import { readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const settingsFile = resolve(root, 'deployment.local.json');
const configFile = resolve(root, 'wrangler.deploy.local.json');
const secretFile = resolve(root, 'deploy-secrets.local.json');
const dry = process.argv.includes('--dry-run');
const interactive = !process.env.CI && process.stdin.isTTY;
const prompts = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : null;
const saved = existsSync(settingsFile) ? JSON.parse(await readFile(settingsFile, 'utf8')) : {};
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;

function repository() {
  // CI's checkout owner is authoritative after a fork; never reuse saved origin.
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  try {
    const remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], { cwd: root, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] }).trim();
    const value = remote.replace(/^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/, '').replace(/\.git$/, '');
    if (repositoryPattern.test(value)) return value;
  } catch {}
  return process.env.UPDATE_GITHUB_REPOSITORY || '';
}
async function setting(key, label, fallback = '', validate = value => !!value) {
  let value = process.env[key] || saved[key] || fallback;
  if (prompts && !process.env[key]) value = (await prompts.question(`${label}${value ? ` [${value}]` : ''}: `)).trim() || value;
  if (!validate(value)) throw new Error(`Missing or invalid ${key}`);
  return value;
}
try {
  const repo = repository();
  if (!repositoryPattern.test(repo)) throw new Error('Cannot identify this GitHub checkout. Set UPDATE_GITHUB_REPOSITORY=OWNER/REPO.');
  const name = await setting('WORKER_NAME', 'Worker 名称', 'spider-watch', value => /^[a-z0-9][a-z0-9-]{0,62}$/.test(value));
  const domain = await setting('PANEL_DOMAIN', '面板域名（无 https://）', '', value => /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(value));
  const team = await setting('ACCESS_TEAM_DOMAIN', 'Access 团队域名', '', value => /^(https:\/\/)?[a-z0-9-]+\.cloudflareaccess\.com$/i.test(value));
  const aud = await setting('ACCESS_PANEL_AUD', 'Access 应用 AUD', '', value => /^[a-f0-9]{64}$/i.test(value));
  const emails = await setting('ADMIN_EMAILS', '管理员邮箱（逗号分隔）', '', value => value.split(',').every(x => /^[^\s@,]+@[^\s@,]+\.[^\s@,]+$/.test(x.trim())));
  let invitation = process.env.INVITATION_SECRET || saved.INVITATION_SECRET;
  if (!invitation && interactive) invitation = randomBytes(32).toString('hex');
  if (typeof invitation !== 'string' || invitation.length < 32 || /[\r\n]/.test(invitation)) throw new Error('Set a persistent INVITATION_SECRET (at least 32 random characters) in CI secrets.');
  const config = JSON.parse(await readFile(resolve(root, 'wrangler.jsonc'), 'utf8'));
  config.name = name;
  config.routes = [{ pattern: domain, custom_domain: true }];
  config.workers_dev = false;
  config.preview_urls = false;
  delete config.env;
  // Keep the DO storage identity constant across redeployments and forks.
  Object.assign(config.vars, { ACCESS_TEAM_DOMAIN: team.startsWith('https://') ? team : `https://${team.toLowerCase()}`, ACCESS_PANEL_AUD: aud, ADMIN_EMAILS: emails,
    UPDATE_GITHUB_REPOSITORY: repo, LOCAL_DEV: 'false' });
  if (interactive) await writeFile(settingsFile, JSON.stringify({WORKER_NAME:name,PANEL_DOMAIN:domain,
    ACCESS_TEAM_DOMAIN:team,ACCESS_PANEL_AUD:aud,ADMIN_EMAILS:emails,INVITATION_SECRET:invitation},null,2)+'\n',{mode:0o600});
  await writeFile(configFile, JSON.stringify(config,null,2)+'\n', {mode:0o600});
  await writeFile(secretFile, JSON.stringify({INVITATION_SECRET:invitation}), {mode:0o600});
  prompts?.close();
  console.log(`SpiderWatch: ${repo} → ${name} → https://${domain}`);
  const args = [resolve(root,'node_modules/wrangler/bin/wrangler.js'),'deploy','--config',configFile,'--secrets-file',secretFile];
  if (dry) args.push('--dry-run','--outdir',resolve(root,'dist'));
  const result = spawnSync(process.execPath,args,{cwd:root,stdio:'inherit',env:process.env});
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Cloudflare deployment failed.');
  console.log(dry ? 'Deployment package verified; nothing uploaded.' : `Deployed. Open https://${domain}/ to log in.`);
} catch (error) {
  console.error(error.message); process.exitCode=1;
} finally {
  prompts?.close();
  await rm(secretFile,{force:true});
  await rm(configFile,{force:true});
}
