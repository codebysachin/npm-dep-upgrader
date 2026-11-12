/**
 * Layout of the files in the run's log folder:
 *
 *   run.log                one line per step: time, result, what was done, which log file
 *   NNN-<step>.log         every command a step ran, its exit code, duration and output,
 *                          followed by a failure analysis when the step failed
 *   errors.log             only what failed, for investigating: created at the first error
 *   mr-summary.md          the Markdown summary for the MR
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { RunResult } from './exec.ts';
import { stripAnsi } from './test-output.ts';

const RULE = '═'.repeat(78);
const THIN_RULE = '─'.repeat(78);

const clock = (date: Date = new Date()): string => date.toTimeString().slice(0, 8);
const timestamp = (date: Date = new Date()): string => `${date.toISOString().slice(0, 10)} ${clock(date)}`;

export function writeStepLogHeader(file: string, { step, cwd }: { step: string; cwd: string }): void {
  writeFileSync(file, [RULE, `Step:     ${step}`, `Project:  ${cwd}`, `Started:  ${timestamp()}`, RULE, ''].join('\n'));
}

/** Text appended to a step log for each command it ran. */
export function formatCommandEntry(display: string, result: RunResult): string {
  const status = result.ok ? 'OK' : `FAILED (exit ${result.status ?? result.signal})`;
  const block = (name: string, text: string): string[] => {
    const clean = stripAnsi(text).trimEnd();
    return clean ? [`[${name}]`, clean, ''] : [];
  };
  return [
    '',
    `$ ${display}`,
    `  ${status} · ${(result.durationMs / 1000).toFixed(1)}s · finished ${clock()}`,
    THIN_RULE,
    ...block('stdout', result.stdout),
    ...block('stderr', result.stderr),
  ].join('\n') + '\n';
}

export function appendLogSection(file: string, title: string, lines: string[]): void {
  appendFileSync(file, ['', RULE, title, RULE, ...lines, ''].join('\n'));
}

/** One failure, as written to errors.log. */
export interface ErrorEntry {
  /** what was being done, e.g. "upgrade chalk 4.1.2 → 6.0.1" */
  step: string;
  /** one line: what went wrong */
  reason: string;
  /** what the tool did about it, e.g. "rolling back chalk to 4.1.2" */
  outcome?: string;
  /** the step's full log */
  logFile?: string;
  /** explanation: failing tests, npm's error lines, how to fix */
  details?: string[];
  /** the command that failed; the end of its output is copied */
  command?: RunResult;
}

/** How much of a failed command's stdout and stderr errors.log keeps; the step log has all of it. */
export const OUTPUT_TAIL_LINES = 40;

export function writeErrorLogHeader(file: string, { cwd, runIndex }: { cwd: string; runIndex: string }): void {
  writeFileSync(
    file,
    [
      `npm-dep-upgrader errors — ${timestamp()}`,
      `Project:  ${cwd}`,
      `Only what failed. Every step, passed or failed, is in ${basename(runIndex)}.`,
      '',
    ].join('\n'),
  );
}

/** Text of one errors.log entry. */
export function formatErrorEntry(number: number, entry: ErrorEntry, date: Date = new Date()): string {
  const lines = ['', RULE, `#${number}  ${clock(date)}  ${entry.step}`, RULE, `Error:     ${entry.reason}`];
  if (entry.outcome) lines.push(`Outcome:   ${entry.outcome}`);
  if (entry.logFile) lines.push(`Full log:  ${basename(entry.logFile)}`);
  if (entry.details?.length) lines.push('', 'Details', ...entry.details.map((line) => `  ${stripAnsi(line)}`));

  const result = entry.command;
  if (result) {
    const status = result.signal ? `signal ${result.signal}` : `exit ${result.status}`;
    lines.push('', 'Failed command', `  $ ${result.command ?? '(unknown)'}`, `  ${status} · ${(result.durationMs / 1000).toFixed(1)}s`);
    for (const [name, text] of [['stdout', result.stdout], ['stderr', result.stderr]] as const) {
      const all = stripAnsi(text ?? '').trimEnd().split('\n');
      if (!all.join('').trim()) continue;
      const shown = all.slice(-OUTPUT_TAIL_LINES);
      const label = shown.length < all.length ? `[${name}: last ${shown.length} of ${all.length} lines]` : `[${name}]`;
      lines.push(`  ${label}`, ...shown.map((line) => `  ${line}`));
    }
  }
  return `${lines.join('\n')}\n`;
}

/** Adds one line to run.log. */
export function appendRunIndex(file: string, { ok, step, logFile }: { ok: boolean | null; step: string; logFile?: string }): void {
  const mark = ok === null ? '•  INFO' : ok ? '✔  PASS' : '✖  FAIL';
  const entry = `${clock()}  ${mark}  ${step.padEnd(56)}  ${logFile ? basename(logFile) : ''}`.trimEnd();
  appendFileSync(file, `${entry}\n`);
}

export function writeRunIndexHeader(file: string, { cwd, testCommand }: { cwd: string; testCommand: string }): void {
  writeFileSync(
    file,
    [`npm-dep-upgrader run — ${timestamp()}`, `Project:       ${cwd}`, `Test command:  ${testCommand}`, THIN_RULE, ''].join('\n'),
  );
}
