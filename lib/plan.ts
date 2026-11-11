/**
 * Turns `npm outdated` output into an ordered list of upgrades.
 * Pure logic (I/O is injected) so it can be unit-tested.
 */
import { DEPENDENCY_SECTIONS, findDependency } from './manifest.ts';
import {
  changeType,
  compareVersions,
  highestVersion,
  isPrerelease,
  parseSimpleRange,
  parseVersion,
  satisfies,
} from './semver.ts';
import type { Manifest } from './manifest.ts';

export type Target = 'latest' | 'minor' | 'patch';

export const TARGETS: readonly Target[] = Object.freeze(['latest', 'minor', 'patch']);

export interface PlannedUpgrade {
  name: string;
  /** dependencies | devDependencies | optionalDependencies */
  section: string;
  /** currently installed (or declared) version */
  from: string;
  /** target version */
  to: string;
  /** new spec written to package.json, keeping the original prefix */
  spec: string;
  saveFlag: string;
  exact: boolean;
  /** major | minor | patch | prerelease */
  change: string;
}

interface PlanParams {
  outdated: Record<string, { current?: string; wanted: string; latest: string }>;
  /** parsed package.json */
  manifest: Manifest;
  target: Target;
  /** when non-empty, only these packages are considered */
  only: Set<string>;
  exclude: Set<string>;
  /** published versions (only used for minor/patch targets) */
  getVersions: (name: string) => string[];
}

export function planUpgrades({ outdated, manifest, target, only, exclude, getVersions }: PlanParams): {
  planned: PlannedUpgrade[];
  skipped: Array<{ name: string; reason: string }>;
} {
  const planned: PlannedUpgrade[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

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
      saveFlag: DEPENDENCY_SECTIONS[dependency.section as keyof typeof DEPENDENCY_SECTIONS],
      exact: range.prefix === '',
      change: changeType(from, to),
    });
  }

  return { planned, skipped };
}

function resolveTarget({
  name,
  from,
  latest,
  target,
  getVersions,
}: {
  name: string;
  from: string;
  latest: string;
  target: Target;
  getVersions: (name: string) => string[];
}): string | null {
  if (target === 'latest') {
    return parseVersion(latest) && compareVersions(latest, from) > 0 ? latest : null;
  }

  const current = parseVersion(from);
  const sameLine = (v: string) => {
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
 * @param params.upgraded   names upgraded in this run
 * @param params.failures   last failed attempt per name
 */
export function nextRoundItems(
  planned: PlannedUpgrade[],
  { upgraded, failures }: { upgraded: Set<string>; failures: Map<string, { to: string; reason?: string }> },
): PlannedUpgrade[] {
  const remaining = planned.filter((p) => !upgraded.has(p.name));
  const fresh = remaining.filter((p) => !failures.has(p.name));
  const tried = remaining.filter((p) => failures.has(p.name));
  return [...fresh, ...tried];
}

/** One entry in the list: a package, or packages that must move together. */
export interface UpgradeUnit {
  /** the package name, or "a + b" for a group */
  name: string;
  members: PlannedUpgrade[];
  /** why the members are grouped (empty for a single package) */
  links: string[];
  /** other units that must be upgraded with this one */
  requires: Array<{ unit: string; reason: string }>;
}

/**
 * What one install-and-test does;
 *   `pulledIn` names the units merged in because the picked one needs them
 */
export interface UpgradeStep extends UpgradeUnit {
  pulledIn: string[];
}

/** Upgrading `from` alone breaks a peerDependency; `requires` must move too. */
export interface PeerLink {
  from: string;
  requires: string;
  reason: string;
}

/**
 * Finds upgrades that can't be done on their own because of peerDependencies:
 *   - the new version of A needs a newer B than the current one        → A requires B
 *   - the current version of A doesn't accept the new version of B     → B requires A
 * A range that can't be understood counts as a requirement too, to be safe.
 */
export function findPeerLinks(
  items: PlannedUpgrade[],
  peersOf: (name: string, version: string) => Record<string, string>,
): PeerLink[] {
  const byName = new Map(items.map((item) => [item.name, item]));
  const links: PeerLink[] = [];
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
 */
export function groupUpgrades(items: PlannedUpgrade[], links: PeerLink[]): UpgradeUnit[] {
  const names = items.map((item) => item.name);
  const known = new Set(names);
  const edges = links.filter((l) => known.has(l.from) && known.has(l.requires));
  const reach = new Map(names.map((name) => [name, reachable(name, edges)]));
  const unitOf = new Map<string, string>();
  for (const name of names) {
    // Members of a unit are the packages that require each other, directly or through others.
    unitOf.set(name, names.find((other) => other === name || (reach.get(name).has(other) && reach.get(other).has(name))));
  }

  const units = new Map<string, PlannedUpgrade[]>();
  for (const item of items) {
    const key = unitOf.get(item.name);
    if (!units.has(key)) units.set(key, []);
    units.get(key).push(item);
  }

  const nameOf = (key: string) => units.get(key).map((m) => m.name).join(' + ');
  const result = [...units.entries()].map(([key, members]): UpgradeUnit => {
    const inside = (l: PeerLink) => unitOf.get(l.from) === key && unitOf.get(l.requires) === key;
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
function requirementsFirst(units: UpgradeUnit[]): UpgradeUnit[] {
  const byName = new Map(units.map((unit) => [unit.name, unit]));
  const ordered: UpgradeUnit[] = [];
  const placed = new Set<string>();
  const place = (unit: UpgradeUnit) => {
    if (placed.has(unit.name)) return;
    placed.add(unit.name);
    for (const { unit: name } of unit.requires) place(byName.get(name));
    ordered.push(unit);
  };
  units.forEach(place);
  return ordered;
}

function reachable(start: string, edges: PeerLink[]): Set<string> {
  const seen = new Set<string>();
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
 * @param selected   in the order the user typed
 * @param units      every unit in the list (to look requirements up)
 */
export function planSteps(selected: UpgradeUnit[], units: UpgradeUnit[]): UpgradeStep[] {
  const byName = new Map(units.map((unit) => [unit.name, unit]));
  const scheduled = new Set<string>();
  const steps: UpgradeStep[] = [];
  for (const unit of selected) {
    if (scheduled.has(unit.name)) continue;
    const needed: UpgradeUnit[] = [];
    const visit = (u: UpgradeUnit) => {
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
        ? { ...unit, pulledIn: [] as string[] }
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

/**
 * Smaller upgrades to try when `item`'s target fails: the newest release in the current major,
 * then in the current minor. Each keeps the original range prefix. Prereleases are never picked.
 * @param published   every published version of the package
 * @returns in the order to try them; empty when there is nothing smaller
 */
export function fallbackTargets(item: PlannedUpgrade, published: string[]): PlannedUpgrade[] {
  const prefix = item.spec.slice(0, item.spec.length - item.to.length);
  const current = parseVersion(item.from);
  if (!current) return [];
  const newestWhere = (sameLine: (v: { major: number; minor: number }) => boolean) =>
    highestVersion(published, (v) => {
      const parsed = parseVersion(v);
      return Boolean(parsed) && !isPrerelease(v) && sameLine(parsed) && compareVersions(v, item.from) > 0 && compareVersions(v, item.to) < 0;
    });
  const targets = [
    newestWhere((v) => v.major === current.major),
    newestWhere((v) => v.major === current.major && v.minor === current.minor),
  ];
  return [...new Set(targets.filter(Boolean))].map((to) => ({ ...item, to, spec: `${prefix}${to}`, change: changeType(item.from, to) }));
}
