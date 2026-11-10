/**
 * Pure helpers for npm "overrides" in package.json.
 * See https://docs.npmjs.com/cli/configuring-npm/package-json#overrides
 *
 * Supported shapes:
 *   { "lodash": "^4.17.21" }                         → top-level override
 *   { "lodash@<4.17.21": "4.17.21" }                 → override with a version selector
 *   { "webpack": { "terser": "5.31.0" } }            → nested override (only under webpack)
 *   { "foo": { ".": "1.0.0", "bar": "2.0.0" } }      → "." overrides the parent itself
 *   { "react": "$react" }                            → reference to a direct dependency
 */

/**
 * @typedef {object} OverrideLeaf
 * @property {string[]} keyPath  path of keys inside `overrides`, e.g. ["webpack", "terser"]
 * @property {string} name       package the override targets
 * @property {string} spec       version spec forced by the override
 */

/** Flattens the overrides object into its string-valued leaves. */
export function collectOverrideLeaves(overrides, parentPath = []) {
  if (!overrides || typeof overrides !== 'object') return [];

  return Object.entries(overrides).flatMap(([key, value]) => {
    const keyPath = [...parentPath, key];
    if (value && typeof value === 'object') return collectOverrideLeaves(value, keyPath);
    if (typeof value !== 'string') return [];

    const selector = key === '.' ? parentPath.at(-1) : key;
    return selector ? [{ keyPath, name: packageNameFromSelector(selector), spec: value }] : [];
  });
}

/** "lodash@<4.17.21" → "lodash", "@scope/pkg@^1" → "@scope/pkg". */
export function packageNameFromSelector(selector) {
  const at = selector.indexOf('@', 1);
  return at === -1 ? selector : selector.slice(0, at);
}

/**
 * Returns a copy of the manifest without the given override leaf.
 * Parent objects that become empty are removed, as is `overrides` itself.
 */
export function removeOverride(manifest, keyPath) {
  const copy = structuredClone(manifest);
  const parents = [copy.overrides];
  for (const key of keyPath.slice(0, -1)) parents.push(parents.at(-1)?.[key]);

  const container = parents.at(-1);
  if (!container || !(keyPath.at(-1) in container)) return copy;
  delete container[keyPath.at(-1)];

  for (let depth = keyPath.length - 1; depth > 0; depth--) {
    if (Object.keys(parents[depth]).length) break;
    delete parents[depth - 1][keyPath[depth - 1]];
  }
  if (Object.keys(copy.overrides).length === 0) delete copy.overrides;
  return copy;
}

export const describeOverride = (leaf) => `${leaf.keyPath.join(' › ')}: "${leaf.spec}"`;
