import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planUpgrades } from '../lib/plan.mjs';

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
