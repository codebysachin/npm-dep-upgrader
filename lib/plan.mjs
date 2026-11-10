/**
 * Turns `npm outdated` output into an ordered list of upgrades.
 * Pure logic (I/O is injected) so it can be unit-tested.
 */
import { DEPENDENCY_SECTIONS, findDependency } from './manifest.mjs';
import {
  changeType,
  compareVersions,
  highestVersion,
  isPrerelease,
  parseSimpleRange,
  parseVersion,
  satisfies,
} from './semver.mjs';

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
 * after the packages not tried yet, so the user can retry them (e.g. after upgrading a peer, or
 * after fixing the code). The failure itself stays in `failures`; the items are plain upgrades.
 *
 * @param {PlannedUpgrade[]} planned
 * @param {object} params
 * @param {Set<string>} params.upgraded                                  names upgraded in this run
 * @param {Map<string, {to: string, reason: string}>} params.failures    last failed attempt per name
 * @returns {PlannedUpgrade[]}
 */
export function nextRoundItems(planned, { upgraded, failures }) {
  const remaining = planned.filter((p) => !upgraded.has(p.name));
  const fresh = remaining.filter((p) => !failures.has(p.name));
  const tried = remaining.filter((p) => failures.has(p.name));
  return [...fresh, ...tried];
}

/**
 * @typedef {object} UpgradeUnit   one entry in the list: a package, or packages that must move together
 * @property {string} name          the package name, or "a + b" for a group
 * @property {PlannedUpgrade[]} members
 * @property {string[]} links       why the members are grouped (empty for a single package)
 * @property {Array<{unit: string, reason: string}>} requires  other units that must be upgraded with this one
 */

/**
 * @typedef {UpgradeUnit & { pulledIn: string[] }} UpgradeStep   what one install-and-test does;
 *   `pulledIn` names the units merged in because the picked one needs them
 */

/**
 * @typedef {object} PeerLink   upgrading `from` alone breaks a peerDependency; `requires` must move too
 * @property {string} from
 * @property {string} requires
 * @property {string} reason
 */

/**
 * Finds upgrades that can't be done on their own because of peerDependencies:
 *   - the new version of A needs a newer B than the current one        → A requires B
 *   - the current version of A doesn't accept the new version of B     → B requires A
 * A range that can't be understood counts as a requirement too, to be safe.
 *
 * @param {PlannedUpgrade[]} items
 * @param {(name: string, version: string) => Record<string, string>} peersOf
 * @returns {PeerLink[]}
 */
export function findPeerLinks(items, peersOf) {
  const byName = new Map(items.map((item) => [item.name, item]));
  const links = [];
  for (const a of items) {
    for (const [peer, range] of Object.entries(peersOf(a.name, a.to) ?? {})) {
      const b = byName.get(peer);
      if (b && b !== a && satisfies(b.from, range) !== true) {
        links.push({ from: a.name, requires: b.name, reason: `${a.name}@${a.to} needs ${b.name} ${range}` });
      }
    }
    for (const [peer, range] of Object.entries(peersOf(a.name, a.from) ?? {})) {
      const b = byName.get(peer);
      if (b && b !== a && satisfies(b.to, range) !== true) {
        links.push({ from: b.name, requires: a.name, reason: `${a.name}@${a.from} only accepts ${b.name} ${range}` });
      }
    }
  }
  return links;
}

/**
 * Turns the list of upgrades into units. Packages that require each other (directly or in a
 * cycle) become one unit, installed and tested together. A one-way requirement stays between
 * units (`requires`), so the required unit can still be upgraded on its own.
 * Units keep the order of their first member, except that required units come first.
 *
 * @param {PlannedUpgrade[]} items
 * @param {PeerLink[]} links
 * @returns {UpgradeUnit[]}
 */
export function groupUpgrades(items, links) {
  const names = items.map((item) => item.name);
  const known = new Set(names);
  const edges = links.filter((l) => known.has(l.from) && known.has(l.requires));
  const reach = new Map(names.map((name) => [name, reachable(name, edges)]));
  const unitOf = new Map();
  for (const name of names) {
    // Members of a unit are the packages that require each other, directly or through others.
    unitOf.set(name, names.find((other) => other === name || (reach.get(name).has(other) && reach.get(other).has(name))));
  }

  const units = new Map();
  for (const item of items) {
    const key = unitOf.get(item.name);
    if (!units.has(key)) units.set(key, []);
    units.get(key).push(item);
  }

  const nameOf = (key) => units.get(key).map((m) => m.name).join(' + ');
  const result = [...units.entries()].map(([key, members]) => {
    const inside = (l) => unitOf.get(l.from) === key && unitOf.get(l.requires) === key;
    const outgoing = edges.filter((l) => unitOf.get(l.from) === key && unitOf.get(l.requires) !== key);
    return {
      name: nameOf(key),
      members,
      links: [...new Set(edges.filter(inside).map((l) => l.reason))],
      requires: outgoing.map((l) => ({ unit: nameOf(unitOf.get(l.requires)), reason: l.reason })),
    };
  });
  return requirementsFirst(result);
}

/** Stable order in which every unit comes after the units it requires. */
function requirementsFirst(units) {
  const byName = new Map(units.map((unit) => [unit.name, unit]));
  const ordered = [];
  const placed = new Set();
  const place = (unit) => {
    if (placed.has(unit.name)) return;
    placed.add(unit.name);
    for (const { unit: name } of unit.requires) place(byName.get(name));
    ordered.push(unit);
  };
  units.forEach(place);
  return ordered;
}

function reachable(start, edges) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const name = stack.pop();
    for (const edge of edges) {
      if (edge.from === name && !seen.has(edge.requires)) {
        seen.add(edge.requires);
        stack.push(edge.requires);
      }
    }
  }
  return seen;
}

/**
 * Turns what the user picked into the steps to run. A unit whose requirements are neither
 * already done nor picked earlier is merged with them into one step, since upgrading it
 * alone is bound to fail.
 *
 * @param {UpgradeUnit[]} selected   in the order the user typed
 * @param {UpgradeUnit[]} units      every unit in the list (to look requirements up)
 * @returns {UpgradeStep[]}
 */
export function planSteps(selected, units) {
  const byName = new Map(units.map((unit) => [unit.name, unit]));
  const scheduled = new Set();
  const steps = [];
  for (const unit of selected) {
    if (scheduled.has(unit.name)) continue;
    const needed = [];
    const visit = (u) => {
      for (const { unit: name } of u.requires) {
        const required = byName.get(name);
        if (!required || scheduled.has(name) || needed.includes(required)) continue;
        needed.push(required);
        visit(required);
      }
    };
    visit(unit);
    const parts = [...needed.filter((u) => u !== unit), unit];
    for (const part of parts) scheduled.add(part.name);
    steps.push(
      parts.length === 1
        ? { ...unit, pulledIn: /** @type {string[]} */ ([]) }
        : {
            name: parts.map((u) => u.name).join(' + '),
            members: parts.flatMap((u) => u.members),
            links: [...new Set(parts.flatMap((u) => [...u.links, ...u.requires.map((r) => r.reason)]))],
            requires: [],
            pulledIn: parts.filter((u) => u !== unit).map((u) => u.name),
          },
    );
  }
  return steps;
}
