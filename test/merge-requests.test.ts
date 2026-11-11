import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApiRequest, detectProvider, parseApiResponse, parseRemoteUrl } from '../lib/merge-requests.ts';

test('parseRemoteUrl handles scp-style, ssh:// and https remotes', () => {
  assert.deepEqual(parseRemoteUrl('git@github.com:acme/app.git'), { host: 'github.com', path: 'acme/app' });
  assert.deepEqual(parseRemoteUrl('ssh://git@gitlab.acme.io:2222/team/sub/app.git'), {
    host: 'gitlab.acme.io',
    path: 'team/sub/app',
  });
  assert.deepEqual(parseRemoteUrl('https://gitlab.acme.io/team/app'), { host: 'gitlab.acme.io', path: 'team/app' });
  assert.equal(parseRemoteUrl('/srv/git/app.git'), null);
  assert.equal(parseRemoteUrl(''), null);
});

test('detectProvider recognises hosts and honours overrides', () => {
  assert.equal(detectProvider('github.com', { env: {} }), 'github');
  assert.equal(detectProvider('gitlab.com', { env: {} }), 'gitlab');
  assert.equal(detectProvider('gitlab.internal.acme.io', { env: {} }), 'gitlab');
  assert.equal(detectProvider('code.acme.io', { env: { GITLAB_HOST: 'code.acme.io' } }), 'gitlab');
  assert.equal(detectProvider('code.acme.io', { env: {} }), null);
  assert.equal(detectProvider('code.acme.io', { override: 'gitlab', env: {} }), 'gitlab');
});

test('buildApiRequest builds GitHub and GitLab queries for the source branch', () => {
  const gh = buildApiRequest('github', { host: 'github.com', path: 'acme/app', branch: 'chore/deps' });
  assert.equal(gh.url, 'https://api.github.com/repos/acme/app/pulls?state=open&head=acme%3Achore%2Fdeps');
  assert.equal(gh.cliPath, 'repos/acme/app/pulls?state=open&head=acme%3Achore%2Fdeps');
  assert.deepEqual(gh.authHeader('t'), { Authorization: 'Bearer t', Accept: 'application/vnd.github+json' });

  const ghe = buildApiRequest('github', { host: 'git.acme.io', path: 'acme/app', branch: 'x' });
  assert.match(ghe.url, /^https:\/\/git\.acme\.io\/api\/v3\//);

  const gl = buildApiRequest('gitlab', { host: 'gitlab.acme.io', path: 'team/sub/app', branch: 'chore/deps' });
  assert.equal(
    gl.url,
    'https://gitlab.acme.io/api/v4/projects/team%2Fsub%2Fapp/merge_requests?state=opened&source_branch=chore%2Fdeps',
  );
  assert.deepEqual(gl.authHeader('t'), { 'PRIVATE-TOKEN': 't' });
});

test('parseApiResponse normalises both providers', () => {
  assert.deepEqual(parseApiResponse('github', [{ number: 2, html_url: 'https://gh/pr/2', title: 'Deps' }]), [
    { id: '#2', url: 'https://gh/pr/2', title: 'Deps' },
  ]);
  assert.deepEqual(parseApiResponse('gitlab', [{ iid: 12, web_url: 'https://gl/mr/12', title: 'Deps' }]), [
    { id: '!12', url: 'https://gl/mr/12', title: 'Deps' },
  ]);
  assert.deepEqual(parseApiResponse('gitlab', []), []);
  assert.throws(() => parseApiResponse('github', { message: 'Not Found' }));
});
