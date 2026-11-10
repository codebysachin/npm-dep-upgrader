import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommitTitle } from '../lib/report.mjs';

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
