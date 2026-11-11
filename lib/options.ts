/**
 * Command-line options: definitions, help text and validation.
 */
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { PreflightError } from './errors.ts';
import { TARGETS, type Target } from './plan.ts';

export interface Options {
  help: boolean;
  cwd: string;
  mainBranch: string;
  remote: string;
  branch: string;
  noBranch: boolean;
  fromMain: boolean;
  onCurrentBranch: boolean;
  noCommit: boolean;
  replaceBranch: boolean;
  gitHost: 'github' | 'gitlab' | undefined;
  target: Target;
  only: Set<string>;
  exclude: Set<string>;
  testCmd: string;
  testTimeoutSec: number;
  skipOverrides: boolean;
  report: string | undefined;
  dryRun: boolean;
  verbose: boolean;
  auto: boolean;
  yes: boolean;
}

const today = () => new Date().toISOString().slice(0, 10);

export const OPTIONS = {
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
  only: { type: 'string', multiple: true, default: [] as string[] },
  exclude: { type: 'string', multiple: true, default: [] as string[] },
  'test-cmd': { type: 'string', default: 'npm test' },
  'test-timeout': { type: 'string', default: '0' },
  'skip-overrides': { type: 'boolean', default: false },
  report: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  verbose: { type: 'boolean', short: 'v', default: false },
  auto: { type: 'boolean', default: false },
  yes: { type: 'boolean', short: 'y', default: false },
  help: { type: 'boolean', short: 'h', default: false },
} satisfies ParseArgsConfig['options'];

export const HELP = `
Usage: node upgrade-deps.ts [options]

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
  --auto                 Upgrade every outdated package without asking which, and try harder
                         before giving up on one: a failed upgrade is tried again together with
                         the packages npm names in a peer conflict and the ones from the same
                         repository or scope, then as a smaller upgrade (newest in the current
                         major, then minor). Failed packages are retried after other upgrades
                         pass. Still asks before committing; add --yes to run unattended.
  --only <pkg>           Only upgrade these packages, without asking (repeatable or comma-separated)
  --exclude <pkg>        Never upgrade these packages (repeatable or comma-separated)
  --test-cmd <command>   Test command (default: "npm test")
  --test-timeout <sec>   Fail a test run that takes longer than this (default: no limit)
  --skip-overrides       Do not evaluate package.json overrides
  --report <file>        Also write the Markdown summary to this file
  --dry-run              Only show what would be upgraded; change nothing
  -v, --verbose          Print each command's output under it, instead of only a
                         link to the log file
  -h, --help             Show this help

At any question, type "q" to quit. Upgrades already done are kept (uncommitted) and the
commands to commit or discard them are shown. While npm or the tests run, use Ctrl+C.

Exit codes: 0 success (also after "q"), 1 pre-flight check failed, 2 tests fail before
            any change, 3 unexpected error, 130 interrupted (Ctrl+C).
`;

/**
 * Parses and validates the command line. The result is frozen: what the run decides later
 * (e.g. the working branch) lives in the session, not here.
 * @throws {PreflightError} for invalid combinations or values
 */
export function parseOptions(argv: string[]): Readonly<Options> {
  const { values } = parseArgs({ args: argv, options: OPTIONS, strict: true });
  const list = (items: string[]) => new Set(items.flatMap((i) => i.split(',')).map((i) => i.trim()).filter(Boolean));

  if (!TARGETS.includes(values.target as Target)) {
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

  return Object.freeze({
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
    gitHost: values['git-host'] as Options['gitHost'],
    target: values.target as Target,
    only: list(values.only),
    exclude: list(values.exclude),
    testCmd: values['test-cmd'],
    testTimeoutSec,
    skipOverrides: values['skip-overrides'],
    report: values.report,
    dryRun: values['dry-run'],
    verbose: values.verbose,
    auto: values.auto,
    yes: values.yes,
  });
}
