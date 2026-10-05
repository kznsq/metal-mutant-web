/**
 * The files the engine's DOS calls work on, held in memory, so the engine needs no file system
 * and runs the same in a browser and in any other JavaScript host.
 *
 * Two directories, both flat like the game's own (DOS names, compared in upper case):
 *  - `store.game`: the original game files (*.IO, *.FIC; METAL.EXE is not needed), read-only. The
 *    class loader (ops_life.Dos) reads here.
 *  - `store.save`: the directory the file statements use (ops_io.save_dir): a copy of the game
 *    files made when it is first needed; saved games are written here.
 * The host fills them with `mount()` before the engine starts and may keep `store.save` (for
 * example in browser storage) to restore saved games later.
 */

export class Directory {
    /** `entries`: an object or Map from file name to Uint8Array (copied). */
    constructor(entries = {}) {
        this.files = new Map();
        const list = entries instanceof Map ? entries.entries() : Object.entries(entries);
        for (const [name, bytes] of list) this.write(name, bytes);
    }

    /** The file names in upper case, sorted. */
    names() {
        return [...this.files.keys()].sort();
    }

    has(name) {
        return this.files.has(name.toUpperCase());
    }

    /** The file's bytes (the stored array; callers copy before changing them), or null. */
    read(name) {
        return this.files.get(name.toUpperCase()) ?? null;
    }

    /** Store a copy of `bytes` as `name`, replacing a file of that name. */
    write(name, bytes) {
        this.files.set(name.toUpperCase(), new Uint8Array(bytes));
    }

    /** Delete a file; returns false when it does not exist. */
    remove(name) {
        return this.files.delete(name.toUpperCase());
    }

    /** An independent copy: every file's bytes are copied. */
    copy() {
        return new Directory(this.files);
    }
}

// The mounted directories (files.Directory, or null before mount).
export const store = {game: null, save: null};

/** Install the game files (and, optionally, a save directory kept from an earlier session). */
export function mount(gameFiles, saveFiles = null) {
    store.game = gameFiles instanceof Directory ? gameFiles : new Directory(gameFiles);
    store.save = saveFiles === null ? null : (saveFiles instanceof Directory ? saveFiles : new Directory(saveFiles));
}

/** The directory of the file statements, copied from the game files on first use. */
export function save_dir() {
    if (store.save === null) {
        if (store.game === null) throw new Error("no game files mounted (files.mount)");
        store.save = store.game.copy();
    }
    return store.save;
}

/** The mounted game files. */
export function game_dir() {
    if (store.game === null) throw new Error("no game files mounted (files.mount)");
    return store.game;
}
