/**
 * Turns failed commands into readable explanations for the terminal, the step
 * log files and the MR summary. Pure functions: styling is passed in, so the
 * same text can be coloured for the terminal and plain for files.
 */
import { stripAnsi } from './test-output.mjs';

const PLAIN = { heading: (s) => s, label: (s) => s, dim: (s) => s, bad: (s) => s };
const MAX_FILES_IN_REASON = 3;

/**
 * Sectioned explanation of a test failure.
 * @param {import('./test-output.mjs').TestFailureAnalysis} analysis
 * @param {object} [options]
 * @param {typeof PLAIN} [options.style]
 * @param {boolean} [options.includeExcerpt]  the log file already has the full output, so it skips this
 * @returns {string[]}
 */
export function renderTestFailure(analysis, { style = PLAIN, includeExcerpt = true } = {}) {
  const lines = [];
  const section = (title, body) => {
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

/** One-line reason for tables, e.g. "tests fail in `test/a.test.js`, `test/b.test.js`". */
export function testFailureReason(analysis, prefix) {
  const names = analysis.files.map((f) => f.file);
  if (names.length) {
    const shown = names.slice(0, MAX_FILES_IN_REASON).map((n) => `\`${n}\``).join(', ');
    const more = names.length > MAX_FILES_IN_REASON ? ` and ${names.length - MAX_FILES_IN_REASON} more` : '';
    return `${prefix} in ${shown}${more}`;
  }
  const firstError = analysis.errors[0];
  return firstError ? `${prefix}: ${truncate(firstError, 90)}` : prefix;
}

/**
 * The meaningful part of a failed npm command: its "npm error" lines.
 * @returns {{ code: string|null, lines: string[] }}
 */
export function summarizeNpmError(result) {
  const all = stripAnsi(`${result.stdout}\n${result.stderr}`).split('\n');
  const errorLines = all
    .map((line) => /^npm (?:error|ERR!)\s?(.*)$/.exec(line.trim())?.[1])
    .filter((line) => line !== undefined && line.trim() && !/A complete log of this run|^\s*\/.*\.log$/.test(line));
  const code = all.map((line) => /^npm (?:error|ERR!) code (\S+)/.exec(line.trim())?.[1]).find(Boolean) ?? null;
  return { code, lines: (errorLines.length ? errorLines : all.filter((l) => l.trim()).slice(-10)).slice(0, 15) };
}

const NPM_CODE_HINTS = {
  ERESOLVE: 'peer dependency conflict',
  ETARGET: 'version not found in the registry',
  E404: 'package not found in the registry',
  E401: 'registry authentication failed',
  E403: 'registry refused access',
  EOVERRIDE: 'conflicts with an override in package.json',
  ENOTFOUND: 'registry could not be reached',
};

export function npmFailureReason({ code }) {
  if (!code) return 'npm install failed';
  return `npm install failed: ${code}${NPM_CODE_HINTS[code] ? ` (${NPM_CODE_HINTS[code]})` : ''}`;
}

/** Collapsible Markdown block with the details of one failure, for the MR summary. */
export function renderFailureMarkdown(title, failure) {
  const out = [`<details><summary>${title}</summary>`, ''];

  if (failure.kind === 'tests') {
    const { analysis } = failure;
    if (analysis.summary) out.push(`**Result:** ${analysis.summary}`, '');
    if (analysis.files.length || analysis.tests.length) {
      out.push('**Failing tests**', '');
      for (const { file, tests } of analysis.files) {
        out.push(`- \`${file}\``, ...tests.map((t) => `  - ${t}`));
      }
      for (const test of analysis.tests) out.push(`- ${test}`);
      out.push('');
    }
    if (analysis.errors.length) out.push('**Errors**', '', '```text', ...analysis.errors, '```', '');
    if (analysis.locations.length) out.push(`**Thrown at:** ${analysis.locations.map((l) => `\`${l}\``).join(', ')}`, '');
  } else {
    out.push('```text', ...failure.lines, '```', '');
  }

  out.push('</details>');
  return out.join('\n');
}

const truncate = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
