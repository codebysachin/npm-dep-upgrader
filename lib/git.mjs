/**
 * Git helpers: pre-flight validation of the main branch, branch creation and commits.
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

/** @throws {PreflightError} when the branch already exists. */
export function createBranch(cwd, branchName) {
  if (git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`]).ok) {
    throw new PreflightError(`Branch "${branchName}" already exists`, [
      {
        problem: `A local branch named "${branchName}" already exists.`,
        fix: [`Delete it:  git branch -D ${branchName}`, 'or choose another name with --branch <name>.'],
      },
    ]);
  }
  run('git', ['checkout', '-b', branchName], { cwd });
}

/**
 * Stages the given files (only those that exist / are tracked) and commits them.
 * @returns {boolean} true when a commit was created.
 */
export function commitFiles(cwd, files, message) {
  run('git', ['add', '--', ...files], { cwd });
  if (git(cwd, ['diff', '--cached', '--quiet']).ok) return false; // nothing staged
  return git(cwd, ['commit', '-m', message]).ok;
}

const indent = (text, spaces) =>
  text
    .split('\n')
    .map((line) => ' '.repeat(spaces) + line)
    .join('\n');
