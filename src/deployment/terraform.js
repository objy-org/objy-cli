import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile, rename, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ssh2 from 'ssh2';
import { isIP } from 'node:net';
import { runProcess } from '../core/process.js';
import { managedNodeRuntimeSetupCommand } from '../drivers/systemd-node-runtime.js';
import { readJson, writeJson } from './files.js';
import { normalizeDomain } from './catalog.js';

const generateKey = promisify(ssh2.utils.generateKeyPair);
const defaultSource = resolve(dirname(fileURLToPath(import.meta.url)), '../../../objydb-terraform');

export async function snapshotModule(source, destination) {
  const metadataPath = join(destination, 'module-source.json');
  const previous = await readJson(metadataPath, null);
  if (previous) return previous;
  const root = resolve(source);
  await access(join(root, 'main.tf')).catch(() => { throw new Error(`Terraform module is missing: ${root}`); });
  const files = [];
  async function collect(relative = '') {
    for (const entry of (await readdir(join(root, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') && entry.name !== '.terraform.lock.hcl') continue;
      if (['tests', 'node_modules'].includes(entry.name)) continue;
      const name = join(relative, entry.name);
      if (entry.isSymbolicLink()) throw new Error('Terraform modules cannot contain symbolic links');
      if (entry.isDirectory()) await collect(name);
      else if (/\.(tf|tf\.json|tftpl|sh)$/.test(name) || entry.name === '.terraform.lock.hcl') files.push([name, await readFile(join(root, name))]);
    }
  }
  await collect();
  const hash = createHash('sha256');
  const staged = `${destination}.${randomUUID()}.tmp`;
  await mkdir(staged, { recursive: true, mode: 0o700 });
  for (const [name, content] of files) {
    hash.update(name).update('\0').update(content).update('\0');
    await mkdir(dirname(join(staged, name)), { recursive: true, mode: 0o700 });
    await writeFile(join(staged, name), content, { mode: 0o600 });
  }
  const metadata = { kind: 'local', path: root, digest: hash.digest('hex'), capturedAt: new Date().toISOString() };
  await writeJson(join(staged, 'module-source.json'), metadata);
  await rename(staged, destination);
  return metadata;
}

export function createTerraformProvisioner({ run = runProcess, fetchImpl = fetch, environment = process.env } = {}) {
  const binary = environment.OBJY_TERRAFORM_BINARY || 'terraform';
  return {
    selectServerType,
    async check({ sourceRequired = true } = {}) {
      const result = await run(binary, ['version', '-json']).catch(() => { throw new Error('Terraform 1.7+ is required. Install it: https://developer.hashicorp.com/terraform/install'); });
      const [major, minor] = String(JSON.parse(result.stdout).terraform_version).split('.').map(Number);
      if (!(major > 1 || major === 1 && minor >= 7)) throw new Error('Terraform 1.7 or newer is required');
      if (!sourceRequired) return;
      const source = join(environment.OBJY_TERRAFORM_DIRECTORY || defaultSource, 'installer', 'hetzner');
      await access(join(source, 'main.tf')).catch(() => { throw new Error(`Local Terraform module not found at ${source}. Set OBJY_TERRAFORM_DIRECTORY to the objydb-terraform project.`); });
    },
    async create({ directory, record, secrets, emit }) {
      if (record.settings.protocol === 'https' && !normalizeDomain(record.settings.domain || '')) {
        throw new Error('Hetzner HTTPS requires a domain. Use HTTP for IP-only access.');
      }
      const saved = await readJson(join(directory, 'infrastructure.json'), null);
      if (saved) return saved;
      const source = join(environment.OBJY_TERRAFORM_DIRECTORY || defaultSource, 'installer', 'hetzner');
      const workingDirectory = join(directory, 'terraform');
      await this.check({ sourceRequired: !await readJson(join(workingDirectory, 'module-source.json'), null) });
      const module = await snapshotModule(source, workingDirectory);
      if (record.settings.protocol === 'https' && !(await readFile(join(workingDirectory, 'main.tf'), 'utf8')).includes('hcloud_managed_certificate')) {
        throw new Error('This saved Terraform module uses node-based TLS. Create a new installation to use load-balancer TLS; existing infrastructure has been left untouched.');
      }
      const keyFile = join(directory, 'ssh-key');
      try { await access(keyFile); }
      catch {
        const key = await generateKey('ed25519', { comment: record.id });
        await writeFile(keyFile, key.private, { mode: 0o600, flag: 'wx' });
        await writeFile(`${keyFile}.pub`, key.public, { mode: 0o600 });
      }
      const variablesPath = join(workingDirectory, 'installer.auto.tfvars.json');
      let variables = await readJson(variablesPath, null);
      if (!variables) {
        emit('Choosing a machine size for your cluster');
        const serverType = await selectServerType(secrets.cloudToken, record.settings.region, record.capacity.heapMb);
        variables = {
          deployment_name: record.id, location: record.settings.region, server_type: serverType,
          shards: record.capacity.shards, replicas: record.capacity.replicas,
          protocol: record.settings.protocol,
          public_domain: record.settings.protocol === 'https' ? record.settings.domain || '' : '',
          ssh_public_key: (await readFile(`${keyFile}.pub`, 'utf8')).trim(),
          bootstrap_script: '#!/bin/bash\n' + managedNodeRuntimeSetupCommand('objydb', { https: false }) + '\n',
        };
        await writeJson(variablesPath, variables);
      }
      const env = Object.fromEntries(Object.entries(environment).filter(([name]) => !name.startsWith('TF_VAR_') && !name.startsWith('TF_CLI_ARGS') && name !== 'TF_DATA_DIR' && name !== 'TF_WORKSPACE'));
      Object.assign(env, { HCLOUD_TOKEN: secrets.cloudToken, TF_IN_AUTOMATION: '1', TF_INPUT: '0' });
      const command = (args) => run(binary, args, { cwd: workingDirectory, env });
      emit('Preparing cloud infrastructure');
      await command(['init', '-input=false', '-no-color']);
      await command(['validate', '-no-color']);
      await command(['plan', '-input=false', '-no-color', '-lock-timeout=30s', '-out=setup.tfplan']);
      const planned = JSON.parse((await command(['show', '-json', 'setup.tfplan'])).stdout);
      assertCreationPlan(planned);
      emit('Creating servers, networking, and persistent volumes');
      await command(['apply', '-input=false', '-no-color', '-lock-timeout=30s', 'setup.tfplan']);
      const inventory = JSON.parse((await command(['output', '-json', 'inventory'])).stdout);
      validateInventory(inventory, record.capacity.nodes, record.id);
      if (variables.public_domain && new URL(inventory.endpoint).hostname !== variables.public_domain) throw new Error('Terraform returned a different domain from the requested endpoint');
      const result = { inventory, module, serverType: variables.server_type, identityFile: keyFile };
      await writeJson(join(directory, 'infrastructure.json'), result);
      return result;
    },
  };

  async function selectServerType(token, location, heapMb, currentName) {
    const types = [];
    for (let page = 1; page && page <= 20;) {
      const response = await fetchImpl(`https://api.hetzner.cloud/v1/server_types?per_page=50&page=${page}`, {
        headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Cannot read cloud machine sizes (HTTP ${response.status}). Check your Hetzner API token.`);
      const body = await response.json();
      types.push(...body.server_types || []);
      page = body.meta?.pagination?.next_page;
    }
    const required = Math.ceil(heapMb / 1024 + 1);
    const current = types.find(t => t.name === currentName);
    // Lowering the heap does not require shrinking a VM's non-shrinkable root disk.
    if (current?.architecture === 'x86' && current.memory >= required) return current.name;
    const available = types.filter(t => t.architecture === 'x86' && t.memory >= required && !t.deprecated
      && (!current?.disk || t.disk >= current.disk)
      && t.prices?.some(p => p.location === location)
      && (!t.locations?.length || t.locations.some(l => (l.name || l) === location && !l.deprecation)));
    available.sort((a, b) => a.memory - b.memory || a.cores - b.cores || a.name.localeCompare(b.name));
    if (!available.length) throw new Error('No suitable cloud machine is available for this memory and location');
    return available[0].name;
  }
}

export function assertCreationPlan(plan) {
  const forbidden = (plan.resource_changes || []).find(r => r.change?.actions?.some(a => !['create', 'no-op', 'read'].includes(a)));
  if (forbidden) throw new Error('Setup would modify or remove existing infrastructure. This version only creates clusters; the saved resources have been left untouched.');
}

export function validateInventory(value, expectedNodes, id) {
  const nodes = Object.values(value?.nodes || {});
  if (![1, 2].includes(value?.schema_version) || nodes.length !== expectedNodes) throw new Error('Terraform returned an invalid cluster inventory');
  for (const n of nodes) {
    if (!n.id?.startsWith(`${id}-s`) || !/^[\d.]+$/.test(n.host) || !/^[\d.]+$/.test(n.peer_host)
      || !Number.isInteger(n.shard) || !Number.isInteger(n.replica)) throw new Error('Terraform returned an invalid node');
  }
  let endpoint;
  try { endpoint = new URL(value.endpoint); } catch { throw new Error('Terraform returned an invalid client endpoint'); }
  if (!['http:', 'https:'].includes(endpoint.protocol) || value.endpoint !== `${endpoint.protocol}//${endpoint.hostname}`
    || (!/^[\d.]+$/.test(endpoint.hostname) && normalizeDomain(endpoint.hostname) !== endpoint.hostname)) throw new Error('Terraform returned an invalid client endpoint');
  if (endpoint.protocol === 'https:' && (value.https_mode !== 'load-balancer' || isIP(value.public_ip) !== 4)) throw new Error('Terraform returned an invalid load-balancer HTTPS inventory');
}
