/**
 * Command-line entry point: parses options and orchestrates the run.
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AbortError, EXIT_CODES, PreflightError, QuitError } from './errors.mjs';
import { run } from './exec.mjs';
import {
  commitFiles,
  compareWithMain,
  createBranch,
  deleteBranch,
  describeChanges,
  getBranchStatus,
  getCurrentBranch,
  nextFreeBranchName,
  uncommittedChanges,
  verifyCurrentBranchCanUpgrade,
  verifyMainBranchIsCurrent,
} from './git.mjs';
import { color, flashBanner, log } from './logger.mjs';
import { lockfileSyncProblems, npmFailureReason, summarizeNpmError, testFailureReason } from './failure-report.mjs';
import { hasLockfile, MANIFEST_FILES, presentManifestFiles, readManifest } from './manifest.mjs';
import { findOpenMergeRequests } from './merge-requests.mjs';
import { canPrompt, choose, confirm, selectItems } from './prompt.mjs';
import { cleanInstall, getOutdated, getPublishedVersions } from './npm.mjs';
import { collectOverrideLeaves, describeOverride } from './overrides.mjs';
import { nextRoundItems, planUpgrades, TARGETS } from './plan.mjs';
import { buildCommitTitle, buildReport } from './report.mjs';
import { pruneOverrides, RunContext, upgradePackage } from './workflow.mjs';

const today = () => new Date().toISOString().slice(0, 10);

const OPTIONS = {
  cwd: { type: 'string', default: process.cwd() },
  'main-branch': { type: 'string', default: 'main' },
  remote: { type: 'string', default: 'origin' },
  branch: { type: 'string', default: `chore/deps-upgrade-${today()}` },
  'no-branch': { type: 'boolean', default: false },
  'from-main': { type: 'boolean', default: false },
  'on-current-branch': { type: 'boolean', default: false },
  'no-commit': { type: 'boolean', default: false },
  'replace-branch': { type: 'boolean', default: false },
  'git-host': { type: 'string' },
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

  When started on a branch other than main, the script reports what is outdated on that
  branch and asks where to upgrade. Without a terminal it only reports, unless told:
  --from-main            switch to main and upgrade on a new branch from it
  --on-current-branch    upgrade on the current branch (its MR gets the changes)

  --replace-branch       If the working branch already exists (locally or on the remote),
                         delete it without asking and start it fresh from main (⚠ irreversible).
                         Without this flag you are asked; with --yes a new name is used instead.
                         Never deletes a branch that has an open MR, or when that can't be checked.
  --git-host <host>      github | gitlab. Only needed when it can't be told from the remote URL
                         (e.g. a self-hosted GitLab without "gitlab" in its name). Open MRs are
                         checked with gh/glab if logged in, else GITHUB_TOKEN / GITLAB_TOKEN.
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

At any question, type "q" to quit. Upgrades already done are kept (uncommitted) and the
commands to commit or discard them are shown. While npm or the tests run, use Ctrl+C.

Exit codes: 0 success (also after "q"), 1 pre-flight check failed, 2 tests fail before
            any change, 3 unexpected error, 130 interrupted (Ctrl+C).
`;

export async function main(argv = process.argv.slice(2)) {
  let ctx;
  // What the run has done so far, so quitting part-way can say what was kept.
  const session = { options: null, results: null };
  // Ctrl+C reaches the running child too; keeping Node alive lets us roll back cleanly.
  process.on('SIGINT', () => {});

  try {
    const options = parseOptions(argv);
    session.options = options;
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

    verifyProject(cwd, options);

    // Started on another branch: report on it first, then let the user decide where to upgrade.
    const startBranch = getCurrentBranch(cwd);
    let mode = 'main';
    if (startBranch && startBranch !== options.mainBranch) {
      mode = await reviewOtherBranch(ctx, options, startBranch);
      if (mode === 'stop') return EXIT_CODES.OK;
    }

    let reuseBranch = false;
    if (mode === 'main') {
      log.step(`Checking that "${options.mainBranch}" is checked out and up to date with ${options.remote}`);
      await ensureUpToDate(cwd, options, () =>
        verifyMainBranchIsCurrent({ cwd, mainBranch: options.mainBranch, remote: options.remote }),
      );
      log.success(`on ${options.mainBranch}, clean and in sync with ${options.remote}/${options.mainBranch}`);

      // Decided up front so a name clash doesn't surface only after installs and test runs.
      if (!options.noBranch && !options.dryRun) {
        ({ name: options.branch, reuse: reuseBranch } = await resolveWorkingBranch(cwd, options));
      }
      installBaseline(ctx, options, options.mainBranch);
      if (options.dryRun) return dryRun(ctx, options);
    }

    // Where the changes land: a new branch from main, main itself (--no-branch), or the current branch.
    const baseBranch = mode === 'main' ? options.mainBranch : startBranch;
    options.createdBranch = mode === 'main' && !options.noBranch;
    options.workBranch = options.createdBranch ? options.branch : baseBranch;

    const interactive = !options.yes && options.only.size === 0 && canPrompt();
    const results = { upgraded: [], failed: [], skipped: [], overridesRemoved: [], overridesKept: [] };
    session.results = results;

    // Ask before the baseline tests so the user isn't kept waiting for a long test run first.
    log.step('Looking for outdated packages');
    let plan = buildPlan(ctx, options);
    results.skipped = plan.skipped;
    let selected = await chooseUpgrades(plan.planned, { interactive, firstRound: true });

    log.step('Running tests before changing anything (baseline)');
    const baselineLog = ctx.nextLogFile('baseline-tests', `run tests on ${baseBranch} before any change`);
    const baseline = ctx.verifyTests(baselineLog);
    ctx.record(baseline.ok, 'baseline tests', baselineLog);
    if (!baseline.ok) {
      await flashBanner(`Tests already fail on ${baseBranch}`, [
        'Upgrades cannot be verified while the baseline is red.',
        testFailureReason(baseline.analysis, 'Failing').replaceAll('`', ''),
        `Fix the failing tests on ${baseBranch} first, then run this script again.`,
        `Details: ${baselineLog}`,
      ]);
      return EXIT_CODES.BASELINE_TESTS_FAILED;
    }

    if (options.createdBranch) {
      createBranch(cwd, options.branch, { reset: reuseBranch });
      log.success(`${reuseBranch ? 'reset and checked out' : 'created'} branch ${options.branch}`);
    }

    const upgraded = new Set();
    const failures = new Map(); // name → last failed attempt; cleared if a retry succeeds
    let pending = plan.planned;
    while (selected.length) {
      for (const [index, item] of selected.entries()) {
        const retry = failures.has(item.name) ? '  — retrying' : '';
        log.step(`[${index + 1}/${selected.length}] ${item.name}  ${item.from} → ${item.to}  (${item.change})${retry}`);
        const { previousAttempt, ...plain } = item;
        const outcome = upgradePackage(ctx, plain);
        if (outcome.ok) {
          upgraded.add(item.name);
          failures.delete(item.name);
          results.upgraded.push(outcome.item);
          log.success(`upgraded ${item.name} to ${item.to}`);
        } else {
          failures.set(item.name, outcome.item);
        }
      }
      results.failed = [...failures.values()];
      if (!interactive) break;

      // Re-check: an upgrade can change what is outdated. Upgraded packages are not offered again;
      // failed ones are, marked as already tried, since a retry can pass after other changes.
      log.step('Checking for more outdated packages');
      plan = buildPlan(ctx, options);
      pending = nextRoundItems(plan.planned, { upgraded, failures });
      selected = await chooseUpgrades(pending, { interactive, firstRound: false });
    }
    for (const p of pending.filter((p) => !upgraded.has(p.name) && !failures.has(p.name))) {
      results.skipped.push({ name: p.name, reason: `not selected (stays at ${p.from}; ${p.to} available)` });
    }

    if (!options.skipOverrides) await reviewOverrides(ctx, results, interactive);

    await finish(ctx, options, results);
    return EXIT_CODES.OK;
  } catch (error) {
    return handleError(error, ctx, session);
  }
}

/**
 * Runs `check` (a branch verification that throws PreflightError). When the only problem is
 * that the branch is behind its remote and can be fast-forwarded, offers to pull (or does so
 * with --yes) and checks again. Anything else (uncommitted work, local commits, divergence)
 * is left for the user to fix by hand.
 * @returns {Promise<boolean>} true when it pulled
 * @throws {PreflightError}
 */
async function ensureUpToDate(cwd, options, check) {
  try {
    check();
    return false;
  } catch (error) {
    const fixable = error instanceof PreflightError && error.issues.length === 1 && error.issues[0].autoFix;
    if (!fixable) throw error;

    const { problem, autoFix } = error.issues[0];
    log.warn(problem);
    if (autoFix.incoming) log.plain(color.dim(autoFix.incoming.split('\n').map((l) => `      ${l}`).join('\n')));

    const pull = options.yes || (canPrompt() && (await confirm(`Pull them now (${autoFix.label})?`)));
    if (!pull) throw error;

    const result = run('git', autoFix.args, { cwd, allowFailure: true });
    if (!result.ok) {
      throw new PreflightError('Could not pull the latest changes', [
        { problem: `${autoFix.label} failed:\n      ${(result.stderr || result.stdout).trim()}`, fix: error.issues[0].fix },
      ]);
    }
    log.success('pulled the latest changes');
  }
  check();
  return true;
}

/**
 * The run started on a branch other than main. Installs that branch's dependencies, reports
 * what is outdated, then asks where the upgrade should happen:
 *   - a new branch from main (recommended: the upgrade gets its own MR), which needs a clean
 *     working tree so switching branches doesn't carry uncommitted work along;
 *   - this branch (the changes become part of its MR); or
 *   - nowhere: stop after the report.
 * Without a terminal (or with --yes) it only reports, unless --from-main or
 * --on-current-branch says what to do.
 * @returns {Promise<'main'|'current'|'stop'>}
 */
async function reviewOtherBranch(ctx, options, branch) {
  const { cwd, mainBranch, remote } = { cwd: ctx.cwd, ...options };
  log.step(`You are on "${branch}", not "${mainBranch}": checking its dependencies first`);

  const relation = compareWithMain(cwd, { mainBranch, remote });
  if (relation) {
    log.info(`${branch} is ${relation.ahead} commit(s) ahead of and ${relation.behind} behind ${remote}/${mainBranch}.`);
  } else {
    log.warn(`Could not fetch ${remote}/${mainBranch} to compare with it.`);
  }
  const dirty = uncommittedChanges(cwd);
  if (dirty) log.info(`It has uncommitted changes to ${dirty.split('\n').length} tracked file(s).`);

  installBaseline(ctx, options, branch);
  printPlanReport(ctx, options, `Dependency report for ${branch}`);
  if (options.dryRun) return 'stop';

  let choice;
  if (options.fromMain) choice = 'main';
  else if (options.onCurrentBranch) choice = 'current';
  else if (canPrompt() && !options.yes) {
    const choices = [];
    if (!dirty) {
      choices.push({ key: 'main', label: `Create a new branch from ${mainBranch} and upgrade there (recommended: separate MR)` });
    } else {
      log.info(color.dim(`A new branch from ${mainBranch} is not offered while ${branch} has uncommitted changes.`));
    }
    choices.push(
      { key: 'current', label: `Upgrade on ${branch} (the changes become part of this branch and its MR)` },
      { key: 'stop', label: 'Stop here; the report above is all I need' },
    );
    log.plain('');
    choice = await choose('Where should the upgrade happen?', choices);
  } else {
    log.plain('\nNo upgrade was done. To upgrade, run again in a terminal and choose, or pass:');
    log.plain(`  --from-main          create a new branch from ${mainBranch} and upgrade there`);
    log.plain(`  --on-current-branch  upgrade on ${branch}`);
    return 'stop';
  }

  if (choice === 'main') {
    if (dirty) {
      throw new PreflightError(`Cannot switch from "${branch}" to "${mainBranch}"`, [
        {
          problem: `"${branch}" has uncommitted changes:\n${dirty.split('\n').map((l) => `      ${l}`).join('\n')}`,
          fix: ['Commit them:   git add -A && git commit -m "<message>"', 'or stash them:   git stash push -m "before dependency upgrade"'],
        },
      ]);
    }
    const checkout = run('git', ['checkout', mainBranch], { cwd, allowFailure: true });
    if (!checkout.ok) {
      throw new PreflightError(`Cannot check out "${mainBranch}"`, [
        { problem: (checkout.stderr || checkout.stdout).trim(), fix: [`git checkout ${mainBranch}`] },
      ]);
    }
    log.success(`switched to ${mainBranch}; ${branch} is unchanged`);
    return 'main';
  }

  if (choice === 'current') {
    log.step(`Checking that "${branch}" is ready for the upgrade`);
    const pulled = await ensureUpToDate(cwd, options, () =>
      verifyCurrentBranchCanUpgrade(cwd, { branch, manifestFiles: MANIFEST_FILES }),
    );
    if (pulled) installBaseline(ctx, options, branch); // the pull may have changed the lockfile
    log.success(`${branch} is ready; the upgrade will happen on it`);
    return 'current';
  }

  log.plain('\nStopped after the report. Nothing was changed.');
  return 'stop';
}

/**
 * Installs the branch's dependencies as committed (npm ci), so `npm outdated` and the
 * baseline tests see exactly what the branch contains.
 * @throws {PreflightError} when the lockfile is out of sync with package.json
 */
function installBaseline(ctx, options, branch) {
  if (hasLockfile(ctx.cwd)) {
    log.step('Installing dependencies from the lockfile (npm ci)');
  } else {
    log.step('No lockfile found — installing dependencies from package.json (npm install)');
    log.warn('npm will create package-lock.json; unless it is gitignored, it will be part of the MR.');
  }
  const installLog = ctx.nextLogFile('baseline-install', `install dependencies of ${branch} before any change`);
  const install = cleanInstall(ctx.cwd, installLog);
  ctx.record(install.ok, `baseline install (${branch})`, installLog);
  if (!install.ok) {
    const mismatches = lockfileSyncProblems(install);
    if (mismatches) throw lockfileOutOfSyncError(mismatches, branch, options.mainBranch);
    const npmError = summarizeNpmError(install);
    throw new Error(`${npmFailureReason(npmError)} before any change:\n${npmError.lines.join('\n')}\nSee ${installLog}`);
  }
  log.success('dependencies installed');
}

/**
 * Picks the branch this run works on when the requested name is already taken.
 * - Local branch with no commits beyond main (e.g. left by an earlier run that wasn't committed):
 *   reused, because resetting it to main loses nothing.
 * - Branch with its own commits, or one that exists on the remote (perhaps an open MR):
 *   the user chooses between the next free name (`<name>-2`, ...), deleting the existing
 *   branch to start fresh, or stopping. Without a terminal, or with --yes, the new name is
 *   taken; the branch is only deleted with an explicit yes or --replace-branch.
 * @returns {Promise<{ name: string, reuse: boolean }>}
 * @throws {PreflightError} when the user stops, or deleting the branch fails.
 */
async function resolveWorkingBranch(cwd, options) {
  const wanted = options.branch;
  const status = getBranchStatus(cwd, wanted, { mainBranch: options.mainBranch, remote: options.remote });
  if (!status.local && !status.remote) return { name: wanted, reuse: false };

  if (!status.remote && !status.uniqueCommits) {
    log.info(`Branch ${wanted} already exists but has no commits beyond ${options.mainBranch}; it will be reused.`);
    return { name: wanted, reuse: true };
  }

  const where = [status.local && 'locally', status.remote && `on ${options.remote}`].filter(Boolean).join(' and ');
  log.warn(`Branch ${wanted} already exists ${where}.`);
  const showCommits = (title, commits) => {
    if (!commits) return;
    log.info(`${title}:`);
    log.plain(color.dim(commits.split('\n').map((l) => `      ${l}`).join('\n')));
  };
  showCommits(`Local commits not on ${options.mainBranch}`, status.uniqueCommits);
  showCommits(`Commits on ${options.remote}/${wanted} not on ${options.mainBranch}`, status.remoteCommits);

  // An MR can only come from a branch that exists on the remote.
  const mergeRequests = status.remote
    ? await findOpenMergeRequests(cwd, { remote: options.remote, branch: wanted, provider: options.gitHost })
    : { status: 'none', items: [] };
  if (mergeRequests.status === 'open') {
    log.warn(`Open MR from this branch, so it must not be deleted:`);
    for (const mr of mergeRequests.items) log.info(`${mr.id} ${mr.title}  ${color.dim(mr.url)}`);
  } else if (mergeRequests.status === 'unknown') {
    log.warn(`Could not check for an open MR from this branch: ${mergeRequests.reason}`);
  } else if (status.remote) {
    log.info('No open MR from this branch.');
  }

  const alternative = nextFreeBranchName(cwd, wanted, options.remote);
  const action = await chooseBranchAction({ wanted, where, alternative, mergeRequests, options });

  if (action === 'rename') {
    log.info(`Working branch: ${alternative}`);
    return { name: alternative, reuse: false };
  }
  if (action === 'replace') {
    const deleted = deleteBranch(cwd, wanted, { local: status.local, remote: status.remote && options.remote });
    if (!deleted.ok) {
      throw new PreflightError(`Could not delete branch "${wanted}"`, [
        {
          problem: deleted.error,
          fix: ['The branch may be protected, or you may lack permission to delete it.', 'Run again and choose a new name instead.'],
        },
      ]);
    }
    log.success(`deleted ${wanted} ${where}; starting fresh from ${options.mainBranch}`);
    return { name: wanted, reuse: false };
  }

  throw new PreflightError(`Branch "${wanted}" is already in use`, [
    {
      problem: `"${wanted}" exists ${where} and this run will not overwrite it.`,
      fix: [
        'Run again with a different name:   --branch <name>',
        `or, if that work is no longer needed, delete it first:   git branch -D ${wanted}` +
          (status.remote ? `   and   git push ${options.remote} --delete ${wanted}` : '') +
          '   (⚠ irreversible)',
      ],
    },
  ]);
}

/**
 * Deleting is never offered while an MR is open from the branch. When MRs could not be
 * checked, the user may still delete interactively (after a warning), but --replace-branch
 * refuses, because nobody is there to double-check.
 * @returns {Promise<'rename'|'replace'|'stop'>}
 * @throws {PreflightError} when --replace-branch is given but deleting isn't safe.
 */
async function chooseBranchAction({ wanted, where, alternative, mergeRequests, options }) {
  const openMr = mergeRequests.status === 'open';

  if (options.replaceBranch) {
    if (openMr || mergeRequests.status === 'unknown') throw cannotReplaceError({ wanted, mergeRequests, options });
    return 'replace';
  }
  if (options.yes || !canPrompt()) return 'rename';

  const choices = [{ key: 'rename', label: `Use a new branch: ${alternative}  (the existing branch is not touched)` }];
  if (openMr) {
    log.info(color.dim(`Deleting ${wanted} is not offered while ${mergeRequests.items.map((mr) => mr.id).join(', ')} is open.`));
  } else {
    choices.push({ key: 'replace', label: `Delete ${wanted} ${where} and start it fresh from ${options.mainBranch}` });
  }
  choices.push({ key: 'stop', label: 'Stop' });

  const action = await choose('What should this run do?', choices);
  if (action !== 'replace') return action;

  const unverified = mergeRequests.status === 'unknown' ? ' Open MRs could not be checked, so make sure none uses this branch.' : '';
  const sure = await confirm(
    `${color.red('⚠')} This permanently deletes ${wanted} ${where}, including the commits listed above.${unverified} Delete it?`,
  );
  return sure ? 'replace' : 'stop';
}

function cannotReplaceError({ wanted, mergeRequests, options }) {
  const openMr = mergeRequests.status === 'open';
  return new PreflightError(`--replace-branch: "${wanted}" cannot be deleted safely`, [
    {
      problem: openMr
        ? `An MR is open from this branch:\n${mergeRequests.items.map((mr) => `      ${mr.id} ${mr.title}  ${mr.url}`).join('\n')}`
        : `Could not check whether an MR is open from this branch: ${mergeRequests.reason}`,
      fix: [
        openMr
          ? 'Merge or close that MR first, then run again.'
          : 'Make the check possible: log in with gh/glab, set GITHUB_TOKEN or GITLAB_TOKEN, or pass --git-host.',
        `or run without --replace-branch to use a new branch name (${options.remote} branch stays untouched).`,
      ],
    },
  ]);
}

/**
 * The branch's lockfile doesn't match its package.json. Repairing it here would mix unrelated
 * lockfile changes into the upgrade and test something that isn't committed, so the user
 * fixes it first: through an MR on main, or with a plain commit on any other branch.
 */
function lockfileOutOfSyncError(mismatches, branch, mainBranch) {
  const commit = 'git add package-lock.json && git commit -m "chore: sync package-lock.json with package.json"';
  return new PreflightError('package-lock.json is out of sync with package.json', [
    {
      problem:
        `package.json on ${branch} was changed without updating package-lock.json, ` +
        'so "npm ci" refuses to install' +
        (mismatches.length ? `:\n${mismatches.map((m) => `      ${m}`).join('\n')}` : '.'),
      fix:
        branch === mainBranch
          ? [
              'git checkout -b fix/sync-lockfile',
              'npm install',
              commit,
              `Merge it into ${mainBranch} through an MR, then pull ${mainBranch}.`,
            ]
          : [`On ${branch}:  npm install`, commit],
    },
  ]);
}

/** Lets the user pick which upgrades to run, and in which order. Non-interactive runs take everything. */
/** One list entry; a package that already failed in this run gets a second, highlighted line. */
function describeUpgrade(p) {
  const line = `${p.name.padEnd(32)} ${p.from} → ${p.to}  (${p.change}, ${p.section})`;
  if (!p.previousAttempt) return line;
  const { to, reason } = p.previousAttempt;
  const note = `${line}  ${color.yellow('[tried, failed]')}`;
  return `${note}\n       ${color.dim(`↳ ${to} failed earlier in this run: ${reason.replaceAll('`', '')}`)}`;
}

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
    describe: describeUpgrade,
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
  if (values['from-main'] && values['on-current-branch']) {
    throw new PreflightError('Invalid option', [
      { problem: '--from-main and --on-current-branch cannot be used together', fix: ['Pick one of them.'] },
    ]);
  }
  if (values['git-host'] && !['github', 'gitlab'].includes(values['git-host'])) {
    throw new PreflightError('Invalid option', [
      { problem: '--git-host must be "github" or "gitlab"', fix: ['e.g. --git-host gitlab'] },
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
    fromMain: values['from-main'],
    onCurrentBranch: values['on-current-branch'],
    noCommit: values['no-commit'],
    replaceBranch: values['replace-branch'],
    gitHost: values['git-host'],
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
  printPlanReport(ctx, options, 'Dry run — nothing will be changed');
  return EXIT_CODES.OK;
}

/** What is outdated and which overrides would be checked, without changing anything. */
function printPlanReport(ctx, options, title) {
  log.step(title);
  const { planned, skipped } = buildPlan(ctx, options);

  log.plain(color.bold(`\nOutdated, can be upgraded (${planned.length}):`));
  if (!planned.length) log.info('none, everything is up to date');
  for (const p of planned) log.info(`${p.name.padEnd(40)} ${p.from} → ${p.to}  (${p.change}, ${p.section})`);
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
    if (options.createdBranch) {
      // Nothing to propose: don't leave an empty branch behind.
      run('git', ['checkout', options.mainBranch], { cwd: ctx.cwd, allowFailure: true });
      run('git', ['branch', '-D', options.workBranch], { cwd: ctx.cwd, allowFailure: true });
      log.info(`No changes were kept, so branch ${options.workBranch} was removed.`);
    }
    return;
  }

  const { report, commitMessage, reportFile, messageFile } = writeSummaryFiles(ctx, options, results);

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
      log.success(`committed to ${options.workBranch}; the commit message is the MR summary`);
      if (options.workBranch !== options.mainBranch) {
        log.plain(`\nNext steps:\n  git push -u ${options.remote} ${options.workBranch}`);
        log.plain(
          options.createdBranch
            ? '  then open an MR — GitHub/GitLab prefill its description from the commit message.'
            : `  The commit becomes part of ${options.workBranch} and of its MR, if it has one.`,
        );
      }
      return;
    }
    log.warn(`commit failed: ${commit.error}`);
  }

  printUncommittedHelp(options, files, messageFile);
}

/** Writes mr-summary.md and commit-message.txt (and --report) for the changes kept so far. */
function writeSummaryFiles(ctx, options, results) {
  const report = buildReport(results);
  const commitMessage = `${buildCommitTitle(results)}\n\n${report}`;
  const reportFile = join(ctx.logDir, 'mr-summary.md');
  const messageFile = join(ctx.logDir, 'commit-message.txt');
  writeFileSync(reportFile, report);
  writeFileSync(messageFile, commitMessage);
  if (options.report) writeFileSync(resolve(options.report), report);
  return { report, commitMessage, reportFile, messageFile };
}

function printUncommittedHelp(options, files, messageFile) {
  const tracked = files.join(' ');
  log.plain(`\n${color.bold('The changes are not committed.')} They are in your working tree on ${options.workBranch}.`);
  log.plain(`  Review:   git diff`);
  log.plain(`  Commit:   git add ${tracked} && git commit -F ${messageFile}`);
  log.plain(
    `  Discard:  git checkout -- ${tracked}` +
      (options.createdBranch ? ` && git checkout ${options.mainBranch} && git branch -D ${options.workBranch}` : ''),
  );
}

/**
 * The user typed "q". Upgrades already kept stay in the working tree, uncommitted, with the
 * commands to commit or discard them. An empty branch the run created is removed.
 */
function reportQuit(ctx, { options, results }) {
  log.plain('');
  log.warn('Quit.');
  if (!ctx || !options) return;

  // Prompts only appear between changes, but never leave a half-applied change behind.
  if (ctx.activeSnapshot) ctx.rollback(ctx.nextLogFile('quit-rollback', 'roll back the change in progress after quitting'));

  const kept = results ? [...results.upgraded.map((u) => `${u.name} ${u.from} → ${u.to}`),
    ...results.overridesRemoved.map((o) => `override ${describeOverride(o)} removed`)] : [];

  if (kept.length) {
    log.info(`Kept so far (all tests passed):`);
    for (const line of kept) log.info(`  • ${line}`);
    const { messageFile } = writeSummaryFiles(ctx, options, results);
    printUncommittedHelp(options, presentManifestFiles(ctx.cwd), messageFile);
    return;
  }

  if (options.createdBranch && getCurrentBranch(ctx.cwd) === options.workBranch) {
    run('git', ['checkout', options.mainBranch], { cwd: ctx.cwd, allowFailure: true });
    run('git', ['branch', '-D', options.workBranch], { cwd: ctx.cwd, allowFailure: true });
    log.info(`Removed the empty branch ${options.workBranch}; you are back on ${options.mainBranch}.`);
  }
  log.info('Nothing was changed.');
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

async function handleError(error, ctx, session) {
  if (error instanceof QuitError) {
    reportQuit(ctx, session);
    return EXIT_CODES.OK;
  }

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
