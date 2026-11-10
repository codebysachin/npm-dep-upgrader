import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSelection } from '../lib/selection.mjs';

const items = ['chalk', 'lodash', 'make-dir', 'mkdirp', 'ms'].map((name) => ({ name }));
const pick = (input, emptyMeansNone = false) => {
  const result = parseSelection(input, items, { nameOf: (i) => i.name, emptyMeansNone });
  return 'selected' in result ? result.selected.map((i) => i.name) : result;
};

test('numbers, ranges and names keep the typed order', () => {
  assert.deepEqual(pick('3,1'), ['make-dir', 'chalk']);
  assert.deepEqual(pick('ms 2-3'), ['ms', 'lodash', 'make-dir']);
  assert.deepEqual(pick('2, 2 lodash'), ['lodash'], 'duplicates are removed');
});

test('all and none keywords', () => {
  assert.equal(pick('all').length, 5);
  assert.deepEqual(pick('none'), []);
  assert.ok('error' in pick('q'), '"q" means quit (handled by the prompt), never "select nothing"');
});

test('empty input depends on the round', () => {
  assert.ok('error' in pick('', false), 'first round requires an explicit choice');
  assert.deepEqual(pick('  ', true), [], 'later rounds: Enter finishes');
});

test('invalid input returns an error message', () => {
  assert.match(pick('9').error, /not in the list/);
  assert.match(pick('4-9').error, /out of bounds/);
  assert.match(pick('react').error, /not in the list/);
});
