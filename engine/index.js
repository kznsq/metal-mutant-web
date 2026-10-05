/**
 * The complete engine: importing this file loads every module.
 *
 * Importing a module registers its handlers in STATEMENTS / EXPRESSIONS and its namespace in the
 * module table (vm.js register_module), so the loaded set can be inspected at run time. The order
 * below is significant: when two modules register the same code, the one imported later keeps it.
 */
import './ops_flow.js';
import './ops_expr.js';
import './ops_objects.js';
import './ops_life.js';
import './ops_view.js';
import './ops_search.js';
import './ops_io.js';
import './render.js';
import './frame_end.js';
import './interrupts.js';
import './program_data.js';
import './boot.js';
import './game.js';

export * from './vm.js';
export { Memory } from './memory.js';

/** Every module of the engine, in import order; vm.js LOADED_MODULES lists the ones loaded. */
export const ALL_MODULES = [
    'ops_flow', 'ops_expr', 'ops_objects', 'ops_life', 'ops_view', 'ops_search', 'ops_io',
    'render', 'frame_end', 'interrupts', 'program_data', 'boot', 'game',
];
