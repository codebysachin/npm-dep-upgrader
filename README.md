# npm-dep-upgrader

Upgrades outdated npm dependencies **one at a time**, runs the test suite after
every upgrade, and keeps an upgrade only if the tests pass. It then removes
`overrides` from `package.json` that are no longer needed. At the end it prints a
Markdown summary you can paste into your merge request.

It uses **only Node.js built-in modules**, with no third-party dependencies to audit or keep patched.

## Requirements

- Node.js >= 18.11 and npm
- git, with the project on `main` and in sync with `origin/main`
- A `test` script in `package.json` (or pass `--test-cmd`)

## Usage

```bash
cd /path/to/your-project
node /path/to/npm-dep-upgrader/upgrade-deps.mjs
```

Preview without changing anything:

```bash
node upgrade-deps.mjs --dry-run
```

Common options (see `--help` for all of them):

| Option | Purpose |
| --- | --- |
| `--target latest\|minor\|patch` | `minor` stays within the current major, `patch` within the current minor |
| `--exclude a,b` / `--only a,b` | Leave out packages, or upgrade only the ones listed |
| `--test-cmd "npm run test:ci"` | Use a different test command |
| `--branch <name>` | Name of the working branch (default `chore/deps-upgrade-<date>`) |
| `--no-commit` | Leave the changes uncommitted |
| `--no-squash` | Keep one commit per change instead of squashing at the end |
| `--skip-overrides` | Don't check overrides |
| `--report mr.md` | Also write the summary to a file |

## What a run does

1. **Pre-flight.** Checks that the project is a git repository, you are on `main`, no tracked
   files are modified, and local `main` matches `origin/main`. If any of these fails, it
   shows a red banner that lists every problem with the commands that fix it, and exits
   with code 1.
2. **Baseline.** Runs `npm ci` and then the tests. If tests already fail on `main`, it stops,
   because upgrades can't be verified against a failing suite.
3. **Creates** the working branch.
4. **Upgrades** each outdated direct dependency in turn:
   - Runs `npm install <pkg>@<version>`. The original range prefix is kept
     (`^`, `~`, `>=` or an exact version), and so is the section
     (`dependencies`, `devDependencies` or `optionalDependencies`).
   - Runs the tests.
   - If the tests pass, it commits `chore(deps): bump <pkg> from X to Y`.
   - If the install or tests fail, it restores `package.json` and the lockfile,
     re-syncs `node_modules`, and records the package as needing attention.
5. **Overrides.** Removes each override in turn and keeps the removal only if all of these hold:
   - `npm install` still succeeds,
   - every installed copy of the package is at least the version the override forced,
   - `npm audit` does not start flagging that package,
   - the tests pass.

   Otherwise the override is restored and the summary says why it stays.
6. **Summary.** Prints the MR summary and saves it to the log folder. If nothing changed, it
   deletes the empty branch.
7. **Squash.** If the run finishes successfully, it squashes all of its commits into a single
   commit titled like `chore(deps): upgrade 4 packages and remove 1 obsolete override`, with
   the full summary as the commit message body. GitHub and GitLab prefill a new MR's
   description from a single commit's message, so the summary appears in the MR. If the run
   stops part-way (an error or Ctrl+C), the per-package commits are left as they are. If a
   commit hook rejects the squash commit, the original commits are restored.

Full command output for every step goes to `$TMPDIR/npm-dep-upgrader/<timestamp>/`. The
project's working tree is never used for logs.

Press Ctrl+C at any time. The change in progress is rolled back, then run
`npm install` to re-sync `node_modules`.

## Limitations

- Supports npm only, not yarn `resolutions` or pnpm overrides, and only the root package of a
  workspace.
- Specs that aren't simple ranges (`git:`, `file:`, `npm:` aliases, `1.x`, `^1 || ^2`) are
  skipped and listed in the summary.
- Overrides that reference a dependency (`"$react"`) or use complex ranges are reported for
  manual review.
- The override check is deliberately conservative: an override counts as obsolete only if
  *every* installed copy of the package satisfies it. Overrides meant to *downgrade* a
  package are caught by the tests, not by the version check.

## Development

```bash
npm test   # node:test unit tests for the pure modules
```

| Module | Responsibility |
| --- | --- |
| `lib/cli.mjs` | Option parsing and the order of steps in a run |
| `lib/git.mjs` | Main-branch pre-flight, branch creation, commits |
| `lib/npm.mjs` | Wrappers around the npm CLI |
| `lib/plan.mjs` | Turns `npm outdated` output into an upgrade plan (pure) |
| `lib/overrides.mjs` | Reads and edits `overrides` (pure) |
| `lib/workflow.mjs` | Applies a change, tests it, then commits or rolls back |
| `lib/semver.mjs` | Minimal semver helpers (pure) |
| `lib/report.mjs` | Builds the Markdown MR summary (pure) |
