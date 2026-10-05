/**
 * Object searches and collision queries: box collision (0x53-0x56, 0x8e, 0x8f, 0xa3-0xa5,
 * search 0x3d1c), distance searches (0x59-0x5e, 0xcb, 0xcc; distance test 0x4706, sort 0x42e6),
 * searches by mask, class, kind byte or over all objects (0x93, 0x94, 0xca, 0x9c) and the shape
 * offset move 0xa2 (0x3a1b).
 *
 * Every search writes object handles to the result list at cs:0x96a, terminated by 0xffff, and ends
 * in 0x3d13: the cursor cs:[0x4f9] is rewound and the first entry goes through a destination item.
 * The searches keep their intermediate values in engine globals exactly where the original keeps
 * them (cs:[0x391..0x3af], cs:[0x4e5..0x50d], the distance list at cs:0x0f6c), so those are written
 * in the same order with the same values.
 *
 * Box tables: the graphics part of a class file (32-bit offset at class+0xe) holds at +6 the 32-bit
 * offset of a table of word offsets (relative to the table) to box records. Word +0 of a record:
 * low byte type, high byte count. Type 0: +2 mask, +4..+6 s8 corner, +7..+9 s8 extent; type 1:
 * +2 mask, +4..+8 corner words, +0xa..+0xe extent words; types 2..0x7f: a point at +2..+6; a type
 * with bit 7 set is a group of `count` word indexes (negative indexes are skipped).
 */
import * as ops_search from './ops_search.js';
import * as O from './ops_objects.js';
import { SKIP, FatalError, OriginalCrash, register_module, s16, statement } from './vm.js';

export const RESULTS = 0x96A;
export const DISTANCES = 0xF6C;
export const STACK_LEVELS = 100;          // group nesting that exhausts the original's ~1 KB stack

export function u16(v) {
    return v & 0xFFFF;
}

export function sx8(v) {
    v &= 0xFF;
    return v >= 128 ? v - 256 : v;
}

export function _r8(vm, seg, off) {
    return vm.mem.r8(seg * 16 + u16(off));
}

export function _r16(vm, seg, off) {
    return vm.mem.r16(seg * 16 + u16(off));
}

/** [handle, record] for every object of the table cs:[0x449], from handle 0 along the links. */
export function* _objects(vm) {
    const table = vm.g16(0x449);
    let h = 0;
    for (;;) {
        yield [h, vm.g16(u16(table + h))];
        h = vm.g16(u16(table + h + 4));
        if (h === 0) return;
    }
}


// --------------------------------------------------------------------- box tables
/** Fold a 32-bit offset (high word, 16-bit offset) into the segment, keeping the offset's low
 * four bits (0x3d4a-0x3d67). The high word is turned into paragraphs with XCHG AL,AH and four
 * shifts, which is exact for high words below 16. */
export function _normalize(seg, off, high) {
    high = u16(high);
    const para = ((((high & 0xFF) << 8) | (high >> 8)) << 4) & 0xFFFF;
    return [u16(seg + para + (off >> 4)), off & 0xF];
}

/** Add a 32-bit offset (low, high) to seg:off with the carry into the high word, normalized. */
export function _add32(seg, off, low, high) {
    const s = off + low;
    if (s > 0xFFFF) high += 1;
    return _normalize(seg, s & 0xFFFF, high);
}

/** Box table of record `rec`'s class as 0x3d38/0x3dc1 find it: the graphics part offset is
 * taken as a 16-bit word (class+0xe, no carry), the table offset as 32 bits. */
export function box_table_short(vm, rec) {
    const seg = O.rec16(vm, rec, -0x12);
    let off = O.rec16(vm, rec, -0x14);
    off = u16(off + _r16(vm, seg, off + 0xE));
    return _add32(seg, off, _r16(vm, seg, off + 6), _r16(vm, seg, off + 8));
}

/** Box table of record `rec`'s class as 0x39a5 and 0x4110 find it (both offsets 32-bit). */
export function box_table(vm, rec) {
    let seg = O.rec16(vm, rec, -0x12), off = O.rec16(vm, rec, -0x14);
    [seg, off] = _add32(seg, off, _r16(vm, seg, off + 0xE), _r16(vm, seg, off + 0x10));
    return _add32(seg, off, _r16(vm, seg, off + 6), _r16(vm, seg, off + 8));
}

/** Offset (in segment `seg`) of the record of box `index`. */
export function box_entry(vm, seg, table, index) {
    return u16(table + _r16(vm, seg, table + 2 * index));
}


// --------------------------------------------------------------------- shape offset (0x3a1b)
/** Code 0x3a1b: evaluate a box index and return the offset [x, y, z] it describes in the
 * current object's box table: the centre of a box (corner + extent / 2, arithmetic shifts) or a
 * point; x is negated when es:[bp-0x2e] >= 0x15 and the object is mirrored (es:[bp-3]). DX is
 * left as the routine leaves it. A group (type >= 0x80) is fatal error 0x14.
 *
 * An end code as the index drops this routine's return address, so the caller continues with
 * the registers the evaluator leaves: AX = the last code byte read, BX, CX. */
export function shape_offset(vm) {
    if (vm.evaluate() === SKIP) return [vm.mem.r8(vm.lin() - 1), vm.bx, vm.cx];
    const [seg, table] = box_table(vm, vm.bp);
    vm.dx = u16(2 * vm.dx);                                // 0x39a5 doubles the index in DX
    const si = u16(table + _r16(vm, seg, table + vm.dx));
    const t = _r8(vm, seg, si);
    let x, y, z;
    if (t === 0) {
        const b = [];
        for (let k = 4; k < 10; k++) b.push(sx8(_r8(vm, seg, si + k)));
        const half = b.slice(3).map((v) => v >> 1);
        [x, y, z] = [0, 1, 2].map((k) => b[k] + half[k]);
        vm.dx = u16(half[2]);
    } else if (t & 0x80) {
        throw new FatalError(0x14, 'shape offset of a group (0x3ab0)');
    } else if (t === 1) {
        const w = [];
        for (let k = 4; k < 0x10; k += 2) w.push(_r16(vm, seg, si + k));
        const half = w.slice(3).map((v) => s16(v) >> 1);
        [x, y, z] = [0, 1, 2].map((k) => w[k] + half[k]);
        vm.dx = u16(half[2]);
    } else {
        [x, y, z] = [2, 4, 6].map((k) => _r16(vm, seg, si + k));
    }
    if (sx8(vm.o8(-0x2E)) >= 0x15 && vm.o8(-3)) x = -x;
    return [u16(x), u16(y), u16(z)];
}

export function move_by_shape(vm) {
    const cx = vm.cx;                                      // 0x2b19 saves CX around the call
    const r = shape_offset(vm);
    [0, 2, 4].forEach((off, k) => vm.so16(off, vm.o16(off) + r[k]));
    vm.cx = cx;
}
statement(0xA2)(move_by_shape);


// --------------------------------------------------------------------- collision search (0x3d1c)
/** 0x3f43 / 0x4096 step: unless cs:[g] > v (signed), exchange them; returns the new v. */
export function _sort_pair(vm, g, v) {
    if (!(s16(vm.g16(g)) > s16(v))) {
        const old = vm.g16(g);
        vm.sg16(g, v);
        v = old;
    }
    return v;
}

/** Corner [bx, cx, dx] and far corner (cs:[0x399], [0x39b], [0x39d]) of a box record of type
 * 0 or 1 placed at (x0, y0, z0), x mirrored; si points at the corner fields. */
export function _box_coordinates(vm, w, seg, si, mirror, x0, y0, z0) {
    const c = [];
    if ((w & 0xFF) === 0) {
        for (let k = 0; k < 6; k++) c.push(sx8(_r8(vm, seg, si + k)));
    } else {
        for (let k = 0; k < 6; k++) c.push(_r16(vm, seg, si + 2 * k));
    }
    let bx = c[0], cx = c[1], dx = c[2];
    if (mirror) bx = -bx;
    bx = u16(bx + x0);
    cx = u16(cx + y0);
    dx = u16(dx + z0);
    [0x399, 0x39B, 0x39D].forEach((g, k) => vm.sg16(g, c[3 + k]));
    if (mirror) vm.sg16(0x399, -vm.g16(0x399));
    for (const [g, v] of [[0x399, bx], [0x39B, cx], [0x39D, dx]]) vm.sg16(g, vm.g16(g) + v);
    return [bx, cx, dx];
}

/** 0x3e8e: place an own box record at the query point (cs:[0x4e5..0x4e9], mirrored by
 * cs:[0x4eb]); store its range in cs:[0x503..0x50d] and test it against the other box. */
export function _own_leaf(vm, w, seg, si, other) {
    si = u16(si + 2);                                      // the own box's mask is not used
    const t = w & 0xFF;
    if (t > 1) return false;
    if (t === 0) vm.sg16(0x39F, w);
    let [bx, cx, dx] = _box_coordinates(vm, w, seg, si, vm.g8(0x4EB),
                                        vm.g16(0x4E5), vm.g16(0x4E7), vm.g16(0x4E9));
    cx = _sort_pair(vm, 0x39B, cx);
    dx = _sort_pair(vm, 0x39D, dx);
    bx = _sort_pair(vm, 0x399, bx);
    for (const [g, v] of [[0x503, bx], [0x505, cx], [0x507, dx], [0x509, vm.g16(0x399)],
                          [0x50B, vm.g16(0x39B)], [0x50D, vm.g16(0x39D)]]) {
        vm.sg16(g, v);
    }
    const [seg2, off2] = other;
    const w2 = _r16(vm, seg2, off2);
    if (w2 & 0x80) return _other_group(vm, seg2, u16(off2 + 2), w2 >> 8, 0);
    return _other_leaf(vm, w2, seg2, u16(off2 + 2));
}

/** 0x3e5c: hit if any child of an own group hits. */
export function _own_group(vm, seg, si, count, other, depth) {
    if (depth > STACK_LEVELS) throw new OriginalCrash('collision search: nested box groups overflow the machine stack');
    for (let i = 0; i < count; i++) {
        const idx = _r16(vm, seg, si);
        si = u16(si + 2);
        if (idx & 0x8000) continue;
        const seg1 = vm.g16(0x4FD), table = vm.g16(0x4FB);
        const off = box_entry(vm, seg1, table, idx);
        const w = _r16(vm, seg1, off);
        let hit;
        if (w & 0x80) {
            hit = _own_group(vm, seg1, u16(off + 2), w >> 8, other, depth + 1);
        } else {
            hit = _own_leaf(vm, w, seg1, u16(off + 2), other);
        }
        if (hit) return true;
    }
    return false;
}

/** 0x3fd5: the other object's box (record cs:[0x3a9], mirrored by its byte -3, at its
 * position) must share a mask bit with cs:[0x4ef] and overlap the own range (inclusive; y,
 * then z, then x). */
export function _other_leaf(vm, w, seg, si) {
    const rec = vm.g16(0x3A9), rseg = vm.g16(0x3AB);
    const t = w & 0xFF;
    if (t > 1) return false;
    const mask = _r16(vm, seg, si) & vm.g16(0x4EF);
    if (mask === 0) return false;
    if (t === 0) vm.sg16(0x39F, mask);
    const pos = [0, 2, 4].map((k) => _r16(vm, rseg, rec + k));
    let [bx, cx, dx] = _box_coordinates(vm, w, seg, u16(si + 2), _r8(vm, rseg, rec - 3), ...pos);
    cx = _sort_pair(vm, 0x39B, cx);
    if (s16(vm.g16(0x39B)) < s16(vm.g16(0x505)) || s16(cx) > s16(vm.g16(0x50B))) return false;
    dx = _sort_pair(vm, 0x39D, dx);
    if (s16(vm.g16(0x39D)) < s16(vm.g16(0x507)) || s16(dx) > s16(vm.g16(0x50D))) return false;
    bx = _sort_pair(vm, 0x399, bx);
    if (s16(vm.g16(0x399)) < s16(vm.g16(0x503)) || s16(bx) > s16(vm.g16(0x509))) return false;
    return true;
}

/** 0x3fa3: hit if any child of the other object's group hits. */
export function _other_group(vm, seg, si, count, depth) {
    if (depth > STACK_LEVELS) throw new OriginalCrash('collision search: nested box groups overflow the machine stack');
    for (let i = 0; i < count; i++) {
        const idx = _r16(vm, seg, si);
        si = u16(si + 2);
        if (idx & 0x8000) continue;
        const seg2 = vm.g16(0x501), table = vm.g16(0x4FF);
        const off = box_entry(vm, seg2, table, idx);
        const w = _r16(vm, seg2, off);
        let hit;
        if (w & 0x80) {
            hit = _other_group(vm, seg2, u16(off + 2), w >> 8, depth + 1);
        } else {
            hit = _other_leaf(vm, w, seg2, u16(off + 2));
        }
        if (hit) return true;
    }
    return false;
}

/** Code 0x3d1c: list the objects whose current box overlaps own box cs:[0x4ed] placed at
 * (cs:[0x4e5], [0x4e7], [0x4e9]). Candidates: same plane (variable +6), box index >= 0, not
 * the current object, from handle 0. Stops after the first hit unless cs:[0x50f] is set. */
export function collision_search(vm) {
    vm.sg16(0x4F9, RESULTS);
    const own = vm.g16(0x4ED);
    if (!(own & 0x8000)) {
        const [seg, table] = box_table_short(vm, vm.bp);
        vm.sg16(0x4FB, table);
        vm.sg16(0x4FD, seg);
        const own_off = box_entry(vm, seg, table, own);
        vm.sg16(0x3BD, own_off);
        vm.sg16(0x3BF, seg);
        for (const [h, rec] of _objects(vm)) {
            if (O.rec16(vm, rec, 6) !== vm.o16(6)) continue;
            const box = O.rec16(vm, rec, -0x1A);
            if (box & 0x8000 || rec === vm.bp) continue;
            vm.sg16(0x3A9, rec);
            vm.sg16(0x3AB, vm.es);
            const [seg2, table2] = box_table_short(vm, rec);
            vm.sg16(0x4FF, table2);
            vm.sg16(0x501, seg2);
            const other = [seg2, box_entry(vm, seg2, table2, box)];
            const w = _r16(vm, seg, own_off);
            let hit;
            if (w & 0x80) {
                hit = _own_group(vm, seg, u16(own_off + 2), w >> 8, other, 0);
            } else {
                hit = _own_leaf(vm, w, seg, u16(own_off + 2), other);
            }
            if (!hit) continue;
            vm.sg16(vm.g16(0x4F9), h);
            vm.sg16(0x4F9, vm.g16(0x4F9) + 2);
            if (vm.g8(0x50F) === 0) break;
        }
    }
    vm.sg16(vm.g16(0x4F9), 0xFFFF);
    vm.sg16(0x4F9, vm.g16(0x4F9) + 2);
}

/** Common end of the collision statements: the mask (and the box) operands, the search, the
 * first result through the destination (0x3d13). */
export function _query(vm, box) {
    if (vm.evaluate() === SKIP) return null;
    vm.sg16(0x4EF, vm.dx);
    if (box) {
        if (vm.evaluate() === SKIP) return null;
        vm.sg16(0x4ED, vm.dx);
    } else {
        vm.sg16(0x4ED, vm.o16(-0x1A));
    }
    collision_search(vm);
    return O.first_result(vm);
}

/** 0x53 / 0x54 / 0x55 / 0x56: query point from three expressions, relative to the position
 * (0x53, 0x55) or absolute (0x54, 0x56); own box from es:[bp-0x1a] or an expression. */
export function _point_query(relative, box) {
    return function h(vm) {
        vm.sg8(0x4EB, vm.o8(-3));
        const globals = [0x4E5, 0x4E7, 0x4E9];
        for (let k = 0; k < 3; k++) {
            if (vm.evaluate() === SKIP) return null;
            if (relative) vm.dx = u16(vm.dx + vm.o16(2 * k));
            vm.sg16(globals[k], vm.dx);
        }
        return _query(vm, box);
    };
}

statement(0x53)(_point_query(true, false));
statement(0x54)(_point_query(false, false));
statement(0x55)(_point_query(true, true));
statement(0x56)(_point_query(false, true));


/** 0x8e / 0x8f: query point = position + velocity (s8 variables +9, +0xa, +0xb). */
export function _ahead_query(box) {
    return function h(vm) {
        vm.sg8(0x4EB, vm.o8(-3));
        [0x4E5, 0x4E7, 0x4E9].forEach((g, k) => vm.sg16(g, vm.o16(2 * k) + sx8(vm.o8(9 + k))));
        return _query(vm, box);
    };
}

statement(0x8E)(_ahead_query(false));
statement(0x8F)(_ahead_query(true));


/** 0xa3 / 0xa4: query point = position + shape offset (0x3a1b) of a box index. */
export function _shape_query(box) {
    return function h(vm) {
        vm.sg8(0x4EB, vm.o8(-3));
        const r = shape_offset(vm);
        [0x4E5, 0x4E7, 0x4E9].forEach((g, k) => vm.sg16(g, r[k] + vm.o16(2 * k)));
        return _query(vm, box);
    };
}

statement(0xA3)(_shape_query(false));
statement(0xA4)(_shape_query(true));


export function query_here(vm) {
    vm.sg8(0x4EB, vm.o8(-3));
    [0x4E5, 0x4E7, 0x4E9].forEach((g, k) => vm.sg16(g, vm.o16(2 * k)));
    return _query(vm, true);
}
statement(0xA5)(query_here);


// --------------------------------------------------------------------- mask test (0x40f8)
/** Code 0x40f8: record `rec` is not the current object, has a box (es:[rec-0x1a] >= 0), and
 * the box's mask word ANDed with cs:[0x4ef] is nonzero; for a group, one of its children.
 * Original bugs: a group visits count + 1 children, and a child counts as a group when bit 15
 * of its type word is clear (that is, when its count byte is below 0x80), so only children with
 * a count byte >= 0x80 have their mask tested. */
export function mask_test(vm, rec) {
    const box = O.rec16(vm, rec, -0x1A);
    if (box & 0x8000 || rec === vm.bp) return false;
    const [seg, table] = box_table(vm, rec);
    const di = box_entry(vm, seg, table, box);
    const w = _r16(vm, seg, di);
    if (w & 0x80) return _mask_group(vm, seg, table, u16(di + 2), w >> 8, 0);
    return (_r16(vm, seg, di + 2) & vm.g16(0x4EF)) !== 0;
}

/** 0x4198 (with the child step 0x41c1). */
export function _mask_group(vm, seg, table, di, count, depth) {
    if (depth > STACK_LEVELS) throw new OriginalCrash('mask test 0x40f8: nested box groups overflow the machine stack');
    if (count === 0) return false;
    let dl = count;
    for (;;) {
        dl = (dl - 1) & 0xFF;
        const idx = _r16(vm, seg, di);
        di = u16(di + 2);
        if (!(idx & 0x8000)) {
            const child = box_entry(vm, seg, table, idx);
            const w = _r16(vm, seg, child);
            let hit;
            if (!(w & 0x8000)) {
                hit = _mask_group(vm, seg, table, u16(child + 2), w >> 8, depth + 1);
            } else {
                hit = (_r16(vm, seg, child + 2) & vm.g16(0x4EF)) !== 0;
            }
            if (hit) return true;
        }
        if (dl === 0xFF) return false;
    }
}


// --------------------------------------------------------------------- distance test (0x4706)
/** A 32-bit value as a signed number. */
export function _signed32(v) {
    return v | 0;
}

/** 32-bit comparison of the original: high words signed, low words unsigned (a and b are
 * unsigned 32-bit values). */
export function _above(a, b) {
    const ah = s16(a >>> 16), bh = s16(b >>> 16);
    return ah > bh || (ah === bh && (a & 0xFFFF) > (b & 0xFFFF));
}

/** The unsigned 32-bit value of the word pair cs:[lo] (low word), cs:[hi] (high word). */
function _g32(vm, lo, hi) {
    return vm.g16(lo) + vm.g16(hi) * 0x10000;
}

/** Code 0x4706: squared distance d2 from the current object to record `rec` (variables +0,
 * +2, +4) within the squared radius cs:[0x4f3]; with cs:[0x4f1] set also d2 <= k * (v . d),
 * v = velocity bytes +9..+0xb, k = cs:[0x4f7]: the object lies in a ball ahead along v.
 * Scratch: deltas cs:[0x393..0x397], d2 cs:[0x3a9], dot product cs:[0x399], k * dot cs:[0x39d]. */
export function distance_test(vm, rec) {
    const d = [];
    for (const [off, g] of [[0, 0x393], [2, 0x395], [4, 0x397]]) {
        const v = u16(O.rec16(vm, rec, off) - vm.o16(off));
        vm.sg16(g, v);
        d.push(s16(v));
    }
    const d2 = (d[0] * d[0] + d[1] * d[1] + d[2] * d[2]) >>> 0;
    vm.sg16(0x3A9, d2);
    vm.sg16(0x3AB, d2 >>> 16);
    const r2 = _g32(vm, 0x4F3, 0x4F5);
    if (_above(d2, r2)) return false;
    if (vm.g8(0x4F1) === 0) return true;
    let sum = 0;
    for (let k = 0; k < 3; k++) sum += sx8(vm.o8(9 + k)) * d[k];
    const dot = sum >>> 0;
    vm.sg16(0x399, dot);
    vm.sg16(0x39B, dot >>> 16);
    const k = vm.g16(0x4F7);
    const low = (dot & 0xFFFF) * k;
    vm.sg16(0x39D, low);
    vm.sg16(0x39F, Math.floor(low / 0x10000) + (dot >>> 16) * k);
    const front = _g32(vm, 0x39D, 0x39F);
    return !_above(d2, front);
}


// --------------------------------------------------------------------- sort (0x42e6)
/** Code 0x42e6: bubble-sort the distance list (cs:0x0f6c, 32-bit entries) ascending, moving
 * the handles of the result list with it; cx / dx point past the list terminator / the last
 * distance. Scratch: cs:[0x391] / [0x393] last handle / distance, cs:[0x397] pairs - 1. */
export function sort_results(vm, cx, dx) {
    dx = u16(dx - 4);
    cx = u16(cx - 4);
    const bx = u16(dx - DISTANCES);
    if (bx === 0) return;
    if (bx & 0x8000) {
        // Nothing found: the count wraps to 0x3ffe pairs and the passes sort the whole code
        // segment, overwriting the engine's code (the original then crashes).
        throw new OriginalCrash('sort 0x42e6 of an empty collect-all result overwrites the engine code');
    }
    vm.sg16(0x397, (bx >> 2) - 1);
    vm.sg16(0x391, cx);
    vm.sg16(0x393, dx);
    const g = (off) => vm.g16(off), sg = (off, v) => vm.sg16(off, v);
    for (;;) {
        let si = g(0x391), di = g(0x393), n = g(0x397);
        let swapped = false;
        for (;;) {
            si = u16(si - 2);
            const hi = g(u16(di + 2)), lo = g(di);
            di = u16(di - 4);
            if (s16(hi) < s16(g(u16(di + 2))) || (hi === g(u16(di + 2)) && lo < g(di))) {
                const prev_hi = g(u16(di + 2)), prev_lo = g(di);
                sg(u16(di + 2), hi);
                sg(di, lo);
                sg(u16(di + 6), prev_hi);
                sg(u16(di + 4), prev_lo);
                const a = g(si), b = g(u16(si + 2));
                sg(si, b);
                sg(u16(si + 2), a);
                swapped = true;
            }
            n = u16(n - 1);
            if (n === 0xFFFF) break;
        }
        if (!swapped) return;
    }
}


// --------------------------------------------------------------------- distance searches
/** Common body of 0x4398 / 0x4472 / 0x455a: the nearest object passing `accept(rec, dx)`
 * (dx = the distance-list pointer, which 0x455a compares by mistake), or with cs:[0x50f] all
 * of them sorted by distance. The nearest form starts the lists with a sentinel distance
 * 0x7fffffff and keeps one entry, replaced by a strictly nearer hit. */
export function _nearest(vm, accept) {
    let cx = RESULTS, dx = DISTANCES;
    if (vm.g8(0x50F) === 0) {
        vm.sg16(dx, 0xFFFF);
        vm.sg16(dx + 2, 0x7FFF);
        dx += 4;
        vm.sg16(cx, 0xFFFF);
        cx += 2;
    }
    for (const [h, rec] of _objects(vm)) {
        if (!accept(rec, dx)) continue;
        if (vm.g8(0x50F) === 0) {
            const best = _g32(vm, u16(dx - 4), u16(dx - 2));
            const d2 = _g32(vm, 0x3A9, 0x3AB);
            if (!_above(best, d2)) continue;
            cx -= 2;
            dx -= 4;
        }
        vm.sg16(dx, vm.g16(0x3A9));
        vm.sg16(dx + 2, vm.g16(0x3AB));
        dx += 4;
        vm.sg16(cx, h);
        cx += 2;
    }
    vm.sg16(cx, 0xFFFF);
    cx += 2;
    if (vm.g8(0x50F)) sort_results(vm, cx, dx);
    vm.sg8(0x50F, 0);
    vm.cx = cx;
    return O.first_result(vm);
}

/** cs:[0x4f1] = front-test flag; radius expression squared (unsigned) to cs:[0x4f3]; DX keeps
 * the high word of the product as MUL leaves it. With the front test, k to cs:[0x4f7]. */
export function _radius(vm, front) {
    vm.sg8(0x4F1, front ? 1 : 0);
    if (vm.evaluate() === SKIP) return SKIP;
    const r2 = vm.dx * vm.dx;
    vm.sg16(0x4F3, r2);
    vm.sg16(0x4F5, r2 >>> 16);
    vm.dx = r2 >>> 16;
    if (front) {
        if (vm.evaluate() === SKIP) return SKIP;
        vm.sg16(0x4F7, vm.dx);
    }
    return null;
}

/** 0x5b / 0x5e (body 0x4398): nearest object in the same plane passing the mask test 0x40f8
 * within the radius. Only the low byte of the mask cs:[0x4ef] is written (original bug). */
export function _by_mask(front) {
    return function h(vm) {
        if (_radius(vm, front) === SKIP) return null;
        if (vm.evaluate() === SKIP) return null;
        vm.sg8(0x4EF, vm.dx);

        const accept = (rec, _dx) => (O.rec16(vm, rec, 6) === vm.o16(6) && mask_test(vm, rec)
                                      && distance_test(vm, rec));
        return _nearest(vm, accept);
    };
}

statement(0x5B)(_by_mask(false));
statement(0x5E)(_by_mask(true));


/** 0x5a / 0x5d (body 0x4472): nearest object of a class (u16 operand, kept in cs:[0x3a1]) in
 * the same plane within the radius, not the current object. */
export function _by_class(front) {
    return function h(vm) {
        if (_radius(vm, front) === SKIP) return null;
        vm.dx = vm.fetch16();
        vm.sg16(0x3A1, vm.dx);

        const accept = (rec, _dx) => (vm.g16(0x3A1) === O.rec16(vm, rec, -0x10)
                                      && O.rec16(vm, rec, 6) === vm.o16(6)
                                      && rec !== vm.bp && distance_test(vm, rec));
        return _nearest(vm, accept);
    };
}

statement(0x5A)(_by_class(false));
statement(0x5D)(_by_class(true));


/** 0xcb / 0xcc (body 0x455a): nearest object of a kind (byte variable +0xc) in the same plane
 * within the radius. Original bug: the u16 kind operand is lost; the byte compared is the low
 * byte of the distance-list pointer (0x70 for the nearest form, 0x6c + 4 per hit so far when
 * collecting all). */
export function _by_kind(front) {
    return function h(vm) {
        if (_radius(vm, front) === SKIP) return null;
        vm.dx = vm.fetch16();

        const accept = (rec, dx) => ((dx & 0xFF) === O.rec8(vm, rec, 0xC)
                                     && O.rec16(vm, rec, 6) === vm.o16(6)
                                     && rec !== vm.bp && distance_test(vm, rec));
        return _nearest(vm, accept);
    };
}

statement(0xCB)(_by_kind(false));
statement(0xCC)(_by_kind(true));


/** 0x59 / 0x5c (body 0x4639): the object of a handle expression if it is in the same plane
 * within the radius (no check that the handle is valid; the current object may pass). */
export function _within(front) {
    return function h(vm) {
        if (_radius(vm, front) === SKIP) return null;
        if (vm.evaluate() === SKIP) return null;
        let cx = RESULTS;
        const handle = vm.dx;
        const rec = vm.g16(u16(vm.g16(0x449) + handle));
        if (O.rec16(vm, rec, 6) === vm.o16(6) && distance_test(vm, rec)) {
            vm.sg16(cx, handle);
            cx += 2;
        }
        vm.sg16(cx, 0xFFFF);
        vm.sg8(0x50F, 0);
        vm.cx = cx;
        return O.first_result(vm);
    };
}

statement(0x59)(_within(false));
statement(0x5C)(_within(true));


// --------------------------------------------------------------------- lists without distance
/** Common body of 0x41e1 / 0x422a / 0x4273: objects from handle 0 passing `accept`, the
 * first only unless cs:[0x50f] is set; then cs:[0x50f] = 0 and the first result. */
export function _collect(vm, accept) {
    let cx = RESULTS;
    for (const [h, rec] of _objects(vm)) {
        if (!accept(rec)) continue;
        vm.sg16(cx, h);
        cx += 2;
        if (vm.g8(0x50F) === 0) break;
    }
    vm.sg16(cx, 0xFFFF);
    vm.sg8(0x50F, 0);
    vm.cx = cx;
    return O.first_result(vm);
}

/** Objects passing the mask test 0x40f8 (no plane, no distance); only the mask's low byte is
 * written. */
export function find_by_mask(vm) {
    if (vm.evaluate() === SKIP) return null;
    vm.sg8(0x4EF, vm.dx);
    return _collect(vm, (rec) => mask_test(vm, rec));
}
statement(0x93)(find_by_mask);

export function find_by_class(vm) {
    vm.dx = vm.fetch16();
    return _collect(vm, (rec) => vm.dx === O.rec16(vm, rec, -0x10) && rec !== vm.bp);
}
statement(0x94)(find_by_class);

export function find_by_kind(vm) {
    if (vm.evaluate() === SKIP) return null;
    return _collect(vm, (rec) => (vm.dx & 0xFF) === O.rec8(vm, rec, 0xC) && rec !== vm.bp);
}
statement(0xCA)(find_by_kind);

/** Every object after handle 0 (the current one included), whatever cs:[0x50f] says. */
export function all_objects(vm) {
    const table = vm.g16(0x449);
    let di = RESULTS;
    let h = 0;
    for (;;) {
        h = vm.g16(u16(table + h + 4));
        if (h === 0) break;
        vm.sg16(di, h);
        di += 2;
    }
    vm.sg16(di, 0xFFFF);
    vm.sg8(0x50F, 0);
    return O.first_result(vm);
}
statement(0x9C)(all_objects);


register_module('ops_search', ops_search);
