import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

export function identifyRepository(env, remote = '') {
  let repository = env.GITHUB_REPOSITORY;
  if (!repository) {
    try {
      const url = new URL(remote.replace(/^git@github\.com:/, 'https://github.com/'));
      if (url.hostname === 'github.com' && ['https:', 'ssh:'].includes(url.protocol)) {
        repository = url.pathname.slice(1).replace(/\.git$/, '');
      }
    } catch {}
    repository ||= env.UPDATE_GITHUB_REPOSITORY;
  }
  if (!repositoryPattern.test(repository || '')) {
    throw new Error('Cannot identify this GitHub checkout. Set UPDATE_GITHUB_REPOSITORY=OWNER/REPO.');
  }
  return repository;
}

export function selectAccount(configured, identity) {
  if (configured && /^[a-f0-9]{32}$/i.test(configured)) return configured;
  if (configured) throw new Error('Invalid CLOUDFLARE_ACCOUNT_ID.');
  const accounts = identity?.loggedIn && identity.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) {
    throw new Error('Set CLOUDFLARE_ACCOUNT_ID to the account that owns this Worker.');
  }
  return selectAccount(accounts[0].id);
}

function credentialHeaders(credential) {
  if (['api_token', 'oauth'].includes(credential.type) && credential.token) {
    return { Authorization: `Bearer ${credential.token}` };
  }
  if (credential.type === 'api_key' && credential.key && credential.email) {
    return { 'X-Auth-Key': credential.key, 'X-Auth-Email': credential.email };
  }
  throw new Error('Cloudflare authentication unavailable. Run npx wrangler login.');
}

export async function readDeployment(account, name, credential, request = fetch) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${encodeURIComponent(name)}`;
  async function get(path, allowMissing = false) {
    const response = await request(`${base}/${path}`, {
      headers: credentialHeaders(credential), signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json();
    if (allowMissing && response.status === 404 && body.errors?.some(error => error.code === 10007)) return null;
    if (!response.ok || body.success !== true) {
      throw new Error(`Cannot read Worker ${path} (HTTP ${response.status}); deployment stopped without changing credentials.`);
    }
    return body.result;
  }
  const secrets = await get('secrets', true);
  if (secrets === null) return { exists: false, hasInvitation: false, hasSession: false, workersDev: false, previews: false };
  if (!Array.isArray(secrets) || secrets.some(secret => typeof secret?.name !== 'string')) {
    throw new Error('Invalid Worker secrets response; deployment stopped.');
  }
  const subdomain = await get('subdomain');
  if (typeof subdomain?.enabled !== 'boolean' || typeof subdomain?.previews_enabled !== 'boolean') {
    throw new Error('Invalid Worker subdomain response; deployment stopped.');
  }
  return {
    exists: true, hasInvitation: secrets.some(secret => secret.name === 'INVITATION_SECRET'),
    hasSession: secrets.some(secret => secret.name === 'SESSION_SECRET'),
    workersDev: subdomain.enabled, previews: subdomain.previews_enabled,
  };
}

export function invitationFor(state, supplied) {
  if (state.hasInvitation) return undefined;
  const value = supplied || randomBytes(32).toString('hex');
  if (typeof value !== 'string' || value.length < 32 || /[\r\n]/.test(value)) {
    throw new Error('INVITATION_SECRET must contain at least 32 random characters.');
  }
  return value;
}

export function sessionFor(state, supplied) {
  if (state.hasSession) return undefined;
  const value = supplied || randomBytes(32).toString('hex');
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new Error('SESSION_SECRET must contain 64 random hexadecimal characters.');
  return value;
}

export function deploymentConfig(source, { name, repository, account }) {
  const config = structuredClone(source);
  delete config.env;
  // Omitted routes preserve domains managed in the Cloudflare dashboard.
  delete config.routes;
  delete config.route;
  delete config.account_id;
  for (const key of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'ADMIN_GITHUB_IDS', 'SESSION_SECRET', 'ACCESS_TEAM_DOMAIN', 'ACCESS_PANEL_AUD', 'ACCESS_AGENT_AUD', 'ADMIN_EMAILS']) {
    delete config.vars[key];
  }
  Object.assign(config, {
    // Source configuration controls public URLs, including on existing Workers.
    name, keep_vars: true, workers_dev: source.workers_dev ?? false, preview_urls: source.preview_urls ?? false,
    main: resolve(root, source.main),
    assets: { ...source.assets, directory: resolve(root, source.assets.directory) },
  });
  if (account) config.account_id = account;
  Object.assign(config.vars, { UPDATE_GITHUB_REPOSITORY: repository, LOCAL_DEV: 'false' });
  return config;
}

function wranglerJSON(args) {
  try {
    return JSON.parse(execFileSync(process.execPath, [wrangler, ...args, '--json'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
    }));
  } catch {
    // Credential commands may include secrets in their output: never echo it.
    throw new Error('Cannot read Cloudflare credentials. Run npx wrangler login, or check the Workers Builds token.');
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  if (args.some(arg => arg !== '--dry-run')) throw new Error('Usage: npm run deploy [-- --dry-run]');
  const dry = args.includes('--dry-run');
  const source = JSON.parse(await readFile(resolve(root, 'wrangler.jsonc'), 'utf8'));
  const name = env.WORKER_NAME || source.name;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error('Invalid WORKER_NAME.');
  let remote = '';
  try {
    remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {}
  const repository = identifyRepository(env, remote);
  let account;
  let state = { exists: false, hasInvitation: false, hasSession: false, workersDev: false, previews: false };
  if (!dry) {
    const configured = env.CLOUDFLARE_ACCOUNT_ID || source.account_id;
    account = selectAccount(configured, configured ? undefined : wranglerJSON(['whoami']));
    const credential = env.CLOUDFLARE_API_TOKEN
      ? { type: 'api_token', token: env.CLOUDFLARE_API_TOKEN }
      : wranglerJSON(['auth', 'token']);
    state = await readDeployment(account, name, credential);
  }
  // Build the same panel for local previews and every production deployment.
  const panelBuild = spawnSync(process.execPath, [resolve(root, 'ui/node_modules/vue-tsc/bin/vue-tsc.js'), '--noEmit'], { cwd: resolve(root, 'ui'), stdio: 'inherit', env });
  if (panelBuild.error || panelBuild.status !== 0) throw new Error('Panel type check failed.');
  const panelBundle = spawnSync(process.execPath, [resolve(root, 'ui/node_modules/vite/bin/vite.js'), 'build'], { cwd: resolve(root, 'ui'), stdio: 'inherit', env });
  if (panelBundle.error || panelBundle.status !== 0) throw new Error('Panel build failed.');
  const config = deploymentConfig(source, { name, repository, account });
  const invitation = invitationFor(state, env.INVITATION_SECRET);
  const session = sessionFor(state, env.SESSION_SECRET);
  const tempRoot = resolve(root, '.tmp');
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const temp = await mkdtemp(resolve(tempRoot, 'deploy-'));
  try {
    const configFile = resolve(temp, 'wrangler.json');
    await writeFile(configFile, JSON.stringify(config, null, 2), { mode: 0o600 });
    const command = [wrangler, 'deploy', '--config', configFile, '--keep-vars'];
    if (invitation || session) {
      const secretFile = resolve(temp, 'secrets.json');
      await writeFile(secretFile, JSON.stringify({ ...(invitation ? { INVITATION_SECRET: invitation } : {}), ...(session ? { SESSION_SECRET: session } : {}) }), { mode: 0o600 });
      command.push('--secrets-file', secretFile);
    }
    if (dry) command.push('--dry-run', '--outdir', resolve(root, 'dist'));
    console.log(`SpiderWatch: ${repository} → ${name}`);
    const result = spawnSync(process.execPath, command, { cwd: root, stdio: 'inherit', env });
    if (result.error || result.status !== 0) throw new Error('Cloudflare deployment failed.');
    console.log(dry ? 'Deployment package verified; nothing uploaded.'
      : 'Deployed. Configure GitHub login in Cloudflare, then open your panel.');
  } finally {
    // Only the unique directory created by this invocation is removed.
    await rm(temp, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
