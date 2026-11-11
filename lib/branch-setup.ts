/**
 * Getting ready to change anything: which branch the run works on, that it is up to date,
 * and that its dependencies install as committed. Nothing in the project changes here except
 * pulling (when allowed), switching to main (when chosen), and deleting a clashing branch
 * (only with an explicit yes or --replace-branch).
 */
import { PreflightError } from './errors.ts';
import { run } from './exec.ts';
import { lockfileSyncProblems, npmFailureReason, summarizeNpmError } from './failure-report.ts';
import {
  compareWithMain,
  deleteBranch,
  getBranchStatus,
  getCurrentBranch,
  nextFreeBranchName,
  uncommittedChanges,
  verifyCurrentBranchCanUpgrade,
  verifyMainBranchIsCurrent,
} from './git.ts';
import { color, log } from './logger.ts';
import { hasLockfile, MANIFEST_FILES } from './manifest.ts';
import { findOpenMergeRequests, type MergeRequestLookup } from './merge-requests.ts';
import { cleanInstall } from './npm.ts';
import { choose, confirm } from './prompt.ts';
import { printPlanReport } from './rounds.ts';
import type { Options } from './options.ts';
import type { Session, Workspace } from './session.ts';
import type { RunContext } from './workflow.ts';

type BranchAction = 'rename' | 'replace' | 'stop';

/**
 * Decides where the changes go and gets that branch ready.
 * - Started on main: checks it is clean and current, picks the working branch name, installs.
 * - Started elsewhere: reports on that branch, then upgrades there, switches to main, or stops.
 * @returns null when the run should stop here
 *   (dry run, report only, or the user chose to stop)
 * @throws {PreflightError} when the branch can't be used as it is
 */
export async function prepareWorkspace(session: Session): Promise<Workspace | null> {
  const { ctx, options } = session;
  const { mainBranch, remote } = options;

  const startBranch = getCurrentBranch(ctx.cwd);
  if (startBranch && startBranch !== mainBranch) {
    const mode = await reviewOtherBranch(session, startBranch);
    if (mode === 'stop') return null;
    if (mode === 'current') return { baseBranch: startBranch, workBranch: startBranch, created: false, reuse: false };
    // mode === 'main': now on main, continue as if started there
  }

  log.step(`Checking that "${mainBranch}" is checked out and up to date with ${remote}`);
  await ensureUpToDate(session, () => verifyMainBranchIsCurrent({ cwd: ctx.cwd, mainBranch, remote }));
  log.success(`on ${mainBranch}, clean and in sync with ${remote}/${mainBranch}`);

  // Decided up front so a name clash doesn't surface only after installs and test runs.
  let branch = { name: options.branch, reuse: false };
  if (!options.noBranch && !options.dryRun) branch = await resolveWorkingBranch(session);

  installBaseline(ctx, mainBranch, mainBranch);
  if (options.dryRun) {
    printPlanReport(session, 'Dry run — nothing will be changed');
    return null;
  }

  const created = !options.noBranch;
  return { baseBranch: mainBranch, workBranch: created ? branch.name : mainBranch, created, reuse: branch.reuse };
}

/**
 * Runs `check` (a branch verification that throws PreflightError). When the only problem is
 * that the branch is behind its remote and can be fast-forwarded, offers to pull (or does so
 * with --yes) and checks again. Anything else (uncommitted work, local commits, divergence)
 * is left for the user to fix by hand.
 * @returns true when it pulled
 * @throws {PreflightError}
 */
async function ensureUpToDate(session: Session, check: () => void): Promise<boolean> {
  const { ctx: { cwd }, options } = session;
  try {
    check();
    return false;
  } catch (error) {
    const fixable = error instanceof PreflightError && error.issues.length === 1 && error.issues[0].autoFix;
    if (!fixable) throw error;

    const { problem, autoFix } = error.issues[0];
    log.warn(problem);
    if (autoFix.incoming) log.plain(color.dim(autoFix.incoming.split('\n').map((l) => `      ${l}`).join('\n')));

    const pull = options.yes || (session.prompts && (await confirm(`Pull them now (${autoFix.label})?`)));
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
 */
async function reviewOtherBranch(session: Session, branch: string): Promise<'main' | 'current' | 'stop'> {
  const { ctx, options } = session;
  const { cwd } = ctx;
  const { mainBranch, remote } = options;
  log.step(`You are on "${branch}", not "${mainBranch}": checking its dependencies first`);

  const relation = compareWithMain(cwd, { mainBranch, remote });
  if (relation) {
    log.info(`${branch} is ${relation.ahead} commit(s) ahead of and ${relation.behind} behind ${remote}/${mainBranch}.`);
  } else {
    log.warn(`Could not fetch ${remote}/${mainBranch} to compare with it.`);
  }
  const dirty = uncommittedChanges(cwd);
  if (dirty) log.info(`It has uncommitted changes to ${dirty.split('\n').length} tracked file(s).`);

  installBaseline(ctx, branch, mainBranch);
  printPlanReport(session, `Dependency report for ${branch}`);
  if (options.dryRun) return 'stop';

  let choice;
  if (options.fromMain) choice = 'main';
  else if (options.onCurrentBranch) choice = 'current';
  else if (session.prompts) {
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
    const pulled = await ensureUpToDate(session, () =>
      verifyCurrentBranchCanUpgrade(cwd, { branch, manifestFiles: MANIFEST_FILES }),
    );
    if (pulled) installBaseline(ctx, branch, mainBranch); // the pull may have changed the lockfile
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
function installBaseline(ctx: RunContext, branch: string, mainBranch: string): void {
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
    if (mismatches) throw lockfileOutOfSyncError(mismatches, branch, mainBranch);
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
 * @throws {PreflightError} when the user stops, or deleting the branch fails.
 */
async function resolveWorkingBranch(session: Session): Promise<{ name: string; reuse: boolean }> {
  const { ctx: { cwd }, options, prompts } = session;
  const wanted = options.branch;
  const status = getBranchStatus(cwd, wanted, { mainBranch: options.mainBranch, remote: options.remote });
  if (!status.local && !status.remote) return { name: wanted, reuse: false };

  if (!status.remote && !status.uniqueCommits) {
    log.info(`Branch ${wanted} already exists but has no commits beyond ${options.mainBranch}; it will be reused.`);
    return { name: wanted, reuse: true };
  }

  const where = [status.local && 'locally', status.remote && `on ${options.remote}`].filter(Boolean).join(' and ');
  log.warn(`Branch ${wanted} already exists ${where}.`);
  const showCommits = (title: string, commits: string) => {
    if (!commits) return;
    log.info(`${title}:`);
    log.plain(color.dim(commits.split('\n').map((l) => `      ${l}`).join('\n')));
  };
  showCommits(`Local commits not on ${options.mainBranch}`, status.uniqueCommits);
  showCommits(`Commits on ${options.remote}/${wanted} not on ${options.mainBranch}`, status.remoteCommits);

  // An MR can only come from a branch that exists on the remote.
  const mergeRequests = status.remote
    ? await findOpenMergeRequests(cwd, { remote: options.remote, branch: wanted, provider: options.gitHost })
    : ({ status: 'none', items: [] } as MergeRequestLookup);
  if (mergeRequests.status === 'open') {
    log.warn(`Open MR from this branch, so it must not be deleted:`);
    for (const mr of mergeRequests.items) log.info(`${mr.id} ${mr.title}  ${color.dim(mr.url)}`);
  } else if (mergeRequests.status === 'unknown') {
    log.warn(`Could not check for an open MR from this branch: ${mergeRequests.reason}`);
  } else if (status.remote) {
    log.info('No open MR from this branch.');
  }

  const alternative = nextFreeBranchName(cwd, wanted, options.remote);
  const action = await chooseBranchAction({ wanted, where, alternative, mergeRequests, options, prompts });

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
 * @throws {PreflightError} when --replace-branch is given but deleting isn't safe.
 */
async function chooseBranchAction({
  wanted,
  where,
  alternative,
  mergeRequests,
  options,
  prompts,
}: {
  wanted: string;
  where: string;
  alternative: string;
  mergeRequests: MergeRequestLookup;
  options: Readonly<Options>;
  prompts: boolean;
}): Promise<BranchAction> {
  const openMr = mergeRequests.status === 'open';

  if (options.replaceBranch) {
    if (openMr || mergeRequests.status === 'unknown') throw cannotReplaceError({ wanted, mergeRequests, options });
    return 'replace';
  }
  if (!prompts) return 'rename';

  const choices = [{ key: 'rename', label: `Use a new branch: ${alternative}  (the existing branch is not touched)` }];
  if (openMr) {
    log.info(color.dim(`Deleting ${wanted} is not offered while ${mergeRequests.items.map((mr) => mr.id).join(', ')} is open.`));
  } else {
    choices.push({ key: 'replace', label: `Delete ${wanted} ${where} and start it fresh from ${options.mainBranch}` });
  }
  choices.push({ key: 'stop', label: 'Stop' });

  const action = (await choose('What should this run do?', choices)) as BranchAction;
  if (action !== 'replace') return action;

  const unverified = mergeRequests.status === 'unknown' ? ' Open MRs could not be checked, so make sure none uses this branch.' : '';
  const sure = await confirm(
    `${color.red('⚠')} This permanently deletes ${wanted} ${where}, including the commits listed above.${unverified} Delete it?`,
  );
  return sure ? 'replace' : 'stop';
}

function cannotReplaceError({
  wanted,
  mergeRequests,
  options,
}: {
  wanted: string;
  mergeRequests: MergeRequestLookup;
  options: Readonly<Options>;
}): PreflightError {
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
function lockfileOutOfSyncError(mismatches: string[], branch: string, mainBranch: string): PreflightError {
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
