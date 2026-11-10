/**
 * Command-line entry point: parses options and orchestrates the run.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AbortError, EXIT_CODES, PreflightError } from './errors.mjs';
import { run, tail } from './exec.mjs';
import { createBranch, verifyMainBranchIsCurrent } from './git.mjs';
import { color, flashBanner, log } from './logger.mjs';
import { readManifest } from './manifest.mjs';
import { cleanInstall, getOutdated, getPublishedVersions } from './npm.mjs';
import { collectOverrideLeaves, describeOverride } from './overrides.mjs';
import { planUpgrades, TARGETS } from './plan.mjs';
import { buildReport } from './report.mjs';
import { pruneOverrides, RunContext, upgradePackage } from './workflow.mjs';

const today = () => new Date().toISOString().slice(0, 10);

const OPTIONS = {
  cwd: { type: 'string', default: process.cwd() },
  'main-branch': { type: 'string', default: 'main' },
  remote: { type: 'string', default: 'origin' },
  branch: { type: 'string', default: `chore/deps-upgrade-${today()}` },
  'no-branch': { type: 'boolean', default: false },
  'no-commit': { type: 'boolean', default: false },
  target: { type: 'string', default: 'latest' },
  only: { type: 'string', multiple: true, default: [] },
  exclude: { type: 'string', multiple: true, default: [] },
  'test-cmd': { type: 'string', default: 'npm test' },
  'test-timeout': { type: 'string', default: '0' },
  'skip-overrides': { type: 'boolean', default: false },
  report: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

const HELP = `
Usage: node upgrade-deps.mjs [options]

Upgrades outdated npm dependencies one at a time, running the tests after each
upgrade and rolling back any upgrade that breaks them. Then removes package.json
"overrides" that are no longer needed. Prints a Markdown summary for your MR.

Options:
  --cwd <dir>            Project directory (default: current directory)
  --main-branch <name>   Branch the run must start from (default: main)
  --remote <name>        Remote to compare against (default: origin)
  --branch <name>        Working branch to create (default: chore/deps-upgrade-<date>)
  --no-branch            Do not create a branch (changes are made on the main branch)
  --no-commit            Do not commit; leave all changes in the working tree
  --target <level>       latest | minor | patch  (default: latest)
                           minor = stay within the current major version
                           patch = stay within the current minor version
  --only <pkg>           Only upgrade these packages (repeatable or comma-separated)
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

    log.step('Running tests before changing anything (baseline)');
    if (!ctx.verifyTests(ctx.nextLogFile('baseline-tests'))) {
      await flashBanner('Tests already fail on main', [
        'Upgrades cannot be verified while the baseline is red.',
        `Fix the failing tests on ${options.mainBranch} first, then run this script again.`,
      ]);
      return EXIT_CODES.BASELINE_TESTS_FAILED;
    }

    if (!options.noBranch) {
      createBranch(cwd, options.branch);
      log.success(`created branch ${options.branch}`);
    }

    const results = { upgraded: [], failed: [], skipped: [], overridesRemoved: [], overridesKept: [] };

    log.step('Looking for outdated packages');
    const { planned, skipped } = buildPlan(ctx, options);
    results.skipped = skipped;
    log.info(planned.length ? `${planned.length} package(s) to upgrade` : 'Everything is up to date.');

    for (const [index, item] of planned.entries()) {
      log.step(`[${index + 1}/${planned.length}] ${item.name}  ${item.from} → ${item.to}  (${item.change})`);
      const outcome = upgradePackage(ctx, item);
      (outcome.ok ? results.upgraded : results.failed).push(outcome.item);
      if (outcome.ok) log.success(`upgraded ${item.name} to ${item.to}`);
    }

    if (!options.skipOverrides) {
      log.step('Checking whether package.json overrides are still needed');
      const { removed, kept } = pruneOverrides(ctx);
      results.overridesRemoved = removed;
      results.overridesKept = kept;
    }

    finish(ctx, options, results);
    return EXIT_CODES.OK;
  } catch (error) {
    return handleError(error, ctx);
  }
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
    target: values.target,
    only: list(values.only),
    exclude: list(values.exclude),
    testCmd: values['test-cmd'],
    testTimeoutSec,
    skipOverrides: values['skip-overrides'],
    report: values.report,
    dryRun: values['dry-run'],
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

function finish(ctx, options, results) {
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

  if (changed && !options.noBranch && ctx.commit) {
    log.plain(`\nNext steps:\n  git push -u ${options.remote} ${options.branch}\n  then open an MR and paste the summary above.`);
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
