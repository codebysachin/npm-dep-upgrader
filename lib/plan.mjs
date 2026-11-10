/**
 * Turns `npm outdated` output into an ordered list of upgrades.
 * Pure logic (I/O is injected) so it can be unit-tested.
 */
import { DEPENDENCY_SECTIONS, findDependency } from './manifest.mjs';
import { changeType, compareVersions, highestVersion, isPrerelease, parseSimpleRange, parseVersion } from './semver.mjs';

export const TARGETS = Object.freeze(['latest', 'minor', 'patch']);

/**
 * @typedef {object} PlannedUpgrade
 * @property {string} name
 * @property {string} section    dependencies | devDependencies | optionalDependencies
 * @property {string} from       currently installed (or declared) version
 * @property {string} to         target version
 * @property {string} spec       new spec written to package.json, keeping the original prefix
 * @property {string} saveFlag
 * @property {boolean} exact
 * @property {string} change     major | minor | patch | prerelease
 */

/**
 * @param {object} params
 * @param {Record<string, {current?: string, wanted: string, latest: string}>} params.outdated
 * @param {object} params.manifest           parsed package.json
 * @param {'latest'|'minor'|'patch'} params.target
 * @param {Set<string>} params.only          when non-empty, only these packages are considered
 * @param {Set<string>} params.exclude
 * @param {(name: string) => string[]} params.getVersions  published versions (only used for minor/patch targets)
 * @returns {{ planned: PlannedUpgrade[], skipped: Array<{name: string, reason: string}> }}
 */
export function planUpgrades({ outdated, manifest, target, only, exclude, getVersions }) {
  const planned = [];
  const skipped = [];

  for (const name of Object.keys(outdated).sort()) {
    const info = outdated[name];
    if (only.size && !only.has(name)) continue;

    if (exclude.has(name)) {
      skipped.push({ name, reason: 'excluded via --exclude' });
      continue;
    }

    const dependency = findDependency(manifest, name);
    if (!dependency) {
      skipped.push({ name, reason: 'not declared in dependencies/devDependencies/optionalDependencies' });
      continue;
    }

    const range = parseSimpleRange(dependency.spec);
    if (!range) {
      skipped.push({ name, reason: `version spec "${dependency.spec}" is not a simple range; update it manually` });
      continue;
    }

    const from = parseVersion(info.current) ? info.current : range.version;
    const to = resolveTarget({ name, from, latest: info.latest, target, getVersions });

    if (!to) {
      const hint = target === 'latest' ? '' : ` (latest is ${info.latest}; use --target latest to allow it)`;
      skipped.push({ name, reason: `no ${target} update available${hint}` });
      continue;
    }

    planned.push({
      name,
      section: dependency.section,
      from,
      to,
      spec: `${range.prefix}${to}`,
      saveFlag: DEPENDENCY_SECTIONS[dependency.section],
      exact: range.prefix === '',
      change: changeType(from, to),
    });
  }

  return { planned, skipped };
}

function resolveTarget({ name, from, latest, target, getVersions }) {
  if (target === 'latest') {
    return parseVersion(latest) && compareVersions(latest, from) > 0 ? latest : null;
  }

  const current = parseVersion(from);
  const sameLine = (v) => {
    const parsed = parseVersion(v);
    return parsed.major === current.major && (target === 'minor' || parsed.minor === current.minor);
  };
  return highestVersion(getVersions(name), (v) => !isPrerelease(v) && sameLine(v) && compareVersions(v, from) > 0);
}

/**
 * The packages to offer in a later round of the same run.
 * Packages upgraded in this run are left out. Packages whose upgrade failed stay in the list,
 * carrying `previousAttempt`, so the user can retry them (e.g. after upgrading a peer, or after
 * fixing the code). They are listed after the packages not tried yet.
 *
 * @param {PlannedUpgrade[]} planned
 * @param {object} params
 * @param {Set<string>} params.upgraded                                  names upgraded in this run
 * @param {Map<string, {to: string, reason: string}>} params.failures    last failed attempt per name
 * @returns {Array<PlannedUpgrade & { previousAttempt?: {to: string, reason: string} }>}
 */
export function nextRoundItems(planned, { upgraded, failures }) {
  const remaining = planned.filter((p) => !upgraded.has(p.name));
  const fresh = remaining.filter((p) => !failures.has(p.name));
  const tried = remaining
    .filter((p) => failures.has(p.name))
    .map((p) => {
      const { to, reason } = failures.get(p.name);
      return { ...p, previousAttempt: { to, reason } };
    });
  return [...fresh, ...tried];
}
