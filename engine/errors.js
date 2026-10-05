/**
 * The exception types of the engine, and its integer helpers.
 *
 * Each kind of failure has its own exception type with a fixed name and message
 * (NotImplementedError, KeyError, IndexError, RuntimeError, ...), so the reason a run stops is
 * reported precisely. The exceptions that model the original program's own ends (ProgramExit,
 * FatalError, OriginalCrash, EngineHang) are in vm.js.
 *
 * The integer helpers give the engine's arithmetic where JavaScript's operators differ: division
 * and modulo rounded towards minus infinity, shifts of values above 32 bits, and the checks for
 * division by zero and negative shift counts.
 */

/** Base class of the engine's exceptions; `name` is the name of the class. */
export class EngineError extends Error {
    constructor(message = '') {
        super(String(message));
        this.name = new.target.name;
    }
}

/** A statement, expression or destination code without a handler. */
export class NotImplementedError extends EngineError {}

/** A lookup of a code that a handler table does not hold, e.g. DEST_STORE[code]; the message is
 * the code in decimal. */
export class KeyError extends EngineError {}

/** A memory access outside the memory image (memory.js). */
export class IndexError extends EngineError {}

/** A script run beyond the interpreter's step limit (VM.step_limit), or a loop of the original
 * that would never end. */
export class RuntimeError extends EngineError {}

/** An integer division or modulo by zero (floordiv, floormod). */
export class ZeroDivisionError extends EngineError {}

/** An argument of the right type with a value that is not allowed (e.g. a negative shift count,
 * or a display type that the start menu cannot select). */
export class ValueError extends EngineError {}

/** An argument of the wrong type, raised on purpose by engine code. Its name is TypeError, but it
 * is not JavaScript's own TypeError, so a deliberate check is never confused with a programming
 * error in the engine. */
export class EngineTypeError extends EngineError {
    constructor(message = '') {
        super(message);
        this.name = 'TypeError';
    }
}

/** Integer division a / b rounded towards minus infinity. */
export function floordiv(a, b) {
    if (b === 0) throw new ZeroDivisionError('division by zero');
    return Math.floor(a / b);
}

/** The remainder that goes with floordiv: a non-zero result has the sign of b. */
export function floormod(a, b) {
    if (b === 0) throw new ZeroDivisionError('division by zero');
    const r = a % b;
    return r !== 0 && (r < 0) !== (b < 0) ? r + b : r;
}

/** Arithmetic right shift a >> n for any integer a below 2**53: the floor of a / 2**n, also for
 * a >= 2**31, where JavaScript's >> would cut a to 32 bits. */
export function shr(a, n) {
    if (n < 0) throw new ValueError('negative shift count');
    return Math.floor(a / 2 ** n);
}

/** Lower-case hexadecimal without prefix, zero-padded to `width` characters (a minus sign
 * counts towards the width and the zeros follow it). */
export function hex(v, width = 0) {
    if (v < 0) return '-' + (-v).toString(16).padStart(width - 1, '0');
    return v.toString(16).padStart(width, '0');
}
