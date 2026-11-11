/**
 * npm CLI wrappers. Every call goes through the project's own npm so the
 * registry, .npmrc and auth configuration are respected.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, type RunResult } from './exec.ts';
import { hasLockfile } from './manifest.ts';

const QUIET_FLAGS = ['--no-audit', '--no-fund'];

/** One entry of `npm outdated --json`. */
export interface OutdatedInfo {
  current?: string;
  wanted: string;
  latest: string;
}

/** Untyped JSON printed by npm. */
type NpmJson = any;

/**
 * Runs `npm outdated --json`. npm exits with code 1 when something is outdated,
 * so the exit code is ignored and the JSON is parsed instead.
 */
export function getOutdated(cwd: string, logFile?: string): Record<string, OutdatedInfo> {
  const result = run('npm', ['outdated', '--json'], { cwd, allowFailure: true, logFile });
  const data: NpmJson = parseJson(result.stdout, {});
  if (data.error) throw new Error(`npm outdated failed: ${data.error.summary ?? JSON.stringify(data.error)}`);

  // In workspaces npm returns an array per package; this tool works on the root package only.
  return Object.fromEntries(
    Object.entries(data).map(([name, info]) => [name, Array.isArray(info) ? info[0] : info]),
  );
}

/** All published versions of a package. */
export function getPublishedVersions(cwd: string, name: string, logFile?: string): string[] {
  const result = run('npm', ['view', name, 'versions', '--json'], { cwd, logFile });
  const versions = parseJson(result.stdout, []);
  return Array.isArray(versions) ? versions : [versions];
}

/**
 * peerDependencies of `name@version`. The installed copy is read from node_modules when it is
 * that version (no network); otherwise the registry is asked. Unknown → {}.
 */
export function getPeerDependencies(cwd: string, name: string, version: string, logFile?: string): Record<string, string> {
  try {
    const installed = JSON.parse(readFileSync(join(cwd, 'node_modules', name, 'package.json'), 'utf8'));
    if (installed.version === version) return installed.peerDependencies ?? {};
  } catch {
    // not installed: ask the registry
  }
  const result = run('npm', ['view', `${name}@${version}`, 'peerDependencies', '--json'], {
    cwd,
    allowFailure: true,
    logFile,
  });
  const peers: NpmJson = parseJson(result.stdout, {});
  return peers && typeof peers === 'object' && !Array.isArray(peers) ? peers : {};
}

/**
 * The source repository of `name@version`, normalised ("github.com/org/repo"), so packages
 * released from one repository can be recognised. Read from node_modules when that version is
 * installed, otherwise from the registry. Unknown → null.
 */
export function getRepository(cwd: string, name: string, version: string, logFile?: string): string | null {
  let repository: NpmJson;
  try {
    const installed = JSON.parse(readFileSync(join(cwd, 'node_modules', name, 'package.json'), 'utf8'));
    if (installed.version === version) repository = installed.repository ?? null;
  } catch {
    // not installed: ask the registry
  }
  if (repository === undefined) {
    const result = run('npm', ['view', `${name}@${version}`, 'repository', '--json'], { cwd, allowFailure: true, logFile });
    repository = parseJson(result.stdout, null);
  }
  return normaliseRepository(typeof repository === 'string' ? repository : repository?.url);
}

/** "git+https://github.com/org/repo.git" → "github.com/org/repo"; shorthand "org/repo" → "github.com/org/repo". */
export function normaliseRepository(url: unknown): string | null {
  if (!url || typeof url !== 'string') return null;
  let text = url.trim().replace(/^git\+/, '').replace(/\.git$/, '').replace(/\/+$/, '');
  if (/^[\w.-]+\/[\w.-]+$/.test(text)) text = `github.com/${text}`;
  text = text.replace(/^github:/, 'github.com/').replace(/^gitlab:/, 'gitlab.com/');
  text = text.replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@/, '').replace(/^([^/:]+):/, '$1/');
  return text.toLowerCase() || null;
}

/** Installs a single dependency, saving it to the given section of package.json. */
export function installPackage(
  cwd: string,
  { name, spec, saveFlag, exact }: { name: string; spec: string; saveFlag: string; exact?: boolean },
  logFile?: string,
): RunResult {
  const args = ['install', `${name}@${spec}`, saveFlag, ...QUIET_FLAGS];
  if (exact) args.push('--save-exact');
  return run('npm', args, { cwd, allowFailure: true, logFile });
}

/** Re-syncs node_modules with package.json / lockfile. */
export function installAll(cwd: string, logFile?: string): RunResult {
  return run('npm', ['install', ...QUIET_FLAGS], { cwd, allowFailure: true, logFile });
}

/** Clean, reproducible install from the lockfile (falls back to `npm install` without one). */
export function cleanInstall(cwd: string, logFile?: string): RunResult {
  const args = hasLockfile(cwd) ? ['ci', ...QUIET_FLAGS] : ['install', ...QUIET_FLAGS];
  return run('npm', args, { cwd, allowFailure: true, logFile });
}

/** Every version of `name` present anywhere in the installed dependency tree. */
export function getInstalledVersions(cwd: string, name: string, logFile?: string): string[] {
  // `npm ls` exits non-zero for unrelated tree problems (e.g. extraneous packages); the JSON is still valid.
  const result = run('npm', ['ls', name, '--all', '--json'], { cwd, allowFailure: true, logFile });
  const tree: NpmJson = parseJson(result.stdout, {});
  const versions = new Set<string>();

  const walk = (deps: NpmJson = {}): void => {
    for (const [depName, node] of Object.entries<NpmJson>(deps)) {
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
 */
export function getVulnerablePackages(cwd: string, logFile?: string): Set<string> | null {
  const result = run('npm', ['audit', '--json'], { cwd, allowFailure: true, logFile });
  const report: NpmJson = parseJson(result.stdout, null);
  if (!report?.vulnerabilities) return null;
  return new Set(Object.keys(report.vulnerabilities));
}

/** Runs the project's tests. CI=true stops watch-mode runners (jest, vitest) from hanging. */
export function runTests(cwd: string, testCommand: string, logFile?: string, timeoutMs?: number): RunResult {
  return run(testCommand, [], { cwd, shell: true, allowFailure: true, env: { CI: 'true' }, logFile, timeoutMs });
}

function parseJson<T>(text: string, fallback: T): NpmJson | T {
  try {
    return text.trim() ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
}
