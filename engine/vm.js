/**
 * Interpreter for Metal Mutant's scripts.
 *
 * Works on a memory image with the original layout (the engine's data segment, object records,
 * loaded class files), so every instruction reproduces the original program's memory writes.
 * Handlers are functions registered by opcode in STATEMENTS and EXPRESSIONS (statement() and
 * expression() below); the ops_*.js modules register theirs when they are imported.
 *
 * Addresses: CS is the linear base of the engine's code and data segment (segment 0x1040);
 * g8(off) / g16(off) read the engine's globals (cs:[off]). An object record is addressed by its
 * segment (ES) and offset (BP); the scheduler's per-object state lives at negative offsets.
 */
import { Memory } from './memory.js';
import {
    IndexError, KeyError, NotImplementedError, EngineError, EngineTypeError, RuntimeError, ValueError,
    ZeroDivisionError, floordiv, floormod, hex, shr,
} from './errors.js';

export {
    Memory, IndexError, KeyError, NotImplementedError, EngineError, EngineTypeError, RuntimeError,
    ValueError, ZeroDivisionError, floordiv, floormod, hex, shr,
};

export const CS = 0x10400;
// A routine that drops its caller's return address (ADD SP,2 ; RET) makes its caller return at
// once. Routines model this by returning SKIP: a caller that made a CALL returns normally when it
// receives SKIP; a caller that JMPed (tail call) passes SKIP on. When SKIP reaches the
// interpreter loop, the script run ends (the main script resumes there in the next frame).
export const SKIP = Symbol('SKIP');
export const YIELD = SKIP;
export const VALUE_STACK = 0x1268;


// Points where the original program stops running scripts.
/** 0x1550 -> 0x7534: the program restores the interrupt vectors, the timer and the video mode,
 * then returns to the operating system (int 21h AX=4C00h). */
export class ProgramExit extends EngineError {}

/** 0x85c2: the program prints "Erreur<code> :<message>", waits for a key and exits. */
export class FatalError extends ProgramExit {
    constructor(code, text = null) {
        super(text || `fatal error 0x${hex(code)}`);
        this.code = code;
        this.text = text;
    }
}

/** At this point the original program runs off its own code (for example a return through a
 * stack that still holds saved registers, or a write over the engine's code), so there is no
 * defined continuation. */
export class OriginalCrash extends EngineError {}

/** The original waits for something that can never happen (an endless loop). */
export class EngineHang extends EngineError {}


// 16-bit and 8-bit arithmetic as the processor's registers do it.
export function s16(v) {
    v &= 0xFFFF;
    return v >= 32768 ? v - 65536 : v;
}

export function u16(v) {
    return v & 0xFFFF;
}

export function sx8(v) {
    v &= 0xFF;
    return v >= 128 ? v - 256 : v;
}


export class VM {
    /** Interpreter state: memory, the current object (es, bp), script pointer (ds, si) and the
     * evaluator's registers (dx = value, cx = value so far, bx = value-stack pointer). */
    constructor(memory, es) {
        this.mem = memory;
        this.es = es;
        this.bp = 0;
        this.ds = 0;
        this.si = 0;
        this.dx = 0;
        this.cx = 0;
        this.bx = 0x1268;
        this.trace = null;            // optional array receiving [object, script address, opcode]
        this.object_gone = false;     // the running object destroyed itself (0x6ee4 jumps to 0x1590)
        this.restart_pass = false;    // a level change restarts the walk at object 0 (0x156c)
        this.step_limit = null;       // optional: raise after this many statements in one script run
        // Hardware interrupts that arrive while a script runs: a script that waits in a loop for
        // the keyboard or the timer (Escape pauses the game this way) needs them to go on.
        // `interrupt_hook()` is called every `interrupt_every` statements of one script run;
        // ordinary runs are far shorter, so they see interrupts only between passes.
        this.interrupt_hook = null;
        this.interrupt_every = 5000;
        // Results of helper routines that their callers read afterwards.
        this.last_mul_high = 0;       // ops_flow.element: high word of the index helper's last MUL
        this.last_add = 0;            // add destinations: the value stored (loop statements 0x2b-0x2d)
        // Host-side attributes, undefined until a module or the host sets them; code that reads
        // one uses its default while it is undefined: stdout, video, sound_log, keys, key_source,
        // mouse, dos_files, pit_count, pit_source, joystick_bits, shift_flags, pointer_hide,
        // pointer_show, machine.
        this.stdout = undefined;
        this.video = undefined;
        this.sound_log = undefined;
        this.keys = undefined;
        this.key_source = undefined;
        this.mouse = undefined;
        this.dos_files = undefined;
        this.pit_count = undefined;
        this.pit_source = undefined;
        this.joystick_bits = undefined;
        this.shift_flags = undefined;
        this.pointer_hide = undefined;
        this.pointer_show = undefined;
        this.machine = undefined;
    }

    // engine globals: cs:[off]
    g8(off) {
        return this.mem.r8(CS + off);
    }

    g16(off) {
        return this.mem.r16(CS + off);
    }

    sg8(off, v) {
        this.mem.w8(CS + off, v);
    }

    sg16(off, v) {
        this.mem.w16(CS + off, v);
    }

    // current object record: es:[bp + off], the offset wrapping inside the segment
    o_addr(off) {
        return this.es * 16 + ((this.bp + off) & 0xFFFF);
    }

    o8(off) {
        return this.mem.r8(this.o_addr(off));
    }

    os8(off) {
        return this.mem.s8(this.o_addr(off));
    }

    o16(off) {
        return this.mem.r16(this.o_addr(off));
    }

    so8(off, v) {
        this.mem.w8(this.o_addr(off), v);
    }

    so16(off, v) {
        this.mem.w16(this.o_addr(off), v);
    }

    // script stream: ds:si, si advancing past each value read
    lin() {
        return this.ds * 16 + this.si;
    }

    fetch8() {
        const v = this.mem.r8(this.lin());
        this.si = (this.si + 1) & 0xFFFF;
        return v;
    }

    fetchs8() {
        const v = this.fetch8();
        return v >= 128 ? v - 256 : v;
    }

    fetch16() {
        const v = this.mem.r16(this.lin());
        this.si = (this.si + 2) & 0xFFFF;
        return v;
    }

    fetchs16() {
        return s16(this.fetch16());
    }

    // per-object call stack: its pointer is the record's word -0xa; a push lowers it by 2 and
    // writes the value at es:[bp + pointer]
    push_return(value) {
        const di = (this.o16(-0xA) - 2) & 0xFFFF;
        this.so16(-0xA, di);
        this.mem.w16(this.es * 16 + ((this.bp + di) & 0xFFFF), value);
    }

    // interpreter loop (code 0x1649)
    run_script() {
        let steps = 0;
        for (;;) {
            steps += 1;
            if (this.step_limit && steps > this.step_limit) {
                throw new RuntimeError(`script run exceeded ${this.step_limit} statements at ${hex(this.ds, 4)}:${hex(this.si, 4)}`);
            }
            if (this.interrupt_hook !== null && steps % this.interrupt_every === 0) this.interrupt_hook();
            const op = this.fetch8();
            if (this.trace !== null) this.trace.push([this.bp, this.lin() - 1, op]);
            const h = STATEMENTS[op];
            if (h == null) {
                throw new NotImplementedError(`statement 0x${hex(op, 2)} at ${hex(this.ds, 4)}:${hex((this.si - 1) & 0xFFFF, 4)}`);
            }
            this.bx = op * 2;                           // the loop head dispatches through BX = 2 * opcode
            if (h(this) === SKIP) return;
        }
    }

    // expression evaluator (code 0x573a / 0x573d / 0x573f)
    /** Entry 0x573a: reset the value stack, CX = DX, evaluate one item; result in DX. */
    evaluate() {
        this.bx = VALUE_STACK;
        return this.eval_next();
    }

    /** Entry 0x5732: evaluate one item with DX preserved; the result goes to CX. */
    evaluate_keep() {
        const saved = this.dx;
        const r = this.evaluate();
        this.cx = this.dx;
        this.dx = saved;
        return r;
    }

    // value stack: cs:[bx], growing down from 0x1268
    push(v) {
        this.bx = (this.bx - 2) & 0xFFFF;
        this.sg16(this.bx, v);
    }

    pop() {
        const v = this.g16(this.bx);
        this.bx = (this.bx + 2) & 0xFFFF;
        return v;
    }

    /** Entry 0x573d: CX = DX, then evaluate one item. */
    eval_next() {
        this.cx = this.dx;
        return this.eval_item();
    }

    /** Entry 0x573f: read an expression code and run its handler. */
    eval_item() {
        const code = this.fetch8();
        const h = EXPRESSIONS[code];
        if (h == null) {
            throw new NotImplementedError(`expression code 0x${hex(code, 2)} at ${hex(this.ds, 4)}:${hex((this.si - 1) & 0xFFFF, 4)}`);
        }
        return h(this);
    }
}


// Handler tables, indexed by code (undefined = no handler).
export const STATEMENTS = new Array(256).fill(undefined);
export const EXPRESSIONS = new Array(256).fill(undefined);

/** statement(0x11)(fn) registers fn for each code; returns fn. A later registration of the same
 * code replaces the earlier one. */
export function statement(...codes) {
    return function reg(fn) {
        for (const c of codes) STATEMENTS[c] = fn;
        return fn;
    };
}

/** The same for expression codes. */
export function expression(...codes) {
    return function reg(fn) {
        for (const c of codes) EXPRESSIONS[c] = fn;
        return fn;
    };
}


// The loaded modules by name: a routine that needs another module's code looks it up when it
// runs (require_module), e.g. ops_expr's expression 0x9c uses ops_io.
export const LOADED_MODULES = [];
const MODULE_TABLE = new Map();

/** Called once at the end of every engine module: register_module('ops_flow', ns) where ns is
 * the module's own namespace (import * as ns from './ops_flow.js'). */
export function register_module(name, namespace) {
    if (!MODULE_TABLE.has(name)) LOADED_MODULES.push(name);
    MODULE_TABLE.set(name, namespace);
}

/** The namespace of a loaded module; NotImplementedError when that module is not loaded. */
export function require_module(name) {
    const ns = MODULE_TABLE.get(name);
    if (ns === undefined) throw new NotImplementedError(`module ${name} is not loaded`);
    return ns;
}

export function has_module(name) {
    return MODULE_TABLE.has(name);
}


// --------------------------------------------------------------------- scheduler (code 0x1590)
/** [segment, offset] of the far pointer stored at linear address a. */
export function far(mem, a) {
    return [mem.r16(a + 2), mem.r16(a)];
}

/** One walk over the object table, as the scheduler at 0x15aa-0x1646 does it. Like 0x1590, the
 * next handle is taken after the one in cs:[0x381] (re-read with the table cs:[0x449] after every
 * turn): destroying the running object sets cs:[0x381] to its predecessor. A level change
 * (vm.restart_pass, 0x156c) starts a new walk with object 0 without the frame end. */
export function script_pass(vm) {
    let bx = vm.g16(0x381);
    for (;;) {
        vm.object_gone = vm.restart_pass = false;
        vm.bp = vm.mem.r16(CS + ((bx + vm.g16(0x449)) & 0xFFFF));
        object_turn(vm);
        if (vm.restart_pass) {
            bx = 0;
            continue;
        }
        bx = vm.mem.r16(CS + ((vm.g16(0x381) + vm.g16(0x449) + 4) & 0xFFFF));
        vm.sg16(0x381, bx);
        if (bx === 0) return;
    }
}

/** The script run destroyed the running object (0x6ee4 jumps to 0x1590) or changed the level
 * (0x156c): nothing more of this object's turn runs. */
export function turn_ended(vm) {
    return vm.object_gone || vm.restart_pass;
}

/** Run the class's event (header +0xa) or per-frame (+6) script if it has one. */
export function _side_script(vm, header_off) {
    const [seg, off] = far(vm.mem, vm.o_addr(-0x14));
    const rel = vm.mem.r16(seg * 16 + off + header_off);
    if (rel === 0) return false;
    vm.ds = seg;
    vm.si = (off + header_off + rel) & 0xFFFF;
    vm.sg16(0x4D1, vm.o16(-0xA));
    vm.run_script();
    if (!turn_ended(vm)) vm.so16(-0xA, vm.g16(0x4D1));
    return true;
}

/** Code 0x2bc1: remember the object's position words +0, +2, +4, +6 in cs:[0x477..0x47d]. */
export function save_position(vm) {
    for (let k = 0; k < 4; k++) vm.sg16(0x477 + 2 * k, vm.o16(2 * k));
}

/** Code 0x2be2: if x, y or z moved, move every attached display element by the same amount.
 *
 * The elements form a chain in the segment of the far pointer cs:[0x45f], starting at the
 * object's field -0x18: byte +0 state (0 becomes 2), words +0x16/+0x18/+0x1a position,
 * word +4 next element. */
export function move_attached(vm) {
    const dx = (vm.o16(0) - vm.g16(0x477)) & 0xFFFF;
    const dy = (vm.o16(2) - vm.g16(0x479)) & 0xFFFF;
    const dz = (vm.o16(4) - vm.g16(0x47B)) & 0xFFFF;
    if (!(dx || dy || dz)) return;
    const seg = vm.g16(0x461);
    let di = vm.o16(-0x18);
    const d = [dx, dy, dz];
    while (di) {
        const a = seg * 16 + di;
        if (vm.mem.r8(a) === 0) vm.mem.w8(a, 2);
        for (let k = 0; k < 3; k++) vm.mem.w16(a + 0x16 + 2 * k, vm.mem.r16(a + 0x16 + 2 * k) + d[k]);
        di = vm.mem.r16(a + 4);
    }
}

/** One object's turn (code 0x15aa-0x1646). */
export function object_turn(vm) {
    vm.sg8(0x50F, 0);
    vm.sg8(0x496, 0);
    const flags = vm.o8(-0x24);
    if (flags & 0x80 && !(flags & 2)) {
        const [seg, off] = far(vm.mem, vm.o_addr(-0x14));
        if (vm.mem.r16(seg * 16 + off + 0xA)) {
            save_position(vm);
            _side_script(vm, 0xA);                           // event script
            if (turn_ended(vm)) return;
            move_attached(vm);
        }
    }
    const active = vm.os8(-4);
    if (active === 0) return;
    if (active < 0) vm.so8(-4, 1);
    vm.so8(-1, vm.o8(-1) - 1);
    if (vm.o8(-1) !== 0) return;
    save_position(vm);
    [vm.ds, vm.si] = far(vm.mem, vm.o_addr(-8));
    vm.sg8(0x496, vm.g8(0x496) + 1);
    vm.run_script();
    if (turn_ended(vm)) return;
    vm.so16(-8, vm.si);
    const [seg, off] = far(vm.mem, vm.o_addr(-0x14));
    if (vm.mem.r16(seg * 16 + off + 6)) {
        vm.sg8(0x496, 0);
        _side_script(vm, 6);                                 // per-frame script
        if (turn_ended(vm)) return;
    }
    move_attached(vm);
    vm.so8(-1, vm.o8(-2));
}
