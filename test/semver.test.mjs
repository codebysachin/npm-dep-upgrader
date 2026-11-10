import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  changeType,
  compareVersions,
  highestVersion,
  minVersionFromSpec,
  parseSimpleRange,
  satisfies,
} from '../lib/semver.mjs';

test('compareVersions orders releases and prereleases', () => {
  assert.equal(compareVersions('1.2.3', '1.2.3'), 0);
  assert.equal(compareVersions('2.0.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.0.0-beta.2', '1.0.0'), -1);
  assert.equal(compareVersions('1.0.0-beta.10', '1.0.0-beta.2'), 1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1);
});

test('changeType classifies the bump', () => {
  assert.equal(changeType('1.2.3', '2.0.0'), 'major');
  assert.equal(changeType('1.2.3', '1.3.0'), 'minor');
  assert.equal(changeType('1.2.3', '1.2.4'), 'patch');
  assert.equal(changeType('1.2.3-rc.1', '1.2.3'), 'prerelease');
});

test('parseSimpleRange keeps the prefix and rejects complex specs', () => {
  assert.deepEqual(parseSimpleRange('^1.2.3'), { prefix: '^', version: '1.2.3' });
  assert.deepEqual(parseSimpleRange('~0.4.0'), { prefix: '~', version: '0.4.0' });
  assert.deepEqual(parseSimpleRange('2.0.0'), { prefix: '', version: '2.0.0' });
  assert.deepEqual(parseSimpleRange('>=3.1.0'), { prefix: '>=', version: '3.1.0' });
  for (const spec of ['latest', '*', '1.x', '^1 || ^2', 'github:user/repo', 'workspace:*', 'npm:foo@1.0.0']) {
    assert.equal(parseSimpleRange(spec), null, spec);
  }
});

test('minVersionFromSpec derives a lower bound', () => {
  assert.equal(minVersionFromSpec('^4.17.21'), '4.17.21');
  assert.equal(minVersionFromSpec('>=2.1'), '2.1.0');
  assert.equal(minVersionFromSpec('3.x'), '3.0.0');
  assert.equal(minVersionFromSpec('7.5.10'), '7.5.10');
  assert.equal(minVersionFromSpec('<2.0.0'), null);
  assert.equal(minVersionFromSpec('1 || 2'), null);
  assert.equal(minVersionFromSpec('$react'), null);
});

test('highestVersion honours the predicate', () => {
  const versions = ['1.0.0', '1.4.2', '2.0.0-beta.1', '1.10.0', 'garbage'];
  assert.equal(highestVersion(versions), '2.0.0-beta.1');
  assert.equal(highestVersion(versions, (v) => !v.includes('-')), '1.10.0');
  assert.equal(highestVersion([], () => true), null);
});

test('satisfies understands the ranges used in peerDependencies', () => {
  const cases = [
    ['7.18.0', '^8.0.0 || ^8.0.0-alpha.0', false],
    ['8.1.0', '^8.0.0 || ^8.0.0-alpha.0', true],
    ['5.9.2', '>=4.8.4 <5.9.0', false],
    ['5.8.3', '>=4.8.4 <5.9.0', true],
    ['1.5.0', '1.x', true],
    ['2.0.0', '1.x', false],
    ['3.0.0', '*', true],
    ['2.3.9', '1.2.3 - 2.3', true],
    ['2.4.0', '1.2.3 - 2.3', false],
    ['0.2.5', '^0.2.3', true],
    ['0.3.0', '^0.2.3', false],
    ['1.2.0', '>= 1.0', true],
    ['2.0.0-beta.1', '^1.0.0', false],
  ];
  for (const [version, range, expected] of cases) assert.equal(satisfies(version, range), expected, `${version} ${range}`);
  assert.equal(satisfies('1.0.0', 'latest'), null, 'tags are not understood');
});
