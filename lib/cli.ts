/**
 * Command-line entry point: runs the phases of a run in order and turns errors into exit codes.
 *
 *   options → session → workspace (branch-setup) → first pick → baseline tests
 *   → upgrade rounds (rounds) → overrides → finish (summary, changes, commit)
 */
import { existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { prepareWorkspace } from './branch-setup.ts';
import { AbortError, CommandError, EXIT_CODES, PreflightError, QuitError, RecordedError, type PreflightIssue } from './errors.ts';
import { run } from './exec.ts';
import { renderTestFailure, testFailureReason } from './failure-report.ts';
import { finish, printErrorLogPointer, reportQuit } from './finish.ts';
import { createBranch } from './git.ts';
import { color, flashBanner, log } from './logger.ts';
import { readManifest } from './manifest.ts';
import { HELP, parseOptions, type Options } from './options.ts';
import { autoUpgrade, chooseFirstRound, reviewOverrides, upgradeRounds } from './rounds.ts';
import { configureRuntime } from './runtime.ts';
import { createSession, emptyResults, type Session } from './session.ts';
import { RunContext } from './workflow.ts';

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  let session: Session | undefined;
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
    configureRuntime({ commandLog: join(logDir, 'commands.log'), echoCommands: true, verbose: options.verbose });
    const ctx = new RunContext({ cwd, testCommand: options.testCmd, logDir, testTimeoutMs: options.testTimeoutSec * 1000 || undefined });
    session = createSession(options, ctx);

    log.plain(color.bold('npm dependency upgrader'));
    log.info(color.dim(`project: ${cwd}`));
    log.info(color.dim(`logs:    ${logDir}`));
    verifyProject(cwd, options);

    session.workspace = await prepareWorkspace(session);
    if (!session.workspace) return EXIT_CODES.OK;
    const { baseBranch, workBranch, created, reuse } = session.workspace;
    session.results = emptyResults();

    // Picking packages is skipped with --only: the command line already says which.
    const choosing = session.prompts && !options.auto && options.only.size === 0;
    const firstRound = await chooseFirstRound(session, { choosing });

    log.step('Running tests before changing anything (baseline)');
    const baselineLog = ctx.nextLogFile('baseline-tests', `run tests on ${baseBranch} before any change`);
    const baseline = ctx.verifyTests(baselineLog);
    ctx.record(baseline.ok, 'baseline tests', baselineLog);
    if (!baseline.ok) {
      ctx.recordError({
        step: `baseline tests (${baseBranch})`,
        reason: testFailureReason(baseline.analysis, baseline.timedOut ? 'tests time out before any change' : 'tests fail before any change'),
        outcome: `run stopped: fix the failing tests on ${baseBranch} first`,
        logFile: baselineLog,
        details: renderTestFailure(baseline.analysis, { includeExcerpt: false }),
        command: baseline.result,
      });
      await flashBanner(`Tests already fail on ${baseBranch}`, [
        'Upgrades cannot be verified while the baseline is red.',
        testFailureReason(baseline.analysis, 'Failing'),
        `Fix the failing tests on ${baseBranch} first, then run this script again.`,
        `Details: ${baselineLog}`,
      ]);
      printErrorLogPointer(ctx);
      return EXIT_CODES.BASELINE_TESTS_FAILED;
    }

    if (created) {
      createBranch(cwd, workBranch, { reset: reuse });
      log.success(`${reuse ? 'reset and checked out' : 'created'} branch ${workBranch}`);
    }

    if (options.auto) await autoUpgrade(session, firstRound);
    else await upgradeRounds(session, { ...firstRound, choosing });
    if (!options.skipOverrides) await reviewOverrides(session);
    await finish(session);
    printErrorLogPointer(ctx);
    return EXIT_CODES.OK;
  } catch (error) {
    return handleError(error, session);
  }
}

/** @throws {PreflightError} */
function verifyProject(cwd: string, options: Readonly<Options>): void {
  const issues: PreflightIssue[] = [];
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

async function handleError(error: any, session: Session | undefined): Promise<number> {
  const ctx = session?.ctx;
  if (error instanceof QuitError) {
    if (session) reportQuit(session);
    else log.warn('Quit.');
    printErrorLogPointer(ctx);
    return EXIT_CODES.OK;
  }

  if (error instanceof PreflightError) {
    ctx?.recordError({
      step: 'checks before starting',
      reason: error.message,
      outcome: 'run stopped before changing anything',
      details: error.issues.flatMap((issue, i) => [`${i + 1}. ${issue.problem}`, ...issue.fix.map((step) => `   fix: ${step}`)]),
    });
    const lines = error.issues.flatMap((issue, i) => [
      '',
      color.bold(`${i + 1}. ${issue.problem}`),
      '   How to fix:',
      ...issue.fix.map((step) => `     ${color.cyan('•')} ${step}`),
    ]);
    await flashBanner(`ACTION REQUIRED: ${error.message}`, [...lines, '', 'Then run this script again.']);
    printErrorLogPointer(ctx);
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

  if (error instanceof RecordedError) {
    log.error(error.message);
  } else {
    log.error(error?.stack ?? String(error));
    ctx?.recordError({
      step: 'run stopped by an unexpected error',
      reason: error?.message ?? String(error),
      details: String(error?.stack ?? '').split('\n').slice(1).map((line) => line.trim()),
      command: error instanceof CommandError ? error.result : undefined,
    });
  }
  printErrorLogPointer(ctx);
  if (ctx) log.info(`Logs: ${ctx.logDir} (start with ${ctx.errorCount ? 'errors.log' : 'run.log'})`);
  return EXIT_CODES.UNEXPECTED;
}
