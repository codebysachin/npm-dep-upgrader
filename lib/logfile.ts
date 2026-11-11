/**
 * Layout of the files in the run's log folder:
 *
 *   run.log                one line per step: time, result, what was done, which log file
 *   NNN-<step>.log         every command a step ran, its exit code, duration and output,
 *                          followed by a failure analysis when the step failed
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
