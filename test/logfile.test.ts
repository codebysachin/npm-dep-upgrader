import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatErrorEntry, OUTPUT_TAIL_LINES } from '../lib/logfile.ts';

const at = new Date(2026, 10, 12, 9, 5, 7);

test('an errors.log entry has the step, reason, outcome, log file, details and failed command', () => {
  const text = formatErrorEntry(2, {
    step: 'upgrade chalk 4.1.2 → 6.0.1',
    reason: 'npm install failed: ERESOLVE (peer dependency conflict)',
    outcome: 'rolling back chalk to 4.1.2',
    logFile: '/tmp/logs/004-upgrade-chalk.log',
    details: ['code ERESOLVE', '\x1b[31mcould not resolve\x1b[0m'],
    command: { command: 'npm install chalk@^6.0.1', ok: false, status: 1, signal: null, stdout: '', stderr: 'npm error code ERESOLVE\n', durationMs: 1250 },
  }, at);

  assert.match(text, /^\n═+\n#2  09:05:07  upgrade chalk 4\.1\.2 → 6\.0\.1\n═+\n/);
  assert.match(text, /\nError: {5}npm install failed: ERESOLVE \(peer dependency conflict\)\n/);
  assert.match(text, /\nOutcome: {3}rolling back chalk to 4\.1\.2\n/);
  assert.match(text, /\nFull log: {2}004-upgrade-chalk\.log\n/, 'the file name, which sits next to errors.log');
  assert.match(text, /\nDetails\n {2}code ERESOLVE\n {2}could not resolve\n/, 'colours are stripped');
  assert.match(text, /\nFailed command\n {2}\$ npm install chalk@\^6\.0\.1\n {2}exit 1 · 1\.3s\n {2}\[stderr\]\n {2}npm error code ERESOLVE\n$/);
  assert.doesNotMatch(text, /\[stdout\]/, 'empty output is left out');
});

test('only the end of a long output is copied; the step log has all of it', () => {
  const stdout = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\n');
  const text = formatErrorEntry(1, {
    step: 'baseline tests (main)',
    reason: 'tests fail before any change',
    command: { command: 'npm test', ok: false, status: null, signal: 'SIGTERM', stdout, stderr: '', durationMs: 60000 },
  }, at);

  assert.match(text, new RegExp(`signal SIGTERM · 60\\.0s\\n {2}\\[stdout: last ${OUTPUT_TAIL_LINES} of 100 lines\\]\\n {2}line ${101 - OUTPUT_TAIL_LINES}\\n`));
  assert.match(text, / {2}line 100\n$/);
  assert.doesNotMatch(text, /line 60\n/);
  assert.doesNotMatch(text, /Outcome|Full log|Details/, 'optional parts are left out');
});
