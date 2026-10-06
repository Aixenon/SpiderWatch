import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { main, resolveGoToolchain } from './build-clients.mjs';
import { makeClientReleaseFixture } from './client-assets-fixture.mjs';

const revision = 'b'.repeat(40);
const repository = 'example/PrivateMonitor';
const value = (args, key) => args[args.indexOf(key) + 1];
const toolchainRoot = resolve(tmpdir(), 'go1.26.0');
const goEnvironment = JSON.stringify({ GOROOT: toolchainRoot, GOVERSION: 'go1.26.0' });

async function fixture(t) {
  const directory = await mkdtemp(resolve(tmpdir(), 'spider-native-build-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = resolve(directory, 'dist');
  return { directory, output, argv: ['--repository', repository, '--revision', revision, '--output', output], env: { SPIDER_BUILD_CACHE: resolve(directory, 'cache') } };
}

test('builds all targets with at most two jobs and publishes only a complete verified release', async t => {
  const f = await fixture(t);
  const calls = [];
  let active = 0, peak = 0;
  const runner = async (command, args, options) => {
    calls.push({ command, args, env: { ...options.env } });
    if (args[0] === 'env') return goEnvironment;
    if (args[0]?.endsWith('bootstrap_nsis.py')) return JSON.stringify({ compiler: '/tools/bin/makensis', directory: '/tools/nsis' });
    if (args.includes('--target')) {
      active++; peak = Math.max(peak, active);
      await new Promise(accept => setTimeout(accept, 1));
      active--;
    }
    if (args.includes('--assemble')) await makeClientReleaseFixture(value(args, '--output'), { repository, revision, version: value(args, '--version') });
    return '';
  };
  const release = await main(f.argv, { env: f.env, run: runner });
  assert.equal(peak, 2);
  const targets = calls.filter(call => call.args.includes('--target'));
  assert.equal(new Set(targets.map(call => value(call.args, '--target'))).size, 19);
  for (const call of targets) {
    assert.equal(call.env.GOTOOLCHAIN, 'local');
    assert.equal(call.env.GO, resolve(toolchainRoot, 'bin', process.platform === 'win32' ? 'go.exe' : 'go'));
    assert.equal(call.env.GOROOT, toolchainRoot);
    assert.equal(call.env.GOMAXPROCS, '1');
    assert.equal(call.env.GOFLAGS, '-p=1');
    assert.equal(call.env.GOCACHE, resolve(f.directory, 'cache/go-build'));
    assert.equal(value(call.args, '--revision'), revision);
  }
  const installers = calls.filter(call => call.args[0]?.endsWith('build-installer.py'));
  assert.deepEqual(installers.map(call => value(call.args, '--arch')), ['amd64', 'arm64', '386']);
  assert.ok(calls.indexOf(installers[0]) > calls.indexOf(targets.at(-1)));
  assert.equal(release.files.length, 27);
  assert.equal(JSON.parse(await readFile(resolve(f.output, 'release-info.json'), 'utf8')).repository, repository);
  assert.deepEqual(await readdir(f.directory), ['.tmp', 'dist']);
  assert.deepEqual(await readdir(resolve(f.directory, '.tmp')), []);
});

test('failed compiler preserves the previous release and skips installers and assembly', async t => {
  const f = await fixture(t);
  await makeClientReleaseFixture(f.output);
  const before = await readFile(resolve(f.output, 'release-info.json'), 'utf8');
  const calls = [];
  const runner = async (command, args) => {
    calls.push(args);
    if (args[0] === 'env') return goEnvironment;
    if (args[0]?.endsWith('bootstrap_nsis.py')) return '{"compiler":"/tools/makensis","directory":"/tools"}';
    if (args.includes('--target')) throw new Error('Cross compiler failed');
    return '';
  };
  await assert.rejects(main(f.argv, { env: f.env, run: runner }), /Cross compiler failed/);
  assert.equal(await readFile(resolve(f.output, 'release-info.json'), 'utf8'), before);
  assert.ok(!calls.some(args => args.includes('--assemble') || args.includes('--arch')));
  assert.deepEqual(await readdir(f.directory), ['.tmp', 'dist']);
  assert.deepEqual(await readdir(resolve(f.directory, '.tmp')), []);
});

test('a missing installer prevents publishing even if the tool exits successfully', async t => {
  const f = await fixture(t);
  const runner = async (command, args) => {
    if (args[0] === 'env') return goEnvironment;
    if (args[0]?.endsWith('bootstrap_nsis.py')) return '{"compiler":"/tools/makensis","directory":"/tools"}';
    if (args.includes('--assemble')) {
      const staging = value(args, '--output');
      await makeClientReleaseFixture(staging, { repository, revision, version: value(args, '--version') });
      await rm(resolve(staging, 'spider-watch-windows-arm64-setup.exe'));
    }
    return '';
  };
  await assert.rejects(main(f.argv, { env: f.env, run: runner }), /Missing client artifact/);
  assert.deepEqual(await readdir(f.directory), ['.tmp']);
  assert.deepEqual(await readdir(resolve(f.directory, '.tmp')), []);
});

test('rejects invalid identity before bootstrapping downloaded tools', async t => {
  const f = await fixture(t);
  let invoked = false;
  f.argv[f.argv.indexOf('--revision') + 1] = '../wrong';
  await assert.rejects(main(f.argv, { env: f.env, run: async () => { invoked = true; } }), /Invalid client build identity/);
  assert.equal(invoked, false);
});

test('the old Go launcher only resolves the new host toolchain without target experiments', async () => {
  const inherited = { GO: '/host/go1.24.3', GOEXPERIMENT: 'nojsonv2', GOROOT: '/old/go', GOOS: 'windows', GOARCH: 'arm64', GOARM: '7', GOTOOLCHAIN: 'auto' };
  const selected = await resolveGoToolchain(async (command, args, options) => {
    assert.equal(command, '/host/go1.24.3');
    assert.deepEqual(args, ['env', '-json', 'GOROOT', 'GOVERSION']);
    assert.equal(options.env.GOTOOLCHAIN, 'go1.26.0');
    assert.equal(options.env.GOEXPERIMENT, '');
    assert.equal(options.env.GOENV, 'off');
    assert.equal(options.env.GOWORK, 'off');
    for (const key of ['GOROOT', 'GOOS', 'GOARCH', 'GOARM']) assert.equal(options.env[key], undefined);
    return goEnvironment;
  }, inherited);
  assert.equal(selected.GOTOOLCHAIN, 'local');
  assert.equal(selected.GO, resolve(toolchainRoot, 'bin', process.platform === 'win32' ? 'go.exe' : 'go'));
  assert.equal(inherited.GOEXPERIMENT, 'nojsonv2');
});

test('toolchain resolution rejects the old compiler and an invalid compiler location', async () => {
  for (const environment of [{ GOROOT: toolchainRoot, GOVERSION: 'go1.24.3' }, { GOROOT: 'relative/path', GOVERSION: 'go1.26.0' }]) {
    await assert.rejects(resolveGoToolchain(async () => JSON.stringify(environment), {}), /required go1.26.0/);
  }
});
