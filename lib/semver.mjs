/**
 * Tiny subset of semantic-versioning helpers — just what this tool needs.
 * Implemented locally on purpose so the script has zero third-party dependencies.
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Range specs we know how to rewrite while keeping the author's prefix. */
const SIMPLE_RANGE_RE = /^(\^|~|>=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** Specs whose lower bound we can derive (used for overrides). */
const LOWER_BOUND_RE = /^(?:\^|~|>=|>|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-[0-9A-Za-z.-]+)?$/;

/**
 * @param {string} version
 * @returns {{major:number, minor:number, patch:number, prerelease:string[]}|null}
 */
export function parseVersion(version) {
  const match = VERSION_RE.exec(String(version).trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

/** @returns {-1|0|1} */
export function compareVersions(a, b) {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) throw new Error(`Cannot compare invalid versions "${a}" and "${b}"`);

  for (const key of ['major', 'minor', 'patch']) {
    if (va[key] !== vb[key]) return va[key] > vb[key] ? 1 : -1;
  }
  return comparePrerelease(va.prerelease, vb.prerelease);
}

function comparePrerelease(a, b) {
  // A release (no prerelease tag) ranks higher than any prerelease of the same version.
  if (!a.length && !b.length) return 0;
  if (!a.length) return 1;
  if (!b.length) return -1;

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === undefined) return -1;
    if (b[i] === undefined) return 1;
    if (a[i] === b[i]) continue;
    const na = /^\d+$/.test(a[i]);
    const nb = /^\d+$/.test(b[i]);
    if (na && nb) return Number(a[i]) > Number(b[i]) ? 1 : -1;
    if (na) return -1;
    if (nb) return 1;
    return a[i] > b[i] ? 1 : -1;
  }
  return 0;
}

export const isPrerelease = (version) => (parseVersion(version)?.prerelease.length ?? 0) > 0;

/** @returns {'major'|'minor'|'patch'|'prerelease'|'none'} */
export function changeType(from, to) {
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) return 'none';
  if (a.major !== b.major) return 'major';
  if (a.minor !== b.minor) return 'minor';
  if (a.patch !== b.patch) return 'patch';
  return compareVersions(from, to) === 0 ? 'none' : 'prerelease';
}

/**
 * Splits a simple range such as "^1.2.3", "~1.2.3", ">=1.2.3" or "1.2.3"
 * into prefix and version. Returns null for anything more complex
 * (git URLs, tags, unions, `workspace:`, `npm:` aliases, ...).
 * @returns {{prefix: string, version: string}|null}
 */
export function parseSimpleRange(spec) {
  const match = SIMPLE_RANGE_RE.exec(String(spec).trim());
  return match ? { prefix: match[1] ?? '', version: match[2] } : null;
}

/**
 * Lowest version allowed by a simple spec, e.g. "^4.17.21" → "4.17.21", "2.x" → "2.0.0".
 * Returns null when the lower bound can't be derived safely (e.g. "<2", "1 || 2").
 */
export function minVersionFromSpec(spec) {
  const match = LOWER_BOUND_RE.exec(String(spec).trim());
  if (!match) return null;
  const part = (value) => (value === undefined || value === 'x' || value === '*' ? '0' : value);
  return `${match[1]}.${part(match[2])}.${part(match[3])}`;
}

/** Highest version from `versions` that satisfies `predicate`, or null. */
export function highestVersion(versions, predicate = () => true) {
  return versions
    .filter((v) => parseVersion(v) && predicate(v))
    .reduce((best, v) => (best === null || compareVersions(v, best) > 0 ? v : best), null);
}
