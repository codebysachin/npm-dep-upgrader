# npm-dep-upgrader

Upgrades outdated npm dependencies **one at a time**, runs the test suite after
every upgrade, and keeps an upgrade only if the tests pass. It then removes
`overrides` from `package.json` that are no longer needed. Nothing is committed while it
works. At the end it shows what changed and asks whether to commit, using a Markdown
summary of the successful upgrades as the commit message, ready for your merge request.

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

### Choosing what to upgrade

In a terminal, the script lists the outdated packages and asks which ones to upgrade.
Packages you don't pick are not touched, which is useful when some upgrades are being
handled on other branches.

```
5 outdated package(s):
  1) chalk      4.1.2 → 6.0.1    (major, dependencies)
  2) lodash     4.17.20 → 4.18.1 (minor, dependencies)
  ...
  Which packages should be upgraded? 4,2
```

- Type numbers, ranges or names, e.g. `3,1,5-7` or `lodash ms`. They are upgraded in the
  order you type them. `all` picks everything, `none` picks nothing.
- When those are done, it checks again and offers any packages that are still outdated.
  Pick more, or press **Enter** to finish.
- It then asks which overrides to check in the same way.
- Packages and overrides you skipped are listed in the terminal at the end, not in the MR summary.

Use `--yes` (or `-y`) to skip all questions: everything is upgraded and the result is
committed. Without a terminal (e.g. in CI) everything is upgraded too, but nothing is
committed unless `--yes` is given. Passing `--only a,b` skips the package question, but
you are still asked before anything is committed.

### Reviewing and committing

```
▶ Changes made (not committed yet)
  M package-lock.json
  M package.json

  package.json
    @@ -7,9 +7,9 @@
    -    "lodash": "4.17.20",
    +    "lodash": "4.18.1",

  Are you happy to commit these changes? [y/N]
```

- **y** commits `package.json` and the lockfile in one commit. The commit message is the MR
  summary, so GitHub and GitLab fill in the MR description from it.
- **n** (or Enter) leaves everything uncommitted on the working branch, and prints the
  commands to review (`git diff`), commit (using the saved message) or discard the changes.

Common options (see `--help` for all of them):

| Option | Purpose |
| --- | --- |
| `-y`, `--yes` | Don't ask; upgrade every outdated package, check every override and commit |
| `--target latest\|minor\|patch` | `minor` stays within the current major, `patch` within the current minor |
| `--exclude a,b` / `--only a,b` | Leave out packages, or upgrade only the ones listed |
| `--test-cmd "npm run test:ci"` | Use a different test command |
| `--branch <name>` | Name of the working branch (default `chore/deps-upgrade-<date>`) |
| `--no-commit` | Never commit and don't ask; leave the changes uncommitted |
| `--skip-overrides` | Don't check overrides |
| `--report mr.md` | Also write the summary to a file |

## What a run does

1. **Pre-flight.** Checks that the project is a git repository, you are on `main`, no tracked
   files are modified, and local `main` matches `origin/main`. If any of these fails, it
   shows a red banner that lists every problem with the commands that fix it, and exits
   with code 1.
2. **Baseline.** Installs dependencies, asks which packages to upgrade, then runs the tests.
   With a lockfile it runs `npm ci`, so the baseline is exactly what is committed. Without
   one it runs `npm install`, which creates `package-lock.json`; that file becomes part of
   the MR unless it is gitignored. If tests
   already fail on `main`, it stops, because upgrades can't be verified against a failing suite.
3. **Creates** the working branch.
4. **Upgrades** each selected dependency in turn, then offers any that are still outdated:
   - Runs `npm install <pkg>@<version>`. The original range prefix is kept
     (`^`, `~`, `>=` or an exact version), and so is the section
     (`dependencies`, `devDependencies` or `optionalDependencies`).
   - Runs the tests.
   - If the tests pass, the change stays in the working tree (uncommitted) and the next
     upgrade builds on it.
   - If the install or tests fail, it restores `package.json` and the lockfile to how they
     were before this one upgrade, and re-syncs `node_modules`.
5. **Overrides.** Removes each selected override in turn and keeps the removal only if all of these hold:
   - `npm install` still succeeds,
   - every installed copy of the package is at least the version the override forced,
   - `npm audit` does not start flagging that package,
   - the tests pass.

   Otherwise the override is restored, and the terminal says why it stays.
6. **Summary.** Prints the MR summary and saves it to the log folder. The summary lists only
   the successful upgrades and removed overrides. What was not changed, and why, is printed
   separately in the terminal. If nothing changed, it deletes the empty branch.
7. **Review and commit.** Shows the changed files and the `package.json` diff, then asks
   whether to commit. The commit is titled like
   `chore(deps): upgrade 4 packages and remove 1 obsolete override`, and its body is the MR
   summary. If a commit hook rejects the commit, the changes are left uncommitted.

## When tests fail

The script reads the test output and explains the failure instead of dumping raw output.
It understands jest, vitest, mocha and `node:test` (spec and TAP reporters). For other
runners it still picks out error messages and the places in your code where they were thrown.

```
▶ [1/2] chalk  4.1.2 → 6.0.1  (major)
  ✖ tests failed (0.3s)
    │ Result
    │   ℹ fail 1
    │ Failing tests
    │   test/color.test.js
    │     • highlights errors in red
    │ Errors
    │   AssertionError [ERR_ASSERTION]: chalk.red should be a function
    │ Thrown at
    │   test/color.test.js:5:10
    │ Full log: …/004-upgrade-chalk.log
  ⚠ rolled back chalk to 4.1.2
```

For `npm install` failures, it shows npm's error code with a hint (for example
`ERESOLVE (peer dependency conflict)`) and npm's error lines. Failures stay out of the MR
summary; at the end of the run the terminal lists each package that was not upgraded, with
the failing test files.

## Logs

Each run writes its logs to `$TMPDIR/npm-dep-upgrader/<timestamp>/`, never to the project's
working tree. The folder is printed at the start and the end of the run.

| File | Contents |
| --- | --- |
| `run.log` | Start here. One line per step: time, PASS/FAIL, what was done, and the step's log file |
| `NNN-<step>.log` | One file per step: a header naming the step, then every command it ran (exit status, duration, stdout and stderr), a `FAILURE ANALYSIS` section if it failed, and a `ROLLBACK` section if the change was undone |
| `mr-summary.md` | The Markdown summary for the MR |
| `commit-message.txt` | Commit title plus the summary, for `git commit -F` if you commit yourself |

```
11:08:42  ✔  PASS  baseline install                          001-baseline-install.log
11:08:43  ✔  PASS  baseline tests                            003-baseline-tests.log
11:08:44  ✖  FAIL  upgrade chalk 4.1.2 → 6.0.1 (tests failed) 004-upgrade-chalk.log
11:08:45  ✔  PASS  upgrade ms 2.0.0 → 2.1.3                  005-upgrade-ms.log
```

Press Ctrl+C at any time. The change in progress is rolled back, then run
`npm install` to re-sync `node_modules`.

## Limitations

- Supports npm only, not yarn `resolutions` or pnpm overrides, and only the root package of a
  workspace.
- Specs that aren't simple ranges (`git:`, `file:`, `npm:` aliases, `1.x`, `^1 || ^2`) are
  skipped and listed in the terminal at the end of the run.
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
| `lib/git.mjs` | Main-branch pre-flight, branch creation, change review, the final commit |
| `lib/npm.mjs` | Wrappers around the npm CLI |
| `lib/plan.mjs` | Turns `npm outdated` output into an upgrade plan (pure) |
| `lib/overrides.mjs` | Reads and edits `overrides` (pure) |
| `lib/workflow.mjs` | Applies a change, tests it, then keeps it or rolls it back |
| `lib/semver.mjs` | Minimal semver helpers (pure) |
| `lib/report.mjs` | Builds the Markdown MR summary (pure) |
| `lib/selection.mjs` | Parses what the user types when picking from a list (pure) |
| `lib/prompt.mjs` | Interactive terminal prompts (`node:readline`) |
| `lib/test-output.mjs` | Finds failing files, tests, errors and locations in test output (pure) |
| `lib/failure-report.mjs` | Formats failures for the terminal and log files (pure) |
| `lib/logfile.mjs` | Layout of `run.log` and the per-step log files |
