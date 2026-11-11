#!/usr/bin/env node
/**
 * A tiny, offline stand-in for the npm CLI, used by the end-to-end tests. It implements only
 * what the upgrader calls, with npm's exit codes and error wording where the upgrader reads them:
 *
 *   npm --version | ci | install [<pkg>@<spec> ...] [--save-prod|--save-dev|--save-optional] [--save-exact]
 *   npm outdated --json | view <pkg> versions --json | view <pkg>@<ver> peerDependencies --json
 *   npm ls <pkg> --all --json | audit --json | test
 *
 * The registry is a JSON file named by FAKE_NPM_REGISTRY:
 *   { "<name>": { "<version>": { "peerDependencies"?: {}, "dependencies"?: {}, "repository"?: "", "vulnerable"?: true } } }
 * Installs are flat (one version per package) and are written to node_modules/<name>/package.json
 * and package-lock.json, so tests can read the installed versions.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Manifest } from '../../../lib/manifest.ts';
import { compareVersions, highestVersion, isPrerelease, satisfies } from '../../../lib/semver.ts';

/** One version's entry in the fake registry. */
export interface RegistryVersion {
  peerDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  repository?: string;
  vulnerable?: boolean;
}
export type Registry = Record<string, Record<string, RegistryVersion>>;
/** name -> version */
type Tree = Record<string, string>;

const SECTIONS: Record<string, string> = { '--save-prod': 'dependencies', '--save-dev': 'devDependencies', '--save-optional': 'optionalDependencies' };
const cwd = process.cwd();
const registry: Registry = JSON.parse(readFileSync(process.env.FAKE_NPM_REGISTRY, 'utf8'));
const args = process.argv.slice(2);
const positional = args.filter((a) => !a.startsWith('--'));
const flags = new Set(args.filter((a) => a.startsWith('--')));

const readJson = (file: string, fallback?: unknown) => (existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback);
const manifestPath = join(cwd, 'package.json');
const lockPath = join(cwd, 'package-lock.json');
const manifest = (): Manifest => readJson(manifestPath);
const directDeps = (m: Manifest): Record<string, string> => ({ ...m.dependencies, ...m.devDependencies, ...m.optionalDependencies });
const versionsOf = (name: string) => Object.keys(registry[name] ?? {});
const latestOf = (name: string) => highestVersion(versionsOf(name), (v) => !isPrerelease(v));
const best = (name: string, range: string) => highestVersion(versionsOf(name), (v) => satisfies(v, range) === true);

function fail(code: string, lines: string[]): never {
  process.stderr.write([`npm error code ${code}`, ...lines.map((l) => `npm error ${l}`), ''].join('\n'));
  process.exit(1);
}

function installed(): Tree {
  const lock: { packages: Record<string, { version: string }> } = readJson(lockPath, { packages: {} });
  return Object.fromEntries(
    Object.entries(lock.packages)
      .filter(([key]) => key.startsWith('node_modules/'))
      .map(([key, entry]) => [key.slice('node_modules/'.length), entry.version]),
  );
}

/** Resolves the whole flat tree. `keep` versions are reused when they still satisfy their range. */
function resolveTree(m: Manifest, keep: Tree): Tree {
  const overrides = m.overrides ?? {};
  const tree: Tree = {};
  const queue = Object.entries(directDeps(m));
  while (queue.length) {
    const [name, requested] = queue.shift();
    if (tree[name]) continue;
    const range = typeof overrides[name] === 'string' ? overrides[name] : requested;
    const version = keep[name] && satisfies(keep[name], range) === true ? keep[name] : best(name, range);
    if (!version) fail('ETARGET', [`No matching version found for ${name}@${range}.`]);
    tree[name] = version;
    queue.push(...Object.entries(registry[name][version].dependencies ?? {}));
  }
  for (const [name, version] of Object.entries(tree)) {
    for (const [peer, range] of Object.entries(registry[name][version].peerDependencies ?? {})) {
      if (tree[peer] && satisfies(tree[peer], range) !== true) {
        fail('ERESOLVE', [
          'ERESOLVE unable to resolve dependency tree',
          '',
          `While resolving: ${m.name}@${m.version}`,
          `Found: ${peer}@${tree[peer]}`,
          '',
          'Could not resolve dependency:',
          `peer ${peer}@"${range}" from ${name}@${version}`,
        ]);
      }
    }
  }
  return tree;
}

function writeTree(m: Manifest, tree: Tree) {
  rmSync(join(cwd, 'node_modules'), { recursive: true, force: true });
  for (const [name, version] of Object.entries(tree)) {
    const dir = join(cwd, 'node_modules', name);
    mkdirSync(dir, { recursive: true });
    const { peerDependencies, dependencies, repository } = registry[name][version];
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version, peerDependencies, dependencies, repository }, null, 2));
  }
  const root = { name: m.name, version: m.version, dependencies: m.dependencies, devDependencies: m.devDependencies };
  const packages: Record<string, object> = { '': root };
  for (const name of Object.keys(tree).sort()) packages[`node_modules/${name}`] = { version: tree[name] };
  writeFileSync(lockPath, `${JSON.stringify({ name: m.name, lockfileVersion: 3, packages }, null, 2)}\n`);
}

function writeManifest(m: Manifest) {
  writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`);
}

const commands: Record<string, () => void> = {
  '--version': () => console.log('10.0.0-fake'),

  ci() {
    if (!existsSync(lockPath)) fail('EUSAGE', ['The `npm ci` command can only install with an existing package-lock.json.']);
    const m = manifest();
    const locked = installed();
    const problems = Object.entries(directDeps(m))
      .filter(([name, range]) => !locked[name] || satisfies(locked[name], range) !== true)
      .map(([name, range]) => (locked[name] ? `Invalid: lock file's ${name}@${locked[name]} does not satisfy ${name}@${range}` : `Missing: ${name}@${range} from lock file`));
    if (problems.length) {
      fail('EUSAGE', [
        '`npm ci` can only install packages when your package.json and package-lock.json are in sync. Please update your lock file with `npm install` before continuing.',
        '',
        ...problems,
      ]);
    }
    writeTree(m, locked);
  },

  install() {
    const m = manifest();
    const section = [...flags].map((f) => SECTIONS[f]).find(Boolean) ?? 'dependencies';
    for (const spec of positional.slice(1)) {
      const at = spec.lastIndexOf('@');
      const [name, range] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, 'latest'];
      for (const s of Object.values(SECTIONS)) if (m[s]) delete m[s][name];
      m[section] = { ...m[section], [name]: range === 'latest' ? `^${latestOf(name)}` : range };
    }
    const tree = resolveTree(m, installed()); // exits on conflict, before anything is written
    writeManifest(m);
    writeTree(m, tree);
  },

  outdated() {
    const m = manifest();
    const current = installed();
    const result: Record<string, object> = {};
    for (const [name, range] of Object.entries(directDeps(m))) {
      const latest = latestOf(name);
      if (current[name] && compareVersions(current[name], latest) < 0) {
        result[name] = { current: current[name], wanted: best(name, range), latest, dependent: m.name, location: `node_modules/${name}` };
      }
    }
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = Object.keys(result).length ? 1 : 0;
  },

  view() {
    const [, spec, field] = positional;
    const at = spec.lastIndexOf('@');
    const [name, version] = at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, null];
    if (!registry[name]) fail('E404', [`404 Not Found - ${name}`]);
    if (field === 'versions') return console.log(JSON.stringify(versionsOf(name).sort(compareVersions)));
    const value = registry[name][version]?.[field as keyof RegistryVersion];
    if (value && Object.keys(value).length) console.log(JSON.stringify(value));
  },

  ls() {
    const name = positional[1];
    const version = installed()[name];
    console.log(JSON.stringify({ dependencies: version ? { [name]: { version } } : {} }));
  },

  audit() {
    const vulnerabilities: Record<string, object> = {};
    for (const [name, version] of Object.entries(installed())) {
      if (registry[name]?.[version]?.vulnerable) vulnerabilities[name] = { name, severity: 'high' };
    }
    console.log(JSON.stringify({ vulnerabilities }));
  },

  test() {
    const script = manifest().scripts?.test;
    if (!script) fail('ENOENT', ['Missing script: "test"']);
    const child = spawnSync(script, { cwd, shell: true, stdio: 'inherit' });
    process.exitCode = child.status ?? 1;
  },
};

const command = commands[args[0]] ?? commands[positional[0]];
if (!command) fail('EUNKNOWN', [`fake npm does not implement: npm ${args.join(' ')}`]);
command();
