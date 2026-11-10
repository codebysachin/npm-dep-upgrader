import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runRounds } from '../lib/rounds.mjs';
import { emptyResults } from '../lib/session.mjs';

const item = (name, to = '2.0.0') => ({ name, from: '1.0.0', to });
const unit = (...members) => ({ name: members.map((m) => m.name).join(' + '), members, links: [], requires: [] });
const step = (u) => ({ ...u, pulledIn: [] });
const names = (list) => list.map((i) => i.name);

/** An upgrader that fails the given names, and records what it was asked to do. */
function fakeUpgrader(failing = new Set()) {
  const calls = [];
  const upgrade = (s, position) => {
    calls.push({ names: names(s.members), retry: position.retry });
    const ok = !s.members.some((m) => failing.has(m.name));
    return { ok, items: ok ? s.members : s.members.map((m) => ({ ...m, reason: 'tests fail' })) };
  };
  return { upgrade, calls };
}

test('one round: upgrades the picks, records failures, lists what was not picked as skipped', async () => {
  const [a, b, c] = [unit(item('a')), unit(item('b')), unit(item('c'))];
  const { upgrade, calls } = fakeUpgrader(new Set(['b']));
  const results = emptyResults();

  await runRounds({ pending: [a, b, c], selected: [step(a), step(b)], upgrade, replan: null, choose: null, repeat: false, results });

  assert.deepEqual(calls.map((c) => c.names), [['a'], ['b']]);
  assert.deepEqual(names(results.upgraded), ['a']);
  assert.deepEqual(results.failed.map((f) => [f.name, f.reason]), [['b', 'tests fail']]);
  assert.deepEqual(results.skipped, [{ name: 'c', reason: 'not selected (stays at 1.0.0; 2.0.0 available)' }]);
});

test('later rounds: a failed package can be retried, and a passing retry clears the failure', async () => {
  const [a, b] = [unit(item('a')), unit(item('b'))];
  const failing = new Set(['a']);
  const { upgrade, calls } = fakeUpgrader(failing);
  const results = emptyResults();
  const offered = [];
  const answers = [[b, a], []]; // round 2: b then a; round 3: finish

  await runRounds({
    pending: [a, b],
    selected: [step(a)],
    upgrade: (s, position) => {
      if (s.name === 'b') failing.delete('a'); // upgrading b fixes a
      return upgrade(s, position);
    },
    replan: ({ upgraded, failures }) => {
      offered.push({ upgraded: [...upgraded], failed: [...failures.keys()] });
      return [a, b].filter((u) => !upgraded.has(u.name));
    },
    choose: async () => answers.shift(),
    repeat: true,
    results,
  });

  assert.deepEqual(calls, [
    { names: ['a'], retry: false },
    { names: ['b'], retry: false },
    { names: ['a'], retry: true },
  ]);
  assert.deepEqual(offered, [
    { upgraded: [], failed: ['a'] },
    { upgraded: ['b', 'a'], failed: [] },
  ]);
  assert.deepEqual(names(results.upgraded), ['b', 'a']);
  assert.deepEqual(results.failed, []);
  assert.deepEqual(results.skipped, []);
});

test('a later pick that needs another package gets it in the same step', async () => {
  const core = unit(item('core'));
  const pair = unit(item('parser'), item('plugin'));
  core.requires = [{ unit: pair.name, reason: 'plugin@1 only accepts core ^1' }];
  const { upgrade, calls } = fakeUpgrader();
  const answers = [[core], []];

  await runRounds({
    pending: [],
    selected: [],
    upgrade,
    replan: () => [pair, core],
    choose: async () => answers.shift(),
    repeat: true,
    results: emptyResults(),
  });
  assert.deepEqual(calls, [], 'nothing picked in the first round: no later rounds either');

  await runRounds({
    pending: [pair, core],
    selected: [step(pair)],
    upgrade,
    replan: () => [pair, core],
    choose: async () => answers.shift(),
    repeat: true,
    results: emptyResults(),
  });
  assert.deepEqual(calls.map((c) => c.names), [['parser', 'plugin'], ['parser', 'plugin', 'core']]);
});
