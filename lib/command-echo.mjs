/**
 * Shows every command the script runs, with its result, on screen.
 *
 * Folded (default): one dim line per command: ✔ or the exit code, how long it took, and a
 *   "▸ <log file>" link to the full output. In terminals that support hyperlinks (iTerm2,
 *   VS Code, Windows Terminal, GNOME Terminal, ...) the link can be clicked; otherwise the
 *   file name is printed and can be opened by hand.
 * Unfolded (--verbose): the command's output is printed under the line as well.
 */
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isTerminal, runtime, useColor } from './runtime.mjs';
import { stripAnsi } from './test-output.mjs';

// Turned on by the CLI through runtime.mjs (echoCommands, verbose); off in unit tests.

/** Before a command starts: in a terminal, show it as running so long commands aren't a mystery. */
export function commandStarted(display) {
  if (!runtime().echoCommands || !isTerminal()) return;
  // Kept to one screen line so it can be cleared again with \r.
  const width = (process.stdout.columns || 80) - 1;
  const text = `    ⋯ $ ${display}`;
  process.stdout.write(paint('2', text.length > width ? `${text.slice(0, width - 1)}…` : text));
}

/** After a command ends: replace the "running" line with the result (and the output if verbose). */
export function commandFinished(display, result, logFile) {
  if (!runtime().echoCommands) return;
  if (isTerminal()) process.stdout.write('\r\x1b[2K'); // clear the "running" line
  const lines = formatCommandEcho(display, result, {
    logFile,
    verbose: runtime().verbose,
    paint,
    link: useColor() ? hyperlink : undefined,
  });
  process.stdout.write(`${lines.join('\n')}\n`);
}

/**
 * Pure formatting, so it can be unit-tested.
 * @param {string} display   the command line
 * @param {{ok: boolean, status: number|null, signal?: string|null, stdout: string, stderr: string, durationMs: number}} result
 * @param {object} options
 * @param {string} [options.logFile]
 * @param {boolean} [options.verbose]
 * @param {(code: string, text: string) => string} [options.paint]
 * @param {(url: string, text: string) => string} [options.link]
 * @returns {string[]}
 */
export function formatCommandEcho(display, result, { logFile, verbose = false, paint: p = (_, t) => t, link } = {}) {
  const output = outputLines(result);
  const seconds = `${(result.durationMs / 1000).toFixed(1)}s`;
  // Non-zero is not always an error (`npm outdated` exits 1 when something is outdated), so it is
  // shown neutrally; real failures get their own ✖ message from the step that ran the command.
  const mark = result.ok ? p('32', '✔') : p('2', `· exit ${result.status ?? result.signal}`);

  let details = '';
  if (!verbose && output.length && logFile) {
    const name = basename(logFile);
    const text = `▸ output (${output.length} line${output.length === 1 ? '' : 's'}): ${name}`;
    details = `  ${link ? link(pathToFileURL(logFile).href, text) : text}`;
  }

  const lines = [`    ${mark} ${p('2', `$ ${display}  · ${seconds}`)}${p('2', details)}`];
  if (verbose) lines.push(...output.map((line) => p('2', `      │ ${line}`)));
  return lines;
}

function outputLines({ stdout = '', stderr = '' }) {
  return stripAnsi(`${stdout}\n${stderr}`)
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean);
}

function paint(code, text) {
  return useColor() ? `\x1b[${code}m${text}\x1b[0m` : text;
}

/** OSC 8 terminal hyperlink. Terminals without support show just the text. */
function hyperlink(url, text) {
  return `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
}
