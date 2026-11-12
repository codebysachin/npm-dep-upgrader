/**
 * The stateful steps of a run: each change is applied, verified with tests and
 * either kept in the working tree or rolled back before the next one starts.
 */
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  npmFailureReason,
  renderTestFailure,
  summarizeNpmError,
  testFailureReason,
} from './failure-report.ts';
import {
  appendLogSection,
  appendRunIndex,
  formatErrorEntry,
  writeErrorLogHeader,
  writeRunIndexHeader,
  writeStepLogHeader,
} from './logfile.ts';
import { RecordedError } from './errors.ts';
import { color, log } from './logger.ts';
import { readManifest, snapshotManifests, writeManifest } from './manifest.ts';
import {
  getInstalledVersions,
  getVulnerablePackages,
  installAll,
  installPackage,
  runTests,
} from './npm.ts';
import { describeOverride, removeOverride } from './overrides.ts';
import { compareVersions, minVersionFromSpec, parseVersion } from './semver.ts';
import { analyzeTestOutput } from './test-output.ts';
import type { Attempt } from './auto.ts';
import type { RunResult } from './exec.ts';
import type { ErrorEntry } from './logfile.ts';
import type { ManifestSnapshot } from './manifest.ts';
import type { OverrideLeaf } from './overrides.ts';
import type { PlannedUpgrade } from './plan.ts';
import type { Results } from './session.ts';
import type { TestFailureAnalysis } from './test-output.ts';

const CONSOLE_STYLE = { heading: color.bold, label: color.bold, dim: color.dim, bad: color.red };

/**
 * Shared state for one run.
 */
export class RunContext {
  cwd: string;
  testCommand: string;
  logDir: string;
  testTimeoutMs: number | undefined;
  logCounter: number;
  runIndex: string;
  /** errors.log: only what failed. Created at the first error, so no file means no errors. */
  errorLog: string;
  errorCount: number;
  activeSnapshot: ManifestSnapshot | null;

  constructor({ cwd, testCommand, logDir, testTimeoutMs }: { cwd: string; testCommand: string; logDir: string; testTimeoutMs?: number }) {
    this.cwd = cwd;
    this.testCommand = testCommand;
    this.logDir = logDir;
    this.testTimeoutMs = testTimeoutMs;
    this.logCounter = 0;
    this.runIndex = join(logDir, 'run.log');
    writeRunIndexHeader(this.runIndex, { cwd, testCommand });
    this.errorLog = join(logDir, 'errors.log');
    this.errorCount = 0;
    /** Snapshot of the change currently in progress; restored on Ctrl+C. */
    this.activeSnapshot = null;
  }

  /**
   * Creates the log file for a step.
   * @param label  short name used in the file name
   * @param step human-readable description written at the top of the file
   */
  nextLogFile(label: string, step: string = label): string {
    this.logCounter += 1;
    const safe = label.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const file = join(this.logDir, `${String(this.logCounter).padStart(3, '0')}-${safe}.log`);
    writeStepLogHeader(file, { step, cwd: this.cwd });
    return file;
  }

  /** Records the outcome of a step in run.log. `ok: null` marks an informational entry. */
  record(ok: boolean | null, step: string, logFile: string): void {
    appendRunIndex(this.runIndex, { ok, step, logFile });
  }

  /** Adds a failure to errors.log, creating the file the first time. */
  recordError(entry: ErrorEntry): void {
    if (!this.errorCount) writeErrorLogHeader(this.errorLog, { cwd: this.cwd, runIndex: this.runIndex });
    this.errorCount += 1;
    appendFileSync(this.errorLog, formatErrorEntry(this.errorCount, entry));
  }

  beginChange(): ManifestSnapshot {
    this.activeSnapshot = snapshotManifests(this.cwd);
    return this.activeSnapshot;
  }

  /** Restores manifests and node_modules to the state before the current change. */
  rollback(logFile: string): void {
    appendLogSection(logFile, 'ROLLBACK: restoring package.json and lockfile, then reinstalling', []);
    this.activeSnapshot?.restore();
    this.activeSnapshot = null;
    const reinstall = installAll(this.cwd, logFile);
    if (!reinstall.ok) {
      const npmError = summarizeNpmError(reinstall);
      this.recordError({
        step: 'roll back the change',
        reason: `${npmFailureReason(npmError)} after restoring package.json and the lockfile`,
        outcome: 'run stopped; node_modules may not match package.json until "npm install" succeeds',
        logFile,
        details: npmError.lines,
        command: reinstall,
      });
      throw new RecordedError(`Rollback failed: "npm install" errored after restoring package files. See ${logFile}`);
    }
  }

  /** Keeps the current change in the working tree; it is committed (if the user agrees) at the end of the run. */
  acceptChange(): void {
    this.activeSnapshot = null;
  }

  /**
   * Runs the test command. On failure, explains which tests failed and why,
   * both in the terminal and at the end of the step's log file.
   */
  verifyTests(logFile: string): { ok: boolean; analysis: TestFailureAnalysis | null; result: RunResult; timedOut: boolean } {
    const result = runTests(this.cwd, this.testCommand, logFile, this.testTimeoutMs);
    const seconds = (result.durationMs / 1000).toFixed(1);

    if (result.ok) {
      log.success(`tests passed (${seconds}s)`);
      return { ok: true, analysis: null, result, timedOut: false };
    }

    const timedOut = Boolean(result.signal === 'SIGTERM' && this.testTimeoutMs);
    const analysis = analyzeTestOutput(`${result.stdout}\n${result.stderr}`, this.cwd);
    log.error(timedOut ? `tests timed out after ${seconds}s` : `tests failed (${seconds}s)`);
    const recognised = analysis.files.length || analysis.tests.length || analysis.errors.length;
    printBlock(renderTestFailure(analysis, { style: CONSOLE_STYLE, includeExcerpt: !recognised }), logFile);
    appendLogSection(logFile, 'FAILURE ANALYSIS', renderTestFailure(analysis, { includeExcerpt: false }));
    return { ok: false, analysis, result, timedOut };
  }
}

export interface UpgradeItem extends PlannedUpgrade {
  reason?: string;
  attempts?: Attempt[];
  tried?: Attempt[];
  instead?: string;
}

export interface UpgradeOutcome {
  ok: boolean;
  /** on failure each item carries `reason` */
  items: UpgradeItem[];
  /**
   * what failed: npm's error code and lines for an install, so a caller can look for
   * the packages npm names (see --auto)
   */
  failure?: { kind: 'install' | 'tests'; code?: string | null; lines?: string[] };
}

/**
 * Upgrades one package, or several that must move together, and keeps the change only if
 * install and tests succeed. Several packages are written to package.json first and then
 * installed with one `npm install`, so npm never sees half of the change.
 */
export function upgradePackages(ctx: RunContext, items: PlannedUpgrade[]): UpgradeOutcome {
  const together = items.length > 1;
  const changes = items.map((i) => `${i.name} ${i.from} → ${i.to}`).join(', ');
  const step = `upgrade ${changes}${together ? ' (together)' : ''}`;
  const logFile = ctx.nextLogFile(`upgrade-${items.map((i) => i.name).join('+')}`, step);
  ctx.beginChange();

  const fail = (
    what: string,
    reason: string,
    failure: UpgradeOutcome['failure'],
    error: Pick<ErrorEntry, 'details' | 'command'>,
  ): UpgradeOutcome => {
    const back = items.map((i) => `${i.name} to ${i.from}`).join(', ');
    ctx.recordError({ step, reason, outcome: `rolling back ${back}`, logFile, ...error });
    ctx.rollback(logFile);
    log.warn(`rolled back ${back}`);
    ctx.record(false, `${step} (${what})`, logFile);
    return { ok: false, items: items.map((i) => ({ ...i, reason })), failure };
  };

  const install = together ? installTogether(ctx.cwd, items, logFile) : installPackage(ctx.cwd, items[0], logFile);
  if (!install.ok) {
    const npmError = summarizeNpmError(install);
    log.error(npmFailureReason(npmError));
    printBlock(npmError.lines.map(color.dim), logFile);
    appendLogSection(logFile, 'FAILURE ANALYSIS', npmError.lines);
    return fail('install failed', npmFailureReason(npmError), { kind: 'install', ...npmError }, { details: npmError.lines, command: install });
  }

  const tests = ctx.verifyTests(logFile);
  if (!tests.ok) {
    const prefix = together ? 'tests fail when upgraded together' : `tests fail with ${items[0].to}`;
    const reason = testFailureReason(tests.analysis, tests.timedOut ? `${prefix} (timed out)` : prefix);
    return fail('tests failed', reason, { kind: 'tests' }, { details: renderTestFailure(tests.analysis, { includeExcerpt: false }), command: tests.result });
  }

  ctx.acceptChange();
  ctx.record(true, step, logFile);
  return { ok: true, items };
}

/** Writes every new spec to package.json, then lets one `npm install` resolve them all at once. */
function installTogether(cwd: string, items: PlannedUpgrade[], logFile: string) {
  const manifest = readManifest(cwd);
  for (const item of items) manifest[item.section][item.name] = item.spec;
  writeManifest(cwd, manifest);
  appendLogSection(logFile, 'PACKAGE.JSON CHANGES', items.map((i) => `${i.section}.${i.name}: ${i.spec}`));
  return installAll(cwd, logFile);
}

/**
 * Tries to remove each override in turn. An override is considered obsolete when,
 * without it:
 *   1. npm install succeeds,
 *   2. every installed copy of the package is at least the version the override forced,
 *   3. npm audit doesn't start reporting the package as vulnerable, and
 *   4. tests pass.
 * @param leaves  the overrides to check, in order
 */
export function pruneOverrides(
  ctx: RunContext,
  leaves: OverrideLeaf[],
): { removed: Results['overridesRemoved']; kept: Results['overridesKept'] } {
  const removed: Results['overridesRemoved'] = [];
  const kept: Results['overridesKept'] = [];

  if (!leaves.length) {
    log.info('No overrides to check.');
    return { removed, kept };
  }

  log.info(`Checking ${leaves.length} override(s). Running npm audit baseline ...`);
  const vulnerableBefore = getVulnerablePackages(ctx.cwd, ctx.nextLogFile('audit-baseline', 'npm audit before removing overrides'));
  if (!vulnerableBefore) log.warn('npm audit unavailable; relying on version checks and tests only.');

  for (const [index, leaf] of leaves.entries()) {
    log.step(`[${index + 1}/${leaves.length}] override ${describeOverride(leaf)}`);
    const outcome = evaluateOverride(ctx, leaf, vulnerableBefore);
    if (outcome.removed) {
      log.success(`removed — without it: ${outcome.resolved}`);
      removed.push({ ...leaf, resolved: outcome.resolved });
    } else {
      log.warn(`kept — ${outcome.reason}`);
      kept.push({ ...leaf, reason: outcome.reason });
    }
    ctx.record(outcome.removed, `override ${describeOverride(leaf)} ${outcome.removed ? 'removed' : 'kept'}`, outcome.logFile);
  }
  return { removed, kept };
}

function evaluateOverride(
  ctx: RunContext,
  leaf: OverrideLeaf,
  vulnerableBefore: Set<string> | null,
): { removed: boolean; reason?: string; resolved?: string; logFile?: string } {
  if (leaf.spec.startsWith('$')) {
    return { removed: false, reason: `references a direct dependency (${leaf.spec}); review manually` };
  }
  const minVersion = minVersionFromSpec(leaf.spec);
  if (!minVersion) return { removed: false, reason: 'spec is too complex to evaluate automatically; review manually' };

  const logFile = ctx.nextLogFile(`override-${leaf.keyPath.join('_')}`, `check override ${describeOverride(leaf)}`);
  ctx.beginChange();
  writeManifest(ctx.cwd, removeOverride(readManifest(ctx.cwd), leaf.keyPath));

  const keep = (reason: string) => {
    ctx.rollback(logFile);
    return { removed: false, reason, logFile };
  };

  const install = installAll(ctx.cwd, logFile);
  if (!install.ok) return keep(npmFailureReason(summarizeNpmError(install)).replace('npm install failed', 'npm install fails without it'));

  const installed = getInstalledVersions(ctx.cwd, leaf.name, logFile);
  const tooOld = installed.filter((v) => parseVersion(v) && compareVersions(v, minVersion) < 0);
  if (tooOld.length) return keep(`without it npm resolves ${leaf.name}@${tooOld.join(', ')} (< ${minVersion})`);

  if (vulnerableBefore) {
    const vulnerableAfter = getVulnerablePackages(ctx.cwd, logFile);
    if (vulnerableAfter?.has(leaf.name) && !vulnerableBefore.has(leaf.name)) {
      return keep(`npm audit reports ${leaf.name} as vulnerable without it`);
    }
  }

  const tests = ctx.verifyTests(logFile);
  if (!tests.ok) return keep(testFailureReason(tests.analysis, 'tests fail without it'));

  const resolved = installed.length ? `${leaf.name}@${installed.join(', ')}` : 'package no longer in dependency tree';
  ctx.acceptChange();
  return { removed: true, resolved, logFile };
}

/** Prints lines in an indented, bar-marked block, ending with the path of the full log. */
function printBlock(lines: string[], logFile: string): void {
  const bar = color.red('│');
  for (const line of lines) log.plain(`    ${bar} ${line}`);
  log.plain(`    ${bar} ${color.dim(`Full log: ${logFile}`)}`);
}
