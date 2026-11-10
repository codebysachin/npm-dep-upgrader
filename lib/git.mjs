/**
 * Git helpers: pre-flight validation of main or the current branch, branch creation and commits.
 */
import { run } from './exec.mjs';
import { PreflightError } from './errors.mjs';

const git = (cwd, args, opts = {}) => run('git', args, { cwd, allowFailure: true, ...opts });

/**
 * Ensures the repository is on `mainBranch`, has no uncommitted changes to
 * tracked files, and that local `mainBranch` is identical to `remote/mainBranch`.
 * Collects every problem found so the user can fix them all in one go.
 *
 * @throws {PreflightError}
 */
export function verifyMainBranchIsCurrent({ cwd, mainBranch, remote }) {
  const remoteRef = `${remote}/${mainBranch}`;

  if (!git(cwd, ['rev-parse', '--is-inside-work-tree']).ok) {
    throw new PreflightError('Not a git repository', [
      {
        problem: `${cwd} is not inside a git repository.`,
        fix: ['cd into your project folder (the one that contains .git) and run the script again.'],
      },
    ]);
  }

  const issues = [];

  const currentBranch = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout.trim();
  const dirty = git(cwd, ['status', '--porcelain', '--untracked-files=no']).stdout.trim();

  if (dirty) {
    issues.push({
      problem: 'You have uncommitted changes to tracked files:\n' + indent(dirty, 6),
      fix: [
        'Commit them:          git add -A && git commit -m "<message>"',
        'or stash them:        git stash push -m "before dependency upgrade"',
        'or discard them:      git restore .   (⚠ irreversible)',
      ],
    });
  }

  if (currentBranch !== mainBranch) {
    issues.push({
      problem: currentBranch
        ? `You are on branch "${currentBranch}", but the script must start from "${mainBranch}".`
        : `HEAD is detached; the script must start from "${mainBranch}".`,
      fix: [`git checkout ${mainBranch}`],
    });
  }

  if (!git(cwd, ['remote', 'get-url', remote]).ok) {
    issues.push({
      problem: `Git remote "${remote}" is not configured.`,
      fix: [`git remote add ${remote} <repository-url>`, 'or pass --remote <name> to use a different remote.'],
    });
    throw new PreflightError(`"${mainBranch}" branch cannot be verified`, issues);
  }

  const fetch = git(cwd, ['fetch', remote, mainBranch, '--quiet']);
  if (!fetch.ok) {
    issues.push({
      problem: `Could not fetch ${remoteRef}:\n${indent(fetch.stderr.trim(), 6)}`,
      fix: [
        'Check your network/VPN connection and git credentials (SSH key or access token).',
        `Verify the branch exists on the remote:  git ls-remote --heads ${remote} ${mainBranch}`,
      ],
    });
    throw new PreflightError(`"${mainBranch}" branch cannot be verified`, issues);
  }

  if (!git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${mainBranch}`]).ok) {
    issues.push({
      problem: `Local branch "${mainBranch}" does not exist.`,
      fix: [`git checkout -b ${mainBranch} ${remoteRef}`],
    });
  } else {
    const counts = git(cwd, ['rev-list', '--left-right', '--count', `${mainBranch}...${remoteRef}`]).stdout.trim();
    const [ahead, behind] = counts.split(/\s+/).map(Number);
    const syncIssue = describeSyncIssue({ ahead, behind, mainBranch, remote, remoteRef });
    // Only a clean main that is purely behind can be updated safely without the user's own git work:
    // a fast-forward pull can't conflict or lose commits.
    if (syncIssue && ahead === 0 && currentBranch === mainBranch && !dirty) {
      syncIssue.autoFix = {
        label: `git pull --ff-only ${remote} ${mainBranch}`,
        args: ['pull', '--ff-only', remote, mainBranch],
        incoming: git(cwd, ['log', '--oneline', '--no-decorate', '-n', '10', `${mainBranch}..${remoteRef}`]).stdout.trim(),
      };
    }
    if (syncIssue) issues.push(syncIssue);
  }

  if (issues.length) throw new PreflightError(`"${mainBranch}" branch is not ready / not up to date`, issues);
}

function describeSyncIssue({ ahead, behind, mainBranch, remote, remoteRef }) {
  if (ahead === 0 && behind === 0) return null;

  if (ahead === 0) {
    return {
      problem: `Local "${mainBranch}" is ${behind} commit(s) behind ${remoteRef}.`,
      fix: [`git checkout ${mainBranch} && git pull --ff-only ${remote} ${mainBranch}`],
    };
  }

  const movesCommits = [
    `Move them to a feature branch and reset ${mainBranch}:`,
    `  git branch <feature-branch-name> ${mainBranch}`,
    `  git checkout ${mainBranch} && git reset --hard ${remoteRef}   (commits stay safe on <feature-branch-name>)`,
  ];

  if (behind === 0) {
    return {
      problem: `Local "${mainBranch}" has ${ahead} commit(s) that are not on ${remoteRef}.`,
      fix: ['If they belong on main, get them merged through an MR first, then pull.', ...movesCommits],
    };
  }

  return {
    problem: `Local "${mainBranch}" has diverged from ${remoteRef} (${ahead} ahead, ${behind} behind).`,
    fix: [`Rebase your local commits:  git pull --rebase ${remote} ${mainBranch}`, ...movesCommits],
  };
}

/** Name of the checked-out branch, or '' when HEAD is detached or this isn't a repository. */
export const getCurrentBranch = (cwd) => git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']).stdout.trim();

/** Tracked files with uncommitted changes, optionally limited to `paths` (`git status --short` lines). */
export const uncommittedChanges = (cwd, paths = []) =>
  git(cwd, ['status', '--porcelain', '--untracked-files=no', '--', ...paths]).stdout.trimEnd();

/**
 * How the current branch relates to the latest remote main (fetched first).
 * @returns {{ ahead: number, behind: number } | null}  null when main can't be fetched
 */
export function compareWithMain(cwd, { mainBranch, remote }) {
  if (!git(cwd, ['fetch', '--quiet', remote, mainBranch]).ok) return null;
  const counts = git(cwd, ['rev-list', '--left-right', '--count', `HEAD...${remote}/${mainBranch}`]).stdout.trim();
  const [ahead, behind] = counts.split(/\s+/).map(Number);
  return { ahead, behind };
}

/**
 * Checks that the current (non-main) branch can take the upgrade:
 * package.json and the lockfile have no uncommitted edits, and the branch is not behind
 * or diverged from its upstream. Being ahead is fine (unpushed work is normal on a branch).
 * When the branch is only behind, the issue carries an `autoFix` fast-forward pull.
 * @throws {PreflightError}
 */
export function verifyCurrentBranchCanUpgrade(cwd, { branch, manifestFiles }) {
  const issues = [];

  const dirtyManifests = uncommittedChanges(cwd, manifestFiles);
  if (dirtyManifests) {
    issues.push({
      problem: `package.json / lockfile have uncommitted changes on "${branch}":\n${indent(dirtyManifests, 6)}`,
      fix: [
        'Commit them first:   git add package.json package-lock.json && git commit -m "<message>"',
        'or stash them:       git stash push -m "before dependency upgrade" -- package.json package-lock.json',
      ],
    });
  }

  const upstream = git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).stdout.trim();
  if (upstream) {
    const [remote, ...rest] = upstream.split('/');
    const remoteBranch = rest.join('/');
    if (!git(cwd, ['fetch', '--quiet', remote, remoteBranch]).ok) {
      issues.push({
        problem: `Could not fetch ${upstream} to check that "${branch}" is up to date.`,
        fix: ['Check your network/VPN connection and git credentials.'],
      });
    } else {
      const counts = git(cwd, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`]).stdout.trim();
      const [ahead, behind] = counts.split(/\s+/).map(Number);
      if (behind && !ahead) {
        issues.push({
          problem: `"${branch}" is ${behind} commit(s) behind ${upstream}.`,
          fix: [`git pull --ff-only ${remote} ${remoteBranch}`],
          autoFix: {
            label: `git pull --ff-only ${remote} ${remoteBranch}`,
            args: ['pull', '--ff-only', remote, remoteBranch],
            incoming: git(cwd, ['log', '--oneline', '--no-decorate', '-n', '10', `HEAD..${upstream}`]).stdout.trim(),
          },
        });
      } else if (behind && ahead) {
        issues.push({
          problem: `"${branch}" has diverged from ${upstream} (${ahead} ahead, ${behind} behind).`,
          fix: [`Bring it up to date first:  git pull --rebase ${remote} ${remoteBranch}`],
        });
      }
    }
  }

  if (issues.length) throw new PreflightError(`"${branch}" is not ready for the upgrade`, issues);
}

const localBranchExists = (cwd, name) => git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).ok;
const remoteBranchExists = (cwd, remote, name) => git(cwd, ['ls-remote', '--exit-code', '--heads', remote, name]).ok;

/**
 * What already exists under a branch name.
 * @returns {{ local: boolean, remote: boolean, uniqueCommits: string, remoteCommits: string }}
 *   uniqueCommits / remoteCommits: commits on the local / remote branch that are not on
 *   `mainBranch` (newest first, at most 5)
 */
export function getBranchStatus(cwd, name, { mainBranch, remote }) {
  const notOnMain = (ref) => git(cwd, ['log', '--oneline', '--no-decorate', '-n', '5', `${mainBranch}..${ref}`]).stdout.trim();
  const local = localBranchExists(cwd, name);
  const onRemote = remoteBranchExists(cwd, remote, name);
  // Fetching into FETCH_HEAD only, so no local branch or remote-tracking ref is created or moved.
  const fetched = onRemote && git(cwd, ['fetch', '--quiet', remote, `refs/heads/${name}`]).ok;
  return {
    local,
    remote: onRemote,
    uniqueCommits: local ? notOnMain(name) : '',
    remoteCommits: fetched ? notOnMain('FETCH_HEAD') : '',
  };
}

/**
 * Deletes a branch locally and/or on the remote.
 * @returns {{ ok: boolean, error?: string }}
 */
export function deleteBranch(cwd, name, { local, remote }) {
  if (local) {
    const result = git(cwd, ['branch', '-D', name]);
    if (!result.ok) return { ok: false, error: result.stderr.trim() };
  }
  if (remote) {
    const result = git(cwd, ['push', remote, '--delete', name]);
    if (!result.ok) return { ok: false, error: result.stderr.trim() };
  }
  return { ok: true };
}

/** First of `<base>-2`, `<base>-3`, ... that exists neither locally nor on the remote. */
export function nextFreeBranchName(cwd, base, remote) {
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!localBranchExists(cwd, candidate) && !remoteBranchExists(cwd, remote, candidate)) return candidate;
  }
}

/**
 * Creates the working branch from the current commit and checks it out.
 * With `reset`, an existing local branch of that name is moved here first; callers
 * only do that when the branch has no commits of its own, so nothing is lost.
 */
export function createBranch(cwd, branchName, { reset = false } = {}) {
  if (!reset && localBranchExists(cwd, branchName)) {
    throw new PreflightError(`Branch "${branchName}" already exists`, [
      {
        problem: `A local branch named "${branchName}" already exists.`,
        fix: ['Choose another name with --branch <name>.'],
      },
    ]);
  }
  run('git', ['checkout', reset ? '-B' : '-b', branchName], { cwd });
}

// Some projects gitignore package-lock.json; `git add` refuses ignored paths.
const trackableFiles = (cwd, files) => files.filter((file) => !git(cwd, ['check-ignore', '-q', '--', file]).ok);

/**
 * What the run changed in the given files, for showing the user before they decide to commit.
 * @returns {{ files: string, stat: string, diff: string }}  `git status --short`, `--stat`, and the diff of `diffFile`
 */
export function describeChanges(cwd, files, diffFile) {
  const paths = trackableFiles(cwd, files);
  const out = (args) => (paths.length ? git(cwd, args).stdout.trimEnd() : '');
  return {
    files: out(['status', '--short', '--', ...paths]),
    stat: out(['diff', '--stat', '--', ...paths]),
    diff: out(['diff', '--no-color', '--', diffFile]),
  };
}

/**
 * Stages the given files and commits them. If the commit fails (e.g. a commit-msg
 * hook rejects it), the files are unstaged again so the working tree is as it was.
 * @returns {{ ok: boolean, error?: string }}
 */
export function commitFiles(cwd, files, message) {
  const paths = trackableFiles(cwd, files);
  if (!paths.length) return { ok: false, error: 'no files to commit' };
  run('git', ['add', '--', ...paths], { cwd });
  if (git(cwd, ['diff', '--cached', '--quiet']).ok) return { ok: false, error: 'nothing changed' };

  // --cleanup=whitespace keeps Markdown "## headings", which the default mode could strip as comments.
  const commit = git(cwd, ['commit', '--cleanup=whitespace', '-F', '-'], { input: message });
  if (commit.ok) return { ok: true };
  git(cwd, ['reset', '-q', '--', ...paths]);
  return { ok: false, error: (commit.stderr || commit.stdout).trim() };
}

const indent = (text, spaces) =>
  text
    .split('\n')
    .map((line) => ' '.repeat(spaces) + line)
    .join('\n');
