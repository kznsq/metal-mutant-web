/**
 * Sound, files, mouse, text input and miscellaneous statements: 0x6b-0x6e, 0x70-0x78, 0x7a, 0x7b,
 * 0x81, 0x82, 0x84-0x86, 0x88, 0x95-0x98, 0x9d, 0x9e, 0xa1, 0xac, 0xae-0xb1, 0xbb, 0xbd, 0xc8,
 * 0xc9, 0xcd, 0xce, 0xd3-0xd6, 0xd8-0xda.
 *
 * Hardware and DOS are replaced as follows; every memory write of the original is kept, except
 * the drawing of the EGA/VGA software mouse pointer (see 0x84, 0x85).
 * - Sound: the request globals cs:[0x535..0x53f], the three tone channel records, the sample
 *   globals cs:[0x574..0x599], the sound slots at cs:0x4e62, the PC-speaker player that the
 *   engine copies into the sample block and the timer vector it installs are all written as the
 *   original writes them (after the data-only start-up of boot.js only the player fields the
 *   model reads, see speaker_play). Port input/output is left out and nothing is played: each
 *   start and stop is appended to `vm.sound_log` (an array of plain objects; a sample record
 *   carries the bytes the PC-speaker player plays, a Uint8Array) for an audio backend. Playback
 *   itself runs in the timer interrupt, outside the interpreter; `sample_finished(vm)` applies
 *   what the interrupt does when a sample ends.
 * - Timer channel 0 reads (`in al, 0x40`) come from `pit_byte(vm)`.
 * - Files: DOS calls work on the save directory of files.js (`save_dir()`, a copy of the game
 *   directory made on first use), so the game directory is never written. An open file is a
 *   DosFile: its bytes and a position, written back to the directory after every write, as a file
 *   flushed after every write. Handles are numbered like DOS (lowest free number from 5,
 *   `vm.dos_files`, a Map from handle to DosFile). DOS failures end in the engine's fatal error
 *   routine (0x85c2), modelled by `fatal_error`, which throws FatalError.
 * - Mouse: only the INT 33h driver calls are replaced (`mouse_registers`, `vm.mouse`). Without a
 *   mouse driver (cs:[0x51c] != 0) the original never calls the driver except in 0x88.
 * - Keyboard input (0xb0, 0xb1): the original busy-waits on the last-key variable cs:[0x689] that
 *   the keyboard interrupt writes. Here keys are taken from the key currently held (cs:[0x689]),
 *   then from the array `vm.keys`, then from the function `vm.key_source`; without a complete
 *   line the statement throws InputNeeded before changing anything.
 */
import * as ops_io from './ops_io.js';
import * as F from './ops_flow.js';
import * as files from './files.js';
import {
    CS, EngineHang, FatalError, EngineError, SKIP, floordiv, floormod, register_module, s16, statement,
} from './vm.js';

export const CODE_SEG = CS >> 4;


export function u16(v) {
    return v & 0xFFFF;
}

export function sx8(v) {
    v &= 0xFF;
    return v >= 128 ? v - 256 : v;
}

export function far8(vm, seg, off) {
    return vm.mem.r8(seg * 16 + u16(off));
}

export function far16(vm, seg, off) {
    return vm.mem.r16(seg * 16 + u16(off));
}

/** Append one record for the audio backend to vm.sound_log: the fields, then `event`. */
export function log_sound(vm, event, fields = {}) {
    if (vm.sound_log === undefined) vm.sound_log = [];
    fields.event = event;
    vm.sound_log.push(fields);
}

/** Evaluate `count` expressions, results discarded; false if an end code abandoned them. */
export function _evaluations(vm, count) {
    for (let k = 0; k < count; k++) {
        if (vm.evaluate() === SKIP) return false;
    }
    return true;
}

/** Handlers that push and pop every register around their work leave DX, CX and BX as they
 * found them (only SI moves past the operands). */
export function preserving_registers(fn) {
    return function h(vm) {
        const saved = [vm.dx, vm.cx, vm.bx];
        try {
            return fn(vm);
        } finally {
            [vm.dx, vm.cx, vm.bx] = saved;
        }
    };
}


// --------------------------------------------------------------------- timer channel 0
export const PIT_STEP = 0x137;

/** One `in al, 0x40` after a latch command: a byte of timer channel 0's running count.
 *
 * The count is free-running hardware state. A VM may supply `vm.pit_source()` returning the
 * byte; the default model is a counter (`vm.pit_count`, initially 0) that drops by 0x137 at
 * every read, so runs are deterministic. */
export function pit_byte(vm) {
    const source = vm.pit_source ?? null;
    if (source !== null) return source() & 0xFF;
    vm.pit_count = u16((vm.pit_count ?? 0) - PIT_STEP);
    return vm.pit_count & 0xFF;
}

/** Code 0x77f1: the speed value cs:[0x518], scaled by 2/3 unless the display type is CGA (2)
 * or monochrome (0x80). */
export function cpu_speed(vm) {
    const v = vm.g16(0x518);
    const d = vm.g16(0x24);
    if (d === 2 || d === 0x80) return v;
    return Math.floor(u16(v * 2) / 3);
}


// --------------------------------------------------------------------- sound blocks (code 0x4dc0)
/** seg:off plus the 32-bit offset hi:lo, normalised to an offset below 16, exactly as
 * 0x4dd0-0x4df8 computes it (the high word counts 0x1000 paragraphs after swapping its bytes). */
export function _far_add(seg, off, lo, hi) {
    let total = off + lo;
    if (total > 0xFFFF) hi = u16(hi + 1);
    total &= 0xFFFF;
    const paragraphs = (((hi & 0xFF) << 8 | hi >> 8) << 4) & 0xFFFF;
    return [u16(seg + paragraphs + (total >> 4)), total & 0xF];
}

/** Code 0x4dc0: far pointer [segment, offset] to sound `index` of the current object's class,
 * or of MAIN's class (record cs:[0x473]) when cs:[0x492] != 0. Class + u32 [+0xe] = resource part;
 * + u32 [+0xc] = sound table; entry `index` = self-relative u32. The index is not range-checked.
 * Leaves DX = 4 * index, as the original does. */
export function sound_block(vm, index) {
    const rec = vm.g8(0x492) ? vm.g16(0x473) : vm.bp;
    const p = vm.es * 16 + u16(rec - 0x14);
    let off = vm.mem.r16(p), seg = vm.mem.r16(p + 2);
    [seg, off] = _far_add(seg, off, far16(vm, seg, off + 0xE), far16(vm, seg, off + 0x10));
    [seg, off] = _far_add(seg, off, far16(vm, seg, off + 0xC), far16(vm, seg, off + 0xE));
    vm.dx = u16(4 * index);
    off = u16(off + vm.dx);
    [seg, off] = _far_add(seg, off, far16(vm, seg, off), far16(vm, seg, off + 2));
    return [seg, off];
}


// --------------------------------------------------------------------- tones (code 0x4cf9)
export const CHANNELS = [0x8FF, 0x90D, 0x91B];
// The original tests ZF right after DIV (0x4c44, 0x4ce3). DIV leaves the flags undefined; on a
// machine where the ZF = 1 of the preceding `sub dx,dx` survives it (the behaviour kept here),
// the fade step is always -1. Set to false for the evident intent (step -1 only when the
// quotient is 0).
export const DIV_KEEPS_FLAGS = true;

/** Code 0x4cf9: put the request cs:[0x535..0x53f] on the channel record with the lowest
 * priority (byte +1) unless that priority is higher than the request's; a playing sample of no
 * higher priority (cs:[0x575]) is stopped first. Record: +0 state (0x80 while written, then 2),
 * +1 priority, +2 mode, +4 duration, +6 0, +7 volume, +8/+9 volume step (word at +8 with a sound
 * device cs:[0x87e0], else the low byte at +9), +0xa pitch, +0xc pitch step. */
export function start_tone(vm) {
    let di = CHANNELS[0];
    let low = sx8(vm.g8(di + 1));
    for (const ch of CHANNELS.slice(1)) {
        if (low > sx8(vm.g8(ch + 1))) {
            di = ch;
            low = sx8(vm.g8(ch + 1));
        }
    }
    const prio = vm.g8(0x535);
    if (low > sx8(prio)) return;
    if (vm.g8(0x574) && sx8(prio) >= sx8(vm.g8(0x575))) stop_sample(vm);
    vm.sg8(di, 0x80);
    vm.sg8(di + 1, prio);
    vm.sg8(di + 2, vm.g8(0x536));
    vm.sg16(di + 0xA, vm.g16(0x539));
    vm.sg16(di + 0xC, vm.g16(0x53B));
    vm.sg8(di + 7, vm.g8(0x53D));
    vm.sg8(di + 6, 0);
    if (vm.g8(0x87E0)) {
        vm.sg16(di + 8, vm.g16(0x53F));
    } else {
        vm.sg8(di + 9, vm.g16(0x53F));
    }
    vm.sg16(di + 4, vm.g16(0x537));
    vm.sg8(di, 2);
    log_sound(vm, 'tone', {
        channel: CHANNELS.indexOf(di), priority: sx8(prio), mode: vm.g8(0x536),
        volume: vm.g8(0x53D), pitch: vm.g16(0x539), duration: vm.g16(0x537),
        pitch_step: s16(vm.g16(0x53B)), volume_step: s16(vm.g16(0x53F)),
    });
}


// --------------------------------------------------------------------- digitised samples
export const PLAYER = 0x8B4E;                  // PC-speaker timer handler, copied to the sample
export const PLAYER_SIZE = 0x6A;
export const PLAYER_END = 0x8CF5;              // its exit, patched into the copy's far jump
export const PLAYER_OUTPUT = 0x20;             // byte +2 of the copy: `mov ax,0aa20h` at 0x8b4f
export const SPEAKER_PATTERNS = 0x8ADE;        // output pattern byte per rate 1..20
export const DEVICE_DIVISORS = 0x8E40;         // timer divisor word per rate (index 2 * rate)
export const DEVICE_HANDLER = 0x9006;          // timer handler of the sound-device player
export const OLD_TIMER = 0x87FA;               // game's timer vector (offset, segment); +4 divisor

export function _set_timer_vector(vm, seg, off) {
    vm.mem.w16(0x20, off);
    vm.mem.w16(0x22, seg);
}

/** Code 0x8827: start the sample cs:[0x57a]:[0x57c] (length cs:[0x57e]) if its priority
 * cs:[0x535] is at least each tone channel's and the playing sample's (cs:[0x575]); rate cs:[0x577]
 * is clamped to 1..20 (else 10), cs:[0x578] is the repeat count. */
export function start_sample(vm) {
    const prio = vm.g8(0x535);
    for (const a of [0x900, 0x90E, 0x91C, 0x575]) {
        if (sx8(prio) < sx8(vm.g8(a))) return;
    }
    vm.sg8(0x575, prio);
    vm.sg16(0x2CB1, 0);
    vm.sg16(0x592, vm.g16(0x57E));
    vm.sg16(0x594, vm.g16(0x578));
    vm.sg8(0x596, vm.g8(0x577));
    vm.sg16(0x58E, vm.g16(0x57A));
    vm.sg16(0x590, vm.g16(0x57C));
    let rate = vm.g8(0x577);
    if (!(1 <= sx8(rate) && sx8(rate) <= 20)) rate = 10;
    vm.sg8(0x577, rate);
    vm.sg8(0x574, 1);
    const seg = vm.g16(0x57C), off = vm.g16(0x57A);
    let count = vm.g16(0x578);
    let device;
    if (vm.g8(0x87E0)) {
        device_play(vm);
        device = 'sound device';
    } else {
        count = speaker_play(vm, seg, off, rate - 1, count);
        device = 'speaker';
    }
    const length = vm.g16(0x57E);
    const data = [];
    for (let k = 0x80; k < Math.max(length, 0x80); k++) {
        const b = vm.mem.r8(seg * 16 + u16(off + k));
        if (b === 0) break;
        data.push(b);
    }
    log_sound(vm, 'sample', {
        device, segment: seg, offset: off, length, rate, repeat: count, priority: sx8(prio),
        data: Uint8Array.from(data),
    });
}

/** Code 0x8bdf (PC speaker): copy the player 0x8b4e..0x8bb7 to the start of the sample data
 * seg:dx, patch its addresses, pattern byte, repeat count and timing into the copy, and point
 * the timer vector at it. bx = rate - 1, cx = repeat count (<= 0 means 0x7d00). The copy plays
 * the bytes from dx + 0x80 up to a zero byte; returns the repeat count used.
 *
 * Without the program image (vm.player_template false: the data-only start-up of boot.js) the
 * player is not copied: only the fields the player model (interrupts.sample_tick,
 * audio.SpeakerSound) reads are written, the output byte +2 (PLAYER_OUTPUT, as the copy starts)
 * and pattern +3, the data pointer +0xc, the repeat count +0x60, the period +0x64 and the tick
 * counter +0x66. The copy's code bytes and the addresses patched into that code keep what the
 * sample block holds there. */
export function speaker_play(vm, seg, dx, bx, cx) {
    const template = vm.player_template ?? true;

    function put16(k, v) {
        vm.mem.w16(seg * 16 + u16(dx + k), u16(v));
    }

    function patch(k, v) {
        if (template) put16(k, v);
    }

    if (template) {
        for (let k = 0; k < PLAYER_SIZE; k += 2) put16(k, vm.g16(PLAYER + k));
    } else {
        vm.mem.w8(seg * 16 + u16(dx + 2), PLAYER_OUTPUT);
    }
    if (s16(cx) <= 0) cx = 0x7D00;
    vm.sg8(0x87E3, 1);
    _set_timer_vector(vm, seg, dx);
    vm.mem.w8(seg * 16 + u16(dx + 3), vm.g8(SPEAKER_PATTERNS + bx));
    put16(0x60, cx);
    patch(0x17, dx + 2);
    patch(0x40, dx + 3);
    patch(0x50, dx + 0xC);
    patch(0x1D, dx + 0xC);
    patch(0x49, dx + 0x60);
    patch(0x57, dx + 0x60);
    patch(0x26, dx + 0x64);
    patch(0x2B, dx + 0x66);
    patch(0x34, dx + 0x66);
    put16(0x0C, dx + 0x80);
    patch(0x52, dx + 0x80);
    patch(0x5C, PLAYER_END);
    patch(0x5E, CODE_SEG);
    const low = pit_byte(vm);
    put16(0x66, low | pit_byte(vm) << 8);
    put16(0x64, s16(cpu_speed(vm)) > 0x64 ? 0x37 : 0x42);
    return cx;
}

/** Code 0x8e6a (sound device, cs:[0x87e0] != 0): reset the player state, time the device,
 * install the timer handler 0x9006 and set its data pointer (sample + 0x80) and divisor. */
export function device_play(vm) {
    vm.sg8(0x8D77, 0xFF);
    vm.sg8(0x8D76, 0xFF);
    vm.sg16(0x8D74, 0xFFFF);
    let low = pit_byte(vm);
    vm.sg16(0x597, low | pit_byte(vm) << 8);
    low = pit_byte(vm);
    const start = low | pit_byte(vm) << 8;
    for (let n = 0; n < 1 << 16; n++) {               // busy wait for 0x952 timer counts, no writes
        low = pit_byte(vm);
        if (u16(start - (low | pit_byte(vm) << 8)) >= 0x952) break;
    }
    _set_timer_vector(vm, CODE_SEG, DEVICE_HANDLER);
    vm.sg16(0x8E3C, u16(vm.g16(0x57A) + 0x80));
    vm.sg16(0x8E3E, vm.g16(0x57C));
    vm.sg16(0x599, vm.g16(DEVICE_DIVISORS + 2 * vm.g8(0x577)));
}

/** Code 0x8af9: if the PC-speaker player runs (cs:[0x87e3]), restore the game's timer vector
 * and clear cs:[0x574], cs:[0x575], cs:[0x87e3]. */
export function speaker_stop(vm) {
    if (!vm.g8(0x87E3)) return false;
    _set_timer_vector(vm, vm.g16(OLD_TIMER + 2), vm.g16(OLD_TIMER));
    vm.sg8(0x574, 0);
    vm.sg8(0x575, 0);
    vm.sg8(0x87E3, 0);
    return true;
}

/** Code 0x8f7d: if a sample plays (cs:[0x574]), restore the timer vector, clear cs:[0x574],
 * cs:[0x575]. */
export function device_stop(vm) {
    if (!vm.g8(0x574)) return false;
    _set_timer_vector(vm, vm.g16(OLD_TIMER + 2), vm.g16(OLD_TIMER));
    vm.sg8(0x574, 0);
    vm.sg8(0x575, 0);
    return true;
}

/** Code 0x88dd: stop the digitised sample on the sound device or the PC speaker. */
export function stop_sample(vm) {
    const stopped = vm.g8(0x87E0) ? device_stop(vm) : speaker_stop(vm);
    if (stopped) log_sound(vm, 'sample stop');
}

/** What the timer interrupt does when the playing sample ends (the copied player jumps to
 * 0x8cf5, which calls 0x8af9; the device player ends through 0x8f7d). The interrupt-time state
 * inside the player copy (current data pointer, repeat and tick counters) is not modelled. */
export function sample_finished(vm) {
    if (!vm.g8(0x574)) return;
    stop_sample(vm);
    if (vm.g8(0x574)) throw new EngineHang('cs:[0x574] is set by the music stub and nothing clears it');
}

/** Code 0x7097: busy-wait until no digitised sample plays (cs:[0x574] == 0); here the playing
 * sample is ended at once. */
export function wait_sample_end(vm) {
    sample_finished(vm);
}

/** Code 0x50d3: play the sound block at seg:off ([type, rate, length u16, ..., data at +16];
 * types 1 and 2 are digitised) unless samples are disabled (cs:[0x51b]); a zero rate request
 * cs:[0x577] takes the block's own rate. */
export function play_block(vm, seg, off) {
    if (vm.g8(0x51B)) return;
    const type = far8(vm, seg, off);
    if (type !== 1 && type !== 2) return;
    if (vm.g8(0x577) === 0) vm.sg8(0x577, far8(vm, seg, off + 1));
    vm.sg16(0x57E, u16(far16(vm, seg, off + 2) - 0x10));
    vm.sg16(0x57A, u16(off + 0x10));
    vm.sg16(0x57C, seg);
    start_sample(vm);
}


// --------------------------------------------------------------------- tone statements
/** Priority, volume, pitch and duration of 0x6b-0x6d into cs:[0x535], [0x53d], [0x539],
 * [0x537]; false if an end code abandoned the statement. */
export function _tone_request(vm) {
    for (const store of [() => vm.sg8(0x535, vm.dx), () => vm.sg8(0x53D, vm.dx),
                         () => vm.sg16(0x539, vm.dx), () => vm.sg16(0x537, vm.dx)]) {
        if (vm.evaluate() === SKIP) return false;
        store();
    }
    return true;
}

/** cs:[0x53f] = -(volume * 256 / duration) (see DIV_KEEPS_FLAGS); returns the remainder. */
export function _fade_step(vm) {
    const a = vm.g8(0x53D) << 8, b = vm.g16(0x537);
    let q = floordiv(a, b);
    const r = floormod(a, b);
    if (DIV_KEEPS_FLAGS || q === 0) q = 1;
    vm.sg16(0x53F, -q);
    return r;
}

/** Tone with pitch slide; the fifth operand exists only when the duration is non-zero. */
export function tone_slide(vm) {
    if (!_tone_request(vm) || vm.dx === 0) return undefined;
    if (vm.evaluate() === SKIP) return undefined;
    vm.sg16(0x53B, vm.dx);
    vm.sg16(0x53F, 0);
    vm.sg8(0x536, 1);
    start_tone(vm);
}
statement(0x6B)(tone_slide);

/** Noise: never reaches a tone channel; plays the built-in noise sample (far cs:[0x586], or
 * the quieter copy cs:[0x58a] for volume <= 0x78; nothing below 0x50) at a rate from the pitch. */
export function noise(vm) {
    if (!_tone_request(vm) || vm.dx === 0) return undefined;
    vm.sg16(0x53B, 0);
    _fade_step(vm);
    vm.sg8(0x536, 3);
    const v = u16(0x7FFF - vm.g16(0x539));
    const q = floordiv(v, 0x666), r = floormod(v, 0x666);
    const rate = Math.min(q + 1, 0x14);
    vm.cx = 0x666;
    vm.dx = r;
    if (s16(vm.g16(0x53D)) < 0x50) return undefined;
    vm.sg16(0x3A7, vm.si);
    vm.sg8(0x577, rate);
    vm.sg16(0x578, 1);
    const ptr = s16(vm.g16(0x53D)) > 0x78 ? 0x586 : 0x58A;
    play_block(vm, vm.g16(ptr + 2), vm.g16(ptr));
}
statement(0x6C)(noise);

/** Tone whose volume falls linearly to 0 over its duration. */
export function tone_fade(vm) {
    if (!_tone_request(vm) || vm.dx === 0) return undefined;
    vm.sg16(0x53B, 0);
    vm.dx = _fade_step(vm);
    vm.sg8(0x536, 1);
    start_tone(vm);
}
statement(0x6D)(tone_fade);

/** Four values for a sound device that this version of the game does not support, evaluated
 * and discarded. */
export function sound_stub(vm) {
    _evaluations(vm, 4);
}
statement(0x6E)(sound_stub);


// --------------------------------------------------------------------- sample and music statements
export function _play_sound(main) {
    /** Play digitised sound n of the own class (0x9d) or MAIN's class (0x9e): operands sound,
     * priority, a byte for cs:[0x53d], repeat count, rate. */
    return preserving_registers(function h(vm) {
        vm.sg8(0x492, main ? 1 : 0);
        if (vm.evaluate() === SKIP) return undefined;
        const index = vm.dx;
        for (const store of [() => vm.sg8(0x535, vm.dx), () => vm.sg8(0x53D, vm.dx),
                             () => vm.sg16(0x578, vm.dx), () => vm.sg8(0x577, vm.dx)]) {
            if (vm.evaluate() === SKIP) return undefined;
            store();
        }
        vm.sg16(0x3A7, vm.si);
        const [seg, off] = sound_block(vm, index);
        play_block(vm, seg, off);
    });
}

statement(0x9D)(_play_sound(false));
statement(0x9E)(_play_sound(true));


export function _music(main) {
    /** Music-driver interface, compiled out of this version of the game (0x95 own class, 0xac
     * MAIN's): a block of type 0 or 3 sets the driver parameters cs:[0x54a..0x552] and
     * cs:[0x542]; type 3 also sets cs:[0x574] (stub 0x8904). Other blocks: the five parameters
     * are only evaluated. */
    return function h(vm) {
        vm.sg8(0x492, main ? 1 : 0);
        if (vm.evaluate() === SKIP) return undefined;
        const index = vm.dx;
        let [seg, off] = sound_block(vm, index);
        const type = far8(vm, seg, off);
        if (type !== 0 && type !== 3) {
            _evaluations(vm, 5);
            return undefined;
        }
        off = u16(off + 6);
        vm.sg16(0x54A, off);
        vm.sg16(0x54C, seg);
        for (const [target, size, bias] of [[0x545, 1, 0], [0x543, 1, 0], [0x54E, 2, 0x10],
                                            [0x552, 2, 0], [0x550, 2, 0x10]]) {
            if (vm.evaluate() === SKIP) return undefined;
            vm.dx = u16(vm.dx + bias);
            if (size === 1) vm.sg8(target, vm.dx);
            else vm.sg16(target, vm.dx);
        }
        const kind = far8(vm, vm.g16(0x54C), vm.g16(0x54A) - 6);
        if (kind) vm.sg8(0x574, 1);
        vm.sg8(0x542, 1);
        vm.cx = (vm.cx & 0xFF00) | vm.g8(0x545);
        log_sound(vm, 'music', {
            kind, segment: seg, offset: u16(off - 6), sound: index,
            p545: vm.g8(0x545), p543: vm.g8(0x543), p54e: vm.g16(0x54E), p552: vm.g16(0x552),
            p550: vm.g16(0x550),
        });
    };
}

statement(0x95)(_music(false));
statement(0xAC)(_music(true));


/** Music stop (0x5076): cs:[0x550] = value + 0x10, cs:[0x54e] = 0, cs:[0x552] = 1, then 0x88d0
 * clears cs:[0x574] and cs:[0x542] (without stopping a playing sample). */
export function music_stop(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    vm.dx = u16(vm.dx + 0x10);
    vm.sg16(0x550, vm.dx);
    vm.sg16(0x54E, 0);
    vm.sg16(0x552, 1);
    vm.sg8(0x574, 0);                                  // 0x88d0
    vm.sg8(0x542, 0);
    log_sound(vm, 'music stop');
}
statement(0x96)(music_stop);

/** cs:[0x87e8] = (value & 0x7f) * 8 (code 0x8942; the game never reads it). */
export function music_parameter(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    vm.sg16(0x87E8, (vm.dx & 0x7F) << 3);
}
statement(0x97)(music_parameter);

/** cs:[0x568] = cs:[0x545] = low byte (a music-driver parameter, without effect in this version
 * of the game). */
export function music_volume(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    vm.sg8(0x568, vm.dx);
    vm.sg8(0x545, vm.dx);
}
statement(0x98)(music_volume);

statement(0xA1)(stop_sample);


export function _sound_slot(main) {
    /** Sound slot s (0..31, at cs:0x4e62 + 8s) = far pointer to sound n of the own class
     * (0xcd) or MAIN's class (0xce) plus 0xc, and parameter p; n < 0 clears the slot. */
    return preserving_registers(function h(vm) {
        vm.sg8(0x492, main ? 1 : 0);
        const values = [];
        for (let k = 0; k < 3; k++) {
            if (vm.evaluate() === SKIP) return undefined;
            values.push(vm.dx);
        }
        const s = values[0], n = values[1];
        let p = values[2];
        vm.sg16(0x3A7, vm.si);
        let seg, off;
        if (n & 0x8000) {
            off = seg = p = 0;
        } else {
            [seg, off] = sound_block(vm, n);
            off += 0xC;
        }
        const k = (s & 0x1F) * 8;
        vm.sg16(0x4E62 + k, off);
        vm.sg16(0x4E64 + k, seg);
        vm.sg16(0x4E66 + k, p);
    });
}

statement(0xCD)(_sound_slot(false));
statement(0xCE)(_sound_slot(true));


// --------------------------------------------------------------------- DOS files
export const format_number = F.format_number;

export function _echo(vm, text) {
    vm.stdout = (vm.stdout ?? '') + F.latin1(text);
}

/** Code 0x85c2 through console output (cs:[0x421] = 0): "Erreur", the number (formatted in the
 * buffer cs:[0x4d3]), " :", the message of the table at cs:0x87c3; then the original waits for a
 * key (DOS function 1) and exits through 0x1550. */
export function fatal_error(vm, code) {
    const parts = [];
    vm.sg8(0x421, 0);
    parts.push(F.cstring(vm, CS + 0x85FC));
    parts.push(format_number(vm, code, vm.g16(0x4D3)));
    vm.sg8(0x421, 0);
    parts.push(F.cstring(vm, CS + 0x8603));
    vm.sg8(0x421, 0);
    parts.push(F.cstring(vm, CS + vm.g16(u16(0x87C3 + 2 * code))));
    const text = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
        text.set(p, at);
        at += p.length;
    }
    _echo(vm, text);
    throw new FatalError(code, F.latin1(text));
}

/** The writable copy of the game directory (files.js), created and filled on first use. */
export function save_dir() {
    return files.save_dir();
}

// Characters trimmed from both ends of a file name: the whitespace and separator characters
// among the 256 Latin-1 codes (tab to carriage return, 0x1c-0x1f, space, 0x85, 0xa0).
const _SPACES = '\t\n\x0b\x0c\r\x1c\x1d\x1e\x1f \x85\xa0';

function _strip(s) {
    let a = 0, b = s.length;
    while (a < b && _SPACES.includes(s[a])) a += 1;
    while (b > a && _SPACES.includes(s[b - 1])) b -= 1;
    return s.slice(a, b);
}

/** The file name at linear address `lin` as DOS sees it: last path component, upper case. */
export function dos_name(vm, lin) {
    const raw = F.latin1(F.cstring(vm, lin));
    const last = raw.split('/').join('\\').split('\\').at(-1).split(':').at(-1);
    return _strip(last).toUpperCase();
}

/** The directory's name of the file called `name` (upper case), or null. */
export function _existing(name) {
    for (const f of save_dir().names()) {
        if (f.toUpperCase() === name) return f;
    }
    return null;
}

export function _files(vm) {
    if (vm.dos_files === undefined) vm.dos_files = new Map();
    return vm.dos_files;
}

/** An open file of the save directory, as a file object opened for reading and writing: the
 * file's bytes and the position. Every change is written back to the directory at once while
 * the directory still holds this file (a file deleted, or deleted and created again, while it is
 * open keeps its bytes for this handle only). */
export class DosFile {
    constructor(dir, name) {
        this.dir = dir;
        this.name = name;
        this.stored = dir.read(name);
        this.data = this.stored.slice();
        this.pos = 0;
    }

    read(count) {
        const end = Math.min(this.data.length, this.pos + count);
        const out = this.pos < end ? this.data.slice(this.pos, end) : new Uint8Array(0);
        this.pos += out.length;
        return out;
    }

    _resize(size) {
        if (size === this.data.length) return;
        const grown = new Uint8Array(size);
        grown.set(size < this.data.length ? this.data.subarray(0, size) : this.data);
        this.data = grown;
    }

    write(bytes) {
        const end = this.pos + bytes.length;
        if (end > this.data.length) this._resize(end);
        this.data.set(bytes, this.pos);
        this.pos = end;
        return bytes.length;
    }

    /** Cut (or extend with zeros) the file at the current position. */
    truncate() {
        this._resize(this.pos);
        return this.pos;
    }

    seek(offset, whence = 0) {
        if (whence === 0) this.pos = offset;
        else if (whence === 1) this.pos += offset;
        else this.pos = this.data.length + offset;
        return this.pos;
    }

    tell() {
        return this.pos;
    }

    flush() {
        if (this.dir.read(this.name) !== this.stored) return;
        this.dir.write(this.name, this.data);
        this.stored = this.dir.read(this.name);
    }

    close() {}
}

export function _new_handle(vm, f) {
    const open = _files(vm);
    let h = 5;
    while (open.has(h)) h += 1;
    if (h >= 20) {
        f.close();
        return [false, 4];                             // too many open files
    }
    open.set(h, f);
    return [true, h];
}

// File-name patterns, case-sensitive: `*` any characters, `?` one character, `[...]` /
// `[!...]` a set (ranges a-z; `]` first is a member; an unclosed `[` is literal); everything
// else literal.
function _glob_tokens(pat) {
    const out = [];
    let i = 0;
    const n = pat.length;
    while (i < n) {
        const c = pat[i];
        i += 1;
        if (c === '*') {
            if (!out.length || out.at(-1) !== '*') out.push('*');
        } else if (c === '?') {
            out.push({any: true});
        } else if (c === '[') {
            let j = i;
            if (j < n && pat[j] === '!') j += 1;
            if (j < n && pat[j] === ']') j += 1;
            while (j < n && pat[j] !== ']') j += 1;
            if (j >= n) {
                out.push({ch: '['});
            } else {
                out.push(_glob_set(pat, i, j));
                i = j + 1;
            }
        } else {
            out.push({ch: c});
        }
    }
    return out;
}

/** The set between the brackets (pat[i] .. pat[j - 1]) as members and ranges. A set containing
 * `--` is cut at hyphens, searched from its second character (after a leading `!`), each search
 * resuming three characters after the last cut: the hyphens at the cuts join ranges, the other
 * hyphens are members. */
function _glob_set(pat, i, j) {
    const items = [];                                   // [char, is_literal_hyphen]
    let negate = false;
    let k0 = i;
    if (pat[i] === '!') {
        negate = true;
        k0 = i + 1;
    }
    const stuff = pat.slice(i, j);
    if (!stuff.includes('--')) {
        for (let k = k0; k < j; k++) items.push([pat[k], false]);
    } else {
        const chunks = [];
        let a = i;
        let k = pat[i] === '!' ? i + 2 : i + 1;
        for (;;) {
            k = pat.indexOf('-', k);
            if (k < 0 || k >= j) break;
            chunks.push([a, k]);
            a = k + 1;
            k = k + 3;
        }
        chunks.push([a, j]);
        chunks.forEach(([s, e], ci) => {
            if (ci) items.push(['-', false]);
            for (let m = s; m < e; m++) {
                if (s === i && m === i && negate) continue;
                items.push([pat[m], pat[m] === '-']);
            }
        });
    }
    // X-Y is a range unless its hyphen is a member
    const ranges = [];
    let m = 0;
    while (m < items.length) {
        const [c] = items[m];
        if (m + 2 < items.length && items[m + 1][0] === '-' && !items[m + 1][1]) {
            const hi = items[m + 2][0];
            if (hi.charCodeAt(0) < c.charCodeAt(0)) {
                // a reversed range makes the pattern invalid
                const e = new EngineError(`bad character range ${c}-${hi} in a file-name pattern`);
                e.name = 'PatternError';
                throw e;
            }
            ranges.push([c.charCodeAt(0), hi.charCodeAt(0)]);
            m += 3;
        } else {
            ranges.push([c.charCodeAt(0), c.charCodeAt(0)]);
            m += 1;
        }
    }
    return {negate, ranges};
}

function _glob_one(tok, c) {
    if (tok.any) return true;
    if (tok.ch !== undefined) return tok.ch === c;
    const code = c.charCodeAt(0);
    const inside = tok.ranges.some(([lo, hi]) => lo <= code && code <= hi);
    return inside !== tok.negate;
}

export function match_file_pattern(name, pat) {
    const toks = _glob_tokens(pat);
    // iterative matching with backtracking to the last star
    let t = 0, s = 0, star = -1, mark = 0;
    while (s < name.length) {
        if (t < toks.length && toks[t] !== '*' && _glob_one(toks[t], name[s])) {
            t += 1;
            s += 1;
        } else if (t < toks.length && toks[t] === '*') {
            star = t;
            mark = s;
            t += 1;
        } else if (star >= 0) {
            t = star + 1;
            mark += 1;
            s = mark;
        } else {
            return false;
        }
    }
    while (t < toks.length && toks[t] === '*') t += 1;
    return t === toks.length;
}

/** DOS 4Eh with normal attributes: does a file match the name? (The disk transfer area that
 * DOS fills with the match is not written.) */
export function dos_find_first(vm, lin) {
    const name = dos_name(vm, lin);
    if (!name) return false;
    return save_dir().names().some((f) => match_file_pattern(f.toUpperCase(), name));
}

/** DOS 3Dh, read/write: [true, handle] or [false, error code]. */
export function dos_open(vm, lin) {
    const path = _existing(dos_name(vm, lin));
    if (path === null) return [false, 2];
    return _new_handle(vm, new DosFile(save_dir(), path));
}

/** DOS 3Ch: create or empty the file. */
export function dos_create(vm, lin) {
    const name = dos_name(vm, lin);
    if (!name || [...'*?"<>|'].some((c) => name.includes(c))) return [false, 3];
    const path = _existing(name) ?? name;
    const dir = save_dir();
    dir.write(path, new Uint8Array(0));
    return _new_handle(vm, new DosFile(dir, path));
}

/** DOS 41h. */
export function dos_delete(vm, lin) {
    const path = _existing(dos_name(vm, lin));
    if (path === null) return [false, 2];
    save_dir().remove(path);
    return [true, 0];
}

export function dos_close(vm, handle) {
    const open = _files(vm);
    const f = open.get(handle);
    if (f === undefined) return [false, 6];
    open.delete(handle);
    f.close();
    return [true, 0];
}

/** DOS 3Fh into linear memory: [true, bytes read]. */
export function dos_read(vm, handle, lin, count) {
    const f = _files(vm).get(handle);
    if (f === undefined) return [false, 6];
    const data = f.read(count);
    vm.mem.m.set(data, lin);
    return [true, data.length];
}

/** DOS 40h from linear memory; a count of 0 truncates the file at the current position. */
export function dos_write(vm, handle, lin, count) {
    const f = _files(vm).get(handle);
    if (f === undefined) return [false, 6];
    if (count === 0) f.truncate();
    else f.write(vm.mem.m.slice(lin, lin + count));
    f.flush();
    return [true, count];
}

export function dos_seek(vm, handle, whence, offset) {
    const f = _files(vm).get(handle);
    if (f === undefined) return [false, 6];
    f.seek(offset, whence);
    return [true, f.tell()];
}

export function _check(vm, result, code) {
    const [ok, value] = result;
    if (!ok) fatal_error(vm, code);
    return value;
}

/** Code 0x7053: create (DOS 3Ch, attributes 0), handle (or error code) -> cs:[0x435];
 * failure is fatal error 8. */
export function create_file(vm, lin) {
    vm.cx = 0;
    const [ok, value] = dos_create(vm, lin);
    vm.sg16(0x435, value);
    if (!ok) fatal_error(vm, 8);
}

/** Code 0x7041: close cs:[0x435]; failure is fatal error 14. */
export function close_file(vm) {
    _check(vm, dos_close(vm, vm.g16(0x435)), 14);
}

/** Code 0x7037: wait for the sample to end, then DOS 4Eh with CX = 0. Returns [found, AX]:
 * DOS returns AX = 0 on success (undocumented behaviour) and the error code 2
 * otherwise, so the mode word that AX held is lost. */
export function _find(vm, lin) {
    wait_sample_end(vm);
    vm.cx = 0;
    const found = dos_find_first(vm, lin);
    return [found, found ? 0 : 2];
}

/** Code 0x6ff1. Mode bits: 0x200 create when missing; 0x400 create (empty) when present;
 * otherwise open read/write (DOS 3Dh, AL = 2); 0x800 then seeks to the end, but with the
 * handle register BX never loaded (it holds `bx`), so on DOS that seek fails: fatal error 1.
 * The mode lives in AX, which a find-first replaces: after 0x200 finds the file, 0x400 and
 * 0x800 are not acted on. The handle (or the DOS error code) goes to cs:[0x435]; failures are
 * fatal error 1. */
export function open_file_routine(vm, lin, mode, bx) {
    wait_sample_end(vm);
    let found;
    if (mode & 0x200) {
        [found, mode] = _find(vm, lin);
        if (!found) return create_file(vm, lin);
    }
    if (mode & 0x400) {
        [found, mode] = _find(vm, lin);
        if (found) return create_file(vm, lin);
    }
    const [ok, value] = dos_open(vm, lin);
    vm.sg16(0x435, value);
    if (!ok) fatal_error(vm, 1);
    if (mode & 0x800) {
        const [seek_ok, pos] = dos_seek(vm, bx, 2, vm.cx * 0x10000 + vm.dx);
        if (!seek_ok) fatal_error(vm, 1);
        vm.dx = Math.floor(pos / 0x10000) & 0xFFFF;
    }
}

/** Open a file: inline name and u16 mode, or 0xff, a string expression (entry 0x574c) and a
 * mode expression. */
export function open_file(vm) {
    vm.dx = vm.si;
    if (vm.mem.r8(vm.lin()) !== 0xFF) {
        const lin = vm.lin();
        vm.si = u16(vm.si + F.cstring(vm, lin).length + 1);
        const mode = vm.fetch16();
        return open_file_routine(vm, lin, mode, 0x70 * 2);
    }
    vm.si = u16(vm.si + 1);
    vm.bx = 0x70 * 2;                                  // 0x574c does not reset the value stack
    F.swap_buffers(vm, 0x4D3, 0x4D5);
    if (vm.eval_item() === SKIP) return undefined;
    if (vm.evaluate() === SKIP) return undefined;
    const mode = vm.dx;
    vm.dx = vm.g16(0x4D3);
    return open_file_routine(vm, CS + vm.dx, mode, vm.bx);
}
statement(0x70)(open_file);

statement(0x71)(close_file);


/** DX = SI at an inline zero-terminated name; SI moves past it. Returns its linear address. */
export function _inline_name(vm) {
    const lin = vm.lin();
    vm.dx = vm.si;
    vm.si = u16(vm.si + F.cstring(vm, lin).length + 1);
    return lin;
}

export function create_empty(vm) {
    const lin = _inline_name(vm);
    vm.fetch16();
    create_file(vm, lin);
    close_file(vm);
}
statement(0x72)(create_empty);

export function delete_file(vm) {
    _check(vm, dos_delete(vm, _inline_name(vm)), 9);
}
statement(0x73)(delete_file);


export function swap16(v) {
    return (v >> 8 | v << 8) & 0xFFFF;
}

/** Read a big-endian word into a destination; at the end of the file the previous content of
 * the buffer cs:[0xf6c] is stored. */
export function read_word(vm) {
    _check(vm, dos_read(vm, vm.g16(0x435), CS + 0xF6C, 2), 13);
    vm.cx = 2;
    vm.dx = swap16(vm.g16(0xF6C));
    return F.destination(vm, F.DEST_STORE);
}
statement(0x74)(read_word);

export function write_word(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    vm.sg16(0xF6C, swap16(vm.dx));
    vm.dx = 0xF6C;
    vm.cx = 2;
    _check(vm, dos_write(vm, vm.g16(0x435), CS + 0xF6C, 2), 7);
}
statement(0x75)(write_word);

/** Write the inline string including its zero byte. */
export function write_string(vm) {
    const lin = vm.lin();
    const n = F.cstring(vm, lin).length + 1;
    vm.dx = vm.si;
    vm.cx = n;
    vm.si = u16(vm.si + n);
    _check(vm, dos_write(vm, vm.g16(0x435), lin, n), 7);
}
statement(0x76)(write_string);

/** Byte-swap `words` words at es:dx in place (0 means 65536: every word twice, no change). */
export function _swap_words(vm, dx, words) {
    for (let k = 0; k < words; k++) {
        const a = vm.es * 16 + u16(dx + 2 * k);
        const lo = vm.mem.r8(a), hi = vm.mem.r8(a + 1);
        vm.mem.w8(a, hi);
        vm.mem.w8(a + 1, lo);
    }
}

export function _is_word_array(vm, dx) {
    return vm.mem.r8(vm.es * 16 + u16(dx - 2)) === 2;
}

/** Read count bytes into own variable v; a word array (element size byte at v-2 == 2) is
 * stored big-endian, so the words read are byte-swapped. */
export function read_block(vm) {
    const dx = u16(vm.bp + vm.fetch16());
    const count = vm.fetch16();
    vm.dx = dx;
    vm.cx = count;
    const n = _check(vm, dos_read(vm, vm.g16(0x435), vm.es * 16 + dx, count), 13);
    if (_is_word_array(vm, dx)) {
        _swap_words(vm, dx, n >> 1);
        vm.cx = 0;
    }
}
statement(0x77)(read_block);

export function write_block(vm) {
    const dx = u16(vm.bp + vm.fetch16());
    const count = vm.fetch16();
    vm.dx = dx;
    vm.cx = count;
    const swapped = _is_word_array(vm, dx);
    if (swapped) _swap_words(vm, dx, count >> 1);
    _check(vm, dos_write(vm, vm.g16(0x435), vm.es * 16 + dx, count), 7);
    if (_is_word_array(vm, dx)) _swap_words(vm, dx, count >> 1);
}
statement(0x78)(write_block);


// --------------------------------------------------------------------- mouse (INT 33h)
/** State of a mouse driver: position and buttons in driver units, pointer shown. */
export class Mouse {
    constructor() {
        this.x = this.y = this.buttons = 0;
        this.visible = false;
    }
}

export function _mouse(vm) {
    if (vm.mouse == null) vm.mouse = new Mouse();
    return vm.mouse;
}

/** INT 33h AX=3: [CX = x, DX = y, BX = buttons] from the driver. */
export function mouse_registers(vm) {
    const m = _mouse(vm);
    return [m.x, m.y, m.buttons];
}

/** INT 33h AX=4 with CX = x, DX = y. */
export function mouse_set_position(vm, x, y) {
    const m = _mouse(vm);
    m.x = x;
    m.y = y;
}

export function _pointer_item(vm) {
    return vm.g16(0x461) * 16 + u16(vm.g16(0x45F) + vm.g16(0x469));
}

/** Show the mouse pointer: CGA through the driver (INT 33h AX=1), EGA/VGA as the software
 * pointer 0xbf28, which places the pointer display item at the last pointer position
 * cs:[0x51f], cs:[0x521] and draws it (renderer 0x988e, not reproduced here). */
export function show_pointer(vm) {
    if (vm.g8(0x51C)) return undefined;
    vm.sg8(0x46C, 1);
    vm.sg8(0x46D, 0xFF);
    if (vm.g8(0x422) === 0) {
        _mouse(vm).visible = true;
        return undefined;
    }
    const item = _pointer_item(vm);
    vm.mem.w8(item + 0x22, 0);
    vm.mem.w16(item + 0xC, vm.g16(0x51F));
    vm.mem.w16(item + 0xE, vm.g16(0x521));
}
statement(0x84)(show_pointer);

/** Hide the mouse pointer: CGA through the driver (INT 33h AX=2), EGA/VGA by restoring the
 * background under the software pointer (0xbfe6 -> 0x9772, not reproduced here). */
export function hide_pointer(vm) {
    if (vm.g8(0x51C)) return undefined;
    vm.sg8(0x46C, 0xFF);
    if (vm.g8(0x422) === 0) _mouse(vm).visible = false;
}
statement(0x85)(hide_pointer);

/** Store the mouse x, y and buttons through three destinations (-1 each without a mouse). */
export function read_mouse(vm) {
    let x, y, buttons;
    if (vm.g8(0x51C)) {
        x = y = buttons = 0xFFFF;
    } else {
        [x, y, buttons] = mouse_registers(vm);
        if (vm.g8(0x422) !== 1) x >>= 1;
        if (vm.g8(0x422) === 0) {
            x = u16(x + 1);
            y = u16(y + 1);
        }
    }
    vm.cx = buttons;
    for (const value of [x, y, buttons]) {
        vm.dx = value;
        if (F.destination(vm, F.DEST_STORE) === SKIP) return undefined;
    }
}
statement(0x86)(read_mouse);

/** Set the mouse position (no check for a driver): x - 1 (doubled unless VGA), y - 1. */
export function set_mouse(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    if (vm.evaluate_keep() === SKIP) return undefined;
    let x = u16(vm.dx - 1);
    if (vm.g8(0x422) !== 1) x = u16(x * 2);
    if (vm.g8(0x51C) === 0) mouse_set_position(vm, x, u16(vm.cx - 1));
}
statement(0x88)(set_mouse);


// --------------------------------------------------------------------- keyboard line input
/** The original busy-waits (code 0x7c14) until the keyboard interrupt sets the last-key
 * variable cs:[0x689]. Thrown before the statement changes anything, with SI back on the
 * opcode, so the statement can run again once keys are available. */
export class InputNeeded extends EngineError {}

export function _line_available(vm) {
    if (typeof vm.key_source === 'function') return true;
    const keys = (vm.g8(0x689) ? [vm.g8(0x689)] : []).concat(Array.from(vm.keys ?? []));
    return keys.some((k) => (k & 0xFF) === 0x0D);
}

/** Code 0x19b4 via 0x7c14: wait for a key (cs:[0x689] != 0), then for its release (the
 * keyboard interrupt clears cs:[0x689]); keys >= 0x80 are ignored. DX = 0 afterwards, as left
 * by the release test. */
export function read_key(vm) {
    for (;;) {
        let k = vm.g8(0x689);
        if (k === 0) {
            const keys = vm.keys ?? null;
            if (keys !== null && keys.length) {
                k = keys.shift() & 0xFF;
            } else if (typeof vm.key_source === 'function') {
                k = vm.key_source() & 0xFF;
            } else {
                throw new InputNeeded();
            }
        }
        vm.sg8(0x689, 0);
        vm.dx = 0;
        if (0 < k && k < 0x80) return k;
    }
}

/** Codes 0x1931 / 0x196b: keys into the buffer cs:[0x4d3] (no length limit), each accepted key
 * echoed on the console; Backspace removes the last one (echo 8, space, 8); Enter ends with 0. */
export function read_line(vm, accept) {
    const start = vm.g16(0x4D3);
    let bx = start;
    for (;;) {
        const k = read_key(vm);
        if (k === 0x0D) {
            vm.sg8(bx, 0);
            return;
        }
        if (k === 0x08) {
            if (bx !== start) {
                bx = u16(bx - 1);
                vm.sg8(bx, 0);
                _echo(vm, [0x08, 0x20, 0x08]);
            }
            continue;
        }
        if (accept(k)) {
            vm.sg8(bx, k);
            bx = u16(bx + 1);
            _echo(vm, [k]);
        }
    }
}

/** Code 0x5c38: optional '-', then decimal digits of the buffer cs:[0x4d3] into DX (16-bit),
 * CX = 1 if negative else 0; cs:[0x391] = 10. Its '$' hexadecimal branch tests cs:[DI] instead
 * of the buffer, DI being whatever the previous statement left; with DI holding an expression
 * code (the usual case) that byte is never '$', so the branch is not modelled. */
export function parse_number(vm) {
    vm.sg16(0x391, 10);
    let si = vm.g16(0x4D3);
    let neg = 0, value = 0;
    if (vm.g8(si)) {
        if (vm.g8(si) === 0x2D) {
            neg = 1;
            si = u16(si + 1);
        }
        while (0x30 <= vm.g8(si) && vm.g8(si) <= 0x39) {
            value = u16(value * 10 + vm.g8(si) - 0x30);
            si = u16(si + 1);
        }
    }
    vm.cx = neg;
    vm.dx = neg ? u16(-value) : value;
}

export function _input(number) {
    return function h(vm) {
        if (!_line_available(vm)) {
            vm.si = u16(vm.si - 1);
            throw new InputNeeded();
        }
        vm.sg8(0x421, 0);
        if (number) {
            read_line(vm, (k) => k === 0x2D || (0x30 <= k && k <= 0x39));
            parse_number(vm);
        } else {
            read_line(vm, (k) => true);
        }
        F.destination(vm, F.DEST_STORE);
        return undefined;
    };
}

statement(0xB0)(_input(true));
statement(0xB1)(_input(false));


// --------------------------------------------------------------------- stubs and setters
statement(0xC8, 0xC9, 0xD3, 0xD4)((vm) => undefined);

export function two_discarded(vm) {
    _evaluations(vm, 2);
}
statement(0x82)(two_discarded);

/** One expression evaluated for the side effects of the store codes inside it. */
export function evaluate_for_effect(vm) {
    _evaluations(vm, 1);
}
statement(0xD5, 0xD9)(evaluate_for_effect);

/** 0x573a then 0x5732: DX = first, CX = second. */
export function _two_values(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    vm.evaluate_keep();
    return undefined;
}
statement(0x7A, 0x7B, 0xBD, 0xD8)(_two_values);

export function own_graphics(vm) {
    vm.sg8(0x492, 0);
    vm.evaluate();
}
statement(0x81)(own_graphics);

/** Three values for the stub driver call 0x7c27 (a bare ret); CX is restored. */
export function driver_call(vm) {
    const cx = vm.cx;
    if (!_evaluations(vm, 3)) return undefined;
    vm.cx = cx;
}
statement(0xAE)(driver_call);

/** Stub driver read 0x7c28 (a bare ret): stores AX = 0x15e, CX, BX = 0x15e (the dispatch
 * value 0xaf * 2) through three destinations. */
export function driver_read(vm) {
    const cx = vm.cx;
    for (const value of [0xAF * 2, cx]) {
        vm.dx = value;
        if (F.destination(vm, F.DEST_STORE) === SKIP) return undefined;
    }
    vm.dx = 0xAF * 2;
    return F.destination(vm, F.DEST_STORE);
}
statement(0xAF)(driver_read);

export function unused_414(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    vm.sg8(0x414, vm.dx);
}
statement(0xBB)(unused_414);

export function unused_field(vm) {
    if (vm.evaluate() === SKIP) return undefined;
    vm.so8(-0x2F, vm.dx);
    _evaluations(vm, 3);
}
statement(0xD6)(unused_field);

/** Entry 0x574c: swap cs:[0x4d3] and cs:[0x4d5], evaluate one item without setting CX and
 * without resetting the value stack (BX holds the dispatch value 0xda * 2). */
export function evaluate_swapped(vm) {
    F.swap_buffers(vm, 0x4D3, 0x4D5);
    vm.bx = 0xDA * 2;
    vm.eval_item();
}
statement(0xDA)(evaluate_swapped);


register_module('ops_io', ops_io);
