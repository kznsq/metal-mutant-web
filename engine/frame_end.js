/**
 * The engine's frame end (code 0x2d12): what happens after every object has had its turn.
 *
 * The scheduler calls 0x2d12 at 0x15a7 when the object list is exhausted. The routine
 *   1. waits until the timer interrupt has counted cs:[0x512] ticks in cs:[0x513], then clears it;
 *   2. points the drawing target at the work page (cs:[0x665..0x671] = cs:[0x3fd], [0x3ff],
 *      [0x673..0x67b]);
 *   3. walks the view list (cs:[0x493], link V+4; view records inside MAIN's record at cs:[0x473])
 *      and brings each view's display nodes up to date (0x2e1f): pending camera moves are applied,
 *      new / changed / removed nodes are projected, re-sorted by depth and the screen rectangles
 *      they cover (old and new) are redrawn from the node lists and copied to the displayed page;
 *   4. handles the pointer node cs:[0x469] when cs:[0x46b] is set (nothing in the game sets it).
 *
 * `frame_end(vm)` reproduces all memory writes of the original. The drawing routines are in
 * render.js. On the EGA/VGA path their pixels go to an EGAVideo (the 64 KB of EGA memory), kept in
 * `vm.video` from frame to frame (`video = false`: the engine globals are still written, no pixels
 * are produced). On the CGA path the pages are ordinary memory and always written; `vm.video` is a
 * CGAVideo marker.
 *
 * Register conventions follow the original: `head` is CX of the routines (the view's window
 * node, first node of the view's list), `prev` is BX (the node before the one being processed),
 * `si` is the SI register (the scheduler leaves cs:[0x449] in it; the redraw routine 0x33d2
 * compares nodes with it, see redraw()).
 */
import * as frame_end_module from './frame_end.js';
import * as render from './render.js';
import { CS, ZeroDivisionError, floordiv, register_module } from './vm.js';


export function u16(v) {
    return v & 0xFFFF;
}

export function s16(v) {
    v &= 0xFFFF;
    return v & 0x8000 ? v - 0x10000 : v;
}

export function s8(v) {
    v &= 0xFF;
    return v & 0x80 ? v - 0x100 : v;
}

/** SAR of a 16-bit word (the count is masked to 5 bits as on 80286 and later). */
export function sar16(v, n) {
    n &= 0x1F;
    return u16(s16(v) >> Math.min(n, 16));
}


/** Access to the structures the frame end works on: engine globals cs:[...], the display-node
 * pool (segment cs:[0x461]) and the view records (MAIN's record, segment ES). */
export class Frame {
    constructor(vm, video) {
        this.vm = vm;
        this.mem = vm.mem;
        this.video = video;
        this.pseg = vm.g16(0x461) * 16;
        this.vseg = vm.es * 16;
        this.si = vm.g16(0x449);
    }

    // globals
    g8(o) {
        return this.mem.r8(CS + o);
    }

    g16(o) {
        return this.mem.r16(CS + o);
    }

    sg8(o, v) {
        this.mem.w8(CS + o, v);
    }

    sg16(o, v) {
        this.mem.w16(CS + o, v);
    }

    // display nodes (offsets in the pool segment)
    n8(node, o) {
        return this.mem.r8(this.pseg + u16(node + o));
    }

    n16(node, o) {
        return this.mem.r16(this.pseg + u16(node + o));
    }

    sn8(node, o, v) {
        this.mem.w8(this.pseg + u16(node + o), v);
    }

    sn16(node, o, v) {
        this.mem.w16(this.pseg + u16(node + o), v);
    }

    // view records (offsets in MAIN's segment)
    v8(view, o) {
        return this.mem.r8(this.vseg + u16(view + o));
    }

    v16(view, o) {
        return this.mem.r16(this.vseg + u16(view + o));
    }

    sv8(view, o, v) {
        this.mem.w8(this.vseg + u16(view + o), v);
    }

    sv16(view, o, v) {
        this.mem.w16(this.vseg + u16(view + o), v);
    }

    view(handle) {
        return u16(this.g16(0x473) + handle);
    }

    /** The drawing loops skip a node whose state is negative (new, not yet projected), whose
     * mirror byte +0x22 is negative or whose depth +0x10 is negative (behind the camera). */
    hidden_or_new(node) {
        return this.n8(node, 0) & 0x80 || this.n8(node, 0x22) & 0x80 || this.n16(node, 0x10) & 0x8000;
    }
}


// --------------------------------------------------------------------------- entry point
/** 0x2d12. `video`: render.EGAVideo / render.CGAVideo; default vm.video, created for the
 * display path in use (cs:[0x422]) on the first call (false: no EGA pixels). */
export function frame_end(vm, video = null) {
    if (video == null) {
        video = vm.video ?? null;
        if (video == null) {
            video = render.video_for(vm);
            vm.video = video;
        }
    }
    const f = new Frame(vm, video || null);
    // 0x2d1b-0x2d3e: wait for cs:[0x512] timer ticks (counted in cs:[0x513] by the timer
    // interrupt at 0x70eb), then restart the count. Here the caller paces the frames.
    f.sg8(0x513, 0);
    target_screen(f);                                         // 0x2d4c-0x2d80
    let handle = f.g16(0x493);
    while (handle) {                                          // 0x2d84-0x2db1
        const view = f.view(handle);
        f.sg16(0x3B1, view);
        f.sg16(0x3B3, vm.es);
        const head = f.v16(view, 2);
        f.sg16(0x397, head);
        view_update(f, view, head);
        handle = f.v16(view, 4);
    }
    f.sg8(0x4C6, 0);
    if (f.g8(0x4B4) === 0 && f.g8(0x46B) !== 0) pointer_node(f);
}


/** Drawing target = the work page: cs:[0x665]/[0x667] = cs:[0x3fd]/[0x3ff] (offset and
 * segment, on EGA the page offset 0x2000 in [0x667]), cs:[0x669..0x671] = cs:[0x673..0x67b]
 * (rectangle 0,0,319,199 and row stride). */
export function target_screen(f) {
    f.sg16(0x665, f.g16(0x3FD));
    f.sg16(0x667, f.g16(0x3FF));
    for (let k = 0; k < 5; k++) f.sg16(0x669 + 2 * k, f.g16(0x673 + 2 * k));
}


/** Drawing target = the layer buffer (cs:[0x655]/[0x657], rectangle cs:[0x65b..0x661],
 * stride cs:[0x663]). */
export function target_layer(f) {
    f.sg16(0x665, f.g16(0x655));
    f.sg16(0x667, f.g16(0x657));
    for (let k = 0; k < 5; k++) f.sg16(0x669 + 2 * k, f.g16(0x65B + 2 * k));
}


// --------------------------------------------------------------------------- one view
/** 0x2c36: add the pending camera move V+0x2a/0x2c/0x2e to the camera V+0x16/0x18/0x1a, clear
 * it, mark every drawn node of the view (list from cs:[0x397]) as changed (0 -> 2) and clear the
 * view's flag bit 7. */
export function camera_move(f, view) {
    for (const k of [0x16, 0x18, 0x1A]) f.sv16(view, k, f.v16(view, k) + f.v16(view, k + 0x14));
    for (const k of [0x2A, 0x2C, 0x2E]) f.sv16(view, k, 0);
    let node = f.g16(0x397);
    for (;;) {
        node = f.n16(node, 6);
        if (node === 0) break;
        if (f.n8(node, 0) === 0) f.sn8(node, 0, 2);
    }
    f.sv8(view, 0, f.v8(view, 0) & 0x7F);
}


/** 0x2e1f: bring one view's nodes up to date. */
export function view_update(f, view, head) {
    f.sg8(0x4C5, 0);
    f.sg16(0x3A5, f.g16(0x45F));
    if (f.g8(0x4C6) || f.v8(view, 0) & 0x80) camera_move(f, view);
    f.sg8(0x64C, f.v8(view, 1) & 4 ? 1 : 0);
    if (f.v8(view, 1) & 0x10) {
        whole_window(f, view, head);
        return;
    }
    let node = head;
    for (;;) {                                                // 0x2e68
        const prev = node;
        node = f.n16(u16(node + f.g16(0x3A5)), 6);
        if (node === 0) return;
        f.sg8(0x495, 0);
        const state = f.n8(node, 0);
        if (state === 0) continue;
        f.sg8(0x3D5, 0);
        f.sg8(0x4C5, 1);
        f.sg8(0x64E, 0);
        if (state === 2) node = node_changed(f, node, prev, head);
        else if (state === 0xFF) node = node_new(f, node, prev, head);
        else node = node_removed(f, node, prev, head);
    }
}


/** 0x2eba (view mode bit 4): process every node of the view without changed rectangles,
 * then redraw the whole window V+0xe/0x10, size V+0x12/0x14, for all views and copy it. */
export function whole_window(f, view, head) {
    const x0 = f.v16(view, 0xE), y0 = f.v16(view, 0x10);
    f.sg16(0x4BD, x0);
    f.sg16(0x4BF, y0);
    f.sg16(0x497, x0);
    f.sg16(0x499, y0);
    const x1 = u16(x0 + f.v16(view, 0x12)), y1 = u16(y0 + f.v16(view, 0x14));
    f.sg16(0x4C1, x1);
    f.sg16(0x4C3, y1);
    f.sg16(0x49B, x1);
    f.sg16(0x49D, y1);
    f.sg16(0x49F, u16(x1 - f.g16(0x497) + 1) >> 3);
    if (!(f.v8(view, 1) & 0x40)) clear(f);
    let node = head;
    for (;;) {                                                // 0x2f08
        const prev = node;
        node = f.n16(node, 6);
        if (node === 0) break;
        const state = f.n8(node, 0);
        if (state === 0) continue;
        if (state === 1) {                                    // 0x2fd2: unlink and free
            f.sn16(prev, 6, f.n16(node, 6));
            f.sn16(node, 4, f.g16(0x463));
            f.sg16(0x463, node);
        } else {                                              // 0x2f97
            project(f, node);
            f.sn16(prev, 6, f.n16(node, 6));
            store_projection(f, node);
            insert(f, node, head);
        }
        node = prev;
    }
    let handle = f.g16(0x493);                                // 0x2f23
    while (handle) {
        const v = f.view(handle);
        const nxt = f.v16(v, 4);
        if (f.v8(v, 0) & 0x40) {
            handle = nxt;
            continue;
        }
        const h = f.v16(v, 2);
        if (h) {
            view_clip(f, h);
            if (f.g8(0x4BB)) {
                let n = h;
                for (;;) {
                    n = f.n16(n, 6);
                    if (n === 0) break;
                    if (!f.hidden_or_new(n)) draw(f, n);
                }
            }
        }
        handle = nxt;
    }
    copy_to_screen(f);                                        // 0x2f91
}


// --------------------------------------------------------------------------- node life cycle
/** 0x319e: cs:[0x3a1] = the node's group word +0x1e; changed rectangle cs:[0x4a9..0x4af]
 * emptied (0x7fff, 0x7fff, 0x8000, 0x8000). */
export function group_start(f, node) {
    f.sg16(0x3A1, f.n16(node, 0x1E));
    f.sg16(0x4A9, 0x7FFF);
    f.sg16(0x4AB, 0x7FFF);
    f.sg16(0x4AD, 0x8000);
    f.sg16(0x4AF, 0x8000);
}


/** cs:[0x64e] = 1 when the view has the layer cache (cs:[0x64c]) and the node's depth is at
 * least the split depth cs:[0x659] (0x3027, 0x3129, 0x3146). */
export function layer_check(f, node) {
    if (f.g8(0x64C) && s16(f.g16(0x659)) <= s16(f.n16(node, 0x10))) f.sg8(0x64E, 1);
}


export function unlink(f, node, prev) {
    f.sn16(prev, 6, f.n16(node, 6));
}


/** 0x2ff2: node+8/+0xa = graphic entry (far), +0xc/+0xe = screen x, y, +0x10 = depth,
 * +0x22 = mirror (cs:[0x4d9..0x4e3], results of 0x262c). */
export function store_projection(f, node) {
    f.sn16(node, 8, f.g16(0x4D9));
    f.sn16(node, 0xA, f.g16(0x4DB));
    f.sn16(node, 0xC, f.g16(0x4DD));
    f.sn16(node, 0xE, f.g16(0x4DF));
    f.sn16(node, 0x10, f.g16(0x4E1));
    f.sn8(node, 0x22, f.g8(0x4E3));
}


/** 0x30d8: project, unlink, store, add the new rectangle to the changed rectangle, re-insert
 * in depth order. Returns `prev` (the original continues from there). */
export function project_insert(f, node, prev, head) {
    project(f, node);
    unlink(f, node, prev);
    store_projection(f, node);
    rect_union(f, node);
    insert(f, node, head);
    return prev;
}


/** 0x3143: old rectangle into the changed rectangle, layer check, then 0x30d8. */
export function changed_in_group(f, node, prev, head) {
    rect_union(f, node);
    layer_check(f, node);
    return project_insert(f, node, prev, head);
}


/** 0x3114: old rectangle into the changed rectangle, unlink, return the node to the free
 * list cs:[0x463] (link +4; the state stays 1), layer check. */
export function removed_in_group(f, node, prev, head) {
    rect_union(f, node);
    unlink(f, node, prev);
    f.sn16(node, 4, f.g16(0x463));
    f.sg16(0x463, node);
    layer_check(f, node);
    return prev;
}


/** 0x3160: process the later nodes of the same group (+0x1e == cs:[0x3a1]) with a non-zero
 * state: new ones (negative) by 0x30d8, changed ones (2) by 0x3143, others by 0x3114. */
export function group_walk(f, node, head) {
    for (;;) {
        const prev = node;
        node = f.n16(node, 6);
        if (node === 0) return;
        if (f.g16(0x3A1) !== f.n16(node, 0x1E)) continue;
        const state = f.n8(node, 0);
        if (state === 0) continue;
        if (state & 0x80) node = project_insert(f, node, prev, head);
        else if (state === 2) node = changed_in_group(f, node, prev, head);
        else node = removed_in_group(f, node, prev, head);
    }
}


/** 0x30c7 / 0x318d: redraw the changed rectangle (cs:[0x495] = 1) and continue after prev. */
export function finish_group(f, node, prev, head) {
    f.sg8(0x495, 1);
    redraw(f, node, head);
    return prev;
}


/** 0x3082: a new node (state 0xff). */
export function node_new(f, node, prev, head) {
    group_start(f, node);
    const after = project_insert(f, node, prev, head);
    if (f.g16(0x3A1) & 0x8000) return finish_group(f, node, prev, head);
    group_walk(f, after, head);
    return finish_group(f, node, prev, head);
}


/** 0x30b3: a node waiting to be erased (state 1, or any other state not handled above). */
export function node_removed(f, node, prev, head) {
    group_start(f, node);
    const after = removed_in_group(f, node, prev, head);
    if (f.g16(0x3A1) & 0x8000) return finish_group(f, node, prev, head);
    group_walk(f, after, head);
    return finish_group(f, node, prev, head);
}


/** 0x3099: a changed node (state 2). In a group: 0x3143 and the group walk; alone (0x3027):
 * project, then redraw the union of old and new rectangles when they overlap, otherwise the
 * old and the new rectangle one after the other. */
export function node_changed(f, node, prev, head) {
    group_start(f, node);
    if (!(f.g16(0x3A1) & 0x8000)) {
        const after = changed_in_group(f, node, prev, head);
        group_walk(f, after, head);
        return finish_group(f, node, prev, head);
    }
    layer_check(f, node);                                     // 0x3027
    project(f, node);
    if (overlap(f, node)) {                                   // 0x2fec
        unlink(f, node, prev);
        store_projection(f, node);
        insert(f, node, head);
        redraw(f, node, head);
        return prev;
    }
    unlink(f, node, prev);                                    // 0x3048
    redraw(f, node, head);
    store_projection(f, node);
    insert(f, node, head);
    redraw(f, node, head);
    return prev;
}


/** 0x32a6: insert the node into the view's list in drawing order and set its state to 0.
 *
 * Order: depth +0x10 descending (far first), then priority +0x20, then slot +1 (signed bytes,
 * larger first); among equal keys a new node (state 0xff) goes before the existing one, any
 * other after it. Nodes with a negative state are passed over. With the layer cache active
 * (cs:[0x64c]) a node nearer than the split depth cs:[0x659] is searched for from the marker
 * node cs:[0x64f]; a farther one from the head, and it sets cs:[0x64e] (the cached layer must
 * be redrawn). */
export function insert(f, node, head) {
    const depth = s16(f.n16(node, 0x10));
    const prio = s8(f.n8(node, 0x20));
    const slot = s8(f.n8(node, 1));
    let pos = head;
    if (f.g8(0x64C) && node !== f.g16(0x64F)) {
        if (depth < s16(f.g16(0x659))) pos = f.g16(0x64F);
        else f.sg8(0x64E, 1);
    }
    let before;
    for (;;) {
        before = pos;
        pos = f.n16(pos, 6);
        if (pos === 0) break;
        if (f.n8(pos, 0) & 0x80) continue;
        const d = s16(f.n16(pos, 0x10));
        if (depth !== d) {
            if (depth > d) break;
            continue;
        }
        const p = s8(f.n8(pos, 0x20));
        if (prio !== p) {
            if (prio > p) break;
            continue;
        }
        const s = s8(f.n8(pos, 1));
        if (slot !== s) {
            if (slot > s) break;
            continue;
        }
        if (f.n8(node, 0) === 0xFF) break;
    }
    f.sn16(node, 6, pos);
    f.sn16(before, 6, node);
    f.sn8(node, 0, 0);
}


// --------------------------------------------------------------------------- rectangles
/** Graphic record of a directory entry at seg:off (32-bit self-relative pointer), normalised
 * as the engine does: [segment, offset 0..15]. */
export function record(f, seg, off) {
    return render.follow(f.mem, seg, off);
}


/** 0x31c5: add the node's stored rectangle (+0xc, +0xe, size from its record +2/+4) to the
 * changed rectangle cs:[0x4a9..0x4af]; nothing when its depth is negative. */
export function rect_union(f, node) {
    if (f.n16(node, 0x10) & 0x8000) return;
    const [rseg, roff] = record(f, f.n16(node, 0xA), f.n16(node, 8));
    const rec = rseg * 16 + roff;
    let x = f.n16(node, 0xC);
    if (s16(x) <= s16(f.g16(0x4A9))) f.sg16(0x4A9, x);
    x = u16(x + f.mem.r16(rec + 2));
    if (s16(x) >= s16(f.g16(0x4AD))) f.sg16(0x4AD, x);
    let y = f.n16(node, 0xE);
    if (s16(y) <= s16(f.g16(0x4AB))) f.sg16(0x4AB, y);
    y = u16(y + f.mem.r16(rec + 4));
    if (s16(y) >= s16(f.g16(0x4AF))) f.sg16(0x4AF, y);
}


/** 0x3722: do the node's old rectangle and the new projection (cs:[0x4d9..0x4e1]) overlap?
 * If so the union goes to cs:[0x4a9..0x4af] and cs:[0x495] = 1; otherwise cs:[0x495] = 0.
 * The two records are left in cs:[0x3c1]/[0x3c3] (old) and cs:[0x3bd]/[0x3bf] (new). */
export function overlap(f, node) {
    const [oseg, ooff] = record(f, f.n16(node, 0xA), f.n16(node, 8));
    f.sg16(0x3C1, ooff);
    f.sg16(0x3C3, oseg);
    const [nseg, noff] = record(f, f.g16(0x4DB), f.g16(0x4D9));
    f.sg16(0x3BD, noff);
    f.sg16(0x3BF, nseg);
    const old = oseg * 16 + ooff, nw = nseg * 16 + noff;
    const r16 = (a) => f.mem.r16(a);
    const nx = f.g16(0x4DD), ny = f.g16(0x4DF);
    let ok = !(f.n16(node, 0x10) & 0x8000);
    let ox, oy, nright, nbottom, oright, obottom;
    if (ok) {
        ox = f.n16(node, 0xC);
        oy = f.n16(node, 0xE);
        nright = u16(nx + r16(nw + 2));
        nbottom = u16(ny + r16(nw + 4));
        oright = u16(ox + r16(old + 2));
        obottom = u16(oy + r16(old + 4));
        ok = (s16(ox) <= s16(nright) && s16(oy) <= s16(nbottom)
              && s16(oright) >= s16(nx) && s16(obottom) >= s16(ny));
    }
    if (!ok) {
        f.sg8(0x495, 0);
        return false;
    }
    f.sg16(0x4A9, s16(ox) > s16(nx) ? nx : ox);
    f.sg16(0x4AB, s16(oy) > s16(ny) ? ny : oy);
    f.sg16(0x4AD, s16(oright) < s16(nright) ? nright : oright);
    f.sg16(0x4AF, s16(obottom) < s16(nbottom) ? nbottom : obottom);
    f.sg8(0x495, 1);
    return true;
}


/** 0x3872: the rectangle to redraw. cs:[0x495] = 0: the node's own rectangle (none if its
 * depth is negative), else the changed rectangle cs:[0x4a9..0x4af]. Rejected when outside the
 * window of `head` (+0xc, +0xe, +0x16, +0x18). Otherwise widened to 16-pixel columns and
 * clipped to the window: cs:[0x497..0x49d], byte width cs:[0x49f]; cs:[0x4a1]/[0x4a3] =
 * 0 / cs:[0x8fd]. */
export function redraw_rect(f, node, head) {
    if (f.g8(0x495) === 0) {
        if (f.n16(node, 0x10) & 0x8000) return false;
        const [rseg, roff] = record(f, f.n16(node, 0xA), f.n16(node, 8));
        const rec = rseg * 16 + roff;
        const x = f.n16(node, 0xC), y = f.n16(node, 0xE);
        f.sg16(0x4A9, x);
        f.sg16(0x4AB, y);
        f.sg16(0x4AD, u16(x + f.mem.r16(rec + 2)));
        f.sg16(0x4AF, u16(y + f.mem.r16(rec + 4)));
    }
    const left = s16(f.n16(head, 0xC)), top = s16(f.n16(head, 0xE));
    const right = s16(f.n16(head, 0x16)), bottom = s16(f.n16(head, 0x18));
    if (s16(f.g16(0x4A9)) > right || s16(f.g16(0x4AB)) > bottom
            || s16(f.g16(0x4AD)) < left || s16(f.g16(0x4AF)) < top) {
        return false;
    }
    let v = f.g16(0x4A9) & 0xFFF0;
    f.sg16(0x497, s16(v) >= left ? v : left);
    v = f.g16(0x4AB);
    f.sg16(0x499, s16(v) >= top ? v : top);
    v = f.g16(0x4AD) | 0xF;
    f.sg16(0x49B, s16(v) <= right ? v : right);
    v = f.g16(0x4AF);
    f.sg16(0x49D, s16(v) <= bottom ? v : bottom);
    f.sg16(0x49F, u16(f.g16(0x49B) - f.g16(0x497) + 1) >> 3);
    f.sg16(0x4A1, 0);
    f.sg16(0x4A3, f.g16(0x8FD));
    return true;
}


/** 0x3684: clip rectangle cs:[0x4bd..0x4c3] = redraw rectangle cs:[0x497..0x49d] intersected
 * with the window of `head`; cs:[0x4bb] = 1 if they intersect. The window corners are left in
 * cs:[0x391..0x397] as far as they are read. */
export function view_clip(f, head) {
    f.sg8(0x4BB, 0);
    const wl = f.n16(head, 0xC);
    f.sg16(0x391, wl);
    if (s16(wl) > s16(f.g16(0x49B))) return;
    const wt = f.n16(head, 0xE);
    f.sg16(0x393, wt);
    if (s16(wt) > s16(f.g16(0x49D))) return;
    const wr = f.n16(head, 0x16);
    f.sg16(0x395, wr);
    if (s16(wr) < s16(f.g16(0x497))) return;
    const wb = f.n16(head, 0x18);
    f.sg16(0x397, wb);
    if (s16(wb) < s16(f.g16(0x499))) return;
    const r = (o) => f.g16(o);
    f.sg16(0x4BD, s16(wl) >= s16(r(0x497)) ? wl : r(0x497));
    f.sg16(0x4BF, s16(wt) >= s16(r(0x499)) ? wt : r(0x499));
    f.sg16(0x4C1, s16(wr) <= s16(r(0x49B)) ? wr : r(0x49B));
    f.sg16(0x4C3, s16(wb) <= s16(r(0x49D)) ? wb : r(0x49D));
    f.sg8(0x4BB, 1);
}


/** 0x364e: cs:[0x64d] = 1 when the clip rectangle's rows lie inside the layer rows
 * cs:[0x65d..0x661], 0xff when they overlap them partly (0 is set by the caller). */
export function layer_rows(f) {
    const top = s16(f.g16(0x4BF)), bottom = s16(f.g16(0x4C3));
    const ltop = s16(f.g16(0x65D)), lbottom = s16(f.g16(0x661));
    if (top >= ltop) {
        if (bottom <= lbottom) f.sg8(0x64D, 1);
        else if (top <= lbottom) f.sg8(0x64D, 0xFF);
    } else if (bottom >= ltop) {
        f.sg8(0x64D, 0xFF);
    }
}


// --------------------------------------------------------------------------- redraw
/** 0x33d2: redraw a rectangle of the screen from the node lists of all views and copy it to
 * the displayed page. Nothing happens when the view being processed (cs:[0x3b1]) is hidden
 * (flag bit 6) or the rectangle is empty (0x3872).
 *
 * The drawing loop treats the node equal to SI as the end of the layer part. SI is the
 * caller's (cs:[0x449], left by the scheduler) until a view with the layer cache sets it to
 * the marker node cs:[0x64f]; it is restored when the routine returns. */
export function redraw(f, node, head) {
    const view = f.g16(0x3B1);
    const vseg = f.g16(0x3B3) * 16;
    if (f.mem.r8(vseg + view) & 0x40) return;
    f.sg8(0x4BC, 0);
    if (!redraw_rect(f, node, head)) return;
    let si = f.si;
    let handle = f.g16(0x493);
    while (handle) {
        const v = f.view(handle);
        const nxt = f.v16(v, 4);
        if (f.v8(v, 0) & 0x40) {
            handle = nxt;
            continue;
        }
        const h = f.v16(v, 2);
        if (h === 0) {
            handle = nxt;
            continue;
        }
        view_clip(f, h);
        if (!f.g8(0x4BB)) {
            handle = nxt;
            continue;
        }
        f.sg8(0x64D, 0);
        if (f.v8(v, 1) & 4) layer_rows(f);
        if (!(f.v8(v, 1) & 0x40)) clear(f);
        const layer = f.g8(0x64D);
        let n = h;
        if (layer === 1) {                                    // 0x3472
            const marker = f.g16(0x64F);
            si = marker;
            if (f.g8(0x64E) === 0) {
                copy_layer(f);                                // 0x350e
                n = marker;
            } else {
                target_layer(f);
            }
        } else if (layer & 0x80 && f.g8(0x64C) && f.g8(0x64E)) {   // 0x35af
            si = f.g16(0x64F);
            const top = f.g16(0x4BF), bottom = f.g16(0x4C3);
            target_layer(f);
            let d = h;
            for (;;) {
                d = f.n16(d, 6);
                if (d === 0 || d === si) break;
                if (!f.hidden_or_new(d)) draw(f, d);
            }
            f.sg16(0x4C3, bottom);
            f.sg16(0x4BF, top);
            target_screen(f);                                 // 0x34d6
            copy_layer(f);
        }
        for (;;) {                                            // 0x34c0
            n = f.n16(n, 6);
            if (n === 0) break;
            if (f.g8(0x64B) && n === si) {                    // 0x34d6: end of the layer part
                target_screen(f);
                copy_layer(f);
                continue;
            }
            if (!f.hidden_or_new(n)) draw(f, n);
        }
        handle = nxt;
    }
    if (f.g8(0x46B)) {                                        // 0x353d: pointer node
        const d = f.g16(0x469);
        if (!(f.n8(d, 0) & 0x80)) {
            f.sg16(0x4BD, f.g16(0x497));
            f.sg16(0x4BF, f.g16(0x499));
            // cs:[0x4c3] is not set: the instruction at 0x3567 repeats the one before it
            f.sg16(0x4C1, f.g16(0x49B));
            draw(f, d);
        }
    }
    if (!(f.mem.r8(vseg + u16(view + 1)) & 0x20)) copy_to_screen(f);
}


/** 0x2dc9: the pointer node cs:[0x469] (screen coordinates in +0x16/+0x18, graphic in
 * +0x12/+0x14), redrawn against the full-screen node cs:[0x465]. */
export function pointer_node(f) {
    f.sg8(0x495, 0);
    const node = u16(f.g16(0x45F) + f.g16(0x469));
    const head = f.g16(0x465);
    const state = f.n8(node, 0);
    if (state === 0 || state === 0xFE) return;
    if (state === 2) {                                        // 0x3265
        f.sg16(0x4D9, f.n16(node, 0x12));
        f.sg16(0x4DB, f.n16(node, 0x14));
        f.sg8(0x4D9, 0);
        f.sg16(0x4DD, f.n16(node, 0x16));
        f.sg16(0x4DF, f.n16(node, 0x18));
        f.sg16(0x4E1, 0);
        if (!overlap(f, node)) {
            f.sn8(node, 0, 0xFF);
            redraw(f, node, head);
        }
    } else if (state === 1) {                                 // 0x329d
        f.sn8(node, 0, 0xFE);
        redraw(f, node, head);
        return;
    } else if (state !== 0xFF) {
        return;
    }
    f.sn8(node, 0x22, f.n8(node, 0x23));                      // 0x323e
    f.sn16(node, 8, f.n16(node, 0x12));
    f.sn16(node, 0xA, f.n16(node, 0x14));
    f.sn16(node, 0xC, f.n16(node, 0x16));
    f.sn16(node, 0xE, f.n16(node, 0x18));
    f.sn8(node, 0, 0);
    redraw(f, node, head);
}


// --------------------------------------------------------------------------- projection
/** 0x28a0: camera-relative position d = (ax, cx, dx) -> [X, Y, Z]. View mode bit 7: rows u, v,
 * w of the view's matrix (signed bytes V+0x20..0x28); otherwise X = d.x, Y = v.y * d.y - d.z
 * (v.y = V+0x24), Z = d.y. 16-bit arithmetic throughout. */
export function rotate(f, view, ax, cx, dx) {
    if (!(f.v8(view, 1) & 0x80)) {                            // 0x288e
        return [ax, u16(s8(f.v8(view, 0x24)) * s16(cx) - dx), cx];
    }
    f.sg16(0x393, ax);
    f.sg16(0x399, ax);
    f.sg16(0x395, cx);
    f.sg16(0x397, dx);
    const d = [s16(ax), s16(cx), s16(dx)];
    const out = [];
    for (const row of [0x20, 0x23, 0x26]) {
        let acc = 0;
        for (let k = 0; k < 3; k++) {
            acc = u16(acc + s8(f.v8(view, row + k)) * d[k]);
            if (row === 0x20) f.sg16(0x399, acc);
            else if (row === 0x26) f.sg16(0x391, acc);
        }
        out.push(acc);
    }
    return [out[0], out[1], out[2]];
}


/** CDQ then n times SHL AX / RCL DX: the sign-extended word shifted left (32-bit result). */
export function shift32(v, n) {
    if (n >= 32) return 0;
    return (s16(v) * 2 ** n) >>> 0;
}


/** IDIV word: signed 32-bit by signed 16-bit, quotient truncated toward zero. */
export function idiv32(num, div) {
    const n = num & 0x80000000 ? num - 2 ** 32 : num;
    const d = s16(div);
    let q = floordiv(Math.abs(n), Math.abs(d));
    if ((n < 0) !== (d < 0)) q = -q;
    if (!(-0x8000 <= q && q <= 0x7FFF)) throw new ZeroDivisionError('divide overflow in the projection (0x26e2)');
    return u16(q);
}


/** 0x262c: project a node through its view. Results: cs:[0x4d9]/[0x4db] far pointer to the
 * directory entry to draw (the node's graphic +0x12/+0x14 plus 4 * level of detail),
 * cs:[0x4dd]/[0x4df] screen x, y of the top-left corner, cs:[0x4e1] depth, cs:[0x4e3] mirror.
 * The intermediate values stay in cs:[0x391..0x3bf]. */
export function project(f, node) {
    const view = f.view(f.n16(node, 2));
    f.sg8(0x4E3, f.n8(node, 0x23));
    let ax = u16(f.n16(node, 0x16) - f.v16(view, 0x16));
    let cx = u16(f.n16(node, 0x18) - f.v16(view, 0x18));
    let dx = u16(f.n16(node, 0x1A) - f.v16(view, 0x1A));
    f.sg16(0x3B9, ax);
    f.sg16(0x399, ax);
    f.sg16(0x3BD, cx);
    f.sg16(0x39B, cx);
    f.sg16(0x39D, dx);
    [ax, cx, dx] = rotate(f, view, ax, cx, dx);
    f.sg16(0x399, ax);
    f.sg16(0x39B, cx);
    f.sg16(0x39D, dx);
    f.sg16(0x397, 0);
    const persp = s8(f.v8(view, 0x1D));
    f.sg16(0x391, persp);
    if (persp >= 0 && !(f.n8(node, 0x1C) & 0x80)) {           // 0x269d: perspective
        const x32 = shift32(f.g16(0x399), persp);
        f.sg16(0x3B9, x32);
        f.sg16(0x3BB, x32 >>> 16);
        const y32 = shift32(f.g16(0x39B), persp);
        f.sg16(0x3BD, y32);
        f.sg16(0x3BF, y32 >>> 16);
        if (f.g16(0x39D) === 0) f.sg16(0x39D, 1);
        const z = f.g16(0x39D);
        f.sg16(0x39B, idiv32(y32, z));
        f.sg16(0x399, idiv32(x32, z));
        let level = sar16(z, f.n8(node, 0x1C));
        level = s16(level) + s8(f.n8(node, 0x1D));
        if (u16(level) & 0x8000) {
            f.sg16(0x397, 0);
        } else {
            const top = u16(s8(f.v8(view, 0x1E)));
            f.sg16(0x39F, top);
            f.sg16(0x397, u16(Math.min(level, top) << 2));
        }
    }
    const shift = f.v8(view, 0x1C);                           // 0x2740
    f.sg16(0x399, u16(sar16(f.g16(0x399), shift) + f.v16(view, 0xA)));
    f.sg16(0x39B, u16(sar16(f.g16(0x39B), shift) + f.v16(view, 0xC)));
    const tseg = f.n16(node, 0x14), toff = f.n16(node, 0x12);
    f.sg16(0x391, tseg);
    let entry = u16(toff + f.g16(0x397));
    let [rseg, roff] = render.follow(f.mem, tseg, entry);
    let rec = rseg * 16 + roff;
    if (f.mem.r8(rec) === 3) {                                // 0x27a4: frame with offset
        const dxo = f.mem.r16(rec + 4);
        if (f.n8(node, 0x23)) f.sg16(0x399, f.g16(0x399) - dxo);
        else f.sg16(0x399, f.g16(0x399) + dxo);
        f.sg16(0x39B, f.g16(0x39B) + f.mem.r16(rec + 6));
        const index = f.mem.r16(rec + 2);
        if (f.mem.r8(rec + 1)) f.sg8(0x4E3, f.g8(0x4E3) ^ 1);
        entry = u16(entry + u16(index << 2));
        [rseg, roff] = render.follow(f.mem, f.g16(0x391), entry);
        rec = rseg * 16 + roff;
    }
    ax = entry;
    let cl = f.n8(node, 0x24);                                // 0x2813: horizontal snapping
    if (cl) {
        const bias = f.n8(node, 0x25);
        if (!(bias & 0x80)) {
            ax = f.g16(0x397) >> 2;
            const al = ax & 0xFF;
            if (al > bias) {
                const dl = (f.g16(0x39F) - bias) & 0xFF;
                if (dl && !(dl & 0x80)) {
                    const prod = ((al - bias) & 0xFF) * cl;
                    const q = Math.floor(prod / dl), r = prod % dl;
                    if (q > 0xFF) throw new ZeroDivisionError('divide overflow in the snapping (0x283e)');
                    ax = r << 8 | q;
                    cl = r;                                   // shift by the remainder (AH), not AL
                }
            }
        }
        const n = cl & 0x1F;
        const x = f.g16(0x399);
        f.sg16(0x399, n < 16 ? u16((x >> n) << n) : 0);
    }
    f.sg16(0x4D9, ax);
    f.sg16(0x4DB, f.g16(0x391));
    f.sg16(0x399, f.g16(0x399) - (f.mem.r16(rec + 2) >> 1));
    f.sg16(0x39B, f.g16(0x39B) - (f.mem.r16(rec + 4) >> 1));
    f.sg16(0x4DD, f.g16(0x399));
    f.sg16(0x4DF, f.g16(0x39B));
    f.sg16(0x4E1, f.g16(0x39D));
}


// --------------------------------------------------------------------------- drawing wrappers
/** 0x79df: EGA/VGA: take the drawing lock cs:[0x46d] (spins until it is 0xff, leaves 0); the
 * software mouse pointer drawn from the timer interrupt (0x549d) respects it. CGA: mask the
 * interrupts other than the timer (port 0x21), no memory effect. */
export function lock(f) {
    if (f.g8(0x422)) f.sg8(0x46D, 0);
}


/** 0x7a01: release the lock (cs:[0x46d] = 0xff) / unmask the interrupts. */
export function unlock(f) {
    if (f.g8(0x422)) f.sg8(0x46D, 0xFF);
}


export function _with_pointer_lock(f, fn) {
    if (!(f.g8(0x46C) & 0x80)) {
        lock(f);
        fn();
        unlock(f);
    } else {
        fn();
    }
}


/** 0x3317: clear the redraw rectangle cs:[0x497..0x49d] of the work page to colour 0
 * (CGA 0xd12c; EGA/VGA 0x9709, inside the pointer lock while the pointer is shown). */
export function clear(f) {
    if (f.g8(0x422) === 0) render.cga_clear(f.vm, f.video);
    else _with_pointer_lock(f, () => render.ega_clear(f.vm, f.video));
}


/** 0x3339: draw one node clipped to cs:[0x4bd..0x4c3] (CGA 0xc199; EGA/VGA 0x9886). */
export function draw(f, node) {
    if (f.g8(0x422) === 0) render.cga_draw(f.vm, f.video, node);
    else _with_pointer_lock(f, () => render.ega_draw(f.vm, f.video, node));
}


/** 0x33b0: copy the clip rectangle cs:[0x4bd..0x4c3] from the layer buffer to the work page
 * (CGA 0xd1ce; EGA/VGA 0x97fd). */
export function copy_layer(f) {
    if (f.g8(0x422) === 0) render.cga_copy_layer(f.vm, f.video);
    else _with_pointer_lock(f, () => render.ega_copy_layer(f.vm, f.video));
}


/** 0x335b: copy the redraw rectangle cs:[0x497..0x49d] from the work page to the displayed
 * page (CGA 0xd074 into B800; EGA/VGA 0x9772 with the XOR copy). While the mouse pointer is
 * shown (cs:[0x46c] >= 0) it is hidden around the copy: on CGA by the mouse driver (interrupt
 * 0x33), on EGA/VGA by the engine's own pointer (0xbfe6 / 0xbf28) when it overlaps the
 * rectangle (0x5458, result in cs:[0x51d]). */
export function copy_to_screen(f) {
    const shown = !(f.g8(0x46C) & 0x80);
    if (f.g8(0x422) === 0) {
        render.cga_copy_to_screen(f.vm, f.video);
        return;
    }
    if (shown) {
        lock(f);
        const hit = render.pointer_overlaps(f.vm);
        f.sg8(0x51D, hit);
        if (hit) render.pointer_hide(f.vm, f.video);
    }
    render.ega_copy_to_screen(f.vm, f.video);
    if (shown) {
        if (f.g8(0x51D)) render.pointer_show(f.vm, f.video);
        unlock(f);
    }
}

register_module('frame_end', frame_end_module);
