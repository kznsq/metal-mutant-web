/**
 * The game's interrupt handlers: what they do to memory between and during script passes.
 *
 * - `timer_tick(vm_or_memory)`: the 50 Hz timer interrupt 0x70e1 (installed by 0x765d). It counts
 *   frames in cs:[0x513], picks the loudest tone channel, advances the three tone channel records
 *   (duration, volume and pitch slides), lets the EGA/VGA mouse pointer follow the mouse, and calls
 *   the BIOS timer handler every cs:[0x511] ticks.
 * - `key_event(memory, scancode, down)`: the keyboard interrupt 0x78b6 (installed by 0x787f). It
 *   keeps the held-keys array cs:[0x68b + scancode - 1] and the last translated key cs:[0x689], and
 *   empties the BIOS keyboard buffer.
 * - `sample_tick(vm_or_memory)`: one interrupt of the PC-speaker sample player, the copy of
 *   0x8b4e..0x8bb7 that 0x8bdf places over the first 0x6a bytes of a playing sample and points the
 *   timer vector at (ops_io.speaker_play). The timer then runs at the sample rate (about 21.7 kHz);
 *   the copy keeps its state inside its own code and chains to 0x70e1 at about 50 Hz.
 * - `calibration_tick(vm)`: the one-shot handler 0x85ab used by the start-up's timer calibration.
 *
 * `dispatch_timer(vm_or_memory)` runs whatever handler the timer vector (0000:0020) points at, as
 * the hardware does, and returns whether the interrupt is then passed on to the BIOS timer
 * handler; `bios_timer(vm_or_memory)` is that handler's effect on memory (the tick count the
 * scripts use as a random seed). Port input/output is left out: what the handlers send to the PC
 * speaker, the timer chip, the sound device and the interrupt controller has no effect on memory.
 * The BIOS keyboard handler the game chains to is not modelled.
 *
 * "vm_or_memory": a VM, a Memory or a Uint8Array of the whole memory image (memory_of).
 */
import * as interrupts from './interrupts.js';
import * as ops_io from './ops_io.js';
import { CS, Memory, NotImplementedError, EngineTypeError, VM, hex, register_module } from './vm.js';

export const CODE_SEG = CS >> 4;
export const CHANNELS = [[0x8FF, 0], [0x90D, 1], [0x91B, 2]];   // tone channel record, channel number
export const TIMER_HANDLER = 0x70E1;
export const CALIBRATION_HANDLER = 0x85AB;
export const KEYBOARD_HANDLER = 0x78B6;
export const KEY_TABLE = 0x78B;
export const HELD_KEYS = 0x68B;
export const LAST_KEY = 0x689;
export const PLAYER_TICK_RELOAD = 0x5D2A;                       // the player's tick counter restarts here


export function u16(v) {
    return v & 0xFFFF;
}

export function s8(v) {
    v &= 0xFF;
    return v >= 128 ? v - 256 : v;
}

/** A Memory that works on the same bytes as `x` (a VM, a Memory or a Uint8Array). */
export function memory_of(x) {
    if (x instanceof VM) return x.mem;
    if (x instanceof Memory) return x;
    if (x instanceof Uint8Array) return Memory.wrap(x);
    throw new EngineTypeError('expected a VM, a Memory or a Uint8Array');
}

/** cs:[...] access on a Memory. */
export class _Globals {
    constructor(mem) {
        this.mem = mem;
    }

    g8(o) {
        return this.mem.r8(CS + u16(o));
    }

    g16(o) {
        return this.mem.r16(CS + u16(o));
    }

    sg8(o, v) {
        this.mem.w8(CS + u16(o), v);
    }

    sg16(o, v) {
        this.mem.w16(CS + u16(o), v);
    }
}

/** [segment, offset] of interrupt 8 in the interrupt vector table. */
export function timer_vector(mem) {
    return [mem.r16(0x22), mem.r16(0x20)];
}


// --------------------------------------------------------------------- timer interrupt 0x70e1
/** Code 0x70e1, one 50 Hz timer interrupt. Returns true when the original passes the
 * interrupt on to the BIOS timer handler (far cs:[0x529]) instead of ending it itself. */
export function timer_tick(x) {
    const vm = x instanceof VM ? x : null;
    const g = new _Globals(memory_of(x));
    const count = (g.g8(0x513) + 1) & 0xFF;           // frame counter; stops at 0xff, no wrap
    g.sg8(0x513, count ? count : 0xFF);
    // cs:[0x542] set: call 0x8903, the music driver entry, a bare RET in this version of the game
    loudest_channel(g);
    for (const [di, n] of CHANNELS) {
        const state = g.g8(di);
        if (state && !(state & 0x80)) channel_step(g, di, n);
    }
    pointer_follow(g, vm);
    const left = (g.g8(0x510) - 1) & 0xFF;
    g.sg8(0x510, left);
    if (left) return false;
    g.sg8(0x510, g.g8(0x511));
    return g.g8(0x542) === 0;
}

/** Code 0x7171: cs:[0x541] = the channel whose priority byte (+1) is highest (signed; the
 * first of equals). The third channel is compared with the first one's priority unless the
 * second one won. */
export function loudest_channel(g) {
    let best = g.g8(0x900);
    g.sg8(0x541, 0);
    if (s8(best) < s8(g.g8(0x90E))) {
        best = g.g8(0x90E);
        g.sg8(0x541, 1);
    }
    if (s8(best) < s8(g.g8(0x91C))) g.sg8(0x541, 2);
}

/** Code 0x719c for a playing channel record at cs:di: the duration word +4 counts down; the
 * volume word +6 moves by the step +8 and the pitch word +0xa by the step +0xc. The channel
 * stops (state, priority, mode, volume and pitch cleared) when the duration runs out or either
 * sum turns negative (the clamp of the volume to 0x7fff at 0x71ae can never act on a sum that
 * is not negative). Then the output routine 0x8950 runs for it. */
export function channel_step(g, di, n) {
    const dur = u16(g.g16(di + 4) - 1);
    g.sg16(di + 4, dur);
    let stop = dur === 0;
    if (!stop) {
        const vol = u16(g.g16(di + 6) + g.g16(di + 8));
        if (vol & 0x8000) {
            stop = true;
        } else {
            g.sg16(di + 6, vol);
            const pitch = u16(g.g16(di + 0xA) + g.g16(di + 0xC));
            if (pitch & 0x8000) {
                stop = true;
            } else {
                g.sg16(di + 0xA, pitch);
            }
        }
    }
    if (stop) {
        g.sg16(di + 6, 0);
        g.sg16(di + 0xA, 0);
        g.sg8(di + 1, 0);
        g.sg8(di + 2, 0);
        g.sg8(di, 0);
    }
    channel_output(g, di, n);
}

/** Code 0x8950: when no sample plays (cs:[0x574] clear) and this is the loudest channel
 * (cs:[0x541]), send volume, pitch and on/off to the sound hardware. The PC-speaker path only
 * writes ports (0x61, 0x42, 0x43; 0x89ed reads port 0x41 for its noise). The sound-device path
 * (cs:[0x87e0] set) remembers what it last sent: 0x8d78 the volume byte +7 in cs:[0x8d76],
 * 0x8d9d the pitch word +0xa / 8 in cs:[0x8d74], 0x8de3 the mode byte +2 in cs:[0x8d77]
 * (switching off also forgets the other two: 0xff, 0xffff). */
export function channel_output(g, di, n) {
    if (g.g8(0x574) || n !== g.g8(0x541)) return;
    if (!g.g8(0x87E0)) return;
    const volume = g.g8(di + 7);
    if (volume !== g.g8(0x8D76)) g.sg8(0x8D76, volume);
    const pitch = g.g16(di + 0xA) >> 3;
    if (pitch !== g.g16(0x8D74)) g.sg16(0x8D74, pitch);
    const mode = g.g8(di + 2);
    if (mode !== g.g8(0x8D77)) {
        g.sg8(0x8D77, mode);
        if (mode === 0) {
            g.sg8(0x8D76, 0xFF);
            g.sg16(0x8D74, 0xFFFF);
        }
    }
}

/** Code 0x7a82: [x, y, buttons] from the mouse driver (INT 33h AX=3) in screen units, or
 * [-1, -1, -1] without a driver (cs:[0x51c] set). */
export function mouse_position(g, vm) {
    if (g.g8(0x51C)) return [0xFFFF, 0xFFFF, 0xFFFF];
    let [x, y, buttons] = vm != null ? ops_io.mouse_registers(vm) : [0, 0, 0];
    if (g.g8(0x422) !== 1) x >>= 1;
    if (g.g8(0x422) === 0) {
        x = u16(x + 1);
        y = u16(y + 1);
    }
    return [x, y, buttons];
}

/** Code 0x549d: on EGA/VGA (cs:[0x422] set) with the software pointer shown (cs:[0x46c] not
 * negative), cs:[0x46d] is raised by one for the duration of the call; when that wraps it to 0
 * (cs:[0x46d] = 0xff: the pointer may be redrawn) and the mouse moved away from cs:[0x51f],
 * cs:[0x521], the pointer is removed (0xbfe6), the new position stored and the pointer drawn
 * again (0xbf28). Removing and drawing are the renderer's: they run through `vm.pointer_hide()`
 * and `vm.pointer_show()` when the VM provides them. */
export function pointer_follow(g, vm) {
    if (g.g8(0x422) === 0 || g.g8(0x46C) & 0x80) return;
    g.sg8(0x46D, g.g8(0x46D) + 1);
    if (g.g8(0x46D) === 0) {
        const [x, y] = mouse_position(g, vm);
        if (x !== g.g16(0x51F) || y !== g.g16(0x521)) {
            const hide = vm == null ? null : vm.pointer_hide ?? null;
            if (hide) hide();
            g.sg16(0x51F, x);
            g.sg16(0x521, y);
            const show = vm == null ? null : vm.pointer_show ?? null;
            if (show) show();
        }
    }
    g.sg8(0x46D, g.g8(0x46D) - 1);
}


// --------------------------------------------------------------------- timer calibration 0x85ab
/** Code 0x85ab: latch timer channel 0 and store its count in cs:[0x527] (low byte read
 * first), then chain to the BIOS timer handler. The count comes from ops_io.pit_byte. */
export function calibration_tick(vm) {
    const low = ops_io.pit_byte(vm);
    vm.sg16(0x527, low | ops_io.pit_byte(vm) << 8);
    return true;
}


// --------------------------------------------------------------------- PC-speaker sample player
/** One interrupt of the sample player copied to seg:p, the timer vector (0x8b4e..0x8bb7 as
 * patched by 0x8bdf; offsets below are relative to p, the code addresses itself through cs).
 *
 * Word p+2 holds the output byte (low, sent to timer channel 2) and the rate pattern (high).
 * Each interrupt rotates the pattern left; when the bit rotated out is 0 the pattern is stored
 * back (p+3), else the next sample byte at the data pointer p+0xc is fetched into p+2 with the
 * rotated pattern and the pointer advances. A zero byte ends one playing: the pointer goes
 * back to the data start (p+0x80) and the repeat word p+0x60 counts down; at 0 the player
 * jumps to 0x8cf5 (stop: 0x8af9 restores the game's timer vector and divisor, clears
 * cs:[0x574], cs:[0x575], cs:[0x87e3]); a negative count is set back (endless). After the
 * interrupt controller is acknowledged the word p+0x66 drops by p+0x64; when that borrows it
 * restarts at 0x5d2a and the game's timer handler 0x70e1 runs (about 50 times a second).
 * Returns 'play', 'stopped', 'tick' (0x70e1 ran and ended the interrupt) or 'tick+bios'
 * (0x70e1 ran and passed it on to the BIOS timer handler). */
export function sample_tick(x) {
    const mem = memory_of(x);
    const [seg, p] = timer_vector(mem);
    const base = seg * 16;

    function r16(k) {
        return mem.r16(base + u16(p + k));
    }

    function w16(k, v) {
        mem.w16(base + u16(p + k), v);
    }

    const word = r16(2);
    let pattern = word >> 8;
    const carry = pattern >> 7;
    pattern = (pattern << 1 | carry) & 0xFF;
    if (!carry) {
        mem.w8(base + u16(p + 3), pattern);
    } else {
        const ptr = r16(0xC);
        const value = mem.r8(base + ptr);
        if (value) {
            w16(2, value | pattern << 8);
            w16(0xC, ptr + 1);
        } else {
            w16(0xC, p + 0x80);
            const count = u16(r16(0x60) - 1);
            w16(0x60, count);
            if (count === 0) {
                const vm = x instanceof VM ? x : new VM(mem, 0);
                ops_io.speaker_stop(vm);
                return 'stopped';
            }
            if (count & 0x8000) w16(0x60, count + 1);
        }
    }
    const step = r16(0x64), counter = r16(0x66);
    w16(0x66, counter - step);
    if (counter >= step) return 'play';
    w16(0x66, PLAYER_TICK_RELOAD);
    return timer_tick(x) ? 'tick+bios' : 'tick';
}

/** Run the handler the timer vector points at: 0x70e1, the calibration handler 0x85ab, or
 * the copied sample player. Returns true when the BIOS timer handler runs after it (see
 * bios_timer). */
export function dispatch_timer(x) {
    const mem = memory_of(x);
    const [seg, off] = timer_vector(mem);
    if (seg === CODE_SEG && off === TIMER_HANDLER) return timer_tick(x);
    if (seg === CODE_SEG && off === CALIBRATION_HANDLER) {
        const vm = x instanceof VM ? x : new VM(mem, 0);
        return calibration_tick(vm);
    }
    const g = new _Globals(mem);
    if (g.g8(0x87E3)) return sample_tick(x) === 'tick+bios';
    throw new NotImplementedError(`timer vector ${hex(seg, 4)}:${hex(off, 4)} is not a handler of the game`);
}


export const DAY_TICKS = 0x1800B0;                              // BIOS ticks in 24 hours

/** What the BIOS timer handler the game chains to does to the game's view of memory: the
 * tick count dword 0040:006c goes up by one; after 0x1800b0 ticks (24 hours) it restarts at 0
 * and the midnight flag 0040:0070 is set. (The diskette motor countdown 0040:0040 and the
 * timer-tick hook interrupt 1Ch are not modelled.) Statement 0x2a with DX = 0 seeds the random
 * generator from 0040:006c. */
export function bios_timer(x) {
    const mem = memory_of(x);
    let t = mem.r16(0x46C) + mem.r16(0x46E) * 0x10000 + 1;
    if (t >= DAY_TICKS) {
        t = 0;
        mem.w8(0x470, 1);
    }
    mem.w16(0x46C, t & 0xFFFF);
    mem.w16(0x46E, t >> 16);
}


// --------------------------------------------------------------------- keyboard interrupt 0x78b6
/** Code 0x78b6 for one byte from the keyboard controller (port 0x60): `scancode | 0x80`
 * when `down` is false. Prefix bytes are passed as they come (0xe0 with down=true is the
 * byte 0xe0, which the handler takes for the release of key 0x60).
 *
 * Press: held-keys byte cs:[0x68b + code - 1] = 1 and, for codes up to 0x70, the translated
 * key (table cs:0x78b) goes to cs:[0x689] unless it is 0xfe. Release: the held-keys byte is
 * cleared and cs:[0x689] = 0 unless the table entry is 0xfe (no range check on release: codes
 * above 0x70 index past the table). Code 0 makes the index -1 (cs:[0x68a], cs:[0x78a]). Then
 * the BIOS keyboard buffer is emptied (head word 0040:001a = tail 0040:001c) and the original
 * chains to the BIOS keyboard handler (far cs:[0x685]). */
export function key_event(x, scancode, down = true) {
    const mem = memory_of(x);
    const g = new _Globals(mem);
    const al = (down ? scancode : scancode | 0x80) & 0xFF;
    const bx = u16((al & 0x7F) - 1);
    if (!(al & 0x80)) {
        g.sg8(HELD_KEYS + bx, 1);
        if (bx < 0x70) {
            const key = g.g8(KEY_TABLE + bx);
            if (key !== 0xFE) g.sg8(LAST_KEY, key);
        }
    } else {
        g.sg8(HELD_KEYS + bx, 0);
        if (g.g8(KEY_TABLE + bx) !== 0xFE) g.sg8(LAST_KEY, 0);
    }
    mem.w16(0x41A, mem.r16(0x41C));
    return true;
}


export const SHIFT_KEYS = new Map([[0x36, 0x01], [0x2A, 0x02], [0x1D, 0x04], [0x38, 0x08]]);  // right/left Shift, Ctrl, Alt
export const LOCK_KEYS = new Map([[0x46, 0x10], [0x45, 0x20], [0x3A, 0x40], [0x52, 0x80]]);   // Scroll, Num, Caps Lock, Insert

/** The part of the BIOS keyboard handler (which 0x78b6 chains to) that the game can see: the
 * shift-state byte 0040:0017 that INT 16h AH=02h returns (expression 0x74). Shift, Ctrl and
 * Alt set their bit while held; Scroll Lock, Num Lock, Caps Lock and Insert toggle theirs on
 * each press. */
export function bios_keyboard(x, scancode, down = true) {
    const mem = memory_of(x);
    let flags = mem.r8(0x417);
    const code = scancode & 0x7F;
    if (SHIFT_KEYS.has(code)) {
        flags = down ? flags | SHIFT_KEYS.get(code) : flags & ~SHIFT_KEYS.get(code);
    } else if (LOCK_KEYS.has(code) && down) {
        flags ^= LOCK_KEYS.get(code);
    }
    mem.w8(0x417, flags & 0xFF);
}


register_module('interrupts', interrupts);
