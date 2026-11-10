/**
 * The end of a run: what was done, the MR summary, the changes, and the commit (with the
 * user's yes). Also what to print when the user quits part-way.
 */
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { run } from './exec.mjs';
import { commitFiles, describeChanges, getCurrentBranch } from './git.mjs';
import { color, log } from './logger.mjs';
import { presentManifestFiles } from './manifest.mjs';
import { describeOverride } from './overrides.mjs';
import { confirm } from './prompt.mjs';
import { buildCommitTitle, buildReport } from './report.mjs';

/**
 * Prints the result and the MR summary, shows the changes and commits them if the user agrees.
 * @param {import('./session.mjs').Session} session
 */
export async function finish(session) {
  const { ctx, options, workspace, results } = session;
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
    if (workspace.created) {
      // Nothing to propose: don't leave an empty branch behind.
      removeEmptyWorkBranch(session);
      log.info(`No changes were kept, so branch ${workspace.workBranch} was removed.`);
    }
    return;
  }

  const { report, commitMessage, reportFile, messageFile } = writeSummaryFiles(session);

  log.plain(`\n${color.bold('──────── MR summary (copy below this line) ────────')}\n`);
  log.plain(report);
  log.plain(color.bold('──────── end of MR summary ────────'));
  log.info(color.dim(`saved to ${reportFile}${options.report ? ` and ${resolve(options.report)}` : ''}`));

  printNotIncluded(results);

  const files = presentManifestFiles(ctx.cwd);
  printChanges(describeChanges(ctx.cwd, files, 'package.json'));

  const shouldCommit = await decideCommit(session);
  if (shouldCommit) {
    const commit = commitFiles(ctx.cwd, files, commitMessage);
    if (commit.ok) {
      log.success(`committed to ${workspace.workBranch}; the commit message is the MR summary`);
      if (workspace.workBranch !== options.mainBranch) {
        log.plain(`\nNext steps:\n  git push -u ${options.remote} ${workspace.workBranch}`);
        log.plain(
          workspace.created
            ? '  then open an MR — GitHub/GitLab prefill its description from the commit message.'
            : `  The commit becomes part of ${workspace.workBranch} and of its MR, if it has one.`,
        );
      }
      return;
    }
    log.warn(`commit failed: ${commit.error}`);
  }

  printUncommittedHelp(session, files, messageFile);
}

/** Writes mr-summary.md and commit-message.txt (and --report) for the changes kept so far. */
function writeSummaryFiles({ ctx, options, results }) {
  const report = buildReport(results);
  const commitMessage = `${buildCommitTitle(results)}\n\n${report}`;
  const reportFile = join(ctx.logDir, 'mr-summary.md');
  const messageFile = join(ctx.logDir, 'commit-message.txt');
  writeFileSync(reportFile, report);
  writeFileSync(messageFile, commitMessage);
  if (options.report) writeFileSync(resolve(options.report), report);
  return { report, commitMessage, reportFile, messageFile };
}

function printUncommittedHelp({ options, workspace }, files, messageFile) {
  const tracked = files.join(' ');
  log.plain(`\n${color.bold('The changes are not committed.')} They are in your working tree on ${workspace.workBranch}.`);
  log.plain(`  Review:   git diff`);
  log.plain(`  Commit:   git add ${tracked} && git commit -F ${messageFile}`);
  log.plain(
    `  Discard:  git checkout -- ${tracked}` +
      (workspace.created ? ` && git checkout ${options.mainBranch} && git branch -D ${workspace.workBranch}` : ''),
  );
}

/**
 * The user typed "q". Upgrades already kept stay in the working tree, uncommitted, with the
 * commands to commit or discard them. An empty branch the run created is removed.
 */
export function reportQuit(session) {
  const { ctx, workspace, results } = session;
  log.plain('');
  log.warn('Quit.');
  if (!ctx) return;

  // Prompts only appear between changes, but never leave a half-applied change behind.
  if (ctx.activeSnapshot) ctx.rollback(ctx.nextLogFile('quit-rollback', 'roll back the change in progress after quitting'));

  const kept = results ? [...results.upgraded.map((u) => `${u.name} ${u.from} → ${u.to}`),
    ...results.overridesRemoved.map((o) => `override ${describeOverride(o)} removed`)] : [];

  if (kept.length) {
    log.info(`Kept so far (all tests passed):`);
    for (const line of kept) log.info(`  • ${line}`);
    const { messageFile } = writeSummaryFiles(session);
    printUncommittedHelp(session, presentManifestFiles(ctx.cwd), messageFile);
    return;
  }

  if (workspace?.created && getCurrentBranch(ctx.cwd) === workspace.workBranch) {
    removeEmptyWorkBranch(session);
    log.info(`Removed the empty branch ${workspace.workBranch}; you are back on ${session.options.mainBranch}.`);
  }
  log.info('Nothing was changed.');
}

/** Commits only with the user's yes in a terminal, or with --yes. */
async function decideCommit({ options, prompts }) {
  if (options.noCommit) return false;
  if (prompts) return confirm('Are you happy to commit these changes?');
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
  for (const f of failed) log.warn(`${f.name} ${f.to}: ${f.reason}`);
  for (const s of skipped) log.info(color.dim(`${s.name}: ${s.reason}`));
  for (const o of overridesKept) log.info(color.dim(`override ${o.keyPath.join(' › ')}: kept, ${o.reason}`));
}

/** Leaves the branch this run created (which holds nothing worth keeping) and deletes it. */
function removeEmptyWorkBranch({ ctx, options, workspace }) {
  run('git', ['checkout', options.mainBranch], { cwd: ctx.cwd, allowFailure: true });
  run('git', ['branch', '-D', workspace.workBranch], { cwd: ctx.cwd, allowFailure: true });
}
