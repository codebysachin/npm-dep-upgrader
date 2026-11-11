/**
 * Thin wrapper around child_process.spawnSync.
 * Commands run sequentially by design: each upgrade must finish (install + tests)
 * before the next one starts.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { commandFinished, commandStarted } from './command-echo.ts';
import { AbortError, CommandError } from './errors.ts';
import { formatCommandEntry } from './logfile.ts';
import { runtime } from './runtime.ts';

const IS_WINDOWS = process.platform === 'win32';
const MAX_BUFFER = 256 * 1024 * 1024;

export interface RunOptions {
  cwd?: string;
  /** Return the result instead of throwing on non-zero exit. */
  allowFailure?: boolean;
  /** Run `command` through the shell (used for user-supplied test commands). */
  shell?: boolean;
  env?: Record<string, string>;
  /**
   * Append the command and its output to this file
   * (default: the run's commands.log, see runtime.ts).
   */
  logFile?: string;
  timeoutMs?: number;
  /** Text written to the command's stdin. */
  input?: string;
}

export interface RunResult {
  ok: boolean;
  status: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export function run(
  command: string,
  args: string[],
  { cwd, allowFailure = false, shell = false, env, logFile = runtime().commandLog, timeoutMs, input }: RunOptions = {},
): RunResult {
  const display = [command, ...args].join(' ');
  const started = Date.now();
  commandStarted(display);

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

  if (child.signal === 'SIGINT' || child.error) {
    commandFinished(display, { ok: false, status: null, signal: child.signal ?? (child.error as NodeJS.ErrnoException).code, stdout: '', stderr: '', durationMs: Date.now() - started });
  }
  if (child.signal === 'SIGINT') throw new AbortError();
  if (child.error) throw child.error;

  const result: RunResult = {
    ok: child.status === 0,
    status: child.status,
    signal: child.signal,
    stdout: child.stdout ?? '',
    stderr: child.stderr ?? '',
    durationMs: Date.now() - started,
  };

  if (logFile) appendFileSync(logFile, formatCommandEntry(display, result));
  commandFinished(display, result, logFile);

  if (!result.ok && !allowFailure) throw new CommandError(display, result);
  return result;
}
