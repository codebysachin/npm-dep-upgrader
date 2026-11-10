/**
 * Thin wrapper around child_process.spawnSync.
 * Commands run sequentially by design: each upgrade must finish (install + tests)
 * before the next one starts.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { AbortError, CommandError } from './errors.mjs';
import { formatCommandEntry } from './logfile.mjs';

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
 * @property {string} [input]          Text written to the command's stdin.
 */

/**
 * @param {string} command
 * @param {string[]} args
 * @param {RunOptions} options
 * @returns {{ ok: boolean, status: number|null, stdout: string, stderr: string, durationMs: number }}
 */
export function run(command, args, { cwd, allowFailure = false, shell = false, env, logFile, timeoutMs, input } = {}) {
  const display = [command, ...args].join(' ');
  const started = Date.now();

  const child = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: timeoutMs,
    input,
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

  if (logFile) appendFileSync(logFile, formatCommandEntry(display, result));

  if (!result.ok && !allowFailure) throw new CommandError(display, result);
  return result;
}
