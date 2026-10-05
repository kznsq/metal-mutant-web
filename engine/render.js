/**
 * Metal Mutant's screen: the engine's drawing routines and a renderer for the interpreter.
 *
 * Two parts:
 *
 * 1. The low-level drawing routines the frame end (frame_end.js, code 0x2d12) calls, with all
 *    their memory effects (engine globals in the code segment) and their pixel output into a video
 *    model:
 *      EGA/VGA (cs:[0x422] = 1)   0x9709 clear, 0x9886 draw a node, 0x9772 copy to the screen,
 *                                 0x97fd copy from the layer page, 0xbf28 / 0xbfe6 mouse pointer
 *      CGA     (cs:[0x422] = 0)   0xd12c, 0xc199, 0xd074, 0xd1ce (into the memory image itself)
 *    EGAVideo models the 64 KB of EGA memory at A000 as one colour index per pixel (pixel p of
 *    byte b is element 8 * b + p). The game keeps three pages in it: the displayed page at 0, the
 *    work page at 0x2000 and the layer page (background cache) at 0x4000, 40 bytes per row.
 *
 * 2. render(): the picture as the original composes it, computed from the interpreter's memory
 *    alone (views, display nodes, class graphics): every visible view's nodes are drawn in list
 *    order (far to near) into a work page, clipped to the view's window, and the work page is
 *    copied to the displayed page as 0x9772 does. Returns 200 x 320 colour indices (the values the
 *    EGA displays) and the 16-colour palette (RGB).
 *
 * Graphics in memory: the class loader converts every bitmap for the display (0x7f49 -> 0x8187
 * for 16 colours): each 4-bit pixel is replaced by a colour of the class's dither table (two
 * colours per entry, chosen by the parity of column + row), entry 0 of a masked bitmap becomes
 * colour 0, and the pixels are rearranged into bit planes:
 *   type 0 (masked)  rows of w/8 groups of 4 bytes: bits 3, 2, 1, 0 of 8 pixels (leftmost = bit 7);
 *                    colour 0 is transparent
 *   type 2 (opaque)  four plane blocks of (w/8) * h bytes, bit 3 first
 *   type 1 (fill)    record +1 = colour (converted the same way)
 * Record header: +0 type, +1 flags, +2 width - 1, +4 height - 1, pixels from +6.
 *
 * Pictures and palettes as JavaScript values:
 *   - a page or a screen of colour indices is a Uint8Array of rows * 320 elements, row by row
 *     (EGAVideo.page() returns a view into EGAVideo.pix);
 *   - a palette is a Uint8Array(48): r, g, b of colour 0, then of colour 1 ... (palette(),
 *     cga_rgb());
 *   - ega_bitmap() returns { pix, h, w }: pix a Uint8Array of h * w colour indices, row by row.
 * Ranges of pixels follow fixed rules: a range past the end is shortened, a negative start counts
 * from the end, an unmasked one-pixel source fills the whole destination range, and any other
 * copy between ranges of different lengths raises ValueError (IndexError for a masked copy).
 */
import * as render_module from './render.js';
import { CS, IndexError, Memory, NotImplementedError, ValueError, register_module } from './vm.js';

export const PAGE_DISPLAY = 0, PAGE_WORK = 0x2000, PAGE_LAYER = 0x4000;
export const BYTES_PER_ROW = 40;
export const EDGE_MASKS = 0x90B4;                       // word table: left / right masks of a span
export const BIT_REVERSE = 0x91B4;                      // byte table used by the mirrored blitters
export const EGA_PALETTE_TABLE = 0x9494;                // mode-set colours (0x93cc -> 0x94b4)


export function u16(v) {
    return v & 0xFFFF;
}

export function s16(v) {
    v &= 0xFFFF;
    return v & 0x8000 ? v - 0x10000 : v;
}

/** [start, stop] of the elements start .. stop - 1 of a sequence of `length` elements: a
 * negative bound counts from the end, a bound beyond either end is clamped, and stop < start
 * gives an empty range. */
function _slice(start, stop, length) {
    if (start < 0) {
        start += length;
        if (start < 0) start = 0;
    } else if (start > length) start = length;
    if (stop < 0) {
        stop += length;
        if (stop < 0) stop = 0;
    } else if (stop > length) stop = length;
    return [start, stop < start ? start : stop];
}


/** seg:off + the 32-bit self-relative pointer stored there, normalised as the engine does
 * (0x31c5, 0x372b, 0x9892 ...): returns [segment, offset 0..15]. */
export function follow(mem, seg, off) {
    const a = seg * 16 + off;
    const lo = mem.r16(a);
    let hi = mem.r16(a + 2);
    let total = off + lo;
    if (total > 0xFFFF) hi += 1;
    hi &= 0xFFFF;
    total &= 0xFFFF;
    seg = u16(seg + u16(((hi & 0xFF) << 8 | hi >> 8) << 4) + (total >> 4));
    return [seg, total & 0xF];
}


// --------------------------------------------------------------------------- bitmaps
/** Layout of a converted bitmap record at linear address `rec`, as ega_bitmap() reads it: kind
 * (type & 3), height h, width w (columns of the image: w1 + 1, at most 8 per group), groups per
 * row, start of the pixel data and plane block size (type 2). */
function _bitmap_layout(mem, rec) {
    const kind = mem.r8(rec) & 3;
    const w1 = mem.r16(rec + 2), h1 = mem.r16(rec + 4);
    const h = h1 + 1;
    const groups = Math.floor((u16((w1 | 7) + 1) >> 1) / 4);
    const block = ((u16(w1 + 1) >> 3) & 0xFF) * (u16(h1 + 1) & 0xFF);
    return { kind, h, w: Math.min(w1 + 1, 8 * groups), groups, data: rec + 6, block };
}

/** Columns c0 .. c1 - 1 of row `sy` of the bitmap described by `L` into out[c0 .. c1 - 1] (bytes
 * past the end of memory read as 0, as ega_bitmap pads them). */
function _bitmap_row(m, L, sy, c0, c1, out) {
    const end = m.length;
    const g0 = c0 >> 3, g1 = (c1 + 7) >> 3;
    for (let g = g0; g < g1; g++) {
        let a3, a2, a1, a0;
        if (L.kind === 0) {
            const a = L.data + (sy * L.groups + g) * 4;
            a3 = a; a2 = a + 1; a1 = a + 2; a0 = a + 3;
        } else {
            a3 = L.data + sy * L.groups + g;
            a2 = a3 + L.block; a1 = a2 + L.block; a0 = a1 + L.block;
        }
        const b3 = a3 < end ? m[a3] : 0, b2 = a2 < end ? m[a2] : 0;
        const b1 = a1 < end ? m[a1] : 0, b0 = a0 < end ? m[a0] : 0;
        const first = Math.max(8 * g, c0), last = Math.min(8 * g + 8, c1);
        for (let c = first; c < last; c++) {
            const s = 7 - (c & 7);
            out[c] = ((b3 >> s) & 1) << 3 | ((b2 >> s) & 1) << 2 | ((b1 >> s) & 1) << 1 | ((b0 >> s) & 1);
        }
    }
}

let _ROW = new Uint8Array(1024);

function _row_buffer(n) {
    if (_ROW.length < n) _ROW = new Uint8Array(Math.max(n, 2 * _ROW.length));
    return _ROW;
}

/** Colour indices (h, w) of a converted type 0 or 2 record at linear address `rec`, read
 * with the strides the blitters use: a row of a type 0 bitmap is [0x9076] = ((w-1) | 7) + 1) / 2
 * bytes (4 per 8 pixels); a type 2 bitmap has plane blocks of [0x9080] = (w/8 rounded down) * h
 * bytes (8-bit product) and rows of w/8 rounded up bytes. (Every bitmap in the game files is a
 * multiple of 8 pixels wide.) Returns { pix, h, w }. */
export function ega_bitmap(mem, rec) {
    const L = _bitmap_layout(mem, rec);
    const pix = new Uint8Array(L.h * L.w);
    const row = _row_buffer(L.w);
    for (let sy = 0; sy < L.h; sy++) {
        _bitmap_row(mem.m, L, sy, 0, L.w, row);
        pix.set(row.subarray(0, L.w), sy * L.w);
    }
    return { pix, h: L.h, w: L.w };
}


// --------------------------------------------------------------------------- EGA memory model
/** 64 KB of EGA memory at A000 as colour indices, one per pixel (element 8 * byte + bit,
 * bit 0 = leftmost pixel = bit 7 of the planes' byte). */
export class EGAVideo {
    constructor() {
        this.pix = new Uint8Array(0x10000 * 8);
    }

    /** From four 64 KB plane images, plane 0 first. */
    static from_planes(planes) {
        const v = new EGAVideo();
        for (let p = 0; p < 4; p++) {
            const plane = planes[p];
            if (plane.length !== 0x10000) {
                throw new ValueError(`pixel ranges of different lengths: ${0x10000 * 8} and ${plane.length * 8}`);
            }
            for (let b = 0; b < 0x10000; b++) {
                const byte = plane[b];
                if (!byte) continue;
                for (let k = 0; k < 8; k++) v.pix[8 * b + k] |= ((byte >> (7 - k)) & 1) << p;
            }
        }
        return v;
    }

    planes() {
        const out = [];
        for (let p = 0; p < 4; p++) {
            const plane = new Uint8Array(0x10000);
            for (let b = 0; b < 0x10000; b++) {
                let byte = 0;
                for (let k = 0; k < 8; k++) byte |= ((this.pix[8 * b + k] >> p) & 1) << (7 - k);
                plane[b] = byte;
            }
            out.push(plane);
        }
        return out;
    }

    /** (rows, 320) view of the page starting at byte `offset`: a Uint8Array of rows * 320 pixels,
     * row by row, sharing this.pix. */
    page(offset, rows = 200) {
        const [lo, hi] = _slice(offset * 8, offset * 8 + rows * 320, this.pix.length);
        if (hi - lo !== rows * 320) throw new ValueError(`cannot view ${hi - lo} pixels as ${rows} rows of 320`);
        return this.pix.subarray(lo, hi);
    }

    byte_pixels(addr) {
        const a = (addr & 0xFFFF) * 8;
        return this.pix.subarray(a, a + 8);
    }

    /** Write 8 colours (leftmost first) to the byte at `addr` where `mask` has a bit. */
    write_masked(addr, colours, mask) {
        if (!mask) return;
        const a = (addr & 0xFFFF) * 8;
        for (let k = 0; k < 8; k++) {
            if (mask & (0x80 >> k)) this.pix[a + k] = colours[k];
        }
    }

    /** Store one byte into one plane (map mask with a single plane, plain write). */
    write_planes(addr, plane, value) {
        const a = (addr & 0xFFFF) * 8;
        const keep = ~(1 << plane) & 0xFF;
        for (let k = 0; k < 8; k++) {
            this.pix[a + k] = (this.pix[a + k] & keep) | (((value >> (7 - k)) & 1) << plane);
        }
    }
}


/** The video model of the display path the program uses (cs:[0x422]). */
export function video_for(vm) {
    return vm.g8(0x422) ? new EGAVideo() : new CGAVideo();
}


/** The CGA path draws into ordinary memory (work buffer at cs:[0x3fd]:[0x3ff], layer buffer
 * at cs:[0x655]:[0x657], displayed page at B800), so it needs no state of its own. */
export class CGAVideo {}


/** Shared by 0x9972, 0xbb66, 0xbc68: [middle byte count, left mask, right mask] of a span of
 * width_minus_1 + 1 pixels starting at x = left, from the table cs:0x90b4. */
export function edges(vm, left, width_minus_1) {
    let bp = 0;
    const dx = left & 7;
    const ax = 8 - dx;
    let bx = width_minus_1;
    if (!(ax >= s16(bx))) {
        bx = u16(bx - ax);
        bp = bx >> 3;
        bx = ((bx & 7) + ax) & 0xF;
    }
    const idx = u16((u16(bx << 3) | dx) << 1);
    const word = vm.g16(u16(EDGE_MASKS + idx));
    return [bp, word & 0xFF, word >> 8];
}


/** 0xbae7: byte offset of pixel (x, y) in a page: (320 * y + x) >> 3 in 16 bits. */
export function ega_address(x, y) {
    return u16(u16(y * 320) + x) >> 3;
}


// --------------------------------------------------------------------------- EGA routines
/** 0x9709: clear cs:[0x497..0x49d] of the work page to colour 0 (write mode 2), whole bytes
 * from byte [0x497] >> 3; nothing when [0x49b] == [0x497]. Sets cs:[0x403] = 0x2000. */
export function ega_clear(vm, video) {
    vm.sg16(0x403, PAGE_WORK);
    const x0 = vm.g16(0x497), y0 = vm.g16(0x499);
    const span = u16(vm.g16(0x49B) - x0);
    if (span === 0 || video == null) return;
    const nbytes = (span >> 3) + 1;
    const rows = u16(vm.g16(0x49D) - y0 + 1) || 0x10000;
    const di = u16(ega_address(x0, y0) + PAGE_WORK);
    const pix = video.pix, end = pix.length;
    for (let r = 0; r < rows; r++) {
        const a = u16(di + r * BYTES_PER_ROW) * 8;
        pix.fill(0, a, Math.min(a + nbytes * 8, end));
    }
}


/** Byte copy of rows y0..y1 (at least one), bytes x0 >> 3 .. + ((x1 - x0) >> 3), from page
 * `src` to page `dst`, XOR `xor` (write mode 0, set/reset + XOR function on the latches). */
export function _copy_rect(vm, video, x0, y0, x1, y1, src, dst, xor) {
    if (video == null) return;
    const nbytes = (u16(x1 - x0) >> 3) + 1;
    const d = s16(y1 - y0);
    const rows = d >= 0 ? d + 1 : 1;
    const base = ega_address(x0, y0);
    const pix = video.pix, end = pix.length;
    const n = nbytes * 8;
    for (let r = 0; r < rows; r++) {
        const s = u16(base + src + r * BYTES_PER_ROW) * 8;
        const t = u16(base + dst + r * BYTES_PER_ROW) * 8;
        const ls = Math.min(s + n, end) - s;
        const lt = Math.min(t + n, end) - t;
        if (ls === lt) {
            pix.copyWithin(t, s, s + ls);
            if (xor) {
                for (let i = t; i < t + lt; i++) pix[i] ^= xor;
            }
        } else if (ls === 1) {
            pix.fill(pix[s] ^ xor, t, t + lt);
        } else {
            throw new ValueError(`cannot copy ${ls} pixels into a range of ${lt}`);
        }
    }
}


/** 0x9772: copy cs:[0x497..0x49d] from the work page to the displayed page. The copy goes
 * through the latches with set/reset 0x0d (0 when cs:[0x423] = 1, VGA) and the XOR function,
 * so the displayed colour is work colour XOR 0x0d. Sets cs:[0x401] = 0x2000, [0x403] = 0. */
export function ega_copy_to_screen(vm, video) {
    vm.sg16(0x401, PAGE_WORK);
    vm.sg16(0x403, PAGE_DISPLAY);
    const xor = vm.g8(0x423) === 1 ? 0 : 0x0D;
    _copy_rect(vm, video, vm.g16(0x497), vm.g16(0x499), vm.g16(0x49B), vm.g16(0x49D),
               PAGE_WORK, PAGE_DISPLAY, xor);
}


/** 0x97fd: copy the clip rectangle cs:[0x4bd..0x4c3] from the layer page 0x4000 to the work
 * page (only when cs:[0x657] != 0). Sets cs:[0x401] = 0x4000, [0x403] = 0x2000. */
export function ega_copy_layer(vm, video) {
    if (vm.g16(0x657) === 0) return;
    vm.sg16(0x401, PAGE_LAYER);
    vm.sg16(0x403, PAGE_WORK);
    _copy_rect(vm, video, vm.g16(0x4BD), vm.g16(0x4BF), vm.g16(0x4C1), vm.g16(0x4C3),
               PAGE_LAYER, PAGE_WORK, 0);
}


/** 0x9886: draw display node `node` (offset in the pool segment cs:[0x461]) into the page
 * cs:[0x667] (work page, or the layer page while the layer is redrawn). */
export function ega_draw(vm, video, node) {
    vm.sg16(0x403, vm.g16(0x667));
    _ega_draw_at(vm, video, node);
}


/** 0x988e: the node's graphic (far pointer +8/+0xa to its directory entry) at +0xc, +0xe,
 * mirrored when +0x22 bit 0 is set, clipped to cs:[0x4bd..0x4c3], into page cs:[0x403]. */
export function _ega_draw_at(vm, video, node) {
    const mem = vm.mem;
    const n = vm.g16(0x461) * 16 + node;
    const [rseg, roff] = follow(mem, mem.r16(n + 0xA), mem.r16(n + 8));
    const rec = rseg * 16 + roff;
    const x = mem.r16(n + 0xC);
    vm.sg16(0x9070, x);
    if (s16(x) > s16(vm.g16(0x4C1))) return;
    const y = mem.r16(n + 0xE);
    vm.sg16(0x9072, y);
    if (s16(y) > s16(vm.g16(0x4C3))) return;
    let right = u16(x + mem.r16(rec + 2));
    if (s16(right) < s16(vm.g16(0x4BD))) return;
    let bottom = u16(y + mem.r16(rec + 4));
    if (s16(bottom) < s16(vm.g16(0x4BF))) return;
    const left = s16(x) >= s16(vm.g16(0x4BD)) ? x : vm.g16(0x4BD);
    const top = s16(y) >= s16(vm.g16(0x4BF)) ? y : vm.g16(0x4BF);
    right = s16(right) <= s16(vm.g16(0x4C1)) ? right : vm.g16(0x4C1);
    bottom = s16(bottom) <= s16(vm.g16(0x4C3)) ? bottom : vm.g16(0x4C3);
    vm.sg16(0x4A9, left);
    vm.sg16(0x4AB, top);
    vm.sg16(0x4AD, right);
    vm.sg16(0x4AF, bottom);
    vm.sg16(0x9074, u16(right - left));
    const rows = (bottom - top + 1) & 0xFF;
    vm.sg8(0x907A, rows);
    const mirror = mem.r8(n + 0x22) & 1;
    const kind = mem.r8(rec) & 3;
    vm.sg16(0x9088, 0);
    const clip = [s16(left), s16(top), s16(right), rows || 256];
    if (kind === 1) {
        _ega_fill(vm, video, rec, left, top, rows || 256);
    } else if (kind === 0 || kind === 2) {
        if (mirror) _setup_mirrored(vm, rseg, roff, left, top);
        else _setup(vm, rseg, roff, left, top);
        const di = u16(u16(top * BYTES_PER_ROW) + (left >> 3) + vm.g16(0x403));
        if (kind === 2) {
            if (vm.g8(0x9085)) vm.sg8(0x9078, vm.g8(0x9078) + 1);
            vm.sg16(0x9097, vm.g16(0x9082));
            vm.sg16(0x9099, di);
        } else {
            vm.sg8(0x907A, 0);
        }
        if (video != null) {
            if (kind === 2 && (x & 7) === 0) _ega_opaque_bytes(vm, video, rseg, di, mirror);
            else _ega_bitmap(vm, video, rec, s16(x), s16(y), mirror, kind === 0, clip);
        }
    } else {
        // the jump table sends type 3 to two type 2 variants without their set-up; the
        // projection replaces a type 3 record before anything is drawn, so this is not reached
        throw new NotImplementedError('record type 3 reached the blitter (0x9886)');
    }
}


/** 0x9972: solid rectangle in colour rec+1 (set/reset), edge bytes masked. */
export function _ega_fill(vm, video, rec, left, top, rows) {
    const [bp, lmask, rmask] = edges(vm, left, vm.g16(0x9074));
    vm.sg8(0x9085, lmask);
    vm.sg8(0x9087, rmask);
    if (video == null) return;
    const colour = vm.mem.r8(rec + 1) & 0x0F;
    const di = u16(ega_address(left, top) + vm.g16(0x403));
    const pix = video.pix;
    const put = (addr, mask) => {
        const a = (addr & 0xFFFF) * 8;
        for (let k = 0; k < 8; k++) {
            if (mask & (0x80 >> k)) pix[a + k] = colour;
        }
    };
    for (let r = 0; r < rows; r++) {
        const a = u16(di + r * BYTES_PER_ROW);
        let k = 0;
        if (lmask) put(u16(a + k++), lmask);
        for (let i = 0; i < bp; i++) put(u16(a + k++), 0xFF);
        if (rmask) put(u16(a + k++), rmask);
    }
}


/** 0xbb66: blitter set-up for unmirrored bitmaps. Writes cs:[0x9082] (source of the plane
 * blocks of a type 2 bitmap), [0x9080] (plane block size), [0x9076] (bytes per row of a type 0
 * bitmap), [0x9078] (middle bytes), [0x9085]/[0x9087] (edge masks), [0x907c] (destination row
 * skip), [0x907e] (source row skip). Returns SI (start of the type 0 pixel groups). */
export function _setup(vm, rseg, roff, left, top) {
    const mem = vm.mem;
    const rec = rseg * 16 + roff;
    let si = roff;
    vm.sg16(0x9082, roff);
    const w1 = mem.r16(rec + 2), h1 = mem.r16(rec + 4);
    vm.sg16(0x9080, ((u16(w1 + 1) >> 3) & 0xFF) * (u16(h1 + 1) & 0xFF));
    const cx = u16((w1 | 7) + 1) >> 1;
    vm.sg16(0x9076, cx);
    let ax = (s16(left) >> 1) & 0xFFFC;
    const dx = (s16(vm.g16(0x9070)) >> 1) & 0xFFFC;
    ax = u16(ax - dx);
    if (!(ax & 0x8000)) {
        si = u16(si + ax);
        vm.sg16(0x9082, vm.g16(0x9082) + (ax >> 2));
    }
    ax = u16(u16(top - vm.g16(0x9072)) * cx);
    vm.sg16(0x9082, vm.g16(0x9082) + (ax >> 2) + 6);
    si = u16(si + ax + 6);
    _edges_into(vm, left, cx, -1);
    return si;
}


/** 0xbc68: as 0xbb66 for mirrored bitmaps (the source is read backwards from the end of the
 * first visible row). */
export function _setup_mirrored(vm, rseg, roff, left, top) {
    const mem = vm.mem;
    const rec = rseg * 16 + roff;
    let si = roff;
    vm.sg16(0x9082, roff);
    const w1 = mem.r16(rec + 2), h1 = mem.r16(rec + 4);
    vm.sg16(0x9080, ((u16(w1 + 1) >> 3) & 0xFF) * (u16(h1 + 1) & 0xFF));
    const cx = u16((w1 | 7) + 1) >> 1;
    vm.sg16(0x9076, cx);
    let ax = (s16(left) >> 1) & 0xFFFC;
    const dx = (s16(vm.g16(0x9070)) >> 1) & 0xFFFC;
    ax = u16(ax - dx);
    if (!(ax & 0x8000)) {
        si = u16(si - ax);
        vm.sg16(0x9082, vm.g16(0x9082) - (ax >> 2));
    }
    ax = u16(u16(top - vm.g16(0x9072) + 1) * cx);
    vm.sg16(0x9082, vm.g16(0x9082) + (ax >> 2) + 5);
    si = u16(si + ax + 4);
    _edges_into(vm, left, cx, +1);
    return si;
}


export function _edges_into(vm, left, row_bytes, sign) {
    const [bp, lmask, rmask] = edges(vm, left, vm.g16(0x9074));
    vm.sg8(0x9085, lmask);
    vm.sg8(0x9087, rmask);
    vm.sg16(0x9078, bp);
    const bx = bp + (lmask ? 1 : 0) + (rmask ? 1 : 0);
    vm.sg16(0x907C, BYTES_PER_ROW - bx);
    vm.sg16(0x907E, u16(row_bytes + sign * 4 * bx));
}


/** 0x9a2d / 0xa4ff (type 2 at x & 7 == 0): whole bytes per row, [0x9078] + 1 of them (one
 * more than the span when it has no right edge byte), copied plane by plane from the plane
 * blocks (mirrored: read backwards through the bit-reversal table cs:0x91b4). */
export function _ega_opaque_bytes(vm, video, rseg, di0, mirror) {
    const mem = vm.mem;
    const m = mem.m;
    const count = (vm.g8(0x9078) + 1) & 0xFF;
    const rows = vm.g8(0x907A) || 256;
    const skip_src = s16(vm.g16(0x907E)) >> 2;
    const skip_dst = vm.g16(0x907C);
    const block = vm.g16(0x9080);
    const base = rseg * 16;
    const rev = CS + BIT_REVERSE;
    const pix = video.pix;
    const planes = [3, 2, 1, 0];
    for (let k = 0; k < 4; k++) {
        const plane = planes[k];
        const keep = ~(1 << plane) & 0xFF;
        let si = u16(vm.g16(0x9097) + k * block);
        let di = di0;
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < count; c++) {
                let b = mem.r8(base + si);
                if (mirror) {
                    b = m[rev + b];
                    si = u16(si - 1);
                } else {
                    si = u16(si + 1);
                }
                const a = di * 8;
                for (let p = 0; p < 8; p++) pix[a + p] = (pix[a + p] & keep) | (((b >> (7 - p)) & 1) << plane);
                di = u16(di + 1);
            }
            si = u16(si + skip_src);
            di = u16(di + skip_dst);
        }
    }
}


/** The blitters of types 0 (masked) and 2 (opaque, x & 7 != 0): pixel-exact copy of the
 * clipped rectangle; colour 0 is transparent in masked bitmaps. */
export function _ega_bitmap(vm, video, rec, x, y, mirror, masked, clip) {
    const [left, top, right, rows] = clip;
    const L = _bitmap_layout(vm.mem, rec);              // the image ega_bitmap() decodes
    const h = L.h, w = L.w;
    const m = vm.mem.m;
    const row = _row_buffer(w);
    const page = vm.g16(0x403);
    const pix = video.pix, end = pix.length;
    for (let r = 0; r < rows; r++) {
        const sy = top - y + r;
        if (!(0 <= sy && sy < h)) continue;
        const sx0 = left - x;
        const [lo, hi] = _slice(sx0, sx0 + (right - left + 1), w);    // columns of the image
        const size = hi - lo;
        const start = u16(page + ega_address(0, top + r)) * 8 + left;
        const [dlo, dhi] = _slice(start, start + size, end);
        const dsize = dhi - dlo;
        if (masked) {
            if (dsize !== size) {
                throw new IndexError(`mask length ${size} does not match ${dsize} pixels`);
            }
        } else if (dsize !== size && size !== 1) {
            throw new ValueError(`cannot copy ${size} pixels into a range of ${dsize}`);
        }
        if (size === 0) continue;
        // source columns lo .. hi - 1; mirrored column c is column w - 1 - c of the bitmap
        if (mirror) _bitmap_row(m, L, sy, w - hi, w - lo, row);
        else _bitmap_row(m, L, sy, lo, hi, row);
        if (masked) {
            for (let i = 0; i < size; i++) {
                const v = mirror ? row[w - 1 - (lo + i)] : row[lo + i];
                if (v) pix[dlo + i] = v;
            }
        } else if (dsize !== size) {
            pix.fill(mirror ? row[w - 1 - lo] : row[lo], dlo, dhi);
        } else {
            for (let i = 0; i < size; i++) pix[dlo + i] = mirror ? row[w - 1 - (lo + i)] : row[lo + i];
        }
    }
}


// --------------------------------------------------------------------------- EGA mouse pointer
/** 0x5458 (EGA): 1 if the 16 x 16 pointer at cs:[0x51f], [0x521] touches the redraw
 * rectangle cs:[0x497..0x49d]. */
export function pointer_overlaps(vm) {
    const x = s16(vm.g16(0x51F)), y = s16(vm.g16(0x521));
    if (x > s16(vm.g16(0x49B)) || y > s16(vm.g16(0x49D))) return 0;
    if (x + 15 < s16(vm.g16(0x497)) || y + 15 < s16(vm.g16(0x499))) return 0;
    return 1;
}


/** 0xbfe6: copy the pointer's 16 x 16 area (bytes from x & ~7) from the work page back to the
 * displayed page (0x9772 with a temporary redraw rectangle). */
export function pointer_hide(vm, video) {
    const offs = [0x497, 0x49B, 0x499, 0x49D];
    const saved = offs.map((o) => vm.g16(o));
    const x = vm.g16(0x51F), y = vm.g16(0x521);
    vm.sg16(0x497, x & 0xFFF8);
    vm.sg16(0x49B, Math.min(s16(x + 15), 0x13F) | 7);
    vm.sg16(0x499, y);
    vm.sg16(0x49D, Math.min(s16(y + 15), 0xC7));
    ega_copy_to_screen(vm, video);
    for (let i = 0; i < 4; i++) vm.sg16(offs[i], saved[i]);
}


/** 0xbf28: draw the pointer node cs:[0x469] straight onto the displayed page at
 * cs:[0x51f], [0x521], clipped to its 16 x 16 square; the clip, the clipped rectangle and
 * cs:[0x403] are restored afterwards. */
export function pointer_show(vm, video) {
    const keep = [0x403, 0x4BD, 0x4C1, 0x4BF, 0x4C3, 0x4A9, 0x4AD, 0x4AB, 0x4AF];
    const saved = keep.map((o) => vm.g16(o));
    vm.sg16(0x403, PAGE_DISPLAY);
    const node = u16(vm.g16(0x45F) + vm.g16(0x469));
    const n = vm.g16(0x461) * 16 + node;
    const x = vm.g16(0x51F), y = vm.g16(0x521);
    vm.mem.w8(n + 0x22, 0);
    vm.mem.w16(n + 0xC, x);
    vm.sg16(0x4BD, x);
    vm.sg16(0x4C1, Math.min(s16(x + 15), 0x13F));
    vm.mem.w16(n + 0xE, y);
    vm.sg16(0x4BF, y);
    vm.sg16(0x4C3, Math.min(s16(y + 15), 0xC7));
    _ega_draw_at(vm, video, node);
    for (let i = 0; i < keep.length; i++) vm.sg16(keep[i], saved[i]);
}


// --------------------------------------------------------------------------- CGA routines
// The CGA path keeps its pages in ordinary memory, in the layout of CGA memory (2 bits per pixel,
// leftmost pixel in bits 7-6, 80 bytes per row, even rows from offset 0 and odd rows from 0x2000):
// the work buffer at segment cs:[0x3ff], the layer buffer at cs:[0x657]:[0x655], and the
// displayed page at B800. A bitmap converted for CGA (0x80d4) holds, per 4 pixels, one byte of
// pixels (type 2) or a word: mask byte (3 per transparent pixel) then pixel byte (type 0).
export const CGA_FILL_BYTES = 0xC160;                   // fill colour 0-3 -> byte of four pixels
export const CGA_REVERSE = 0xC060;                      // byte with its four pixels reversed


/** Byte offset of pixel (x, y) in a CGA page: 80 * (y >> 1) + (x >> 2), + 0x2000 on odd rows
 * (0xd135, 0xc287). */
export function cga_row_offset(x, y) {
    const off = u16(80 * (y >> 1) + (x >> 2));
    return y & 1 ? off ^ 0x2000 : off;
}


/** The row step of the CGA loops: add the row skip, flip 0x2000; back 80 bytes when the
 * result is an odd row. */
export function cga_next_row(di, add) {
    di = u16(di + add) ^ 0x2000;
    return di & 0x2000 ? u16(di - 0x50) : di;
}


/** The row loop of 0xd12c / 0xd074 / 0xd1ce: rows y0..y1 (one more pass while the counter
 * has not reached 0), `words` words per row from byte (x >> 2). */
export function _cga_rows(vm, x, y0, y1, words, write) {
    let di = cga_row_offset(x, y0);
    const rows = u16(y1 - y0 + 1) || 0x10000;
    const skip = u16(80 - 2 * words);
    for (let r = 0; r < rows; r++) {
        write(di, 2 * words);
        di = cga_next_row(u16(di + 2 * words), skip);
    }
}


/** 0xd12c: zero the redraw rectangle cs:[0x497..0x49d] of the work buffer (segment
 * cs:[0x3ff]), cs:[0x49f] words per row from byte [0x497] >> 2. No global is written. */
export function cga_clear(vm, video) {
    const base = vm.g16(0x3FF) * 16;
    const m = vm.mem.m;
    const write = (di, n) => {
        for (let k = 0; k < n; k++) m[base + u16(di + k)] = 0;
    };
    _cga_rows(vm, vm.g16(0x497), vm.g16(0x499), vm.g16(0x49D), vm.g16(0x49F), write);
}


/** 0xd074: copy the redraw rectangle from the work buffer (segment cs:[0x3ff]) to the
 * displayed page at B800, same offsets, cs:[0x49f] words per row. */
export function cga_copy_to_screen(vm, video) {
    const src = vm.g16(0x3FF) * 16;
    const m = vm.mem.m;
    const write = (di, n) => {
        for (let k = 0; k < n; k++) m[0xB8000 + u16(di + k)] = m[src + u16(di + k)];
    };
    _cga_rows(vm, vm.g16(0x497), vm.g16(0x499), vm.g16(0x49D), vm.g16(0x49F), write);
}


/** 0xd1ce: copy the clip rectangle's rows cs:[0x4bf..0x4c3] from the layer buffer
 * (cs:[0x657]:[0x655] + offset) to the work buffer, from byte [0x4bd] >> 2 but cs:[0x49f]
 * words per row (the width of the redraw rectangle, not of the clip rectangle). The row step
 * is decided on the source offset. */
export function cga_copy_layer(vm, video) {
    const dst = vm.g16(0x3FF) * 16;
    const sseg = vm.g16(0x657) * 16;
    const m = vm.mem.m;
    let di = cga_row_offset(vm.g16(0x4BD), vm.g16(0x4BF));
    let si = u16(di + vm.g16(0x655));
    const words = vm.g16(0x49F);
    const rows = u16(vm.g16(0x4C3) - vm.g16(0x4BF) + 1) || 0x10000;
    const skip = u16(80 - 2 * words);
    for (let r = 0; r < rows; r++) {
        for (let k = 0; k < 2 * words; k++) m[dst + u16(di + k)] = m[sseg + u16(si + k)];
        si = u16(si + 2 * words + skip) ^ 0x2000;
        di = u16(di + 2 * words + skip) ^ 0x2000;
        if (si & 0x2000) {
            si = u16(si - 0x50);
            di = u16(di - 0x50);
        }
    }
}


/** Registers and memory of the CGA blitter 0xc199: source DS:SI (the bitmap), destination
 * ES:DI (cs:[0x667], the work or layer buffer), direction flag. */
export class _CGABlit {
    constructor(vm, rseg) {
        this.vm = vm;
        this.m = vm.mem.m;
        this.src = rseg * 16;
        this.dst = vm.g16(0x667) * 16;
        this.si = 0;
        this.di = 0;
        this.down = false;
    }

    lodsb() {
        const v = this.m[this.src + this.si];
        this.si = u16(this.down ? this.si - 1 : this.si + 1);
        return v;
    }

    lodsw() {
        const a = this.src + this.si;
        const v = this.m[a] | this.m[this.src + u16(this.si + 1)] << 8;
        this.si = u16(this.down ? this.si - 2 : this.si + 2);
        return v;
    }

    dest() {
        return this.m[this.dst + this.di];
    }

    /** Every store of the blitters runs with the direction flag clear (cld before stosb). */
    stosb(v) {
        this.m[this.dst + this.di] = v & 0xFF;
        this.di = u16(this.di + 1);
    }

    rev(b) {
        return this.vm.g8(CGA_REVERSE + b);
    }

    next_row(src_skip) {
        this.si = u16(this.si + this.vm.g16(src_skip));
        this.di = cga_next_row(this.di, this.vm.g16(0x8E5));
    }

    /** Count down the rows left in cs:[0x3a3]; true when none is left (dec word cs:[0x3a3];
     * je done). */
    row_done() {
        const v = u16(this.vm.g16(0x3A3) - 1);
        this.vm.sg16(0x3A3, v);
        return v === 0;
    }
}


const _CGA_MASKED = [_cga_masked0, _cga_masked_shift, _cga_masked_shift, _cga_masked_shift];
const _CGA_OPAQUE = [_cga_opaque0, _cga_opaque_shift, _cga_opaque_shift, _cga_opaque_shift];

/** 0xc199: draw display node `node` into segment cs:[0x667] (work or layer buffer), clipped
 * to cs:[0x4bd..0x4c3]. Horizontal clipping is by whole bytes (4 pixels); the edge bytes of a
 * bitmap that starts or ends inside the clip rectangle at x & 3 != 0 are merged with what is
 * there. Unlike 0x9886 the mirror byte +0x22 must be exactly 0 or 1 (other values: nothing is
 * drawn) and a record of type other than 0, 1, 2 is drawn only mirrored, as type 0. */
export function cga_draw(vm, video, node) {
    const mem = vm.mem;
    const g = (o) => vm.g16(o), sg = (o, v) => vm.sg16(o, v);
    const n = vm.g16(0x461) * 16 + node;
    const [rseg, roff] = follow(mem, mem.r16(n + 0xA), mem.r16(n + 8));
    const rec = rseg * 16 + roff;
    sg(0x8F5, roff);
    const mirror = mem.r8(n + 0x22);
    vm.sg8(0x4B3, mirror);
    const kind = mem.r8(rec);
    vm.sg8(0x4B5, kind);
    vm.sg8(0x4B6, vm.g8(CGA_FILL_BYTES + (mem.r8(rec + 1) & 3)));
    const w1 = mem.r16(rec + 2), h1 = mem.r16(rec + 4);
    sg(0x8F9, u16(s16(u16(w1 + 1)) >> 1));
    const x = mem.r16(n + 0xC), y = mem.r16(n + 0xE);
    if (s16(x) > s16(g(0x4C1)) || s16(y) > s16(g(0x4C3))) return;
    const right = u16(x + w1);
    if (s16(right) < s16(g(0x4BD))) return;
    const bottom = u16(y + h1);
    if (s16(bottom) < s16(g(0x4BF))) return;
    sg(0x4A9, s16(x) >= s16(g(0x4BD)) ? x : g(0x4BD));
    sg(0x4AB, s16(y) >= s16(g(0x4BF)) ? y : g(0x4BF));
    sg(0x4AD, s16(right) <= s16(g(0x4C1)) ? right : g(0x4C1));
    sg(0x4AF, s16(bottom) <= s16(g(0x4C3)) ? bottom : g(0x4C3));
    sg(0x8E1, u16(g(0x49D) - g(0x499) + 1));
    sg(0x8F1, cga_row_offset(g(0x4A9), g(0x4AB)));
    const nbytes = u16((g(0x4AD) | 3) - (g(0x4A9) & 0xFFFC) + 1) >> 2;
    sg(0x8E9, nbytes);
    sg(0x8E5, u16(80 - nbytes));
    const b = new _CGABlit(vm, rseg);
    if (kind === 2) {
        if (mirror === 0) {
            _cga_setup_opaque(vm, b, n, rec, roff, nbytes, false);
            _CGA_OPAQUE[g(0x8ED)](vm, b, false);
        } else if (mirror === 1) {
            _cga_setup_opaque(vm, b, n, rec, roff, nbytes, true);
            _CGA_OPAQUE[g(0x8ED)](vm, b, true);
        }
        return;
    }
    if (kind === 1 || mirror === 0) {
        _cga_setup_masked(vm, b, n, rec, roff, nbytes, false);
        if (kind === 0) _CGA_MASKED[g(0x8ED)](vm, b, false);
        else if (kind === 1) _cga_fill(vm, b);
        return;
    }
    if (mirror === 1) {
        _cga_setup_masked(vm, b, n, rec, roff, nbytes, true);
        _CGA_MASKED[g(0x8ED)](vm, b, true);
    }
}


/** Shared by the set-ups: cs:[0x4b1] = 1 when the bitmap starts inside the clip rectangle at
 * x & 3 != 0, cs:[0x4b2] = 1 when it also ends inside it (then one byte less in cs:[0x8e9]);
 * each adds `step` to the source row skip cs:[0x8e3]. */
export function _cga_edges(vm, x, rec, step) {
    const g = (o) => vm.g16(o), sg = (o, v) => vm.sg16(o, v);
    vm.sg8(0x4B1, 0);
    vm.sg8(0x4B2, 0);
    const shift = x & 3;
    sg(0x8ED, shift);
    if (shift) {
        if (s16(x) > s16(g(0x4BD))) {
            vm.sg8(0x4B1, 1);
            sg(0x8E3, g(0x8E3) + step);
        }
        if (s16(u16(x + vm.mem.r16(rec + 2))) < s16(g(0x4C1))) {
            vm.sg8(0x4B2, 1);
            sg(0x8E9, g(0x8E9) - 1);
            sg(0x8E3, g(0x8E3) + step);
        }
    }
    sg(0x3A3, u16(g(0x4AF) - g(0x4AB) + 1));
}


/** 0xc2fc (and type 1) / 0xc3e4 (mirrored): source pointer and row skip of a masked bitmap
 * (one word per 4 pixels). */
export function _cga_setup_masked(vm, b, n, rec, roff, nbytes, mirror) {
    const g = (o) => vm.g16(o), sg = (o, v) => vm.sg16(o, v), mem = vm.mem;
    const w1 = mem.r16(rec + 2);
    const x = mem.r16(n + 0xC), y = mem.r16(n + 0xE);
    sg(0x8E3, u16((u16((u16(w1 + 1) >> 2) - nbytes) << 1) - 2));
    _cga_edges(vm, x, rec, 2);
    let si = roff;
    let ax = u16(u16(g(0x4AB) - y) * (u16(w1 + 1) >> 1));
    if (!mirror) {
        ax = u16(ax + (u16(g(0x4A9) - x) >> 1));
        if (!(ax & 0x8000)) si = u16(si + (ax & 0xFFFE));
        si = u16(si + 6);
    } else {
        ax = u16(ax + (u16(u16(x + w1 - g(0x4AD)) & 0xFFFC) >> 1));
        if (!(ax & 0x8000)) si = u16(si + ax);
        si = u16(si + 6);
        if (vm.g8(0x4B1) === 0) si = u16(si + 2);
        si = u16(si + u16(g(0x8E9) << 1) - 2);
        sg(0x8E3, u16(-g(0x8E3) + 2 * g(0x8F9)));
    }
    b.si = si;
    b.di = g(0x8F1);
}


/** 0xc4ff / 0xc5cc (mirrored): the same for an opaque bitmap (one byte per 4 pixels). */
export function _cga_setup_opaque(vm, b, n, rec, roff, nbytes, mirror) {
    const g = (o) => vm.g16(o), sg = (o, v) => vm.sg16(o, v), mem = vm.mem;
    const w1 = mem.r16(rec + 2);
    const x = mem.r16(n + 0xC), y = mem.r16(n + 0xE);
    sg(0x8E3, u16((u16(w1 + 1) >> 2) - nbytes - 1));
    _cga_edges(vm, x, rec, 1);
    let si = roff;
    let ax = u16(u16(g(0x4AB) - y) * (u16(w1 + 1) >> 1));
    if (!mirror) {
        ax = u16(ax + (u16(g(0x4A9) - x) >> 1));
        if (!(ax & 0x8000)) si = u16(si + (ax >> 1));
        si = u16(si + 6);
    } else {
        ax = u16(ax + (u16(u16(x + w1 - g(0x4AD)) & 0xFFFC) >> 1));
        if (!(ax & 0x8000)) si = u16(si + (ax >> 1));
        si = u16(si + 6);
        if (vm.g8(0x4B1) === 0) si = u16(si + 1);
        si = u16(si - 1 + g(0x8E9));
        sg(0x8E3, u16(-g(0x8E3) + g(0x8F9)));
    }
    b.si = si;
    b.di = g(0x8F1);
}


/** 0xca7a / 0xcab4 (mirrored): masked bitmap at x & 3 == 0: dest = dest AND mask OR pixels,
 * a word per byte (mirrored: read backwards, both bytes through the reversal table). */
export function _cga_masked0(vm, b, mirror) {
    if (!mirror) {
        vm.sg16(0x8E3, vm.g16(0x8E3) + 2);
    } else {
        vm.sg16(0x8E3, vm.g16(0x8E3) - 2);
        b.si = u16(b.si - 2);
        b.down = true;
    }
    for (;;) {
        const count = vm.g16(0x8E9);
        for (let i = 0; i < count; i++) {
            const w = b.lodsw();
            const mask = w & 0xFF, pix = w >> 8;
            if (mirror) b.stosb((b.rev(mask) & b.dest()) | b.rev(pix));
            else b.stosb((mask & b.dest()) | pix);
        }
        if (b.row_done()) return;
        b.next_row(0x8E3);
    }
}


/** 0xc6c8, 0xc732, 0xc7ac / 0xc837, 0xc8e8, 0xc9a9 (mirrored): masked bitmap at x & 3 = 1, 2,
 * 3: each byte is made of two neighbouring words shifted by 2 * (x & 3) bits; the left edge
 * byte (cs:[0x4b1]) starts from a transparent word, the right edge byte (cs:[0x4b2]) ends
 * with one. The mirrored forms read backwards (word saved in cs:[0x395]) and reverse the
 * pixels of each finished byte. */
export function _cga_masked_shift(vm, b, mirror) {
    const k = 2 * vm.g16(0x8ED);
    for (;;) {
        const cx = vm.g16(0x8E9);
        b.down = mirror;
        let prev = b.lodsw();
        if (cx) {
            if (vm.g8(0x4B1)) {
                prev = 0x00FF;
                b.si = u16(mirror ? b.si + 2 : b.si - 2);
            }
            for (let i = 0; i < cx; i++) {
                const cur = b.lodsw();
                if (mirror) vm.sg16(0x395, cur);
                b.stosb(_cga_merge(b, cur, prev, k, mirror));
                prev = cur;
            }
        }
        if (vm.g8(0x4B2)) b.stosb(_cga_merge(b, 0x00FF, prev, k, mirror));
        if (b.row_done()) {
            b.down = false;
            return;
        }
        b.next_row(0x8E3);
    }
}


/** One destination byte from two (mask, pixels) words. */
export function _cga_merge(b, cur, prev, k, mirror) {
    const cm = cur & 0xFF, cp = cur >> 8;
    const pm = prev & 0xFF, pp = prev >> 8;
    if (!mirror) {
        const mask = ((pm << 8 | cm) >> k) & 0xFF;
        const pix = ((pp << 8 | cp) >> k) & 0xFF;
        return (mask & b.dest()) | pix;
    }
    const mask = (((cm << 8 | pm) << k) >> 8) & 0xFF;
    const pix = (((cp << 8 | pp) << k) >> 8) & 0xFF;
    return (b.rev(mask) & b.dest()) | b.rev(pix);
}


/** 0xce0b / 0xce52 (mirrored): opaque bitmap at x & 3 == 0: a byte copy. Unmirrored it
 * copies a first byte alone when DI is odd, then words, then one more byte when cs:[0x8e9]
 * is odd (so an odd DI gives one byte too few or too many). */
export function _cga_opaque0(vm, b, mirror) {
    const m = b.m;
    if (!mirror) {
        vm.sg16(0x8E3, vm.g16(0x8E3) + 1);
        const movsb = () => {
            m[b.dst + b.di] = m[b.src + b.si];
            b.si = u16(b.si + 1);
            b.di = u16(b.di + 1);
        };
        for (;;) {
            let cx = vm.g16(0x8E9);
            if (cx) {
                if (b.di & 1) {
                    movsb();
                    cx = u16(cx - 1);
                }
                const words = 2 * (cx >> 1);
                for (let i = 0; i < words; i++) movsb();
                if (vm.g16(0x8E9) & 1) movsb();
            }
            if (b.row_done()) return;
            b.next_row(0x8E3);
        }
    }
    vm.sg16(0x8E3, vm.g16(0x8E3) - 1);
    b.si = u16(b.si - 1);
    b.down = true;
    for (;;) {
        const count = vm.g16(0x8E9);
        for (let i = 0; i < count; i++) b.stosb(b.rev(b.lodsb()));
        if (b.row_done()) {
            b.down = false;
            return;
        }
        b.next_row(0x8E3);
    }
}


/** 0xcb08, 0xcb6d, 0xcbde / 0xcc5b, 0xccdf, 0xcd6f (mirrored): opaque bitmap at x & 3 = 1, 2,
 * 3: bytes shifted by 2 * (x & 3) bits; the edge bytes keep the pixels of the destination
 * outside the bitmap. */
export function _cga_opaque_shift(vm, b, mirror) {
    const k = 2 * vm.g16(0x8ED);
    const keep_left = (0xFF << (8 - k)) & 0xFF;
    const keep_right = 0xFF >> k;
    for (;;) {
        let cx = vm.g16(0x8E9);
        b.down = mirror;
        let al = b.lodsb();
        if (mirror) al = b.rev(al);
        let ah = al;
        if (cx) {
            let first = true;
            while (cx) {
                if (first && vm.g8(0x4B1)) {
                    b.stosb((b.dest() & keep_left) | (al >> k));
                } else {
                    al = b.lodsb();
                    if (mirror) al = b.rev(al);
                    b.stosb(((ah << 8 | al) >> k) & 0xFF);
                    ah = al;
                }
                first = false;
                cx -= 1;
            }
        }
        if (vm.g8(0x4B2)) b.stosb((b.dest() & keep_right) | ((ah << 8) >> k & 0xFF));
        if (b.row_done()) {
            b.down = false;
            return;
        }
        b.next_row(0x8E3);
    }
}


/** 0xce96: solid rectangle of the colour byte cs:[0x4b6]. The edge bytes are merged with
 * the destination (masks cs:[0x4b7] / [0x4b8], colours [0x4b9] / [0x4ba]) when the rectangle
 * ends inside a byte and inside the redraw rectangle cs:[0x497..0x49b] (not the clip
 * rectangle); cs:[0x8e9] middle bytes, row skip cs:[0x8e5]. */
export function _cga_fill(vm, b) {
    const g = (o) => vm.g16(o), sg = (o, v) => vm.sg16(o, v);
    const left = g(0x4A9), right = g(0x4AD);
    vm.sg8(0x4B1, s16(left) > s16(g(0x497)) && (left & 3) ? 1 : 0);
    vm.sg8(0x4B2, s16(right) < s16(g(0x49B)) && (right & 3) !== 3 ? 1 : 0);
    const colour = vm.g8(0x4B6);
    let al = (0xFF00 >> ((left & 3) << 1)) & 0xFF;
    vm.sg8(0x4B7, al);
    vm.sg8(0x4B9, ~al & colour);
    al = (0xFF >> (((right & 3) + 1) << 1)) & 0xFF;
    vm.sg8(0x4B8, al);
    vm.sg8(0x4BA, ~al & colour);
    sg(0x8E5, 0x50);
    const width = u16(right - left + 1);
    sg(0x8EB, width);
    sg(0x8E9, width >> 2);
    let l1 = vm.g8(0x4B1), r1 = vm.g8(0x4B2);
    if (!(s16(g(0x8E9)) > 0)) {
        if (!l1) {
            if (!r1) return;
            sg(0x8E5, g(0x8E5) - 1);
        } else if (!r1) {
            sg(0x8E5, g(0x8E5) - 1);
        } else if (u16((right >> 2) - (left >> 2))) {
            sg(0x8E5, g(0x8E5) - 2);
        } else {
            sg(0x8E5, g(0x8E5) - 1);
            const a = ~vm.g8(0x4B7) & ~vm.g8(0x4B8) & 0xFF;
            vm.sg8(0x4BA, colour & a);
            vm.sg8(0x4B8, ~a & 0xFF);
            vm.sg8(0x4B1, 0);
        }
    } else {
        sg(0x8E5, g(0x8E5) - g(0x8E9));
        if (!l1) {
            if (r1) sg(0x8E5, g(0x8E5) - 1);
        } else if (!r1) {
            sg(0x8E5, g(0x8E5) - 1);
        } else {
            const ah = (4 - (left & 3)) & 3;
            vm.sg8(0xC164, ah);
            if (((((right & 3) + 1) & 3) + ah) > 3) {
                sg(0x8E9, g(0x8E9) - 1);
                sg(0x8E5, g(0x8E5) + 1);
            }
            sg(0x8E5, g(0x8E5) - 2);
        }
    }
    l1 = vm.g8(0x4B1);
    r1 = vm.g8(0x4B2);
    let rows = g(0x3A3);
    for (;;) {
        if (l1) b.stosb((vm.g8(0x4B7) & b.dest()) | vm.g8(0x4B9));
        const count = g(0x8E9);
        for (let i = 0; i < count; i++) b.stosb(colour);
        if (r1) b.stosb((vm.g8(0x4B8) & b.dest()) | vm.g8(0x4BA));
        rows = u16(rows - 1);
        if (rows === 0) return;
        b.di = cga_next_row(b.di, g(0x8E5));
    }
}


// --------------------------------------------------------------------------- palette
/** 6-bit attribute value -> [r, g, b] as an EGA monitor shows it in the 200-line modes (bits 0-2
 * blue, green, red; bit 4 intensity; colour 6 brown). */
export function ega_rgb(value) {
    const i = value & 0x10 ? 0x55 : 0;
    const r = (value & 4 ? 0xAA : 0) + i, b = (value & 1 ? 0xAA : 0) + i;
    let g = (value & 2 ? 0xAA : 0) + i;
    if ((value & 0x17) === 0x06) g = 0x55;
    return [r, g, b];
}


/** 0x94b4: the 16 attribute-controller values computed from 16 palette words (byte 0 red,
 * byte 1 green << 4 | blue, levels 0-7): any red -> 4, green -> 2, blue -> 1, a level of 4 or
 * more in any of them -> intensity 0x10; 0x111 / 0x222 -> 0x10 (dark grey), 0x444 -> 7,
 * 0x420 -> 6 (brown). At the EGA mode set the words come from the table cs:0x9494. */
export function ega_attributes(mem, table = EGA_PALETTE_TABLE) {
    const out = [];
    for (let i = 0; i < 16; i++) {
        const b0 = mem.r8(CS + table + 2 * i);
        const b1 = mem.r8(CS + table + 2 * i + 1);
        const ax = b0 << 8 | b1;
        const ah = b0, al = b1;
        let ch = 0;
        if (ah & 7) ch |= 4;
        if (ah & 4) ch |= 0x10;
        if (al & 0x70) ch |= 2;
        if (al & 0x40) ch |= 0x10;
        if (al & 7) ch |= 1;
        if (al & 4) ch |= 0x10;
        if (ax === 0x111 || ax === 0x222) ch = 0x10;
        if (ax === 0x444) ch = 7;
        if (ax === 0x420) ch = 6;
        out.push(ch);
    }
    return out;
}


/** A palette word (byte 0 red, byte 1 green << 4 | blue, levels 0-7) as the VGA DAC shows
 * it (0x9592: level * 8 into the 6-bit DAC): [r, g, b]. */
export function vga_rgb(b0, b1) {
    return [b0 & 7, (b1 >> 4) & 7, b1 & 7].map((level) => Math.floor(((level * 8) * 255 + 31) / 63));
}


/** The 16 displayed colours: a Uint8Array(48), r, g, b of each colour in turn.
 *
 * EGA (cs:[0x423] = 0): the attribute registers programmed once at the mode set from the
 * table cs:0x9494 (0x94b4); the game never changes them (0x4a28 returns at once). VGA
 * (cs:[0x423] = 1): the DAC, programmed from cs:0x9494 at the mode set and from the palette
 * cs:[0x5a9] (16 words) whenever the game sends it (0x4a6a: a palette record shown, statements
 * 0x69 and 0xbc). `dac` is the last palette sent (vm.dac, kept by ops_view.program_palette);
 * an all-black palette is a real state (the game blacks the screen out while it changes
 * rooms). Without `dac` (rendering from memory alone) cs:[0x5a9] is used, and an all-zero
 * cs:[0x5a9] is taken to mean that nothing has been sent since the mode set. */
export function palette(mem, dac = null) {
    const out = new Uint8Array(48);
    if (mem.r8(CS + 0x423) === 1) {
        let words = dac;
        if (words == null) {
            words = mem.m.slice(CS + 0x5A9, CS + 0x5A9 + 32);
            if (!words.some((v) => v)) words = mem.m.slice(CS + EGA_PALETTE_TABLE, CS + EGA_PALETTE_TABLE + 32);
        }
        for (let i = 0; i < 16; i++) {
            if (2 * i + 1 >= words.length) throw new IndexError('the palette holds fewer than 16 colours');
            out.set(vga_rgb(words[2 * i], words[2 * i + 1]), 3 * i);
        }
        return out;
    }
    const attrs = ega_attributes(mem);
    for (let i = 0; i < 16; i++) out.set(ega_rgb(attrs[i]), 3 * i);
    return out;
}


// --------------------------------------------------------------------------- the renderer
/** A throw-away copy of the memory with the VM accessors the drawing routines use. */
export class _Scratch {
    constructor(image) {
        this.mem = new Memory(image instanceof Memory ? image.m : image);
    }

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
}


/** [handle, view offset] of the views in list order (cs:[0x493], link V+4). */
export function views(mem, es = null) {
    es = es == null ? cs_es(mem) : es;
    const out = [];
    let h = mem.r16(CS + 0x493);
    while (h && out.length < 64) {
        const v = u16(mem.r16(CS + 0x473) + h);
        out.push([h, v]);
        h = mem.r16(es * 16 + u16(v + 4));
    }
    return out;
}


/** Segment of MAIN's record (cs:[0x475]), where the view records live. */
export function cs_es(mem) {
    return mem.r16(CS + 0x475);
}


/** [window node, display nodes] of a view in drawing order (from its window node V+2, link +6). */
export function view_nodes(mem, view, es = null) {
    es = es == null ? cs_es(mem) : es;
    const pseg = mem.r16(CS + 0x461) * 16;
    const out = [];
    let n = mem.r16(es * 16 + u16(view + 2));
    const head = n;
    while (n && out.length < 4096) {
        n = mem.r16(pseg + u16(n + 6));
        if (n) out.push(n);
    }
    return [head, out];
}


/** Compose the screen from a memory image (Uint8Array or Memory) the way the frame end draws
 * it, as if every view were redrawn whole: for every view not hidden (flag bit 6), in list
 * order, its window (window node +0xc, +0xe, +0x16, +0x18) is cleared to colour 0 unless mode
 * bit 6 is set (0x9709 / 0xd12c), its nodes are drawn far to near (nodes with a negative state,
 * mirror byte +0x22 or depth are skipped) clipped to the window (0x9886 / 0xc199), and unless
 * mode bit 5 is set the work page is copied to the displayed page (0x9772: XOR 0x0d on EGA;
 * 0xd074 on CGA) where the original's redraws have copied it: the rectangle of every drawn
 * node, widened to 16-pixel columns and clipped to the window as 0x3872 does (`whole_windows`:
 * the whole window instead).
 *
 * `work`, `display`: optional initial work and displayed pages (64000 colour indices, row by
 * row), for what the original keeps from earlier frames (windows of mode bit 6 are never
 * cleared; parts of the screen outside every window are never copied). By default both start as
 * the BIOS mode set leaves them, all colour 0. A running interpreter gets the exact pages from
 * frame_end() instead (EGA: vm.video.page(0); CGA: the page at B800 in its memory, cga_page()).
 *
 * Returns [indices (Uint8Array(64000)) as displayed, palette (Uint8Array(48)) RGB]. On the CGA
 * path (cs:[0x422] = 0) the indices are 0-3 and the palette's first four colours are CGA palette
 * `cga_palette` (0 green / red / yellow, 1 cyan / magenta / white, high intensity): the game
 * chooses it with statement 0x68 (0xc166, interrupt 0x10 AH = 0x0b) and keeps no copy. */
export function render(image, es = null, work = null, display = null, whole_windows = false, cga_palette = 1) {
    const vm = new _Scratch(image);
    const mem = vm.mem;
    es = es == null ? cs_es(mem) : es;
    const cga = vm.g8(0x422) === 0;
    let video, clear, draw, copy;
    if (cga) {
        video = new CGAVideo();
        const work_seg = vm.g16(0x3FF) * 16;
        set_cga_page(mem, work_seg, work != null ? work : new Uint8Array(64000));
        set_cga_page(mem, 0xB8000, display != null ? display : new Uint8Array(64000));
        vm.sg16(0x665, vm.g16(0x3FD));
        vm.sg16(0x667, vm.g16(0x3FF));
        [clear, draw, copy] = [cga_clear, cga_draw, cga_copy_to_screen];
    } else {
        video = new EGAVideo();
        if (work != null) video.page(PAGE_WORK).set(work);
        if (display != null) video.page(PAGE_DISPLAY).set(display);
        vm.sg16(0x667, PAGE_WORK);
        [clear, draw, copy] = [ega_clear, ega_draw, ega_copy_to_screen];
    }
    const pseg = vm.g16(0x461) * 16;

    const redraw_rect = (r) => {
        const offs = [0x497, 0x499, 0x49B, 0x49D];
        for (let i = 0; i < 4; i++) vm.sg16(offs[i], r[i]);
        vm.sg16(0x49F, u16(r[2] - r[0] + 1) >> 3);
    };

    for (const [, v] of views(mem, es)) {
        const flags = mem.r8(es * 16 + v), mode = mem.r8(es * 16 + u16(v + 1));
        if (flags & 0x40) continue;
        const [head, nodes] = view_nodes(mem, v, es);
        if (!head) continue;
        const window = [0xC, 0xE, 0x16, 0x18].map((o) => mem.r16(pseg + head + o));
        const clip = [0x4BD, 0x4BF, 0x4C1, 0x4C3];
        for (let i = 0; i < 4; i++) vm.sg16(clip[i], window[i]);
        redraw_rect(window);
        if (!(mode & 0x40)) clear(vm, video);
        const rects = [];
        for (const n of nodes) {
            const a = pseg + n;
            if (mem.r8(a) & 0x80 || mem.r8(a + 0x22) & 0x80 || mem.r16(a + 0x10) & 0x8000) continue;
            draw(vm, video, n);
            rects.push(_node_rect(mem, a, window));
        }
        if (mode & 0x20) continue;
        for (const r of whole_windows ? [window] : rects.filter((r) => r)) {
            redraw_rect(r);
            copy(vm, video);
        }
    }
    if (cga) return [cga_page(mem, 0xB8000), cga_rgb(cga_palette)];
    return [video.page(PAGE_DISPLAY).slice(), palette(mem)];
}


/** Colour indices (Uint8Array(64000), 200 rows of 320) of a CGA-layout page at linear address
 * `base`. */
export function cga_page(mem, base = 0xB8000) {
    const m = mem.m;
    const out = new Uint8Array(64000);
    for (let y = 0; y < 200; y++) {
        const row = base + (y & 1 ? 0x2000 : 0) + 80 * (y >> 1);
        for (let c = 0; c < 80; c++) {
            const byte = m[row + c];
            const o = 320 * y + 4 * c;
            out[o] = (byte >> 6) & 3;
            out[o + 1] = (byte >> 4) & 3;
            out[o + 2] = (byte >> 2) & 3;
            out[o + 3] = byte & 3;
        }
    }
    return out;
}


/** Store colour indices (64000, 200 rows of 320) as a CGA-layout page at linear address `base`. */
export function set_cga_page(mem, base, indices) {
    const m = mem.m;
    for (let y = 0; y < 200; y++) {
        const row = base + (y & 1 ? 0x2000 : 0) + 80 * (y >> 1);
        for (let c = 0; c < 80; c++) {
            const o = 320 * y + 4 * c;
            m[row + c] = (indices[o] & 3) << 6 | (indices[o + 1] & 3) << 4 | (indices[o + 2] & 3) << 2 | (indices[o + 3] & 3);
        }
    }
}


/** CGA mode 4 colours, high intensity: black background, then palette 0 (light green,
 * light red, yellow) or palette 1 (light cyan, light magenta, white); padded to 16 colours
 * (Uint8Array(48)). */
export function cga_rgb(which = 1) {
    const fg = which === 0 ? [0x55, 0xFF, 0x55, 0xFF, 0x55, 0x55, 0xFF, 0xFF, 0x55]
        : [0x55, 0xFF, 0xFF, 0xFF, 0x55, 0xFF, 0xFF, 0xFF, 0xFF];
    const out = new Uint8Array(48);
    out.set(fg, 3);
    return out;
}


/** The redraw rectangle of a node as 0x3872 computes it (none when outside the window). */
export function _node_rect(mem, a, window) {
    const [rseg, roff] = follow(mem, mem.r16(a + 0xA), mem.r16(a + 8));
    const rec = rseg * 16 + roff;
    const x0 = mem.r16(a + 0xC), y0 = mem.r16(a + 0xE);
    const x1 = u16(x0 + mem.r16(rec + 2)), y1 = u16(y0 + mem.r16(rec + 4));
    const [wl, wt, wr, wb] = window.map(s16);
    if (s16(x0) > wr || s16(y0) > wb || s16(x1) < wl || s16(y1) < wt) return null;
    return [Math.max(s16(x0 & 0xFFF0), wl), Math.max(s16(y0), wt), Math.min(s16(x1 | 0xF), wr), Math.min(s16(y1), wb)];
}


/** RGB of colour indices: Uint8Array(3 * indices.length), r, g, b per pixel. */
export function to_rgb(indices, pal) {
    const out = new Uint8Array(3 * indices.length);
    for (let i = 0; i < indices.length; i++) {
        const c = 3 * indices[i];
        if (c + 2 >= pal.length) throw new IndexError(`colour index ${indices[i]} outside a palette of ${pal.length / 3} colours`);
        out[3 * i] = pal[c];
        out[3 * i + 1] = pal[c + 1];
        out[3 * i + 2] = pal[c + 2];
    }
    return out;
}

register_module('render', render_module);
