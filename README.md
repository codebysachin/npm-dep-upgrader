# npm-dep-upgrader

Upgrades outdated npm dependencies **one at a time**, runs the test suite after
every upgrade, and keeps an upgrade only if the tests pass. It then removes
`overrides` from `package.json` that are no longer needed. Nothing is committed while it
works. At the end it shows what changed and asks whether to commit, using a Markdown
summary of the successful upgrades as the commit message, ready for your merge request.

It uses **only Node.js built-in modules**, with no third-party dependencies to audit or keep patched.

## Requirements

- Node.js >= 18.11 and npm
- git. The script can start on `main` or on any other branch (see
  [Running on another branch](#running-on-another-branch)).
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

### Running on another branch

If you start the script on a branch other than `main`, it doesn't stop. It first reports on
that branch: how far it is from `main`, what is outdated, and which overrides would be
re-checked. Then it asks where the upgrade should happen:

```
▶ You are on "feature/login", not "main": checking its dependencies first
  feature/login is 1 commit(s) ahead of and 0 behind origin/main.
▶ Dependency report for feature/login
Outdated, can be upgraded (1):
  ms     2.0.0 → 2.1.3  (minor, dependencies)

  1) Create a new branch from main and upgrade there (recommended: separate MR)
  2) Upgrade on feature/login (the changes become part of this branch and its MR)
  3) Stop here; the report above is all I need
  Where should the upgrade happen? [1-3, Enter = 1]
```

- **1. New branch from `main`:** switches to `main` (your branch is left as it is) and carries
  on exactly as if you had started on `main`. This needs a clean working tree, so it isn't
  offered while the branch has uncommitted changes. Commit or stash them first.
- **2. This branch:** upgrades on the current branch, and the final commit lands on it. The
  branch must not be behind or diverged from its remote branch. If it is only behind, the
  script offers a fast-forward pull. `package.json` and the lockfile must have no uncommitted
  edits. Other uncommitted files are fine and are never committed.
- **3. Stop:** nothing is changed.

Without a terminal (or with `--yes`), the script only prints the report unless you say what
to do: `--from-main` for option 1, or `--on-current-branch` for option 2. `--dry-run` on a
branch prints the report and stops.

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
  order you type them. `all` picks everything, `none` picks nothing, and `q` quits (see
  [Quitting](#quitting)).
- When those are done, it checks again and offers any packages that are still outdated.
  Pick more, or press **Enter** to finish.
- A package whose upgrade failed stays in that list, at the end, marked `[tried, failed]`
  with the reason underneath. You can pick it again, for example after upgrading a
  package it depends on, or after fixing the code that broke. Packages that upgraded
  successfully are not offered again.
- It then asks which overrides to check in the same way.
- Packages that can't be upgraded one at a time are handled together. See
  [Packages that depend on each other](#packages-that-depend-on-each-other).
- Packages and overrides you skipped are listed in the terminal at the end, not in the MR summary.

### Packages that depend on each other

Some packages can only be upgraded together, because their `peerDependencies` don't allow a
mix of old and new versions. Upgrading one of them alone fails with `ERESOLVE`. Before each
list is shown, the script reads the `peerDependencies` of the current and the new version of
every outdated package. The current version comes from `node_modules` and the new one from
your registry. Two cases come up:

- **They need each other.** Example: `@typescript-eslint/eslint-plugin` 8 needs
  `@typescript-eslint/parser` 8, and plugin 7 rejects parser 8. They are shown as one entry
  marked `[linked]`, with the reasons underneath. They are written to `package.json` together,
  installed with a single `npm install`, tested once, and kept or rolled back together. Typing
  either package's name selects the whole entry.
- **One needs the other.** Example: `eslint` 10 is rejected by `@typescript-eslint` 7, but
  `@typescript-eslint` 8 still accepts `eslint` 8. `eslint` is listed with
  `needs @typescript-eslint/... too`, and it comes after the packages it needs.
  - If you pick it after them (or with `all`), it is upgraded on its own once they are done.
  - If you pick it without them, they are added to the same step.
  - You can always upgrade `@typescript-eslint` without `eslint`.

```
  1) 2 packages, upgraded together  [linked]
         @typescript-eslint/eslint-plugin 7.18.0 → 8.72.2  (major, devDependencies)
         @typescript-eslint/parser        7.18.0 → 8.72.2  (major, devDependencies)
         ↳ @typescript-eslint/eslint-plugin@8.72.2 needs @typescript-eslint/parser ^8.72.2
         ↳ @typescript-eslint/eslint-plugin@7.18.0 only accepts @typescript-eslint/parser ^7.0.0
  2) eslint                           8.57.1 → 10.14.0  (major, devDependencies)
       ↳ needs @typescript-eslint/eslint-plugin + @typescript-eslint/parser too; it is added to the same step unless upgraded first
           @typescript-eslint/eslint-plugin@7.18.0 only accepts eslint ^8.56.0
```

`--dry-run` shows the same links. Only packages that are outdated are linked. If you
narrow the run with `--only`, list the related packages too (e.g.
`--only @typescript-eslint/parser,@typescript-eslint/eslint-plugin`).

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
| `--replace-branch` | If that branch already exists, delete it locally and on the remote without asking (⚠ irreversible). Refuses if an MR is open from it, or if that can't be checked |
| `--git-host github\|gitlab` | Say which host the remote is, when the URL doesn't make it obvious (e.g. self-hosted GitLab) |
| `--no-commit` | Never commit and don't ask; leave the changes uncommitted |
| `--from-main` / `--on-current-branch` | When started on another branch without a terminal: upgrade on a new branch from `main`, or on the current branch |
| `--skip-overrides` | Don't check overrides |
| `--report mr.md` | Also write the summary to a file |
| `-v`, `--verbose` | Print each command's output on screen, not only a link to its log file. See [Commands on screen](#commands-on-screen) |

## What a run does

1. **Pre-flight.** If you are on another branch, it reports on it first and asks where to
   upgrade (see [Running on another branch](#running-on-another-branch)). For an upgrade from
   `main`, it checks that the project is a git repository, you are on `main`, no tracked files
   are modified, and local `main` matches `origin/main`. It runs `git fetch` to compare with
   the remote, which never changes your files.
   - If the only problem is that a clean `main` is **behind** the remote, it lists the new
     commits and asks `Pull them now (git pull --ff-only origin main)? [y/N]`. A fast-forward
     pull can't conflict or lose work. `--yes` pulls without asking.
   - Anything else (uncommitted changes, another branch checked out, or local commits not on
     the remote) needs your judgement, so it is never fixed automatically. It shows a red
     banner listing every problem with the commands that fix it, and exits with code 1.
2. **Baseline.** Installs dependencies, asks which packages to upgrade, then runs the tests.
   - With a lockfile it runs `npm ci`, so the baseline is exactly what is committed on `main`.
     A lockfile that is merely older than the latest versions is fine; that is what the
     upgrade fixes.
   - If `package.json` was changed without updating the lockfile, `npm ci` refuses. The script
     then stops and explains how to sync the lockfile on `main` first, rather than mixing
     that repair into the upgrade MR.
   - Without a lockfile it runs `npm install`, which creates `package-lock.json`; that file
     becomes part of the MR unless it is gitignored.
   - If tests already fail on `main`, it stops, because upgrades can't be verified against a
     failing suite.
3. **Creates** the working branch. Whether the name is free is checked at the start, right
   after the `main` checks, so a clash never shows up after a long install or test run.
   - **Name is free:** the branch is created from `main`.
   - **Exists locally with no commits beyond `main`** (for example, left by an earlier run
     that wasn't committed): it is reused. Resetting it to `main` loses nothing.
   - **Has its own commits, or exists on the remote** (perhaps with an open MR): it lists
     those commits and asks:
     ```
     1) Use a new branch: chore/deps-upgrade-2026-11-10-2  (the existing branch is not touched)
     2) Delete chore/deps-upgrade-2026-11-10 locally and on origin and start it fresh from main
     3) Stop
     What should this run do? [1-3, Enter = 1]
     ```
     Option 2 asks once more before deleting anything, since it removes those commits. With
     `--yes`, or without a terminal, it takes option 1; it deletes only with `--replace-branch`.
   - **Open MR check.** If the branch exists on the remote, the script first asks the git host
     whether an MR (GitLab) or pull request (GitHub) is open from it:

     | Result | Interactive run | `--replace-branch` |
     | --- | --- | --- |
     | MR open | The MR is shown and **deleting is not offered**; only a new name or stop | Refuses and shows the MR |
     | No MR open | All three options | Deletes |
     | Couldn't check | Warns, and the delete confirmation reminds you to check yourself | Refuses |

     The host is worked out from the remote URL: `github.com` means GitHub, and a host with
     "gitlab" in its name (or matching `GITLAB_HOST`) means GitLab. Use `--git-host` for
     anything else. The check uses the `gh` or `glab` CLI if it is installed and logged in.
     Otherwise it calls the host's API with `GITHUB_TOKEN` / `GH_TOKEN` or `GITLAB_TOKEN` /
     `GITLAB_PRIVATE_TOKEN` (read-only access is enough). The token is sent only to the host
     of your own git remote.
4. **Upgrades** each selected dependency in turn, then offers any that are still outdated.
   Linked packages count as one step (see
   [Packages that depend on each other](#packages-that-depend-on-each-other)).
   - Runs `npm install <pkg>@<version>`. For linked packages it writes the new versions to
     `package.json` and runs `npm install` once. The original range prefix is kept
     (`^`, `~`, `>=` or an exact version), and so is the section
     (`dependencies`, `devDependencies` or `optionalDependencies`).
   - Runs the tests.
   - If the tests pass, the change stays in the working tree (uncommitted) and the next
     upgrade builds on it.
   - If the install or tests fail, it restores `package.json` and the lockfile to how they
     were before this step, and re-syncs `node_modules`.
     The package is offered again in the next round, marked as tried.
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
| `commands.log` | Commands that don't belong to a step (mostly git checks), with their output |
| `mr-summary.md` | The Markdown summary for the MR |
| `commit-message.txt` | Commit title plus the summary, for `git commit -F` if you commit yourself |

```
11:08:42  ✔  PASS  baseline install                          001-baseline-install.log
11:08:43  ✔  PASS  baseline tests                            003-baseline-tests.log
11:08:44  ✖  FAIL  upgrade chalk 4.1.2 → 6.0.1 (tests failed) 004-upgrade-chalk.log
11:08:45  ✔  PASS  upgrade ms 2.0.0 → 2.1.3                  005-upgrade-ms.log
```

### Commands on screen

Every command the script runs is shown under the step that ran it. While a command runs, a
`⋯ $ <command>` line shows what it is waiting for. When the command finishes, that line is
replaced by the result. The output stays folded away by default:

```
▶ [1/1] ms  2.0.0 → 2.1.3  (minor)
    ✔ $ npm install ms@~2.1.3 --save-prod --no-audit --no-fund  · 0.2s  ▸ output (1 line): 008-upgrade-ms.log
    ✔ $ npm test  · 0.1s  ▸ output (3 lines): 008-upgrade-ms.log
  ✔ tests passed (0.1s)
```

- `✔` means exit code 0. `· exit 1` is shown neutrally, because some commands exit non-zero
  normally (`npm outdated` does whenever something is outdated). Real failures get their own
  `✖` message from the step.
- `▸ output (…): <file>` is a link to the log file that holds the full output. Terminals with
  hyperlink support can open it with a click (usually Cmd/Ctrl+click), for example iTerm2,
  VS Code, Windows Terminal and GNOME Terminal. Other terminals print the file name, which is
  in the logs folder.
- `--verbose` (`-v`) unfolds it: each command's output is printed under it, prefixed with `│`.

## Quitting

At **every question** the script asks (which packages, which overrides, where to upgrade,
whether to pull, what to do about an existing branch, whether to commit), you can type `q`
(or `quit`) to stop. Lists of choices also show a `q) Quit` line.

What happens when you quit:
- **Upgrades already done are kept**, uncommitted, in the working tree. Each one passed the
  tests. The script lists them and prints the commands to review (`git diff`), commit (with
  a ready-made commit message for what was done so far) or discard them.
- **If nothing was changed yet**, it says so. If it had already created the working branch,
  it removes that empty branch and switches back to `main`.
- The exit code is 0, because quitting is a normal choice and not an error.

While npm or the tests are running there is no question on screen, so use **Ctrl+C** to stop.
The change in progress is rolled back; then run `npm install` to re-sync `node_modules`.

## Limitations

- Supports npm only, not yarn `resolutions` or pnpm overrides, and only the root package of a
  workspace.
- Specs that aren't simple ranges (`git:`, `file:`, `npm:` aliases, `1.x`, `^1 || ^2`) are
  skipped and listed in the terminal at the end of the run.
- Linking only uses `peerDependencies`. Packages that break each other in other ways
  (e.g. a plugin that expects a newer core but doesn't declare it) show up as a test or
  install failure. Pick them together in the next round, e.g. `a b`. They will still be
  two steps, so put the one that is needed first.
- Overrides that reference a dependency (`"$react"`) or use complex ranges are reported for
  manual review.
- The override check is deliberately conservative: an override counts as obsolete only if
  *every* installed copy of the package satisfies it. Overrides meant to *downgrade* a
  package are caught by the tests, not by the version check.

## Development

```bash
npm test            # everything (about 20 seconds)
npm run test:unit   # pure modules only, instant
npm run test:e2e    # the real CLI against throwaway projects
```

### Tests

- **Unit tests** (`test/*.test.mjs`) cover the pure modules: the plan, linking, the upgrade-rounds
  loop, selection, semver, overrides, the report, test-output parsing and command display.
- **End-to-end tests** (`test/e2e/`) run `upgrade-deps.mjs` against a throwaway git project with a
  local bare remote, in a temp folder, with your git config isolated. `npm` there is
  `test/e2e/support/fake-npm.mjs`, an offline stand-in that resolves versions from a JSON registry
  defined in each test and enforces `peerDependencies`. Nothing touches the network or a real
  registry.
- Interactive runs are scripted with `NPM_DEP_UPGRADER_ANSWERS`, a JSON array of answers used one
  per question, e.g. `'["alpha", "", "y"]'`. If the answers run out, the run fails instead of
  waiting for input.

To add a scenario, copy a test in `test/e2e/upgrade.test.mjs`. `createProject` takes the
`package.json`, the fake registry and extra files (usually `check.js`, which fails the tests
under a condition you choose).

### Tooling

- **CI:** `.github/workflows/test.yml` runs `npm test` on Node 18, 20, 22 and 24 for pushes to
  `main` and for every PR.
- **Types:** `jsconfig.json` makes VS Code type-check `lib/` against the JSDoc types. Node's own
  types come from VS Code's automatic type acquisition, so nothing is added to the project.
- **Formatting:** `.editorconfig`: 2 spaces, LF, UTF-8, final newline.

### Modules

A run goes through these phases, each in its own module:

```
cli.mjs ─ options ─ session ─ branch-setup ─ rounds (first pick) ─ baseline tests
        ─ rounds (upgrade loop) ─ rounds (overrides) ─ finish
```

| Module | Responsibility |
| --- | --- |
| `lib/cli.mjs` | Runs the phases in order and turns errors into exit codes |
| `lib/options.mjs` | Option definitions, `--help` text and validation. The parsed options are frozen |
| `lib/session.mjs` | What a run shares between phases: options, context, whether it can ask questions (`prompts`), the workspace and the results |
| `lib/branch-setup.mjs` | Which branch the run works on, that it is up to date, branch-name clashes, the baseline install |
| `lib/rounds.mjs` | Lists outdated packages, lets the user pick, runs the upgrade rounds (`runRounds` is unit-tested) and the overrides review |
| `lib/finish.mjs` | Summary, MR text, showing the changes, the commit, and what to print when quitting |
| `lib/workflow.mjs` | Applies a change, tests it, then keeps it or rolls it back |
| `lib/plan.mjs` | Turns `npm outdated` output into an upgrade plan and groups linked packages (pure) |
| `lib/git.mjs` | Git checks and operations: branch status, creation, deletion, change review, the commit |
| `lib/npm.mjs` | Wrappers around the npm CLI |
| `lib/exec.mjs` | Runs commands and records them in the logs |
| `lib/command-echo.mjs` | Shows each command and its result on screen (folded, or full with `--verbose`) |
| `lib/runtime.mjs` | The few process-wide settings (command log, echo, verbose), set once by the CLI |
| `lib/overrides.mjs` | Reads and edits `overrides` (pure) |
| `lib/semver.mjs` | Minimal semver helpers, including npm range matching (pure) |
| `lib/report.mjs` | Builds the Markdown MR summary (pure) |
| `lib/selection.mjs` | Parses what the user types when picking from a list (pure) |
| `lib/prompt.mjs` | Interactive terminal prompts (`node:readline`), or scripted answers |
| `lib/test-output.mjs` | Finds failing files, tests, errors and locations in test output (pure) |
| `lib/failure-report.mjs` | Formats failures for the terminal and log files (pure) |
| `lib/logfile.mjs` | Layout of `run.log` and the per-step log files |
| `lib/merge-requests.mjs` | Finds open GitHub PRs / GitLab MRs from a branch (`gh`/`glab`, or the REST API with a token) |
| `lib/errors.mjs` | Error types and exit codes |
| `lib/logger.mjs` | Coloured terminal output and the flashing banner |
