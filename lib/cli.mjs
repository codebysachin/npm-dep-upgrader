/**
 * Command-line entry point: parses options and orchestrates the run.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AbortError, EXIT_CODES, PreflightError } from './errors.mjs';
import { run } from './exec.mjs';
import { commitFiles, createBranch, describeChanges, verifyMainBranchIsCurrent } from './git.mjs';
import { color, flashBanner, log } from './logger.mjs';
import { npmFailureReason, summarizeNpmError, testFailureReason } from './failure-report.mjs';
import { hasLockfile, presentManifestFiles, readManifest } from './manifest.mjs';
import { canPrompt, confirm, selectItems } from './prompt.mjs';
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

Nothing is committed while it works. At the end it shows what changed and asks
whether to commit; the commit message is the MR summary.

Options:
  --cwd <dir>            Project directory (default: current directory)
  --main-branch <name>   Branch the run must start from (default: main)
  --remote <name>        Remote to compare against (default: origin)
  --branch <name>        Working branch to create (default: chore/deps-upgrade-<date>)
  --no-branch            Do not create a branch (changes are made on the main branch)
  --no-commit            Never commit and don't ask; leave all changes in the working tree
  --target <level>       latest | minor | patch  (default: latest)
                           minor = stay within the current major version
                           patch = stay within the current minor version
  -y, --yes              Don't ask; upgrade every outdated package, check every override
                         and commit the result. Without a terminal (e.g. CI) everything is
                         upgraded too, but nothing is committed unless --yes is given.
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
    if (hasLockfile(cwd)) {
      log.step('Installing dependencies from the lockfile (npm ci)');
    } else {
      log.step('No lockfile found — installing dependencies from package.json (npm install)');
      log.warn('npm will create package-lock.json; unless it is gitignored, it will be part of the MR.');
    }
    const installLog = ctx.nextLogFile('baseline-install', 'install dependencies before any change');
    const install = cleanInstall(cwd, installLog);
    ctx.record(install.ok, 'baseline install', installLog);
    if (!install.ok) {
      const npmError = summarizeNpmError(install);
      throw new Error(`${npmFailureReason(npmError)} before any change:\n${npmError.lines.join('\n')}\nSee ${installLog}`);
    }
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
    const baselineLog = ctx.nextLogFile('baseline-tests', `run tests on ${options.mainBranch} before any change`);
    const baseline = ctx.verifyTests(baselineLog);
    ctx.record(baseline.ok, 'baseline tests', baselineLog);
    if (!baseline.ok) {
      await flashBanner('Tests already fail on main', [
        'Upgrades cannot be verified while the baseline is red.',
        testFailureReason(baseline.analysis, 'Failing').replaceAll('`', ''),
        `Fix the failing tests on ${options.mainBranch} first, then run this script again.`,
        `Details: ${baselineLog}`,
      ]);
      return EXIT_CODES.BASELINE_TESTS_FAILED;
    }

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

    await finish(ctx, options, results);
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
    outdated: getOutdated(ctx.cwd, ctx.nextLogFile('outdated', 'list outdated packages')),
    manifest: readManifest(ctx.cwd),
    target: options.target,
    only: options.only,
    exclude: options.exclude,
    getVersions: (name) => getPublishedVersions(ctx.cwd, name, ctx.nextLogFile(`versions-${name}`, `list published versions of ${name}`)),
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

async function finish(ctx, options, results) {
  const changed = results.upgraded.length + results.overridesRemoved.length;
  log.step('Done');
  log.info(
    `${color.green(`${results.upgraded.length} upgraded`)}, ` +
      `${color.green(`${results.overridesRemoved.length} override(s) removed`)}, ` +
      `${color.yellow(`${results.failed.length} failed`)}, ${results.skipped.length} skipped`,
  );
  log.info(color.dim(`step-by-step run log: ${ctx.runIndex}`));

  if (!changed) {
    printNotIncluded(results);
    if (!options.noBranch) {
      // Nothing to propose: don't leave an empty branch behind.
      run('git', ['checkout', options.mainBranch], { cwd: ctx.cwd, allowFailure: true });
      run('git', ['branch', '-D', options.branch], { cwd: ctx.cwd, allowFailure: true });
      log.info(`No changes were kept, so branch ${options.branch} was removed.`);
    }
    return;
  }

  const report = buildReport(results);
  const commitMessage = `${buildCommitTitle(results)}\n\n${report}`;
  const reportFile = join(ctx.logDir, 'mr-summary.md');
  const messageFile = join(ctx.logDir, 'commit-message.txt');
  writeFileSync(reportFile, report);
  writeFileSync(messageFile, commitMessage);
  if (options.report) writeFileSync(resolve(options.report), report);

  log.plain(`\n${color.bold('──────── MR summary (copy below this line) ────────')}\n`);
  log.plain(report);
  log.plain(color.bold('──────── end of MR summary ────────'));
  log.info(color.dim(`saved to ${reportFile}${options.report ? ` and ${resolve(options.report)}` : ''}`));

  printNotIncluded(results);

  const files = presentManifestFiles(ctx.cwd);
  printChanges(describeChanges(ctx.cwd, files, 'package.json'));

  const shouldCommit = await decideCommit(options);
  if (shouldCommit) {
    const commit = commitFiles(ctx.cwd, files, commitMessage);
    if (commit.ok) {
      log.success(`committed to ${options.noBranch ? options.mainBranch : options.branch}; the commit message is the MR summary`);
      if (!options.noBranch) {
        log.plain(`\nNext steps:\n  git push -u ${options.remote} ${options.branch}`);
        log.plain('  then open an MR — GitHub/GitLab prefill its description from the commit message.');
      }
      return;
    }
    log.warn(`commit failed: ${commit.error}`);
  }

  const tracked = files.join(' ');
  log.plain(`\n${color.bold('The changes are not committed.')} They are in your working tree${options.noBranch ? '' : ` on ${options.branch}`}.`);
  log.plain(`  Review:   git diff`);
  log.plain(`  Commit:   git add ${tracked} && git commit -F ${messageFile}`);
  log.plain(`  Discard:  git checkout -- ${tracked}${options.noBranch ? '' : ` && git checkout ${options.mainBranch} && git branch -D ${options.branch}`}`);
}

/** Commits only with the user's yes in a terminal, or with --yes. */
async function decideCommit(options) {
  if (options.noCommit) return false;
  if (canPrompt() && !options.yes) return confirm('Are you happy to commit these changes?');
  if (options.yes) return true;
  log.info('Not running in a terminal, so nothing is committed (pass --yes to commit automatically).');
  return false;
}

function printChanges({ files, stat, diff }) {
  log.step('Changes made (not committed yet)');
  for (const line of (files || '(none)').split('\n')) log.info(line);
  if (stat) log.plain(color.dim(stat.split('\n').map((l) => `  ${l}`).join('\n')));
  if (!diff) return;
  log.plain(`\n  ${color.bold('package.json')}`);
  for (const line of diff.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l))) {
    const painted = line.startsWith('+') ? color.green(line) : line.startsWith('-') ? color.red(line) : color.dim(line);
    log.plain(`    ${painted}`);
  }
}

/** Terminal-only list of what was left out of the MR (the MR summary lists successful changes only). */
function printNotIncluded({ failed, skipped, overridesKept }) {
  if (!failed.length && !skipped.length && !overridesKept.length) return;
  log.step('Not changed in this run (shown here only, not in the MR summary)');
  for (const f of failed) log.warn(`${f.name} ${f.to}: ${f.reason.replaceAll('`', '')}`);
  for (const s of skipped) log.info(color.dim(`${s.name}: ${s.reason}`));
  for (const o of overridesKept) log.info(color.dim(`override ${o.keyPath.join(' › ')}: kept, ${o.reason.replaceAll('`', '')}`));
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
  if (ctx) log.info(`Logs: ${ctx.logDir} (start with run.log)`);
  return EXIT_CODES.UNEXPECTED;
}
