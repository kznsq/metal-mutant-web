# Metal Mutant in the browser

Play *Metal Mutant* (Silmarils, 1991, MS-DOS) in a web browser.

This is a reimplementation of the game's engine in JavaScript. It runs the original game's own
scripts, graphics and sounds from the original game files, without emulating the PC: the
script interpreter, object scheduler, display list, renderer, PC-speaker sound, keyboard and
timer handling are rewritten from the original program, routine by routine.

## What you need

- **Your own copy of the original game.** No game files are included. The engine reads only the
  game's data files: `MAIN.IO` and the other `.IO` files, `CAC40.FIC` and `SOS.FIC`. The program
  `METAL.EXE` is not used; the few tables the engine needs from it (key translation, pixel masks,
  speaker rate patterns, the start-up palette, messages) are part of the engine
  (`engine/program_data.js`), most of them computed by formula.
- **A current web browser** (Chrome, Edge, Firefox or Safari).
- **Python 3** to run the included local server, or any other static web server.

## Running it

```
python3 serve.py --game /path/to/METALMUT
```

then open http://127.0.0.1:8791/ in a browser. Options:

- `--game FOLDER`: the folder with the original game files. Without it, the folder `game` next to
  `serve.py` is used.
- `--port N`: the port to listen on (default 8791). The server answers on this computer only.

Without game files on the server (or with any other static web server), the page asks you to
choose your Metal Mutant folder instead. The files are then read in the browser and are not
uploaded anywhere. Opening `index.html` directly from disk does not work: browsers load the
engine's JavaScript modules only from a web server.

Sound starts with the first key press or click: browsers do not play sound before that.

## Controls

| Key | Action |
|---|---|
| Arrows | walk, climb, crouch |
| Home, PgUp, End, PgDn | diagonals (`\` also works as PgUp, `'` as End) |
| Shift | fire / use |
| Shift + End | save, standing under a survival module |
| F1, F2, F3 | change form |
| Return, Space | choose in menus |
| Escape | pause; any key resumes |

The keys of the numeric keypad work as well.

## Saving and autosave

The game saves itself at a survival module: stand under it and press Shift + End. To continue
later, choose LOAD in the game's menu.

With **Autosave** on (the default), the page also asks the game to save at the start of every
scene, in exactly the way a survival module does. After a death, choose LOAD in the menu to
continue from the last scene reached. The **Autosave** button switches this on or off; the
choice is remembered.

Saved games are kept in the browser's local storage, separately for each web address the page
is opened from. **Forget saves** deletes them; reload the page afterwards to start without them.
The original game files are never changed.

## Display options

The display selector switches between the three displays the original offered at start-up:

- **VGA**: the game's own colour palettes (the default).
- **EGA**: 16 colours.
- **CGA**: 4 colours.

Changing the display restarts the game. The choice and the sound on/off setting are remembered.

## How faithful it is

The engine was rebuilt from the original program and checked frame by frame against it:

- Every script statement and expression, the start-up, the interrupt handlers, the frame end and
  the renderer produce the same memory, byte for byte, as the original program.
- Recorded games of 3,000 frames each on VGA, EGA and CGA (intro, menu and play with keys) give
  identical memory and an identical screen in every frame.
- The start-up from the data files alone was compared with the original start-up from
  `METAL.EXE` over about 96,000 frames on all three displays and all levels: memory differs only
  in the bytes of the original's machine code (which the engine never reads) and in the unused
  parts of the speaker player that the original copies over each sound sample.

The original's quirks are kept, including its bugs, because the game's scripts may rely on them.
Hardware interrupts (keyboard, timer) are applied between the engine's script passes, as on a PC
fast enough to finish each pass within one timer tick; a script that waits in a loop for a key
(the pause on Escape) still receives key presses while it waits.

## Layout

- `index.html`, `main.js`: the page (canvas, keyboard, sound output, loading the game files,
  saved games, autosave).
- `engine/`: the engine, one module per part of the original program:
  - `vm.js`: script interpreter and object scheduler; `memory.js`: the machine's memory;
  - `ops_*.js`: the script statements and expressions;
  - `boot.js`: the start-up; `program_data.js`: the engine's own tables;
  - `interrupts.js`: timer and keyboard interrupts;
  - `frame_end.js`, `render.js`: the display;
  - `audio.js`: PC-speaker sound;
  - `game.js`: the frame loop; `files.js`: the game files in memory;
  - `errors.js`: exception types and integer helpers; `index.js`: loads every module.

  Comments give the addresses of the original routines and variables (for example the
  scheduler `0x15aa` or the variable `cs:[0x381]`).
- `serve.py`: a small local server for the page and the game files.
