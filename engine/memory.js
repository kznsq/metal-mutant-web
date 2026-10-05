/**
 * The machine's memory: one byte array with the original layout (the engine's code and data
 * segment at linear CS = 0x10400, object records, class files, the display segment ...).
 *
 * Addresses are linear integers. An address from 0 to size - 1 is the byte there, a negative
 * address -size .. -1 counts back from the end, any other integer raises IndexError and a
 * non-integer raises TypeError. A 16-bit access is two byte accesses (low byte first), so a word
 * write at the last byte stores its low byte before it raises IndexError.
 */
import { IndexError, EngineTypeError } from './errors.js';

export class Memory {
    /** A copy of `image` (Uint8Array, ArrayBuffer or array of byte values). */
    constructor(image) {
        if (image instanceof Uint8Array) this.m = image.slice();
        else if (image instanceof ArrayBuffer) this.m = new Uint8Array(image.slice(0));
        else this.m = Uint8Array.from(image);
    }

    /** A Memory working on the bytes of `bytes` itself (no copy). */
    static wrap(bytes) {
        const mem = Object.create(Memory.prototype);
        mem.m = bytes;
        return mem;
    }

    /** Position in this.m of linear address a, by the address rules above. */
    index(a) {
        const n = this.m.length;
        if (!Number.isInteger(a)) throw new EngineTypeError('memory address must be an integer, not ' + typeof a);
        if (a >= 0 && a < n) return a;
        if (a < 0 && a >= -n) return a + n;
        throw new IndexError('memory address out of range');
    }

    // r8 / r16 read unsigned, s8 / s16 signed, w8 / w16 write; words are little-endian. The first
    // check of each is the fast path for an address inside the image.
    r8(a) {
        if ((a >>> 0) === a && a < this.m.length) return this.m[a];
        return this.m[this.index(a)];
    }

    s8(a) {
        const v = this.r8(a);
        return v >= 128 ? v - 256 : v;
    }

    r16(a) {
        if ((a >>> 0) === a && a + 1 < this.m.length) return this.m[a] | this.m[a + 1] << 8;
        return this.r8(a) | this.r8(a + 1) << 8;
    }

    s16(a) {
        const v = this.r16(a);
        return v >= 32768 ? v - 65536 : v;
    }

    w8(a, v) {
        if ((a >>> 0) === a && a < this.m.length) this.m[a] = v & 0xFF;
        else this.m[this.index(a)] = v & 0xFF;
    }

    w16(a, v) {
        if ((a >>> 0) === a && a + 1 < this.m.length) {
            this.m[a] = v & 0xFF;
            this.m[a + 1] = (v >> 8) & 0xFF;
        } else {
            this.w8(a, v);
            this.w8(a + 1, v >> 8);
        }
    }
}
