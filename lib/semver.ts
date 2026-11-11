/**
 * Tiny subset of semantic-versioning helpers — just what this tool needs.
 * Implemented locally on purpose so the script has zero third-party dependencies.
 */

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** Range specs we know how to rewrite while keeping the author's prefix. */
const SIMPLE_RANGE_RE = /^(\^|~|>=)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

/** Specs whose lower bound we can derive (used for overrides). */
const LOWER_BOUND_RE = /^(?:\^|~|>=|>|=)?\s*v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-[0-9A-Za-z.-]+)?$/;

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

type Comparator = [op: string, bound: string];

export function parseVersion(version: string): ParsedVersion | null {
  const match = VERSION_RE.exec(String(version).trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const va = parseVersion(a);
  const vb = parseVersion(b);
  if (!va || !vb) throw new Error(`Cannot compare invalid versions "${a}" and "${b}"`);

  for (const key of ['major', 'minor', 'patch'] as const) {
    if (va[key] !== vb[key]) return va[key] > vb[key] ? 1 : -1;
  }
  return comparePrerelease(va.prerelease, vb.prerelease);
}

function comparePrerelease(a: string[], b: string[]): -1 | 0 | 1 {
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

export const isPrerelease = (version: string): boolean => (parseVersion(version)?.prerelease.length ?? 0) > 0;

export function changeType(from: string, to: string): 'major' | 'minor' | 'patch' | 'prerelease' | 'none' {
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
 */
export function parseSimpleRange(spec: string): { prefix: string; version: string } | null {
  const match = SIMPLE_RANGE_RE.exec(String(spec).trim());
  return match ? { prefix: match[1] ?? '', version: match[2] } : null;
}

/**
 * Lowest version allowed by a simple spec, e.g. "^4.17.21" → "4.17.21", "2.x" → "2.0.0".
 * Returns null when the lower bound can't be derived safely (e.g. "<2", "1 || 2").
 */
export function minVersionFromSpec(spec: string): string | null {
  const match = LOWER_BOUND_RE.exec(String(spec).trim());
  if (!match) return null;
  const part = (value: string | undefined): string => (value === undefined || value === 'x' || value === '*' ? '0' : value);
  return `${match[1]}.${part(match[2])}.${part(match[3])}`;
}

/**
 * Highest version from `versions` that satisfies `predicate`, or null.
 */
export function highestVersion(versions: string[], predicate: (version: string) => boolean = () => true): string | null {
  return versions
    .filter((v) => parseVersion(v) && predicate(v))
    .reduce<string | null>((best, v) => (best === null || compareVersions(v, best) > 0 ? v : best), null);
}

const COMPARATOR_RE =
  /^(<=|>=|<|>|=|\^|~>?)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Whether `version` is allowed by an npm range such as "^8.0.0 || ^8.0.0-alpha.0",
 * ">=4.8.4 <5.9.0", "1.x", "*" or "1.2.3 - 2.3". Used to read peerDependencies.
 * Simplification: prereleases are compared like any other version.
 * @returns null when the range can't be understood (tags, URLs, ...)
 */
export function satisfies(version: string, range: string): boolean | null {
  if (!parseVersion(version)) return null;
  let understood = false;
  for (const set of String(range).split('||')) {
    const comparators = expandComparatorSet(set.trim());
    if (!comparators) continue;
    understood = true;
    if (comparators.every(([op, bound]) => testComparator(version, op, bound))) return true;
  }
  return understood ? false : null;
}

/** "^1.2.3" → [[">=", "1.2.3"], ["<", "2.0.0-0"]]; null when not understood. */
function expandComparatorSet(set: string): Comparator[] | null {
  const hyphen = /^(\S+)\s+-\s+(\S+)$/.exec(set);
  if (hyphen) {
    const low = expandComparator(`>=${hyphen[1]}`);
    const high = expandComparator(`<=${hyphen[2]}`);
    return low && high ? [...low, ...high] : null;
  }
  const tokens = set.replace(/(<=|>=|<|>|=|\^|~>?)\s+/g, '$1').split(/\s+/).filter(Boolean);
  const result: Comparator[] = [];
  for (const token of tokens) {
    const expanded = expandComparator(token);
    if (!expanded) return null;
    result.push(...expanded);
  }
  return result; // empty (e.g. "" or "*") matches everything
}

function expandComparator(token: string): Comparator[] | null {
  const match = COMPARATOR_RE.exec(token);
  if (!match) return null;
  const [, op = '', ...rest] = match;
  const num = (v: string | undefined): number | null => (v === undefined || /^[xX*]$/.test(v) ? null : Number(v));
  const [M, m, p] = [num(rest[0]), num(rest[1]), num(rest[2])];
  const pre = rest[3] ? `-${rest[3]}` : '';
  const full = `${M}.${m ?? 0}.${p ?? 0}${pre}`;
  if (M === null) return op === '<' || op === '>' ? [['<', '0.0.0-0']] : [];

  switch (op) {
    case '':
    case '=':
      if (m === null) return [['>=', `${M}.0.0`], ['<', `${M + 1}.0.0-0`]];
      if (p === null) return [['>=', `${M}.${m}.0`], ['<', `${M}.${m + 1}.0-0`]];
      return [['=', full]];
    case '^': {
      const upper =
        M > 0 || m === null ? `${M + 1}.0.0-0` : m > 0 || p === null ? `0.${m + 1}.0-0` : `0.0.${p + 1}-0`;
      return [['>=', full], ['<', upper]];
    }
    case '~':
    case '~>':
      return [['>=', full], ['<', m === null ? `${M + 1}.0.0-0` : `${M}.${m + 1}.0-0`]];
    case '>':
      if (m === null) return [['>=', `${M + 1}.0.0`]];
      if (p === null) return [['>=', `${M}.${m + 1}.0`]];
      return [['>', full]];
    case '<=':
      if (m === null) return [['<', `${M + 1}.0.0-0`]];
      if (p === null) return [['<', `${M}.${m + 1}.0-0`]];
      return [['<=', full]];
    default: // '>=', '<'
      return [[op, full]];
  }
}

function testComparator(version: string, op: string, bound: string): boolean {
  const c = compareVersions(version, bound);
  return { '=': c === 0, '>': c > 0, '>=': c >= 0, '<': c < 0, '<=': c <= 0 }[op];
}
