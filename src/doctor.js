import { access } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { runProcess } from './core/process.js';
import { seaweedRelease } from './storage/native-runtime.js';

export const targetId = value => value === 'local' ? 'node-process' : value;
export const targetName = value => value === 'node-process' ? 'local' : value;

export async function doctor(target, { environment = process.env, run = runProcess, protocol = 'http', storage, sourceRequired = true, action = 'deploy' } = {}) {
  target = targetId(target);
  if (!['docker', 'node-process', 'vm', 'hetzner'].includes(target)) throw new Error('Choose local, docker, vm or hetzner');
  const checks = [{ name: 'Node.js', ok: Number(process.versions.node.split('.')[0]) >= 22, detail: process.version, install: 'https://nodejs.org/en/download' }];
  async function command(name, binary, args, install, validate = () => true) {
    try { const result = await run(binary, args); checks.push({ name, ok: validate(result.stdout), detail: result.stdout.trim().split('\n')[0], install }); }
    catch { checks.push({ name, ok: false, detail: `${name} is unavailable`, install }); }
  }
  if (target === 'node-process') {
    if ((!storage || ['auto', 'local-s3'].includes(storage)) && !['stop', 'delete'].includes(action)) {
      try { const release = seaweedRelease(); checks.push({ name: 'Automatic local storage', ok: true, detail: `SeaweedFS ${release.version} will be downloaded when needed` }); }
      catch (error) { checks.push({ name: 'Automatic local storage', ok: false, detail: error.message }); }
    }
    if (action === 'deploy') await command('npm', process.platform === 'win32' ? 'npm.cmd' : 'npm', ['--version'], 'https://nodejs.org/en/download');
    if (protocol === 'https' && !['stop', 'delete'].includes(action)) await command('Caddy', 'caddy', ['version'], 'https://caddyserver.com/docs/install');
  }
  if (target === 'docker') {
    await command('Docker Engine', 'docker', ['info', '--format', '{{.ServerVersion}}'], 'https://docs.docker.com/get-started/get-docker/');
    await command('Docker Compose', 'docker', ['compose', 'version', '--short'], 'https://docs.docker.com/compose/install/');
  }
  if (['hetzner', 'vm'].includes(target) && action === 'deploy') await command('tar', 'tar', ['--version'], 'https://www.gnu.org/software/tar/');
  if (target === 'hetzner' && action === 'deploy') {
    await command('Terraform 1.7+', environment.OBJY_TERRAFORM_BINARY || 'terraform', ['version', '-json'], 'https://developer.hashicorp.com/terraform/install', source => {
      const [major, minor] = String(JSON.parse(source).terraform_version).split('.').map(Number);
      return major > 1 || major === 1 && minor >= 7;
    });
    if (sourceRequired) {
      const directory = environment.OBJY_TERRAFORM_DIRECTORY;
      let ok = false;
      if (directory) { try { await access(join(resolve(directory), 'installer/hetzner/main.tf')); ok = true; } catch {} }
      checks.push({ name: 'Terraform configuration', ok, detail: ok ? resolve(directory) : 'Set OBJY_TERRAFORM_DIRECTORY to your local objydb-terraform checkout.' });
    }
  }
  return { target: targetName(target), ok: checks.every(check => check.ok), checks };
}

export async function requireDependencies(target, options) {
  const result = await doctor(target, options);
  if (!result.ok) throw new Error(result.checks.filter(c => !c.ok).map(c => `${c.detail}${c.install ? `\nInstall: ${c.install}` : ''}`).join('\n'));
  return result;
}
