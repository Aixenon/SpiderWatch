import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const platforms = JSON.parse(await readFile(resolve(root, 'client/internal/agent/platforms.json'), 'utf8'));

// Synthetic files for packaging tests only; these cannot run or install a client.
export async function makeClientReleaseFixture(directory, { repository = 'fixture/SpiderWatch', version = '0.7.1', revision = 'a'.repeat(40), artifactBytes = 1024 } = {}) {
  await mkdir(directory, { recursive: true });
  const assets = [], files = [];
  async function put(file, content) {
    const bytes = Buffer.from(content);
    await writeFile(resolve(directory, file), bytes);
    const entry = { file, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
    files.push(entry);
    return entry;
  }
  for (const { os, arch } of platforms) {
    const file = `spider-watch-${os}-${arch}${os === 'windows' ? '.exe' : ''}`;
    assets.push({ os, arch, ...await put(file, `${file}\n`.padEnd(artifactBytes, 'x')) });
  }
  for (const arch of ['amd64', 'arm64', '386']) await put(`spider-watch-windows-${arch}-setup.exe`, 'fixture-installer'.padEnd(artifactBytes, 'x'));
  await put('install.sh', '#!/bin/sh\nexit 99 # packaging fixture\n');
  await put('install.ps1', 'throw "packaging fixture"\n');
  await writeFile(resolve(directory, 'checksums.txt'), files.map(file => `${file.sha256}  ${file.file}\n`).join(''));
  await writeFile(resolve(directory, 'update-manifest.json'), JSON.stringify({ schema: 1, version, revision, assets }));
  await writeFile(resolve(directory, 'release-info.json'), JSON.stringify({ repository, version, revision }));
  return { repository, version, revision, assets, files };
}
