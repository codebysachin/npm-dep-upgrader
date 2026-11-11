/**
 * Turns failed commands into readable explanations for the terminal and the
 * step log files. Pure functions: styling is passed in, so the
 * same text can be coloured for the terminal and plain for files.
 */
import type { RunResult } from './exec.ts';
import { stripAnsi, type TestFailureAnalysis } from './test-output.ts';

export interface FailureStyle {
  heading: (s: string) => string;
  label: (s: string) => string;
  dim: (s: string) => string;
  bad: (s: string) => string;
}

export interface NpmErrorSummary {
  code: string | null;
  lines: string[];
}

/** The parts of a command result these functions read. */
type CommandOutput = Pick<RunResult, 'stdout' | 'stderr'>;

const PLAIN: FailureStyle = { heading: (s) => s, label: (s) => s, dim: (s) => s, bad: (s) => s };
const MAX_FILES_IN_REASON = 3;

/**
 * Sectioned explanation of a test failure.
 * @param options.includeExcerpt the log file already has the full output, so it skips this
 */
export function renderTestFailure(
  analysis: TestFailureAnalysis,
  { style = PLAIN, includeExcerpt = true }: { style?: FailureStyle; includeExcerpt?: boolean } = {},
): string[] {
  const lines: string[] = [];
  const section = (title: string, body: string[]): void => {
    if (!body.length) return;
    lines.push(style.label(title), ...body.map((line) => `  ${line}`));
  };

  if (analysis.summary) section('Result', [analysis.summary]);

  const testLines = analysis.files.flatMap(({ file, tests }) => [
    style.bad(file),
    ...tests.map((test) => `  • ${test}`),
  ]);
  if (analysis.tests.length) {
    testLines.push(style.dim('(file not reported by the test runner)'), ...analysis.tests.map((t) => `  • ${t}`));
  }
  section('Failing tests', testLines);
  section('Errors', analysis.errors);
  section('Thrown at', analysis.locations);
  if (includeExcerpt) section(`Output (last ${analysis.excerpt.length} relevant lines)`, analysis.excerpt.map(style.dim));

  if (!lines.length) lines.push(style.dim('The test output did not contain recognisable failure details.'));
  return lines;
}

/** One-line, plain-text reason, e.g. "tests fail in test/a.test.js, test/b.test.js". */
export function testFailureReason(analysis: TestFailureAnalysis, prefix: string): string {
  const names = analysis.files.map((f) => f.file);
  if (names.length) {
    const shown = names.slice(0, MAX_FILES_IN_REASON).join(', ');
    const more = names.length > MAX_FILES_IN_REASON ? ` and ${names.length - MAX_FILES_IN_REASON} more` : '';
    return `${prefix} in ${shown}${more}`;
  }
  const firstError = analysis.errors[0];
  return firstError ? `${prefix}: ${truncate(firstError, 90)}` : prefix;
}

/**
 * The meaningful part of a failed npm command: its "npm error" lines.
 */
export function summarizeNpmError(result: CommandOutput): NpmErrorSummary {
  const all = stripAnsi(`${result.stdout}\n${result.stderr}`).split('\n');
  const errorLines = all
    .map((line) => /^npm (?:error|ERR!)\s?(.*)$/.exec(line.trim())?.[1])
    .filter((line) => line !== undefined && line.trim() && !/A complete log of this run|^\s*\/.*\.log$/.test(line));
  const code = all.map((line) => /^npm (?:error|ERR!) code (\S+)/.exec(line.trim())?.[1]).find(Boolean) ?? null;
  return { code, lines: (errorLines.length ? errorLines : all.filter((l) => l.trim()).slice(-10)).slice(0, 15) };
}

/**
 * When `npm ci` refused to run because package.json and the lockfile disagree,
 * returns npm's list of mismatches (e.g. "Missing: lodash@4.18.1 from lock file").
 * Returns null for any other failure.
 */
export function lockfileSyncProblems(result: CommandOutput): string[] | null {
  const { code, lines } = summarizeNpmError(result);
  if (code !== 'EUSAGE' || !lines.some((line) => /\bin sync\b/.test(line))) return null;
  const all = stripAnsi(`${result.stdout}\n${result.stderr}`).split('\n');
  return all
    .map((line) => /^npm (?:error|ERR!)\s+((?:Missing|Invalid):.*)$/.exec(line.trim())?.[1])
    .filter(Boolean);
}

const NPM_CODE_HINTS: Record<string, string> = {
  ERESOLVE: 'peer dependency conflict',
  ETARGET: 'version not found in the registry',
  E404: 'package not found in the registry',
  E401: 'registry authentication failed',
  E403: 'registry refused access',
  EOVERRIDE: 'conflicts with an override in package.json',
  ENOTFOUND: 'registry could not be reached',
};

export function npmFailureReason({ code }: Pick<NpmErrorSummary, 'code'>): string {
  if (!code) return 'npm install failed';
  return `npm install failed: ${code}${NPM_CODE_HINTS[code] ? ` (${NPM_CODE_HINTS[code]})` : ''}`;
}

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * Package names npm mentions in an ERESOLVE error ("Found: eslint@8.57.1",
 * 'peer eslint@"^9.0.0" from @typescript-eslint/parser@8.20.0', "Conflicting peer dependency: ...").
 * The caller keeps only the names it can upgrade, so the root project's own name does no harm.
 * @param lines npm's error lines (summarizeNpmError)
 */
export function conflictingPackages(lines: string[]): string[] {
  const names = new Set<string>();
  for (const line of lines) {
    for (const match of line.matchAll(/(?:^|[\s"'(])((?:@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*)@["'^~<>=\d*xX]/gi)) {
      names.add(match[1]);
    }
  }
  return [...names];
}
