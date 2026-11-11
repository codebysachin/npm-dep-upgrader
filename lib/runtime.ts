/**
 * The few settings that apply to the whole process, in one place. The CLI sets them once at
 * start-up; until then (and after resetRuntime) nothing is echoed or logged by default, which
 * keeps unit tests quiet and independent of each other.
 *
 * Terminal capabilities (colour, TTY) are read when needed rather than stored, so they always
 * match the current process.
 */

export interface RuntimeSettings {
  commandLog?: string;
  echoCommands: boolean;
  verbose: boolean;
}

const DEFAULTS: Readonly<RuntimeSettings> = Object.freeze({
  /** Log file for commands that don't belong to a step (see exec.ts). */
  commandLog: undefined,
  /** Print each command and its result on screen (see command-echo.ts). */
  echoCommands: false,
  /** Print each command's output too, instead of a pointer to the log. */
  verbose: false,
});

let current = DEFAULTS;

export const runtime = (): Readonly<RuntimeSettings> => current;

export function configureRuntime(changes: Partial<RuntimeSettings>): void {
  current = Object.freeze({ ...current, ...changes });
}

export function resetRuntime(): void {
  current = DEFAULTS;
}

/** Standard output is a terminal (so lines can be rewritten and questions asked). */
export const isTerminal = (): boolean => Boolean(process.stdout.isTTY);

/** Colours are used on a terminal unless NO_COLOR is set (https://no-color.org). */
export const useColor = (): boolean => isTerminal() && !('NO_COLOR' in process.env);
