/**
 * Core object statements: interrupt calls (0x30-0x33), activation, yield, positions and
 * velocity, result-list walking, messages (0x61-0x66), direction tables (0x5f, 0x89-0x8d) and
 * simple field setters.
 */
import * as ops_objects from './ops_objects.js';
import * as F from './ops_flow.js';
import { SKIP, register_module, s16, statement } from './vm.js';

export function u16(v) {
    return v & 0xFFFF;
}

export function sx8(v) {
    v &= 0xFF;
    return v >= 128 ? v - 256 : v;
}

export function record_of_handle(vm, h) {
    return vm.g16(u16(vm.g16(0x449) + h));
}

/** Linear address of the class file of the current object (or of record `rec`). */
export function class_ptr(vm, rec = null) {
    const a = rec == null ? vm.o_addr(-0x14) : vm.es * 16 + u16(rec - 0x14);
    return vm.mem.r16(a + 2) * 16 + vm.mem.r16(a);
}

export function rec8(vm, rec, off) {
    return vm.mem.r8(vm.es * 16 + u16(rec + off));
}

export function rec16(vm, rec, off) {
    return vm.mem.r16(vm.es * 16 + u16(rec + off));
}

export function set_rec8(vm, rec, off, v) {
    vm.mem.w8(vm.es * 16 + u16(rec + off), v);
}

export function set_rec16(vm, rec, off, v) {
    vm.mem.w16(vm.es * 16 + u16(rec + off), v);
}


// --------------------------------------------------------------------- interrupt call and resume
function _interrupt_call(size) {
    return function h(vm) {
        const off = F._offset(vm, size);
        const after = vm.si;
        const target = u16(after + off);
        if (vm.g8(0x496)) {                                // main script
            if (vm.o16(-0xC) === 0) {
                const sp = u16(vm.o16(-0xA) - 2);
                vm.so16(-0xA, sp);
                vm.mem.w16(vm.o_addr(sp), after);
                vm.so16(-0xC, sp);
            } else {
                vm.so16(-0xA, vm.o16(-0xC));
            }
            vm.si = target;
            return undefined;
        }
        if (vm.o16(-0xC) === 0) {                          // side script: redirect the main script
            const di = u16(vm.g16(0x4D1) - 2);
            vm.sg16(0x4D1, di);
            vm.so16(-0xC, di);
            vm.mem.w16(vm.o_addr(di), vm.o16(-8));
        } else {
            vm.sg16(0x4D1, vm.o16(-0xC));
        }
        vm.so16(-8, target);
        vm.so8(-4, 1);
        vm.so8(-1, 1);
        return undefined;
    };
}

for (const [op, size] of [[0x30, 1], [0x31, 2], [0x32, 3]]) statement(op)(_interrupt_call(size));


export function resume(vm) {
    const m = vm.o16(-0xC);
    if (m === 0) return F.ret(vm);
    vm.so16(-0xC, 0);
    if (vm.g8(0x496)) {
        vm.si = vm.mem.r16(vm.o_addr(m));
        vm.so16(-0xA, u16(m + 2));
    } else {
        vm.so16(-8, vm.mem.r16(vm.o_addr(m)));
        vm.sg16(0x4D1, u16(m + 2));
    }
}
statement(0x33)(resume);

export function set_48d(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    vm.sg16(0x48D, vm.dx);
}
statement(0x34)(set_48d);

function _set_active(value) {
    return function h(vm) {
        if (vm.evaluate() === SKIP) return undefined;
        if (!(vm.dx & 0x8000)) set_rec8(vm, record_of_handle(vm, vm.dx), -4, value);
    };
}

statement(0x35)(_set_active(0));
statement(0x3E)(_set_active(1));
statement(0x3A)((vm) => { vm.sg8(0x4B4, 0); });
statement(0x3B)((vm) => undefined);

export function deactivate_self(vm) {
    vm.so8(-4, 0);
    if (vm.g8(0x496)) return SKIP;
}
statement(0x3F)(deactivate_self);

statement(0x42)((vm) => SKIP);

export function return_and_yield(vm) {
    if (vm.g8(0x496)) F.ret(vm);
    return SKIP;
}
statement(0x43)(return_and_yield);

export function set_view(vm) {
    vm.so16(-0x16, vm.fetch16());
}
statement(0x47)(set_view);

function _position(add) {
    return function h(vm) {
        for (const off of [0, 2, 4]) {
            if (vm.evaluate() === SKIP) return undefined;
            vm.so16(off, add ? u16(vm.o16(off) + vm.dx) : vm.dx);
        }
    };
}

statement(0x4C)(_position(false));
statement(0x4D)(_position(true));

export function set_box(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    vm.so16(-0x1A, vm.dx);
}
statement(0x51)(set_box);

statement(0x52)((vm) => { vm.so16(-0x1A, 0xFFFF); });


// --------------------------------------------------------------------- result list (cs:0x96a)
export const RESULTS = 0x96A;

/** 0x3d13 + 0x3cde: rewind the cursor and store the first result through a destination. */
export function first_result(vm) {
    vm.sg16(0x4F9, RESULTS);
    return next_result(vm);
}

export function next_result(vm) {
    vm.dx = vm.g16(vm.g16(0x4F9));
    if (!(vm.dx & 0x8000)) vm.sg16(0x4F9, vm.g16(0x4F9) + 2);
    return F.destination(vm, F.DEST_STORE);
}

statement(0x57)(next_result);
statement(0x60)(first_result);

export function previous_result(vm) {
    if (vm.g16(0x4F9) === RESULTS) {
        vm.dx = 0xFFFF;
    } else {
        vm.sg16(0x4F9, vm.g16(0x4F9) - 2);
        vm.dx = vm.g16(vm.g16(0x4F9));
    }
    return F.destination(vm, F.DEST_STORE);
}
statement(0x58)(previous_result);

statement(0x67)((vm) => { vm.sg8(0x50F, 1); });


// --------------------------------------------------------------------- messages
export function send(vm) {
    const n = vm.fetch8() + 1;
    if (vm.evaluate() === SKIP) return undefined;
    const h = vm.dx;
    const rec = h !== 0xFFFF ? record_of_handle(vm, h) : 0;

    function discard(k) {
        for (let i = 0; i < k; i++) {
            if (vm.evaluate() === SKIP) return;
        }
    }

    if (h === 0xFFFF || rec === 0 || rec8(vm, rec, -0x24) & 1) {
        discard(n);
        vm.cx = 0;                                         // LOOP counter, saved around evaluations
        return undefined;
    }
    let w = rec16(vm, rec, -0x1C);
    const size = vm.mem.r16(class_ptr(vm, rec) + 0x16);
    for (let k = 0; k < n; k++) {
        if (vm.evaluate() === SKIP) return undefined;
        vm.sg16(0x393, w);                                 // slot of this word
        const pos = w;
        w = u16(w + 2);
        if (s16(w) >= -0x34) w = u16(w - size);
        if (w === rec16(vm, rec, -0x1E)) {
            set_rec16(vm, rec, -0x1C, w);
            discard(n - k - 1);
            vm.cx = 0;
            return undefined;
        }
        set_rec16(vm, rec, pos, vm.dx);
    }
    set_rec16(vm, rec, -0x1C, w);
    set_rec8(vm, rec, -0x24, rec8(vm, rec, -0x24) | 0x80);
    vm.cx = 0;
}
statement(0x61)(send);

statement(0x62)((vm) => { vm.so8(-0x24, vm.o8(-0x24) & 0xFE); });

export function refuse_messages(vm) {
    vm.so8(-0x24, vm.o8(-0x24) | 1);
    vm.so16(-0x1E, vm.o16(-0x1C));
    vm.so8(-0x24, vm.o8(-0x24) & 0x7F);
}
statement(0x63)(refuse_messages);

statement(0x64)((vm) => { vm.so8(-0x24, vm.o8(-0x24) & 0xFD); });
statement(0x65)((vm) => { vm.so8(-0x24, vm.o8(-0x24) | 2); });

export function flush_messages(vm) {
    vm.so16(-0x1E, vm.o16(-0x1C));
    vm.so8(-0x24, vm.o8(-0x24) & 0x7F);
}
statement(0x66)(flush_messages);

export function frame_ticks(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    vm.sg8(0x512, vm.dx);
}
statement(0x6A)(frame_ticks);

export function copy_bytes(vm) {
    const dest = vm.fetch16();
    const count = vm.fetch16();
    for (let k = 0; k < count - 1; k++) vm.so8(u16(dest + k), vm.fetch8());
}
statement(0x6F)(copy_bytes);

export function redraw_group(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    vm.so16(-0x2A, vm.dx);
}
statement(0x83)(redraw_group);


// --------------------------------------------------------------------- directions and velocity
export const BUILTIN_DIRECTIONS = 0x55FA;                  // count byte, then 3-byte entries

/** Linear address of the object's direction table: a byte (entries - 1), then 3-byte entries
 * (x, y, z steps); the class's own table (object field -0x20) or the built-in one. */
export function direction_table(vm) {
    const t = vm.o16(-0x20);
    return t ? class_ptr(vm) + t : 0x10400 + BUILTIN_DIRECTIONS;
}

export function set_direction(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    const entry = direction_table(vm) + 1 + 3 * vm.dx;
    for (let k = 0; k < 3; k++) vm.so8(9 + k, vm.mem.r8(entry + k));
}
statement(0x5F)(set_direction);

export function skip_table(vm) {
    const n = vm.fetch8();
    vm.si = u16(vm.si + 3 * n + 3);
}
statement(0x89)(skip_table);

statement(0x8A)((vm) => { vm.so16(-0x20, vm.fetch16()); });


/** Code 0x55a7: 32-bit dot product of a 3-byte direction entry with cs:[0x4e5..0x4e9] into
 * cs:[0x3a9..0x3ac]; returns [value (unsigned 32-bit), DX as the routine leaves it]. */
export function _dot(vm, entry, d) {
    let acc = 0;
    const a0 = sx8(vm.mem.r8(entry));
    let dx = a0 < 0 ? 0xFFFF : 0;
    for (let k = 0; k < 3; k++) {
        const a = sx8(vm.mem.r8(entry + k));
        if (a) {
            const p = a * d[k];
            dx = Math.floor(p / 0x10000) & 0xFFFF;
            acc = (acc + p) >>> 0;
        }
    }
    vm.sg16(0x3A9, acc & 0xFFFF);
    vm.sg16(0x3AB, acc >>> 16);
    return [acc, dx];
}

/** Codes 0x564a / 0x56be: choose the direction-table entry with the largest (0x8c) or smallest
 * (0x8d) dot product with the vector to another object (helpers 0x5555, 0x55a7). */
function _towards(nearest_max) {
    return function h(vm) {
        if (vm.evaluate() === SKIP) return undefined;
        if (vm.dx === 0xFFFF) return undefined;
        const t = record_of_handle(vm, vm.dx);
        const d = [0, 2, 4].map((off) => s16(rec16(vm, t, off) - vm.o16(off)));
        d.forEach((v, k) => vm.sg16(0x4E5 + 2 * k, v));
        const table = direction_table(vm);
        // cs:[0x395] keeps the chosen entry's offset in its segment (class file or engine)
        const seg_base = vm.o16(-0x20) ? vm.mem.r16(vm.o_addr(-0x14) + 2) * 16 : 0x10400;
        let cx = vm.mem.r8(table) + 1;
        vm.so8(8, cx);
        let best = nearest_max ? 0x80000000 : 0x7FFFFFFF;
        vm.sg16(0x3AD, best & 0xFFFF);
        vm.sg16(0x3AF, best >>> 16);
        let entry = table + 1;
        const signed = (v) => v | 0;                       // unsigned 32-bit -> signed 32-bit

        while (cx) {
            let value;
            [value, vm.dx] = _dot(vm, entry, d);
            const better = nearest_max ? signed(value) > signed(best) : signed(value) < signed(best);
            if (better) {
                best = value;
                vm.sg16(0x3AD, value & 0xFFFF);
                vm.sg16(0x3AF, value >>> 16);
                vm.sg16(0x397, cx);
                vm.sg16(0x395, (entry - seg_base) & 0xFFFF);
            }
            entry += 3;
            cx -= 1;
        }
        vm.cx = vm.g16(0x397);
        vm.so8(8, vm.o8(8) - (vm.cx & 0xFF));
        const chosen = seg_base + vm.g16(0x395);
        for (let j = 0; j < 3; j++) vm.so8(9 + j, vm.mem.r8(chosen + j));
    };
}

statement(0x8C)(_towards(true));
statement(0x8D)(_towards(false));


export function move_by_velocity(vm) {
    [0, 2, 4].forEach((off, k) => vm.so16(off, u16(vm.o16(off) + sx8(vm.o8(9 + k)))));
}
statement(0x90)(move_by_velocity);

export function copy5(vm) {
    const off = vm.fetch16();
    for (let k = 0; k < 5; k++) vm.so8(u16(off + k), vm.fetch8());
}
statement(0x91)(copy5);

statement(0x92)((vm) => { vm.so16(-0x22, vm.fetch16()); });
statement(0x99)((vm) => { vm.so8(-3, vm.o8(-3) ^ 1); });
statement(0x9A)((vm) => { vm.so8(-3, 1); });
statement(0x9B)((vm) => { vm.so8(-3, 0); });
statement(0x9F)((vm) => { vm.so8(-0x25, 0); });
statement(0xA0)((vm) => { vm.so8(-0x25, 0xFF); });

export function set_shape(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    vm.so16(-0x1A, vm.dx);
}
statement(0xAD)(set_shape);


register_module('ops_objects', ops_objects);
