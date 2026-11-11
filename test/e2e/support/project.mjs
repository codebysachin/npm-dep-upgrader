/**
 * Builds a throwaway project for an end-to-end test: a git repo on "main" pushed to a local
 * bare remote, with dependencies installed by the fake npm from a fake registry. Then runs the
 * upgrader against it. Everything is offline and lives in a temp folder.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, '..', '..', '..', 'upgrade-deps.mjs');
const FAKE_NPM = join(here, 'fake-npm.mjs');

/**
 * @param {object} params
 * @param {object} params.packageJson        written as package.json
 * @param {object} params.registry           see fake-npm.mjs
 * @param {Record<string,string>} [params.files]  extra files to commit (e.g. a test script)
 */
export function createProject({ packageJson, registry, files = {} }) {
  const root = mkdtempSync(join(tmpdir(), 'ndu-e2e-'));
  const dir = join(root, 'app');
  const bin = join(root, 'bin');
  mkdirSync(dir);
  mkdirSync(bin);

  writeFileSync(join(root, 'registry.json'), JSON.stringify(registry));
  writeFileSync(join(root, 'gitconfig'), '[user]\n\tname = E2E\n\temail = e2e@example.invalid\n[init]\n\tdefaultBranch = main\n');
  writeFileSync(join(bin, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_NPM}" "$@"\n`);
  chmodSync(join(bin, 'npm'), 0o755);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    FAKE_NPM_REGISTRY: join(root, 'registry.json'),
    // Isolate from the developer's git setup (signing, hooks, aliases).
    GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    TMPDIR: root, // the upgrader's logs
    NO_COLOR: '1',
  };
  delete env.NPM_DEP_UPGRADER_ANSWERS;

  const sh = (command, args, cwd = dir) => {
    const result = spawnSync(command, args, { cwd, env, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout}${result.stderr}`);
    return result.stdout.trim();
  };
  const git = (...args) => sh('git', args);

  sh('git', ['init', '-q', '--bare', 'remote.git'], root);
  git('init', '-q');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(packageJson, null, 2)}\n`);
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  sh('npm', ['install']);
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  git('remote', 'add', 'origin', join(root, 'remote.git'));
  git('push', '-q', '-u', 'origin', 'main');

  return {
    dir,
    git,
    npm: (...args) => sh('npm', args),
    /** Runs the upgrader. `answers` scripts the interactive questions, in order. */
    run(args = [], { answers } = {}) {
      const result = spawnSync(process.execPath, [CLI, ...args], {
        cwd: dir,
        env: answers ? { ...env, NPM_DEP_UPGRADER_ANSWERS: JSON.stringify(answers) } : env,
        encoding: 'utf8',
        timeout: 60_000,
      });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    },
    readJson: (file) => JSON.parse(readFileSync(join(dir, file), 'utf8')),
    installedVersion: (name) =>
      existsSync(join(dir, 'node_modules', name)) ? JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8')).version : null,
    write: (file, content) => writeFileSync(join(dir, file), content),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** A registry entry with the given versions and no metadata. */
export const versions = (...list) => Object.fromEntries(list.map((v) => [v, {}]));
