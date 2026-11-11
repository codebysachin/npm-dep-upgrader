/**
 * --auto: upgrade every outdated package without asking which, and try harder before giving
 * up on one. For each package (or group that must move together):
 *
 *   1. upgrade it as planned;
 *   2. if that fails, try again together with related packages: the ones npm names in a
 *      peer-dependency conflict (ERESOLVE), and the ones released from the same repository
 *      or under the same npm scope;
 *   3. if a single package still fails, try smaller upgrades: the newest release in its
 *      current major, then in its current minor.
 *
 * After each pass over the list, packages that failed are tried again, but only if something
 * else was upgraded since they last failed (otherwise the result would be the same). The run
 * stops when a pass upgrades nothing new.
 *
 * Every attempt is installed and tested, and rolled back if it fails, so only combinations
 * that pass the tests are kept. I/O is passed in, so this module can be unit-tested.
 */
import { planSteps } from './plan.ts';
import type { PlannedUpgrade, UpgradeStep, UpgradeUnit } from './plan.ts';
import type { Results } from './session.ts';
import type { UpgradeItem, UpgradeOutcome } from './workflow.ts';

/** Attempts per package or group in one pass (the plain upgrade counts as the first). */
export const MAX_ATTEMPTS = 4;
/** A safety stop; every pass but the last upgrades at least one package, so it is rarely reached. */
export const MAX_PASSES = 10;

/** One failed try. */
export interface Attempt {
  /** what was tried, e.g. "express 5.1.0" or "a 2.0.0 + b 3.0.0" */
  what: string;
  reason: string;
}

/** Passed to `upgrade`, for the progress line. */
export interface AttemptPosition {
  pass: number;
  index: number;
  total: number;
  /** a member failed in an earlier pass */
  retry: boolean;
  /** 1 for the planned upgrade, then 2, 3, ... */
  attempt: number;
  /** what this attempt changes, e.g. "together with b" */
  note?: string;
}

type Upgrade = (step: UpgradeStep, position: AttemptPosition) => UpgradeOutcome;
type Related = (
  step: UpgradeStep,
  failure: UpgradeOutcome['failure'] | undefined,
  candidates: UpgradeUnit[],
) => { units: UpgradeUnit[]; blockers: string[] };
type Fallbacks = (item: PlannedUpgrade) => PlannedUpgrade[];

interface AutoParams {
  /** everything outdated, in plan order */
  units: UpgradeUnit[];
  upgrade: Upgrade;
  /** what is outdated now, minus what was upgraded in this run */
  replan: (state: { upgraded: Set<string>; failures: Map<string, UpgradeItem> }) => UpgradeUnit[];
  /** units worth trying together with a failed step (see findRelated) */
  related: Related;
  /** smaller upgrades to try for a single package (see fallbackTargets) */
  fallbacks: Fallbacks;
  results: Results;
  onPass?: (pass: number, steps: UpgradeStep[]) => void;
  maxAttempts?: number;
}

export async function runAuto({ units, upgrade, replan, related, fallbacks, results, onPass, maxAttempts = MAX_ATTEMPTS }: AutoParams): Promise<void> {
  const upgraded = new Set<string>();
  const failures = new Map<string, UpgradeItem>(); // name → failed item, with its attempts
  const failedAt = new Map<string, number>(); // name → how many packages were upgraded when it last failed
  let offered = units;
  let steps = planSteps(units, units);

  for (let pass = 1; steps.length && pass <= MAX_PASSES; pass += 1) {
    onPass?.(pass, steps);
    for (const [index, planned] of steps.entries()) {
      // An earlier step may already have upgraded some members (e.g. as a related package).
      const step: UpgradeStep = { ...planned, members: planned.members.filter((m) => !upgraded.has(m.name)) };
      if (!step.members.length) continue;

      const inStep = new Set(step.members.map((m) => m.name));
      const candidates = offered.filter((u) => u.members.every((m) => !upgraded.has(m.name) && !inStep.has(m.name)));
      const retry = step.members.some((m) => failures.has(m.name));
      const outcome = tryStep(step, { pass, index, total: steps.length, retry }, { upgrade, related, fallbacks, candidates, maxAttempts });

      for (const item of outcome.items) {
        if (outcome.ok) {
          upgraded.add(item.name);
          failures.delete(item.name);
          results.upgraded.push(item);
        } else {
          failures.set(item.name, item);
          failedAt.set(item.name, upgraded.size);
        }
      }
      results.failed = [...failures.values()];
    }

    // An upgrade can change what is outdated (and what a failed package needs), so each pass
    // starts from a fresh plan. A failure is only worth retrying if something changed since.
    offered = replan({ upgraded, failures });
    const unchanged = (m: PlannedUpgrade) => failures.has(m.name) && failedAt.get(m.name) === upgraded.size;
    steps = planSteps(offered.filter((u) => !u.members.some(unchanged)), offered);
  }

  for (const unit of offered) {
    for (const m of unit.members) {
      if (upgraded.has(m.name) || failures.has(m.name)) continue;
      const failed = unit.members.find((other) => failures.has(other.name));
      results.skipped.push({
        name: m.name,
        reason: failed ? `not tried: it moves together with ${failed.name}, which failed` : `not tried (stays at ${m.from}; ${m.to} available)`,
      });
    }
  }
}

/** The planned upgrade, then related packages, then smaller upgrades, until one passes. */
function tryStep(
  step: UpgradeStep,
  position: Omit<AttemptPosition, 'attempt' | 'note'>,
  {
    upgrade,
    related,
    fallbacks,
    candidates,
    maxAttempts,
  }: { upgrade: Upgrade; related: Related; fallbacks: Fallbacks; candidates: UpgradeUnit[]; maxAttempts: number },
): UpgradeOutcome {
  const attempts: Attempt[] = [];
  const attempt = (s: UpgradeStep, note?: string) => {
    const outcome = upgrade(s, { ...position, attempt: attempts.length + 1, note });
    if (!outcome.ok) attempts.push({ what: describeAttempt(s), reason: outcome.items[0]?.reason ?? 'failed' });
    return outcome;
  };
  const succeeded = (outcome: UpgradeOutcome, extra: { instead?: string } = {}): UpgradeOutcome => ({
    ...outcome,
    items: outcome.items.map((item) => ({ ...item, ...extra, tried: attempts })),
  });

  const first = attempt(step);
  if (first.ok) return first;

  const { units: extra, blockers } = related(step, first.failure, candidates);
  if (extra.length && attempts.length < maxAttempts) {
    const together = mergeSteps(step, extra);
    const outcome = attempt(together, `together with ${extra.map((u) => u.name).join(', ')}`);
    if (outcome.ok) return succeeded(outcome);
  }

  if (step.members.length === 1) {
    const [item] = step.members;
    for (const smaller of fallbacks(item)) {
      if (attempts.length >= maxAttempts) break;
      const outcome = attempt(
        { ...step, name: item.name, members: [smaller], links: [], requires: [], pulledIn: [] },
        `smaller upgrade: ${smaller.to} instead of ${item.to}`,
      );
      if (outcome.ok) return succeeded(outcome, { instead: item.to });
    }
  }

  const blocked = blockers.length ? `; npm also names ${blockers.join(', ')}, which has no upgrade in this run` : '';
  return {
    ok: false,
    items: step.members.map((m) => ({ ...m, reason: `${attempts[0].reason}${blocked}`, attempts })),
  };
}

/** One step for a failed step plus the units to try with it. */
export function mergeSteps(step: UpgradeStep, extra: UpgradeUnit[]): UpgradeStep {
  return {
    name: [step.name, ...extra.map((u) => u.name)].join(' + '),
    members: [...step.members, ...extra.flatMap((u) => u.members)],
    links: step.links,
    requires: [],
    pulledIn: [...step.pulledIn, ...extra.map((u) => u.name)],
  };
}

const describeAttempt = (step: UpgradeStep) => step.members.map((m) => `${m.name} ${m.to}`).join(' + ');

/** Scope that suggests packages are released together. "@types" holds unrelated packages. */
const scopeOf = (name: string) => (name.startsWith('@') && !name.startsWith('@types/') ? name.split('/')[0] : null);

/**
 * Which other upgrades are worth trying together with a step that failed:
 *   - packages npm named in a peer-dependency conflict (`conflicts`), and
 *   - packages from the same source repository, or under the same npm scope (not @types).
 * Names npm mentions that aren't in `candidates` are returned as `blockers`, except the
 * project itself and the step's own members.
 *
 * @param candidates   upgrades not done yet, outside the step
 */
export function findRelated(
  step: UpgradeStep,
  candidates: UpgradeUnit[],
  {
    conflicts = [],
    repositoryOf = () => null,
    projectName,
  }: { conflicts?: string[]; repositoryOf?: (item: PlannedUpgrade) => string | null; projectName?: string } = {},
): { units: UpgradeUnit[]; blockers: string[] } {
  const inStep = new Set(step.members.map((m) => m.name));
  const unitOf = new Map(candidates.flatMap((u) => u.members.map((m): [string, UpgradeUnit] => [m.name, u])));
  const picked = new Set<UpgradeUnit>();
  const blockers: string[] = [];

  for (const name of conflicts) {
    if (inStep.has(name) || name === projectName) continue;
    if (unitOf.has(name)) picked.add(unitOf.get(name));
    else if (!blockers.includes(name)) blockers.push(name);
  }

  const scopes = new Set(step.members.map((m) => scopeOf(m.name)).filter(Boolean));
  const repositories = new Set(step.members.map(repositoryOf).filter(Boolean));
  for (const unit of candidates) {
    if (unit.members.some((m) => scopes.has(scopeOf(m.name)) || repositories.has(repositoryOf(m)))) picked.add(unit);
  }

  return { units: candidates.filter((u) => picked.has(u)), blockers };
}
