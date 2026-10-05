/**
 * Script statements 0x00-0x2f (flow, assignment, text output, arrays, loops, switches) and the
 * destination items, which tell an assignment where to store (or add) its value. Destination
 * items are the store table at 0x14d8 (the expression table shifted by 0xaa) and the add table
 * at 0x1514 (shifted by 0xe6).
 */
import * as ops_flow from './ops_flow.js';
import {
    CS, KeyError, NotImplementedError, SKIP, VALUE_STACK, expression, hex, register_module, s16,
    statement,
} from './vm.js';

export const DEST_STORE = new Array(256).fill(undefined);
export const DEST_ADD = new Array(256).fill(undefined);

export function dest_store(...codes) {
    return function reg(fn) {
        for (const c of codes) {
            DEST_STORE[c] = fn;
            expression(c + 0xAA)(fn);
        }
        return fn;
    };
}

export function dest_add(...codes) {
    return function reg(fn) {
        for (const c of codes) {
            DEST_ADD[c] = fn;
            if (c + 0xE6 <= 0xFE) expression(c + 0xE6)(fn);
        }
        return fn;
    };
}


// --------------------------------------------------------------------- no-ops, calls, jumps
statement(0x00, 0x01, 0x02, 0x03, 0x04, 0x0B, 0x0C, 0x0D, 0x0E, 0x0F, 0x10, 0x22, 0x23,
          0x36, 0x37, 0x8B, 0xB2, 0xB3, 0xB4, 0xB5)((vm) => undefined);


export function _offset(vm, size) {
    if (size === 1) return vm.fetchs8();
    const v = vm.fetchs16();
    if (size === 3) vm.fetch8();                           // ignored third byte
    return v;
}

function _call(size) {
    return function h(vm) {
        const off = _offset(vm, size);
        vm.push_return(vm.si);
        vm.si = (vm.si + off) & 0xFFFF;
    };
}

function _jump(size) {
    return function h(vm) {
        const off = _offset(vm, size);
        vm.si = (vm.si + off) & 0xFFFF;
    };
}

for (const [op, size] of [[0x05, 1], [0x06, 2], [0x07, 3]]) statement(op)(_call(size));
for (const [op, size] of [[0x08, 1], [0x09, 2], [0x0A, 3]]) statement(op)(_jump(size));


/** Return from a script subroutine; in a side script (event or per-frame script) with nothing
 * pushed, end the script run. */
export function ret(vm) {
    const sp = vm.o16(-0xA);
    if (vm.g8(0x496) === 0 && s16(sp) >= s16(vm.g16(0x4D1))) return SKIP;
    vm.si = vm.mem.r16(vm.es * 16 + ((vm.bp + sp) & 0xFFFF));
    if (sp === vm.o16(-0xC)) vm.so16(-0xC, 0);
    vm.so16(-0xA, sp + 2);
}
statement(0x11)(ret);


const _CONDITIONS = [[0x12, (vm) => vm.dx === 0], [0x15, (vm) => vm.dx !== 0],
                     [0x18, (vm) => vm.dx === vm.cx], [0x1B, (vm) => vm.dx !== vm.cx]];

function _branch(test, size) {
    return function h(vm) {
        const off = _offset(vm, size);
        if (test(vm)) vm.si = (vm.si + off) & 0xFFFF;
    };
}

for (const [base, test] of _CONDITIONS) {
    [1, 2, 3].forEach((size, k) => statement(base + k)(_branch(test, size)));
}


// --------------------------------------------------------------------- strings
export function swap_buffers(vm, a = 0x4D3, b = 0x4D7) {
    const x = vm.g16(a), y = vm.g16(b);
    vm.sg16(a, y);
    vm.sg16(b, x);
}

/** The zero-terminated string at linear `lin`, without the zero, as a Uint8Array. */
export function cstring(vm, lin) {
    let n = 0;
    while (vm.mem.r8(lin + n)) n += 1;
    if (lin >= 0) return vm.mem.m.slice(lin, lin + n);
    const out = new Uint8Array(n);                         // a negative address counts from the end
    for (let k = 0; k < n; k++) out[k] = vm.mem.r8(lin + k);
    return out;
}

export function copy_string(vm, src_lin, dst_lin) {
    let k = 0;
    for (;;) {
        const c = vm.mem.r8(src_lin + k);
        vm.mem.w8(dst_lin + k, c);
        k += 1;
        if (c === 0) return;
    }
}

export function append_string(vm, src_lin, dst_lin) {
    while (vm.mem.r8(dst_lin)) dst_lin += 1;
    copy_string(vm, src_lin, dst_lin);
}

/** The string the value expression just wrote (buffer cs:[cs:[0x4d7]] after the swap). */
export function value_string(vm) {
    return CS + vm.g16(0x4D7);
}


// --------------------------------------------------------------------- destination items
export function _rec_addr(vm, base, off) {
    return vm.es * 16 + ((base + off) & 0xFFFF);
}

/** Record of the object whose table index is in variable h: word cs:[cs:[0x449] + es:[bp+h]]. */
export function _handle_record(vm, h) {
    return vm.g16((vm.g16(0x449) + vm.o16(h)) & 0xFFFF);
}

/** Address offset (relative to the record) of an array element; first index in DX, the others
 * popped from the value stack (index helpers 0x59c2 / 0x59ef / 0x5a1e). */
export function element(vm, base, n, kind) {
    const dims = vm.mem.r8(_rec_addr(vm, base, n - 1));
    vm.last_mul_high = 0;                                  // high word of the helper's last MUL
    let off;
    if (kind === 'byte') {
        off = n + vm.dx;
    } else if (kind === 'word') {
        off = n + 2 * vm.dx;
    } else {
        const prod = vm.mem.r8(_rec_addr(vm, base, n - 2)) * vm.dx;
        vm.last_mul_high = Math.floor(prod / 0x10000);
        off = n + prod;
        vm.sg16(0x391, n);
    }
    for (let k = 1; k <= dims; k++) {
        const prod = vm.pop() * vm.mem.r16(_rec_addr(vm, base, n - 2 - 2 * k));
        vm.last_mul_high = Math.floor(prod / 0x10000);
        off += prod;
    }
    off &= 0xFFFF;
    if (dims) vm.sg16(0x389, off);                         // stored only with extra dimensions
    return off;
}

/** [record base, offset] for the plain forms of a code group. */
export function _operands(vm, group) {
    if (group === 'own16') return [vm.bp, vm.fetch16()];
    if (group === 'own8') return [vm.bp, vm.fetch8()];
    if (group === 'sel') return [vm.g16(0x473), vm.fetch16()];
    if (group === 'handle') {
        const h = vm.fetch16();
        return [_handle_record(vm, h), vm.fetch16()];
    }
    if (group === 'handle_array') {                        // array offset first, handle second
        const a = vm.fetch16();
        const h = vm.fetch16();
        return [_handle_record(vm, h), a];
    }
    throw new Error(`unknown operand group ${group}`);
}

/** One destination handler. kind: byte / word / string; indexed: array element (value popped
 * after the indices); add: add (or append) instead of store; absolute: the original's quirk of
 * appending at es:[offset] without the record base. */
export function _make_dest(group, kind, indexed, add, absolute = false) {
    return function h(vm) {
        let [base, off] = _operands(vm, group);
        if (indexed) {
            off = element(vm, base, off, kind);
            vm.dx = vm.pop();
        }
        const a = absolute ? vm.es * 16 + (off & 0xFFFF) : _rec_addr(vm, base, off);
        if (kind === 'byte') {
            if (add) {
                const v = (vm.mem.r8(a) + vm.dx) & 0xFF;
                vm.mem.w8(a, v);
                vm.last_add = v;
            } else {
                vm.mem.w8(a, vm.dx);
            }
        } else if (kind === 'word') {
            if (add) {
                const v = (vm.mem.r16(a) + vm.dx) & 0xFFFF;
                vm.mem.w16(a, v);
                vm.last_add = v;
            } else {
                vm.mem.w16(a, vm.dx);
            }
        } else if (add) {
            append_string(vm, value_string(vm), a);
            vm.last_add = 1;
        } else {
            copy_string(vm, value_string(vm), a);
        }
    };
}

const _GROUPS = [['own16', 0x06], ['own8', 0x12], ['sel', 0x1E]];
const _SIX = [['byte', false, 0], ['word', false, 2], ['string', false, 4], ['string', true, 6],
              ['byte', true, 8], ['word', true, 10]];
for (const [group, first] of _GROUPS) {
    for (const [kind, indexed, k] of _SIX) {
        dest_store(first + k)(_make_dest(group, kind, indexed, false));
        const quirk = (group === 'own16' || group === 'own8') && kind === 'string';
        dest_add(first + k)(_make_dest(group, kind, indexed, true, quirk));
    }
}
for (const [code, kind] of [[0x2A, 'byte'], [0x2C, 'word'], [0x2E, 'string']]) {
    dest_store(code)(_make_dest('handle', kind, false, false));
    dest_add(code)(_make_dest('handle', kind, false, true));
}
for (const [code, kind] of [[0x30, 'string'], [0x32, 'byte'], [0x34, 'word']]) {
    dest_store(code)(_make_dest('handle_array', kind, true, false));
    dest_add(code)(_make_dest('handle_array', kind, true, true));
}


export function _push_dx(vm) {
    vm.push(vm.dx);
}
dest_store(0x36)(_push_dx);
DEST_ADD[0x36] = _push_dx;


/** Code 0x5eea: evaluate items until an end code (0x3a) drops this loop's frame. */
export function eval_loop(vm) {
    for (;;) {
        if (vm.eval_item() === SKIP) return undefined;
    }
}

export function _nested(table) {
    return function h(vm) {
        vm.bx = VALUE_STACK;
        vm.push(vm.dx);
        eval_loop(vm);
        let code = vm.fetch8();
        code = code >= 128 ? code - 256 : code;           // sign-extended in the nested path
        const fn = table[code & 0xFF];
        if (fn === undefined) throw new KeyError(code & 0xFF);
        return fn(vm);
    };
}

DEST_STORE[0x38] = _nested(DEST_STORE);
DEST_ADD[0x38] = _nested(DEST_ADD);
expression(0x38 + 0xAA)(DEST_STORE[0x38]);
DEST_STORE[0x3A] = DEST_ADD[0x3A] = (vm) => SKIP;
expression(0x3A + 0xAA)(DEST_STORE[0x3A]);


/** Swap the string buffers, empty the value stack and run one destination item. */
export function destination(vm, table) {
    swap_buffers(vm);
    vm.bx = VALUE_STACK;
    const code = vm.fetch8();
    const h = table[code];
    if (h === undefined) throw new NotImplementedError(`destination code 0x${hex(code, 2)}`);
    return h(vm);
}


// --------------------------------------------------------------------- assignment
export function assign(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    destination(vm, DEST_STORE);
}
statement(0x1E)(assign);

export function evaluate(vm) {
    vm.bx = VALUE_STACK;
    return vm.eval_next();                                 // tail jump: an end code ends the run
}
statement(0x1F)(evaluate);

export function add_to(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    destination(vm, DEST_ADD);
}
statement(0x20)(add_to);

export function subtract_from(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    vm.dx = -vm.dx & 0xFFFF;
    destination(vm, DEST_ADD);
}
statement(0x21)(subtract_from);


// --------------------------------------------------------------------- text output (DOS)
/** Bytes as text, one character per byte (Latin-1). */
export function latin1(bytes) {
    let s = '';
    for (let k = 0; k < bytes.length; k++) s += String.fromCharCode(bytes[k]);
    return s;
}

export function _out(vm, text) {
    vm.sg8(0x421, 0);
    vm.stdout = (vm.stdout ?? '') + latin1(text);
}

/** Code 0x1b80: signed decimal of `value` at cs:[di] (zero-terminated, leading zeros dropped);
 * cs:[0x38f] = 1 once a non-zero digit is written. Returns the text (Uint8Array). */
export function format_number(vm, value, di) {
    vm.sg16(0x38F, 0);
    const out = [];
    let dx = value & 0xFFFF;
    if (dx & 0x8000) {
        out.push(0x2D);
        dx = -dx & 0xFFFF;
    }
    for (let k = 0; k < 5; k++) {
        const step = vm.g16(0x1C04 + 2 * k);
        let digit = 0x30;
        for (;;) {
            dx = (dx - step) & 0xFFFF;
            if (dx & 0x8000) {
                dx = (dx + step) & 0xFFFF;
                break;
            }
            digit += 1;
        }
        digit &= 0xFF;
        if (digit === 0x30) {
            if (vm.g16(0x38F) === 0 && k !== 4) continue;
        } else {
            vm.sg16(0x38F, 1);
        }
        out.push(digit);
    }
    out.push(0);
    for (let k = 0; k < out.length; k++) vm.sg8((di + k) & 0xFFFF, out[k]);
    return Uint8Array.from(out.slice(0, -1));
}

export function print_number(vm) {
    vm.sg8(0x421, 0);
    if (vm.evaluate() === SKIP) return undefined;
    _out(vm, format_number(vm, vm.dx, vm.g16(0x4D3)));
}
statement(0x24)(print_number);

export function print_inline(vm) {
    for (;;) {
        vm.sg8(0x421, 0);
        const c = vm.fetch8();
        if (c === 0) return;
        _out(vm, [c]);
    }
}
statement(0x25)(print_inline);

export function print_string(vm) {
    vm.sg8(0x421, 0);
    if (vm.evaluate() === SKIP) return undefined;
    _out(vm, cstring(vm, CS + vm.g16(0x4D3)));
}
statement(0x26)(print_string);

export function cursor(vm) {
    vm.sg8(0x421, 0);
    if (vm.evaluate() === SKIP) return undefined;
    vm.evaluate_keep();
    vm.sg8(0x437, vm.dx);
    vm.sg8(0x438, vm.cx);
}
statement(0x27)(cursor);

export function cursor_column(vm) {
    vm.sg8(0x421, 0);
    if (vm.evaluate() === SKIP) return undefined;
    vm.sg8(0x437, vm.dx);
}
statement(0x28)(cursor_column);


// --------------------------------------------------------------------- arrays, random seed, loops
export function declare_array(vm) {
    const n = vm.fetch16();
    const dims = vm.fetch8();
    const size = vm.fetch8();
    vm.so8(n - 1, dims);
    vm.so8(n - 2, size);
    for (let k = 1; k <= dims; k++) vm.so16(n - 2 - 2 * k, vm.fetch16());
}
statement(0x29)(declare_array);

export function seed(vm) {
    if (vm.eval_item() === SKIP) return undefined;
    vm.sg16(0x4C9, vm.dx ? vm.dx : vm.mem.r16(0x46C));
}
statement(0x2A)(seed);

function _loop(size) {
    return function h(vm) {
        const p = vm.si;
        vm.sg16(0x4CF, p);
        const off = _offset(vm, size);
        vm.dx = 0xFFFF;
        vm.last_add = 0;
        if (destination(vm, DEST_ADD) === SKIP) return undefined;
        if (vm.last_add !== 0) vm.si = (p + size + off) & 0xFFFF;
    };
}

for (const [op, size] of [[0x2B, 1], [0x2C, 2], [0x2D, 3]]) statement(op)(_loop(size));


// --------------------------------------------------------------------- switches
/** Sorted table of n+1 {key, offset}; a miss continues after the whole table. */
export function switch_sorted(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    const v = s16(vm.dx);
    const n = vm.fetch8();
    vm.si = (vm.si + 1) & 0xFFFE;
    const end = (vm.si + 4 * (n + 1)) & 0xFFFF;
    for (let k = 0; k < n + 1; k++) {
        const key = vm.fetchs16();
        const off = vm.fetchs16();
        if (v === key) {
            vm.si = (vm.si + off) & 0xFFFF;
            return undefined;
        }
        if (v < key) break;
    }
    vm.si = end;
    return undefined;
}
statement(0x2E)(switch_sorted);

/** Code 0x486e: bias word, then n+1 offsets; a miss (negative or above n) continues after the
 * table. DX is left as 2*(value+bias) on a hit, value+bias otherwise; CX is preserved. */
export function switch_dense(vm) {
    const cx = vm.cx;
    if (vm.evaluate() === SKIP) return undefined;
    const n = vm.fetch8();
    if (vm.si & 1) vm.si = (vm.si + 1) & 0xFFFF;
    const at_bias = vm.si;
    const i = (vm.dx + vm.mem.r16(vm.ds * 16 + at_bias)) & 0xFFFF;
    vm.cx = cx;
    if (i & 0x8000 || i > n) {
        vm.dx = i;
        vm.si = (at_bias + 4 + 2 * n) & 0xFFFF;
        return undefined;
    }
    vm.dx = (2 * i) & 0xFFFF;
    const entry = (at_bias + 2 + vm.dx) & 0xFFFF;
    vm.si = (entry + vm.mem.r16(vm.ds * 16 + entry) + 2) & 0xFFFF;
}
statement(0x2F)(switch_dense);


register_module('ops_flow', ops_flow);
