/**
 * Extracts the useful parts of a failed test run: which test files and tests
 * failed, the error messages, and where in the project's code they were thrown.
 *
 * Understands the output of jest, vitest, mocha and node:test (spec and TAP
 * reporters). For anything else it still finds errors and stack locations.
 * Pure logic so it can be unit-tested with captured output.
 */
import { isAbsolute, relative } from 'node:path';

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const SCRIPT_FILE = String.raw`[^\s()'"]+?\.[cm]?[jt]sx?`;
const TEST_FILE_RE = /(?:^|[/\\])(?:__tests__|tests?|spec)[/\\]|\.(?:test|spec)\.[cm]?[jt]sx?$/;

const MAX_ERRORS = 8;
const MAX_LOCATIONS = 6;
const MAX_EXCERPT = 25;

const PATTERNS = {
  // jest: "FAIL src/a.test.js"   vitest: "FAIL  src/a.test.ts > suite > test"
  failFile: new RegExp(String.raw`^FAIL\s+(${SCRIPT_FILE})(?::\d+(?::\d+)?)?(?:\s+>\s+(.+?))?(?:\s+\(.*\))?$`),
  // vitest: "❯ src/a.test.ts (3 tests | 1 failed) 5ms"
  vitestFile: new RegExp(String.raw`^❯\s+(${SCRIPT_FILE})\s+\(.*\bfailed\b`),
  // vitest: "× suite > test 3ms"
  vitestTest: /^[×✗]\s+(.+?)(?:\s+\d+(?:\.\d+)?m?s)?$/,
  // jest: "● suite › test"
  jestTest: /^●\s+(.+)$/,
  // node:test spec: "✖ test name (1.2ms)" and the file line "test at test/a.test.mjs:5:1"
  nodeTest: /^✖\s+(.+?)(?:\s+\(\d+(?:\.\d+)?m?s\))?$/,
  nodeTestFile: new RegExp(String.raw`^test at (?:file://)?(${SCRIPT_FILE}):\d+:\d+$`),
  // TAP (node --test-reporter=tap, tape, ...): "not ok 1 - name" + "location: '/abs/file.js:5:1'"
  tapTest: /^not ok \d+ - (.+)$/,
  tapLocation: new RegExp(String.raw`^location:\s*'(?:file://)?(${SCRIPT_FILE}):\d+:\d+'$`),
  // mocha: "2 failing" then "1) suite" / "     test title:"
  mochaFailing: /^\d+ failing$/,
  mochaTest: /^\d+\)\s+(.+)$/,
  // stack frame: "at fn (/abs/file.js:3:8)" or "at /abs/file.js:3:8"
  stackFrame: new RegExp(String.raw`^at\s+(?:.*?\()?(?:file://)?(${SCRIPT_FILE}):(\d+):(\d+)\)?$`),
  error: /^(?:[\w.$]*(?:Error|Exception)\b(?! \[ERR_TEST_FAILURE\]).*|expect\(.+|Expected:?\s.+|Received:?\s.+|[+-] (?:Expected|Received)\b.*)$/,
  summary: /^(?:Tests?:\s.*\bfailed\b.*|Test Files\s.*\bfailed\b.*|ℹ fail [1-9]\d*|# fail [1-9]\d*|\d+ failing)$/,
  noise: /^(?:npm (?:ERR!|error|warn)|>\s|at\s.*(?:node:internal|node_modules|\(node:)|at node:|Node\.js v\d)/,
};

// jest uses "●" for console output blocks too; node:test prints "✖ failing tests:" as a heading.
const IGNORED_TEST_NAMES = new Set(['failing tests:', 'Test suite failed to run', 'Console']);

/**
 * @typedef {object} TestFailureAnalysis
 * @property {Array<{file: string, tests: string[]}>} files  failing test files and the tests that failed in each
 * @property {string[]} tests       failing tests whose file could not be determined
 * @property {string[]} errors      error / assertion messages (first few, de-duplicated)
 * @property {string[]} locations   "file:line:col" in the project's own code, from stack traces
 * @property {string|null} summary  the runner's own summary line, e.g. "Tests: 1 failed, 4 passed"
 * @property {string[]} excerpt     last relevant output lines (npm noise and internal frames removed)
 */

/**
 * @param {string} output  combined stdout + stderr of the test command
 * @param {string} cwd     project root, used to make paths relative
 * @returns {TestFailureAnalysis}
 */
export function analyzeTestOutput(output, cwd) {
  const lines = stripAnsi(output).replace(/\r/g, '').split('\n').map((line) => line.trimEnd());
  const files = new Map();
  const looseTests = new Set();
  const errors = new Set();
  const locations = new Set();
  let summary = null;
  let currentFile = null;
  let inMochaFailures = false;

  const addFile = (path) => {
    const file = toProjectPath(path, cwd);
    if (!files.has(file)) files.set(file, new Set());
    return file;
  };
  const addTest = (name) => {
    if (IGNORED_TEST_NAMES.has(name)) return;
    if (currentFile) files.get(currentFile).add(name);
    else looseTests.add(name);
  };

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i].trim();
    if (!text) continue;
    let match;

    if ((match = PATTERNS.failFile.exec(text)) || (match = PATTERNS.vitestFile.exec(text))) {
      currentFile = addFile(match[1]);
      if (match[2]) addTest(match[2]);
    } else if ((match = PATTERNS.nodeTestFile.exec(text))) {
      currentFile = addFile(match[1]);
    } else if ((match = PATTERNS.tapLocation.exec(text))) {
      // TAP prints the location after the test, so move the last loose test under its file.
      const file = addFile(match[1]);
      const last = [...looseTests].at(-1);
      if (last) {
        looseTests.delete(last);
        files.get(file).add(last);
      }
    } else if ((match = PATTERNS.jestTest.exec(text)) || (match = PATTERNS.vitestTest.exec(text))) {
      addTest(match[1]);
    } else if ((match = PATTERNS.nodeTest.exec(text))) {
      addTest(match[1]);
    } else if ((match = PATTERNS.tapTest.exec(text))) {
      looseTests.add(match[1]);
    } else if (PATTERNS.mochaFailing.test(text)) {
      inMochaFailures = true;
    } else if (inMochaFailures && (match = PATTERNS.mochaTest.exec(text))) {
      // mocha prints the suite on this line and the test title (ending in ":") on the next.
      const next = lines[i + 1]?.trim() ?? '';
      addTest(next.endsWith(':') ? `${match[1]} › ${next.slice(0, -1)}` : match[1]);
    } else if ((match = PATTERNS.stackFrame.exec(text))) {
      const path = match[1];
      if (!/node_modules|^node:|^internal[/\\]/.test(path) && isInsideProject(path, cwd)) {
        const file = toProjectPath(path, cwd);
        if (locations.size < MAX_LOCATIONS) locations.add(`${file}:${match[2]}:${match[3]}`);
        if (TEST_FILE_RE.test(file)) addFile(file);
      }
    }

    if (PATTERNS.summary.test(text)) summary = text;
    if (errors.size < MAX_ERRORS && PATTERNS.error.test(text)) errors.add(text);
  }

  // node:test lists failures twice (inline and again under "failing tests:"); keep the entries that have a file.
  const filed = new Set([...files.values()].flatMap((tests) => [...tests]));
  return {
    files: [...files].map(([file, tests]) => ({ file, tests: [...tests] })),
    tests: [...looseTests].filter((name) => !filed.has(name)),
    errors: [...errors],
    locations: [...locations],
    summary,
    excerpt: lines.filter((line) => line.trim() && !PATTERNS.noise.test(line.trim())).slice(-MAX_EXCERPT),
  };
}

export const stripAnsi = (text) => String(text).replace(ANSI_RE, '');

function isInsideProject(path, cwd) {
  if (!isAbsolute(path)) return true;
  const rel = relative(cwd, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function toProjectPath(path, cwd) {
  const clean = path.replace(/^file:\/\//, '');
  return isAbsolute(clean) && isInsideProject(clean, cwd) ? relative(cwd, clean) : clean;
}
