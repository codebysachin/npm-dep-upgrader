/**
 * Domain-specific error types. Keeping them in one place lets the CLI entry
 * point decide on exit codes and presentation without string matching.
 */
import type { RunResult } from './exec.ts';

export interface AutoFix {
  label: string;
  args: string[];
  incoming?: string;
}

export interface PreflightIssue {
  problem: string;
  fix: string[];
  autoFix?: AutoFix;
}

/** A precondition (git state, project layout, tooling) is not satisfied. */
export class PreflightError extends Error {
  issues: PreflightIssue[];

  /**
   * @param title Short headline shown in the banner.
   * @param issues What is wrong and how to fix each one; `autoFix` is a git command the script may run for the user.
   */
  constructor(title: string, issues: PreflightIssue[]) {
    super(title);
    this.name = 'PreflightError';
    this.issues = issues;
  }
}

/** A spawned command exited with a non-zero status. */
export class CommandError extends Error {
  command: string;
  result: RunResult;

  constructor(command: string, result: RunResult) {
    super(`Command failed (exit ${result.status ?? result.signal}): ${command}`);
    this.name = 'CommandError';
    this.command = command;
    this.result = result;
  }
}

/** A failure that stops the run and is already in errors.log, so the CLI doesn't record it again. */
export class RecordedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecordedError';
  }
}

/** The user interrupted the run (Ctrl+C). */
export class AbortError extends Error {
  constructor() {
    super('Interrupted by user');
    this.name = 'AbortError';
  }
}

/** The user typed "q" at a prompt. A normal way to stop, not a failure. */
export class QuitError extends Error {
  constructor() {
    super('Quit by user');
    this.name = 'QuitError';
  }
}

export const EXIT_CODES = Object.freeze({
  OK: 0,
  PREFLIGHT_FAILED: 1,
  BASELINE_TESTS_FAILED: 2,
  UNEXPECTED: 3,
  INTERRUPTED: 130,
});
