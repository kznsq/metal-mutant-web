/**
 * Object life cycle: create (0x3c, 0x40), destroy (0x41, 0x44, 0xde), unload a class (0x3d) and
 * load a class or change the level (0x45). The engine routines they call follow the original
 * code; the comments give their addresses.
 *
 * Two statements end an object's turn in a way the interpreter loop cannot express by itself; the
 * handlers return SKIP and set a flag on the VM for the scheduler:
 *   * `vm.object_gone`: the running object is destroyed (0x6ee4 drops the interpreter's and the
 *     scheduler's return addresses and jumps to 0x1590). Nothing more of its turn runs (no save of
 *     SI to es:[bp-8], no per-frame script, no 0x2be2, no countdown reload, no restore of the
 *     call-stack pointer after a side script); the walk continues after cs:[0x381], which 0x6ee4
 *     set to the destroyed object's predecessor.
 *   * `vm.restart_pass`: a level is loaded (0x45 with class 0 jumps to 0x156c). The pass is
 *     abandoned and a new walk starts with object 0 at 0x15aa, without the frame end 0x2d12;
 *     the string buffers and cs:[0x381] are already reset, and `vm.es` is the new object heap.
 *
 * DOS calls (open, read, close, change directory) work on the game directory through `DOS`.
 * Fatal errors (0x85c2: message, key, exit) and the exit to DOS (0x1550) raise exceptions.
 */
import * as ops_life from './ops_life.js';
import * as F from './ops_flow.js';
import { game_dir } from './files.js';
import {
    CS, SKIP, FatalError, NotImplementedError, ProgramExit, RuntimeError, hex, register_module, s16,
    statement,
} from './vm.js';

export function u16(v) {
    return v & 0xFFFF;
}

export function sx8(v) {
    v &= 0xFF;
    return v >= 128 ? v - 256 : v;
}


export const TURN_OVER = 'turn over';
export const STRING_BUFFERS = [0x81, 0x181, 0x281];


// --------------------------------------------------------------------- memory helpers
export function r8(vm, seg, off) {
    return vm.mem.r8(seg * 16 + u16(off));
}

export function r16(vm, seg, off) {
    return vm.mem.r16(seg * 16 + u16(off));
}

export function w8(vm, seg, off, v) {
    vm.mem.w8(seg * 16 + u16(off), v);
}

export function w16(vm, seg, off, v) {
    vm.mem.w16(seg * 16 + u16(off), v);
}

/** seg:off plus the 32-bit offset hi:lo, normalised the way the engine does it (0x39a5,
 * 0x7f49): the carry of the low add goes into hi, hi's bytes are swapped and shifted left by
 * 4 (16-bit), the offset keeps its low nibble. */
export function far_add(seg, off, lo, hi) {
    let off2 = off + lo;
    if (off2 > 0xFFFF) hi += 1;
    off2 &= 0xFFFF;
    hi &= 0xFFFF;
    const para = ((((hi & 0xFF) << 8) | (hi >> 8)) << 4) & 0xFFFF;
    return [u16(seg + para + (off2 >> 4)), off2 & 0xF];
}

/** Forward copy of n bytes between linear addresses with dst < src (MOVS). */
export function copy_bytes(vm, dst, src, n) {
    const m = vm.mem.m;
    m.copyWithin(dst, src, src + n);
}


// --------------------------------------------------------------------- DOS
/** The DOS functions the loader uses, on the game directory taken as the root of the drive.
 * Names are matched ignoring case. The game keeps one file open at a time, so an open always
 * returns handle 5 (0-4 are the standard devices). The game directory (a files.Directory) is
 * flat: the root is its only directory. */
export class Dos {
    /** `root`: a files.Directory, or null for the mounted game directory (files.game_dir()). */
    constructor(root = null) {
        this.root = root;
        this.cwd = [];                                     // path components below the root
    }

    _directory() {
        return this.root ?? game_dir();
    }

    /** The path below the root names a directory (only the root itself is one). */
    _isdir(parts) {
        return parts.length === 0;
    }

    _resolve(name, want_dir) {
        name = name.replaceAll('/', '\\');
        if (name.length > 1 && name[1] === ':') name = name.slice(2);
        const parts = name.startsWith('\\') ? [] : [...this.cwd];
        for (const comp of name.split('\\')) {
            if (comp === '' || comp === '.') continue;
            if (comp === '..') {
                if (parts.length) parts.pop();
                continue;
            }
            const names = this._isdir(parts) ? this._directory().names() : [];
            const upper = comp.toUpperCase();
            const match = names.filter((f) => f.toUpperCase() === upper);
            if (!match.length) return null;
            parts.push(match[0]);
        }
        if (want_dir !== this._isdir(parts)) return null;
        return parts;
    }

    /** int 21h AH=3Bh; returns false (carry set) when the directory does not exist. */
    chdir(name) {
        const parts = this._resolve(name, true);
        if (parts === null) return false;
        this.cwd = parts;
        return true;
    }

    /** int 21h AH=3Dh; an open file object, or null (error 2, file not found). */
    open(name) {
        const parts = this._resolve(name, false);
        if (parts === null) return null;
        return new DosFile(this._directory().read(parts[parts.length - 1]));
    }
}
Dos.HANDLE = 5;


export class DosFile {
    constructor(data) {
        this.data = data;
        this.pos = 0;
    }

    /** int 21h AH=3Fh: read up to n bytes to seg:off (linear); returns the count. */
    read(vm, seg, off, n) {
        const chunk = this.data.subarray(this.pos, this.pos + n);
        this.pos += chunk.length;
        const a = seg * 16 + off;
        vm.mem.m.set(chunk, a);
        return chunk.length;
    }
}


export const DOS = new Dos();


/** 0x6ff1 with AX = 2 (open for reading and writing): the handle goes to cs:[0x435]; on
 * failure AX = error code 2 is stored there and fatal error 1 follows. (0x7097 first waits
 * until the sound flag cs:[0x574] is clear; that wait is not modelled.) */
export function open_file(vm, name) {
    const f = DOS.open(name);
    if (f === null) {
        vm.sg16(0x435, 2);
        throw new FatalError(1);
    }
    vm.sg16(0x435, Dos.HANDLE);
    return f;
}


// --------------------------------------------------------------------- class table
/** 0x6c75: [segment, offset, address after the entry] of the loaded class `cid`, or null.
 * The table at cs:[0x439] holds cs:[0x445] far pointers sorted by class id; the search stops
 * at the first id that is not lower. */
export function find_class(vm, cid) {
    let di = vm.g16(0x439);
    const end = u16(vm.g16(0x445) * 4 + di);
    for (;;) {
        const off = vm.g16(di), seg = vm.g16(u16(di + 2));
        di = u16(di + 4);
        if (di > end) return null;
        const v = r16(vm, seg, off);
        if (cid > v) continue;
        return cid === v ? [seg, off, di] : null;
    }
}

/** [segment, offset] of the class file of the object whose record is at es:rec. */
export function class_far(vm, rec) {
    return [r16(vm, vm.es, rec - 0x12), r16(vm, vm.es, rec - 0x14)];
}


// --------------------------------------------------------------------- creation
/** 0x6d8b: take the first entry of the free list cs:[0x455], link it into the object list
 * right after the running object cs:[0x381] (CX = its old link), count it (cs:[0x453]; above
 * the maximum cs:[0x451]: fatal error 5) and make its record (0x6dcf). Returns the record
 * offset; the handle is cs:[0x385]. */
export function create_object(vm, seg, off) {
    const table = vm.g16(0x449);
    const cur = vm.g16(0x381);
    const after = vm.g16(u16(cur + table + 4));
    vm.cx = after;
    const h = vm.g16(0x455);
    vm.sg16(u16(cur + table + 4), h);
    vm.sg16(0x455, vm.g16(u16(h + table + 4)));
    vm.sg16(u16(h + table + 4), after);
    vm.sg16(0x453, vm.g16(0x453) + 1);
    if (s16(vm.g16(0x453)) > s16(vm.g16(0x451))) throw new FatalError(5);
    vm.sg16(0x385, h);
    return init_record(vm, seg, off);
}

/** 0x6dcf: allocate the record of object cs:[0x385] at the heap end cs:[0x44f] for the
 * class at seg:off and initialise it. Layout from the heap end: [class+0x12] bytes of call
 * stack, [class+0x16] bytes of message queue, the 0x34-byte header, then [class+0x14] bytes
 * of variables (zeroed). Fatal error 0xc when the heap passes the limit segment cs:[0x459]
 * (cs:[0x44f] and the table entry are already written then). */
export function init_record(vm, seg, off) {
    const cls = (k) => r16(vm, seg, off + k);

    const table = vm.g16(0x449);
    const top = u16(vm.g16(0x44F) + cls(0x12));
    vm.sg16(0x38B, top);
    const rec = u16(top + cls(0x16) + 0x34);
    const h = vm.g16(0x385);
    vm.sg16(u16(table + h), rec);
    vm.sg16(0x38D, rec);
    const nvars = cls(0x14);
    const end = u16(rec + nvars);
    vm.sg16(0x44F, end);
    if (u16((end >> 4) + 1 + vm.g16(0x44D)) >= vm.g16(0x459)) throw new FatalError(0xC);
    const es = vm.es;
    if (nvars & 1) throw new RuntimeError("odd variable size: the original's clearing loop never ends");
    let k = nvars;
    for (;;) {
        w16(vm, es, k + rec - 2, 0);
        k = u16(k - 2);
        if (k === 0) break;
    }

    const w = (o, v) => w16(vm, es, rec + o, v);
    const b = (o, v) => w8(vm, es, rec + o, v);

    const sp = u16(vm.g16(0x38B) - rec);
    w(-0xA, sp);
    w(-0x1C, sp);
    w(-0x1E, sp);
    w(-8, off + 2 + cls(2));
    w(-6, seg);
    w(-0x10, cls(0));
    w(-0x14, 0);
    w(-0x12, seg);
    b(-0x2E, r8(vm, seg, off + 5));
    b(-2, 1);
    b(-1, 1);
    b(-4, 0xFF);
    w(-0x1A, 0xFFFF);
    w(-0xE, h);
    b(-0x24, 2);
    w(-0x18, 0);
    w(-0xC, 0);
    w(-0x22, 0);
    w(-0x20, 0);
    b(-3, 0);
    b(-0x25, 0);
    b(-0x26, 0xFF);
    b(-0x2A, 0);
    b(-0x28, 0);
    b(-0x2C, 0);
    b(-0x2D, 0);
    b(-0x2F, 0);
    w(-0x32, 0);
    w(-0x34, 0);
    b(-0x30, 0);
    return rec;
}

/** 0x1c66: u16 class, then a destination. Creates an object of the class next to the
 * running one at its position + (cs:[0x4e5], cs:[0x4e7], cs:[0x4e9]) and stores its handle
 * (-1 when the class is not loaded). CX is left as 0x6c75 / 0x6d8b leave it. */
export function spawn(vm) {
    vm.cx = u16(vm.g16(0x445) * 4 + vm.g16(0x439));
    const found = find_class(vm, vm.fetch16());
    if (found === null) {
        vm.dx = 0xFFFF;
        return F.destination(vm, F.DEST_STORE);
    }
    const [seg, off] = found;
    const nu = create_object(vm, seg, off);
    vm.dx = vm.g16(0x385);
    const es = vm.es, cur = vm.bp;
    for (const k of [0, 2, 4]) w16(vm, es, nu + k, vm.o16(k));
    for (const k of [9, 0xA, 0xB]) w8(vm, es, nu + k, vm.o8(k));
    w16(vm, es, nu - 0x28, vm.o16(-0xE));
    for (const [k, g] of [[0, 0x4E5], [2, 0x4E7], [4, 0x4E9]]) {
        w16(vm, es, nu + k, r16(vm, es, nu + k) + vm.g16(g));
    }
    w16(vm, es, nu - 0x16, r16(vm, es, cur - 0x16));
    w16(vm, es, nu - 0x22, r16(vm, es, cur - 0x22));
    w16(vm, es, nu - 0x2A, r16(vm, es, nu - 0xE));
    return F.destination(vm, F.DEST_STORE);
}

export function create(vm) {
    for (const g of [0x4E5, 0x4E7, 0x4E9]) vm.sg16(g, 0);
    return spawn(vm);
}
statement(0x40)(create);


/** 0x39a5: [segment, offset] of entry `index` of the current object's box table: the class's
 * graphics part (32-bit offset at class+0xe), its box table (32-bit offset at gfx+6), then the
 * entry's word offset from the table's word list. */
export function box_entry(vm, index) {
    let [seg, off] = class_far(vm, vm.bp);
    [seg, off] = far_add(seg, off, r16(vm, seg, off + 0xE), r16(vm, seg, off + 0x10));
    [seg, off] = far_add(seg, off, r16(vm, seg, off + 6), r16(vm, seg, off + 8));
    return [seg, u16(off + r16(vm, seg, u16(index * 2) + off))];
}

/** 0x3a1b: evaluate a box index and return the centre of that box [ax, bx, cx]: type 0 s8
 * corner + half the s8 extent, type 1 word corner + half the word extent, type >= 2 the
 * point at +2; negative type: fatal error 0x14. x is negated when es:[bp-0x2e] >= 0x15 and
 * the mirror flag es:[bp-3] is set. If the expression is an end item (0x3a), the evaluator
 * returns straight to 0x3a1b's caller with AX = 0x3a, BX = the value-stack pointer and
 * CX = DX. */
export function hotspot(vm) {
    if (vm.evaluate() === SKIP) return [0x3A, vm.bx, vm.cx];
    const [seg, si] = box_entry(vm, vm.dx);
    const kind = r8(vm, seg, si);
    let x, y, z;
    if (kind === 0) {
        const b = [];
        for (let k = 0; k < 6; k++) b.push(sx8(r8(vm, seg, si + 4 + k)));
        [x, y, z] = [0, 1, 2].map((k) => b[k] + (b[k + 3] >> 1));
    } else if (kind === 1) {
        const w = [];
        for (let k = 0; k < 6; k++) w.push(s16(r16(vm, seg, si + 4 + 2 * k)));
        [x, y, z] = [0, 1, 2].map((k) => w[k] + (w[k + 3] >> 1));
    } else if (kind < 0x80) {
        [x, y, z] = [0, 1, 2].map((k) => r16(vm, seg, si + 2 + 2 * k));
    } else {
        throw new FatalError(0x14);
    }
    if (sx8(vm.o8(-0x2E)) >= 0x15 && vm.o8(-3)) x = -x;
    return [u16(x), u16(y), u16(z)];
}

export function create_at_hotspot(vm) {
    const r = hotspot(vm);
    [0x4E5, 0x4E7, 0x4E9].forEach((g, k) => vm.sg16(g, r[k]));
    return spawn(vm);
}
statement(0x3C)(create_at_hotspot);


// --------------------------------------------------------------------- display nodes
/** 0x2a9d: unlink a node from its view's list (head es:[cs:[0x473] + view + 2], links at
 * node+6). */
export function remove_from_view(vm, ds, node) {
    const view = r16(vm, ds, node + 2);
    const main = vm.g16(0x473);
    const head = r16(vm, vm.es, main + view + 2);
    if (head === node) {
        w16(vm, vm.es, main + view + 2, r16(vm, ds, node + 6));
        return;
    }
    let si = head;
    for (let i = 0; i < 0x10000; i++) {
        if (r16(vm, ds, si + 6) === node) {
            w16(vm, ds, si + 6, r16(vm, ds, node + 6));
            return;
        }
        si = r16(vm, ds, si + 6);
    }
    throw new RuntimeError('node not in its view list: the original loops forever');
}

/** 0x2a26: remove every display node of the object at es:rec (list head es:[rec-0x18],
 * links at node+4) with 0x2a45, then clear cs:[0x470]. 0x2a45: when cs:[0x470] is clear and
 * the node's state byte is not negative, the node is only unlinked from the object and marked
 * 1 (the renderer erases and frees it); otherwise it is also put on the free list cs:[0x463]
 * and unlinked from its view. */
export function remove_object_nodes(vm, rec) {
    const ds = vm.g16(0x461);
    let di = r16(vm, vm.es, rec - 0x18);
    while (di) {
        const nxt = r16(vm, ds, di + 4);
        if (vm.g8(0x470) === 0 && r8(vm, ds, di) < 0x80) {
            w8(vm, ds, di, 1);
            w16(vm, vm.es, rec - 0x18, nxt);
        } else {
            w16(vm, vm.es, rec - 0x18, nxt);
            w16(vm, ds, di + 4, vm.g16(0x463));
            vm.sg16(0x463, di);
            remove_from_view(vm, ds, di);
        }
        di = r16(vm, vm.es, rec - 0x18);
    }
    vm.sg8(0x470, 0);
}


// --------------------------------------------------------------------- destruction
/** 0x6ee4: destroy object h (also given in cs:[0x385]). A negative handle or a free entry
 * only clears cs:[0x470] (returns null). Otherwise: remove its display nodes (0x2a26), move
 * the rest of the object heap down over its record (REP MOVSW of (cs:[0x44f] - record end)/2
 * words), lower cs:[0x44f] and every table entry at or above the record by its size, unlink
 * the entry (the predecessor defaults to entry 0 when none is found), put it on the free
 * list cs:[0x455] and decrement cs:[0x453]. If h is the running object cs:[0x381], set
 * cs:[0x381] to its predecessor and return TURN_OVER (the original continues the scheduler at
 * 0x1590); else return the running object's record (moved or not), which the original
 * leaves in BP (also stored in cs:[0x391]). */
export function destroy_object(vm, h) {
    const table = vm.g16(0x449);
    const rec = vm.g16(u16(h + table));
    if (h & 0x8000 || rec === 0) {
        vm.sg8(0x470, 0);
        return null;
    }
    remove_object_nodes(vm, rec);
    const [seg, off] = class_far(vm, rec);
    const below = u16(r16(vm, seg, off + 0x12) + r16(vm, seg, off + 0x16) + 0x34);
    const start = u16(rec - below);
    const size = u16(below + r16(vm, seg, off + 0x14));
    const src = u16(start + size);
    const end = vm.g16(0x44F);
    const words = u16(end - src) >> 1;
    const es = vm.es * 16;
    if (start + 2 * words <= 0x10000 && src + 2 * words <= 0x10000) {
        copy_bytes(vm, es + start, es + src, 2 * words);
    } else {
        for (let k = 0; k < words; k++) vm.mem.w16(es + u16(start + 2 * k), vm.mem.r16(es + u16(src + 2 * k)));
    }
    vm.sg16(0x44F, u16(end - size));
    let pred = 0, bx = 0;
    for (;;) {
        const nxt = vm.g16(u16(bx + table + 4));
        if (vm.g16(0x385) === nxt) pred = bx;
        bx = nxt;
        if (bx === 0) break;
        const r = vm.g16(u16(bx + table));
        if (rec <= r) vm.sg16(u16(bx + table), u16(r - size));
    }
    h = vm.g16(0x385);
    vm.sg16(u16(pred + table + 4), vm.g16(u16(h + table + 4)));
    vm.sg16(u16(h + table), 0);
    vm.sg16(u16(h + table + 4), vm.g16(0x455));
    vm.sg16(0x455, h);
    vm.sg16(0x453, vm.g16(0x453) - 1);
    if (vm.g16(0x381) === h) {
        vm.sg16(0x381, pred);
        return TURN_OVER;
    }
    const bp = vm.g16(u16(vm.g16(0x381) + table));
    vm.sg16(0x391, bp);
    return bp;
}

export function _end_turn(vm) {
    vm.object_gone = true;
    return SKIP;
}

/** 0x1cef: evaluate a handle at 0x573d (the value stack is not reset: BX is still the
 * interpreter's opcode * 2); if it is > 0, cs:[0x385] = handle and destroy it. */
export function _destroy_statement(vm) {
    if (vm.eval_next() === SKIP) return null;
    const h = vm.dx;
    if (h & 0x8000 || h === 0) return null;
    vm.sg16(0x385, h);
    const r = destroy_object(vm, h);
    if (r === TURN_OVER) return _end_turn(vm);
    if (r !== null) vm.bp = r;
    return null;
}

export function destroy(vm) {
    vm.bx = 0x41 * 2;
    return _destroy_statement(vm);
}
statement(0x41)(destroy);

/** 0x1ce5: as 0x41 with cs:[0x470] = 1 (nodes freed at once). A handle <= 0 leaves the flag
 * set. Destroying the running object this way leaves one return address on the machine
 * stack (0x1ce5 calls 0x1cef), which has no effect on memory here. */
export function destroy_now(vm) {
    vm.sg8(0x470, 1);
    vm.bx = 0xDE * 2;
    return _destroy_statement(vm);
}
statement(0xDE)(destroy_now);

/** 0x1d16: object 0 leaves the program; any other object destroys itself. */
export function destroy_self(vm) {
    const cur = vm.g16(0x381);
    if (cur === 0) throw new ProgramExit('statement 0x44 in object 0');
    vm.sg16(0x385, cur);
    if (destroy_object(vm, cur) === TURN_OVER) return _end_turn(vm);
    return null;
}
statement(0x44)(destroy_self);


// --------------------------------------------------------------------- unloading
/** 0x6b26-0x6b6d: copy class memory from segment src down to segment dst in 64K blocks.
 * AX = paras >> 4 counts 256-byte units; a block is 64K while AX - 0x100 is not negative,
 * else (paras & 0xfff) * 16 bytes (MOVSB + DEC CX + REP MOVSB, so 0 means 64K); the loop
 * stops when AX <= 0 after a block (a remainder below 256 bytes after whole blocks is not
 * copied). */
export function move_paragraphs(vm, dst, src, paras) {
    let ax = paras >> 4;
    for (;;) {
        ax = u16(ax - 0x100);
        const cx = !(ax & 0x8000) ? 0 : ((paras & 0xFFF) << 4) & 0xFFFF;
        const n = ((cx - 1) & 0xFFFF) + 1;
        copy_bytes(vm, dst * 16, src * 16, n);
        if (s16(ax) <= 0) return;
        dst = u16(dst + 0x1000);
        src = u16(src + 0x1000);
    }
}

/** 0x6ab6: unload class cs:[0x383] unless it is -1, the running object's class or not
 * loaded. Classes loaded above it move down (their memory and table segments), its table
 * entry is removed (cs:[0x447] -= 4, cs:[0x445]--), cs:[0x441] drops by the freed size, its
 * objects are destroyed (0x6ee4), every other object above it gets its class segment
 * es:[rec-0x12] and main-script segment es:[rec-6] lowered, and so do the graphic segments
 * (node+0xa, node+0x14) of the display nodes in every view list except state 0xff at +0x21.
 * The script segment DS is lowered too when it lies above.
 *
 * Quirk of the original, kept: 0x6ee4 returns with BP = the running object's record, while this
 * loop keeps the class id in BP; after a destruction it compares records with that offset and
 * continues from the freed entry's link, i.e. along the free list (records 0, so it reads and
 * may change es:[0xffee]/[0xfffa]). The running object's BP is restored unchanged even if its
 * record moved. */
export function unload_class(vm) {
    const cid = vm.g16(0x383);
    if (cid === 0xFFFF || cid === vm.o16(-0x10)) return null;
    const found = find_class(vm, cid);
    if (found === null) return null;
    const [seg, , after] = found;
    vm.sg16(0x393, u16(after - 4));
    vm.sg16(0x397, seg);
    let nxt = 0xFFFF;
    let bx = u16(vm.g16(0x439) - 4);
    for (;;) {
        bx = u16(bx + 4);
        if (bx === vm.g16(0x447)) break;
        const s = vm.g16(u16(bx + 2));
        if (s <= seg || s >= nxt) continue;
        nxt = s;
    }
    vm.sg16(0x399, nxt);
    if (nxt === 0xFFFF) {
        vm.sg16(0x399, vm.g16(0x441));
    } else {
        move_paragraphs(vm, seg, nxt, u16(vm.g16(0x441) - nxt));
    }
    let dist = u16(vm.g16(0x399) - vm.g16(0x397));
    vm.sg16(0x441, u16(vm.g16(0x441) - dist));
    vm.sg16(0x395, dist);
    let di = vm.g16(0x393);
    let si = u16(di + 4);
    const n = u16(vm.g16(0x447) - si);
    if (n) copy_bytes(vm, CS + di, CS + si, 2 * (n >> 1));
    vm.sg16(0x447, u16(vm.g16(0x447) - 4));
    vm.sg16(0x445, u16(vm.g16(0x445) - 1));
    const low = vm.g16(0x397);
    dist = vm.g16(0x395);
    di = vm.g16(0x439);
    for (;;) {
        di = u16(di + 4);
        const s = vm.g16(u16(di - 2));
        if (s >= low) vm.sg16(u16(di - 2), u16(s - dist));
        if (!(di < vm.g16(0x447))) break;
    }

    const saved_es = vm.es;
    const es = vm.es = vm.g16(0x44D);
    let bp = cid;
    const table = vm.g16(0x449);
    bx = 0;
    for (;;) {
        bx = vm.g16(u16(bx + table + 4));
        if (bx === 0) break;
        si = vm.g16(u16(bx + table));
        if (r16(vm, es, si - 0x10) === bp) {
            vm.sg16(0x385, bx);
            const r = destroy_object(vm, bx);
            if (r === TURN_OVER) {
                vm.es = es;
                return _end_turn(vm);
            }
            if (r !== null) bp = r;
            continue;
        }
        if (r16(vm, es, si - 0x12) < low) continue;
        w16(vm, es, si - 0x12, r16(vm, es, si - 0x12) - dist);
        w16(vm, es, si - 6, r16(vm, es, si - 6) - dist);
    }

    let view = vm.g16(0x493);
    if (view) {
        const main = vm.g16(0x473);
        const ds = vm.g16(0x461);
        for (;;) {
            let node = r16(vm, es, view + main + 2);
            for (;;) {
                node = r16(vm, ds, node + 6);
                if (node === 0) break;
                if (r8(vm, ds, node + 0x21) === 0xFF) continue;
                for (const k of [0xA, 0x14]) {
                    const v = r16(vm, ds, node + k);
                    if (v >= low) w16(vm, ds, node + k, v - dist);
                }
            }
            view = r16(vm, es, view + main + 4);
            if (view === 0) break;
        }
    }
    vm.es = saved_es;
    if (vm.ds >= vm.g16(0x397)) vm.ds = u16(vm.ds - vm.g16(0x395));
    return null;
}

export function unload(vm) {
    vm.sg16(0x383, vm.fetch16());
    return unload_class(vm);
}
statement(0x3D)(unload);


// --------------------------------------------------------------------- loading
/** 0x7073: int 21h AH=3Fh with BX = cs:[0x435]. A read error would be fatal error 0xd; reads
 * from the game files in memory cannot fail. */
export function read_file(vm, f, seg, off, n) {
    return f.read(vm, seg, off, n);
}

/** The bit reader 0x6a53 (CL bits, most significant first, from big-endian words of the
 * read buffer; refills the whole buffer with 0x1f40 bytes from the file at its end, without
 * clearing what a short read leaves). */
export function _bits_reader(vm, f, bseg, boff) {
    const st = { cur: 0, left: 0, di: u16(boff + 8) };
    const bend = vm.g16(0x3B9);

    function take(k) {
        const v = st.cur >> (16 - k);
        st.cur = (st.cur << k) & 0xFFFF;
        return v;
    }

    function read(cl) {
        if (!(1 <= cl && cl <= 16)) throw new NotImplementedError(`bit count ${cl}`);
        let ax = 0;
        if (st.left) {
            if (st.left >= cl) {
                st.left -= cl;
                return take(cl);
            }
            const n = st.left;
            cl -= n;
            ax = take(n);
            st.left = 0;
        }
        if (s16(st.di) >= s16(bend)) {
            read_file(vm, f, bseg, boff, 0x1F40);
            st.di = boff;
        }
        const w = r16(vm, bseg, st.di);
        st.cur = ((w >> 8) | (w << 8)) & 0xFFFF;
        st.di = u16(st.di + 2);
        st.left = 16 - cl;
        return ((ax << cl) | take(cl)) & 0xFFFF;
    }
    return read;
}

/** 0x6751 with the codec of type 0xa0 (0x68ed): decode the rest of the file into seg:off
 * until the output reaches seg:off + high:low (checked only after a literal run and after a
 * match, so the last token may write past it). The file is read 0x1f40 bytes at a time into
 * the buffer at far cs:[0x3d9]; its first 8 bytes (distance bit counts) are copied to
 * cs:0x6a1f. Sets cs:[0x3bd]/[0x3bf] (destination), cs:[0x674f] (end segment), cs:[0x399]
 * (end offset, < 16), cs:[0x3b9] (buffer end), and on return cs:[0x393] = end segment,
 * cs:[0x395] = CX = end offset. */
export function decompress(vm, f, seg, off, high, low) {
    let di = low + off;
    let ax = high;
    if (di > 0xFFFF) ax = u16(ax + 1);
    di &= 0xFFFF;
    vm.sg16(0x3BD, off);
    vm.sg16(0x3BF, seg);
    ax = ((((ax & 0xFF) << 8) | (ax >> 8)) << 4) & 0xFFFF;
    const end_seg = u16(seg + ax + (di >> 4));
    di &= 0xF;
    vm.sg16(0x674F, end_seg);
    if ((vm.g8(0x3D6) & 0xF0) !== 0xA0) {
        throw new NotImplementedError(`compression type 0x${hex(vm.g8(0x3D6), 2)} (0x6846/0x686e)`);
    }
    vm.sg16(0x399, di);
    const bseg = vm.g16(0x3DB), boff = vm.g16(0x3D9);
    vm.sg16(0x3B9, u16(boff + 0x1F40));
    read_file(vm, f, bseg, boff, 0x1F40);
    for (let k = 0; k < 8; k++) vm.sg8(0x6A1F + k, r8(vm, bseg, boff + k));
    const bits = _bits_reader(vm, f, bseg, boff);
    let ds = seg, si = off;

    const done = () => {
        const p = u16(ds + (si >> 4));
        if (p !== end_seg) return p > end_seg;
        return (si & 0xF) >= vm.g16(0x399);
    };

    while (!done()) {
        if (bits(1)) {
            let n = 0;
            for (;;) {
                const g = bits(2);
                n += g;
                if (g !== 3) break;
            }
            n = u16(n + 1);
            if (n + si > 0xFFFF) {
                ds = u16(ds + (si >> 4));
                si &= 0xF;
            }
            for (let i = 0; i < n; i++) {
                w8(vm, ds, si, bits(8));
                si = u16(si + 1);
            }
            if (done()) break;
        }
        const idx = bits(3);
        const cl = vm.g8(0x6A1F + idx);
        let n, dist;
        if ((idx & 3) === 0) {
            dist = bits(cl);
            n = 0;
            for (;;) {
                const g = bits(3);
                n += g;
                if (g !== 7) break;
            }
            n += 4;
        } else {
            n = idx & 3;
            dist = bits(cl);
        }
        n = u16(n + 1);
        const bp = u16(-dist);
        if (!(si > dist)) {
            const a = u16((u16(dist + 1) | 0xF) + 1);
            si = u16(si + a);
            ds = u16(ds - (a >> 4));
        }
        if (n + si > 0xFFFF) {
            const a = u16((u16(n + si) | 0xF) + 1);
            si = u16(si - a);
            ds = u16(ds + (a >> 4));
        }
        for (let i = 0; i < n; i++) {
            w8(vm, ds, si, r8(vm, ds, bp + si - 1));
            si = u16(si + 1);
        }
    }
    vm.sg16(0x393, end_seg);
    vm.sg16(0x395, vm.g16(0x399));
    return vm.g16(0x395);
}

/** 0x670d: read high:low bytes (a borrow from the caller's subtraction lowers high) to
 * seg:off in blocks of 0xffff bytes, advancing seg by 0xfff and off by 0xf per block.
 * Returns [CX, DS]: the last count plus the final offset, and the final segment. */
export function read_plain(vm, f, seg, off, high, low, borrow) {
    let ax = borrow ? u16(high - 1) : high;
    let cx = low, dx = off;
    if (s16(ax) > 0) {
        vm.sg16(0x391, cx);
        ax &= 0xF;
        for (;;) {
            read_file(vm, f, seg, dx, 0xFFFF);
            seg = u16(seg + 0xFFF);
            dx = u16(dx + 0xF);
            vm.sg16(0x391, vm.g16(0x391) + 1);
            if (vm.g16(0x391) !== 0) ax = u16(ax - 1);
            if (!(s16(ax) > 0)) break;
        }
        cx = vm.g16(0x391);
    }
    if (cx) read_file(vm, f, seg, dx, cx);
    return [u16(cx + dx), seg];
}

/** 0x66c2 / 0x6589: load the rest of the open file to cs:[0x441]:cs:[0x43f] according to
 * the header at cs:0xf6c (24-bit size, flags byte: bit 7 = compressed, cs:[0x3d6] = flags
 * & 0xfe); the size counts `header_size` bytes already read. Then close it (0x7041). Returns
 * [segment, offset, CX] for 0x6cf1. */
export function load_body(vm, f, header_size) {
    const seg = vm.g16(0x441), off = vm.g16(0x43F);
    const ax = vm.g16(0xF6E), cx = vm.g16(0xF6C);
    const ah = (ax >> 8) & 0xFE;
    vm.sg8(0x3D6, ah);
    const low = u16(cx - header_size);
    let end;
    if (ah & 0x80) {
        end = decompress(vm, f, seg, off, ax & 0xFF, low);
    } else {
        let ds;
        [end, ds] = read_plain(vm, f, seg, off, (ah << 8) | (ax & 0xFF), low, cx < header_size);
        vm.sg16(0x393, ds);
    }
    return [seg, off, end];
}

/** 0x6cf1: cs:[0x441] = cs:[0x393] + (CX >> 4) + 1 (next load segment; above cs:[0x40b]:
 * fatal error 0xb), insert seg:off into the class table sorted by the id in the file (before
 * the first entry whose id is not lower), cs:[0x447] += 4, cs:[0x445]++ (above cs:[0x443]:
 * fatal error 4), then convert the graphics (0x7f49) and the sounds (0x7df0). */
export function register_class(vm, seg, off, cx) {
    vm.sg16(0x441, u16((cx >> 4) + 1 + vm.g16(0x393)));
    if (vm.g16(0x441) > vm.g16(0x40B)) throw new FatalError(0xB);
    const cid = r16(vm, seg, off);
    let di = vm.g16(0x439);
    for (;;) {
        const o = vm.g16(di), s = vm.g16(u16(di + 2));
        di = u16(di + 4);
        if (di > vm.g16(0x447)) break;
        if (cid > r16(vm, s, o)) continue;
        let si = vm.g16(0x447);
        for (;;) {
            vm.sg16(si, vm.g16(u16(si - 4)));
            vm.sg16(u16(si + 2), vm.g16(u16(si - 2)));
            si = u16(si - 4);
            if (si < di) break;
        }
        break;
    }
    di = u16(di - 4);
    vm.sg16(di, off);
    vm.sg16(u16(di + 2), seg);
    vm.sg16(0x447, u16(vm.g16(0x447) + 4));
    vm.sg16(0x445, u16(vm.g16(0x445) + 1));
    if (s16(vm.g16(0x445)) > s16(vm.g16(0x443))) throw new FatalError(4);
    convert_graphics(vm, seg, off);
    convert_sounds(vm, seg, off);
}


export const CGA_TYPES = [1, 2, 0x80, 0x81, 0x82];


/** 0x7f49: adapt a loaded class's graphics to the display. gfx = class + [class+0xe]
 * (32-bit); [gfx+4] entries listed by 32-bit self-relative offsets at gfx + [gfx+0] (32-bit);
 * a 16-word palette at gfx + [gfx+0x12] (32-bit) + 0x20. On the 2-bit displays (cs:[0x24] in
 * 1, 2, 0x80-0x82): palette words &= 0x0f0f (cs:[0x7f44] = 0), cs:[0x3a9] = palette word 0,
 * then per entry: type 0 (masked sprite, cs:[0x7f43] = 0) and 2 (unmasked, cs:[0x7f43] = 1)
 * set palette word 0 to 0 / cs:[0x3a9] and convert the 4-bit pixels in place to 2-bit ones,
 * each colour index picking the low or high byte of its palette word by the parity of
 * column + row (dither); type 0 also builds a mask byte (3 per colour-0 pixel). Type 1 maps
 * its colour byte +1 through the palette. */
export function convert_graphics(vm, seg, off) {
    let [es, di] = far_add(seg, off, r16(vm, seg, off + 0xE), r16(vm, seg, off + 0x10));
    const count = u16(r16(vm, es, di + 4) - 1);
    vm.sg16(0x395, count);
    if (count & 0x8000) return;
    let [ds, si] = far_add(es, di, r16(vm, es, di), r16(vm, es, di + 2));
    const lo = r16(vm, es, di + 0x12);
    let hi = r16(vm, es, di + 0x14);
    let o = di + lo;
    if (o > 0xFFFF) hi += 1;
    o = u16(u16(o) + 0x20);
    hi &= 0xFFFF;
    es = u16(es + (((((hi & 0xFF) << 8) | (hi >> 8)) << 4) & 0xFFFF) + (o >> 4));
    di = o & 0xF;
    const cga = CGA_TYPES.includes(vm.g16(0x24));
    for (let k = 0; k < 16; k++) {
        const w = r16(vm, es, di + 2 * k);
        if (!cga) vm.sg8(0x7F44, 1);
        w16(vm, es, di + 2 * k, cga ? w & 0x0F0F : (w >> 4) & 0x0F0F);
    }
    if (cga) vm.sg8(0x7F44, 0);
    vm.sg16(0x3A9, r16(vm, es, di));
    for (;;) {
        const [gseg, gsi] = far_add(ds, si, r16(vm, ds, si), r16(vm, ds, si + 2));
        const kind = r8(vm, gseg, gsi);
        if (!cga) {
            _convert_planar(vm, es, di, gseg, gsi);
        } else if (kind === 1) {
            w16(vm, es, di, vm.g16(0x3A9));
            w8(vm, gseg, gsi + 1, r8(vm, es, di + 2 * r8(vm, gseg, gsi + 1)));
        } else if (kind === 0 || kind === 2) {
            w16(vm, es, di, kind ? vm.g16(0x3A9) : 0);
            vm.sg8(0x7F43, kind ? 1 : 0);
            _convert_sprite(vm, es, di, gseg, gsi);
        }
        si = u16(si + 4);
        vm.sg16(0x395, vm.g16(0x395) - 1);
        if (vm.g16(0x395) & 0x8000) return;
    }
}

/** 0x80d4-0x8166: 4-bit pixels at +6 (width +2, rows - 1 at +4) to 2-bit pixels in place. */
export function _convert_sprite(vm, es, di, ds, si) {
    const words = u16((u16(r16(vm, ds, si + 2) + 1) >> 2) - 1);
    vm.sg16(0x39F, r16(vm, ds, si + 4));
    vm.sg16(0x39D, words);
    si = u16(si + 6);
    let bp = si;
    vm.sg16(0x3C1, words);
    const masked = vm.g8(0x7F43) === 0;
    for (;;) {
        vm.sg16(0x39D, vm.g16(0x3C1));
        for (;;) {
            const w = r16(vm, ds, si);
            si = u16(si + 2);
            let ax = ((w >> 8) | (w << 8)) & 0xFFFF;
            let dx = 0;
            const odd_row = vm.g16(0x39F) & 1;
            for (const cx of [4, 3, 2, 1]) {
                let bl = ((ax >> 8) >> 3) & 0x1E;
                if (cx & 1) bl |= 1;
                if (odd_row) bl ^= 1;
                dx = (dx << 2) & 0xFFFF;
                dx |= r8(vm, es, di + bl) << 8;
                if ((bl & 0x1E) === 0) dx |= 3;
                ax = (ax << 4) & 0xFFFF;
            }
            if (masked) {
                w16(vm, ds, bp, dx);
                bp = u16(bp + 2);
            } else {
                w8(vm, ds, bp, dx >> 8);
                bp = u16(bp + 1);
            }
            vm.sg16(0x39D, vm.g16(0x39D) - 1);
            if (vm.g16(0x39D) & 0x8000) break;
        }
        vm.sg16(0x39F, vm.g16(0x39F) - 1);
        if (vm.g16(0x39F) & 0x8000) return;
    }
}

/** 0x8187: one graphic for the 16-colour displays. Type 1 maps its colour byte +1 through
 * the palette (unless cs:[0x423] = 1). Types 0 and 2 set palette word 0 (0 / cs:[0x3a9]) and,
 * row by row: map every pixel through the palette (a nibble of the low or high palette byte
 * by column + row parity; skipped when cs:[0x423] = 1), then split each 4 bytes (8 pixels)
 * into one byte per bit plane. Type 0 stores the planes in place (two words); type 2 writes
 * them to four 0x1f40-byte plane buffers at far cs:[0x4a1] (pointer cs:[0x7f45], 0x8330) and
 * copies the planes back after the last row, plane after plane (0x8352). */
export function _convert_planar(vm, es, di, ds, si) {
    vm.sg16(0x7F45, vm.g16(0x4A1));
    vm.sg16(0x7F47, vm.g16(0x4A3));
    const kind = r8(vm, ds, si);
    if (kind === 1) {
        if (vm.g8(0x423) !== 1) {
            w16(vm, es, di, vm.g16(0x3A9));
            w8(vm, ds, si + 1, r8(vm, es, di + 2 * r8(vm, ds, si + 1)));
        }
        return;
    }
    if (!(kind === 0 || kind === 2)) return;
    vm.sg8(0x7F43, kind ? 1 : 0);
    w16(vm, es, di, kind ? vm.g16(0x3A9) : 0);
    const words = u16((u16(r16(vm, ds, si + 2) + 1) >> 2) - 1);
    vm.sg16(0x39F, r16(vm, ds, si + 4));
    vm.sg16(0x39D, words);
    si = u16(si + 6);
    const bp = si;
    vm.sg16(0x3C1, words);
    const planes = [0, 0, 0, 0];
    for (;;) {
        const row = si;
        if (vm.g8(0x423) !== 1) {
            vm.sg16(0x39D, vm.g16(0x3C1));
            for (;;) {
                const w = r16(vm, ds, si);
                let ax = ((w >> 8) | (w << 8)) & 0xFFFF;
                let dx = 0;
                const odd_row = vm.g16(0x39F) & 1;
                for (const cx of [4, 3, 2, 1]) {
                    let bl = ((ax >> 8) >> 3) & 0x1E;
                    if (cx & 1) bl |= 1;
                    if (odd_row) bl ^= 1;
                    dx = (dx << 4) & 0xFFFF;
                    dx |= r8(vm, es, di + bl);
                    ax = (ax << 4) & 0xFFFF;
                }
                w16(vm, ds, si, ((dx >> 8) | (dx << 8)) & 0xFFFF);
                si = u16(si + 2);
                vm.sg16(0x39D, vm.g16(0x39D) - 1);
                if (vm.g16(0x39D) & 0x8000) break;
            }
        }
        si = row;
        vm.sg16(0x39D, vm.g16(0x3C1));
        for (;;) {
            planes[0] = planes[1] = planes[2] = planes[3] = 0;
            for (let k = 0; k < 4; k++) {
                const b = r8(vm, ds, si + k);
                for (let bit = 7; bit >= 0; bit--) {
                    const p = (3 - bit) & 3;
                    planes[p] = ((planes[p] << 1) | ((b >> bit) & 1)) & 0xFF;
                }
            }
            if (vm.g8(0x7F43) === 1) {
                const pseg = vm.g16(0x7F47), poff = vm.g16(0x7F45);
                for (let k = 0; k < 4; k++) w8(vm, pseg, poff + 0x1F40 * k, planes[k]);
                vm.sg16(0x7F45, poff + 1);
            } else {
                w16(vm, ds, si, planes[0] | (planes[1] << 8));
                w16(vm, ds, si + 2, planes[2] | (planes[3] << 8));
            }
            si = u16(si + 4);
            vm.sg16(0x39D, vm.g16(0x39D) - 2);
            if (vm.g16(0x39D) & 0x8000) break;
        }
        vm.sg16(0x39F, vm.g16(0x39F) - 1);
        if (vm.g16(0x39F) & 0x8000) break;
    }
    if (vm.g8(0x7F43) === 1) {
        const pseg = vm.g16(0x7F47), n = vm.g16(0x7F45) >> 1;
        let dst = bp;
        for (let k = 0; k < 4; k++) {
            for (let j = 0; j < n; j++) {
                w16(vm, ds, dst, r16(vm, pseg, 0x1F40 * k + 2 * j));
                dst = u16(dst + 2);
            }
        }
    }
}

/** 0x7df0 (only after a compressed file, cs:[0x3d6] != 0): expand 4-bit delta-coded sounds.
 * [gfx+0x10] sounds listed by 32-bit self-relative offsets at gfx + [gfx+0xc] (32-bit); a
 * sound of type 1 or 2 with byte +6 = 1 has (length [+2] - 0x74) / 2 code bytes at +0x74:
 * they are copied to the buffer at far cs:[0x3d9] (an even count), then decoded back in
 * place: the first byte as is, then two samples per byte, each adding the table cs:0x7de0
 * entry of a nibble (high first); the last two samples are zeroed and the length drops by 2. */
export function convert_sounds(vm, seg, off) {
    if (vm.g8(0x3D6) === 0) return;
    const [es, di] = far_add(seg, off, r16(vm, seg, off + 0xE), r16(vm, seg, off + 0x10));
    const count = u16(r16(vm, es, di + 0x10) - 1);
    vm.sg16(0x395, count);
    if (count & 0x8000) return;
    let [ds, si] = far_add(es, di, r16(vm, es, di + 0xC), r16(vm, es, di + 0xE));
    const bseg = vm.g16(0x3DB), boff = vm.g16(0x3D9);
    for (;;) {
        const [sseg, ssi] = far_add(ds, si, r16(vm, ds, si), r16(vm, ds, si + 2));
        const type = r8(vm, sseg, ssi);
        if ((type === 1 || type === 2) && r8(vm, sseg, ssi + 6) === 1) {
            const data = u16(ssi + 0x74);
            const cx = u16(r16(vm, sseg, ssi + 2) - 0x74) >> 1;
            for (let k = 0; k < 2 * (cx >> 1); k++) w8(vm, bseg, boff + k, r8(vm, sseg, data + k));
            let src = boff, dst = data;
            let dl = r8(vm, bseg, src);
            src = u16(src + 1);
            w8(vm, sseg, dst, dl);
            dst = u16(dst + 1);
            const n = u16(cx - 1) || 0x10000;
            for (let i = 0; i < n; i++) {
                const b = r8(vm, bseg, src);
                src = u16(src + 1);
                for (const nib of [b >> 4, b & 0xF]) {
                    dl = (dl + vm.g8(0x7DE0 + nib)) & 0xFF;
                    w8(vm, sseg, dst, dl);
                    dst = u16(dst + 1);
                }
            }
            w8(vm, sseg, dst - 1, 0);
            w8(vm, sseg, dst - 2, 0);
            w16(vm, sseg, ssi + 2, r16(vm, sseg, ssi + 2) - 2);
        }
        si = u16(si + 4);
        vm.sg16(0x395, vm.g16(0x395) - 1);
        if (vm.g16(0x395) & 0x8000) return;
    }
}

/** 0x668c: load class cs:[0x383] from file `name` (DOS path) unless a class with that id is
 * already loaded; class 0 loads a level instead (0x644a). The 6-byte header goes to
 * cs:0xf6c; a header with word +4 = 0 is a level file and continues as a level load (0x6459). */
export function load_class(vm, name) {
    if (vm.g16(0x383) === 0) return load_level(vm, name);
    if (find_class(vm, vm.g16(0x383)) !== null) {
        vm.cx = u16(vm.g16(0x445) * 4 + vm.g16(0x439));
        return null;
    }
    const f = open_file(vm, name);
    read_file(vm, f, CS >> 4, 0xF6C, 6);
    if (vm.g16(0xF70) === 0) return _load_level_body(vm, f);
    const [seg, off, cx] = load_body(vm, f, 6);
    register_class(vm, seg, off, cx);
    vm.cx = cx;
    vm.dx = off;
    return null;
}


// --------------------------------------------------------------------- level
/** 0x6cab: entries 0 .. max-2 cleared and chained (entry k links to k + 6); entry 0 alone
 * in the object list, count 1, free list from 6. The last entry is not touched. */
export function init_object_table(vm) {
    const di = vm.g16(0x449);
    let bx = 0, cx = 1;
    for (;;) {
        bx = u16(bx + 6);
        cx += 1;
        const si = u16(bx + di);
        vm.sg16(u16(si - 2), bx);
        vm.sg16(u16(si - 6), 0);
        vm.sg16(u16(si - 4), 0);
        if (!(s16(cx) < s16(vm.g16(0x451)))) break;
    }
    vm.sg16(u16(di + 4), 0);
    vm.sg16(0x453, 1);
    vm.sg16(0x455, 6);
}

/** 0x65f2: the display-node pool at far cs:[0x457]: reserved nodes at +2 (full screen,
 * cs:[0x465]), +0x28 (cs:[0x64f]) and +0x4e (state 0xfe, cs:[0x469]), then a free list from
 * +0x74 (cs:[0x463]) of 0x26-byte nodes up to segment cs:[0x45d]. */
export function init_display_pool(vm) {
    let si = vm.g16(0x457);
    const ds = vm.g16(0x459);
    vm.sg16(0x45F, si);
    vm.sg16(0x461, ds);
    si = u16(si + 2);
    vm.sg16(0x465, si);
    w16(vm, ds, si + 0xC, 0);
    w16(vm, ds, si + 0xE, 0);
    w16(vm, ds, si + 0x16, 0x13F);
    w16(vm, ds, si + 0x18, 0xC7);
    si = u16(si + 0x26);
    w8(vm, ds, si + 1, 0);
    vm.sg16(0x64F, si);
    si = u16(si + 0x26);
    vm.sg16(0x469, si);
    w16(vm, ds, si + 0xC, 0);
    w16(vm, ds, si + 0xE, 0);
    w8(vm, ds, si, 0xFE);
    vm.sg8(0x46B, 0);
    si = u16(si + 0x26);
    vm.sg16(0x463, si);
    let di = si;
    for (;;) {
        si = u16(si + 0x26);
        if (si > 0xFFD9) break;
        w16(vm, ds, di + 4, si);
        di = si;
        if (!(u16((di >> 4) + ds) < vm.g16(0x45D))) break;
    }
    w16(vm, ds, di - 0x26 + 4, 0);
}

/** 0x6459-0x65e9: read the 16-byte level header to cs:0xf72 (+0 class table size, +2 object
 * table size, +4 class memory size (32-bit), +8 object heap size, +0xc display nodes - 3),
 * lay out the tables, heap, display pool and class memory after them, reset the class table
 * and object table, load the file's class (object 0's) and create object 0 (record in
 * cs:[0x473]/[0x475], view 0). */
export function _load_level_body(vm, f) {
    read_file(vm, f, CS >> 4, 0xF72, 0x10);
    let ax = vm.g16(0xF72);
    vm.sg16(0x443, ax);
    const dx = vm.g16(0x405);
    vm.sg16(0x439, dx);
    vm.sg16(0x447, dx);
    const table = u16((((ax >> 2) + 1) << 4) + dx);
    vm.sg16(0x449, table);
    ax = vm.g16(0xF74);
    vm.sg16(0x451, ax);
    ax = u16(((ax * 6) & 0xFFFF) + table);
    const heap = u16((ax >> 4) + 1 + (CS >> 4));
    vm.sg16(0x44B, 0);
    vm.sg16(0x44D, heap);
    vm.es = heap;
    vm.sg16(0x44F, 0);
    const limit = u16(heap + (vm.g16(0xF7A) >> 4) + 1);
    vm.sg16(0x457, 0);
    vm.sg16(0x459, limit);
    const nodes = u16(vm.g16(0xF7E) + 3);
    const classes = u16(limit + (((nodes * 0x26) & 0xFFFF) >> 4) + 1);
    vm.sg16(0x45B, 0);
    vm.sg16(0x45D, classes);
    vm.sg16(0x43B, 0);
    vm.sg16(0x43D, classes);
    vm.sg16(0x43F, 0);
    vm.sg16(0x441, classes);
    const size = u16(((vm.g16(0xF78) & 0xF) << 12) + (vm.g16(0xF76) >> 4));
    const top = classes + size;
    if (top <= 0xFFFF && top <= vm.g16(0x40B)) {
        vm.sg16(0x40B, top);
        vm.sg16(0x409, 0);
    }
    vm.sg16(0x445, 0);
    vm.sg8(0x4B4, 0);
    vm.sg8(0x512, 0);
    vm.sg16(0x493, 0);
    vm.sg16(0x48D, 0);
    vm.sg8(0x46B, 0);
    vm.sg8(0x46C, 0xFF);
    vm.sg16(0x415, 0xFFFF);
    init_object_table(vm);
    init_display_pool(vm);
    const [seg, off, cx] = load_body(vm, f, 0x16);
    register_class(vm, seg, off, cx);
    vm.sg16(0x385, 0);
    const rec = init_record(vm, seg, off);
    w16(vm, vm.es, rec - 0x16, 0);
    vm.sg16(0x473, rec);
    vm.sg16(0x475, vm.es);
    vm.cx = cx;
    vm.dx = u16(off + 2 + r16(vm, seg, off + 2));
}

/** 0x644a: open the level's master file (`name`) and load the level. */
export function load_level(vm, name) {
    const f = open_file(vm, name);
    read_file(vm, f, CS >> 4, 0xF6C, 6);
    _load_level_body(vm, f);
}


export const LEVEL_FILE = 0x6442;                          // "main.io"


/** 0x63ee: build '<base directory cs:0x60b>\<string in buffer cs:[0x4d3]>' in the buffer
 * cs:[0x4d5] (one separator cs:[0x609] between them), change to that directory (int 21h
 * AH=3Bh, error ignored) and load the level from main.io (cs:[0x383] = 0, 0x668c). */
export function change_level(vm) {
    let di = vm.g16(0x4D5);
    let k = 0;
    for (;;) {
        const c = vm.g8(0x60B + k);
        vm.sg8(u16(di), c);
        di = u16(di + 1);
        k += 1;
        if (c === 0) break;
    }
    const sep = vm.g8(0x609);
    if (vm.g8(u16(di - 2)) === sep) di = u16(di - 1);
    vm.sg8(u16(di - 1), sep);
    let si = vm.g16(0x4D3);
    if (vm.g8(si) !== 0) {
        for (;;) {
            const c = vm.g8(si);
            si = u16(si + 1);
            vm.sg8(di, c);
            di = u16(di + 1);
            if (c === 0) break;
        }
        vm.sg8(u16(di - 1), 0);
    }
    vm.sg8(di, 0);
    const path = F.latin1(F.cstring(vm, CS + vm.g16(0x4D5)));
    DOS.chdir(path);
    vm.sg16(0x383, 0);
    load_class(vm, F.latin1(F.cstring(vm, CS + LEVEL_FILE)));
}

/** 0x1d2c: u16 class; class != 0: inline file name, load the class (0x668c) and continue
 * after the name; class 0: a string expression (0x574c: buffers swapped, value stack not
 * reset), change level (0x63ee) and restart the scheduler at object 0 (0x156c). */
export function load(vm) {
    const cid = vm.fetch16();
    if (cid) {
        vm.sg16(0x383, cid);
        vm.dx = vm.si;
        const name = F.latin1(F.cstring(vm, vm.lin()));
        load_class(vm, name);
        while (vm.fetch8()) { /* skip the name */ }
        return null;
    }
    vm.bx = 0x45 * 2;
    F.swap_buffers(vm, 0x4D3, 0x4D5);
    if (vm.eval_item() === SKIP) return null;
    change_level(vm);
    [0x4D3, 0x4D5, 0x4D7].forEach((g, k) => vm.sg16(g, STRING_BUFFERS[k]));
    vm.sg16(0x381, 0);
    vm.restart_pass = true;
    return SKIP;
}
statement(0x45)(load);


register_module('ops_life', ops_life);
