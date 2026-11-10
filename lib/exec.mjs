/**
 * Thin wrapper around child_process.spawnSync.
 * Commands run sequentially by design: each upgrade must finish (install + tests)
 * before the next one starts.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { AbortError, CommandError } from './errors.mjs';

const IS_WINDOWS = process.platform === 'win32';
const MAX_BUFFER = 256 * 1024 * 1024;

/**
 * @typedef {object} RunOptions
 * @property {string} cwd
 * @property {boolean} [allowFailure]  Return the result instead of throwing on non-zero exit.
 * @property {boolean} [shell]         Run `command` through the shell (used for user-supplied test commands).
 * @property {Record<string,string>} [env]
 * @property {string} [logFile]        Append the command and its output to this file.
 * @property {number} [timeoutMs]
 */

/**
 * @param {string} command
 * @param {string[]} args
 * @param {RunOptions} options
 * @returns {{ ok: boolean, status: number|null, stdout: string, stderr: string, durationMs: number }}
 */
export function run(command, args, { cwd, allowFailure = false, shell = false, env, logFile, timeoutMs } = {}) {
  const display = [command, ...args].join(' ');
  const started = Date.now();

  const child = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: timeoutMs,
    // npm/npx are .cmd shims on Windows and need a shell to resolve.
    shell: shell || IS_WINDOWS,
  });

  if (child.signal === 'SIGINT') throw new AbortError();
  if (child.error) throw child.error;

  const result = {
    ok: child.status === 0,
    status: child.status,
    signal: child.signal,
    stdout: child.stdout ?? '',
    stderr: child.stderr ?? '',
    durationMs: Date.now() - started,
  };

  if (logFile) {
    appendFileSync(
      logFile,
      `$ ${display}\n(cwd: ${cwd}, exit: ${result.status ?? result.signal}, ${result.durationMs}ms)\n` +
        `${result.stdout}\n${result.stderr}\n${'-'.repeat(80)}\n`,
    );
  }

  if (!result.ok && !allowFailure) throw new CommandError(display, result);
  return result;
}

/** Last `count` non-empty lines of a command's combined output, handy for error summaries. */
export function tail(result, count = 15) {
  return `${result.stdout}\n${result.stderr}`
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-count)
    .join('\n');
}
