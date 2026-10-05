/**
 * Start-up of the engine up to the first script pass, from the game's data files only:
 * METAL.EXE is not read.
 *
 * `boot(display)` returns the memory image (2 MB; the PSP at segment 0xff0, the engine's segment
 * at 0x1040) at the point where the original's scheduler reaches the first object (0x15aa with
 * cs:[0x381] = 0); `boot_vm(display)` returns a VM on that image, ready for script_pass. It is
 * built in three steps (`data_start`):
 *
 * 1. What DOS sets up for a program besides the program itself: interrupt vectors, the BIOS bytes,
 *    the PSP at segment 0xff0 (`load_environment`).
 * 2. The engine's code segment 0x1040 (code offset X at linear 0x10400 + X): zero, except for the
 *    tables the engine reads as data (program_data.js: generated tables and the game's constants).
 * 3. The engine start-up 0x1554 (`engine_start`): 0x7270 (DOS, BIOS and hardware set-up, the
 *    noise sample, the display, sound, timer calibration, joystick, mouse, screen), 0x8a9a (tone
 *    channels), 0x63d3 (MAIN.IO loaded as the level, object 0 created), 0x156c (string buffers,
 *    cs:[0x381] = 0) and the jump to 0x15aa. The original's display menu (text, one key) is not
 *    shown: the display is chosen directly (`display_choice`).
 *
 * The original program's machine code is not in memory, so the PC-speaker player that 0x8bdf
 * copies into each sample is not copied either (vm.player_template = false, ops_io.speaker_play).
 * Otherwise the memory equals what the original builds from METAL.EXE.
 *
 * DOS, BIOS and hardware become `Machine`: its fields are the answers the start-up code gets, and
 * `Machine.log` records the services it asks for (video modes, text output, key waits). The
 * defaults describe a PC with EGA, 640 KB, current drive C: and no mouse, joystick or sound
 * device. Files are read through ops_io (0x6ff1: the save directory) and ops_life (level
 * loader: the game directory); the game directory is never written. Interrupts that happen during
 * the start-up run through interrupts.js. The machine stack (0x10000-0x10400) is not modelled.
 */
import * as boot_module from './boot.js';
import * as INT from './interrupts.js';
import * as F from './ops_flow.js';
import * as IO from './ops_io.js';
import * as LIFE from './ops_life.js';
import * as program_data from './program_data.js';
import {
    CS, EngineHang, Memory, NotImplementedError, ProgramExit, EngineTypeError, VM, ValueError,
    floordiv, hex, register_module, s16,
} from './vm.js';

export const MEMSZ = 0x200000;
export const PSP_SEG = 0xFF0;
export const CODE_SEG = CS >> 4;
export const IRET_STUB = 0x7F0;
export const ENGINE_END = 0xD255;                         // end of the engine image; buffers start at the next paragraph
export const SPEED_LOOP = 0x7FFF;                         // the speed loop's counter stops here (0x76f5)

export const SCAN_F1 = 0x3B, SCAN_F2 = 0x3C, SCAN_F10 = 0x44;


export function u16(v) {
    return v & 0xFFFF;
}

export function s8(v) {
    v &= 0xFF;
    return v >= 128 ? v - 256 : v;
}

// The upper half of code page 437 (bytes 0x80-0xff); the lower half is ASCII.
const CP437_HIGH =
    'ÇüéâäàåçêëèïîìÄÅ' +
    'ÉæÆôöòûùÿÖÜ¢£¥₧ƒ' +
    'áíóúñÑªº¿⌐¬½¼¡«»' +
    '░▒▓│┤╡╢╖╕╣║╗╝╜╛┐' +
    '└┴┬├─┼╞╟╚╔╩╦╠═╬╧' +
    '╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀' +
    'αßΓπΣσµτΦΘΩδ∞φε∩' +
    '≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

/** Text of the bytes in code page 437, the PC's character set. */
export function _cp437(bytes) {
    let s = '';
    for (let k = 0; k < bytes.length; k++) {
        const b = bytes[k];
        s += b < 0x80 ? String.fromCharCode(b) : CP437_HIGH[b - 0x80];
    }
    return s;
}

/** The bytes of a Machine byte field (Uint8Array or array of byte values); a string, which has
 * no defined encoding, raises TypeError. */
function _bytes(v) {
    if (typeof v === 'string') throw new EngineTypeError('machine byte fields take byte values, not a string');
    return Uint8Array.from(v);
}

/** Hexadecimal with the prefix 0x (after the sign for negative values), for messages. */
function _hex_alt(v) {
    return v < 0 ? '-0x' + (-v).toString(16) : '0x' + v.toString(16);
}


// --------------------------------------------------------------------- the machine
/** DOS, the BIOS and the hardware as the start-up code sees them (defaults in brackets).
 *
 * adapter        'ega' (INT 10h AH=12h answers, AX=1A00h is unsupported) [default], 'vga'
 *                (AX=1A00h answers with display code 8), 'cga', 'hercules', 'mda', 'none'
 *                (no BIOS or port answers: type 0, which the start-up turns into CGA)
 * ega_switches   CL of INT 10h AH=12h BL=10h (switch settings; picks the EGA monitor type) [0]
 * ega_memory     BL of the same call (0 = 64K ... 3 = 256K): cs:[0x41f] [3]
 * bios_video_mode byte 0040:0049 when the display set-up reads it (7 = monochrome text) [0]
 * memory_kb      INT 12h [640]
 * drive          INT 21h AH=19h (0 = A:) [2, drive C:]
 * country        AL after INT 21h AH=38h AL=0; null leaves AL = 0 [null]
 * country_info   bytes DOS writes to the buffer cs:0x70c1 [none]
 * command_line   PSP command tail (options s, j, m: no samples, joystick flag, no mouse) [empty]
 * mouse          a mouse driver answers INT 33h [false]
 * joystick       null (port 0x201 reads 0xff) or the four axis timings returned by 0x7bc7
 *                (null for an axis that times out) [null]
 * sound_device   an AdLib-compatible card answers at port 0x388 [false]
 * pit_count      start of the timer channel 0 count model (ops_io.pit_byte) [0]
 * speed_count    iterations the speed loop 0x76eb makes in two timer ticks (cs:[0x518] =
 *                count / 40) [21388]
 * ticks          50 Hz timer interrupts from the speed measurement to the first pass;
 *                cs:[0x513] counts them [35; machine_for gives 34 on the CGA path]
 * clock          BIOS tick count 0040:006c when the start-up takes over the timer, the time of
 *                day [0x98]. It goes up whenever the game's timer handlers pass an interrupt on
 *                to the BIOS (interrupts.bios_timer); scripts read it to seed the random
 *                generator (statement 0x2a)
 * old_vector     what every interrupt vector holds before the program runs ([segment, offset])
 *                [0000:07f0, an IRET]
 * low_memory_key scancode answered to the "NOT ENOUGH MEMORY" prompt (0x2e 'c' continues) [0x2e]
 *
 * `new Machine({adapter: 'vga', ...})` overrides the defaults; an unknown setting raises
 * TypeError. */
export class Machine {
    constructor(settings = {}) {
        this.adapter = 'ega';
        this.ega_switches = 0;
        this.ega_memory = 3;
        this.bios_video_mode = 0;
        this.memory_kb = 640;
        this.drive = 2;
        this.country = null;
        this.country_info = new Uint8Array(0);
        this.command_line = new Uint8Array(0);
        this.mouse = false;
        this.joystick = null;
        this.sound_device = false;
        this.pit_count = 0;
        this.speed_count = 21388;
        this.ticks = 35;
        this.clock = 0x98;
        this.old_vector = [0, IRET_STUB];
        this.low_memory_key = 0x2E;
        for (const [k, v] of Object.entries(settings)) {
            if (!(k in this)) throw new EngineTypeError(`unknown machine setting ${k}`);
            this[k] = v;
        }
        this.log = [];
    }

    note(service, detail = '') {
        this.log.push([service, detail]);
    }
}


// Start-up timer ticks (Machine.ticks) by display type where they differ from 35: CGA takes 34.
export const START_TICKS = new Map([[2, 34]]);

/** A machine on which choosing `display` in the start menu is possible, with the default
 * start-up timing for that display. */
export function machine_for(display) {
    if (display === 5) return new Machine({adapter: 'vga'});
    if (display === 0x80) return new Machine({adapter: 'hercules', bios_video_mode: 7});
    return new Machine({ticks: START_TICKS.get(display) ?? 35});
}


// --------------------------------------------------------------------- memory helpers
/** Linear memory with segment:offset access (16-bit offsets wrap inside the segment). */
export class Image {
    constructor(size = MEMSZ) {
        this.m = new Uint8Array(size);
        this._mem = Memory.wrap(this.m);                   // the address rules of memory.js
    }

    r8(seg, off) {
        return this._mem.r8(seg * 16 + u16(off));
    }

    w8(seg, off, v) {
        this._mem.w8(seg * 16 + u16(off), v & 0xFF);
    }

    r16(seg, off) {
        return this.r8(seg, off) | this.r8(seg, off + 1) << 8;
    }

    w16(seg, off, v) {
        this.w8(seg, off, v);
        this.w8(seg, off + 1, v >> 8);
    }

    vector(n) {
        return [this.r16(0, 4 * n + 2), this.r16(0, 4 * n)];
    }

    set_vector(n, seg, off) {
        this.w16(0, 4 * n, off);
        this.w16(0, 4 * n + 2, seg);
    }
}


// --------------------------------------------------------------------- DOS environment
/** What DOS EXEC sets up besides the program: every interrupt vector = machine.old_vector,
 * where an IRET is placed, the BIOS video mode byte and tick count, the PSP (INT 20h at +0, the
 * command tail at +0x80); the current directory is the game directory (the root of ops_life's
 * drive). */
export function load_environment(img, machine) {
    LIFE.DOS.cwd = [];
    const [seg, off] = machine.old_vector;
    for (let n = 0; n < 256; n++) img.set_vector(n, seg, off);
    img.w8(seg, off, 0xCF);
    img.w8(0x40, 0x49, machine.bios_video_mode);
    img.w16(0x40, 0x6C, machine.clock & 0xFFFF);
    img.w16(0x40, 0x6E, Math.floor(machine.clock / 0x10000));
    img.w8(PSP_SEG, 0, 0xCD);
    img.w8(PSP_SEG, 1, 0x20);
    const tail = _bytes(machine.command_line).slice(0, 126);
    img.w8(PSP_SEG, 0x80, tail.length);
    [...tail, 0x0D].forEach((b, k) => img.w8(PSP_SEG, 0x81 + k, b));
}


// --------------------------------------------------------------------- the engine's start-up
/** A VM on the image (sharing its bytes), with the machine's timer count model. */
export function start_vm(img, machine) {
    const vm = new VM(INT.memory_of(img.m), 0);
    vm.pit_count = machine.pit_count;
    return vm;
}

/** One timer interrupt: the handler the vector points at, then the BIOS handler when the
 * game's handler passes the interrupt on. */
export function timer_interrupt(vm) {
    if (INT.dispatch_timer(vm)) INT.bios_timer(vm);
}

/** INT 21h AH=35h / AH=25h: keep vector n at cs:[save] (offset, segment) and point it at
 * 1040:handler. */
export function swap_vector(vm, n, save, handler) {
    const seg = vm.mem.r16(4 * n + 2), off = vm.mem.r16(4 * n);
    vm.sg16(save, off);
    vm.sg16(save + 2, seg);
    vm.mem.w16(4 * n, handler);
    vm.mem.w16(4 * n + 2, CODE_SEG);
}

/** 0x7534: the original restores timer, video mode, sound and keyboard and ends with INT 21h
 * AX=4C00h; here the run ends with ProgramExit. */
export function exit_program(vm, why) {
    throw new ProgramExit(why);
}

/** 0x7270-0x733e: the PSP command tail (DS = PSP): a letter at PSP:0082, 0083 or 0084 (as far
 * as the length byte PSP:0080 reaches) sets cs:[0x51b] for s/S (no digitised sound), cs:[0x51a]
 * for j/J (joystick flag), cs:[0x51c] for m/M (no mouse). */
export function command_options(vm, machine) {
    const n = s8(vm.mem.r8(PSP_SEG * 16 + 0x80));
    const letters = [];
    for (let k = 0; k < 3; k++) if (n >= k + 2) letters.push(vm.mem.r8(PSP_SEG * 16 + 0x82 + k));
    for (const [flag, letter] of [[0x51B, 0x73], [0x51A, 0x6A], [0x51C, 0x6D]]) {
        if (letters.includes(letter) || letters.includes(letter - 0x20)) vm.sg8(flag, 1);
    }
}

/** INT 21h AH=47h DL=0 to cs:0x60c: the current directory of ops_life.DOS (the level loader's
 * drive), without drive and leading backslash. */
export function current_directory(vm, machine) {
    const text = LIFE.DOS.cwd.join('\\').toUpperCase();
    const path = [];
    for (let k = 0; k < text.length; k++) {
        const c = text.charCodeAt(k);
        if (c > 0xFF) throw new ValueError(`character 0x${hex(c)} at position ${k} of the current directory has no single-byte code`);
        path.push(c);
    }
    path.push(0);
    path.forEach((b, k) => vm.sg8(0x60C + k, b));
}

/** 0x71f5: open blancpc.io (cs:0x71ea, 0x6ff1 with AX = 2), read up to 0x9c4 bytes to far
 * cs:[0x582] (0x7073), close (0x7041). The noise sample starts at +0x36: cs:[0x586]:[0x588]
 * and cs:[0x58a]:[0x58c] point at it, the second 0xa0 paragraphs higher, where a quieter copy
 * is made: 0x74 header bytes as they are, then 0x98c bytes each moved towards 0x20 by
 * (b - 0x20) >> 2 (signed; zero bytes stay zero). The copy reads past the 0x834 bytes of the
 * file into whatever memory follows. */
export function load_noise(vm, machine) {
    const name = CS + 0x71EA;
    IO.open_file_routine(vm, name, 2, 0);
    const seg = vm.g16(0x584), off = vm.g16(0x582);
    const [ok, n] = IO.dos_read(vm, vm.g16(0x435), seg * 16 + off, 0x9C4);
    if (!ok) IO.fatal_error(vm, 0xD);
    IO.close_file(vm);
    machine.note('file', `${F.latin1(F.cstring(vm, name))}: ${n} bytes at ${hex(seg, 4)}:${hex(off, 4)}`);
    vm.sg16(0x586, off + 0x36);
    vm.sg16(0x58A, off + 0x36);
    vm.sg16(0x588, seg);
    vm.sg16(0x58C, seg + 0xA0);
    const src = seg * 16;
    const dst = (seg + 0xA0) * 16;
    let si = u16(off + 0x36), di = si;
    const m = vm.mem;
    for (let k = 0; k < 0x74; k++) {
        m.w8(dst + di, m.r8(src + si));
        si = u16(si + 1);
        di = u16(di + 1);
    }
    for (let k = 0; k < 0x98C; k++) {
        let b = m.r8(src + si);
        if (b) b = ((s8(b - 0x20) >> 2) + 0x20) & 0xFF;
        m.w8(dst + di, b);
        si = u16(si + 1);
        di = u16(di + 1);
    }
}

/** 0x7617: INT 21h AH=38h AL=0 (country information to cs:0x70c1). cs:[0x534] = 0 for AL =
 * 0x21 or 0x20 (France, Belgium), 2 for 0x31, 0x29, 0x2b (Germany, Switzerland, Austria),
 * else 1; any value but 1 leaves the program (jmp 0x7534). */
export function country_check(vm, machine) {
    _bytes(machine.country_info).forEach((b, k) => vm.sg8(0x70C1 + k, b));
    const al = machine.country != null ? machine.country : 0;
    machine.note('INT 21h AH=38h', `AL = 0x${hex(al, 2)}`);
    if (al === 0x21 || al === 0x20) vm.sg8(0x534, 0);
    else if (al === 0x31 || al === 0x29 || al === 0x2B) vm.sg8(0x534, 2);
    else vm.sg8(0x534, 1);
    if (vm.g8(0x534) !== 1) exit_program(vm, 'country check 0x7617');
}

/** 0x75bf: cursor home, "NOT ENOUGH MEMORY [A]bort [C]ontinue" (cs:0x75eb, INT 21h AH=9),
 * then cs:[0x689] is polled (no wait for a release) until 'a'/'A' (leave) or 'c'/'C'. */
export function low_memory_prompt(vm, machine) {
    const text = vm.mem.m.slice(CS + 0x75EB, CS + 0x7700);
    const end = text.indexOf(0x24);
    machine.note('INT 21h AH=09h', _cp437(end < 0 ? text : text.subarray(0, end)));
    INT.key_event(vm.mem, machine.low_memory_key, true);
    const key = vm.g8(0x689);
    INT.key_event(vm.mem, machine.low_memory_key, false);
    if (key === 0x61 || key === 0x41) exit_program(vm, 'not enough memory');
    if (!(key === 0x63 || key === 0x43)) throw new EngineHang("the memory prompt waits for 'a' or 'c'");
}


// The display type word (AL type, AH monitor) that the port probes of 0x9320 give per adapter.
export const ADAPTER_PORTS = new Map([['cga', 0x0202], ['mda', 0x0101], ['hercules', 0x8001], ['none', 0]]);

/** 0x9320 (via 0x8385): cs:[0x908a] = 0, then the display type in AL (and a monitor code in
 * AH) into cs:[0x908a]: INT 10h AX=1A00h answering AL = 1Ah gives the word at cs:0x9300 +
 * 2 * display code; else INT 10h AH=12h BL=10h answering BL != 10h gives AL = 3, AH = byte
 * cs:0x931a + switches / 2; else the CRT controller probes (0xbb4a at 0x3d4: colour, 0x0202;
 * at 0x3b4 with the 0x3ba status bits: MDA 0x0101, Hercules 0x8001/0x8101, InColor 0x8203;
 * no answer at either port: cs:[0x908a] stays 0). Returns AL. */
export function detect_adapter(vm, machine) {
    vm.sg16(0x908A, 0);
    let ax;
    if (machine.adapter === 'vga') ax = vm.g16(0x9300 + 2 * 8);
    else if (machine.adapter === 'ega') ax = 0x0003 | vm.g8(0x931A + ((machine.ega_switches & 0xFF) >> 1)) << 8;
    else if (ADAPTER_PORTS.has(machine.adapter)) ax = ADAPTER_PORTS.get(machine.adapter);
    else throw new NotImplementedError(`adapter ${machine.adapter}`);
    vm.sg16(0x908A, ax);
    machine.note('display detection', `${machine.adapter}: AX = 0x${hex(ax, 4)}`);
    return ax & 0xFF;
}


export const MENU_NAMES = new Map([[0x10, 0x35], [0x11, 0x40], [3, 0x4D]]);

/** The display menu's outcome without the menu: what the key that menu_key picks for `display`
 * would set, cs:[0x24] = 2 (F1), the detected type (F2) or 3 (F10 on VGA). The menu's text and
 * its key wait leave no other trace in memory. */
export function display_choice(vm, machine, display) {
    if (display === 2) {
        vm.sg16(0x24, 2);
    } else if (vm.g16(0x24) === 5 && display === 3) {
        vm.sg16(0x24, 3);
    } else if (display !== vm.g16(0x24)) {
        throw new ValueError(`display type ${_hex_alt(display)} cannot be chosen in the menu of type `
                             + _hex_alt(vm.g16(0x24)));
    }
    machine.note('display menu', `not shown: display type ${_hex_alt(vm.g16(0x24))} chosen`);
}

/** 0x83a2: cs:[0x24] = detected type. CGA (2) and Hercules (0x80) go straight on; types
 * 0x10 (Tandy), 0x11 (Amstrad), 3 (EGA), 4/5 (VGA, cs:[0x24] = 5) get the original's menu (keys
 * F1 -> cs:[0x24] = 2, F2 keeps the type, on VGA F10 -> 3), here display_choice. Other types
 * become 2. Then 0x8467: cs:[0x422] = cs:[0x423] = 0; BIOS mode 7 (0040:0049) -> Hercules
 * set-up 0x8544, cs:[0x24] = 0x80; type 2 -> INT 10h mode 4; otherwise cs:[0x422] = 1, types
 * 4/5 -> cs:[0x423] = 1 and 5, cs:[0x41f] = EGA memory (INT 10h AH=12h BL=10h) and 0x93b8. */
export function display_setup(vm, machine, display) {
    const kind = detect_adapter(vm, machine);
    vm.sg16(0x24, kind);
    if (!(kind === 2 || kind === 0x80)) {
        let name = MENU_NAMES.get(kind) ?? null;
        if (name === null && (kind === 4 || kind === 5)) {
            name = 0x52;
            vm.sg16(0x24, 5);
        }
        if (name !== null) {
            display_choice(vm, machine, display);
        } else {
            vm.sg16(0x24, 2);
        }
    }
    vm.sg8(0x422, 0);
    vm.sg8(0x423, 0);
    if (vm.mem.r8(0x449) === 7) {
        hercules_setup(vm, machine);
        vm.sg16(0x24, 0x80);
        return;
    }
    if (vm.g16(0x24) === 2) {
        machine.note('INT 10h AX=0004h', 'CGA 320x200, 4 colours');
        vm.sg16(0x24, 2);
        return;
    }
    vm.sg8(0x422, 1);
    if (vm.g16(0x24) === 4 || vm.g16(0x24) === 5) {
        vm.sg8(0x423, 1);
        vm.sg16(0x24, 5);
    }
    vm.sg8(0x41F, machine.ega_memory);
    machine.note('INT 10h AX=000Dh', 'EGA 320x200, 16 colours; palette ' +
                 (vm.g8(0x423) === 1 ? 'DAC 0x9592' : 'attribute registers 0x94b4') + ' from cs:0x9494');
}

/** 0x8544: Hercules graphics registers (ports 0x3b4/0x3b5 from cs:0x859f, 0x3bf, 0x3b8),
 * BIOS mode byte 0040:0049 = 4, equipment byte 0040:0010 bit 4 cleared, video memory
 * b000:0000 cleared (REP STOSW of 0xfffe words: the offset wraps inside the segment), and
 * cs:[0x51c] = 1 (no mouse). */
export function hercules_setup(vm, machine) {
    vm.mem.w8(0x449, 4);
    vm.mem.w8(0x410, vm.mem.r8(0x410) & 0xEF);
    let di = 0;
    for (let k = 0; k < 0xFFFE; k++) {
        vm.mem.w16(0xB0000 + di, 0);
        di = u16(di + 2);
    }
    vm.sg8(0x51C, 1);
    machine.note('Hercules', 'graphics mode registers');
}

/** 0x8ab0: tone channel record cs:di: state, mode, priority, volume word and pitch low byte
 * cleared. */
export function init_channel(vm, di) {
    vm.sg8(di, 0);
    vm.sg8(di + 2, 0);
    vm.sg8(di + 1, 0);
    vm.sg16(di + 6, 0);
    vm.sg8(di + 0xA, 0);
}

/** 0x8a9a: the three tone channel records cs:0x8ff, 0x90d, 0x91b. */
export function init_channels(vm) {
    for (const di of [0x8FF, 0x90D, 0x91B]) init_channel(vm, di);
}

/** 0x8a1c: interrupt 0Fh -> 1040:8a15 (old vector at cs:[0x8808]), timer channel 2 mode,
 * the tone channels (0x8a9a), the game's timer vector and divisor for the sample players
 * (cs:[0x87fa] = 1040:70e1, cs:[0x87fe] = 0x5d2a), then 0x880d: cs:[0x87e0] = 1 and bit 0x20
 * of cs:[0x516] when 0x8cff finds an AdLib (timer registers 4 at port 0x388: status bits 0xe0
 * clear after a reset, 0xc0 after timer 1 ran). */
export function sound_setup(vm, machine) {
    swap_vector(vm, 0x0F, 0x8808, 0x8A15);
    init_channels(vm);
    vm.sg16(0x87FA, INT.TIMER_HANDLER);
    vm.sg16(0x87FC, CODE_SEG);
    vm.sg16(0x87FE, 0x5D2A);
    vm.sg8(0x87E0, 0);
    if (machine.sound_device) {
        vm.sg8(0x87E0, 1);
        vm.sg16(0x516, vm.g16(0x516) | 0x20);
    }
}

/** 0x765d: interrupt 8 -> the calibration handler 0x85ab (old vector at cs:[0x529]); wait
 * for its count in cs:[0x527]; cs:[0x510] = cs:[0x511] = count / 0x5d2a, or 1 when that is 0
 * (ticks per BIOS tick); timer channel 0 at 50 Hz (divisor 0x5d2a); cs:[0x514] = cs:[0x515] =
 * 0x10; interrupt 8 -> 0x70e1; cs:[0x513] = 0, then count loop iterations (up to 0x7fff)
 * until the timer interrupt has raised cs:[0x513] to 2: cs:[0x518] = count / 40. */
export function timer_setup(vm, machine) {
    swap_vector(vm, 8, 0x529, INT.CALIBRATION_HANDLER);
    vm.sg16(0x527, 0);
    let counted = false;
    for (let k = 0; k < 0x10000; k++) {
        timer_interrupt(vm);
        if (vm.g16(0x527)) {
            counted = true;
            break;
        }
    }
    if (!counted) throw new EngineHang('the timer count reads 0 every time');
    vm.sg8(0x510, 1);
    vm.sg8(0x511, 1);
    const q = Math.floor(vm.g16(0x527) / 0x5D2A);
    if (q) {
        vm.sg8(0x511, q);
        vm.sg8(0x510, q);
    }
    machine.note('timer', 'channel 0 divisor 0x5d2a (50 Hz)');
    vm.sg8(0x514, 0x10);
    vm.sg8(0x515, 0x10);
    vm.mem.w16(0x20, INT.TIMER_HANDLER);
    vm.mem.w16(0x22, CODE_SEG);
    vm.sg8(0x513, 0);
    const count = Math.min(machine.speed_count, SPEED_LOOP);
    while (vm.g8(0x513) !== 2) timer_interrupt(vm);
    vm.sg16(0x518, floordiv(count, 0x28));
}

/** 0x7910: cs:[0x5b6e] = cs:[0x5b6f] = 0. When the button bits of port 0x201 stay the same
 * for 200 reads and buttons 1 and 2 are up, the axis timings are read (0x7bc7, -1 = time-out):
 * axes 1 and 2 present -> cs:[0x5b6a], cs:[0x5b6c], cs:[0x5b6e] = 1, bit 1 of cs:[0x516];
 * axes 3 and 4 present -> cs:[0x5b6f] = 1, bit 2 of cs:[0x516]. */
export function joystick_setup(vm, machine) {
    vm.sg8(0x5B6E, 0);
    vm.sg8(0x5B6F, 0);
    const [a1, a2, a3, a4] = machine.joystick && machine.joystick.length ? machine.joystick : [null, null, null, null];
    if (a1 != null) {
        vm.sg16(0x5B6A, a1);
        if (a2 != null) {
            vm.sg16(0x5B6C, a2);
            vm.sg8(0x5B6E, 1);
            vm.sg16(0x516, vm.g16(0x516) | 1);
        }
    }
    if (a3 != null && a4 != null) {
        vm.sg8(0x5B6F, 1);
        vm.sg16(0x516, vm.g16(0x516) | 2);
    }
}

/** 0x7a19: unless the 'm' option set cs:[0x51c]: cs:[0x51c] = 1, INT 33h AX=0; with a driver:
 * mickey ratio 16/32 (AX=0Fh), on VGA the pointer at (0xa0, 0x64) limited to 0..0x13f x
 * 0..0xc7 (AX=4, 7, 8) and the ratio 32/32, cs:[0x51c] = 0 and bit 4 of cs:[0x516]. Then
 * cs:[0x46c] = 0xff (pointer hidden). */
export function mouse_setup(vm, machine) {
    if (vm.g8(0x51C) === 0) {
        vm.sg8(0x51C, 1);
        machine.note('INT 33h AX=0000h', machine.mouse ? 'driver present' : 'no driver');
        if (machine.mouse) {
            vm.mouse = new IO.Mouse();
            if (vm.g8(0x422) === 1) IO.mouse_set_position(vm, 0xA0, 0x64);
            vm.sg8(0x51C, 0);
            vm.sg16(0x516, vm.g16(0x516) | 4);
        }
    }
    vm.sg8(0x46C, 0xFF);
}

/** 0xd12c: clear the clip rectangle cs:[0x497..0x49f] in the CGA work buffer (segment
 * cs:[0x3ff]; interleaved rows, 0x2000 apart): cs:[0x49f] words per row step. */
export function clear_cga_buffer(vm) {
    const x0 = vm.g16(0x497), y0 = vm.g16(0x499), y1 = vm.g16(0x49D), words = vm.g16(0x49F);
    let di = u16(0x50 * ((s16(y0) >> 1) & 0xFFFF) + (x0 >> 2));
    if (y0 & 1) di ^= 0x2000;
    const seg = vm.g16(0x3FF);
    let rows = u16(y1 - y0 + 1);
    const step = u16(0x50 - 2 * words);
    for (;;) {
        for (let k = 0; k < words; k++) {
            vm.mem.w16(seg * 16 + di, 0);
            di = u16(di + 2);
        }
        rows = u16(rows - 1);
        if (rows === 0) return;
        di = u16(di + step) ^ 0x2000;
        if (di & 0x2000) di = u16(di - 0x50);
    }
}

/** 0x9709: cs:[0x403] = 0x2000 (the work page); clear the clip rectangle there through the
 * graphics controller (write mode 2, all planes, colour 0): bytes a000:(0x2000 + 40 y + x / 8)
 * (0xbae7), (x1 - x0) / 8 + 1 per row. */
export function clear_ega_page(vm, machine) {
    vm.sg16(0x403, 0x2000);
    const x0 = vm.g16(0x497), y0 = vm.g16(0x499);
    let di = u16(u16(u16(u16(y0 * 5) << 6) + x0) >> 3);
    di = u16(di + vm.g16(0x403));
    let width = u16(vm.g16(0x49B) - x0);
    if (width === 0) return;
    width >>= 3;
    const skip = u16(0x27 - width);
    let rows = u16(vm.g16(0x49D) - y0 + 1);
    width += 1;
    machine.note('EGA', 'write mode 2, colour 0');
    for (;;) {
        for (let k = 0; k < width; k++) {
            vm.mem.w8(0xA0000 + di, 0);
            di = u16(di + 1);
        }
        di = u16(di + skip);
        rows = u16(rows - 1);
        if (rows === 0) return;
    }
}

/** 0x7270: command options; interrupt 24h -> 0x7787 (critical error) and 0 -> 0x7731 (divide
 * overflow); current drive (cs:[0x533]) and directory (cs:0x60b = separator + path); the noise
 * sample at the first paragraph after the engine; the class table at cs:[0x405]; the top of
 * memory less 0x7d0 paragraphs (INT 12h) as the segment of the CGA work buffer, the sample
 * buffers and the class memory limit cs:[0x40b]; keyboard (0x787f), country (0x7617), the
 * low-memory prompt (0x75bf), display (0x83a2), sound (0x8a1c), timer (0x765d), joystick
 * (0x7910), mouse (0x7a19); the clip rectangle cs:[0x497..0x49f] = full screen and the work
 * page cleared (CGA 0xd12c, else 0x9709 and the EGA page globals cs:[0x3f9..0x400],
 * cs:[0x655], cs:[0x657], cs:[0x67b]). `display`: see display_setup. */
export function hardware_setup(vm, machine, display) {
    command_options(vm, machine);
    swap_vector(vm, 0x24, 0x52D, 0x7787);
    swap_vector(vm, 0x00, 0x3ED, 0x7731);
    // 0x7381-0x73a8: INT 0 (the handler 0x7731 finds no DIV after it and returns) and three
    // divisions that overflow on purpose (0x7731 halves the dividend until the quotient fits).
    vm.sg16(0x39D, 1);
    const drive = machine.drive & 0xFF;
    vm.sg8(0x533, drive === 2 ? 0 : drive);                      // INT 21h AH=19h
    current_directory(vm, machine);                              // INT 21h AH=47h
    vm.sg8(0x60B, vm.g8(0x609));
    machine.note('INT 13h AH=00h', 'disk reset (twice)');
    const paras = (ENGINE_END >> 4) + 1;
    vm.sg16(0x584, CODE_SEG + paras);
    vm.sg16(0x582, 0);
    load_noise(vm, machine);
    vm.sg16(0x405, u16((paras << 4) + 0x1480));
    vm.sg16(0x407, CODE_SEG);
    const top = u16(u16(u16(machine.memory_kb << 6) - 1) - (0x7D00 >> 4));   // INT 12h
    vm.sg16(0x8FB, 0);
    vm.sg16(0x8FD, top);
    vm.sg16(0x4A1, 0);
    vm.sg16(0x4A3, top);
    vm.sg16(0x3FD, 0);
    vm.sg16(0x3FF, top);
    vm.sg16(0x3D9, 0);
    vm.sg16(0x3DB, top);
    vm.sg16(0x40B, top);
    vm.sg16(0x409, 0);
    vm.sg16(0x3F9, 0);
    vm.sg16(0x3FB, 0xB800);
    for (const [off, v] of [[0x673, 0], [0x675, 0], [0x677, 0x13F], [0x679, 0xC7], [0x67B, 0x50]]) vm.sg16(off, v);
    swap_vector(vm, 9, 0x685, INT.KEYBOARD_HANDLER);             // 0x787f
    country_check(vm, machine);
    if (u16(vm.g16(0x40B) - vm.g16(0x407)) <= 0x5780) low_memory_prompt(vm, machine);
    display_setup(vm, machine, display);
    sound_setup(vm, machine);
    timer_setup(vm, machine);
    joystick_setup(vm, machine);
    mouse_setup(vm, machine);
    for (const [off, v] of [[0x497, 0], [0x499, 0], [0x49B, 0x13F], [0x49D, 0xC7], [0x49F, 0x50]]) vm.sg16(off, v);
    if (vm.g8(0x422) === 0) {
        clear_cga_buffer(vm);
        return;
    }
    clear_ega_page(vm, machine);
    vm.sg16(0x3FF, 0x2000);
    vm.sg16(0x3FD, 0);
    vm.sg16(0x3FB, 0);
    vm.sg16(0x3F9, 0);
    vm.sg16(0x657, vm.g8(0x41F) ? 0x4000 : 0);
    vm.sg16(0x655, 0);
    vm.sg16(0x67B, 0xA0);
}

/** 0x63d3: cs:[0x383] = cs:[0x381] = 0 and load class 0 from MAIN.IO (cs:0x65ea) with 0x668c,
 * which loads it as the level (ops_life: tables, heap, display pool, object 0). */
export function load_main(vm, machine) {
    vm.sg16(0x383, 0);
    vm.sg16(0x381, 0);
    const name = F.latin1(F.cstring(vm, CS + 0x65EA));
    LIFE.load_class(vm, name);
    machine.note('file', `${name}: level loaded, object heap at segment ${hex(vm.es, 4)}`);
}

/** 0x1554 with SS:SP = 1000:0400: nine registers pushed, cs:[0x3df] = SP (0x3ee, restored by
 * the exit 0x7534); 0x7270, 0x8a9a, 0x63d3; the timer interrupts that fall after the speed
 * measurement; then 0x156c: string buffers cs:[0x4d3] = 0x81, [0x4d5] = 0x181, [0x4d7] =
 * 0x281, cs:[0x381] = 0, and 0x15aa runs object 0 (BX = 0, SI = cs:[0x449], ES = the heap).
 * `display`: see display_setup. */
export function engine_start(vm, machine, display) {
    vm.sg16(0x3DF, 0x400 - 9 * 2);
    hardware_setup(vm, machine, display);
    init_channels(vm);
    load_main(vm, machine);
    for (let k = 0; k < Math.max(0, machine.ticks - 2); k++) timer_interrupt(vm);
    [0x4D3, 0x4D5, 0x4D7].forEach((g, k) => vm.sg16(g, LIFE.STRING_BUFFERS[k]));
    vm.sg16(0x381, 0);
    [vm.ds, vm.si, vm.bx, vm.bp] = [CODE_SEG, vm.g16(0x449), 0, 0];
}

/** The start-menu key that leaves cs:[0x24] = display on this machine (null: no menu); a
 * display the menu cannot give is refused (ValueError). */
export function menu_key(display, machine) {
    if (!(machine.adapter === 'ega' || machine.adapter === 'vga')) return null;
    if (display === 2) return SCAN_F1;
    if (display === 3) return machine.adapter === 'vga' ? SCAN_F10 : SCAN_F2;
    if (display === 5 && machine.adapter === 'vga') return SCAN_F2;
    throw new ValueError(`display type ${display} cannot be chosen on adapter ${machine.adapter}`);
}

/** The VM at the first script pass: memory, ES = object heap, DS:SI = 1040:cs:[0x449],
 * pit_count and the open-file table of ops_io, the mouse (if any). `machine` defaults to
 * machine_for(display); a display the start menu cannot select raises ValueError. */
export function boot_vm(display = 3, machine = null) {
    machine = machine || machine_for(display);
    menu_key(display, machine);
    return data_start(display, machine);
}

/** The start-up from data: the DOS environment, the engine's tables (program_data.install) in a
 * code segment that is zero otherwise, and the engine start-up 0x1554 with the display chosen
 * directly (display_choice). The sample player copy of 0x8bdf is not taken from the program
 * image (vm.player_template = false, ops_io.speaker_play). */
export function data_start(display, machine) {
    const img = new Image();
    load_environment(img, machine);
    program_data.install(img.m);
    machine.note('program', 'engine tables from program_data, no METAL.EXE');
    const vm = start_vm(img, machine);
    vm.machine = machine;
    vm.player_template = false;
    engine_start(vm, machine, display);
    const got = vm.g16(0x24);
    if (got !== display) {
        throw new ValueError(`display type ${_hex_alt(got)} on this machine, not ${_hex_alt(display)}`);
    }
    return vm;
}

/** Memory image (Uint8Array, 2 MB, layout as above) at the first script pass. */
export function boot(display = 3, machine = null) {
    return boot_vm(display, machine).mem.m;
}


register_module('boot', boot_module);
