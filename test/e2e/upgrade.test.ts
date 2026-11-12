/**
 * End-to-end tests: the real upgrader against throwaway git projects, with a fake npm and
 * registry (see support/). Offline and deterministic; interactive runs use scripted answers.
 */
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createProject, type Project, type ProjectParams, versions } from './support/project.ts';

const BRANCH = 'deps/e2e';
let project: Project;
afterEach(() => project?.cleanup());

/** check.js fails the tests when `condition` (a JS expression over `v(name)`) is true. */
const failWhen = (condition: string, message = 'simulated test failure') => `
const fs = require('fs');
const v = (name) => JSON.parse(fs.readFileSync('node_modules/' + name + '/package.json', 'utf8')).version;
const major = (name) => Number(v(name).split('.')[0]);
if (${condition}) { console.error('Error: ${message}'); process.exit(1); }
console.log('ok');
`;

function simpleProject({ condition = 'false', ...extra }: { condition?: string } & Partial<ProjectParams> = {}) {
  return createProject({
    packageJson: {
      name: 'app',
      version: '1.0.0',
      private: true,
      scripts: { test: 'node check.js' },
      dependencies: { alpha: '^1.0.0' },
      devDependencies: { beta: '~1.0.0' },
      ...extra.packageJson,
    },
    registry: { alpha: versions('1.0.0', '2.0.0'), beta: versions('1.0.0', '1.1.0'), ...extra.registry },
    files: { 'check.js': failWhen(condition) },
  });
}

const branch = () => project.git('branch', '--show-current');
const lastCommit = () => project.git('log', '-1', '--format=%B');
const changedFiles = () => project.git('status', '--porcelain');

test('--yes upgrades every package on a new branch and commits with the MR summary', () => {
  project = simpleProject();
  const { status, output } = project.run(['--yes', '--branch', BRANCH]);

  assert.equal(status, 0, output);
  assert.equal(branch(), BRANCH);
  assert.equal(changedFiles(), '', 'everything is committed');
  assert.deepEqual(project.readJson('package.json').dependencies, { alpha: '^2.0.0' });
  assert.deepEqual(project.readJson('package.json').devDependencies, { beta: '~1.1.0' }, 'the range prefix is kept');
  assert.match(lastCommit(), /^chore\(deps\): upgrade 2 packages/);
  assert.match(lastCommit(), /\| `alpha` \| 1\.0\.0 \| 2\.0\.0 \|/);
  assert.match(output, /✔ \$ npm install alpha@\^2\.0\.0 --save-prod/, 'commands are shown on screen');
  assert.equal(project.readLog('errors.log'), null, 'no errors.log when nothing failed');
  assert.doesNotMatch(output, /error\(s\) recorded/);
});

test('an upgrade that breaks the tests is rolled back and left out of the commit', () => {
  project = simpleProject({ condition: "major('alpha') >= 2" });
  const { status, output } = project.run(['--yes', '--branch', BRANCH]);

  assert.equal(status, 0, output);
  assert.match(output, /rolled back alpha to 1\.0\.0/);
  assert.match(output, /Error: simulated test failure/, 'the failing test output is explained');
  assert.equal(project.readJson('package.json').dependencies.alpha, '^1.0.0');
  assert.equal(project.installedVersion('alpha'), '1.0.0', 'node_modules is re-synced');
  assert.match(lastCommit(), /^chore\(deps\): upgrade 1 package\n/);
  assert.doesNotMatch(lastCommit(), /alpha/, 'the MR summary lists successful upgrades only');

  const errors = project.readLog('errors.log');
  assert.match(output, /1 error\(s\) recorded for investigation: .*errors\.log/);
  assert.match(errors, /#1 .* upgrade alpha 1\.0\.0 → 2\.0\.0\n/);
  assert.match(errors, /Error: {5}tests fail with 2\.0\.0/);
  assert.match(errors, /Outcome: {3}rolling back alpha to 1\.0\.0/);
  assert.match(errors, /Full log: {2}\d{3}-upgrade-alpha\.log/);
  assert.match(errors, /\$ npm test\n {2}exit 1/, 'the failed command');
  assert.match(errors, /\[stderr\]\n {2}Error: simulated test failure/, 'and its output');
  assert.doesNotMatch(errors, /beta/, 'only failures are recorded');
});

test('a failed upgrade is offered again, marked as tried, and can pass after another upgrade', () => {
  project = simpleProject({ condition: "major('alpha') >= 2 && v('beta') !== '1.1.0'" });
  const { status, output } = project.run(['--branch', BRANCH], { answers: ['alpha', 'beta alpha', 'n'] });

  assert.equal(status, 0, output);
  assert.match(output, /alpha .*\[tried, failed\]/);
  assert.match(output, /alpha {2}1\.0\.0 → 2\.0\.0 {2}\(major\) {2}— retrying/);
  assert.match(output, /2 upgraded, 0 override\(s\) removed, 0 failed/);
  assert.equal(project.readJson('package.json').dependencies.alpha, '^2.0.0');
  assert.match(changedFiles(), /package\.json/, 'answering "n" leaves the changes uncommitted');
  assert.equal(lastCommit(), 'initial');
});

function linkedProject() {
  return createProject({
    packageJson: {
      name: 'app',
      version: '1.0.0',
      scripts: { test: 'node check.js' },
      devDependencies: { core: '^1.0.0', parser: '^1.0.0', plugin: '^1.0.0' },
    },
    registry: {
      core: versions('1.0.0', '2.0.0'),
      parser: versions('1.0.0', '2.0.0'),
      plugin: {
        '1.0.0': { peerDependencies: { parser: '^1.0.0', core: '^1.0.0' } },
        '2.0.0': { peerDependencies: { parser: '^2.0.0', core: '^1.0.0 || ^2.0.0' } },
      },
    },
    files: { 'check.js': failWhen('false') },
  });
}

test('packages that need each other are upgraded together in one step', () => {
  project = linkedProject();
  const { status, output } = project.run(['--branch', BRANCH], { answers: ['parser', '', 'y'] });

  assert.equal(status, 0, output);
  assert.match(output, /2 packages, upgraded together {2}\[linked\]/);
  assert.match(output, /plugin@2\.0\.0 needs parser \^2\.0\.0/);
  assert.match(output, /\[1\/1\] 2 packages together/);
  assert.deepEqual([project.installedVersion('parser'), project.installedVersion('plugin')], ['2.0.0', '2.0.0']);
  assert.equal(project.installedVersion('core'), '1.0.0', 'core needs the pair, but the pair does not need core');
  assert.match(lastCommit(), /upgrade 2 packages/);
});

test('picking a package without what it needs pulls that into the same step', () => {
  project = linkedProject();
  const { status, output } = project.run(['--branch', BRANCH], { answers: ['core', 'y'] });

  assert.equal(status, 0, output);
  assert.match(output, /core .*\n.*needs parser \+ plugin too/);
  assert.match(output, /included because they are needed: parser \+ plugin/);
  assert.deepEqual(['core', 'parser', 'plugin'].map(project.installedVersion), ['2.0.0', '2.0.0', '2.0.0']);
});

test('--dry-run reports the plan, including linked packages, and changes nothing', () => {
  project = linkedProject();
  const { status, output } = project.run(['--dry-run']);

  assert.equal(status, 0, output);
  assert.match(output, /upgraded together \(2\):/);
  assert.equal(branch(), 'main');
  assert.equal(changedFiles(), '');
});

test('typing "q" quits cleanly and changes nothing', () => {
  project = simpleProject();
  const { status, output } = project.run(['--branch', BRANCH], { answers: ['q'] });

  assert.equal(status, 0, output);
  assert.match(output, /Quit\./);
  assert.match(output, /Nothing was changed\./);
  assert.equal(branch(), 'main');
  assert.equal(project.git('branch', '--list', BRANCH), '');
});

test('quitting after an upgrade keeps it uncommitted and explains how to commit or discard', () => {
  project = simpleProject();
  const { status, output } = project.run(['--branch', BRANCH], { answers: ['alpha', 'q'] });

  assert.equal(status, 0, output);
  assert.match(output, /Kept so far \(all tests passed\):\n\s+• alpha 1\.0\.0 → 2\.0\.0/);
  assert.match(output, /Commit: {3}git add package\.json package-lock\.json && git commit -F /);
  assert.equal(branch(), BRANCH);
  assert.match(changedFiles(), /package\.json/);
});

test('uncommitted changes on main stop the run with instructions', () => {
  project = simpleProject();
  project.write('check.js', `${failWhen('false')}\n// edited`);
  const { status, output } = project.run(['--yes']);

  assert.equal(status, 1, output);
  assert.match(output, /ACTION REQUIRED/);
  assert.match(output, /check\.js/);
});

test('main behind its remote: --yes pulls it, otherwise the run stops and says how to pull', () => {
  project = simpleProject();
  project.write('notes.txt', 'new');
  project.git('add', 'notes.txt');
  project.git('commit', '-q', '-m', 'upstream change');
  project.git('push', '-q');
  project.git('reset', '-q', '--hard', 'HEAD~1');

  const stopped = project.run([]);
  assert.equal(stopped.status, 1, stopped.output);
  assert.match(stopped.output, /behind/);
  assert.match(stopped.output, /git pull --ff-only/);

  const pulled = project.run(['--yes', '--branch', BRANCH]);
  assert.equal(pulled.status, 0, pulled.output);
  assert.match(pulled.output, /pulled the latest changes/);
  assert.match(project.git('log', '--format=%s'), /upstream change/);
});

test('tests that already fail on main stop the run, and errors.log says why', () => {
  project = simpleProject({ condition: 'true' });
  const { status, output } = project.run(['--yes', '--branch', BRANCH]);

  assert.equal(status, 2, output);
  assert.match(output, /Tests already fail on main/);
  assert.match(output, /1 error\(s\) recorded for investigation/);
  const errors = project.readLog('errors.log');
  assert.match(errors, /#1 .* baseline tests \(main\)\n═+\nError: {5}tests fail before any change/);
  assert.match(errors, /Outcome: {3}run stopped: fix the failing tests on main first/);
  assert.match(errors, /\[stderr\]\n {2}Error: simulated test failure/);
  assert.equal(changedFiles(), '', 'nothing changed');
});

test('a lockfile out of sync with package.json stops the run before anything changes', () => {
  project = simpleProject();
  const manifest = project.readJson('package.json');
  manifest.dependencies.alpha = '^1.1.0';
  project.write('package.json', `${JSON.stringify(manifest, null, 2)}\n`);
  project.git('commit', '-q', '-am', 'bump without lockfile');
  project.git('push', '-q');

  const { status, output } = project.run(['--yes']);
  assert.equal(status, 1, output);
  assert.match(output, /package-lock\.json is out of sync with package\.json/);
  assert.match(output, /Invalid: lock file's alpha@1\.0\.0 does not satisfy alpha@\^1\.1\.0/);
  assert.match(project.readLog('errors.log'), /checks before starting[\s\S]*out of sync[\s\S]*fix: /);
});

test('obsolete overrides are removed and needed ones are kept', () => {
  project = createProject({
    packageJson: {
      name: 'app',
      version: '1.0.0',
      scripts: { test: 'node check.js' },
      dependencies: { lib: '^1.0.0' },
      overrides: { deep: '^1.2.0', pinned: '^1.5.0' },
    },
    registry: {
      lib: { '1.0.0': { dependencies: { deep: '^1.0.0', pinned: '~1.0.0' } } },
      deep: versions('1.0.0', '1.2.0'),
      pinned: versions('1.0.0', '1.5.0'),
    },
    files: { 'check.js': failWhen('false') },
  });
  const { status, output } = project.run(['--yes', '--branch', BRANCH]);

  assert.equal(status, 0, output);
  assert.deepEqual(project.readJson('package.json').overrides, { pinned: '^1.5.0' });
  assert.match(output, /without it npm resolves pinned@1\.0\.0 \(< 1\.5\.0\)/);
  assert.match(lastCommit(), /^chore\(deps\): remove 1 obsolete override/);
});

test('an existing branch with its own commits is not touched: the run uses the next free name', () => {
  project = simpleProject();
  project.git('checkout', '-q', '-b', BRANCH);
  project.write('wip.txt', 'work in progress');
  project.git('add', 'wip.txt');
  project.git('commit', '-q', '-m', 'wip');
  project.git('checkout', '-q', 'main');

  const { status, output } = project.run(['--yes', '--branch', BRANCH]);
  assert.equal(status, 0, output);
  assert.equal(branch(), `${BRANCH}-2`);
  assert.equal(project.git('log', '-1', '--format=%s', BRANCH), 'wip');
});

test('started on another branch: reports only, unless told where to upgrade', () => {
  project = simpleProject();
  project.git('checkout', '-q', '-b', 'feature');

  const report = project.run([]);
  assert.equal(report.status, 0, report.output);
  assert.match(report.output, /Dependency report for feature/);
  assert.match(report.output, /No upgrade was done/);
  assert.equal(changedFiles(), '');

  const upgrade = project.run(['--on-current-branch', '--yes']);
  assert.equal(upgrade.status, 0, upgrade.output);
  assert.equal(branch(), 'feature');
  assert.match(lastCommit(), /^chore\(deps\): upgrade 2 packages/);
});

test('--auto retries a peer conflict together with the package npm names in it', () => {
  // alpha@2 needs lib-x@2, whose peer needs core@2: not visible from alpha's own peerDependencies.
  project = createProject({
    packageJson: { name: 'app', version: '1.0.0', private: true, scripts: { test: 'node check.js' }, dependencies: { alpha: '^1.0.0', core: '^1.0.0' } },
    registry: {
      alpha: { '1.0.0': {}, '2.0.0': { dependencies: { 'lib-x': '^2.0.0' } } },
      'lib-x': { '2.0.0': { peerDependencies: { core: '^2.0.0' } } },
      core: versions('1.0.0', '2.0.0'),
    },
    files: { 'check.js': failWhen('false') },
  });
  const { status, output } = project.run(['--auto', '--yes', '--branch', BRANCH]);

  assert.equal(status, 0, output);
  assert.match(output, /ERESOLVE/);
  assert.match(output, /attempt 2: together with core/);
  assert.match(output, /2 upgraded, 0 override\(s\) removed, 0 failed/);
  assert.deepEqual(project.readJson('package.json').dependencies, { alpha: '^2.0.0', core: '^2.0.0' });
  assert.match(lastCommit(), /^chore\(deps\): upgrade 2 packages/);
});

test('--auto retries a failed package together with packages from the same scope', () => {
  project = createProject({
    packageJson: {
      name: 'app',
      version: '1.0.0',
      private: true,
      scripts: { test: 'node check.js' },
      dependencies: { '@acme/theme': '^1.0.0', '@acme/ui': '^1.0.0' },
    },
    registry: { '@acme/theme': versions('1.0.0', '2.0.0'), '@acme/ui': versions('1.0.0', '2.0.0') },
    files: { 'check.js': failWhen("major('@acme/ui') !== major('@acme/theme')", 'theme and ui majors differ') },
  });
  const { status, output } = project.run(['--auto', '--yes', '--branch', BRANCH]);

  assert.equal(status, 0, output);
  assert.match(output, /theme and ui majors differ/, 'the first, single-package attempt fails');
  assert.match(output, /attempt 2: together with @acme\/ui/);
  assert.deepEqual(project.readJson('package.json').dependencies, { '@acme/theme': '^2.0.0', '@acme/ui': '^2.0.0' });
});

test('--auto falls back to a smaller upgrade and retries failures in a later pass', () => {
  project = simpleProject({
    // alpha 2 needs beta 1.1.0 (upgraded after it); gamma 2 never works, but 1.5.0 does.
    condition: "(major('alpha') >= 2 && v('beta') !== '1.1.0') || major('gamma') >= 2",
    packageJson: { dependencies: { alpha: '^1.0.0', gamma: '1.0.0' } }, // exact, so 1.5.0 isn't installed already
    registry: { gamma: versions('1.0.0', '1.5.0', '2.0.0') },
  });
  const { status, output } = project.run(['--auto', '--yes', '--branch', BRANCH]);

  assert.equal(status, 0, output);
  assert.match(output, /attempt 2: smaller upgrade: 1\.5\.0 instead of 2\.0\.0/);
  assert.match(output, /Pass 2: trying 1 failed or newly outdated upgrade\(s\) again/);
  assert.match(output, /3 upgraded, 0 override\(s\) removed, 0 failed/);
  assert.match(output, /gamma 1\.0\.0 → 1\.5\.0 {2}\(instead of 2\.0\.0\)/, 'the end report shows what was tried');
  assert.deepEqual(project.readJson('package.json').dependencies, { alpha: '^2.0.0', gamma: '1.5.0' });
  assert.match(lastCommit(), /\| `gamma` \| 1\.0\.0 \| 1\.5\.0 \|/);
});
