/**
 * Views and display: view records (0x46, 0x4e, 0x4f; camera and projection parameters 0x38,
 * 0x39, 0xc0-0xc6, 0xd1, 0xdf, 0xe0), graphics shown in display nodes (0x48, 0x49, 0xa6-0xab),
 * node removal (0x4a, 0x4b, 0x50, 0xdb-0xdd), per-object node attributes (0xc7, 0xcf, 0xd0), text
 * output modes 1 and 2 (0xb6-0xb9, font 0xba, text position 0xbf), the pen (0x79, 0x7c-0x80), the
 * pointer image (0x87) and palettes (0x68, 0x69, 0xbc, 0xbe, 0xd7).
 *
 * View records live inside object 0's variables: view handle v is the record at es:[cs:[0x473] + v]
 * (+0 flags, +1 mode, +2 window node, +4 next view, +6..+0x25 creation data, +0x26..+0x28 depth
 * axis, +0x2a..+0x2e pending camera move). The view list starts at cs:[0x493].
 *
 * Display nodes (0x26 bytes) live in the segment of the far pointer cs:[0x45f] (segment
 * cs:[0x461]); node offsets are offsets in that segment. Free list: cs:[0x463], linked by +4.
 * Node: +0 state (0xff new, 2 changed, 0 drawn, 1 erase at frame end), +1 slot, +2 view, +4 next in
 * the object's list (head es:[bp-0x18], sorted descending by view, then slot), +6 next in the
 * view's list (head = the view's window node), +0x12/+0x14 graphic directory entry (offset,
 * segment), +0x16/+0x18/+0x1a position, +0x1c/+0x1d depth shift / bias, +0x1e group word, +0x20
 * priority, +0x23 mirror, +0x24/+0x25 snapping.
 *
 * Not modelled, because they only reach the display hardware: the video BIOS calls (0x79 pixel,
 * int 10h AH=0Ch; 0x68 CGA palette 0xc166, int 10h AH=0Bh), the hardware palette programming
 * (0x4a6a -> 0x94b4, ports only) and the EGA/VGA drawing of 0x7c (0x9886 + 0x9772). The CGA drawing
 * of 0x7c (back buffer at segment cs:[0x667], then the screen at B800) is reproduced. A fatal error
 * raises FatalError; a palette record shown through 0x2360 raises OriginalCrash.
 */
import * as ops_view from './ops_view.js';
import * as F from './ops_flow.js';
import {
    CS, FatalError, NotImplementedError, OriginalCrash, SKIP, VALUE_STACK, register_module, statement,
} from './vm.js';

export const MAIN_RECORD = 0x473;
export const VIEW_LIST = 0x493;
export const POOL = 0x45F;                                 // far pointer; its segment word is 0x461
export const FREE = 0x463;
export const IMMEDIATE = 0x470;                            // remove nodes at once (0xdb-0xdd)
export const SNAPSHOT = 0x477;                             // position +0/+2/+4 before a script run
export const OFFSET = 0x47F;                               // placement offset x, y, z
export const SLOT = 0x48B;
export const MIRROR = 0x48F;                               // byte; word push/pop includes 0x490
export const IN_GROUP = 0x490;
export const ADD_GLYPH = 0x491;
export const SOURCE = 0x492;                               // 0 own class, 1 object 0's class
export const PALETTE = 0x5A9;                              // 16 words R, G<<4|B
export const BASE_PALETTE = 0x5E9;


export function u16(v) {
    return v & 0xFFFF;
}

export function sx8(v) {
    v &= 0xFF;
    return v >= 128 ? v - 256 : v;
}

export function s16(v) {
    v &= 0xFFFF;
    return v >= 32768 ? v - 65536 : v;
}


// --------------------------------------------------------------------- memory access
export function es_addr(vm, off) {
    return vm.es * 16 + u16(off);
}

/** ES offset of the view record v (default: the object's current view es:[bp-0x16]). */
export function view_offset(vm, v = null) {
    return u16(vm.g16(MAIN_RECORD) + (v == null ? vm.o16(-0x16) : v));
}

export function _dseg(vm) {
    return vm.g16(POOL + 2) * 16;
}

export function n8(vm, n, off) {
    return vm.mem.r8(_dseg(vm) + u16(n + off));
}

export function n16(vm, n, off) {
    return vm.mem.r16(_dseg(vm) + u16(n + off));
}

export function set_n8(vm, n, off, v) {
    vm.mem.w8(_dseg(vm) + u16(n + off), v);
}

export function set_n16(vm, n, off, v) {
    vm.mem.w16(_dseg(vm) + u16(n + off), v);
}

/** n evaluations (0x573a); the values, or null when an end code abandoned the statement. */
export function evaluate_all(vm, n) {
    const out = [];
    for (let i = 0; i < n; i++) {
        if (vm.evaluate() === SKIP) return null;
        out.push(vm.dx);
    }
    return out;
}


// --------------------------------------------------------------------- view list
/** Code 0x21d3: append view v to the view list (link at view +4, head cs:[0x493]). A view
 * already in the list is cut off there and linked to itself or truncates the list. */
export function append_view(vm, v) {
    const main = vm.g16(MAIN_RECORD);
    vm.mem.w16(es_addr(vm, v + main + 4), 0);
    let p = vm.g16(VIEW_LIST);
    if (p === 0) {
        vm.sg16(VIEW_LIST, v);
        return;
    }
    for (;;) {
        const nxt = vm.mem.r16(es_addr(vm, p + main + 4));
        if (nxt === 0) break;
        p = nxt;
    }
    vm.mem.w16(es_addr(vm, p + main + 4), v);
}

/** Code 0x21fc: remove view v from the view list. */
export function unlink_view(vm, v) {
    const main = vm.g16(MAIN_RECORD);
    let p = vm.g16(VIEW_LIST);
    if (p === 0) return;
    if (p === v) {
        vm.sg16(VIEW_LIST, vm.mem.r16(es_addr(vm, v + main + 4)));
        return;
    }
    for (;;) {
        const nxt = vm.mem.r16(es_addr(vm, p + main + 4));
        if (nxt === v) {
            vm.mem.w16(es_addr(vm, p + main + 4), vm.mem.r16(es_addr(vm, v + main + 4)));
            return;
        }
        p = nxt;
        if (nxt === 0) return;
    }
}

/** Code 0x222f: depth axis w = u x v of the view record at ES offset vb (u at +0x20, v at
 * +0x23, signed bytes). The three components are stored as overlapping words at +0x26, +0x27,
 * +0x28. Returns the last component (left in DX). */
export function cross_product(vm, vb) {
    const b = (k) => sx8(vm.mem.r8(es_addr(vm, vb + k)));
    let dx = 0;
    for (const [dest, [a1, b1, a2, b2]] of [[0x26, [0x21, 0x25, 0x24, 0x22]], [0x27, [0x22, 0x23, 0x25, 0x20]],
                                            [0x28, [0x20, 0x24, 0x23, 0x21]]]) {
        dx = u16(b(a1) * b(b1) - b(a2) * b(b2));
        vm.mem.w16(es_addr(vm, vb + dest), dx);
    }
    return dx;
}


// --------------------------------------------------------------------- graphics lookup
/** Record whose class supplies the graphics: the current object, or object 0 (cs:[0x492]). */
export function _graphics_owner(vm) {
    return vm.g8(SOURCE) ? vm.g16(MAIN_RECORD) : vm.bp;
}

/** [class segment, offset of the directory] of the graphics owner's class. */
export function _directory(vm) {
    const a = es_addr(vm, _graphics_owner(vm) - 0x14);
    const off = vm.mem.r16(a), seg = vm.mem.r16(a + 2);
    const base = seg * 16;
    let bx = u16(off + vm.mem.r16(base + u16(off + 0xE)));
    bx = u16(bx + vm.mem.r16(base + bx));
    return [seg, bx];
}

/** Code 0x2995: [segment, offset] of the directory entry of graphic g. */
export function graphic_entry(vm, g) {
    const [seg, d] = _directory(vm);
    return [seg, u16(d + 4 * g)];
}

/** Code 0x2940: normalised far pointer [segment, offset] of graphic g's record (the entry's
 * 32-bit self-relative offset added), and the value it leaves in CX. */
export function graphic_record(vm, g) {
    let [seg, bx] = graphic_entry(vm, g);
    const base = seg * 16;
    let cx = vm.mem.r16(base + bx);
    let ax = vm.mem.r16(base + u16(bx + 2));
    const total = bx + cx;
    bx = u16(total);
    if (total > 0xFFFF) ax = u16(ax + 1);
    ax = u16((((ax & 0xFF) << 8) | (ax >> 8)) << 4);
    ax = u16(ax + seg);
    cx = bx >> 4;
    ax = u16(ax + cx);
    return [ax, bx & 0xF, cx];
}


// --------------------------------------------------------------------- object node list
/** Code 0x2502: node n has the object's view and the slot cs:[0x48b]. */
export function _key_match(vm, n) {
    return n16(vm, n, 2) === vm.o16(-0x16) && n8(vm, n, 1) === vm.g8(SLOT);
}

/** Code 0x251a: first node of the object with key (es:[bp-0x16], cs:[0x48b]) in its list,
 * sorted descending by view, then slot (signed). Returns [found, previous node or 0, the node
 * or the node to insert before, the CX left: the view, or null for an empty list]. */
export function find_slot(vm) {
    let prev = 0, n = vm.o16(-0x18);
    if (n === 0) return [false, 0, 0, null];
    const view = vm.o16(-0x16), slot = vm.g8(SLOT);
    for (;;) {
        const nv = n16(vm, n, 2);
        if (s16(view) < s16(nv)) {
            [prev, n] = [n, n16(vm, n, 4)];
            if (n === 0) return [false, prev, n, view];
            continue;
        }
        if (view !== nv) return [false, prev, n, view];
        const ns = n8(vm, n, 1);
        if (sx8(slot) < sx8(ns)) {
            [prev, n] = [n, n16(vm, n, 4)];
            if (n === 0) return [false, prev, n, view];
            continue;
        }
        return [slot === ns, prev, n, view];
    }
}

/** Code 0x24f9: the node after n, and whether it has the same key. */
export function next_same(vm, n) {
    const prev = n;
    n = n16(vm, n, 4);
    if (n === 0) return [false, prev, n];
    return [_key_match(vm, n), prev, n];
}

/** Code 0x254b: first node of the object in its current view; [found, prev, node, CX]. */
export function find_view(vm) {
    let prev = 0, n = vm.o16(-0x18);
    if (n === 0) return [false, 0, 0, null];
    const view = vm.o16(-0x16);
    for (;;) {
        const nv = n16(vm, n, 2);
        if (s16(view) < s16(nv)) {
            [prev, n] = [n, n16(vm, n, 4)];
            if (n === 0) return [false, prev, n, view];
            continue;
        }
        return [view === nv, prev, n, view];
    }
}

/** Code 0x2571: take a node from the free list, link it into the object's list between
 * prev and before, key it with (es:[bp-0x16], cs:[0x48b]), state 0xff, and put it first in
 * the view's list (after the window node es:[view+2]). An empty pool is fatal error 10. */
export function allocate_node(vm, prev, before) {
    const n = vm.g16(FREE);
    if (n === 0) throw new FatalError(0xA);
    vm.sg16(FREE, n16(vm, n, 4));
    if (prev === 0) vm.so16(-0x18, n);
    else set_n16(vm, prev, 4, n);
    set_n16(vm, n, 4, before);
    set_n16(vm, n, 2, vm.o16(-0x16));
    set_n8(vm, n, 1, vm.g8(SLOT));
    set_n8(vm, n, 0, 0xFF);
    const window = vm.mem.r16(es_addr(vm, view_offset(vm) + 2));
    set_n16(vm, n, 6, n16(vm, window, 6));
    set_n16(vm, window, 6, n);
    return n;
}

/** Code 0x2a9d: remove node n from its view's list (head = the window node at view+2). */
export function unlink_from_view(vm, n) {
    const va = es_addr(vm, vm.g16(MAIN_RECORD) + n16(vm, n, 2) + 2);
    if (n === vm.mem.r16(va)) {
        vm.mem.w16(va, n16(vm, n, 6));
        return;
    }
    let p = vm.mem.r16(va);
    while (n16(vm, p, 6) !== n) p = n16(vm, p, 6);
    set_n16(vm, p, 6, n16(vm, n, 6));
}

/** Code 0x2a45: unlink node n (after prev, 0 = list head) from the object's list. A drawn
 * node (state >= 0) with cs:[0x470] == 0 is marked state 1 for the renderer to erase and
 * free; otherwise it goes back to the free list and leaves its view's list at once.
 * Returns the node that follows prev after the removal. */
export function remove_node(vm, prev, n) {
    if (vm.g8(IMMEDIATE) === 0 && !(n8(vm, n, 0) & 0x80)) {
        set_n8(vm, n, 0, 1);
        _unlink_object(vm, prev, n);
    } else {
        _unlink_object(vm, prev, n);
        set_n16(vm, n, 4, vm.g16(FREE));
        vm.sg16(FREE, n);
        unlink_from_view(vm, n);
    }
    return prev === 0 ? vm.o16(-0x18) : n16(vm, prev, 4);
}

export function _unlink_object(vm, prev, n) {
    if (prev === 0) vm.so16(-0x18, n16(vm, n, 4));
    else set_n16(vm, prev, 4, n16(vm, n, 4));
}


// --------------------------------------------------------------------- palette
/** Code 0x4a6a: send the palette cs:0x5a9 to the VGA colour registers (DAC entries 0-15,
 * 0x94b4 -> 0x9592). Only ports are written; `vm.dac` keeps the 32 bytes sent, which is what the
 * screen shows from then on (the attribute registers map colour i to DAC entry i, 0x954d). */
export function program_palette(vm) {
    vm.dac = vm.mem.m.slice(CS + PALETTE, CS + PALETTE + 32);
}

/** Code 0x4a28: on VGA (cs:[0x423]) and unless locked by cs:[0x471], copy the 16 words at
 * lin + 2 to the palette cs:0x5a9 and program it (0x4a6a); clear the lock. */
export function load_palette_record(vm, lin) {
    if (vm.g8(0x423) && vm.g8(0x471) === 0) {
        for (let k = 0; k < 32; k++) vm.sg8(PALETTE + k, vm.mem.r8(lin + 2 + k));
        program_palette(vm);
    }
    vm.sg8(0x471, 0);
}


// --------------------------------------------------------------------- show a graphic
/** Code 0x2360: show graphic DX of the selected class (cs:[0x492]) in the object's display
 * node with key (view es:[bp-0x16], slot cs:[0x48b]) at the position snapshot cs:[0x477..]
 * plus the offset cs:[0x47f..], mirrored when cs:[0x48f] is set.
 *
 * A single image (record type < 0x80) reuses the slot's first node (state 2) or allocates one
 * (state 0xff); inside a group (cs:[0x490]) or for glyphs (cs:[0x491]) it reuses the next
 * node still in state 0 instead. A group (other types >= 0x80) is `count` elements of 8
 * bytes after a 2-byte header (graphic word, bit 15 toggles the mirror; dx (negated when
 * mirrored), dy, dz added to the offset), each shown in turn. At the top level the slot's
 * nodes still in state 0 (not reused) are removed afterwards. The palette record (type 0xfe)
 * jumps to 0x4a28 with the registers of this routine still pushed, so the original returns
 * to the address held in SI; see show_palette_record. */
export function show_graphic(vm) {
    vm.sg8(IN_GROUP, 0);
    _show(vm);
}

/** Code 0x2366, the recursive part of 0x2360. */
export function _show(vm) {
    const [seg, off] = graphic_record(vm, vm.dx);
    const rec = seg * 16 + off;
    const kind = vm.mem.r8(rec);
    if (kind & 0x80) {
        if (kind === 0xFE) {
            show_palette_record(vm, off);
            return;
        }
        const count = vm.mem.r8(rec + 1);
        let p = u16(off + 2);
        for (let i = 0; i < count; i++) {
            const saved = [MIRROR, OFFSET, OFFSET + 2, OFFSET + 4].map((a) => vm.g16(a));
            vm.sg8(IN_GROUP, 1);
            let child = vm.mem.r16(seg * 16 + p);
            let [dx, dy, dz] = [2, 4, 6].map((k) => vm.mem.r16(seg * 16 + u16(p + k)));
            p = u16(p + 8);
            if (vm.g8(MIRROR)) dx = u16(-dx);
            vm.sg16(OFFSET, vm.g16(OFFSET) + dx);
            vm.sg16(OFFSET + 2, vm.g16(OFFSET + 2) + dy);
            vm.sg16(OFFSET + 4, vm.g16(OFFSET + 4) + dz);
            if (child & 0x8000) {
                child &= 0x7FFF;
                vm.sg8(MIRROR, vm.g8(MIRROR) ^ 1);
            }
            vm.dx = child;
            _show(vm);
            const back = saved.slice().reverse();
            [OFFSET + 4, OFFSET + 2, OFFSET, MIRROR].forEach((a, k) => vm.sg16(a, back[k]));
        }
    } else {
        _place(vm);
    }
    if (vm.g8(IN_GROUP) === 0) _remove_unused(vm);
    vm.sg8(ADD_GLYPH, 0);
}

/** Palette record reached through 0x2360 (JMP 0x4a28 with DS, DI, BX, CX, SI still pushed):
 * 0x4a28 copies from ES (the object segment) at the record's normalised offset + 2 instead of
 * from the record, and its RET pops the saved SI as a return address. The memory effect of
 * 0x4a28 is reproduced, then OriginalCrash is raised. */
export function show_palette_record(vm, off) {
    load_palette_record(vm, es_addr(vm, off));
    throw new OriginalCrash('palette record shown through 0x2360: the original returns to address SI');
}

/** Code 0x2402-0x24c5: choose the node for a single image and fill it. */
export function _place(vm) {
    let [found, prev, n] = find_slot(vm);
    if (vm.g8(ADD_GLYPH) || vm.g8(IN_GROUP)) {
        for (;;) {
            if (!found) {
                n = allocate_node(vm, prev, n);
                break;
            }
            if (n8(vm, n, 0) === 0) {
                set_n8(vm, n, 0, 2);
                break;
            }
            [found, prev, n] = next_same(vm, n);
        }
    } else {
        if (!found) n = allocate_node(vm, prev, n);
        if (!(n8(vm, n, 0) & 0x80)) set_n8(vm, n, 0, 2);
    }
    const [seg, entry] = graphic_entry(vm, vm.dx);
    set_n16(vm, n, 0x12, entry);
    set_n16(vm, n, 0x14, seg);
    set_n8(vm, n, 0x23, vm.g8(MIRROR));
    set_n16(vm, n, 0x1E, vm.o16(-0x2A));
    set_n8(vm, n, 0x20, vm.o8(-0x2B));
    set_n8(vm, n, 0x24, vm.o8(-0x2C));
    set_n8(vm, n, 0x25, vm.o8(-0x2D));
    set_n8(vm, n, 0x1C, vm.o8(-0x25));
    if (!(vm.o8(-0x25) & 0x80)) {
        set_n8(vm, n, 0x1D, vm.o8(-0x27));
        set_n8(vm, n, 0x1C, vm.o8(-0x26));
        if (vm.o8(-0x26) & 0x80) {
            set_n8(vm, n, 0x1D, 0);
            set_n8(vm, n, 0x1C, vm.mem.r8(es_addr(vm, view_offset(vm) + 0x1F)));
        }
    }
    for (let k = 0; k < 3; k++) set_n16(vm, n, 0x16 + 2 * k, vm.g16(SNAPSHOT + 2 * k) + vm.g16(OFFSET + 2 * k));
}

/** Code 0x24cf-0x24eb: remove the slot's nodes still in state 0. */
export function _remove_unused(vm) {
    let [found, prev, n] = find_slot(vm);
    if (!found) return;
    for (;;) {
        if (n8(vm, n, 0) !== 0) {
            [found, prev, n] = next_same(vm, n);
            if (!found) return;
            continue;
        }
        n = remove_node(vm, prev, n);
        if (n === 0 || !_key_match(vm, n)) return;
    }
}


// --------------------------------------------------------------------- views and camera
export function camera_move(vm) {
    const v = evaluate_all(vm, 3);
    if (v == null) return undefined;
    const vb = view_offset(vm);
    v.forEach((d, k) => vm.mem.w16(es_addr(vm, vb + 0x2A + 2 * k), d));
    vm.mem.w8(es_addr(vm, vb), vm.mem.r8(es_addr(vm, vb)) | 0x80);
}
statement(0x38)(camera_move);

export function camera_to(vm) {
    const v = evaluate_all(vm, 3);
    if (v == null) return undefined;
    const vb = view_offset(vm);
    for (const k of [2, 1, 0]) {
        const cam = vm.mem.r16(es_addr(vm, vb + 0x16 + 2 * k));
        vm.dx = u16(v[k] - cam);
        vm.mem.w16(es_addr(vm, vb + 0x2A + 2 * k), vm.dx);
    }
    vm.mem.w8(es_addr(vm, vb), vm.mem.r8(es_addr(vm, vb)) | 0x80);
}
statement(0x39)(camera_to);

/** Code 0x1d59: view record, its window node (from cs:[0x45f] + cs:[0x463]), list entry and
 * depth axis. */
export function define_view(vm) {
    const v = vm.fetch16();
    const vb = u16(v + vm.g16(MAIN_RECORD));
    const at = (k) => es_addr(vm, vb + k);

    vm.mem.w8(at(0), vm.mem.r8(at(0)) | 0x40);
    vm.mem.w8(at(1), vm.fetch8());
    for (let k = 0; k < 32; k++) vm.mem.w8(at(6 + k), vm.fetch8());
    vm.cx = 0;
    const n = u16(vm.g16(POOL) + vm.g16(FREE));
    if (n === 0) throw new FatalError(0xA);
    vm.sg16(FREE, n16(vm, n, 4));
    vm.mem.w16(at(2), n);
    set_n16(vm, n, 6, 0);
    vm.mem.w16(at(4), 0);
    set_n8(vm, n, 1, vm.mem.r8(at(1)));
    const x = vm.mem.r16(at(0xE)), y = vm.mem.r16(at(0x10));
    set_n16(vm, n, 0xC, x & 0xFFF0);
    set_n16(vm, n, 0xE, y);
    set_n16(vm, n, 0x10, 0x7FFF);
    set_n16(vm, n, 0x16, u16(x + vm.mem.r16(at(0x12))) | 0xF);
    set_n16(vm, n, 0x18, u16(y + vm.mem.r16(at(0x14))));
    for (const k of [0x2A, 0x2C, 0x2E]) vm.mem.w16(at(k), 0);
    append_view(vm, v);
    vm.dx = cross_product(vm, vb);
}
statement(0x46)(define_view);

/** Code 0x21aa: clear 'hidden', mark changed, move the view to the end of the list. */
export function show_view(vm) {
    const v = vm.fetch16();
    const a = es_addr(vm, v + vm.g16(MAIN_RECORD));
    vm.mem.w8(a, (vm.mem.r8(a) & 0xBF) | 0x80);
    unlink_view(vm, v);
    append_view(vm, v);
}
statement(0x4E)(show_view);

export function hide_view(vm) {
    const a = es_addr(vm, vm.fetch16() + vm.g16(MAIN_RECORD));
    vm.mem.w8(a, vm.mem.r8(a) | 0x40);
}
statement(0x4F)(hide_view);

/** 0xc0 (view +0xa/+0xc), and 0xc1/0xc2, which leave out the view offset (original bug) and
 * write object 0's record at +0xe/+0x10 and +0x12/+0x14. */
export function _view_pair(off, add_view) {
    return function h(vm) {
        if (vm.evaluate() === SKIP || vm.evaluate_keep() === SKIP) return undefined;
        const view = vm.o16(-0x16);
        if (view === 0) return undefined;
        const b = u16(vm.g16(MAIN_RECORD) + (add_view ? view : 0));
        vm.mem.w16(es_addr(vm, b + off), vm.dx);
        vm.mem.w16(es_addr(vm, b + off + 2), vm.cx);
        vm.mem.w8(es_addr(vm, b), vm.mem.r8(es_addr(vm, b)) | 0x80);
    };
}

statement(0xC0)(_view_pair(0xA, true));
statement(0xC1)(_view_pair(0xE, false));
statement(0xC2)(_view_pair(0x12, false));

/** 0xc3 (axis u at +0x20) / 0xc4 (axis v at +0x23, then w = u x v). The guard tests only
 * the low byte of the view handle and comes before the operands, which are then not read. */
export function _axis(off, recompute) {
    return function h(vm) {
        if (vm.o8(-0x16) === 0) return undefined;
        const v = evaluate_all(vm, 3);
        if (v == null) return undefined;
        const vb = view_offset(vm);
        for (const k of [2, 1, 0]) vm.mem.w8(es_addr(vm, vb + off + k), v[k]);
        vm.dx = v[0];
        if (recompute) vm.dx = cross_product(vm, vb);
        vm.mem.w8(es_addr(vm, vb), vm.mem.r8(es_addr(vm, vb)) | 0x80);
    };
}

statement(0xC3)(_axis(0x20, false));
statement(0xC4)(_axis(0x23, true));

/** Code 0x1f91: view +0x1d = a, +0x1e = b - 1, +0x1f = c; without a view the third operand
 * is not read. */
export function perspective(vm) {
    if (vm.evaluate() === SKIP || vm.evaluate_keep() === SKIP) return undefined;
    const view = vm.o16(-0x16);
    if (view === 0) return undefined;
    const vb = u16(vm.g16(MAIN_RECORD) + view);
    vm.mem.w8(es_addr(vm, vb + 0x1D), vm.dx);
    vm.cx = (vm.cx & 0xFF00) | ((vm.cx - 1) & 0xFF);
    vm.mem.w8(es_addr(vm, vb + 0x1E), vm.cx);
    if (vm.evaluate() === SKIP) return undefined;
    vm.mem.w8(es_addr(vm, vb + 0x1F), vm.dx);
    vm.mem.w8(es_addr(vm, vb), vm.mem.r8(es_addr(vm, vb)) | 0x80);
}
statement(0xC5)(perspective);

/** Code 0x1fbe (original bugs): object 0's record +0x1c = value and byte +0 = CL | 0x80,
 * instead of the view's +0x1c. */
export function scale_shift(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    if (vm.o16(-0x16) === 0) return undefined;
    const b = vm.g16(MAIN_RECORD);
    vm.mem.w8(es_addr(vm, b + 0x1C), vm.dx);
    vm.mem.w8(es_addr(vm, b), (vm.cx & 0xFF) | 0x80);
}
statement(0xC6)(scale_shift);

/** Code 0x4b2f: six words cs:[0x4b1f..0x4b29] that nothing reads, cs:[0x4b2b] = 0; view mode
 * bits 3/4 = first value != 0 (only the sign of the view handle is checked). */
export function window_mode(vm) {
    const v = evaluate_all(vm, 6);
    if (v == null) return undefined;
    v.forEach((d, k) => vm.sg16(0x4B1F + 2 * k, d));
    vm.sg16(0x4B2B, 0);
    const view = vm.o16(-0x16);
    if (view & 0x8000) return undefined;
    const a = es_addr(vm, view + vm.g16(MAIN_RECORD) + 1);
    vm.mem.w8(a, vm.mem.r8(a) & 0xE7);
    if (vm.g16(0x4B1F)) vm.mem.w8(a, vm.mem.r8(a) | 0x18);
}
statement(0xD1)(window_mode);

export function unused_words(vm) {
    const v = evaluate_all(vm, 8);
    if (v == null) return undefined;
    v.forEach((d, k) => vm.sg16(0x4B1F + 2 * k, d));
}
statement(0xD2)(unused_words);

/** Code 0x1fdc: four values that nothing reads, cs:[0x67d] (byte), [0x67f], [0x681], [0x683];
 * view +0 bit 5 when the first is non-zero (no view check). */
export function view_flag_5(vm) {
    const v = evaluate_all(vm, 4);
    if (v == null) return undefined;
    vm.sg8(0x67D, v[0]);
    for (let k = 1; k < 4; k++) vm.sg16(0x67D + 2 * k, v[k]);
    if (vm.g8(0x67D)) {
        const a = es_addr(vm, view_offset(vm));
        vm.mem.w8(a, vm.mem.r8(a) | 0x20);
    }
}
statement(0xE0)(view_flag_5);


// --------------------------------------------------------------------- background layer (0xdf)
export const LAYER_ON = 0x64B, LAYER_MARKER = 0x64F, LAYER_DEPTH = 0x659;

/** Code 0x756a: take size bytes (+ a paragraph header) from the top of free memory
 * (cs:[0x40b] = first paragraph in use, cs:[0x441] = lowest allowed); [segment, offset] of
 * the block, segment 0 when it does not fit. */
export function allocate_top(vm, size) {
    const paras = u16((u16(size + 0x10) >> 4) + 1);
    const seg = u16(vm.g16(0x40B) - paras);
    if (seg < vm.g16(0x441)) return [0, 0];
    vm.sg16(0x40B, seg);
    vm.mem.w16(seg * 16, paras);
    return [u16(seg + 1), 0];
}

/** Code 0x75a6: give back the block at seg if it is the lowest one in use. */
export function free_top(vm, seg) {
    seg = u16(seg - 1);
    if (seg === vm.g16(0x40B)) vm.sg16(0x40B, seg + vm.mem.r16(seg * 16));
}

/** Code 0x32a6: insert node n into the view list after `first`, before the first node
 * (in state >= 0) that is nearer: depth +0x10, then priority +0x20, then slot +1 (signed);
 * on a full tie a node in state 0xff goes first. n gets state 0. With cs:[0x64c] set, nodes
 * behind the layer split cs:[0x659] are inserted from the layer marker on and others set
 * cs:[0x64e]. */
export function insert_by_depth(vm, n, first) {
    const depth = s16(n16(vm, n, 0x10)), prio = sx8(n8(vm, n, 0x20)), slot = sx8(n8(vm, n, 1));
    // (depth, prio, slot) against a node's key, compared in that order: -1, 0 or 1
    const order = (key) => {
        const own = [depth, prio, slot];
        for (let k = 0; k < 3; k++) {
            if (own[k] !== key[k]) return own[k] < key[k] ? -1 : 1;
        }
        return 0;
    };
    let p = first;
    if (vm.g8(0x64C) && n !== vm.g16(LAYER_MARKER)) {
        if (depth < s16(vm.g16(LAYER_DEPTH))) p = vm.g16(LAYER_MARKER);
        else vm.sg8(0x64E, 1);
    }
    let prev;
    for (;;) {
        [prev, p] = [p, n16(vm, p, 6)];
        if (p === 0) break;
        if (n8(vm, p, 0) & 0x80) continue;
        const c = order([s16(n16(vm, p, 0x10)), sx8(n8(vm, p, 0x20)), sx8(n8(vm, p, 1))]);
        if (c < 0) continue;
        if (c > 0) break;
        if (n8(vm, n, 0) === 0xFF) break;
    }
    set_n16(vm, n, 6, p);
    set_n16(vm, prev, 6, n);
    set_n8(vm, n, 0, 0);
}

/** Code 0x2014: background layer cache. Switching on forces the rectangle to the whole
 * screen (0, 0, 319, 199, 80 bytes per row), takes a buffer (CGA: 80*200+16 bytes from the
 * top of memory, else requires cs:[0x41f]) and inserts the marker node cs:[0x64f] into the
 * view's list by depth; the nodes before it are marked changed. Switching off frees the
 * buffer and unlinks the marker. No view check. */
export function background_layer(vm) {
    const old = vm.g8(LAYER_ON);
    for (let k = 0; k < 6; k++) {                          // on, depth, x0, y0, x1, y1
        if (vm.evaluate() === SKIP) return undefined;
        if (k === 0) vm.sg8(LAYER_ON, vm.dx);
        else vm.sg16(LAYER_DEPTH + 2 * (k - 1), vm.dx);
    }
    vm.dx = old;
    const marker = vm.g16(LAYER_MARKER);
    const wb = view_offset(vm);
    const mode = es_addr(vm, wb + 1);
    const on = vm.g8(LAYER_ON);
    if (old === on) return undefined;
    if (on === 0) {
        if (vm.g8(0x422) === 0) free_top(vm, vm.g16(0x657));
        vm.sg8(0x64E, 0);
        vm.sg8(0x64D, 0);
        vm.mem.w8(mode, vm.mem.r8(mode) & 0xFB);
        let p = vm.mem.r16(es_addr(vm, wb + 2));
        while (p) {
            if (n16(vm, p, 6) === marker) {
                set_n16(vm, p, 6, n16(vm, marker, 6));
                break;
            }
            p = n16(vm, p, 6);
        }
        return undefined;
    }
    const settings = [[0x663, (u16(vm.mem.r16(es_addr(vm, wb + 0x12)) + 1) >> 4) * 4],
                      [0x65B, 0], [0x65D, 0], [0x65F, 0x13F], [0x661, 0xC7], [0x663, 0x50]];
    for (const [addr, value] of settings) vm.sg16(addr, value);
    if (vm.g8(0x422) === 0) {
        const size = u16(vm.g16(0x663) * u16(vm.g16(0x661) - vm.g16(0x65D) + 1) + 0x10);
        const [seg, off] = allocate_top(vm, size);
        if (seg === 0) {
            vm.sg8(LAYER_ON, 0);
            return undefined;
        }
        vm.sg16(0x657, seg);
        vm.sg16(0x655, off);
    } else if (vm.g8(0x41F) === 0) {
        vm.sg8(LAYER_ON, 0);
        return undefined;
    }
    set_n16(vm, marker, 2, vm.o16(-0x16));
    set_n16(vm, marker, 0xC, vm.g16(0x65B));
    set_n16(vm, marker, 0xE, vm.g16(0x65D));
    set_n16(vm, marker, 0x10, vm.g16(LAYER_DEPTH));
    set_n8(vm, marker, 0x20, 0x80);
    set_n8(vm, marker, 1, 0x80);
    set_n16(vm, marker, 0x1E, 0xFFFF);
    set_n16(vm, marker, 0x21, 0xFFFF);
    set_n8(vm, marker, 0, 0);
    vm.mem.w8(mode, vm.mem.r8(mode) | 4);
    vm.sg8(0x64C, 0);
    const window = vm.mem.r16(es_addr(vm, wb + 2));
    insert_by_depth(vm, marker, window);
    let p = n16(vm, window, 6);
    while (p !== marker) {
        set_n8(vm, p, 0, 2);
        p = n16(vm, p, 6);
        if (p === 0) break;
    }
}
statement(0xDF)(background_layer);


// --------------------------------------------------------------------- show graphics
/** 0x48 / 0x49 family: cs:[0x492] = source, mirror = es:[bp-3] (inverted for 0xa6, 0xa7,
 * 0xab), offset (0 or three operands), graphic, slot (0 or an operand), then 0x2360. */
export function _draw(source, invert, with_offset) {
    return function h(vm) {
        vm.sg8(SOURCE, source);
        vm.sg8(MIRROR, vm.o8(-3) ^ (invert ? 1 : 0));
        if (with_offset) {
            for (let k = 0; k < 3; k++) {
                if (vm.evaluate() === SKIP) return undefined;
                vm.sg16(OFFSET + 2 * k, vm.dx);
            }
            if (vm.evaluate() === SKIP || vm.evaluate_keep() === SKIP) return undefined;
            vm.sg16(SLOT, vm.cx);
        } else {
            if (vm.evaluate() === SKIP) return undefined;
            for (let k = 0; k < 3; k++) vm.sg16(OFFSET + 2 * k, 0);
            vm.sg16(SLOT, 0);
        }
        show_graphic(vm);
    };
}

statement(0x48)(_draw(0, false, false));
statement(0x49)(_draw(0, false, true));
statement(0xA6)(_draw(0, true, false));
statement(0xA7)(_draw(0, true, true));
statement(0xA8)(_draw(1, false, false));
statement(0xA9)(_draw(1, false, true));
statement(0xAA)(_draw(1, false, false));                   // original bug: XORs BX, not AL
statement(0xAB)(_draw(1, true, true));


// --------------------------------------------------------------------- remove nodes
/** Code 0x29f9: remove the object's nodes in its current view; cs:[0x470] = 0. */
export function _remove_view_nodes(vm) {
    let [found, prev, n, cx] = find_view(vm);
    if (cx != null) vm.cx = cx;
    if (found) {
        for (;;) {
            n = remove_node(vm, prev, n);
            if (n === 0 || n16(vm, n, 2) !== vm.o16(-0x16)) break;
        }
    }
    vm.sg8(IMMEDIATE, 0);
}

/** Code 0x29cf: remove the object's nodes with the slot (expression) in its current view;
 * cs:[0x470] = 0. */
export function _remove_slot_nodes(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    vm.sg8(SLOT, vm.dx);
    for (;;) {
        const [found, prev, n, cx] = find_slot(vm);
        if (cx != null) vm.cx = cx;
        if (!found) break;
        remove_node(vm, prev, n);
    }
    vm.sg8(IMMEDIATE, 0);
}

/** Code 0x2a26: remove all the object's nodes; cs:[0x470] = 0. */
export function remove_all_nodes(vm) {
    let n = vm.o16(-0x18);
    while (n) n = remove_node(vm, 0, n);
    vm.sg8(IMMEDIATE, 0);
}

export function _immediately(body) {
    return function h(vm) {
        vm.sg8(IMMEDIATE, 1);
        return body(vm);
    };
}

statement(0x4A)(_remove_view_nodes);
statement(0x4B)(_remove_slot_nodes);
statement(0x50)(remove_all_nodes);
statement(0xDB)(_immediately(_remove_view_nodes));
statement(0xDC)(_immediately(remove_all_nodes));
statement(0xDD)(_immediately(_remove_slot_nodes));


// --------------------------------------------------------------------- per-object node attributes
export function depth_shift(vm) {
    const v = evaluate_all(vm, 1);
    if (v == null) return undefined;
    vm.so8(-0x26, vm.dx);
    if (vm.evaluate() === SKIP) return undefined;
    vm.so8(-0x27, vm.dx);
}
statement(0xC7)(depth_shift);

export function priority(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    vm.so8(-0x2B, vm.dx);
}
statement(0xCF)(priority);

export function snapping(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    const g = vm.dx;
    let s = 0;
    for (const [shift, bit] of [[4, 0x10], [3, 8], [2, 4], [1, 2]]) {
        if (g & bit) {
            s = shift;
            break;
        }
    }
    vm.so8(-0x2C, s);
    if (vm.evaluate() === SKIP) return undefined;
    vm.so8(-0x2D, vm.dx);
}
statement(0xD0)(snapping);


// --------------------------------------------------------------------- text output modes 1 and 2
/** Graphic number of character c in the font (cs:[0x41d] first character, cs:[0x41b]
 * count, cs:[0x415] first graphic), or null for a character outside it. */
export function _glyph(vm, c) {
    const d = u16(c - vm.g16(0x41D));
    if (d & 0x8000 || d >= vm.g16(0x41B)) return null;
    return u16(d + vm.g16(0x415));
}

/** Code 0x1a7d: one character in output mode cs:[0x421]: 0 DOS console (0x784f), 1 cursor
 * cs:[0x40d]/[0x40f] only (0x1a9a), 2 glyph sprites at the offset cs:[0x47f..] (0x1afc). */
export function output_char(vm, c) {
    const mode = vm.g8(0x421);
    if (mode === 0) {
        vm.stdout = (vm.stdout ?? '') + String.fromCharCode(c);
    } else if (mode === 1) {
        if (c === 0x0A || c === 0x0D) {
            if (c === 0x0D) vm.sg16(0x40D, vm.g16(0x417) >> 1);
            vm.sg16(0x40F, vm.g16(0x40F) + vm.g8(0x419));
            return;
        }
        if (c !== 0x20) {
            if (vm.g16(0x415) & 0x8000) return;
            if (_glyph(vm, c) != null) {
                vm.sg8(SOURCE, 1);
                vm.sg8(MIRROR, 0);
            }
        }
        vm.sg16(0x40D, vm.g16(0x40D) + vm.g8(0x417));
    } else if (mode === 2) {
        if (c === 0x0A) {
            vm.sg16(OFFSET + 4, vm.g16(OFFSET + 4) - vm.g8(0x419));
            return;
        }
        if (c === 0x0D) {
            vm.sg16(OFFSET, 0);
            return;
        }
        if (c !== 0x20) {
            if (vm.g16(0x415) & 0x8000) return;
            const g = _glyph(vm, c);
            if (g != null) {
                vm.sg8(SOURCE, 1);
                vm.sg8(MIRROR, 0);
                vm.sg8(ADD_GLYPH, 1);
                const saved = vm.dx;
                vm.dx = g;
                show_graphic(vm);
                vm.dx = saved;
            }
        }
        vm.sg16(OFFSET, vm.g16(OFFSET) + vm.g8(0x417));
    }
}

/** Code 0x1be0: output the zero-terminated string at cs:[at]. */
export function _output_string(vm, at) {
    for (;;) {
        const c = vm.g8(at);
        at = u16(at + 1);
        if (c === 0) return;
        output_char(vm, c);
    }
}

export function _print_number(mode) {
    return function h(vm) {
        vm.sg8(0x421, mode);
        if (vm.evaluate() === SKIP) return undefined;
        const buf = vm.g16(0x4D3);
        F.format_number(vm, vm.dx, buf);                   // 0x1b66 -> 0x1b80
        _output_string(vm, buf);
    };
}

export function _print_string(mode) {
    return function h(vm) {
        vm.sg8(0x421, mode);
        vm.bx = VALUE_STACK;                               // entry 0x5749
        F.swap_buffers(vm, 0x4D3, 0x4D5);
        if (vm.eval_item() === SKIP) return undefined;
        _output_string(vm, vm.g16(0x4D3));
    };
}

statement(0xB6)(_print_number(1));
statement(0xB7)(_print_string(1));
statement(0xB8)(_print_number(2));
statement(0xB9)(_print_string(2));

export function font(vm) {
    const v = evaluate_all(vm, 5);
    if (v == null) return undefined;
    vm.sg16(0x41D, v[0]);
    vm.sg16(0x415, v[1]);
    vm.sg8(0x417, v[2]);
    vm.sg8(0x419, v[3]);
    vm.sg16(0x41B, v[4]);
}
statement(0xBA)(font);

export function text_position(vm) {
    const v = evaluate_all(vm, 4);
    if (v == null) return undefined;
    for (let k = 0; k < 3; k++) vm.sg16(OFFSET + 2 * k, v[k]);
    vm.sg8(SLOT, v[3]);
}
statement(0xBF)(text_position);


// --------------------------------------------------------------------- pen
/** Code 0x5238: pen position = (x, y), then a pixel in the pen colour cs:[0x411] (XOR when
 * cs:[0x412] == 3) through int 10h AH=0Ch; the pixel itself is not modelled. */
export function plot(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    vm.sg16(0x40D, vm.dx);
    if (vm.evaluate() === SKIP) return undefined;
    vm.sg16(0x40F, vm.dx);
    vm.cx = vm.g16(0x40D);
}
statement(0x79)(plot);


export const CGA_PATTERN = 0xC160;                         // colour -> a byte of four such pixels
export const CGA_STRIDE = 0x50, CGA_BANK = 0x2000;         // bytes per line; odd lines at +0x2000

/** Advance an interleaved CGA offset to the next line (step = bytes to the next row). */
export function _cga_next_line(di, step) {
    di = u16(di + step) ^ CGA_BANK;
    return di & CGA_BANK ? u16(di - CGA_STRIDE) : di;
}

/** Code 0xc199 for a fill record (type 1, item +0x22 = 0), as 0x7c's scratch item uses it:
 * clip the item's rectangle (item +0xc/+0xe, record +2/+4 = width-1/height-1) to
 * cs:[0x4bd..0x4c3] and fill it with the colour's pattern cs:[0xc160 + colour] into the back
 * buffer at segment cs:[0x667] (0xc2fc, then 0xce96), leaving the renderer's working values
 * in cs:[0x3a3], [0x4a9..0x4ba], [0x8e1..0x8f9] and [0xc164]. */
export function cga_draw_fill(vm, item) {
    const g16 = (o) => vm.g16(o), sg16 = (o, v) => vm.sg16(o, v);
    const g8 = (o) => vm.g8(o), sg8 = (o, v) => vm.sg8(o, v);
    const off = n16(vm, item, 8);
    let seg = n16(vm, item, 0xA);
    let high = vm.mem.r16(seg * 16 + u16(off + 2));
    const total = off + vm.mem.r16(seg * 16 + off);
    if (total > 0xFFFF) high = u16(high + 1);
    high = u16((((high & 0xFF) << 8) | (high >> 8)) << 4);
    let si = u16(total);
    seg = u16(seg + high + (si >> 4));
    si &= 0xF;

    const rec16 = (k) => vm.mem.r16(seg * 16 + u16(si + k));

    sg16(0x8F5, si);
    sg8(0x4B3, n8(vm, item, 0x22));
    const kind = vm.mem.r8(seg * 16 + si);
    sg8(0x4B5, kind);
    sg8(0x4B6, g8(CGA_PATTERN + (vm.mem.r8(seg * 16 + si + 1) & 3)));
    const w = rec16(2), h = rec16(4);
    sg16(0x8F9, s16(u16(w + 1)) >> 1);
    const x0 = n16(vm, item, 0xC), y0 = n16(vm, item, 0xE);
    const x1 = u16(x0 + w), y1 = u16(y0 + h);
    if (s16(x0) > s16(g16(0x4C1)) || s16(y0) > s16(g16(0x4C3)) || s16(x1) < s16(g16(0x4BD))
            || s16(y1) < s16(g16(0x4BF))) {
        return;
    }
    sg16(0x4A9, s16(x0) >= s16(g16(0x4BD)) ? x0 : g16(0x4BD));
    sg16(0x4AB, s16(y0) >= s16(g16(0x4BF)) ? y0 : g16(0x4BF));
    sg16(0x4AD, s16(x1) <= s16(g16(0x4C1)) ? x1 : g16(0x4C1));
    sg16(0x4AF, s16(y1) <= s16(g16(0x4C3)) ? y1 : g16(0x4C3));
    sg16(0x8E1, g16(0x49D) - g16(0x499) + 1);
    let di = u16(CGA_STRIDE * (g16(0x4AB) >> 1) + (g16(0x4A9) >> 2));
    if (g16(0x4AB) & 1) di ^= CGA_BANK;
    sg16(0x8F1, di);
    const cx = u16((g16(0x4AD) | 3) - (g16(0x4A9) & 0xFFFC) + 1) >> 2;
    sg16(0x8E9, cx);
    sg16(0x8E5, CGA_STRIDE - cx);
    if (kind !== 1 || g8(0x4B3) !== 0) {
        throw new NotImplementedError('CGA renderer: only the fill record of statement 0x7c is modelled');
    }
    sg16(0x8E3, u16((u16((u16(w + 1) >> 2) - cx) << 1) - 2));
    sg8(0x4B1, 0);
    sg8(0x4B2, 0);
    sg16(0x8ED, x0 & 3);
    if (x0 & 3) {
        if (s16(x0) > s16(g16(0x4BD))) {
            sg8(0x4B1, 1);
            sg16(0x8E3, g16(0x8E3) + 2);
        }
        if (s16(x1) < s16(g16(0x4C1))) {
            sg8(0x4B2, 1);
            sg16(0x8E9, g16(0x8E9) - 1);
            sg16(0x8E3, g16(0x8E3) + 2);
        }
    }
    sg16(0x3A3, g16(0x4AF) - g16(0x4AB) + 1);
    _cga_fill_rows(vm, g16(0x8F1), g16(0x667));
}

/** Code 0xce96: edge masks and row geometry, then the row loop at 0xd01d. */
export function _cga_fill_rows(vm, di, buffer) {
    const g16 = (o) => vm.g16(o), sg16 = (o, v) => vm.sg16(o, v);
    const g8 = (o) => vm.g8(o), sg8 = (o, v) => vm.sg8(o, v);
    sg8(0x4B1, 0);
    sg8(0x4B2, 0);
    if (s16(g16(0x4A9)) > s16(g16(0x497)) && g16(0x4A9) & 3) sg8(0x4B1, 1);
    if (s16(g16(0x4AD)) < s16(g16(0x49B)) && (g16(0x4AD) & 3) !== 3) sg8(0x4B2, 1);
    const pattern = g8(0x4B6);
    sg8(0x4B7, (0xFF00 >> (2 * (g16(0x4A9) & 3))) & 0xFF);
    sg8(0x4B9, ~g8(0x4B7) & pattern);
    sg8(0x4B8, (0xFF >> (2 * ((g16(0x4AD) & 3) + 1))) & 0xFF);
    sg8(0x4BA, ~g8(0x4B8) & pattern);
    sg16(0x8E5, CGA_STRIDE);
    sg16(0x8EB, g16(0x4AD) - g16(0x4A9) + 1);
    sg16(0x8E9, g16(0x8EB) >> 2);
    let left = g8(0x4B1), right = g8(0x4B2);
    if (s16(g16(0x8E9)) <= 0) {
        if (!left && !right) return;
        if (left && right) {
            if ((g16(0x4AD) >> 2) - (g16(0x4A9) >> 2) !== 0) {
                sg16(0x8E5, g16(0x8E5) - 2);
            } else {
                sg16(0x8E5, g16(0x8E5) - 1);
                const keep = ~g8(0x4B7) & ~g8(0x4B8) & 0xFF;
                sg8(0x4BA, pattern & keep);
                sg8(0x4B8, ~keep);
                sg8(0x4B1, 0);
            }
        } else {
            sg16(0x8E5, g16(0x8E5) - 1);
        }
    } else {
        sg16(0x8E5, g16(0x8E5) - g16(0x8E9));
        if (left && right) {
            sg8(0xC164, (4 - (g16(0x4A9) & 3)) & 3);
            if (sx8(((g16(0x4AD) & 3) + 1) % 4 + g8(0xC164)) > 3) {
                sg16(0x8E9, g16(0x8E9) - 1);
                sg16(0x8E5, g16(0x8E5) + 1);
            }
            sg16(0x8E5, g16(0x8E5) - 2);
        } else if (left || right) {
            sg16(0x8E5, g16(0x8E5) - 1);
        }
    }
    left = g8(0x4B1);
    right = g8(0x4B2);
    let rows = g16(0x3A3);
    const base = buffer * 16;

    const put = (at, v) => vm.mem.w8(base + at, v);

    for (;;) {
        if (left) {
            put(di, (g8(0x4B7) & vm.mem.r8(base + di)) | g8(0x4B9));
            di = u16(di + 1);
        }
        for (let k = 0, count = g16(0x8E9); k < count; k++) {
            put(di, pattern);
            di = u16(di + 1);
        }
        if (right) {
            put(di, (g8(0x4B8) & vm.mem.r8(base + di)) | g8(0x4BA));
            di = u16(di + 1);
        }
        rows = u16(rows - 1);
        if (rows === 0) return;
        di = _cga_next_line(di, g16(0x8E5));
    }
}

/** Code 0xd074: copy the redraw rectangle cs:[0x497]/[0x499]..[0x49d] (cs:[0x49f] words per
 * line) from the back buffer at segment cs:[0x3ff] to the CGA screen at B800. */
export function cga_copy_to_screen(vm) {
    const g16 = (o) => vm.g16(o);
    let si = u16(CGA_STRIDE * u16(s16(g16(0x499)) >> 1) + (g16(0x497) >> 2));
    if (g16(0x499) & 1) si ^= CGA_BANK;
    let di = si;
    const src = g16(0x3FF) * 16, dst = 0xB800 * 16;
    let lines = u16(g16(0x49D) - g16(0x499) + 1);
    const words = g16(0x49F);
    const step = u16(CGA_STRIDE - 2 * words);
    for (;;) {
        for (let k = 0; k < words; k++) {
            vm.mem.w16(dst + di, vm.mem.r16(src + si));
            si = u16(si + 2);
            di = u16(di + 2);
        }
        lines = u16(lines - 1);
        if (lines === 0) return;
        si = u16(si + step) ^ CGA_BANK;
        di = u16(di + step) ^ CGA_BANK;
        if (si & CGA_BANK) {
            si = u16(si - CGA_STRIDE);
            di = u16(di - CGA_STRIDE);
        }
    }
}

/** Code 0x5278: filled box from the pen to pen + (dx, dy): the scratch display item at
 * cs:[0x45f] + cs:[0x467] gets the directory entry cs:0x526e of the fill record (cs:0x5272)
 * and the corner, the fill record its colour and size, the redraw rectangle
 * cs:[0x497..0x49f] / [0x4bd..0x4c3] is set and the pen moves to the far corner; then the
 * box is drawn at once. The CGA drawing (0xc199 + 0xd074) is reproduced; the EGA/VGA drawing
 * (0x9886 + 0x9772, video planes through the graphics controller) is not modelled. */
export function box(vm) {
    if (vm.evaluate() === SKIP || vm.evaluate_keep() === SKIP) return undefined;
    const item = u16(vm.g16(POOL) + vm.g16(0x467));
    set_n16(vm, item, 0xA, CS >> 4);
    set_n16(vm, item, 8, 0x526E);
    set_n16(vm, item, 0xC, vm.g16(0x40D));
    set_n16(vm, item, 0xE, vm.g16(0x40F));
    set_n16(vm, item, 0x10, 0);
    set_n8(vm, item, 0x22, 0);
    let colour = vm.g8(0x411);
    if (vm.g8(0x422) === 0) colour &= 3;
    vm.sg8(0x5273, colour);
    let dx = vm.dx, cx = vm.cx;
    vm.sg16(0x40D, vm.g16(0x40D) + dx);
    vm.sg16(0x40F, vm.g16(0x40F) + cx);
    if (dx & 0x8000) {
        set_n16(vm, item, 0xC, n16(vm, item, 0xC) + dx);
        dx = u16(-dx);
    }
    if (cx & 0x8000) {
        set_n16(vm, item, 0xE, n16(vm, item, 0xE) + cx);
        cx = u16(-cx);
    }
    vm.sg16(0x5274, dx);
    vm.sg16(0x5276, cx);
    let x0 = n16(vm, item, 0xC);
    const y0 = n16(vm, item, 0xE);
    const x1 = u16(dx + x0) | 0xF, y1 = u16(cx + y0);
    x0 &= 0xFFF0;
    for (const base of [0x497, 0x4BD]) {
        [x0, y0, x1, y1].forEach((v, k) => vm.sg16(base + 2 * k, v));
    }
    vm.sg16(0x49F, s16(u16(x1 - x0 + 1)) >> 1);
    if (vm.g8(0x422) === 0) {
        cga_draw_fill(vm, item);
        cga_copy_to_screen(vm);
    }
    [vm.dx, vm.cx] = [dx, cx];
}
statement(0x7C)(box);

statement(0x7D)((vm) => { if (vm.evaluate() !== SKIP) vm.sg8(0x411, vm.dx); });
statement(0x80)((vm) => { if (vm.evaluate() !== SKIP) vm.sg8(0x412, vm.dx); });

export function pen_to(vm) {
    for (const a of [0x40D, 0x40F]) {
        if (vm.evaluate() === SKIP) return undefined;
        vm.sg16(a, vm.dx);
    }
}
statement(0x7E)(pen_to);

export function pen_by(vm) {
    for (const a of [0x40D, 0x40F]) {
        if (vm.evaluate() === SKIP) return undefined;
        vm.sg16(a, vm.g16(a) + vm.dx);
    }
}
statement(0x7F)(pen_by);

/** Code 0x53ec: the pointer display item (cs:[0x45f] + cs:[0x469]) gets the directory entry
 * of graphic DX of the own class; cs:[0x3a9..0x3af] keep the record and entry pointers. */
export function pointer_image(vm) {
    vm.sg8(SOURCE, 0);
    if (vm.evaluate() === SKIP) return undefined;
    const [seg, entry] = graphic_entry(vm, vm.dx);
    vm.sg16(0x3AD, entry);
    vm.sg16(0x3AF, seg);
    const [rseg, roff] = graphic_record(vm, vm.dx);
    vm.sg16(0x3A9, roff);
    vm.sg16(0x3AB, rseg);
    const item = u16(vm.g16(POOL) + vm.g16(0x469));
    set_n16(vm, item, 8, vm.g16(0x3AD));
    set_n16(vm, item, 0xA, vm.g16(0x3AF));
}
statement(0x87)(pointer_image);


// --------------------------------------------------------------------- palettes
/** 0x68 / 0xbe tail: with cs:[0x422] set, load graphic DX's record when it is a palette
 * record (type 0xfe), through 0x4a28; cs:[0x471] = 0 in any case. */
export function _palette_from_record(vm) {
    if (vm.g8(0x422)) {
        const [seg, off, cx] = graphic_record(vm, vm.dx);
        vm.cx = cx;
        if (vm.mem.r8(seg * 16 + off) === 0xFE) load_palette_record(vm, seg * 16 + off);
    }
    vm.sg8(0x471, 0);
}

/** Code 0x49eb: palette record of the own class; a negative value on CGA selects a CGA
 * palette through the BIOS (0xc166: -1 / -2 = int 10h AH=0Bh BH=1 BL=0 / 1), not modelled. */
export function palette(vm) {
    vm.sg8(SOURCE, 0);
    if (vm.evaluate() === SKIP) return undefined;
    if (vm.dx & 0x8000) {
        vm.sg8(0x471, 0);
        return undefined;
    }
    _palette_from_record(vm);
}
statement(0x68)(palette);

export function palette_record(vm) {
    vm.sg8(SOURCE, 0);
    if (vm.evaluate() === SKIP || vm.evaluate_keep() === SKIP) return undefined;
    _palette_from_record(vm);
}
statement(0xBE)(palette_record);

/** Code 0x4a88: on VGA (cs:[0x423] == 1) palette word index = colour 0x0RGB stored
 * big-endian, then programmed; no range check. */
export function palette_entry(vm) {
    if (vm.evaluate() === SKIP || vm.evaluate_keep() === SKIP) return undefined;
    if (vm.g8(0x423) === 1) {
        vm.dx = u16(vm.dx * 2);
        vm.cx = ((vm.cx & 0xFF) << 8) | (vm.cx >> 8);
        vm.sg16(u16(PALETTE + vm.dx), vm.cx);
        program_palette(vm);
    }
}
statement(0x69)(palette_entry);

/** Code 0x4adb: unless locked, restore the palette from cs:0x5e9 (VGA only). */
export function base_palette(vm) {
    if (vm.evaluate_keep() === SKIP) return undefined;
    if (vm.g8(0x423) && vm.g8(0x471) === 0) {
        for (let k = 0; k < 32; k++) vm.sg8(PALETTE + k, vm.g8(BASE_PALETTE + k));
        program_palette(vm);
    }
    vm.sg8(0x471, 0);
}
statement(0xBC)(base_palette);

export function palette_lock(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    vm.sg8(0x471, vm.dx);
    vm.sg8(0x472, 1);
}
statement(0xD7)(palette_lock);


register_module('ops_view', ops_view);
