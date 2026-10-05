/**
 * The browser front end: loads the game files, starts the engine, runs it at the game's own
 * speed, shows the screen on a canvas and passes the keyboard to it.
 *
 * Game files come from the local server (/game/index.json and /game/NAME) or, when there is
 * none, from a folder the player picks: the *.IO and *.FIC files; the engine starts from these
 * alone, so METAL.EXE is not needed (and not used when it is there). Saved games (the file
 * statements write SOS.FIC and the like into the save directory) are kept in the browser's local
 * storage.
 *
 * A frame runs to completion in one go. A script that waits in a loop for the keyboard (Escape
 * pauses the game that way) cannot see keys while it runs, because the page has one thread: after
 * a bound on the statements of one script run, the frame is abandoned, memory and engine state go
 * back to their copy from the frame's start, and the frame runs again once a key arrives, with all
 * the key events since that start applied first.
 */
import * as FILES from './engine/files.js';
import './engine/index.js';
import { Game, TICK_SECONDS } from './engine/game.js';
import { SpeakerSound } from './engine/audio.js';

// PC scancodes (set 1) by KeyboardEvent.code. The numeric keypad's digits are the game's
// directions; Home, PgUp, End and PgDn its diagonals; \ also gives PgUp and ' gives End.
const SCANCODES = {
    Escape: 0x01, Minus: 0x0C, Equal: 0x0D, Backspace: 0x0E, Tab: 0x0F, BracketLeft: 0x1A,
    BracketRight: 0x1B, Enter: 0x1C, NumpadEnter: 0x1C, ControlLeft: 0x1D, ControlRight: 0x1D,
    Semicolon: 0x27, Backquote: 0x29, ShiftLeft: 0x2A, ShiftRight: 0x36, Comma: 0x33, Period: 0x34,
    Slash: 0x35, AltLeft: 0x38, AltRight: 0x38, Space: 0x39, CapsLock: 0x3A, NumLock: 0x45,
    ScrollLock: 0x46, Home: 0x47, ArrowUp: 0x48, PageUp: 0x49, NumpadSubtract: 0x4A,
    ArrowLeft: 0x4B, Numpad5: 0x4C, ArrowRight: 0x4D, NumpadAdd: 0x4E, End: 0x4F, ArrowDown: 0x50,
    PageDown: 0x51, Insert: 0x52, Delete: 0x53, F11: 0x57, F12: 0x58,
    Numpad7: 0x47, Numpad8: 0x48, Numpad9: 0x49, Numpad4: 0x4B, Numpad6: 0x4D, Numpad1: 0x4F,
    Numpad2: 0x50, Numpad3: 0x51, Numpad0: 0x52, NumpadDecimal: 0x53,
    Backslash: 0x49, Quote: 0x4F,
};
for (let d = 1; d <= 9; d++) SCANCODES[`Digit${d}`] = 0x01 + d;
SCANCODES.Digit0 = 0x0B;
for (let n = 1; n <= 10; n++) SCANCODES[`F${n}`] = 0x3A + n;
[['QWERTYUIOP', 0x10], ['ASDFGHJKL', 0x1E], ['ZXCVBNM', 0x2C]].forEach(([row, first]) =>
    [...row].forEach((ch, k) => { SCANCODES[`Key${ch}`] = first + k; }));

const DISPLAYS = { 5: 'VGA', 3: 'EGA', 2: 'CGA' };
const SAVE_PREFIX = 'metal-mutant-save:';
const STATEMENTS_PER_CHECK = 20000;                       // vm.interrupt_every: one key check each
const FIRST_LIMIT = 10;                                   // checks before a frame is abandoned
const MAX_LIMIT = 640;                                    // beyond this, replays wait for a key

const $ = (id) => document.getElementById(id);
const canvas = $('screen');
const ctx = canvas.getContext('2d');
const image = ctx.createImageData(320, 200);
const pixels = new Uint32Array(image.data.buffer);

// Abandons a frame that waits for input; the frame is replayed when keys arrive.
class Suspend extends Error {}

let game = null;
let queue = [];                                           // [scancode, down] since the last frame
const held = new Set();
let checks = 0, limit = FIRST_LIMIT, waiting = false, fresh_input = false, next_time = 0, timer = null;
let consumed = [];                                        // key events applied in the current attempt

// ------------------------------------------------------------------------------- sound
// The PC speaker (engine/audio.js), rendered after every tick and played back to back. Browsers
// start sound only after a click or a key, so the audio output opens on the first one.
let actx = null, out_gain = null, audio_time = 0;
let muted = storage(() => localStorage.getItem('metal-mutant-muted') === '1', false);

function open_audio() {
    if (actx || !game) return;
    try {
        actx = new AudioContext();
    } catch {
        return;
    }
    out_gain = actx.createGain();
    out_gain.gain.value = muted ? 0 : 1;
    out_gain.connect(actx.destination);
    game.observer = new SpeakerSound(actx.sampleRate);
    actx.resume();
    sound_label();
}

function play_sound() {
    if (!actx || !game.observer) return;
    const pcm = game.observer.take();
    if (!pcm.length || actx.state !== 'running') return;
    const now = actx.currentTime;
    if (audio_time < now + 0.02) audio_time = now + 0.06;             // start, or after a gap
    if (audio_time > now + 0.4) return;                               // far ahead: drop this tick
    const buffer = actx.createBuffer(1, pcm.length, actx.sampleRate);
    buffer.copyToChannel(pcm, 0);
    const src = actx.createBufferSource();
    src.buffer = buffer;
    src.connect(out_gain);
    src.start(audio_time);
    audio_time += pcm.length / actx.sampleRate;
}

function sound_label() {
    $('sound').textContent = !actx ? 'Sound: press a key' : (muted ? 'Sound off' : 'Sound on');
}

function status(text) {
    $('status').textContent = text;
}

function storage(fn, fallback) {
    try { return fn(); } catch { return fallback; }
}

// ------------------------------------------------------------------------------- game files
/** The engine reads only the game's data files: programs (METAL.EXE and the like) and hidden
 * files are left out. */
function wanted(name) {
    return !name.startsWith('.') && !/\.(EXE|COM|BAT)$/.test(name);
}

async function files_from_server() {
    const r = await fetch('game/index.json');
    if (!r.ok) throw new Error(`no game files on the server (${r.status})`);
    const list = await r.json();
    const entries = {};
    await Promise.all(list.filter(({ name }) => wanted(name.toUpperCase())).map(async ({ name }) => {
        const f = await fetch(`game/${encodeURIComponent(name)}`);
        if (f.ok) entries[name.toUpperCase()] = new Uint8Array(await f.arrayBuffer());
    }));
    return entries;
}

async function files_from_picker(fileList) {
    const entries = {};
    for (const f of fileList) {
        const name = f.name.toUpperCase();
        if (wanted(name)) entries[name] = new Uint8Array(await f.arrayBuffer());
    }
    return entries;
}

function to_base64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
}

function from_base64(text) {
    const s = atob(text);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
}

/** The save directory: the game files, then the files saved in this browser; every write and
 * removal is kept in local storage. */
function mount(entries) {
    FILES.mount(entries);
    const save = FILES.store.game.copy();
    storage(() => {
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key.startsWith(SAVE_PREFIX)) save.write(key.slice(SAVE_PREFIX.length), from_base64(localStorage.getItem(key)));
        }
    });
    const write = save.write.bind(save), remove = save.remove.bind(save);
    save.write = (name, bytes) => {
        write(name, bytes);
        storage(() => localStorage.setItem(SAVE_PREFIX + name.toUpperCase(), to_base64(save.read(name))));
    };
    save.remove = (name) => {
        storage(() => localStorage.removeItem(SAVE_PREFIX + name.toUpperCase()));
        return remove(name);
    };
    FILES.store.save = save;
}

// ------------------------------------------------------------------------------- frames
/** Engine state a frame can change before its frame end: memory and the VM's own fields. */
function snapshot() {
    const vm = game.vm;
    const fields = {};
    for (const k of Object.keys(vm)) {
        if (k === 'mem' || k === 'video') continue;
        const v = vm[k];
        fields[k] = Array.isArray(v) ? v.slice() : (v instanceof Uint8Array ? v.slice() : v);
    }
    return { mem: vm.mem.m.slice(), fields, frame: game.frame, ticks: game.ticks, typed: game.typed.slice() };
}

function restore(s) {
    const vm = game.vm;
    vm.mem.m.set(s.mem);
    for (const k of Object.keys(vm)) if (!(k in s.fields) && k !== 'mem' && k !== 'video') delete vm[k];
    Object.assign(vm, s.fields);
    game.frame = s.frame;
    game.ticks = s.ticks;
    game.typed = s.typed;
}

// ------------------------------------------------------------------------------- autosave
// At the start of every scene the game is asked to save itself, the way the in-game survival
// module does it (class TRUC at 0x0ed9: message 103 to the master script MAIN, whose handler 0xf69
// writes SOS.FIC), so LOAD in the menu continues from the last scene reached. A scene is the
// master script's level (MAIN byte +0xbd) and room (MAIN word +0xbe, set by its handler 0x931 when
// the hero leaves a screen) while the hero exists. The message is sent once the scene has lasted
// half a second and the master script's main script waits in its idle loop (MAIN 0xf5-0xf6: yield,
// jump back), where all its work is done by message handlers; a save then cannot cut short the
// handler that sets up the room.
const SCENE_SETTLE_TICKS = 25;
const MAIN_IDLE = [0xF5, 0xF6];                                   // MAIN.IO offsets of the idle loop
const SAVE_SCRIPT = [0x61, 0x00, 0x00, 0x00, 0x00, 0x67, 0x42];   // send 103 to handle 0; yield
const SAVE_SCRIPT_AT = 0x80000;                                   // borrowed and restored after use
let autosave_on = storage(() => localStorage.getItem('metal-mutant-autosave') !== '0', true);
let scene = null, scene_since = 0, scene_saved = false;

function main_var(off, size) {
    const vm = game.vm;
    const a = vm.g16(0x475) * 16 + ((vm.g16(0x473) + off) & 0xFFFF);   // MAIN's record (cs:[0x473/0x475])
    return size === 1 ? vm.mem.r8(a) : vm.mem.r16(a);
}

/** True when the master script's main script is at its idle loop (record fields -8/-6: the
 * script position; -0x14/-0x12: the class, whose file starts the script offsets). */
function main_idle() {
    const at = main_var(-6, 2) * 16 + main_var(-8, 2) - (main_var(-0x12, 2) * 16 + main_var(-0x14, 2));
    return MAIN_IDLE.includes(at);
}

/** The record of the hero (an object of class 1, APOLO), or 0 outside a level. */
function hero_record() {
    const vm = game.vm;
    const table = vm.g16(0x449);
    let h = 0;
    for (let n = 0; n < 256; n++) {
        const rec = vm.g16((table + h) & 0xFFFF);
        if (rec && vm.mem.r16(vm.es * 16 + ((rec - 0x10) & 0xFFFF)) === 1) return rec;
        h = vm.g16((table + h + 4) & 0xFFFF);
        if (h === 0) return 0;
    }
    return 0;
}

/** Statement 0x61 run for the hero: message 103 to the master script. */
function request_save(hero) {
    const vm = game.vm;
    const kept = vm.mem.m.slice(SAVE_SCRIPT_AT, SAVE_SCRIPT_AT + SAVE_SCRIPT.length);
    const regs = { bp: vm.bp, ds: vm.ds, si: vm.si, dx: vm.dx, cx: vm.cx, bx: vm.bx,
                   object_gone: vm.object_gone, restart_pass: vm.restart_pass };
    const main_flag = vm.g8(0x496);
    vm.mem.m.set(SAVE_SCRIPT, SAVE_SCRIPT_AT);
    Object.assign(vm, { bp: hero, ds: SAVE_SCRIPT_AT >> 4, si: 0 });
    vm.sg8(0x496, 1);
    try {
        vm.run_script();
    } finally {
        vm.sg8(0x496, main_flag);
        Object.assign(vm, regs);
        vm.mem.m.set(kept, SAVE_SCRIPT_AT);
    }
}

/** After every frame: once per scene, ask the game to save itself. */
function autosave_check() {
    if (!autosave_on) return;
    const hero = hero_record();
    if (!hero) {                                          // menus and title screens
        scene = null;
        return;
    }
    if (main_var(0xB8, 2) === 0xFFFF) return;             // the hero is dying
    const here = `${main_var(0xBD, 1)}:${main_var(0xBE, 2)}`;
    if (here !== scene) {
        scene = here;
        scene_since = game.ticks;
        scene_saved = false;
        return;
    }
    if (!scene_saved && game.ticks - scene_since >= SCENE_SETTLE_TICKS && main_idle()) {
        request_save(hero);
        scene_saved = true;
        status('Autosaved: LOAD in the menu continues from this scene.');
    }
}

function autosave_label() {
    $('autosave').textContent = autosave_on ? 'Autosave on' : 'Autosave off';
}

/** The key events for this frame: in arrival order, up to the release of a key pressed in the
 * same batch; that release and everything after it wait for the next frame, so every press is
 * seen by at least one script pass. */
function take_events() {
    const pressed = new Set();
    let n = 0;
    for (; n < queue.length; n++) {
        const [sc, down] = queue[n];
        if (down) pressed.add(sc);
        else if (pressed.has(sc)) break;
    }
    return queue.splice(0, n);
}

/** One frame with the queued key events. Returns the timer ticks it took, or 0 when it is
 * abandoned to wait for input (see the top of this file). */
function run_frame() {
    const s = snapshot();
    consumed = take_events();
    for (const [sc, down] of consumed) game.key(sc, down);
    checks = 0;
    fresh_input = false;
    try {
        const ticks = game.step();
        limit = FIRST_LIMIT;
        waiting = false;
        return ticks;
    } catch (ex) {
        if (!(ex instanceof Suspend)) throw ex;
        restore(s);
        queue = consumed.concat(queue);
        if (limit < MAX_LIMIT) limit *= 4;                // a long but finite loop gets further next time
        waiting = true;
        return 0;
    }
}

/** For a text-input statement (vm.key_source): the queued key events in order, until a press
 * gives a translated key in cs:[0x689]; with none left the frame waits for keys as above. */
function typed_key() {
    while (queue.length) {
        const ev = queue.shift();
        consumed.push(ev);
        game.key(ev[0], ev[1]);
        if (ev[1] && game.vm.g8(0x689)) return game.vm.g8(0x689);
    }
    throw new Suspend('a text-input statement waits for keys');
}

/** Called while a script runs in a loop (vm.interrupt_hook): the keyboard interrupt delivers the
 * next queued key event, as on the original machine; with none left the frame is abandoned
 * after `limit` calls and replayed when a new key arrives. */
function script_interrupt() {
    if (queue.length) {
        const ev = queue.shift();
        consumed.push(ev);
        game.key(ev[0], ev[1]);
        checks = 0;
        return;
    }
    checks += 1;
    if (checks >= limit) throw new Suspend('a script waits for the keyboard or the timer');
}

/** Draw the game's screen on the canvas. */
function show() {
    const [indices, palette] = game.screen();
    const pal = new Uint32Array(16);
    for (let i = 0; i < 16; i++) {
        const c = palette.length === 48 ? [palette[3 * i], palette[3 * i + 1], palette[3 * i + 2]] : palette[i];
        pal[i] = 0xFF000000 | (c[2] << 16) | (c[1] << 8) | c[0];
    }
    for (let i = 0; i < 64000; i++) pixels[i] = pal[indices[i] & 15];
    ctx.putImageData(image, 0, 0);
}

/** One frame per call, timed by the ticks each frame takes (50 per second of game time). */
function loop() {
    timer = null;
    try {
        if (waiting && !fresh_input && (limit >= MAX_LIMIT || performance.now() < next_time)) {
            timer = setTimeout(loop, 50);                 // paused: wait for a key
            return;
        }
        const ticks = run_frame();
        if (ticks) {
            show();
            play_sound();
            autosave_check();
            next_time += ticks * TICK_SECONDS * 1000;
        } else {
            next_time = performance.now() + 50;           // without a key, retry with a higher limit
        }
        const now = performance.now();
        if (next_time < now - 250) next_time = now;       // behind: do not try to catch up
        timer = setTimeout(loop, Math.max(0, next_time - now));
        $('frame').textContent = `frame ${game.frame} · ${(game.ticks * TICK_SECONDS).toFixed(1)} s`;
    } catch (ex) {
        status(ex && ex.name === 'ProgramExit' ? `The game ended: ${ex.message}` : `The engine stopped: ${ex && ex.stack || ex}`);
        console.error(ex);
    }
}

// ------------------------------------------------------------------------------- keyboard
/** A browser key event as one scancode press or release; auto-repeat and events that do not
 * change a key's state are dropped. Any key also opens the sound output. */
function key_event(e, down) {
    open_audio();
    const sc = SCANCODES[e.code];
    if (sc === undefined || !game) return;
    e.preventDefault();
    if (down && e.repeat) return;
    if (down === held.has(e.code)) return;
    if (down) held.add(e.code); else held.delete(e.code);
    queue.push([sc, down]);
    if (waiting) {                                        // paused: try the frame again at once
        fresh_input = true;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(loop, 0);
    }
}

window.addEventListener('keydown', (e) => key_event(e, true));
window.addEventListener('keyup', (e) => key_event(e, false));
window.addEventListener('blur', () => {                   // keys released while the page is away
    for (const code of held) queue.push([SCANCODES[code], false]);
    held.clear();
});

// ------------------------------------------------------------------------------- start
/** Start the game on these files with the display chosen last time (VGA at first). */
function start(entries) {
    mount(entries);
    const display = Number(storage(() => localStorage.getItem('metal-mutant-display'), null)) || 5;
    $('display').value = String(display);
    try {
        game = new Game(display);
    } catch (ex) {
        status(`The engine could not start: ${ex && ex.message || ex}`);
        console.error(ex);
        return;
    }
    game.vm.interrupt_every = STATEMENTS_PER_CHECK;
    game.vm.interrupt_hook = script_interrupt;
    game.vm.key_source = typed_key;
    $('picker').hidden = true;
    sound_label();
    autosave_label();
    status(`${DISPLAYS[display]} · ${Object.keys(entries).length} game files`);
    next_time = performance.now();
    canvas.focus();
    loop();
}

canvas.addEventListener('pointerdown', () => open_audio());
$('sound').addEventListener('click', () => {
    if (!actx) {
        open_audio();
        return;
    }
    muted = !muted;
    storage(() => localStorage.setItem('metal-mutant-muted', muted ? '1' : '0'));
    out_gain.gain.value = muted ? 0 : 1;
    sound_label();
});

$('autosave').addEventListener('click', () => {
    autosave_on = !autosave_on;
    storage(() => localStorage.setItem('metal-mutant-autosave', autosave_on ? '1' : '0'));
    if (!autosave_on) scene = null;
    autosave_label();
});

$('display').addEventListener('change', (e) => {
    storage(() => localStorage.setItem('metal-mutant-display', e.target.value));
    location.reload();
});
$('folder').addEventListener('change', async (e) => start(await files_from_picker(e.target.files)));
$('forget').addEventListener('click', () => {
    storage(() => {
        for (const key of Object.keys(localStorage)) if (key.startsWith(SAVE_PREFIX)) localStorage.removeItem(key);
    });
    status('Saved games deleted from this browser. Reload the page to start without them.');
});

/** For the browser console: the running game (window.metal_mutant.game). */
window.metal_mutant = { get game() { return game; }, main_var };

(async () => {
    status('Loading the game files…');
    try {
        start(await files_from_server());
    } catch (ex) {
        $('picker').hidden = false;
        status('Choose your Metal Mutant folder to start.');
    }
})();
