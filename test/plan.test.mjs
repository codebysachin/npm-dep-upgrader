import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findPeerLinks, groupUpgrades, nextRoundItems, planSteps, planUpgrades } from '../lib/plan.mjs';

const manifest = {
  dependencies: { express: '^4.18.0', lodash: '4.17.20', 'my-fork': 'github:me/fork' },
  devDependencies: { jest: '~29.0.0' },
};

const outdated = {
  express: { current: '4.18.0', wanted: '4.21.0', latest: '5.1.0' },
  lodash: { current: '4.17.20', wanted: '4.17.20', latest: '4.17.21' },
  'my-fork': { current: '1.0.0', wanted: '1.0.0', latest: '1.0.0' },
  jest: { current: '29.0.3', wanted: '29.0.3', latest: '30.0.0' },
};

const published = {
  express: ['4.18.0', '4.19.0', '4.21.0', '5.0.0', '5.1.0', '5.2.0-beta.1'],
  jest: ['29.0.3', '29.0.5', '29.7.0', '30.0.0'],
};

const plan = (overrides = {}) =>
  planUpgrades({
    outdated,
    manifest,
    target: 'latest',
    only: new Set(),
    exclude: new Set(),
    getVersions: (name) => published[name] ?? [],
    ...overrides,
  });

test('latest target keeps the original range prefix and save flags', () => {
  const { planned, skipped } = plan();
  assert.deepEqual(
    planned.map(({ name, spec, saveFlag, exact, change }) => ({ name, spec, saveFlag, exact, change })),
    [
      { name: 'express', spec: '^5.1.0', saveFlag: '--save-prod', exact: false, change: 'major' },
      { name: 'jest', spec: '~30.0.0', saveFlag: '--save-dev', exact: false, change: 'major' },
      { name: 'lodash', spec: '4.17.21', saveFlag: '--save-prod', exact: true, change: 'patch' },
    ],
  );
  assert.deepEqual(skipped.map((s) => s.name), ['my-fork']);
});

test('minor target stays within the current major', () => {
  const { planned } = plan({ target: 'minor' });
  assert.deepEqual(planned.map((p) => `${p.name}@${p.to}`), ['express@4.21.0', 'jest@29.7.0']);
});

test('patch target stays within the current minor', () => {
  const { planned } = plan({ target: 'patch', only: new Set(['jest']) });
  assert.deepEqual(planned.map((p) => `${p.name}@${p.to}`), ['jest@29.0.5']);
});

test('exclude skips packages with a reason', () => {
  const { planned, skipped } = plan({ exclude: new Set(['express']) });
  assert.equal(planned.some((p) => p.name === 'express'), false);
  assert.match(skipped.find((s) => s.name === 'express').reason, /excluded/);
});

test('nextRoundItems drops upgraded packages and keeps failed ones, marked and listed last', () => {
  const planned = ['axios', 'chalk', 'lodash', 'ms'].map((name) => ({ name, to: '2.0.0' }));
  const items = nextRoundItems(planned, {
    upgraded: new Set(['ms']),
    failures: new Map([['axios', { to: '2.0.0', reason: 'tests fail with 2.0.0 in `a.test.js`' }]]),
  });
  assert.deepEqual(items.map((i) => i.name), ['chalk', 'lodash', 'axios']);
  assert.deepEqual(items[2].previousAttempt, { to: '2.0.0', reason: 'tests fail with 2.0.0 in `a.test.js`' });
  assert.equal('previousAttempt' in items[0], false);
});

const tsEslint = [
  { name: 'eslint', from: '8.57.1', to: '10.14.0' },
  { name: '@typescript-eslint/eslint-plugin', from: '7.18.0', to: '8.20.0' },
  { name: '@typescript-eslint/parser', from: '7.18.0', to: '8.20.0' },
  { name: 'ms', from: '2.0.0', to: '2.1.3' },
];
const peers = {
  '@typescript-eslint/eslint-plugin@8.20.0': {
    '@typescript-eslint/parser': '^8.0.0 || ^8.0.0-alpha.0',
    eslint: '^8.57.0 || ^9.0.0 || ^10.0.0',
  },
  '@typescript-eslint/eslint-plugin@7.18.0': { '@typescript-eslint/parser': '^7.0.0', eslint: '^8.56.0' },
  '@typescript-eslint/parser@7.18.0': { eslint: '^8.56.0' },
};
const peersOf = (name, version) => peers[`${name}@${version}`] ?? {};
const PAIR = '@typescript-eslint/eslint-plugin + @typescript-eslint/parser';

test('findPeerLinks finds which upgrade needs which, from both old and new peerDependencies', () => {
  const links = findPeerLinks(tsEslint, peersOf).map((l) => `${l.from} -> ${l.requires}`);
  assert.deepEqual(links, [
    '@typescript-eslint/eslint-plugin -> @typescript-eslint/parser', // the new plugin needs the new parser
    '@typescript-eslint/parser -> @typescript-eslint/eslint-plugin', // the old plugin rejects the new parser
    'eslint -> @typescript-eslint/eslint-plugin', // the old plugin rejects eslint 10
    'eslint -> @typescript-eslint/parser',
  ]);
  assert.deepEqual(findPeerLinks([tsEslint[3]], peersOf), [], 'packages not being upgraded are ignored');
});

test('groupUpgrades groups mutual requirements and keeps one-way ones between units', () => {
  const items = [...tsEslint];
  items[2] = { ...items[2], previousAttempt: { to: '8.20.0', reason: 'x' } };
  const units = groupUpgrades(items, findPeerLinks(tsEslint, peersOf));
  assert.deepEqual(units.map((u) => u.name), [PAIR, 'eslint', 'ms'], 'required units are listed first');
  const [pair, eslint, ms] = units;
  assert.equal(pair.links.length, 2);
  assert.deepEqual(pair.requires, []);
  assert.deepEqual(pair.previousAttempt, { to: '8.20.0', reason: 'x' });
  assert.equal('previousAttempt' in pair.members[1], false, 'members are plain upgrades');
  assert.deepEqual([...new Set(eslint.requires.map((r) => r.unit))], [PAIR]);
  assert.deepEqual([ms.links, ms.requires], [[], []]);
});

test('planSteps pulls in requirements that are not done earlier in the same selection', () => {
  const units = groupUpgrades(tsEslint, findPeerLinks(tsEslint, peersOf));
  const byName = Object.fromEntries(units.map((u) => [u.name, u]));

  const alone = planSteps([byName.eslint], units);
  assert.equal(alone.length, 1);
  assert.deepEqual(alone[0].members.map((m) => m.name), ['@typescript-eslint/eslint-plugin', '@typescript-eslint/parser', 'eslint']);
  assert.deepEqual(alone[0].pulledIn, [PAIR]);

  const inOrder = planSteps([byName[PAIR], byName.eslint, byName.ms], units);
  assert.deepEqual(inOrder.map((s) => [s.name, s.pulledIn.length]), [[PAIR, 0], ['eslint', 0], ['ms', 0]]);

  assert.deepEqual(planSteps([byName[PAIR]], units).map((s) => s.name), [PAIR], 'the pair can go without eslint');
});
