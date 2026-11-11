import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findRelated, runAuto } from '../lib/auto.mjs';
import { conflictingPackages } from '../lib/failure-report.mjs';
import { normaliseRepository } from '../lib/npm.mjs';
import { fallbackTargets } from '../lib/plan.mjs';
import { emptyResults } from '../lib/session.mjs';

const item = (name, to = '2.0.0', from = '1.0.0') => ({ name, from, to, spec: `^${to}` });
const unit = (...members) => ({ name: members.map((m) => m.name).join(' + '), members, links: [], requires: [] });
const step = (u) => ({ ...u, pulledIn: [] });
const names = (list) => list.map((i) => i.name);

/**
 * An upgrader driven by `passes(installed)`: given the versions that would be installed after a
 * step, says whether it passes. Records every attempt.
 */
function fakeNpm(passes, { conflictsOn = {} } = {}) {
  const installed = {};
  const calls = [];
  const upgrade = (s, position) => {
    calls.push({ names: names(s.members), to: s.members.map((m) => m.to), attempt: position.attempt, pass: position.pass });
    const next = { ...installed, ...Object.fromEntries(s.members.map((m) => [m.name, m.to])) };
    const conflict = s.members.map((m) => conflictsOn[m.name]).find(Boolean);
    if (conflict && !s.members.some((m) => m.name === conflict)) {
      return {
        ok: false,
        items: s.members.map((m) => ({ ...m, reason: 'npm install failed: ERESOLVE (peer dependency conflict)' })),
        failure: { kind: 'install', code: 'ERESOLVE', lines: [`peer ${conflict}@"^2.0.0" from ${s.members[0].name}@2.0.0`] },
      };
    }
    if (!passes(next)) return { ok: false, items: s.members.map((m) => ({ ...m, reason: 'tests fail' })), failure: { kind: 'tests' } };
    Object.assign(installed, next);
    return { ok: true, items: s.members };
  };
  return { upgrade, calls, installed };
}

const related = (s, failure, candidates) =>
  findRelated(s, candidates, { conflicts: failure?.lines ? conflictingPackages(failure.lines) : [] });
const noFallbacks = () => [];
const replanFrom = (all) => ({ upgraded }) => all.filter((u) => !u.members.some((m) => upgraded.has(m.name)));

test('conflictingPackages reads the package names out of an npm ERESOLVE error', () => {
  const lines = [
    'ERESOLVE unable to resolve dependency tree',
    'While resolving: my-app@1.0.0',
    'Found: eslint@8.57.1',
    'node_modules/eslint',
    '  dev eslint@"^8.57.1" from the root project',
    'peer eslint@"^9.0.0" from @typescript-eslint/parser@8.20.0',
    'Conflicting peer dependency: @types/node@20.1.0',
  ];
  assert.deepEqual(conflictingPackages(lines), ['my-app', 'eslint', '@typescript-eslint/parser', '@types/node']);
});

test('normaliseRepository makes the usual repository forms comparable', () => {
  assert.deepEqual(
    ['git+https://github.com/Org/Repo.git', 'git@github.com:org/repo.git', 'org/repo', 'github:org/repo', null].map(normaliseRepository),
    ['github.com/org/repo', 'github.com/org/repo', 'github.com/org/repo', 'github.com/org/repo', null],
  );
});

test('fallbackTargets offers the newest release in the current major, then in the current minor', () => {
  const published = ['4.18.0', '4.18.3', '4.21.0', '5.0.0', '5.1.0', '4.22.0-beta.1'];
  const targets = fallbackTargets({ ...item('express', '5.1.0', '4.18.0'), spec: '^5.1.0' }, published);
  assert.deepEqual(targets.map((t) => [t.to, t.spec, t.change]), [['4.21.0', '^4.21.0', 'minor'], ['4.18.3', '^4.18.3', 'patch']]);
  assert.deepEqual(fallbackTargets(item('ms', '2.1.3', '2.1.2'), ['2.1.2', '2.1.3']), [], 'nothing between from and to');
});

test('findRelated picks packages npm names, and ones from the same repository or scope', () => {
  const failed = step(unit(item('@acme/ui')));
  const candidates = [unit(item('@acme/theme')), unit(item('react')), unit(item('@types/react')), unit(item('icons')), unit(item('lodash'))];
  const repositoryOf = (m) => ({ '@acme/ui': 'gitlab.example/acme/web', icons: 'gitlab.example/acme/web' })[m.name] ?? null;
  const { units, blockers } = findRelated(failed, candidates, {
    conflicts: ['app', 'react', 'scheduler', '@acme/ui'],
    repositoryOf,
    projectName: 'app',
  });
  assert.deepEqual(names(units), ['@acme/theme', 'react', 'icons'], 'same scope, named by npm, same repository; @types is not a family');
  assert.deepEqual(blockers, ['scheduler'], 'named by npm but not upgradable here; the project and the step itself are left out');
});

test('a peer conflict is retried together with the package npm names', async () => {
  const [plugin, core] = [unit(item('plugin')), unit(item('core'))];
  const npm = fakeNpm(() => true, { conflictsOn: { plugin: 'core' } });
  const results = emptyResults();

  await runAuto({ units: [plugin, core], upgrade: npm.upgrade, replan: replanFrom([plugin, core]), related, fallbacks: noFallbacks, results });

  assert.deepEqual(npm.calls.map((c) => [c.names, c.attempt]), [[['plugin'], 1], [['plugin', 'core'], 2]], 'core is not tried again on its own');
  assert.deepEqual(names(results.upgraded), ['plugin', 'core']);
  assert.equal(results.upgraded[0].tried.length, 1, 'the failed first attempt is kept for the report');
  assert.deepEqual(results.failed, []);
});

test('a package that keeps failing gets a smaller upgrade instead', async () => {
  const express = unit({ ...item('express', '5.1.0', '4.18.0'), spec: '^5.1.0' });
  const npm = fakeNpm((v) => !v.express.startsWith('5.'));
  const results = emptyResults();

  await runAuto({
    units: [express],
    upgrade: npm.upgrade,
    replan: () => [],
    related,
    fallbacks: (i) => fallbackTargets(i, ['4.18.0', '4.18.3', '4.21.0', '5.1.0']),
    results,
  });

  assert.deepEqual(npm.calls.map((c) => c.to[0]), ['5.1.0', '4.21.0']);
  assert.deepEqual(results.upgraded.map((u) => [u.to, u.spec, u.instead]), [['4.21.0', '^4.21.0', '5.1.0']]);
});

test('failed packages are retried in a later pass only after something else was upgraded', async () => {
  const [a, b, c] = [unit(item('a')), unit(item('b')), unit(item('c'))];
  // a passes once b is upgraded; c never passes.
  const npm = fakeNpm((v) => (!v.a || v.b) && !v.c);
  const results = emptyResults();
  const passes = [];

  await runAuto({
    units: [a, b, c],
    upgrade: npm.upgrade,
    replan: replanFrom([a, b, c]),
    related,
    fallbacks: noFallbacks,
    results,
    onPass: (pass, steps) => passes.push([pass, steps.map((s) => s.name)]),
  });

  assert.deepEqual(passes, [
    [1, ['a', 'b', 'c']],
    [2, ['a']], // c failed after b passed: nothing new for it yet
    [3, ['c']], // a passed in pass 2, so c is worth one more try; then nothing changes and the run stops
  ]);
  assert.deepEqual(names(results.upgraded), ['b', 'a']);
  assert.deepEqual(results.failed.map((f) => [f.name, f.reason]), [['c', 'tests fail']]);
});

test('attempts per step are limited', async () => {
  const x = unit(item('x', '9.0.0', '1.0.0'));
  const npm = fakeNpm(() => false);
  const results = emptyResults();
  const many = ['1.1.0', '1.2.0', '1.3.0', '1.4.0'].map((to) => ({ ...item('x', to, '1.0.0') }));

  await runAuto({ units: [x], upgrade: npm.upgrade, replan: () => [x], related, fallbacks: () => many, results, maxAttempts: 3 });

  assert.equal(npm.calls.length, 3, 'one pass only: nothing else changed');
  assert.equal(results.failed[0].attempts.length, 3);
});
