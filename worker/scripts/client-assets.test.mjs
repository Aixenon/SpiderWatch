import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { mkdtemp, readFile, readdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { packageClientAssets, verifyClientRelease } from './client-assets.mjs';
import { makeClientReleaseFixture } from './client-assets-fixture.mjs';

let temp, release, output;
beforeEach(async () => {
  temp = await mkdtemp(resolve(tmpdir(), 'spider-watch-assets-'));
  release = resolve(temp, 'release'); output = resolve(temp, 'assets');
  await makeClientReleaseFixture(release);
});
afterEach(async () => { await rm(temp, { recursive: true, force: true }); });

test('packages all 19 binaries, three installers and metadata with reproducible identity', async () => {
  const current = await packageClientAssets(release, output, { repository: 'fixture/SpiderWatch', revision: 'a'.repeat(40) });
  assert.equal(current.assets.length, 19); assert.equal(current.files.length, 27);
  assert.equal(current.revision, 'a'.repeat(40)); assert.match(current.build, /^[a-f0-9]{64}$/);
  assert.deepEqual(JSON.parse(await readFile(resolve(output, 'downloads/current.json'), 'utf8')), current);
  assert.equal(await readFile(resolve(output, 'install.sh'), 'utf8'), await readFile(resolve(release, 'install.sh'), 'utf8'));
  assert.deepEqual(await verifyClientRelease(release), current);
  for (const file of current.files) assert.deepEqual(await readFile(resolve(output, 'downloads', file.file)), await readFile(resolve(release, file.file)));
  assert.deepEqual((await readdir(output)).sort(), ['downloads', 'install.sh']);
  assert.equal((await readdir(resolve(output, 'downloads'))).length, 28);
});

test('refuses incomplete builds, mismatched repositories and stale commits', async () => {
  await assert.rejects(verifyClientRelease(release, { repository: 'other/repo' }), /different repository/);
  await assert.rejects(verifyClientRelease(release, { revision: 'b'.repeat(40) }), /different source commit/);
  await rm(resolve(release, 'spider-watch-windows-arm64-setup.exe'));
  await assert.rejects(packageClientAssets(release, output), /Missing client artifact/);
  await assert.rejects(readFile(resolve(output, 'downloads/current.json')), /ENOENT/);
});

test('rejects changed binaries, checksums and incomplete or duplicate platform lists', async () => {
  const binary = resolve(release, 'spider-watch-linux-amd64');
  const original = await readFile(binary);
  await writeFile(binary, Buffer.alloc(original.length, 0));
  await assert.rejects(verifyClientRelease(release), /checksum mismatch/);
  await writeFile(binary, original);
  const manifestPath = resolve(release, 'update-manifest.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.assets[1] = manifest.assets[0];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(verifyClientRelease(release), /Missing or duplicate/);
  await makeClientReleaseFixture(release);
  await writeFile(resolve(release, 'checksums.txt'), '');
  await assert.rejects(verifyClientRelease(release), /Invalid client artifact size/);
});

test('enforces the Worker static asset size limit before copying any files', async () => {
  await truncate(resolve(release, 'spider-watch-windows-amd64-setup.exe'), 25 * 1024 * 1024 + 1);
  await assert.rejects(packageClientAssets(release, output), /Invalid client artifact size/);
  await assert.rejects(readFile(resolve(output, 'downloads/current.json')), /ENOENT/);
});

test('requires stable versions, matching revisions and canonical filenames', async () => {
  const path = resolve(release, 'update-manifest.json');
  for (const change of [manifest => { manifest.version = '0.7.1-dev'; }, manifest => { manifest.revision = 'b'.repeat(40); }, manifest => { manifest.assets[0].file = '../outside'; }]) {
    await makeClientReleaseFixture(release);
    const manifest = JSON.parse(await readFile(path, 'utf8')); change(manifest);
    await writeFile(path, JSON.stringify(manifest));
    await assert.rejects(verifyClientRelease(release), /manifest/);
  }
});
