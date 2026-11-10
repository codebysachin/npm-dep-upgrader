/**
 * Domain-specific error types. Keeping them in one place lets the CLI entry
 * point decide on exit codes and presentation without string matching.
 */

/** A precondition (git state, project layout, tooling) is not satisfied. */
export class PreflightError extends Error {
  /**
   * @param {string} title  Short headline shown in the banner.
   * @param {Array<{problem: string, fix: string[]}>} issues  What is wrong and how to fix each one.
   */
  constructor(title, issues) {
    super(title);
    this.name = 'PreflightError';
    this.issues = issues;
  }
}

/** A spawned command exited with a non-zero status. */
export class CommandError extends Error {
  constructor(command, result) {
    super(`Command failed (exit ${result.status ?? result.signal}): ${command}`);
    this.name = 'CommandError';
    this.command = command;
    this.result = result;
  }
}

/** The user interrupted the run (Ctrl+C). */
export class AbortError extends Error {
  constructor() {
    super('Interrupted by user');
    this.name = 'AbortError';
  }
}

export const EXIT_CODES = Object.freeze({
  OK: 0,
  PREFLIGHT_FAILED: 1,
  BASELINE_TESTS_FAILED: 2,
  UNEXPECTED: 3,
  INTERRUPTED: 130,
});
