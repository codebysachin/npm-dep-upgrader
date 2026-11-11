import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectOverrideLeaves, packageNameFromSelector, removeOverride } from '../lib/overrides.ts';

const manifest = {
  name: 'app',
  overrides: {
    semver: '^7.5.4',
    'lodash@<4.17.21': '4.17.21',
    webpack: { terser: '5.31.0' },
    foo: { '.': '1.0.0', bar: '2.0.0' },
    react: '$react',
  },
};

test('collectOverrideLeaves flattens every supported shape', () => {
  assert.deepEqual(collectOverrideLeaves(manifest.overrides), [
    { keyPath: ['semver'], name: 'semver', spec: '^7.5.4' },
    { keyPath: ['lodash@<4.17.21'], name: 'lodash', spec: '4.17.21' },
    { keyPath: ['webpack', 'terser'], name: 'terser', spec: '5.31.0' },
    { keyPath: ['foo', '.'], name: 'foo', spec: '1.0.0' },
    { keyPath: ['foo', 'bar'], name: 'bar', spec: '2.0.0' },
    { keyPath: ['react'], name: 'react', spec: '$react' },
  ]);
  assert.deepEqual(collectOverrideLeaves(undefined), []);
});

test('packageNameFromSelector handles scopes and selectors', () => {
  assert.equal(packageNameFromSelector('lodash'), 'lodash');
  assert.equal(packageNameFromSelector('lodash@<4'), 'lodash');
  assert.equal(packageNameFromSelector('@babel/core'), '@babel/core');
  assert.equal(packageNameFromSelector('@babel/core@^7'), '@babel/core');
});

test('removeOverride deletes a leaf and prunes empty parents', () => {
  const result = removeOverride(manifest, ['webpack', 'terser']);
  assert.equal('webpack' in result.overrides, false);
  assert.equal(manifest.overrides.webpack.terser, '5.31.0', 'original is not mutated');

  const partial = removeOverride(manifest, ['foo', '.']);
  assert.deepEqual(partial.overrides.foo, { bar: '2.0.0' });
});

test('removeOverride drops the overrides key when it becomes empty', () => {
  const result = removeOverride({ name: 'x', overrides: { a: { b: '1.0.0' } } }, ['a', 'b']);
  assert.equal('overrides' in result, false);
});
