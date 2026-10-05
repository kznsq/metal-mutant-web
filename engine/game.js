/**
 * The game loop: Metal Mutant run frame by frame on the engine.
 *
 * The engine starts from the game's data files (boot.js; METAL.EXE is not needed), then repeats
 * what the original's scheduler does: one script pass over all objects (script_pass), the
 * frame-rate wait, and the frame end (frame_end.js), which brings the screen up to date. Between
 * passes the hardware interrupts are applied (interrupts.js): key presses and releases, and timer
 * ticks at 50 Hz.
 *
 * Timing: the original waits at the frame end until the timer has counted cs:[0x512] ticks since
 * the previous frame end. Here a frame advances exactly the ticks that wait needs (at least one),
 * as on a machine fast enough to finish every pass and frame end within one tick. While a sample
 * plays on the PC speaker, a tick runs the copied sample player until it chains to the game's
 * timer handler, so the sample advances in step with the game.
 */
import { CS, ProgramExit, register_module, require_module, script_pass } from './vm.js';
import * as interrupts from './interrupts.js';
import * as frame_end from './frame_end.js';
import * as render from './render.js';
import * as game from './game.js';

export const TICK_SECONDS = 0.02;                         // the game programs the timer at 50 Hz

export class Game {
    constructor(display = 3, machine = null) {
        this._init(require_module('boot').boot_vm(display, machine));
    }

    /** A Game around an existing VM: everything the constructor does after boot_vm. */
    static from_vm(vm) {
        const g = Object.create(Game.prototype);
        g._init(vm);
        return g;
    }

    _init(vm) {
        this.vm = vm;
        this.vm.key_source = () => this._typed_key();
        this.vm.shift_flags = this.vm.mem.r8(0x417);      // INT 16h AH=02h returns this BIOS byte
        this.typed = [];                                  // translated keys for text-input statements
        this.frame = 0;
        this.ticks = 0;
        this.observer = null;                             // see tick(), e.g. audio.SpeakerSound
    }

    // ----------------------------------------------------------------------------- input
    /** A key press or release: the byte from the keyboard controller goes to the game's keyboard
     * interrupt 0x78b6, then to the BIOS keyboard handler it chains to (the shift-state byte
     * 0040:0017). */
    key(scancode, down = true) {
        if (interrupts.key_event(this.vm, scancode, down)) {
            interrupts.bios_keyboard(this.vm, scancode, down);
        }
        this.vm.shift_flags = this.vm.mem.r8(0x417);
    }

    /** Keys for the statements that read a line of text (0xb0, 0xb1); Enter ends a line. */
    type_text(text) {
        for (const c of text.replace(/\n/g, '\r')) this.typed.push(c.charCodeAt(0));
    }

    /** The default vm.key_source: the next key given to type_text; without one the run ends
     * (ProgramExit). */
    _typed_key() {
        if (!this.typed.length) {
            throw new ProgramExit('a text-input statement is waiting for keys (Game.type_text)');
        }
        return this.typed.shift();
    }

    // ----------------------------------------------------------------------------- time
    /** One 50 Hz timer tick: the game's handler 0x70e1, or while a sample plays on the PC speaker
     * the copied player's interrupts up to the one that chains to 0x70e1. A handler that passes
     * the interrupt on runs the BIOS tick count too.
     *
     * An observer (this.observer) sees every interrupt: observer.interrupt(vm) before the handler
     * runs and observer.interrupt_done(vm, result) after it, with result 'tick' or 'tick+bios'
     * (0x70e1 ran, directly or chained from the player, and did not or did pass the interrupt
     * on), 'play' (a player interrupt that did not chain) or 'stopped' (the sample ended). */
    tick() {
        const vm = this.vm;
        const observer = this.observer;
        this.ticks += 1;
        for (;;) {
            const [seg, off] = interrupts.timer_vector(vm.mem);
            if (observer) observer.interrupt(vm);
            let result;
            if (seg === interrupts.CODE_SEG && off === interrupts.TIMER_HANDLER) {
                result = interrupts.timer_tick(vm) ? 'tick+bios' : 'tick';
            } else {
                result = interrupts.sample_tick(vm);
            }
            if (result === 'tick+bios') interrupts.bios_timer(vm);
            if (observer) observer.interrupt_done(vm, result);
            if (result !== 'play') return;
        }
    }

    // ----------------------------------------------------------------------------- frames
    /** One frame: a script pass, the frame-rate wait, the frame end. Returns the ticks the frame
     * took. */
    step() {
        const vm = this.vm;
        script_pass(vm);
        let ticks = 0;
        while (ticks === 0 || vm.g8(0x513) < vm.g8(0x512)) {   // 0x2d1b: wait for cs:[0x512] ticks
            this.tick();
            ticks += 1;
        }
        frame_end.frame_end(vm);
        this.frame += 1;
        return ticks;
    }

    /** The displayed picture: [colour indices (200 rows of 320 pixels), palette (16 RGB colours
     * in 48 bytes; on CGA the four colours of CGA palette 1)]. */
    screen() {
        const vm = this.vm;
        if (vm.g8(0x422) === 0) return [render.cga_page(vm.mem), render.cga_rgb(1)];
        let dac = vm.dac ?? null;
        if (dac === null) {                               // no palette sent yet: the start-up one
            const a = CS + render.EGA_PALETTE_TABLE;
            dac = vm.mem.m.slice(a, a + 32);
        }
        return [vm.video.page(render.PAGE_DISPLAY).slice(), render.palette(vm.mem, dac)];
    }

    /** Sound events since the last call (tones, samples, music), as ops_io records them. */
    sounds() {
        const log = this.vm.sound_log ?? [];
        this.vm.sound_log = [];
        return log;
    }
}

/** Key events from text "FRAME:SCANCODE:HOLD,..." (decimal or 0x numbers): a press at FRAME
 * and a release HOLD frames later, as [frame, scancode, down] sorted by frame. */
export function parse_keys(text) {
    const events = [];
    for (const item of (text || '').split(',').map((t) => t.trim()).filter((t) => t)) {
        const [at, sc, hold] = item.split(':').map((v) => Number(v.trim()));
        events.push([at, sc, true], [at + hold, sc, false]);
    }
    return events.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (Number(a[2]) - Number(b[2])));
}

register_module('game', game);
