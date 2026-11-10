import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCommandEcho } from '../lib/command-echo.mjs';

const ok = { ok: true, status: 0, stdout: 'added 3 packages\n\nup to date\n', stderr: '', durationMs: 3140 };
const failed = { ok: false, status: 1, stdout: '', stderr: 'npm error code ERESOLVE\n', durationMs: 900 };

test('folded: one line with the result and a pointer to the output', () => {
  assert.deepEqual(formatCommandEcho('npm ci', ok, { logFile: '/tmp/logs/002-install.log' }), [
    '    ✔ $ npm ci  · 3.1s  ▸ output (2 lines): 002-install.log',
  ]);
  assert.deepEqual(formatCommandEcho('npm install x@2', failed, { logFile: '/tmp/l/004-upgrade-x.log' }), [
    '    · exit 1 $ npm install x@2  · 0.9s  ▸ output (1 line): 004-upgrade-x.log',
  ]);
});

test('no pointer when there is no output', () => {
  const empty = { ...ok, stdout: '' };
  assert.deepEqual(formatCommandEcho('git fetch', empty, { logFile: '/tmp/l/commands.log' }), ['    ✔ $ git fetch  · 3.1s']);
});

test('the pointer is a clickable file link when the terminal supports it', () => {
  const [line] = formatCommandEcho('npm ci', ok, { logFile: '/tmp/a b/x.log', link: (url, text) => `<${url}|${text}>` });
  assert.match(line, /<file:\/\/\/tmp\/a%20b\/x\.log\|▸ output \(2 lines\): x\.log>/);
});

test('verbose: the output is printed under the command instead', () => {
  assert.deepEqual(formatCommandEcho('npm ci', ok, { logFile: '/tmp/x.log', verbose: true }), [
    '    ✔ $ npm ci  · 3.1s',
    '      │ added 3 packages',
    '      │ up to date',
  ]);
});
