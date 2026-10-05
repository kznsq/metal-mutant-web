/**
 * Expression codes: loads, operators, strings and engine queries.
 *
 * DX is the accumulator and CX the left operand of binary operators; both are VM registers that
 * nested items may change, so every operator combines the registers as they are after its right
 * operand, exactly as the original handlers do. Store and add codes (0xb0 and up) are the
 * destination handlers registered by ops_flow.js.
 */
import * as ops_expr from './ops_expr.js';
import * as F from './ops_flow.js';
import { CS, KeyError, SKIP, VALUE_STACK, expression, register_module, require_module, s16 } from './vm.js';

export function u16(v) {
    return v & 0xFFFF;
}

export function sx8(v) {
    v &= 0xFF;
    return v >= 128 ? v - 256 : v;
}

export function set_dx_s8(vm, b) {
    vm.dx = u16(sx8(b));
}


// --------------------------------------------------------------------- constants and strings
export function imm8(vm) {
    vm.dx = u16(vm.fetchs8());
}
expression(0x00)(imm8);

export function imm16(vm) {
    vm.dx = vm.fetch16();
}
expression(0x02)(imm16);

/** Write `text` (bytes) and a terminating zero to the current string buffer cs:[cs:[0x4d3]]. */
export function _to_buffer(vm, text) {
    const lin = CS + vm.g16(0x4D3);
    for (let k = 0; k < text.length; k++) vm.mem.w8(lin + k, text[k]);
    vm.mem.w8(lin + text.length, 0);
}

export function literal(vm) {
    const start = vm.lin();
    const text = F.cstring(vm, start);
    vm.si = u16(vm.si + text.length + 1);
    _to_buffer(vm, text);
}
expression(0x04)(literal);


// --------------------------------------------------------------------- variable loads
/** Six load codes: byte, word, string, string element, byte element, word element. */
export function _load_group(first, operands, record_of) {
    function base_off(vm) {
        const [a, b] = operands(vm);
        return record_of(vm, a, b);
    }

    function byte(vm) {
        const [base, off] = base_off(vm);
        set_dx_s8(vm, vm.mem.r8(vm.es * 16 + u16(base + off)));
    }

    function word(vm) {
        const [base, off] = base_off(vm);
        vm.dx = vm.mem.r16(vm.es * 16 + u16(base + off));
    }

    function string(vm) {
        const [base, off] = base_off(vm);
        _to_buffer(vm, F.cstring(vm, vm.es * 16 + u16(base + off)));
    }

    function string_el(vm) {
        const [base, off] = base_off(vm);
        const keep_bx = first === 0x06 || first === 0x12;   // quirk: own-variable forms restore BX
        const bx = vm.bx;
        const el = F.element(vm, base, off, 'string');
        if (keep_bx) vm.bx = bx;
        vm.dx = vm.last_mul_high;
        _to_buffer(vm, F.cstring(vm, vm.es * 16 + u16(base + el)));
    }

    function byte_el(vm) {
        const [base, off] = base_off(vm);
        const el = F.element(vm, base, off, 'byte');
        set_dx_s8(vm, vm.mem.r8(vm.es * 16 + u16(base + el)));
    }

    function word_el(vm) {
        const [base, off] = base_off(vm);
        const el = F.element(vm, base, off, 'word');
        vm.dx = vm.mem.r16(vm.es * 16 + u16(base + el));
    }

    [byte, word, string, string_el, byte_el, word_el].forEach((fn, k) => expression(first + 2 * k)(fn));
}

_load_group(0x06, (vm) => [vm.fetch16(), null], (vm, a, b) => [vm.bp, a]);
_load_group(0x12, (vm) => [vm.fetch8(), null], (vm, a, b) => [vm.bp, a]);
_load_group(0x1E, (vm) => [vm.fetch16(), null], (vm, a, b) => [vm.g16(0x473), a]);


export function _handle_ops(vm) {
    const h = vm.fetch16();
    return [h, vm.fetch16()];
}

export function _handle_rec(vm, h, field) {
    return [F._handle_record(vm, h), field];
}

function _make(kind) {
    return function fn(vm) {
        const [h, field] = _handle_ops(vm);
        const a = vm.es * 16 + u16(F._handle_record(vm, h) + field);
        if (kind === 'byte') set_dx_s8(vm, vm.mem.r8(a));
        else if (kind === 'word') vm.dx = vm.mem.r16(a);
        else _to_buffer(vm, F.cstring(vm, a));
    };
}

for (const [code, kind] of [[0x2A, 'byte'], [0x2C, 'word'], [0x2E, 'string']]) expression(code)(_make(kind));

function _make_arr(kind) {
    return function fn(vm) {
        const arr = vm.fetch16();
        const h = vm.fetch16();
        const base = F._handle_record(vm, h);
        const el = F.element(vm, base, arr, kind);
        const a = vm.es * 16 + u16(base + el);
        if (kind === 'byte') {
            set_dx_s8(vm, vm.mem.r8(a));
        } else if (kind === 'word') {
            vm.dx = vm.mem.r16(a);
        } else {
            vm.dx = vm.last_mul_high;
            _to_buffer(vm, F.cstring(vm, a));
        }
    };
}

for (const [code, kind] of [[0x30, 'string'], [0x32, 'byte'], [0x34, 'word']]) expression(code)(_make_arr(kind));


// --------------------------------------------------------------------- value stack, groups
export function pop_left(vm) {
    vm.dx = vm.cx;
    vm.cx = vm.pop();
}
expression(0x36)(pop_left);

expression(0x38)((vm) => F.eval_loop(vm));
expression(0x3A, 0xE4)((vm) => SKIP);

export function push(vm) {
    vm.push(vm.dx);
}
expression(0x40, 0xE0)(push);

export function indexed_store(vm) {
    vm.bx = VALUE_STACK;
    vm.push(vm.dx);
    F.eval_loop(vm);
    const code = vm.fetch8();
    const fn = F.DEST_STORE[code];
    if (fn === undefined) throw new KeyError(code);
    return fn(vm);
}
expression(0xE2)(indexed_store);


// --------------------------------------------------------------------- binary operators
function _binary(combine) {
    return function fn(vm) {
        if (vm.eval_next() === SKIP) return undefined;    // abandoned operator: group continues
        combine(vm);
    };
}

function _cmp(test) {
    return function c(vm) {
        vm.dx = test(s16(vm.cx), s16(vm.dx)) ? 0xFFFF : 0;
    };
}

function _sub(vm) {
    vm.cx = u16(vm.cx - vm.dx);
    vm.dx = vm.cx;
}

/** IDIV CX with DX:AX = `dividend` (32-bit, two's complement, given as an unsigned number) as
 * the engine runs it on an 80286 or later. A quotient outside -32768..32767 raises a divide
 * error; the game's handler 0x7731 shifts DX:AX right by two and returns to the same IDIV, which
 * runs again. The handler tells DIV from IDIV by bit 2 of the ModR/M byte instead of bit 3, so
 * for IDIV CX (F7 F9) it shifts logically, as for DIV. Returns [quotient, remainder], truncated
 * toward zero. */
export function _idiv(dividend, divisor) {
    for (;;) {
        const n = dividend >= 0x80000000 ? dividend - 0x100000000 : dividend;
        let q = Math.floor(Math.abs(n) / Math.abs(divisor));
        if ((n < 0) !== (divisor < 0)) q = -q;
        if (q >= -0x8000 && q <= 0x7FFF) return [q, n - q * divisor];
        dividend = Math.floor(dividend / 4);
    }
}

/** Codes 0x5ad5 (modulo) and 0x5ae7 (divide): AX = CX, CWD, divisor CX = DX (0 -> 1), IDIV. */
function _divide(vm, want) {
    const left = s16(vm.cx), right = s16(vm.dx);
    vm.cx = right ? u16(right) : 1;
    const [q, r] = _idiv(left >>> 0, s16(vm.cx));
    vm.dx = u16(want === 'mod' ? r : q);
}

function _imul(vm) {
    vm.dx = u16(s16(vm.dx) * s16(vm.cx));
}

for (const [code, fn] of [
    [0x42, (vm) => { vm.dx = vm.dx & vm.cx; }],
    [0x44, (vm) => { vm.dx = vm.dx | vm.cx; }],
    [0x46, (vm) => { vm.dx = vm.dx ^ vm.cx; }],
    [0x48, (vm) => { vm.dx = u16(~(vm.dx ^ vm.cx)); }],
    [0x4A, _cmp((a, b) => a === b)], [0x4C, _cmp((a, b) => a !== b)],
    [0x4E, _cmp((a, b) => a <= b)], [0x50, _cmp((a, b) => a >= b)],
    [0x52, _cmp((a, b) => a < b)], [0x54, _cmp((a, b) => a > b)],
    [0x56, (vm) => { vm.dx = u16(vm.dx + vm.cx); }],
    [0x58, _sub], [0x5A, (vm) => _divide(vm, 'mod')],
    [0x5C, (vm) => _divide(vm, 'div')], [0x5E, _imul],
]) {
    expression(code)(_binary(fn));
}


// --------------------------------------------------------------------- unary and random
expression(0x60)((vm) => { vm.dx = u16(-vm.dx); });
expression(0x62)((vm) => { vm.dx = vm.dx !== 0x8000 ? u16(Math.abs(s16(vm.dx))) : 0x8000; });
expression(0x66)((vm) => { vm.dx = vm.dx === 0 ? 0 : (vm.dx & 0x8000 ? 0xFFFF : 1); });
expression(0x68)((vm) => { vm.dx = u16(~vm.dx); });
expression(0x6C)((vm) => undefined);
expression(0xA6)((vm) => { vm.dx = 0; });


export function lcg(v) {
    return u16(v * 0x7AB7 + 0xF881);
}

export function random(vm) {
    const s = lcg(vm.g16(0x4C9));
    vm.sg16(0x4C9, s);
    vm.dx = Math.floor(s * vm.dx / 0x10000);               // 32-bit product, high word
}
expression(0x64)(random);

export function hashed(vm) {
    let s = vm.pop();
    s = ((s >> 6) | (s << 10)) & 0xFFFF;
    vm.dx = Math.floor(lcg(s) * vm.dx / 0x10000);
}
expression(0x70)(hashed);


// --------------------------------------------------------------------- input and system queries
export function key(vm) {
    vm.dx = vm.g8(0x689);
}
expression(0x6A)(key);

/** Joystick bits (1 up, 2 down, 4 left, 8 right, 0x80 fire); keyboard fallback flags when the
 * stick is absent and DX is exactly 0; the code byte 0x6e itself otherwise (original bug). */
export function joystick(vm) {
    if (vm.g8(0x51A)) {
        vm.dx = 0;
        return;
    }
    const stick_present = (vm.dx & 0xFF) === 0 ? vm.g8(0x5B6E) : vm.g8(0x5B6F);
    if (stick_present) {
        vm.dx = vm.joystick_bits !== undefined ? vm.joystick_bits(vm.dx & 0xFF) : 0;
        return;
    }
    if (vm.dx !== 0) {
        vm.dx = 0x6E;
        return;
    }
    let bits = 0;
    for (const [flag, bit] of [[0x706, 1], [0x705, 2], [0x704, 4], [0x703, 8], [0x702, 0x80], [0x701, 0x80]]) {
        if (vm.g8(flag)) bits |= bit;
    }
    vm.dx = bits;
}
expression(0x6E)(joystick);

export function receive(vm) {
    let rd = vm.o16(-0x1E);
    if (rd === vm.o16(-0x1C)) {
        vm.dx = 0xFFFF;
        return;
    }
    const seg = vm.mem.r16(vm.o_addr(-0x14) + 2), off = vm.mem.r16(vm.o_addr(-0x14));
    const size = vm.mem.r16(seg * 16 + off + 0x16);
    vm.dx = vm.mem.r16(vm.es * 16 + u16(vm.bp + rd));
    rd = u16(rd + 2);
    if (s16(rd) >= -0x34) rd = u16(rd - size);
    vm.so16(-0x1E, rd);
    if (rd === vm.o16(-0x1C)) vm.so8(-0x24, vm.o8(-0x24) & 0x7F);
}
expression(0x72)(receive);

export function shift_flags(vm) {
    vm.dx = vm.shift_flags ?? 0x0D;                        // BIOS shift flags (INT 16h), else 0x0d
}
expression(0x74)(shift_flags);

export function system_info(vm) {
    const sel = vm.dx;
    if (sel === 0) {
        vm.dx = u16(((vm.g16(0x40B) + (vm.g16(0x409) >> 4)) - (vm.g16(0x441) + (vm.g16(0x43F) >> 4))) >> 6);
    } else if (sel === 1) {
        vm.dx = u16(((vm.g16(0x459) + (vm.g16(0x457) >> 4)) - vm.g16(0x451) - (vm.g16(0x44F) >> 4)) >> 6);
    } else if (sel === 2) {
        vm.dx = u16(vm.g16(0x443) - vm.g16(0x445));
    } else if (sel === 3) {
        vm.dx = u16(vm.g16(0x451) - vm.g16(0x453));
    } else {
        vm.dx = 0x7FFF;                                    // disk space, broken cases: not modelled
    }
}
expression(0x76)(system_info);

const _DISPLAY_INDEX = new Map([[2, 0], [0x80, 1], [3, 2], [5, 4]]);

export function display(vm) {
    vm.dx = 2000 + (_DISPLAY_INDEX.get(vm.g16(0x24)) ?? 0);
}
expression(0x78)(display);

export function wait_key(vm) {
    vm.dx = vm.g8(0x689);                                  // the original waits for press + release
}
expression(0x7A)(wait_key);

export function drive(vm) {
    vm.dx = 0x43;                                          // drive "C"
}
expression(0xA0)(drive);

export function language(vm) {
    vm.dx = vm.g8(0x534);
}
expression(0xA2)(language);

/** Code 0x5d80 -> 0x77f1: cs:[0x518]; unless the display is CGA (2) or monochrome (0x80),
 * multiplied by 2 (MUL: the low word is kept) and divided by 3. */
export function cpu_speed(vm) {
    const v = vm.g16(0x518);
    const d = vm.g16(0x24);
    vm.dx = d === 2 || d === 0x80 ? v : Math.floor(u16(v * 2) / 3);
}
expression(0xA4)(cpu_speed);

export function hardware(vm) {
    vm.dx = vm.g16(0x516);
}
expression(0xA8)(hardware);


// --------------------------------------------------------------------- string functions
export function _cur(vm) {
    return CS + vm.g16(0x4D3);
}

export function _push_string(vm, text) {
    vm.bx = u16(vm.bx - (text.length + 1));
    for (let k = 0; k < text.length; k++) vm.sg8(u16(vm.bx + k), text[k]);
    vm.sg8(u16(vm.bx + text.length), 0);
}

export function _pop_string(vm) {
    const out = [];
    for (;;) {
        const c = vm.g8(vm.bx);
        vm.bx = u16(vm.bx + 1);
        if (c === 0) return Uint8Array.from(out);
        out.push(c);
    }
}

expression(0x96)((vm) => _push_string(vm, F.cstring(vm, _cur(vm))));

export function left(vm) {
    _to_buffer(vm, _pop_string(vm));
    vm.mem.w8(_cur(vm) + (vm.dx & 0xFF), 0);
    vm.bx = vm.dx & 0xFF;                                  // original bug: BX used as a temporary
}
expression(0x7C)(left);

export function right(vm) {
    const s = _pop_string(vm);
    const n = s16(vm.dx);
    _to_buffer(vm, n >= s.length ? s : s.subarray(Math.min(s.length - n, s.length)));
}
expression(0x7E)(right);

export function mid(vm) {
    const start = vm.pop();
    const s = _pop_string(vm);
    _to_buffer(vm, s);
    const lin = _cur(vm);
    const ch = start < s.length ? s[start] : 0;
    vm.mem.w8(lin, ch);
    if (ch !== 0 && s16(vm.dx) <= 1) vm.mem.w8(lin + 1, 0);
    vm.dx = u16(vm.dx - 2);
}
expression(0x80)(mid);

expression(0x82)((vm) => { vm.dx = F.cstring(vm, _cur(vm)).length; });
expression(0x84)((vm) => { vm.dx = vm.mem.r8(_cur(vm)); });
expression(0x86)((vm) => F.format_number(vm, vm.dx, vm.g16(0x4D3)));


/** Swap the current and secondary string buffers, then evaluate the right operand into the new
 * current buffer. */
export function _string_right(vm) {
    F.swap_buffers(vm, 0x4D3, 0x4D5);
    return vm.eval_item();
}

export function concat(vm) {
    if (_string_right(vm) === SKIP) return undefined;
    F.append_string(vm, _cur(vm), CS + vm.g16(0x4D5));
    F.swap_buffers(vm, 0x4D3, 0x4D5);
}
expression(0x88)(concat);

export function _compare(vm) {
    const a = F.cstring(vm, CS + vm.g16(0x4D5));
    const b = F.cstring(vm, _cur(vm));
    for (let k = 0; k < a.length; k++) {
        const ca = a[k];
        const cb = k < b.length ? b[k] : 0;
        if (ca !== cb) return sx8(ca) - sx8(cb);
    }
    return 0;
}

function _string_cmp(test) {
    return function fn(vm) {
        if (_string_right(vm) === SKIP) return undefined;
        vm.dx = test(_compare(vm)) ? 0xFFFF : 0;
    };
}

for (const [code, test] of [[0x8A, (r) => r === 0], [0x8C, (r) => r !== 0], [0x8E, (r) => r <= 0],
                            [0x90, (r) => r >= 0], [0x92, (r) => r < 0], [0x94, (r) => r > 0]]) {
    expression(code)(_string_cmp(test));
}

export function pop_secondary(vm) {
    F.swap_buffers(vm, 0x4D3, 0x4D5);
    const s = _pop_string(vm);
    const lin = CS + vm.g16(0x4D5);
    for (let k = 0; k < s.length; k++) vm.mem.w8(lin + k, s[k]);
    vm.mem.w8(lin + s.length, 0);
}
expression(0x98)(pop_secondary);

export function val(vm) {
    const s = F.cstring(vm, _cur(vm));
    const neg = s.length > 0 && s[0] === 0x2D;
    let v = 0;
    for (let k = neg ? 1 : 0; k < s.length; k++) {
        const c = s[k];
        if (!(c >= 48 && c <= 57)) break;
        v = u16(v * 10 + c - 48);
    }
    vm.dx = neg ? u16(-v) : v;
    vm.cx = neg ? 1 : 0;
}
expression(0x9A)(val);

/** Code 0x5cef: the shared find routine 0x7037 (waits for a playing sample to end, CX = 0,
 * DOS find-first) on the current string buffer; DX = 0xffff when found, else 0. */
export function file_exists(vm) {
    const ops_io = require_module('ops_io');
    const [found] = ops_io._find(vm, _cur(vm));
    vm.dx = found ? 0xFFFF : 0;
}
expression(0x9C)(file_exists);

export function char_to_string(vm) {
    _to_buffer(vm, [vm.dx & 0xFF]);
}
expression(0x9E)(char_to_string);


register_module('ops_expr', ops_expr);
