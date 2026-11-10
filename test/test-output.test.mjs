import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyzeTestOutput } from '../lib/test-output.mjs';
import { lockfileSyncProblems, summarizeNpmError, testFailureReason } from '../lib/failure-report.mjs';

test('lockfileSyncProblems recognises an out-of-sync lockfile', () => {
  const stderr = [
    'npm error code EUSAGE',
    'npm error',
    'npm error `npm ci` can only install packages when your package.json and package-lock.json or npm-shrinkwrap.json are in sync. Please update your lock file with `npm install` before continuing.',
    'npm error',
    'npm error Missing: lodash@4.18.1 from lock file',
    'npm error Invalid: lock file\'s ms@2.0.0 does not satisfy ms@~2.1.0',
    'npm error Clean install a project',
  ].join('\n');
  assert.deepEqual(lockfileSyncProblems({ stdout: '', stderr }), [
    'Missing: lodash@4.18.1 from lock file',
    "Invalid: lock file's ms@2.0.0 does not satisfy ms@~2.1.0",
  ]);
  assert.equal(lockfileSyncProblems({ stdout: '', stderr: 'npm error code ERESOLVE\nnpm error could not resolve' }), null);
});

const CWD = '/project';
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test('node:test spec reporter (captured output)', () => {
  const result = analyzeTestOutput(fixture('node-test-spec.txt'), CWD);
  assert.deepEqual(result.files, [
    { file: 'test/math.test.mjs', tests: ['adds numbers'] },
    { file: 'test/str.test.mjs', tests: ['throws'] },
  ]);
  assert.deepEqual(result.tests, []);
  assert.equal(result.summary, 'ℹ fail 2');
  assert.ok(result.errors.some((e) => e.startsWith('AssertionError [ERR_ASSERTION]')));
  assert.ok(result.errors.includes('TypeError: boom is not a function'));
  assert.deepEqual(result.locations, ['test/math.test.mjs:3:37', 'test/str.test.mjs:2:30']);
  assert.ok(result.excerpt.every((line) => !line.includes('node:internal')));
});

test('node:test TAP reporter (captured output)', () => {
  const result = analyzeTestOutput(fixture('node-test-tap.txt'), CWD);
  assert.deepEqual(result.files, [
    { file: 'test/math.test.mjs', tests: ['adds numbers'] },
    { file: 'test/str.test.mjs', tests: ['throws'] },
  ]);
  assert.equal(result.summary, '# fail 2');
});

test('jest', () => {
  const output = `
PASS src/util.test.js
FAIL src/api/client.test.js
  ● Client › fetches users

    expect(received).toBe(expected) // Object.is equality

    Expected: 200
    Received: 500

      12 |   const res = await client.get('/users');
    > 13 |   expect(res.status).toBe(200);

      at Object.<anonymous> (src/api/client.test.js:13:22)

  ● Console

    console.log
      debug output

Test Suites: 1 failed, 1 passed, 2 total
Tests:       1 failed, 7 passed, 8 total
`;
  const result = analyzeTestOutput(output, CWD);
  assert.deepEqual(result.files, [{ file: 'src/api/client.test.js', tests: ['Client › fetches users'] }]);
  assert.equal(result.summary, 'Tests:       1 failed, 7 passed, 8 total');
  assert.deepEqual(result.errors, [
    'expect(received).toBe(expected) // Object.is equality',
    'Expected: 200',
    'Received: 500',
  ]);
  assert.deepEqual(result.locations, ['src/api/client.test.js:13:22']);
});

test('vitest', () => {
  const output = `
 ❯ test/cart.test.ts (3 tests | 1 failed) 12ms
   × cart > applies discount 4ms
 ✓ test/user.test.ts (2 tests) 3ms

 FAIL  test/cart.test.ts > cart > applies discount
AssertionError: expected 90 to be 81 // Object.is equality
 ❯ test/cart.test.ts:22:30

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 4 passed (5)
`;
  const result = analyzeTestOutput(output, CWD);
  assert.deepEqual(result.files, [{ file: 'test/cart.test.ts', tests: ['cart > applies discount'] }]);
  assert.equal(result.summary, 'Test Files  1 failed | 1 passed (2)');
  assert.ok(result.errors[0].startsWith('AssertionError: expected 90 to be 81'));
});

test('mocha', () => {
  const output = `
  Calculator
    ✓ adds
    1) divides

  1 passing (8ms)
  1 failing

  1) Calculator
       divides:
     AssertionError [ERR_ASSERTION]: Infinity == 0
      at Context.<anonymous> (/project/test/calculator.spec.js:9:12)
      at process.processImmediate (node:internal/timers:476:21)
`;
  const result = analyzeTestOutput(output, CWD);
  assert.deepEqual(result.files, [{ file: 'test/calculator.spec.js', tests: [] }]);
  assert.deepEqual(result.tests, ['Calculator › divides']);
  assert.equal(result.summary, '1 failing');
  assert.deepEqual(result.locations, ['test/calculator.spec.js:9:12']);
});

test('unknown runner still yields errors, locations and an excerpt', () => {
  const output = '> app@1.0.0 test\n> node test.js\n\n/project/test.js:3\nTypeError: x is not a function\n    at Object.<anonymous> (/project/test.js:3:1)\n    at node:internal/main:1:1\nnpm error Lifecycle script `test` failed\n';
  const result = analyzeTestOutput(output, CWD);
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.errors, ['TypeError: x is not a function']);
  assert.deepEqual(result.locations, ['test.js:3:1']);
  assert.deepEqual(result.excerpt, ['/project/test.js:3', 'TypeError: x is not a function', '    at Object.<anonymous> (/project/test.js:3:1)']);
});

test('ANSI colours are stripped', () => {
  const result = analyzeTestOutput('\x1b[31mFAIL\x1b[39m src/a.test.js\n\x1b[1m● a › b\x1b[22m', CWD);
  assert.deepEqual(result.files, [{ file: 'src/a.test.js', tests: ['a › b'] }]);
});

test('testFailureReason names the failing files, or falls back to the first error', () => {
  const analysis = analyzeTestOutput(fixture('node-test-spec.txt'), CWD);
  assert.equal(testFailureReason(analysis, 'tests fail'), 'tests fail in `test/math.test.mjs`, `test/str.test.mjs`');
  const noFiles = { files: [], tests: [], errors: ['TypeError: x is not a function'], locations: [], summary: null, excerpt: [] };
  assert.equal(testFailureReason(noFiles, 'tests fail'), 'tests fail: TypeError: x is not a function');
});

test('summarizeNpmError extracts the error code and lines', () => {
  const summary = summarizeNpmError({
    stdout: '',
    stderr: 'npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree\nnpm error A complete log of this run can be found in: /x.log\n',
  });
  assert.equal(summary.code, 'ERESOLVE');
  assert.deepEqual(summary.lines, ['code ERESOLVE', 'ERESOLVE unable to resolve dependency tree']);
});
