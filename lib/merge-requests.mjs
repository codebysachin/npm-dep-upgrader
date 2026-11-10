/**
 * Finds open merge requests (GitLab) / pull requests (GitHub) whose source is a given branch,
 * so the script never deletes a branch that an open MR still depends on.
 *
 * Ways to ask the host, tried in order:
 *   1. the host's own CLI (`gh` / `glab`) if it is installed and logged in, and
 *   2. the host's REST API via Node's built-in fetch, with a token from the environment
 *      (GITHUB_TOKEN / GH_TOKEN, GITLAB_TOKEN / GITLAB_PRIVATE_TOKEN).
 * The token is only ever sent to the host of the project's own git remote.
 */
import { run } from './exec.mjs';

const TIMEOUT_MS = 15_000;

/**
 * @typedef {object} MergeRequestLookup
 * @property {'open'|'none'|'unknown'} status
 * @property {Array<{ id: string, url: string, title: string }>} items  open MRs (status "open")
 * @property {string} [reason]  why the lookup could not be done (status "unknown")
 */

/**
 * "git@host:group/repo.git", "ssh://git@host:22/group/repo.git", "https://host/group/repo.git"
 * → { host: "host", path: "group/repo" }
 */
export function parseRemoteUrl(url) {
  const text = String(url).trim();
  const scp = /^[\w.-]+@([^:/]+):(.+?)(?:\.git)?\/?$/.exec(text);
  if (scp && !text.includes('://')) return { host: scp[1], path: scp[2] };
  try {
    const parsed = new URL(text);
    const path = parsed.pathname.replace(/^\/+/, '').replace(/\.git\/?$/, '').replace(/\/+$/, '');
    return parsed.hostname && path ? { host: parsed.hostname, path } : null;
  } catch {
    return null;
  }
}

/** @returns {'github'|'gitlab'|null} */
export function detectProvider(host, { override, env = process.env } = {}) {
  if (override) return override;
  const lower = host.toLowerCase();
  if (lower === 'github.com' || lower === env.GH_HOST?.toLowerCase()) return 'github';
  if (lower.includes('gitlab') || [env.GITLAB_HOST, env.CI_SERVER_HOST].some((h) => h && lower === h.toLowerCase())) {
    return 'gitlab';
  }
  return null;
}

/** API request for open MRs from `branch`, for the given provider. */
export function buildApiRequest(provider, { host, path, branch }) {
  if (provider === 'github') {
    const [owner] = path.split('/');
    const query = `state=open&head=${encodeURIComponent(`${owner}:${branch}`)}`;
    return {
      cliPath: `repos/${path}/pulls?${query}`,
      url: `${host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`}/repos/${path}/pulls?${query}`,
      tokenEnv: ['GITHUB_TOKEN', 'GH_TOKEN'],
      authHeader: (token) => ({ Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' }),
    };
  }
  const query = `state=opened&source_branch=${encodeURIComponent(branch)}`;
  const project = encodeURIComponent(path);
  return {
    cliPath: `projects/${project}/merge_requests?${query}`,
    url: `https://${host}/api/v4/projects/${project}/merge_requests?${query}`,
    tokenEnv: ['GITLAB_TOKEN', 'GITLAB_PRIVATE_TOKEN'],
    authHeader: (token) => ({ 'PRIVATE-TOKEN': token }),
  };
}

/** Normalises the API's JSON array into { id, url, title } items. */
export function parseApiResponse(provider, body) {
  if (!Array.isArray(body)) throw new Error('unexpected API response');
  return body.map((mr) =>
    provider === 'github'
      ? { id: `#${mr.number}`, url: mr.html_url, title: mr.title }
      : { id: `!${mr.iid}`, url: mr.web_url, title: mr.title },
  );
}

/**
 * @param {string} cwd
 * @param {object} params
 * @param {string} params.remote     git remote name, e.g. "origin"
 * @param {string} params.branch
 * @param {'github'|'gitlab'} [params.provider]  overrides detection from the remote URL
 * @returns {Promise<MergeRequestLookup>}
 */
export async function findOpenMergeRequests(cwd, { remote, branch, provider: override }) {
  const remoteUrl = run('git', ['remote', 'get-url', remote], { cwd, allowFailure: true }).stdout.trim();
  const location = parseRemoteUrl(remoteUrl);
  if (!location) return unknown(`could not read the host from remote URL "${remoteUrl}"`);

  const provider = detectProvider(location.host, { override });
  if (!provider) {
    return unknown(`"${location.host}" is not recognised as GitHub or GitLab (pass --git-host github|gitlab)`);
  }

  const request = buildApiRequest(provider, { ...location, branch });
  const attempts = [];

  const cli = provider === 'github' ? 'gh' : 'glab';
  const viaCli = askCli(cli, request.cliPath, location.host, cwd);
  if (viaCli.ok) return found(provider, viaCli.body);
  attempts.push(viaCli.reason);

  const tokenName = request.tokenEnv.find((name) => process.env[name]);
  if (tokenName) {
    const viaApi = await askApi(request, process.env[tokenName]);
    if (viaApi.ok) return found(provider, viaApi.body);
    attempts.push(`${tokenName}: ${viaApi.reason}`);
  } else {
    attempts.push(`no ${request.tokenEnv.join(' or ')} set`);
  }

  return unknown(`could not check ${provider === 'github' ? 'pull requests' : 'merge requests'} (${attempts.join('; ')})`);
}

function askCli(cli, apiPath, host, cwd) {
  let result;
  try {
    result = run(cli, ['api', '--hostname', host, apiPath], { cwd, allowFailure: true, timeoutMs: TIMEOUT_MS });
  } catch {
    return { ok: false, reason: `${cli} not installed` };
  }
  if (!result.ok) return { ok: false, reason: `${cli}: ${firstLine(result.stderr) || 'request failed'}` };
  try {
    return { ok: true, body: JSON.parse(result.stdout) };
  } catch {
    return { ok: false, reason: `${cli}: unreadable response` };
  }
}

async function askApi(request, token) {
  try {
    const response = await fetch(request.url, {
      headers: request.authHeader(token),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, reason: `HTTP ${response.status}` };
    return { ok: true, body: await response.json() };
  } catch (error) {
    return { ok: false, reason: error.name === 'TimeoutError' ? 'timed out' : error.message };
  }
}

function found(provider, body) {
  try {
    const items = parseApiResponse(provider, body);
    return { status: items.length ? 'open' : 'none', items };
  } catch (error) {
    return unknown(error.message);
  }
}

const unknown = (reason) => ({ status: 'unknown', items: [], reason });
const firstLine = (text) => String(text).trim().split('\n')[0];
