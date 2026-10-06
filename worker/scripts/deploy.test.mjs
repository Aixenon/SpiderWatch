import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import childProcess from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploymentConfig, identifyRepository, invitationFor, sessionFor, main as deployMain, readDeployment, selectAccount } from './deploy.mjs';
import { makeClientReleaseFixture } from './client-assets-fixture.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const account = 'a'.repeat(32);
const credential = { type: 'api_token', token: 'fixture-api-token' };
const newState = { exists: false, hasInvitation: false, hasSession: false, workersDev: false, previews: false };
const existingState = { exists: true, hasInvitation: true, hasSession: true, workersDev: false, previews: false };
const success = result => Response.json({ success: true, result });
let fixtureDirectory, releaseDirectory, assetsDirectory;
const main = (args = [], env = {}) => deployMain(args, { SPIDER_RELEASE_DIR: releaseDirectory, ...env }, { assetsDirectory });

beforeEach(async () => {
  fixtureDirectory = await mkdtemp(resolve(tmpdir(), 'spider-watch-deploy-test-'));
  releaseDirectory = resolve(fixtureDirectory, 'release');
  assetsDirectory = resolve(fixtureDirectory, 'assets');
  await makeClientReleaseFixture(releaseDirectory);
  // Every network and subprocess boundary is closed unless a test supplies a fake.
  mock.method(globalThis, 'fetch', async () => { throw new Error('Unexpected network access'); });
  mock.method(childProcess, 'execFileSync', () => { throw new Error('Unexpected subprocess'); });
  mock.method(childProcess, 'spawnSync', () => { throw new Error('Unexpected deployment'); });
  syncBuiltinESMExports();
});
afterEach(async () => { mock.restoreAll(); syncBuiltinESMExports(); await rm(fixtureDirectory, { recursive: true, force: true }); });

test('uses the current checkout repository after a fork and accepts GitHub checkout URL forms', () => {
  assert.equal(identifyRepository({ GITHUB_REPOSITORY: 'fork/SpiderWatch', UPDATE_GITHUB_REPOSITORY: 'stale/old' }, 'https://github.com/upstream/old.git'), 'fork/SpiderWatch');
  for (const remote of [
    'https://github.com/owner/SpiderWatch.git', 'git@github.com:owner/SpiderWatch.git',
    'ssh://git@github.com/owner/SpiderWatch.git', 'https://checkout:fixture@github.com/owner/SpiderWatch',
  ]) assert.equal(identifyRepository({}, remote), 'owner/SpiderWatch');
  assert.equal(identifyRepository({ UPDATE_GITHUB_REPOSITORY: 'owner/fallback' }), 'owner/fallback');
});

test('rejects invalid repository identities instead of silently reusing an old repository', () => {
  for (const repository of ['owner', '../repository', 'owner/repo/extra', 'owner/repo?token=fixture', ' owner/repo']) {
    assert.throws(() => identifyRepository({ GITHUB_REPOSITORY: repository }, 'https://github.com/valid/repo'), /Cannot identify/);
  }
  for (const remote of ['https://github.com.example.test/owner/repo', 'https://example.test/owner/repo', 'file:///owner/repo']) {
    assert.throws(() => identifyRepository({}, remote), /Cannot identify/);
  }
});

test('selects only an explicit valid account or an unambiguous authenticated account', () => {
  assert.equal(selectAccount(account), account);
  assert.equal(selectAccount(undefined, { loggedIn: true, accounts: [{ id: account }] }), account);
  assert.throws(() => selectAccount('not-an-account', { loggedIn: true, accounts: [{ id: account }] }), /Invalid/);
  for (const identity of [undefined, { loggedIn: false, accounts: [{ id: account }] }, { loggedIn: true, accounts: [] },
    { loggedIn: true, accounts: [{ id: account }, { id: 'b'.repeat(32) }] }, { loggedIn: true, accounts: [{ id: 'invalid' }] }]) {
    assert.throws(() => selectAccount(undefined, identity), /CLOUDFLARE_ACCOUNT_ID/);
  }
});

test('treats only the Worker-not-found response as a first deployment', async () => {
  const calls = [];
  const state = await readDeployment(account, 'spider-watch', credential, async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer fixture-api-token');
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
  });
  assert.deepEqual(state, newState);
  assert.deepEqual(calls, [`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/spider-watch/secrets`]);
});

test('reads existing secret names and domain switches without retrieving secret values', async () => {
  for (const workersDev of [false, true]) for (const previews of [false, true]) {
    const calls = [];
    const state = await readDeployment(account, 'spider-watch', credential, async (url, options) => {
      calls.push(url);
      assert.equal(options.method, undefined);
      assert.equal(options.body, undefined);
      return url.endsWith('/secrets')
        ? success([{ name: 'OTHER_SECRET', type: 'secret_text' }, { name: 'INVITATION_SECRET', type: 'secret_text' }])
        : success({ enabled: workersDev, previews_enabled: previews });
    });
    assert.deepEqual(state, { exists: true, hasInvitation: true, hasSession: false, workersDev, previews });
    assert.equal(calls.length, 2);
    assert.ok(calls[1].endsWith('/subdomain'));
    assert.equal(invitationFor(state, 'a replacement must not overwrite the existing secret'), undefined);
  }
});

test('supports Wrangler token, OAuth and API key credential JSON without mixing authentication headers', async () => {
  for (const [auth, expected] of [
    [credential, { Authorization: 'Bearer fixture-api-token' }],
    [{ type: 'oauth', token: 'fixture-oauth' }, { Authorization: 'Bearer fixture-oauth' }],
    [{ type: 'api_key', key: 'fixture-key', email: 'owner@example.test' }, { 'X-Auth-Key': 'fixture-key', 'X-Auth-Email': 'owner@example.test' }],
  ]) {
    const state = await readDeployment(account, 'spider-watch', auth, async (url, options) => {
      assert.deepEqual(options.headers, expected);
      return url.endsWith('/secrets') ? success([]) : success({ enabled: true, previews_enabled: false });
    });
    assert.deepEqual(state, { ...newState, exists: true, workersDev: true });
  }
  let requested = false;
  await assert.rejects(readDeployment(account, 'spider-watch', { type: 'api_token' }, async () => { requested = true; }), /authentication unavailable/);
  assert.equal(requested, false);
});

test('stops on denied, malformed or unavailable deployment metadata instead of regenerating credentials', async () => {
  for (const response of [
    Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 403 }),
    Response.json({ success: false, errors: [{ code: 10000 }] }, { status: 404 }),
    Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 500 }),
    Response.json({ success: false, result: [] }), success({}), success([{ type: 'secret_text' }]),
    new Response('unavailable', { status: 502 }),
  ]) await assert.rejects(readDeployment(account, 'spider-watch', credential, async () => response));
  for (const result of [{ enabled: false }, { enabled: 'false', previews_enabled: false }, null]) {
    await assert.rejects(readDeployment(account, 'spider-watch', credential, async url => url.endsWith('/secrets') ? success([]) : success(result)), /Invalid Worker subdomain/);
  }
  await assert.rejects(readDeployment(account, 'spider-watch', credential, async () => { throw new Error('fixture connection failed'); }), /connection failed/);
});

test('generates an invitation secret only when absent and never replaces an existing one', () => {
  const first = invitationFor(newState), second = invitationFor(newState);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.match(second, /^[a-f0-9]{64}$/);
  assert.notEqual(first, second);
  const supplied = 'fixture-invitation-secret-'.repeat(2);
  assert.equal(invitationFor(newState, supplied), supplied);
  for (const invalid of ['short', 'x'.repeat(32) + '\n', 123]) assert.throws(() => invitationFor(newState, invalid), /INVITATION_SECRET/);
  for (const supplied of [undefined, 'short', 'x'.repeat(64)]) assert.equal(invitationFor(existingState, supplied), undefined);
});

test('keeps dashboard-managed settings out of the upload and preserves durable bindings and source config', () => {
  const source = JSON.parse(readFileSync(resolve(root, 'wrangler.jsonc'), 'utf8'));
  source.routes = [{ pattern: 'old.example.test', custom_domain: true }];
  source.route = 'old.example.test/*';
  source.account_id = 'b'.repeat(32);
  Object.assign(source.vars, { GITHUB_CLIENT_ID: 'old-app', GITHUB_CLIENT_SECRET: 'old-secret', ADMIN_GITHUB_IDS: '12345', SESSION_SECRET: 'a'.repeat(64), ACCESS_TEAM_DOMAIN: 'old.cloudflareaccess.com', ACCESS_PANEL_AUD: 'old-aud', ACCESS_AGENT_AUD: 'old-agent-aud', ADMIN_EMAILS: 'old@example.test' });
  const original = structuredClone(source);
  const config = deploymentConfig(source, { name: 'spider-watch', repository: 'fork/SpiderWatch', account });
  assert.deepEqual(source, original);
  for (const key of ['env', 'routes', 'route']) assert.equal(Object.hasOwn(config, key), false);
  for (const key of ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'ADMIN_GITHUB_IDS', 'SESSION_SECRET', 'ACCESS_TEAM_DOMAIN', 'ACCESS_PANEL_AUD', 'ACCESS_AGENT_AUD', 'ADMIN_EMAILS']) assert.equal(Object.hasOwn(config.vars, key), false);
  assert.equal(config.keep_vars, true);
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
  assert.equal(config.account_id, account);
  assert.equal(config.vars.UPDATE_GITHUB_REPOSITORY, 'fork/SpiderWatch');
  assert.equal(config.vars.LOCAL_DEV, 'false');
  assert.equal(config.vars.MONITOR_GROUP, original.vars.MONITOR_GROUP);
  assert.deepEqual(config.durable_objects, original.durable_objects);
  assert.deepEqual(config.migrations, original.migrations);
  assert.deepEqual(config.assets.run_worker_first, ['/*', '!/install.sh', '!/downloads/*']);
  assert.equal(config.main, resolve(root, source.main));
  assert.equal(config.assets.directory, resolve(root, source.assets.directory));
  assert.ok(isAbsolute(config.main) && isAbsolute(config.assets.directory));
});

test('uses explicit source URL switches and defaults omitted switches to disabled', () => {
  for (const workersDev of [undefined, false, true]) for (const previews of [undefined, false, true]) {
    const source = JSON.parse(readFileSync(resolve(root, 'wrangler.jsonc'), 'utf8'));
    if (workersDev === undefined) delete source.workers_dev;
    else source.workers_dev = workersDev;
    if (previews === undefined) delete source.preview_urls;
    else source.preview_urls = previews;
    const config = deploymentConfig(source, { name: 'spider-watch', repository: 'fork/SpiderWatch', account });
    assert.equal(config.workers_dev, workersDev ?? false);
    assert.equal(config.preview_urls, previews ?? false);
  }
});

function fakeDeployment({ secrets = [{ name: 'INVITATION_SECRET' }, { name: 'SESSION_SECRET' }], exists = true, workersDev = false, previews = false, status = 0, error, authError = false, apiStatus = 200, panelStatus = 0, clientStatus = 0, name = 'spider-watch' } = {}) {
  const calls = [], uploads = [], logs = [], panelBuilds = [], clientBuilds = [];
  mock.method(console, 'log', value => logs.push(String(value)));
  mock.method(childProcess, 'execFileSync', (command, args) => {
    calls.push([command, args]);
    if (command === 'git') return args[0] === 'rev-parse' ? 'a'.repeat(40) + '\n' : 'https://github.com/fixture/SpiderWatch.git\n';
    if (authError) throw new Error('fixture-sensitive-auth-output');
    if (args.includes('whoami')) return JSON.stringify({ loggedIn: true, accounts: [{ id: account }] });
    if (args.includes('token')) return JSON.stringify(credential);
    throw new Error('Unexpected credential command');
  });
  const request = mock.method(globalThis, 'fetch', async url => {
    assert.ok(url.startsWith(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/${name}/`));
    if (apiStatus !== 200) return Response.json({ success: false, errors: [{ code: 10000 }] }, { status: apiStatus });
    if (!exists) return Response.json({ success: false, errors: [{ code: 10007 }] }, { status: 404 });
    return url.endsWith('/secrets') ? success(secrets) : success({ enabled: workersDev, previews_enabled: previews });
  });
  const deploy = mock.method(childProcess, 'spawnSync', (_command, args) => {
    if (args[0].endsWith('build-clients.mjs')) {
      assert.equal(request.mock.callCount(), 0);
      clientBuilds.push(args);
      return { status: clientStatus };
    }
    if (args[0].includes('vue-tsc') || args[0].endsWith('vite.js')) {
      panelBuilds.push(args);
      return { status: panelStatus };
    }
    assert.equal(args[1], 'deploy');
    assert.ok(args.includes('--keep-vars'));
    const configFile = args[args.indexOf('--config') + 1];
    const upload = { args, directory: dirname(configFile), config: JSON.parse(readFileSync(configFile, 'utf8')) };
    if (args.includes('--secrets-file')) upload.secrets = JSON.parse(readFileSync(args[args.indexOf('--secrets-file') + 1], 'utf8'));
    uploads.push(upload);
    return { status, error };
  });
  syncBuiltinESMExports();
  return { calls, uploads, logs, request, deploy, panelBuilds, clientBuilds };
}

test('Workers Builds compiles the checkout and preserves the injected existing Worker name', async () => {
  const fixture = fakeDeployment({ name: 'existing-monitor' });
  await main([], { WORKERS_CI: '1', WORKERS_CI_COMMIT_SHA: 'a'.repeat(40), GITHUB_SHA: 'b'.repeat(40),
    WRANGLER_CI_OVERRIDE_NAME: 'existing-monitor', WORKER_NAME: 'ignored-name', GITHUB_REPOSITORY: 'fixture/SpiderWatch' });
  assert.deepEqual(fixture.clientBuilds, [[resolve(root, 'scripts/build-clients.mjs'), '--repository', 'fixture/SpiderWatch',
    '--revision', 'a'.repeat(40), '--output', releaseDirectory]]);
  assert.equal(fixture.uploads[0].config.name, 'existing-monitor');
  assert.equal(fixture.uploads[0].secrets, undefined);
});

test('a failed Cloudflare client build stops before authentication or deployment', async () => {
  const fixture = fakeDeployment({ clientStatus: 1 });
  await assert.rejects(main([], { WORKERS_CI: '1', GITHUB_REPOSITORY: 'fixture/SpiderWatch' }), /Client build failed/);
  assert.equal(fixture.request.mock.callCount(), 0);
  assert.equal(fixture.uploads.length, 0);
  assert.equal(fixture.panelBuilds.length, 0);
});

test('explicit local client builds also work in dry-run mode without Cloudflare credentials', async () => {
  const fixture = fakeDeployment();
  await main(['--dry-run', '--build-clients'], { GITHUB_REPOSITORY: 'fixture/SpiderWatch' });
  assert.equal(fixture.clientBuilds.length, 1);
  assert.equal(fixture.request.mock.callCount(), 0);
  assert.equal(fixture.uploads.length, 1);
});

test('redeployment keeps existing credentials and removes only its temporary deployment directory', async () => {
  const fixture = fakeDeployment();
  await main([], { GITHUB_REPOSITORY: 'fixture/SpiderWatch' });
  assert.equal(fixture.uploads.length, 1);
  assert.equal(fixture.panelBuilds.length, 2);
  assert.equal(fixture.uploads[0].config.assets.directory, assetsDirectory);
  const packaged = JSON.parse(readFileSync(resolve(assetsDirectory, 'downloads/current.json'), 'utf8'));
  assert.equal(packaged.files.length, 27);
  assert.equal(packaged.revision, 'a'.repeat(40));
  const upload = fixture.uploads[0];
  assert.equal(upload.secrets, undefined);
  assert.equal(upload.config.account_id, account);
  assert.equal(upload.config.workers_dev, false);
  assert.equal(upload.config.preview_urls, false);
  assert.equal(existsSync(upload.directory), false);
  assert.equal(fixture.request.mock.callCount(), 2);
  assert.ok(fixture.logs.every(line => !line.includes(credential.token)));
});

test('first deployment disables workers.dev and previews by default', async () => {
  const fixture = fakeDeployment({ exists: false });
  await main([], { GITHUB_REPOSITORY: 'fixture/SpiderWatch' });
  const upload = fixture.uploads[0];
  assert.equal(upload.config.workers_dev, false);
  assert.equal(upload.config.preview_urls, false);
  assert.deepEqual(Object.keys(upload.secrets), ['INVITATION_SECRET', 'SESSION_SECRET']);
  assert.equal(fixture.request.mock.callCount(), 1);
});

test('redeployment disables remotely enabled URLs according to the source defaults', async () => {
  const fixture = fakeDeployment({ workersDev: true, previews: true });
  await main([], { GITHUB_REPOSITORY: 'fixture/SpiderWatch' });
  const upload = fixture.uploads[0];
  assert.equal(upload.config.workers_dev, false);
  assert.equal(upload.config.preview_urls, false);
  assert.equal(upload.secrets, undefined);
  assert.equal(upload.config.keep_vars, true);
});

test('uploads independent invitation and session secrets only when absent', async () => {
  const fixture = fakeDeployment({ secrets: [{ name: 'UNRELATED_SECRET' }] });
  await main([], { GITHUB_REPOSITORY: 'fixture/SpiderWatch', CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: credential.token });
  assert.equal(fixture.calls.length, 2); // Only checkout lookups; credentials are already supplied.
  const upload = fixture.uploads[0];
  assert.deepEqual(Object.keys(upload.secrets), ['INVITATION_SECRET', 'SESSION_SECRET']);
  assert.match(upload.secrets.INVITATION_SECRET, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(upload.directory), false);
  assert.ok(fixture.logs.every(line => !line.includes(upload.secrets.INVITATION_SECRET)));
});

test('cleans temporary credentials after Wrangler fails', async () => {
  const fixture = fakeDeployment({ secrets: [], status: 1 });
  await assert.rejects(main([], { GITHUB_REPOSITORY: 'fixture/SpiderWatch' }), /Cloudflare deployment failed/);
  assert.match(fixture.uploads[0].secrets.INVITATION_SECRET, /^[a-f0-9]{64}$/);
  assert.equal(existsSync(fixture.uploads[0].directory), false);
});

test('upgrading an existing deployment adds only the missing session secret', async () => {
  const fixture = fakeDeployment({ secrets: [{ name: 'INVITATION_SECRET' }, { name: 'GITHUB_CLIENT_SECRET' }] });
  await main([], { GITHUB_REPOSITORY: 'fixture/SpiderWatch' });
  assert.deepEqual(Object.keys(fixture.uploads[0].secrets), ['SESSION_SECRET']);
  assert.match(fixture.uploads[0].secrets.SESSION_SECRET, /^[a-f0-9]{64}$/);
  assert.ok(fixture.logs.every(line => !line.includes(fixture.uploads[0].secrets.SESSION_SECRET)));
});

test('generates independent session keys and never overwrites an existing session secret', () => {
  const first = sessionFor(newState), second = sessionFor(newState);
  assert.match(first, /^[a-f0-9]{64}$/); assert.notEqual(first, second);
  assert.equal(sessionFor(newState, 'f'.repeat(64)), 'f'.repeat(64));
  for (const invalid of ['short', 'z'.repeat(64), 'a'.repeat(64) + '\n', 123]) assert.throws(() => sessionFor(newState, invalid), /SESSION_SECRET/);
  assert.equal(sessionFor(existingState, 'do-not-replace'), undefined);
});

test('credential and metadata failures stop before deployment and do not print credential command output', async () => {
  const fixture = fakeDeployment({ authError: true });
  await assert.rejects(main([], { GITHUB_REPOSITORY: 'fixture/SpiderWatch' }), error => {
    assert.match(error.message, /Cannot read Cloudflare credentials/);
    assert.ok(!error.message.includes('fixture-sensitive-auth-output'));
    return true;
  });
  assert.equal(fixture.deploy.mock.callCount(), 0);
  assert.equal(fixture.request.mock.callCount(), 0);
});

test('metadata permission failures never fall through to a first deployment', async () => {
  const fixture = fakeDeployment({ apiStatus: 403 });
  await assert.rejects(main([], { GITHUB_REPOSITORY: 'fixture/SpiderWatch', CLOUDFLARE_ACCOUNT_ID: account, CLOUDFLARE_API_TOKEN: credential.token }), /deployment stopped/);
  assert.equal(fixture.deploy.mock.callCount(), 0);
});

test('dry run does not read account credentials or make Cloudflare requests', async () => {
  const fixture = fakeDeployment();
  await main(['--dry-run'], { GITHUB_REPOSITORY: 'fixture/SpiderWatch' });
  assert.equal(fixture.calls.length, 2);
  assert.equal(fixture.calls[0][0], 'git');
  assert.equal(fixture.request.mock.callCount(), 0);
  assert.ok(fixture.uploads[0].args.includes('--dry-run'));
  assert.equal(fixture.uploads[0].config.account_id, undefined);
  assert.equal(fixture.uploads[0].config.workers_dev, false);
  assert.equal(fixture.uploads[0].config.preview_urls, false);
  assert.equal(existsSync(fixture.uploads[0].directory), false);
});

test('rejects unsupported arguments and invalid names before any deployment', async () => {
  await assert.rejects(main(['--production']), /Usage/);
  await assert.rejects(main([], { WORKER_NAME: '../other-worker' }), /Invalid WORKER_NAME/);
  assert.equal(globalThis.fetch.mock.callCount(), 0);
  assert.equal(childProcess.spawnSync.mock.callCount(), 0);
});

test('a failed panel build cannot publish stale assets', async () => {
  const fixture = fakeDeployment({ panelStatus: 1 });
  await assert.rejects(main(['--dry-run'], { GITHUB_REPOSITORY: 'fixture/SpiderWatch' }), /Panel type check failed/);
  assert.equal(fixture.uploads.length, 0);
  assert.equal(fixture.request.mock.callCount(), 0);
});

test('an incomplete client build cannot authenticate, build or deploy a partial update', async () => {
  const fixture = fakeDeployment();
  await rm(resolve(releaseDirectory, 'spider-watch-windows-amd64-setup.exe'));
  await assert.rejects(main([], { GITHUB_REPOSITORY: 'fixture/SpiderWatch' }), /Missing client artifact/);
  assert.equal(fixture.request.mock.callCount(), 0);
  assert.equal(fixture.deploy.mock.callCount(), 0);
  assert.equal(fixture.calls.length, 2);
});

test('local deployment checks the checkout commit instead of trusting an older artifact', async () => {
  const fixture = fakeDeployment();
  await makeClientReleaseFixture(releaseDirectory, { revision: 'b'.repeat(40) });
  await assert.rejects(main([], { GITHUB_REPOSITORY: 'fixture/SpiderWatch' }), /different source commit/);
  assert.equal(fixture.request.mock.callCount(), 0);
  assert.equal(fixture.deploy.mock.callCount(), 0);
  assert.deepEqual(fixture.calls[1][1], ['rev-parse', 'HEAD']);
});

test('CI uses its exact source commit and refuses malformed revision values before deployment', async () => {
  const fixture = fakeDeployment();
  await main(['--dry-run'], { GITHUB_REPOSITORY: 'fixture/SpiderWatch', GITHUB_SHA: 'a'.repeat(40) });
  assert.equal(fixture.calls.length, 1);
  await assert.rejects(main([], { GITHUB_REPOSITORY: 'fixture/SpiderWatch', GITHUB_SHA: 'main' }), /Cannot identify the source commit/);
  assert.equal(fixture.request.mock.callCount(), 0);
});
