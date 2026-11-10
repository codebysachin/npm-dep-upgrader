/**
 * The few settings that apply to the whole process, in one place. The CLI sets them once at
 * start-up; until then (and after resetRuntime) nothing is echoed or logged by default, which
 * keeps unit tests quiet and independent of each other.
 *
 * Terminal capabilities (colour, TTY) are read when needed rather than stored, so they always
 * match the current process.
 */

/**
 * @typedef {object} RuntimeSettings
 * @property {string} [commandLog]
 * @property {boolean} echoCommands
 * @property {boolean} verbose
 */

/** @type {Readonly<RuntimeSettings>} */
const DEFAULTS = Object.freeze({
  /** Log file for commands that don't belong to a step (see exec.mjs). */
  commandLog: undefined,
  /** Print each command and its result on screen (see command-echo.mjs). */
  echoCommands: false,
  /** Print each command's output too, instead of a pointer to the log. */
  verbose: false,
});

let current = DEFAULTS;

/** @returns {Readonly<RuntimeSettings>} */
export const runtime = () => current;

/** @param {Partial<RuntimeSettings>} changes */
export function configureRuntime(changes) {
  current = Object.freeze({ ...current, ...changes });
}

export function resetRuntime() {
  current = DEFAULTS;
}

/** Standard output is a terminal (so lines can be rewritten and questions asked). */
export const isTerminal = () => Boolean(process.stdout.isTTY);

/** Colours are used on a terminal unless NO_COLOR is set (https://no-color.org). */
export const useColor = () => isTerminal() && !('NO_COLOR' in process.env);
