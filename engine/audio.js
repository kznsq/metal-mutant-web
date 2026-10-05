/**
 * The PC-speaker sound of Metal Mutant: what the game sends to the speaker, rendered as
 * floating-point samples for the browser's audio output.
 *
 * Without a sound device (cs:[0x87e0] = 0, as on the default machine) every sound goes to the PC
 * speaker, driven by one line: the output of timer channel 2 AND bit 1 of port 0x61; bit 0 of port
 * 0x61 is the gate of timer channel 2. The game writes these ports in three places:
 *  - 0x8950, called by the 50 Hz timer handler 0x70e1 for each tone channel it steps, sends the
 *    loudest channel (cs:[0x541]) when no sample plays (cs:[0x574] = 0): speaker data bit =
 *    volume byte +7 != 0 (0x896f); timer channel 2 in square-wave mode with the divisor pitch
 *    word +0xa + 100 (0x8995); gate off for mode byte +2 = 0, else on (0x89c0).
 *  - The sample player: 0x8bdf sets the speaker bits, puts timer channel 2 in one-shot mode and
 *    makes timer channel 0 interrupt every 0x37 (or 0x42) clocks; each interrupt of the player
 *    copy writes its output byte (copy + 2): the line goes low for byte + 1 clocks, then high.
 *  - 0x8af9, the end of a sample, switches the speaker off.
 *
 * `Speaker` keeps timer channel 2 and the two port bits and turns port writes at timer-clock
 * times into the speaker line. `SpeakerSound` is the observer of Game.tick(): before and after
 * every timer interrupt it reads memory to replay that interrupt's port writes, keeps the time
 * in timer clocks, and renders the line after every 50 Hz tick. Each output sample is the average
 * of the line over its interval; one period of the sample player counts as its average level;
 * a 10 Hz high-pass filter takes out the steady level, as a speaker's coupling does.
 */
import { CS, register_module } from './vm.js';
import * as interrupts from './interrupts.js';
import * as audio from './audio.js';

export const PIT_HZ = 1193182;                            // input clock of the timer chip
export const GAIN = 0.5;                                  // output level of a full speaker swing
export const HIGHPASS_HZ = 10.0;                          // cut-off of the output high-pass filter

export const GAME_DIVISOR = 0x5D2A;                       // timer channel 0 divisor of the 50 Hz tick
export const TONE_BIAS = 100;                             // 0x89a8: the divisor is the pitch word + 0x64
export const DIVISOR_CACHE = 0x8993;                      // 0x8995 skips a divisor equal to this word
export const LOUDEST = 0x541;                             // cs:[0x541]: the channel 0x8950 sends
export const SAMPLE_PLAYS = 0x574;                        // cs:[0x574]: a sample is playing
export const PLAYER_BYTE = 2;                             // player copy + 2: output byte of the next interrupt
export const PLAYER_PERIOD = 0x64;                        // player copy + 0x64: timer channel 0 divisor
export const LEVEL = 0, SQUARE = 1, TRAIN = 2;            // kinds of line pieces

/** Timer channel 2 and bits 0 (gate) and 1 (data) of port 0x61, driven by port writes at times
 * in timer clocks. The line is 1 while channel 2's output and the data bit are both high.
 * Channel 2 runs in mode 3 (square wave: high for ceil(N/2) clocks, low for the rest of N,
 * restarted by a control word or a rising gate; high while the gate is low or no count is
 * loaded) or mode 0 (low from the control word or a count write until N + 1 clocks after the
 * write, then high). A count of 0 is 65536. `pieces` collects the line as [start, end, kind, a,
 * b]: LEVEL with a = the level, SQUARE with a = start of the first period and b = N, TRAIN with
 * a = the period and b = the average level of each period. */
export class Speaker {
    constructor() {
        this.gate = false;
        this.data = false;
        this.mode = 3;
        this.lohi = true;
        this.high_next = false;
        this.low = 0;
        this.count = null;
        this.t_load = 0;
        this.t0 = 0;
        this.train = null;
        this.pieces = [];
    }

    /** Port 0x61 at time t: the gate (bit 0) and data (bit 1) bits. */
    port61(t, gate, data) {
        if (gate === this.gate && data === this.data) return;
        this.close(t);
        if (gate && !this.gate && this.mode === 3) this.t_load = t;   // a rising gate restarts the wave
        this.gate = gate;
        this.data = data;
    }

    /** A control word for channel 2 (port 0x43): the mode, and whether the count is written as
     * two bytes (low, high) or one; no count is loaded until the next one is written. */
    control2(t, mode, lohi) {
        this.close(t);
        this.mode = mode;
        this.lohi = lohi;
        this.high_next = false;
        this.count = null;
    }

    /** A byte written to channel 2's count (port 0x42); the count is loaded with its last byte. */
    out42(t, value) {
        if (this.lohi && !this.high_next) {
            this.low = value;
            this.high_next = true;
            return;
        }
        this.close(t);
        this.high_next = false;
        this.count = this.lohi ? (this.low | value << 8) : value;
        this.t_load = t;
    }

    /** The output byte of one sample player interrupt, written at time t, `period` clocks before
     * the next one. In the player's set-up (mode 0, one-byte count, gate and data on) it adds a
     * period to the current TRAIN, or starts a new one; otherwise it is an ordinary count write. */
    pulse(t, value, period) {
        if (this.mode !== 0 || this.lohi || !(this.gate && this.data)) {
            this.out42(t, value);
            return;
        }
        const low = value ? value + 1 : 0x10001;
        const level = 1.0 - Math.min(low, period) / period;
        let train = this.train;
        if (train === null || train[0] !== period || t !== this.t0 + train[1].length * period) {
            this.close(t);
            train = this.train = [period, []];
        }
        train[1].push(level);
        this.count = value;
        this.t_load = t;
    }

    /** 0x8bdf: gate and data on, channel 2 in mode 0 with a one-byte count. */
    sample_start(t) {
        this.port61(t, true, true);
        this.control2(t, 0, false);
    }

    /** 0x8af9: gate and data off. */
    sample_stop(t) {
        this.port61(t, false, false);
    }

    /** Turn the line up to time t into pieces: the pending TRAIN as far as its periods reach,
     * then the steady state of the channel and the port bits. */
    close(t) {
        let t0 = this.t0;
        if (this.train !== null) {
            const [period, levels] = this.train;
            this.train = null;
            const n = Math.min(levels.length, Math.ceil((t - t0) / period));
            const end = Math.min(t, t0 + n * period);
            if (n > 0 && end > t0) {
                this.pieces.push([t0, end, TRAIN, period, levels.slice(0, n)]);
                t0 = end;
            }
        }
        if (t > t0) this._state_pieces(t0, t);
        this.t0 = Math.max(this.t0, t);
    }

    /** The pieces from a to b while the ports do not change. */
    _state_pieces(a, b) {
        const add = (p) => this.pieces.push(p);
        if (!this.data) {
            add([a, b, LEVEL, 0.0, null]);
        } else if (this.mode === 3) {
            if (this.gate && this.count !== null) add([a, b, SQUARE, this.t_load, this.count || 0x10000]);
            else add([a, b, LEVEL, 1.0, null]);
        } else if (this.count === null) {
            add([a, b, LEVEL, 0.0, null]);
        } else {
            const end = this.t_load + (this.count || 0x10000) + 1;
            if (a < end) add([a, Math.min(b, end), LEVEL, 0.0, null]);
            if (b > end) add([Math.max(a, end), b, LEVEL, 1.0, null]);
        }
    }

    /** Close at time t and hand over the pieces collected so far. */
    take_pieces(t) {
        this.close(t);
        const pieces = this.pieces;
        this.pieces = [];
        return pieces;
    }
}

/** u modulo a positive n, also for negative and fractional u: 0 <= result < n. */
function mod(u, n) {
    return u - Math.floor(u / n) * n;
}

/** Integral of the line from t_start to each of the sorted times `queries`. */
export function integrate(pieces, t_start, queries) {
    const out = new Float64Array(queries.length);
    let acc = 0.0, lo = 0;
    for (const [p0, p1, kind, a, b] of pieces) {
        let hi = lo;
        while (hi < queries.length && queries[hi] <= p1) hi++;
        if (kind === LEVEL) {
            for (let i = lo; i < hi; i++) out[i] = acc + a * (queries[i] - p0);
            acc += a * (p1 - p0);
        } else if (kind === SQUARE) {
            const n = b, high = Math.floor((b + 1) / 2);
            const g = (u) => Math.floor(u / n) * high + Math.min(mod(u, n), high);
            const base = g(p0 - a);
            for (let i = lo; i < hi; i++) out[i] = acc + g(queries[i] - a) - base;
            acc += g(p1 - a) - base;
        } else {
            const levels = b;
            const cum = new Float64Array(levels.length + 1);
            let sum = 0;
            for (let k = 0; k < levels.length; k++) { sum += levels[k]; cum[k + 1] = sum * a; }
            const g = (u) => {
                const i = Math.min(Math.floor(u / a), levels.length - 1);
                return cum[i] + levels[i] * (u - i * a);
            };
            for (let i = lo; i < hi; i++) out[i] = acc + g(queries[i] - p0);
            acc += g(p1 - p0);
        }
        lo = hi;
    }
    for (let i = lo; i < queries.length; i++) out[i] = acc;
    return out;
}

/** Observer of Game.tick() (game.observer = new SpeakerSound(rate)): replays what each timer
 * interrupt sends to the PC speaker and renders the sound after every 50 Hz tick. `take()`
 * returns the samples rendered since the previous call (Float32Array, -1..1). */
export class SpeakerSound {
    constructor(rate = 44100, gain = GAIN) {
        this.speaker = new Speaker();
        this.rate = rate;
        this.gain = gain;
        this.now = 0;
        this.player = false;
        this.stepped = [];
        this.rendered = 0;
        this.t_rendered = 0;
        this.carry = 0.0;
        this.r = Math.exp(-2 * Math.PI * HIGHPASS_HZ / rate);
        this.hp_x = 0.0;
        this.hp_y = 0.0;
        this.chunks = [];
        this.noise_state = 0x41;
    }

    /** Before a timer interrupt: the tone channels the game's handler will step, and for a
     * sample player interrupt the output byte it writes. */
    interrupt(vm) {
        const m = vm.mem.m;
        const off = m[0x20] | m[0x21] << 8;
        const seg = m[0x22] | m[0x23] << 8;
        this.stepped = m[CS + SAMPLE_PLAYS] ? []
            : interrupts.CHANNELS.filter(([di]) => m[CS + di] && !(m[CS + di] & 0x80)).map(([, n]) => n);
        if (seg === interrupts.CODE_SEG && off === interrupts.TIMER_HANDLER) {
            if (this.player) {                            // 0x8af9 ran in the script pass
                this.speaker.sample_stop(this.now);
                this.player = false;
            }
            return;
        }
        const p = seg * 16 + off;                         // the player copy
        if (!this.player) {                               // 0x8bdf ran in the script pass
            this.speaker.sample_start(this.now);
            this.player = true;
        }
        const period = m[p + PLAYER_PERIOD] | m[p + PLAYER_PERIOD + 1] << 8;
        this.speaker.pulse(this.now, m[p + PLAYER_BYTE], period || 0x10000);
    }

    /** After the interrupt: the tone output (0x8950) of the loudest stepped channel, the end of a
     * sample, the time advanced by one timer period, and the sound rendered (except after a
     * player interrupt that did not reach the 50 Hz tick). */
    interrupt_done(vm, result) {
        const m = vm.mem.m;
        if ((result === 'tick' || result === 'tick+bios') && this.stepped.length && !m[CS + SAMPLE_PLAYS]) {
            const n = m[CS + LOUDEST];
            if (this.stepped.includes(n)) this.tone_output(m, interrupts.CHANNELS[n][0]);
        }
        if (result === 'stopped') {                       // the player's last byte: 0x8cf5 -> 0x8af9
            this.speaker.sample_stop(this.now);
            this.player = false;
        }
        const off = m[0x20] | m[0x21] << 8;
        const seg = m[0x22] | m[0x23] << 8;
        if (seg === interrupts.CODE_SEG && off === interrupts.TIMER_HANDLER) {
            this.now += GAME_DIVISOR;
        } else {
            const p = seg * 16 + off;
            this.now += (m[p + PLAYER_PERIOD] | m[p + PLAYER_PERIOD + 1] << 8) || 0x10000;
        }
        if (result !== 'play') this.render(this.now);
    }

    /** Code 0x8950's PC-speaker path for the tone channel record at cs:di. */
    tone_output(m, di) {
        const sp = this.speaker, t = this.now;
        sp.port61(t, sp.gate, m[CS + di + 7] !== 0);                                 // 0x896f
        sp.control2(t, 3, true);                                                    // 0x8995
        const pitch = m[CS + di + 0xA] | m[CS + di + 0xB] << 8;
        const divisor = (pitch + TONE_BIAS) & 0xFFFF;
        if (divisor !== (m[CS + DIVISOR_CACHE] | m[CS + DIVISOR_CACHE + 1] << 8)) {
            sp.out42(t, divisor & 0xFF);
            sp.out42(t, divisor >> 8);
        }
        const mode = m[CS + di + 2];                                                // 0x89c0
        if (mode === 0) {
            sp.port61(t, false, sp.data);
        } else if (!sp.gate) {
            sp.port61(t, true, sp.data);
            if (mode & 2) this.noise_divisor(pitch);
        }
    }

    /** Code 0x89ed: the pitch / 16 + 1, doubled 1..8 times (the count from port 0x41 & 7, plus 1)
     * or until bit 15 is set, as a new divisor. The port read (a free-running timer count) is
     * modelled by a pseudo-random sequence. No statement selects this mode. */
    noise_divisor(pitch) {
        this.noise_state = (this.noise_state * 1103515245 + 12345) >>> 0;
        const shifts = ((this.noise_state >>> 16) & 7) + 1;
        let ax = (pitch >> 4) + 1;
        for (let k = 0; k < shifts; k++) {
            ax = (ax << 1) & 0xFFFF;
            if (ax & 0x8000) break;
        }
        this.speaker.out42(this.now, ax & 0xFF);
        this.speaker.out42(this.now, ax >> 8);
    }

    /** Render the output samples that end by time t_end. */
    render(t_end) {
        const pieces = this.speaker.take_pieces(t_end);
        const first = this.rendered;
        const last = Math.floor(t_end * this.rate / PIT_HZ);
        const n = Math.max(0, last - first);
        const queries = new Float64Array(n + 1);
        const width = PIT_HZ / this.rate;
        for (let k = 0; k < n; k++) queries[k] = Math.min((first + 1 + k) * width, t_end);
        queries[n] = t_end;
        const f = integrate(pieces, this.t_rendered, queries);
        if (n > 0) {
            const x = new Float64Array(n);
            x[0] = (f[0] + this.carry) / width;
            for (let k = 1; k < n; k++) x[k] = (f[k] - f[k - 1]) / width;
            this.chunks.push(this._pcm(x));
            this.carry = f[n] - f[n - 1];
        } else {
            this.carry += f[0];
        }
        this.rendered = Math.max(last, first);
        this.t_rendered = t_end;
    }

    /** High-pass filter y[n] = x[n] - x[n-1] + r y[n-1], scaled to -1..1. */
    _pcm(x) {
        const out = new Float32Array(x.length);
        let px = this.hp_x, py = this.hp_y;
        const r = this.r, gain = this.gain;
        for (let k = 0; k < x.length; k++) {
            py = x[k] - px + r * py;
            px = x[k];
            out[k] = Math.max(-1, Math.min(1, py * gain));
        }
        this.hp_x = px;
        this.hp_y = py;
        return out;
    }

    /** Samples rendered since the previous call. */
    take() {
        const chunks = this.chunks;
        this.chunks = [];
        if (chunks.length === 1) return chunks[0];
        const out = new Float32Array(chunks.reduce((s, c) => s + c.length, 0));
        let at = 0;
        for (const c of chunks) { out.set(c, at); at += c.length; }
        return out;
    }

    seconds() {
        return this.now / PIT_HZ;
    }
}

register_module('audio', audio);
