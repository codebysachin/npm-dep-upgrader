/**
 * The stateful steps of a run: each change is applied, verified with tests and
 * either kept in the working tree or rolled back before the next one starts.
 */
import { join } from 'node:path';
import {
  npmFailureReason,
  renderTestFailure,
  summarizeNpmError,
  testFailureReason,
} from './failure-report.mjs';
import { appendLogSection, appendRunIndex, writeRunIndexHeader, writeStepLogHeader } from './logfile.mjs';
import { color, log } from './logger.mjs';
import { readManifest, snapshotManifests, writeManifest } from './manifest.mjs';
import {
  getInstalledVersions,
  getVulnerablePackages,
  installAll,
  installPackage,
  runTests,
} from './npm.mjs';
import { describeOverride, removeOverride } from './overrides.mjs';
import { compareVersions, minVersionFromSpec, parseVersion } from './semver.mjs';
import { analyzeTestOutput } from './test-output.mjs';

const CONSOLE_STYLE = { heading: color.bold, label: color.bold, dim: color.dim, bad: color.red };

/**
 * Shared state for one run.
 */
export class RunContext {
  /**
   * @param {object} options
   * @param {string} options.cwd
   * @param {string} options.testCommand
   * @param {string} options.logDir
   * @param {number} [options.testTimeoutMs]
   */
  constructor({ cwd, testCommand, logDir, testTimeoutMs }) {
    this.cwd = cwd;
    this.testCommand = testCommand;
    this.logDir = logDir;
    this.testTimeoutMs = testTimeoutMs;
    this.logCounter = 0;
    this.runIndex = join(logDir, 'run.log');
    writeRunIndexHeader(this.runIndex, { cwd, testCommand });
    /** Snapshot of the change currently in progress; restored on Ctrl+C. */
    this.activeSnapshot = null;
  }

  /**
   * Creates the log file for a step.
   * @param {string} label  short name used in the file name
   * @param {string} [step] human-readable description written at the top of the file
   */
  nextLogFile(label, step = label) {
    this.logCounter += 1;
    const safe = label.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const file = join(this.logDir, `${String(this.logCounter).padStart(3, '0')}-${safe}.log`);
    writeStepLogHeader(file, { step, cwd: this.cwd });
    return file;
  }

  /** Records the outcome of a step in run.log. `ok: null` marks an informational entry. */
  record(ok, step, logFile) {
    appendRunIndex(this.runIndex, { ok, step, logFile });
  }

  beginChange() {
    this.activeSnapshot = snapshotManifests(this.cwd);
    return this.activeSnapshot;
  }

  /** Restores manifests and node_modules to the state before the current change. */
  rollback(logFile) {
    appendLogSection(logFile, 'ROLLBACK: restoring package.json and lockfile, then reinstalling', []);
    this.activeSnapshot?.restore();
    this.activeSnapshot = null;
    const reinstall = installAll(this.cwd, logFile);
    if (!reinstall.ok) {
      throw new Error(`Rollback failed: "npm install" errored after restoring package files. See ${logFile}`);
    }
  }

  /** Keeps the current change in the working tree; it is committed (if the user agrees) at the end of the run. */
  acceptChange() {
    this.activeSnapshot = null;
  }

  /**
   * Runs the test command. On failure, explains which tests failed and why,
   * both in the terminal and at the end of the step's log file.
   * @returns {{ ok: boolean, analysis: import('./test-output.mjs').TestFailureAnalysis | null }}
   */
  verifyTests(logFile) {
    const result = runTests(this.cwd, this.testCommand, logFile, this.testTimeoutMs);
    const seconds = (result.durationMs / 1000).toFixed(1);

    if (result.ok) {
      log.success(`tests passed (${seconds}s)`);
      return { ok: true, analysis: null };
    }

    const timedOut = result.signal === 'SIGTERM' && this.testTimeoutMs;
    const analysis = analyzeTestOutput(`${result.stdout}\n${result.stderr}`, this.cwd);
    log.error(timedOut ? `tests timed out after ${seconds}s` : `tests failed (${seconds}s)`);
    const recognised = analysis.files.length || analysis.tests.length || analysis.errors.length;
    printBlock(renderTestFailure(analysis, { style: CONSOLE_STYLE, includeExcerpt: !recognised }), logFile);
    appendLogSection(logFile, 'FAILURE ANALYSIS', renderTestFailure(analysis, { includeExcerpt: false }));
    return { ok: false, analysis };
  }
}

/**
 * Upgrades one package, or several that must move together, and keeps the change only if
 * install and tests succeed. Several packages are written to package.json first and then
 * installed with one `npm install`, so npm never sees half of the change.
 * @param {RunContext} ctx
 * @param {import('./plan.mjs').PlannedUpgrade[]} items
 * @returns {{ok: boolean, items: object[]}}  on failure each item carries `reason`
 */
export function upgradePackages(ctx, items) {
  const together = items.length > 1;
  const changes = items.map((i) => `${i.name} ${i.from} → ${i.to}`).join(', ');
  const step = `upgrade ${changes}${together ? ' (together)' : ''}`;
  const logFile = ctx.nextLogFile(`upgrade-${items.map((i) => i.name).join('+')}`, step);
  ctx.beginChange();

  const fail = (what, reason) => {
    ctx.rollback(logFile);
    log.warn(`rolled back ${items.map((i) => `${i.name} to ${i.from}`).join(', ')}`);
    ctx.record(false, `${step} (${what})`, logFile);
    return { ok: false, items: items.map((i) => ({ ...i, reason })) };
  };

  const install = together ? installTogether(ctx.cwd, items, logFile) : installPackage(ctx.cwd, items[0], logFile);
  if (!install.ok) {
    const npmError = summarizeNpmError(install);
    log.error(npmFailureReason(npmError));
    printBlock(npmError.lines.map(color.dim), logFile);
    appendLogSection(logFile, 'FAILURE ANALYSIS', npmError.lines);
    return fail('install failed', npmFailureReason(npmError));
  }

  const tests = ctx.verifyTests(logFile);
  if (!tests.ok) {
    const prefix = together ? 'tests fail when upgraded together' : `tests fail with ${items[0].to}`;
    return fail('tests failed', testFailureReason(tests.analysis, prefix));
  }

  ctx.acceptChange();
  ctx.record(true, step, logFile);
  return { ok: true, items };
}

/** Writes every new spec to package.json, then lets one `npm install` resolve them all at once. */
function installTogether(cwd, items, logFile) {
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
 * @param {RunContext} ctx
 * @param {import('./overrides.mjs').OverrideLeaf[]} leaves  the overrides to check, in order
 */
export function pruneOverrides(ctx, leaves) {
  const removed = [];
  const kept = [];

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

function evaluateOverride(ctx, leaf, vulnerableBefore) {
  if (leaf.spec.startsWith('$')) {
    return { removed: false, reason: `references a direct dependency (${leaf.spec}); review manually` };
  }
  const minVersion = minVersionFromSpec(leaf.spec);
  if (!minVersion) return { removed: false, reason: 'spec is too complex to evaluate automatically; review manually' };

  const logFile = ctx.nextLogFile(`override-${leaf.keyPath.join('_')}`, `check override ${describeOverride(leaf)}`);
  ctx.beginChange();
  writeManifest(ctx.cwd, removeOverride(readManifest(ctx.cwd), leaf.keyPath));

  const keep = (reason) => {
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
function printBlock(lines, logFile) {
  const bar = color.red('│');
  for (const line of lines) log.plain(`    ${bar} ${line}`);
  log.plain(`    ${bar} ${color.dim(`Full log: ${logFile}`)}`);
}
