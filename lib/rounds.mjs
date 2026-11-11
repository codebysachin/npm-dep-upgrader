/**
 * The upgrade rounds: show what is outdated, let the user pick (or take everything), upgrade
 * the picks one step at a time, and offer what is still outdated until the user finishes.
 */
import { findRelated, runAuto } from './auto.mjs';
import { conflictingPackages } from './failure-report.mjs';
import { color, log } from './logger.mjs';
import { readManifest } from './manifest.mjs';
import { getOutdated, getPeerDependencies, getPublishedVersions, getRepository } from './npm.mjs';
import { collectOverrideLeaves, describeOverride } from './overrides.mjs';
import { fallbackTargets, findPeerLinks, groupUpgrades, nextRoundItems, planSteps, planUpgrades } from './plan.mjs';
import { selectItems } from './prompt.mjs';
import { pruneOverrides, upgradePackages } from './workflow.mjs';

/**
 * Upgrades the packages picked in the first round, then (when `repeat`) keeps offering what is
 * still outdated until nothing is left or the user picks nothing. Results are recorded as each
 * step finishes, so quitting part-way can still report what was kept.
 * I/O is passed in, so the loop itself can be unit-tested.
 *
 * @param {object} params
 * @param {import('./plan.mjs').UpgradeUnit[]} params.pending   what the first round offered
 * @param {object[]} params.selected   steps picked in the first round (planSteps output)
 * @param {(step: object, position: {index: number, total: number, retry: boolean}) => {ok: boolean, items: object[]}} params.upgrade
 * @param {(state: {upgraded: Set<string>, failures: Map<string, object>}) => import('./plan.mjs').UpgradeUnit[]} params.replan
 *        what is outdated now, minus what was upgraded in this run
 * @param {(units: object[], failures: Map<string, object>) => Promise<object[]>} params.choose
 *        picks from a later round; nothing picked finishes
 * @param {boolean} params.repeat   offer later rounds (only when the user is choosing)
 * @param {import('./session.mjs').Results} params.results
 */
export async function runRounds({ pending, selected, upgrade, replan, choose, repeat, results }) {
  const upgraded = new Set();
  const failures = new Map(); // name → last failed attempt; cleared if a retry succeeds
  let steps = selected;
  let offered = pending;

  while (steps.length) {
    for (const [index, step] of steps.entries()) {
      const retry = step.members.some((m) => failures.has(m.name));
      const outcome = upgrade(step, { index, total: steps.length, retry });
      for (const item of outcome.items) {
        if (outcome.ok) {
          upgraded.add(item.name);
          failures.delete(item.name);
          results.upgraded.push(item);
        } else {
          failures.set(item.name, item);
        }
      }
      results.failed = [...failures.values()];
    }
    if (!repeat) break;

    // An upgrade can change what is outdated, so each round starts from a fresh plan.
    offered = replan({ upgraded, failures });
    steps = planSteps(await choose(offered, failures), offered);
  }

  for (const p of offered.flatMap((unit) => unit.members)) {
    if (!upgraded.has(p.name) && !failures.has(p.name)) {
      results.skipped.push({ name: p.name, reason: `not selected (stays at ${p.from}; ${p.to} available)` });
    }
  }
}

/**
 * Asks which packages to upgrade (before the baseline tests, so nobody waits for a long test
 * run first). Without a person to ask, or with --only, everything listed is taken.
 * @returns {Promise<{pending: object[], selected: object[]}>}
 */
export async function chooseFirstRound(session, { choosing }) {
  log.step('Looking for outdated packages');
  const plan = buildPlan(session);
  session.results.skipped.push(...plan.skipped);
  const pending = linkUpgrades(session.ctx, plan.planned);
  const selected = planSteps(await chooseUpgrades(pending, { interactive: choosing, firstRound: true }), pending);
  return { pending, selected };
}

/** Runs the rounds with the real npm, prompts and logging. */
export function upgradeRounds(session, { pending, selected, choosing }) {
  return runRounds({
    pending,
    selected,
    repeat: choosing,
    results: session.results,
    upgrade: (step, position) => upgradeStep(session.ctx, step, position),
    replan: ({ upgraded, failures }) => {
      log.step('Checking for more outdated packages');
      return linkUpgrades(session.ctx, nextRoundItems(buildPlan(session).planned, { upgraded, failures }));
    },
    choose: (units, failures) => chooseUpgrades(units, { interactive: true, firstRound: false, failures }),
  });
}

/**
 * --auto: everything in the first plan, retried with related packages and smaller upgrades
 * (see auto.mjs), with the real npm and logging.
 */
export function autoUpgrade(session, { pending }) {
  const { ctx } = session;
  const projectName = readManifest(ctx.cwd).name;
  const repositories = new Map();
  const repositoryOf = (item) => {
    if (!repositories.has(item.name)) {
      const logFile = ctx.nextLogFile(`repository-${item.name}`, `read the repository of ${item.name}@${item.from}`);
      repositories.set(item.name, getRepository(ctx.cwd, item.name, item.from, logFile));
    }
    return repositories.get(item.name);
  };
  return runAuto({
    units: pending,
    results: session.results,
    onPass: (pass, steps) => {
      if (pass > 1) log.step(`Pass ${pass}: trying ${steps.length} failed or newly outdated upgrade(s) again`);
    },
    upgrade: (step, position) => upgradeStep(ctx, step, position),
    replan: ({ upgraded, failures }) => {
      log.step('Checking for more outdated packages');
      return linkUpgrades(ctx, nextRoundItems(buildPlan(session).planned, { upgraded, failures }));
    },
    related: (step, failure, candidates) => {
      const conflicts = failure?.kind === 'install' && failure.code === 'ERESOLVE' ? conflictingPackages(failure.lines ?? []) : [];
      return findRelated(step, candidates, { conflicts, repositoryOf, projectName });
    },
    fallbacks: (item) =>
      fallbackTargets(item, getPublishedVersions(ctx.cwd, item.name, ctx.nextLogFile(`versions-${item.name}`, `list published versions of ${item.name}`))),
  });
}

/** One step: a package, or packages that must move together. */
function upgradeStep(ctx, step, { index, total, retry, attempt = 1, note }) {
  const counter = `[${index + 1}/${total}]`;
  const again = attempt > 1 ? `  — attempt ${attempt}: ${note}` : retry ? '  — retrying' : '';
  if (step.members.length === 1) {
    const [item] = step.members;
    log.step(`${counter} ${item.name}  ${item.from} → ${item.to}  (${item.change})${again}`);
  } else {
    log.step(`${counter} ${step.members.length} packages together${again}`);
    const width = Math.max(...step.members.map((m) => m.name.length));
    for (const m of step.members) log.info(`${m.name.padEnd(width)}  ${m.from} → ${m.to}  (${m.change})`);
    for (const link of step.links) log.info(color.dim(`↳ ${link}`));
    if (step.pulledIn.length) log.info(color.yellow(`included because they are needed: ${step.pulledIn.join(', ')}`));
  }
  const outcome = upgradePackages(ctx, step.members);
  if (outcome.ok) for (const item of outcome.items) log.success(`upgraded ${item.name} to ${item.to}`);
  return outcome;
}

/** What `npm outdated` reports, turned into upgrades (see plan.mjs). */
export function buildPlan({ ctx, options }) {
  return planUpgrades({
    outdated: getOutdated(ctx.cwd, ctx.nextLogFile('outdated', 'list outdated packages')),
    manifest: readManifest(ctx.cwd),
    target: options.target,
    only: options.only,
    exclude: options.exclude,
    getVersions: (name) => getPublishedVersions(ctx.cwd, name, ctx.nextLogFile(`versions-${name}`, `list published versions of ${name}`)),
  });
}

/**
 * Groups upgrades that peerDependencies say must happen together into one unit each.
 * @returns {import('./plan.mjs').UpgradeUnit[]}
 */
export function linkUpgrades(ctx, items) {
  if (items.length < 2) return groupUpgrades(items, []);
  log.info(color.dim('checking peerDependencies for packages that must be upgraded together ...'));
  const cache = new Map();
  const peersOf = (name, version) => {
    const key = `${name}@${version}`;
    if (!cache.has(key)) {
      const logFile = ctx.nextLogFile(`peers-${name}`, `read peerDependencies of ${key}`);
      cache.set(key, getPeerDependencies(ctx.cwd, name, version, logFile));
    }
    return cache.get(key);
  };
  return groupUpgrades(items, findPeerLinks(items, peersOf));
}

/** @returns {Map<string, string[]>} required unit → reasons */
function requirementsByUnit(unit) {
  const byUnit = new Map();
  for (const { unit: name, reason } of unit.requires) byUnit.set(name, [...(byUnit.get(name) ?? []), reason]);
  return byUnit;
}

const describeMember = (p, width = 32) => `${p.name.padEnd(width)} ${p.from} → ${p.to}  (${p.change}, ${p.section})`;

/**
 * One list entry. Packages that must move together are shown as one entry with a line each,
 * plus why; a unit that already failed in this run (see `failures`) gets a highlighted note.
 * @param {import('./plan.mjs').UpgradeUnit} unit
 * @param {Map<string, {to: string, reason: string}>} failures  last failed attempt per package name
 */
function describeUnit(unit, failures = new Map()) {
  const indent = '\n       ';
  const lines =
    unit.members.length === 1
      ? [describeMember(unit.members[0])]
      : [
          `${color.bold(`${unit.members.length} packages, upgraded together`)}  ${color.cyan('[linked]')}`,
          ...unit.members.map((m) => `  ${describeMember(m, Math.max(30, ...unit.members.map((x) => x.name.length)))}`),
          ...unit.links.map((link) => color.dim(`  ↳ ${link}`)),
        ];
  for (const [name, reasons] of requirementsByUnit(unit)) {
    lines.push(color.yellow(`↳ needs ${name} too; it is added to the same step unless upgraded first`));
    lines.push(...reasons.map((reason) => color.dim(`    ${reason}`)));
  }
  const previous = unit.members.map((m) => failures.get(m.name)).find(Boolean);
  if (previous) {
    const what = unit.members.length === 1 ? previous.to : 'this group';
    lines[0] += `  ${color.yellow('[tried, failed]')}`;
    lines.push(color.dim(`↳ ${what} failed earlier in this run: ${previous.reason}`));
  }
  return lines.join(indent);
}

/** Lets the user pick which upgrades to run, and in which order. Non-interactive runs take everything. */
export async function chooseUpgrades(units, { interactive, firstRound, failures = new Map() }) {
  if (!units.length) {
    log.info(firstRound ? 'Everything is up to date.' : 'No more outdated packages.');
    return [];
  }
  const count = units.reduce((n, unit) => n + unit.members.length, 0);
  if (!interactive) {
    log.info(`${count} package(s) to upgrade`);
    return units;
  }
  return selectItems({
    title: firstRound ? `${count} outdated package(s):` : `${count} package(s) are still outdated:`,
    items: units,
    nameOf: (unit) => unit.name,
    aliasesOf: (unit) => unit.members.map((m) => m.name),
    describe: (unit) => describeUnit(unit, failures),
    question: firstRound
      ? 'Which packages should be upgraded?'
      : 'Upgrade any of these as well? Press Enter to finish:',
    emptyMeansNone: !firstRound,
  });
}

/**
 * Asks which overrides to check (or takes all of them: no terminal, --yes or --auto), then removes the ones no longer needed.
 * @param {import('./session.mjs').Session} session
 */
export async function reviewOverrides(session) {
  const { ctx, results, options } = session;
  const prompts = session.prompts && !options.auto;
  const leaves = collectOverrideLeaves(readManifest(ctx.cwd).overrides);
  const chosen =
    prompts && leaves.length
      ? await selectItems({
          title: `${leaves.length} override(s) in package.json:`,
          items: leaves,
          nameOf: (leaf) => leaf.name,
          describe: describeOverride,
          question: 'Which overrides should be checked (and removed if no longer needed)?',
          emptyMeansNone: false,
        })
      : leaves;

  log.step('Checking whether package.json overrides are still needed');
  const { removed, kept } = pruneOverrides(ctx, chosen);
  const notChosen = leaves.filter((leaf) => !chosen.includes(leaf));
  results.overridesRemoved = removed;
  results.overridesKept = [...kept, ...notChosen.map((leaf) => ({ ...leaf, reason: 'not selected for review' }))];
}

/** What is outdated and which overrides would be checked, without changing anything. */
export function printPlanReport(session, title) {
  const { ctx, options } = session;
  log.step(title);
  const { planned, skipped } = buildPlan(session);
  const units = linkUpgrades(ctx, planned);

  log.plain(color.bold(`\nOutdated, can be upgraded (${planned.length}):`));
  if (!planned.length) log.info('none, everything is up to date');
  for (const unit of units) {
    if (unit.members.length > 1) log.info(color.bold(`upgraded together (${unit.members.length}):`));
    const pad = unit.members.length > 1 ? '  ' : '';
    for (const p of unit.members) log.info(`${pad}${p.name.padEnd(40)} ${p.from} → ${p.to}  (${p.change}, ${p.section})`);
    for (const link of unit.links) log.info(color.dim(`  ↳ ${link}`));
    for (const [name, reasons] of requirementsByUnit(unit)) {
      log.info(color.dim(`  ↳ needs ${name} too: ${reasons.join('; ')}`));
    }
  }
  if (skipped.length) {
    log.plain(color.bold(`\nWould skip (${skipped.length}):`));
    for (const s of skipped) log.info(`${s.name.padEnd(40)} ${s.reason}`);
  }

  const overrides = collectOverrideLeaves(readManifest(ctx.cwd).overrides);
  if (overrides.length && !options.skipOverrides) {
    log.plain(color.bold(`\nOverrides that would be re-checked (${overrides.length}):`));
    for (const o of overrides) log.info(describeOverride(o));
  }
}
