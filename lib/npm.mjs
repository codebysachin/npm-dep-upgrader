/**
 * npm CLI wrappers. Every call goes through the project's own npm so the
 * registry, .npmrc and auth configuration are respected.
 */
import { run } from './exec.mjs';
import { hasLockfile } from './manifest.mjs';

const QUIET_FLAGS = ['--no-audit', '--no-fund'];

/**
 * Runs `npm outdated --json`. npm exits with code 1 when something is outdated,
 * so the exit code is ignored and the JSON is parsed instead.
 * @returns {Record<string, {current?: string, wanted: string, latest: string}>}
 */
export function getOutdated(cwd, logFile) {
  const result = run('npm', ['outdated', '--json'], { cwd, allowFailure: true, logFile });
  const data = parseJson(result.stdout, {});
  if (data.error) throw new Error(`npm outdated failed: ${data.error.summary ?? JSON.stringify(data.error)}`);

  // In workspaces npm returns an array per package; this tool works on the root package only.
  return Object.fromEntries(
    Object.entries(data).map(([name, info]) => [name, Array.isArray(info) ? info[0] : info]),
  );
}

/** All published versions of a package. */
export function getPublishedVersions(cwd, name, logFile) {
  const result = run('npm', ['view', name, 'versions', '--json'], { cwd, logFile });
  const versions = parseJson(result.stdout, []);
  return Array.isArray(versions) ? versions : [versions];
}

/** Installs a single dependency, saving it to the given section of package.json. */
export function installPackage(cwd, { name, spec, saveFlag, exact }, logFile) {
  const args = ['install', `${name}@${spec}`, saveFlag, ...QUIET_FLAGS];
  if (exact) args.push('--save-exact');
  return run('npm', args, { cwd, allowFailure: true, logFile });
}

/** Re-syncs node_modules with package.json / lockfile. */
export function installAll(cwd, logFile) {
  return run('npm', ['install', ...QUIET_FLAGS], { cwd, allowFailure: true, logFile });
}

/** Clean, reproducible install from the lockfile (falls back to `npm install` without one). */
export function cleanInstall(cwd, logFile) {
  const args = hasLockfile(cwd) ? ['ci', ...QUIET_FLAGS] : ['install', ...QUIET_FLAGS];
  return run('npm', args, { cwd, allowFailure: true, logFile });
}

/** Every version of `name` present anywhere in the installed dependency tree. */
export function getInstalledVersions(cwd, name, logFile) {
  // `npm ls` exits non-zero for unrelated tree problems (e.g. extraneous packages); the JSON is still valid.
  const result = run('npm', ['ls', name, '--all', '--json'], { cwd, allowFailure: true, logFile });
  const tree = parseJson(result.stdout, {});
  const versions = new Set();

  const walk = (deps = {}) => {
    for (const [depName, node] of Object.entries(deps)) {
      if (depName === name && node.version) versions.add(node.version);
      walk(node.dependencies);
    }
  };
  walk(tree.dependencies);
  return [...versions];
}

/**
 * Names of packages that `npm audit` reports as vulnerable.
 * Returns null when audit can't run (offline, registry without audit support, ...).
 * @returns {Set<string>|null}
 */
export function getVulnerablePackages(cwd, logFile) {
  const result = run('npm', ['audit', '--json'], { cwd, allowFailure: true, logFile });
  const report = parseJson(result.stdout, null);
  if (!report?.vulnerabilities) return null;
  return new Set(Object.keys(report.vulnerabilities));
}

/** Runs the project's tests. CI=true stops watch-mode runners (jest, vitest) from hanging. */
export function runTests(cwd, testCommand, logFile, timeoutMs) {
  return run(testCommand, [], { cwd, shell: true, allowFailure: true, env: { CI: 'true' }, logFile, timeoutMs });
}

function parseJson(text, fallback) {
  try {
    return text.trim() ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}
