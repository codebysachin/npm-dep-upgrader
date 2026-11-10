/**
 * The stateful steps of a run: each change is applied, verified with tests and
 * either committed or rolled back before the next one starts.
 */
import { join } from 'node:path';
import { commitFiles } from './git.mjs';
import { color, log } from './logger.mjs';
import { presentManifestFiles, readManifest, snapshotManifests, writeManifest } from './manifest.mjs';
import {
  getInstalledVersions,
  getVulnerablePackages,
  installAll,
  installPackage,
  runTests,
} from './npm.mjs';
import { collectOverrideLeaves, describeOverride, removeOverride } from './overrides.mjs';
import { compareVersions, minVersionFromSpec, parseVersion } from './semver.mjs';
import { tail } from './exec.mjs';

/**
 * Shared state for one run.
 */
export class RunContext {
  /**
   * @param {object} options
   * @param {string} options.cwd
   * @param {string} options.testCommand
   * @param {string} options.logDir
   * @param {boolean} options.commit
   * @param {number} [options.testTimeoutMs]
   */
  constructor({ cwd, testCommand, logDir, commit, testTimeoutMs }) {
    Object.assign(this, { cwd, testCommand, logDir, commit, testTimeoutMs });
    this.logCounter = 0;
    /** Snapshot of the change currently in progress; restored on Ctrl+C. */
    this.activeSnapshot = null;
  }

  nextLogFile(label) {
    this.logCounter += 1;
    const safe = label.replace(/[^a-zA-Z0-9._-]+/g, '_');
    return join(this.logDir, `${String(this.logCounter).padStart(3, '0')}-${safe}.log`);
  }

  beginChange() {
    this.activeSnapshot = snapshotManifests(this.cwd);
    return this.activeSnapshot;
  }

  /** Restores manifests and node_modules to the state before the current change. */
  rollback(logFile) {
    this.activeSnapshot?.restore();
    this.activeSnapshot = null;
    const reinstall = installAll(this.cwd, logFile);
    if (!reinstall.ok) {
      throw new Error(`Rollback failed: "npm install" errored after restoring package files. See ${logFile}`);
    }
  }

  commitChange(message) {
    this.activeSnapshot = null;
    if (!this.commit) return;
    if (!commitFiles(this.cwd, presentManifestFiles(this.cwd), message)) {
      log.warn('Nothing to commit (or the commit hook rejected it); continuing.');
    }
  }

  /** Runs the test command and prints a one-line verdict. */
  verifyTests(logFile) {
    log.info(color.dim(`running "${this.testCommand}" ...`));
    const result = runTests(this.cwd, this.testCommand, logFile, this.testTimeoutMs);
    const seconds = (result.durationMs / 1000).toFixed(1);
    if (result.ok) log.success(`tests passed (${seconds}s)`);
    else log.error(`tests failed (${seconds}s) — log: ${logFile}\n${color.dim(indent(tail(result)))}`);
    return result.ok;
  }
}

/**
 * Upgrades one package and keeps it only if install and tests succeed.
 * @param {RunContext} ctx
 * @param {import('./plan.mjs').PlannedUpgrade} item
 * @returns {{ok: true, item: object} | {ok: false, item: object}}
 */
export function upgradePackage(ctx, item) {
  const logFile = ctx.nextLogFile(`upgrade-${item.name}`);
  ctx.beginChange();

  const install = installPackage(ctx.cwd, item, logFile);
  if (!install.ok) {
    log.error(`npm install failed — log: ${logFile}\n${color.dim(indent(tail(install)))}`);
    ctx.rollback(logFile);
    log.warn(`rolled back ${item.name} to ${item.from}`);
    return { ok: false, item: { ...item, reason: 'npm install failed (peer dependency conflict?)' } };
  }

  if (!ctx.verifyTests(logFile)) {
    ctx.rollback(logFile);
    log.warn(`rolled back ${item.name} to ${item.from}`);
    return { ok: false, item: { ...item, reason: `tests fail with ${item.to}` } };
  }

  ctx.commitChange(`chore(deps): bump ${item.name} from ${item.from} to ${item.to}`);
  return { ok: true, item };
}

/**
 * Tries to remove each override in turn. An override is considered obsolete when,
 * without it:
 *   1. npm install succeeds,
 *   2. every installed copy of the package is at least the version the override forced,
 *   3. npm audit doesn't start reporting the package as vulnerable, and
 *   4. tests pass.
 * @param {RunContext} ctx
 */
export function pruneOverrides(ctx) {
  const removed = [];
  const kept = [];
  const leaves = collectOverrideLeaves(readManifest(ctx.cwd).overrides);

  if (!leaves.length) {
    log.info('No overrides found in package.json.');
    return { removed, kept };
  }

  log.info(`Found ${leaves.length} override(s). Checking npm audit baseline ...`);
  const vulnerableBefore = getVulnerablePackages(ctx.cwd, ctx.nextLogFile('audit-baseline'));
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
  }
  return { removed, kept };
}

function evaluateOverride(ctx, leaf, vulnerableBefore) {
  if (leaf.spec.startsWith('$')) {
    return { removed: false, reason: `references a direct dependency (${leaf.spec}); review manually` };
  }
  const minVersion = minVersionFromSpec(leaf.spec);
  if (!minVersion) return { removed: false, reason: 'spec is too complex to evaluate automatically; review manually' };

  const logFile = ctx.nextLogFile(`override-${leaf.keyPath.join('_')}`);
  ctx.beginChange();
  writeManifest(ctx.cwd, removeOverride(readManifest(ctx.cwd), leaf.keyPath));

  const keep = (reason) => {
    ctx.rollback(logFile);
    return { removed: false, reason };
  };

  if (!installAll(ctx.cwd, logFile).ok) return keep('npm install fails without it');

  const installed = getInstalledVersions(ctx.cwd, leaf.name, logFile);
  const tooOld = installed.filter((v) => parseVersion(v) && compareVersions(v, minVersion) < 0);
  if (tooOld.length) return keep(`without it npm resolves ${leaf.name}@${tooOld.join(', ')} (< ${minVersion})`);

  if (vulnerableBefore) {
    const vulnerableAfter = getVulnerablePackages(ctx.cwd, logFile);
    if (vulnerableAfter?.has(leaf.name) && !vulnerableBefore.has(leaf.name)) {
      return keep(`npm audit reports ${leaf.name} as vulnerable without it`);
    }
  }

  if (!ctx.verifyTests(logFile)) return keep('tests fail without it');

  const resolved = installed.length ? `${leaf.name}@${installed.join(', ')}` : 'package no longer in dependency tree';
  ctx.commitChange(`chore(deps): remove obsolete override ${leaf.keyPath.join(' > ')}`);
  return { removed: true, resolved };
}

const indent = (text) =>
  text
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');
