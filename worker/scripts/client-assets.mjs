import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const platforms = JSON.parse(await readFile(resolve(root, 'client/internal/agent/platforms.json'), 'utf8'));
const versionPattern = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const revisionPattern = /^[a-f0-9]{40}$/;
const digestPattern = /^[a-f0-9]{64}$/;
const staticAssetLimit = 25 * 1024 * 1024;
const binaryName = ({ os, arch }) => `spider-watch-${os}-${arch}${os === 'windows' ? '.exe' : ''}`;
const installerNames = ['amd64', 'arm64', '386'].map(arch => `spider-watch-windows-${arch}-setup.exe`);
const scriptNames = ['install.sh', 'install.ps1'];
const metadataNames = ['update-manifest.json', 'checksums.txt', 'release-info.json'];

async function describe(directory, name, min = 1, max = staticAssetLimit) {
  const path = resolve(directory, name);
  let stat;
  try { stat = await lstat(path); } catch { throw new Error(`Missing client artifact: ${name}. Build all clients before deploying.`); }
  if (!stat.isFile() || stat.size < min || stat.size > max) throw new Error(`Invalid client artifact size or type: ${name}`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return { file: name, bytes: stat.size, sha256: hash.digest('hex') };
}

export async function verifyClientRelease(directory, { repository, revision } = {}) {
  directory = resolve(directory);
  const metadata = [];
  for (const name of metadataNames) metadata.push(await describe(directory, name, 1, 256 * 1024));
  const info = JSON.parse(await readFile(resolve(directory, 'release-info.json'), 'utf8'));
  const manifest = JSON.parse(await readFile(resolve(directory, 'update-manifest.json'), 'utf8'));
  if (!versionPattern.test(info.version || '') || !revisionPattern.test(info.revision || '') || !repositoryPattern.test(info.repository || '')) {
    throw new Error('Invalid client release identity.');
  }
  if (repository && info.repository !== repository) throw new Error('Client artifacts belong to a different repository.');
  if (revision && info.revision !== revision) throw new Error('Client artifacts belong to a different source commit.');
  if (manifest.schema !== 1 || manifest.version !== info.version || manifest.revision !== info.revision || !Array.isArray(manifest.assets) || manifest.assets.length !== platforms.length) {
    throw new Error('Client manifest does not describe the complete current build.');
  }
  const files = [];
  const assets = [];
  for (const platform of platforms) {
    const matching = manifest.assets.filter(asset => asset?.os === platform.os && asset?.arch === platform.arch);
    if (matching.length !== 1) throw new Error(`Missing or duplicate client platform: ${platform.os}/${platform.arch}`);
    const entry = matching[0];
    const expected = binaryName(platform);
    if (entry.file !== expected || !digestPattern.test(entry.sha256 || '')) throw new Error(`Invalid client manifest entry: ${expected}`);
    const file = await describe(directory, expected, 1024, 16 * 1024 * 1024);
    if (entry.bytes !== file.bytes || entry.sha256 !== file.sha256) throw new Error(`Client artifact checksum mismatch: ${expected}`);
    assets.push({ os: platform.os, arch: platform.arch, ...file });
    files.push(file);
  }
  for (const name of installerNames) files.push(await describe(directory, name, 1024));
  for (const name of scriptNames) files.push(await describe(directory, name, 1, 64 * 1024));
  const checksums = new Map();
  for (const line of (await readFile(resolve(directory, 'checksums.txt'), 'utf8')).trimEnd().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64}) {2}([A-Za-z0-9.-]+)$/.exec(line);
    if (!match || checksums.has(match[2])) throw new Error('Invalid or duplicate client checksum entry.');
    checksums.set(match[2], match[1]);
  }
  if (checksums.size !== files.length || files.some(file => checksums.get(file.file) !== file.sha256)) throw new Error('Incomplete or mismatched client checksums.');
  files.push(...metadata);
  const build = createHash('sha256').update(JSON.stringify(files)).digest('hex');
  return { schema: 1, version: info.version, revision: info.revision, repository: info.repository, build, assets, files };
}

export async function packageClientAssets(directory, assetsDirectory, options = {}) {
  const manifest = await verifyClientRelease(directory, options);
  const destination = resolve(assetsDirectory, 'downloads');
  await mkdir(destination, { recursive: true });
  for (const file of manifest.files) {
    await copyFile(resolve(directory, file.file), resolve(destination, file.file));
    const copied = await describe(destination, file.file);
    if (copied.bytes !== file.bytes || copied.sha256 !== file.sha256) throw new Error(`Client artifact changed during packaging: ${file.file}`);
  }
  await copyFile(resolve(destination, 'install.sh'), resolve(assetsDirectory, 'install.sh'));
  await writeFile(resolve(destination, 'current.json'), JSON.stringify(manifest) + '\n');
  return manifest;
}
