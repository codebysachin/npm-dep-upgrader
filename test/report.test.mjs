import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommitTitle, buildReport } from '../lib/report.mjs';

test('buildReport lists only the changes in the MR', () => {
  const report = buildReport({
    upgraded: [{ name: 'lodash', from: '4.17.20', to: '4.18.1', change: 'minor', section: 'dependencies' }],
    overridesRemoved: [{ keyPath: ['minimist'], spec: '^1.2.6', resolved: 'minimist@1.2.8' }],
    failed: [{ name: 'chalk', from: '4.1.2', to: '6.0.1', reason: 'tests fail' }],
    skipped: [{ name: 'ms', reason: 'not selected' }],
    overridesKept: [{ keyPath: ['semver'], spec: '7.5.4', reason: 'still needed' }],
    testCommand: 'npm test',
  });
  assert.match(report, /\| `lodash` \| 4\.17\.20 \| 4\.18\.1 \|/);
  assert.match(report, /\| `minimist` \| \^1\.2\.6 \| minimist@1\.2\.8 \|/);
  for (const leftOut of ['chalk', 'ms', 'semver', 'Not upgraded', 'Skipped', 'still required']) {
    assert.equal(report.includes(leftOut), false, `"${leftOut}" should not be in the MR summary`);
  }
});

test('buildCommitTitle summarises upgrades and override removals', () => {
  const item = {};
  assert.equal(
    buildCommitTitle({ upgraded: [item, item], overridesRemoved: [item] }),
    'chore(deps): upgrade 2 packages and remove 1 obsolete override',
  );
  assert.equal(buildCommitTitle({ upgraded: [item], overridesRemoved: [] }), 'chore(deps): upgrade 1 package');
  assert.equal(
    buildCommitTitle({ upgraded: [], overridesRemoved: [item, item] }),
    'chore(deps): remove 2 obsolete overrides',
  );
});
