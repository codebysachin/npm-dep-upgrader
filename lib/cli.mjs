/**
 * Command-line entry point: parses options and orchestrates the run.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AbortError, EXIT_CODES, PreflightError } from './errors.mjs';
import { run, tail } from './exec.mjs';
import { createBranch, getHeadSha, squashCommitsSince, verifyMainBranchIsCurrent } from './git.mjs';
import { color, flashBanner, log } from './logger.mjs';
import { readManifest } from './manifest.mjs';
import { canPrompt, selectItems } from './prompt.mjs';
import { cleanInstall, getOutdated, getPublishedVersions } from './npm.mjs';
import { collectOverrideLeaves, describeOverride } from './overrides.mjs';
import { planUpgrades, TARGETS } from './plan.mjs';
import { buildCommitTitle, buildReport } from './report.mjs';
import { pruneOverrides, RunContext, upgradePackage } from './workflow.mjs';

const today = () => new Date().toISOString().slice(0, 10);

const OPTIONS = {
  cwd: { type: 'string', default: process.cwd() },
  'main-branch': { type: 'string', default: 'main' },
  remote: { type: 'string', default: 'origin' },
  branch: { type: 'string', default: `chore/deps-upgrade-${today()}` },
  'no-branch': { type: 'boolean', default: false },
  'no-commit': { type: 'boolean', default: false },
  'no-squash': { type: 'boolean', default: false },
  target: { type: 'string', default: 'latest' },
  only: { type: 'string', multiple: true, default: [] },
  exclude: { type: 'string', multiple: true, default: [] },
  'test-cmd': { type: 'string', default: 'npm test' },
  'test-timeout': { type: 'string', default: '0' },
  'skip-overrides': { type: 'boolean', default: false },
  report: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  yes: { type: 'boolean', short: 'y', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const HELP = `
Usage: node upgrade-deps.mjs [options]

Upgrades outdated npm dependencies one at a time, running the tests after each
upgrade and rolling back any upgrade that breaks them. Then removes package.json
"overrides" that are no longer needed. Prints a Markdown summary for your MR.

In a terminal it asks which packages to upgrade (and in which order), then offers
any packages still outdated until you choose to finish. It also asks which
overrides to check. Packages you don't pick are not touched.

Options:
  --cwd <dir>            Project directory (default: current directory)
  --main-branch <name>   Branch the run must start from (default: main)
  --remote <name>        Remote to compare against (default: origin)
  --branch <name>        Working branch to create (default: chore/deps-upgrade-<date>)
  --no-branch            Do not create a branch (changes are made on the main branch)
  --no-commit            Do not commit; leave all changes in the working tree
  --no-squash            Keep one commit per change instead of squashing them at the end
                         into a single commit whose message is the MR summary
  --target <level>       latest | minor | patch  (default: latest)
                           minor = stay within the current major version
                           patch = stay within the current minor version
  -y, --yes              Don't ask; upgrade every outdated package and check every override
                         (also the behaviour when not run in a terminal, e.g. in CI)
  --only <pkg>           Only upgrade these packages, without asking (repeatable or comma-separated)
  --exclude <pkg>        Never upgrade these packages (repeatable or comma-separated)
  --test-cmd <command>   Test command (default: "npm test")
  --test-timeout <sec>   Fail a test run that takes longer than this (default: no limit)
  --skip-overrides       Do not evaluate package.json overrides
  --report <file>        Also write the Markdown summary to this file
  --dry-run              Only show what would be upgraded; change nothing
  -h, --help             Show this help

Exit codes: 0 success, 1 pre-flight check failed, 2 tests fail before any change,
            3 unexpected error, 130 interrupted.
`;

export async function main(argv = process.argv.slice(2)) {
  let ctx;
  // Ctrl+C reaches the running child too; keeping Node alive lets us roll back cleanly.
  process.on('SIGINT', () => {});

  try {
    const options = parseOptions(argv);
    if (options.help) {
      log.plain(HELP);
      return EXIT_CODES.OK;
    }

    const cwd = resolve(options.cwd);
    const logDir = join(tmpdir(), 'npm-dep-upgrader', new Date().toISOString().replace(/[:.]/g, '-'));
    mkdirSync(logDir, { recursive: true });
    ctx = new RunContext({
      cwd,
      testCommand: options.testCmd,
      logDir,
      commit: !options.noCommit && !options.dryRun,
      testTimeoutMs: options.testTimeoutSec * 1000 || undefined,
    });

    log.plain(color.bold('npm dependency upgrader'));
    log.info(color.dim(`project: ${cwd}`));
    log.info(color.dim(`logs:    ${logDir}`));

    log.step(`Checking that "${options.mainBranch}" is checked out and up to date with ${options.remote}`);
    verifyProject(cwd, options);
    verifyMainBranchIsCurrent({ cwd, mainBranch: options.mainBranch, remote: options.remote });
    log.success(`on ${options.mainBranch}, clean and in sync with ${options.remote}/${options.mainBranch}`);

    // Also needed for --dry-run: `npm outdated` reports versions from node_modules, which may be stale.
    log.step('Installing dependencies from the lockfile (npm ci)');
    const install = cleanInstall(cwd, ctx.nextLogFile('baseline-install'));
    if (!install.ok) throw new Error(`Baseline install failed:\n${tail(install)}`);
    log.success('dependencies installed');

    if (options.dryRun) return dryRun(ctx, options);

    const interactive = !options.yes && options.only.size === 0 && canPrompt();
    const results = { upgraded: [], failed: [], skipped: [], overridesRemoved: [], overridesKept: [] };

    // Ask before the baseline tests so the user isn't kept waiting for a long test run first.
    log.step('Looking for outdated packages');
    let plan = buildPlan(ctx, options);
    results.skipped = plan.skipped;
    let selected = await chooseUpgrades(plan.planned, { interactive, firstRound: true });

    log.step('Running tests before changing anything (baseline)');
    if (!ctx.verifyTests(ctx.nextLogFile('baseline-tests'))) {
      await flashBanner('Tests already fail on main', [
        'Upgrades cannot be verified while the baseline is red.',
        `Fix the failing tests on ${options.mainBranch} first, then run this script again.`,
      ]);
      return EXIT_CODES.BASELINE_TESTS_FAILED;
    }

    // Every commit after this one is made by this run, so it is safe to squash at the end.
    const baseSha = getHeadSha(cwd);
    if (!options.noBranch) {
      createBranch(cwd, options.branch);
      log.success(`created branch ${options.branch}`);
    }

    const attempted = new Set();
    let pending = plan.planned;
    while (selected.length) {
      for (const [index, item] of selected.entries()) {
        log.step(`[${index + 1}/${selected.length}] ${item.name}  ${item.from} → ${item.to}  (${item.change})`);
        attempted.add(item.name);
        const outcome = upgradePackage(ctx, item);
        (outcome.ok ? results.upgraded : results.failed).push(outcome.item);
        if (outcome.ok) log.success(`upgraded ${item.name} to ${item.to}`);
      }
      if (!interactive) break;

      // Re-check: an upgrade can change what is outdated. Packages already tried are not offered again.
      log.step('Checking for more outdated packages');
      plan = buildPlan(ctx, options);
      pending = plan.planned.filter((p) => !attempted.has(p.name));
      selected = await chooseUpgrades(pending, { interactive, firstRound: false });
    }
    for (const p of pending.filter((p) => !attempted.has(p.name))) {
      results.skipped.push({ name: p.name, reason: `not selected (stays at ${p.from}; ${p.to} available)` });
    }

    if (!options.skipOverrides) await reviewOverrides(ctx, results, interactive);

    finish(ctx, options, results, baseSha);
    return EXIT_CODES.OK;
  } catch (error) {
    return handleError(error, ctx);
  }
}

/** Lets the user pick which upgrades to run, and in which order. Non-interactive runs take everything. */
async function chooseUpgrades(items, { interactive, firstRound }) {
  if (!items.length) {
    log.info(firstRound ? 'Everything is up to date.' : 'No more outdated packages.');
    return [];
  }
  if (!interactive) {
    log.info(`${items.length} package(s) to upgrade`);
    return items;
  }
  return selectItems({
    title: firstRound ? `${items.length} outdated package(s):` : `${items.length} package(s) are still outdated:`,
    items,
    nameOf: (p) => p.name,
    describe: (p) => `${p.name.padEnd(32)} ${p.from} → ${p.to}  (${p.change}, ${p.section})`,
    question: firstRound
      ? 'Which packages should be upgraded?'
      : 'Upgrade any of these as well? Press Enter to finish:',
    emptyMeansNone: !firstRound,
  });
}

async function reviewOverrides(ctx, results, interactive) {
  const leaves = collectOverrideLeaves(readManifest(ctx.cwd).overrides);
  const chosen =
    interactive && leaves.length
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

function parseOptions(argv) {
  const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true });
  const list = (items) => new Set(items.flatMap((i) => i.split(',')).map((i) => i.trim()).filter(Boolean));

  if (!TARGETS.includes(values.target)) {
    throw new PreflightError('Invalid option', [
      { problem: `--target must be one of: ${TARGETS.join(', ')}`, fix: ['e.g. --target minor'] },
    ]);
  }
  const testTimeoutSec = Number(values['test-timeout']);
  if (!Number.isFinite(testTimeoutSec) || testTimeoutSec < 0) {
    throw new PreflightError('Invalid option', [
      { problem: '--test-timeout must be a number of seconds', fix: ['e.g. --test-timeout 600'] },
    ]);
  }

  return {
    help: values.help,
    cwd: values.cwd,
    mainBranch: values['main-branch'],
    remote: values.remote,
    branch: values.branch,
    noBranch: values['no-branch'],
    noCommit: values['no-commit'],
    noSquash: values['no-squash'],
    target: values.target,
    only: list(values.only),
    exclude: list(values.exclude),
    testCmd: values['test-cmd'],
    testTimeoutSec,
    skipOverrides: values['skip-overrides'],
    report: values.report,
    dryRun: values['dry-run'],
    yes: values.yes,
  };
}

/** @throws {PreflightError} */
function verifyProject(cwd, options) {
  const issues = [];
  if (!existsSync(join(cwd, 'package.json'))) {
    issues.push({ problem: `No package.json found in ${cwd}.`, fix: ['Run the script from the project root or pass --cwd <dir>.'] });
  } else if (options.testCmd === 'npm test' && !readManifest(cwd).scripts?.test) {
    issues.push({
      problem: 'package.json has no "test" script, so upgrades cannot be verified.',
      fix: ['Add a "test" script to package.json', 'or pass --test-cmd "<command that runs your tests>".'],
    });
  }
  if (!run('npm', ['--version'], { cwd, allowFailure: true }).ok) {
    issues.push({ problem: 'npm is not available on PATH.', fix: ['Install Node.js/npm (https://nodejs.org).'] });
  }
  if (issues.length) throw new PreflightError('Project cannot be upgraded', issues);
}

function buildPlan(ctx, options) {
  return planUpgrades({
    outdated: getOutdated(ctx.cwd, ctx.nextLogFile('outdated')),
    manifest: readManifest(ctx.cwd),
    target: options.target,
    only: options.only,
    exclude: options.exclude,
    getVersions: (name) => getPublishedVersions(ctx.cwd, name, ctx.nextLogFile(`versions-${name}`)),
  });
}

function dryRun(ctx, options) {
  log.step('Dry run — nothing will be changed');
  const { planned, skipped } = buildPlan(ctx, options);

  log.plain(color.bold(`\nWould upgrade (${planned.length}):`));
  for (const p of planned) log.info(`${p.name.padEnd(40)} ${p.from} → ${p.to}  (${p.change}, ${p.section})`);
  if (skipped.length) {
    log.plain(color.bold(`\nWould skip (${skipped.length}):`));
    for (const s of skipped) log.info(`${s.name.padEnd(40)} ${s.reason}`);
  }

  const overrides = collectOverrideLeaves(readManifest(ctx.cwd).overrides);
  if (overrides.length && !options.skipOverrides) {
    log.plain(color.bold(`\nWould re-evaluate overrides (${overrides.length}):`));
    for (const o of overrides) log.info(describeOverride(o));
  }
  return EXIT_CODES.OK;
}

function finish(ctx, options, results, baseSha) {
  const report = buildReport({ ...results, testCommand: options.testCmd });
  const reportFile = join(ctx.logDir, 'mr-summary.md');
  writeFileSync(reportFile, report);
  if (options.report) writeFileSync(resolve(options.report), report);

  const changed = results.upgraded.length + results.overridesRemoved.length;
  log.step('Done');
  log.info(
    `${color.green(`${results.upgraded.length} upgraded`)}, ` +
      `${color.green(`${results.overridesRemoved.length} override(s) removed`)}, ` +
      `${color.yellow(`${results.failed.length} failed`)}, ${results.skipped.length} skipped`,
  );

  log.plain(`\n${color.bold('──────── MR summary (copy below this line) ────────')}\n`);
  log.plain(report);
  log.plain(color.bold('──────── end of MR summary ────────'));
  log.info(color.dim(`saved to ${reportFile}${options.report ? ` and ${resolve(options.report)}` : ''}`));

  if (changed && ctx.commit && !options.noSquash) {
    const message = `${buildCommitTitle(results)}\n\n${report}`;
    if (squashCommitsSince(ctx.cwd, baseSha, message)) {
      log.success('squashed all changes into one commit whose message is the MR summary');
    } else {
      log.warn('could not squash (commit hook rejected the message?); kept one commit per change');
    }
  }

  if (changed && !options.noBranch && ctx.commit) {
    const hint = options.noSquash
      ? 'then open an MR and paste the summary above.'
      : 'then open an MR — GitHub/GitLab prefill its description from the commit message.';
    log.plain(`\nNext steps:\n  git push -u ${options.remote} ${options.branch}\n  ${hint}`);
  } else if (changed && !ctx.commit) {
    log.plain('\nChanges are uncommitted in your working tree (--no-commit). Review them with: git diff');
  } else if (!changed && !options.noBranch) {
    // Nothing to propose: don't leave an empty branch behind.
    run('git', ['checkout', options.mainBranch], { cwd: ctx.cwd, allowFailure: true });
    run('git', ['branch', '-D', options.branch], { cwd: ctx.cwd, allowFailure: true });
    log.info(`No changes were kept, so branch ${options.branch} was removed.`);
  }
}

async function handleError(error, ctx) {
  if (error instanceof PreflightError) {
    const lines = error.issues.flatMap((issue, i) => [
      '',
      color.bold(`${i + 1}. ${issue.problem}`),
      '   How to fix:',
      ...issue.fix.map((step) => `     ${color.cyan('•')} ${step}`),
    ]);
    await flashBanner(`ACTION REQUIRED: ${error.message}`, [...lines, '', 'Then run this script again.']);
    return EXIT_CODES.PREFLIGHT_FAILED;
  }

  if (error instanceof AbortError) {
    log.error('Interrupted.');
    if (ctx?.activeSnapshot) {
      ctx.activeSnapshot.restore();
      log.warn('Restored package.json / package-lock.json for the change in progress. Run "npm install" to resync node_modules.');
    }
    return EXIT_CODES.INTERRUPTED;
  }

  if (error?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' || error?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    log.error(error.message);
    log.plain(HELP);
    return EXIT_CODES.PREFLIGHT_FAILED;
  }

  log.error(error?.stack ?? String(error));
  if (ctx) log.info(`Logs: ${ctx.logDir}`);
  return EXIT_CODES.UNEXPECTED;
}
