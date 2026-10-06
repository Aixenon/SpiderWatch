import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { verifyClientRelease } from './client-assets.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const platforms = JSON.parse(await readFile(resolve(root, 'client/internal/agent/platforms.json'), 'utf8'));
const buildLimit = 18 * 60 * 1000;

export function run(command, args, { cwd = root, env = process.env, capture = false, signal } = {}) {
  return new Promise((accept, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const child = spawn(command, args, { cwd, env, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', capture ? 'pipe' : 'inherit', 'inherit'] });
    let output = '';
    const abort = () => {
      if (!child.pid) return;
      // Stop the Python wrapper and its Go/SCons descendants together on the Linux builder.
      try { process.platform === 'win32' ? child.kill() : process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') reject(error); }
    };
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout?.on('data', chunk => { output += chunk; });
    child.once('error', reject);
    child.once('close', code => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(signal.reason);
      else code === 0 ? accept(output.trim()) : reject(new Error(`${command} failed (${code})`));
    });
  });
}

function argumentsFor(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    if (!['--repository', '--revision', '--output', '--version'].includes(option) || !argv[index + 1] || result[option.slice(2)]) {
      throw new Error('Expected --repository OWNER/REPO --revision COMMIT --output DIRECTORY [--version VERSION]');
    }
    result[option.slice(2)] = argv[index + 1];
  }
  return result;
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const env = options.env || process.env;
  const execute = options.run || run;
  const verify = options.verify || verifyClientRelease;
  const args = argumentsFor(argv);
  const version = args.version || (await readFile(resolve(root, 'client/VERSION'), 'utf8')).trim();
  const python = env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const revision = args.revision || env.GITHUB_SHA || await execute('git', ['rev-parse', 'HEAD'], { env, capture: true });
  const repository = args.repository || env.GITHUB_REPOSITORY || await execute(python, ['-c', 'from repository import resolve_repository; print(resolve_repository())'], { cwd: resolve(root, 'client/scripts'), env, capture: true });
  if (!/^[a-f0-9]{40}$/.test(revision) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository) || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version)) {
    throw new Error('Invalid client build identity');
  }
  const output = resolve(args.output || resolve(root, 'client/dist'));
  if (output === root || output === resolve(root, 'client') || dirname(output) === output) throw new Error('Unsafe client output directory');
  const npmCache = env.npm_config_cache || env.NPM_CONFIG_CACHE || (process.platform === 'win32' && env.LOCALAPPDATA ? resolve(env.LOCALAPPDATA, 'npm-cache') : resolve(homedir(), '.npm'));
  const cache = resolve(env.SPIDER_BUILD_CACHE || resolve(npmCache, 'spiderwatch-native-v1'));
  const stagingRoot = resolve(dirname(output), '.tmp');
  await mkdir(stagingRoot, { recursive: true });
  const staging = await mkdtemp(resolve(stagingRoot, 'clients-'));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Client build exceeded 18 minutes')), buildLimit);
  const environment = { ...env, GOTOOLCHAIN: 'go1.26.0', GOCACHE: resolve(cache, 'go-build'), GOMODCACHE: resolve(cache, 'go-mod'), GOMAXPROCS: '1', GOFLAGS: '-p=1' };
  const step = (command, values, extra = {}) => execute(command, values, { env: environment, signal: controller.signal, ...extra });
  try {
    const tools = JSON.parse(await step(python, [resolve(root, 'client/scripts/bootstrap_nsis.py'), '--cache', resolve(cache, 'tools')], { capture: true }));
    if (!tools.compiler || !tools.directory) throw new Error('Native installer compiler is unavailable');
    environment.MAKENSIS = tools.compiler;
    environment.NSISDIR = tools.directory;
    await step(env.GO || 'go', ['version']);
    const shared = ['--version', version, '--revision', revision, '--output', staging, '--repository', repository];
    let next = 0;
    const worker = async () => {
      while (next < platforms.length && !controller.signal.aborted) {
        const platform = platforms[next++];
        await step(python, [resolve(root, 'client/scripts/build.py'), '--target', `${platform.os}-${platform.arch}`, ...shared]);
      }
    };
    // Two independent architectures, one Go compiler CPU each, match Workers Builds' 2 vCPUs.
    const workers = [worker(), worker()];
    try { await Promise.all(workers); } catch (error) {
      controller.abort(error);
      await Promise.allSettled(workers);
      throw error;
    }
    if (controller.signal.aborted) throw controller.signal.reason;
    for (const arch of ['amd64', 'arm64', '386']) {
      await step(python, [resolve(root, 'client/scripts/windows/build-installer.py'), '--version', version, '--arch', arch, '--build-dir', staging]);
    }
    await step(python, [resolve(root, 'client/scripts/build.py'), '--assemble', '--installers', ...shared]);
    const release = await verify(staging, { repository, revision });
    if (release.version !== version) throw new Error('Client build version differs from the requested source');
    const backup = staging + '.previous';
    let previous = false;
    try { await rename(output, backup); previous = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
    try { await rename(staging, output); } catch (error) {
      if (previous) await rename(backup, output);
      throw error;
    }
    if (previous) await rm(backup, { recursive: true, force: true });
    console.log(`Built ${platforms.length} clients and 3 Windows installers for ${repository} ${version} (${revision.slice(0, 12)}).`);
    return release;
  } finally {
    clearTimeout(timer);
    await rm(staging, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
