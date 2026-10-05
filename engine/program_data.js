/**
 * The data the engine reads from its own code segment, for a start-up without METAL.EXE.
 *
 * The original program keeps its variables and tables in its code segment (segment 0x1040, linear
 * CS). Its variables start at zero, except for the few listed here, and the engine reads only
 * these tables of the program image as data: every other byte of the image is either written
 * before it is read or belongs to the original's machine code, which the engine does not run.
 * `install(m)` writes them into a memory image m (a Uint8Array holding the code segment at linear
 * CS); everything else of the program image stays zero.
 *
 * - Generated tables: built by a formula here, equal byte for byte to the original's tables.
 * - The game's own constants (key translation, speaker rates, the start-up palette, the display
 *   adapter answers, file names and messages): written out as they are.
 *
 * The PC-speaker sample player (0x8b4e..0x8bb7, x86 code that the original copies into every
 * sample it plays) is not here: in the data-only start-up ops_io.speaker_play writes only the
 * fields of the copy that the player model reads.
 */
import * as program_data from './program_data.js';
import { CS, register_module } from './vm.js';

export const PIT_HZ = 1193182;                            // input clock of the timer chip

/** Little-endian bytes of 16-bit words. */
function words(list) {
    const out = new Uint8Array(2 * list.length);
    list.forEach((v, k) => { out[2 * k] = v & 0xFF; out[2 * k + 1] = (v >> 8) & 0xFF; });
    return out;
}

/** Bytes of a string of character codes below 256. */
function text(s) {
    return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

// --------------------------------------------------------------------- generated tables
/** cs:0x1c04, read by the number formatter 0x1b80 (ops_flow.format_number): the words 10000,
 * 1000, 100, 10, 1. */
export function powers_of_ten() {
    const list = [];
    for (let k = 4; k >= 0; k--) list.push(10 ** k);
    return words(list);
}

/** cs:0x7de0, read by the sound conversion 0x8187 (ops_life.convert_sounds): the 16 steps of
 * the 4-bit delta code of compressed sounds, -34, -21, -13, -8, -5, -3, -2, -1, 1, 2, 3, 5, 8, 13,
 * 21, 34 (the Fibonacci numbers from 1), as signed bytes. */
export function fibonacci_deltas() {
    const fib = [1, 2];
    while (fib.length < 8) fib.push(fib[fib.length - 1] + fib[fib.length - 2]);
    return Uint8Array.from([...fib.slice().reverse().map((f) => -f & 0xFF), ...fib]);
}

export const COMPASS_X = [1, 1, 0, -1, -1, -1, 0, 1];     // eight steps, counter-clockwise from +x

/** cs:0x55fa, the built-in direction table of statement 0x5f (ops_objects.direction_table)
 * for classes without their own: a byte (entries - 1 = 25), then 26 entries of three signed
 * bytes (x, y, z steps): the eight compass steps from +x towards +y at z = 0, the same at
 * z = +1, (0, 0, +1), the same at z = -1, (0, 0, -1). */
export function directions() {
    const compass = [];
    for (let k = 0; k < 8; k++) compass.push([COMPASS_X[k], COMPASS_X[(k + 6) % 8]]);
    const entries = compass.map(([x, y]) => [x, y, 0]);
    for (const z of [1, -1]) {
        for (const [x, y] of compass) entries.push([x, y, z]);
        entries.push([0, 0, z]);
    }
    return Uint8Array.from([entries.length - 1, ...entries.flat().map((v) => v & 0xFF)]);
}

/** cs:0x90b4, read by render.edges (0x9972, 0xbb66, 0xbc68): 128 words, the entry
 * 8 * (n - 1) + k for a span of n = 1..16 pixels that starts at bit k = 0..7 of a byte: n one
 * bits from bit 15 down, shifted right by k, stored high byte first (left byte, right byte).
 * Spans that would reach past the second byte (n + k > 16; the edge routines never ask for
 * them) hold the entry of n - 8 instead. */
export function edge_masks() {
    const out = [];
    for (let n = 1; n <= 16; n++) {
        for (let k = 0; k < 8; k++) {
            const m = n + k <= 16 ? n : n - 8;
            const v = ((0xFFFF << (16 - m)) & 0xFFFF) >> k;
            out.push(v >> 8, v & 0xFF);
        }
    }
    return Uint8Array.from(out);
}

/** cs:0x91b4, read by the mirrored EGA blitters (render): every byte with its 8 bits in
 * reverse order. */
export function bit_reverse() {
    const out = new Uint8Array(256);
    for (let b = 0; b < 256; b++) {
        let r = 0;
        for (let k = 0; k < 8; k++) if (b & (1 << k)) r |= 0x80 >> k;
        out[b] = r;
    }
    return out;
}

/** cs:0xc060, read by the mirrored CGA blitters (render): every byte with its four 2-bit
 * pixels in reverse order. */
export function cga_reverse() {
    const out = new Uint8Array(256);
    for (let b = 0; b < 256; b++) out[b] = (b & 3) << 6 | (b >> 2 & 3) << 4 | (b >> 4 & 3) << 2 | b >> 6;
    return out;
}

/** cs:0xc160, read by the CGA fill (render, ops_view): colour 0..3 in all four pixels of a
 * byte. */
export function cga_fill_bytes() {
    return Uint8Array.from([0, 1, 2, 3].map((c) => 0x55 * c));
}

/** cs:0x8e40, read by the sound-device sample player set-up 0x8e6a (ops_io.device_play): the
 * timer divisor for rate r = 1..20 (r thousand interrupts a second) at word 2 * r,
 * floor(1193182 / (1000 * r)); word 0 repeats rate 1. */
export function device_divisors() {
    const list = [];
    for (let r = 0; r < 21; r++) list.push(Math.floor(PIT_HZ / (1000 * Math.max(r, 1))));
    return words(list);
}

// --------------------------------------------------------------------- the game's constants
// cs:0x78b: the keyboard interrupt 0x78b6 (interrupts.key_event) translates scancode s = 1..0x7f
// to the key at index s - 1 (cs:[0x689]); 0xfe marks Ctrl, Shift, Alt and Caps Lock (no key),
// 0xbb..0xc4 are F1..F10.
export const KEY_TABLE = Uint8Array.from([
    0x1B, 0x26, 0x82, 0x22, 0x27, 0x28, 0x60, 0x8A, 0x21, 0x87, 0x85, 0x29, 0x2D, 0x08, 0x09, 0x71,
    0x77, 0x65, 0x72, 0x74, 0x79, 0x75, 0x69, 0x6F, 0x70, 0x5E, 0x24, 0x0D, 0xFE, 0x61, 0x73, 0x64,
    0x66, 0x67, 0x68, 0x6A, 0x6B, 0x6C, 0x3B, 0x97, 0xE6, 0xFE, 0x3C, 0x7A, 0x78, 0x63, 0x76, 0x62,
    0x6E, 0x6D, 0x3B, 0x2E, 0x2F, 0xFE, 0x2A, 0xFE, 0x20, 0xFE, 0xBB, 0xBC, 0xBD, 0xBE, 0xBF, 0xC0,
    0xC1, 0xC2, 0xC3, 0xC4, 0xFF, 0xFF, 0x37, 0x38, 0x39, 0x2D, 0x34, 0x35, 0x36, 0x2B, 0x31, 0x32,
    0x33, 0x30, 0x2E, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
    0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
]);

// cs:0x8ade: the PC-speaker sample player's output pattern for rate 1..20 (ops_io.speaker_play):
// the player rotates it once per timer interrupt and plays the next sample byte when a one bit
// comes out, so a pattern with more one bits plays faster.
export const SPEAKER_PATTERNS = Uint8Array.from([
    0x01, 0x01, 0x11, 0x11, 0x11, 0x1A, 0x1A, 0x1A, 0xAA, 0xAA, 0xAB, 0xAB, 0xBB, 0xBB, 0xBF, 0xBF,
    0xBF, 0xFF, 0xFF, 0xFF,
]);

// cs:0x9494: the 16 colours the EGA/VGA mode set programs (0x93cc: attribute registers 0x94b4 or
// the DAC 0x9592); words of byte 0 red, byte 1 green << 4 | blue, levels 0..7. render.palette and
// game.screen show them until the game sends a palette of its own.
export const START_PALETTE = Uint8Array.from([
    0x00, 0x00, 0x00, 0x03, 0x00, 0x30, 0x00, 0x33, 0x03, 0x00, 0x03, 0x03, 0x04, 0x20, 0x03, 0x33,
    0x01, 0x11, 0x00, 0x07, 0x00, 0x70, 0x00, 0x77, 0x07, 0x00, 0x00, 0x00, 0x07, 0x70, 0x07, 0x77,
]);

// cs:0x9300: the display adapter detection 0x9320 (boot.detect_adapter) turns the display
// combination code c = 0..0xc of INT 10h AX=1A00h into the word at 2 * c: display type (low byte;
// 5 = VGA) and monitor (high byte).
export const DISPLAY_CODES = Uint8Array.from([
    0x00, 0x00, 0x01, 0x01, 0x02, 0x02, 0x00, 0x00, 0x03, 0x03, 0x03, 0x01, 0x00, 0x00, 0x05, 0x04,
    0x05, 0x05, 0x00, 0x00, 0x04, 0x03, 0x04, 0x04, 0x04, 0x05,
]);

// cs:0x931a: the monitor code for EGA switch settings 0..0xb (index switches / 2) when INT 10h
// AH=12h BL=10h answers (boot.detect_adapter).
export const EGA_MONITORS = Uint8Array.from([0x02, 0x03, 0x01, 0x02, 0x03, 0x01]);

// cs:0x8d74..0x8d77: what the sound-device output 0x8950 last sent (pitch word, volume byte, mode
// byte); 0xff means nothing yet, so the first tone is always sent (interrupts.channel_output).
export const DEVICE_SENT = Uint8Array.from([0xFF, 0xFF, 0xFF, 0xFF]);

// Strings: file names, the path separator and the texts the engine prints.
export const STRINGS = [
    [0x609, text('\\')],                                  // path separator (0x7270, change_level 0x63ee)
    [0x6442, text('main.io\0')],                          // level file of statement 0x45 class 0 (0x63ee)
    [0x65EA, text('MAIN.IO\0')],                          // first class, loaded by the start-up (0x63d3)
    [0x71EA, text('blancpc.io\0')],                       // noise sample (0x71f5)
    [0x75EB, text('NOT ENOUGH MEMORY [A]bort [C]ontinue    $')],   // low-memory prompt (0x75bf)
    [0x85FC, text('Erreur\0')],                           // fatal error 0x85c2: "Erreur", the code,
    [0x8603, text(' :\0')],                               // " :" and the message of the table below
];

// cs:0x87c3: the fatal error routine 0x85c2 (ops_io.fatal_error) prints the text the word at
// 2 * code points to; codes 0..13 have an entry (code 13 points at the zero byte before the table).
export const ERROR_TABLE = 0x87C3;
export const ERROR_MESSAGES = [
    [0x8606, '...'],
    [0x860A, 'open'],
    [0x86B2, 'Erreur fatale, formattage imprimante en cours'],
    [0x86E0, 'Erreur  fatale,microprocesseur fondu'],
    [0x876C, "Erreur fatale, l'ecran va exploser"],
    [0x8637, "trop d'entites vivantes"],
    [0x864F, 'programme main attendu'],
    [0x8666, 'write'],
    [0x866C, 'create'],
    [0x8673, 'del'],
    [0x8677, 'trop de sprites'],
    [0x8687, 'debordement programmes'],
    [0x869E, 'debordement entites'],
    [0x87C2, ''],
];

/** Every table as [code-segment offset, bytes, name], in address order. */
export function tables() {
    const out = [
        [0x1C04, powers_of_ten(), 'powers of ten'],
        [0x55FA, directions(), 'built-in directions'],
        [0x7DE0, fibonacci_deltas(), 'sound delta steps'],
        [0x90B4, edge_masks(), 'EGA edge masks'],
        [0x91B4, bit_reverse(), 'bit reversal'],
        [0xC060, cga_reverse(), 'CGA pixel reversal'],
        [0xC160, cga_fill_bytes(), 'CGA fill bytes'],
        [0x8E40, device_divisors(), 'sound-device timer divisors'],
        [0x78B, KEY_TABLE, 'key translation'],
        [0x8ADE, SPEAKER_PATTERNS, 'speaker rate patterns'],
        [0x9494, START_PALETTE, 'start-up palette'],
        [0x9300, DISPLAY_CODES, 'display combination codes'],
        [0x931A, EGA_MONITORS, 'EGA monitor codes'],
        [0x8D74, DEVICE_SENT, 'sound-device output state'],
        [ERROR_TABLE, words(ERROR_MESSAGES.map(([a]) => a)), 'fatal error messages'],
    ];
    for (const [a, s] of STRINGS) out.push([a, s, 'string']);
    for (const [a, s] of ERROR_MESSAGES) if (s.length) out.push([a, text(s + '\0'), 'fatal error message']);
    return out.sort((x, y) => x[0] - y[0]);
}

/** Write every table into the memory image m (code segment at linear CS). */
export function install(m) {
    for (const [off, data] of tables()) m.set(data, CS + off);
}

register_module('program_data', program_data);
