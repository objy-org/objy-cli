import { lstat, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { installationPaths } from '../core/installation-state.js';
import { readJson, writeJson, redact } from './files.js';
import { conflict, installationId, withLock } from './operations.js';
import { targetName } from '../doctor.js';

export function createDeletionService({ root, setup, adapters, check }) {
  const directory = id => join(root, installationId(id));
  async function load(id) {
    const path = directory(id), entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('The deployment directory is not a regular directory');
    const record = await readJson(join(path, 'installation.json'));
    if (record.id !== id) throw new Error('The saved deployment identity does not match its directory');
    if (!['node-process', 'docker'].includes(record.settings.target)) throw new Error('Deletion is currently available only for Local and Docker deployments');
    const plan = await readJson(join(path, 'runtime/plan.json'), null);
    if (plan && (plan.deployment !== id || plan.driver !== record.settings.target)) throw new Error('The saved runtime plan does not belong to this deployment');
    if (plan && (plan.storage?.driver !== record.settings.storage || !['external-s3', record.settings.target === 'docker' ? 'docker-minio' : 'local-s3'].includes(plan.storage?.driver))) throw new Error('The saved storage does not match this deployment');
    const removed = record.management?.operation?.action === 'delete' && record.management.operation.completed.includes('resources');
    if (!plan && !removed) {
      for (const file of ['runtime/processes.json', 'runtime/storage/process.json', 'runtime/compose.json']) {
        if (await readJson(join(path, file), null)) throw new Error('Runtime state exists without its saved plan. Restore the plan before deleting this deployment.');
      }
    }
    return { record, plan, path };
  }
  async function blockers(id, plan) {
    if (!plan || plan.storage.driver === 'external-s3') return [];
    const endpoints = new Set([plan.persistence.endpoint, plan.storage.runtimeEndpoint].filter(Boolean).map(normalizeEndpoint));
    const blocked = [];
    for (const other of await setup.list()) {
      if (other.id === id) continue;
      const otherPath = directory(other.id);
      const saved = await readJson(join(otherPath, 'installation.json'));
      const otherPlan = await readJson(join(otherPath, 'runtime/plan.json'), null);
      const endpoint = otherPlan?.persistence?.endpoint || saved.settings.s3Endpoint;
      // Removing a storage process or container affects every bucket it serves.
      if (endpoint && endpoints.has(normalizeEndpoint(endpoint))) blocked.push(other.name);
    }
    return blocked;
  }
  async function preview(id) {
    const { record, plan } = await load(id);
    const blockedBy = await blockers(id, plan);
    const automatic = plan ? plan.storage.driver !== 'external-s3' : ['local-s3', 'docker-minio'].includes(record.settings.storage);
    return { id, name: record.settings.name, target: targetName(record.settings.target), blockedBy,
      removes: [record.settings.target === 'docker' ? 'Deployment containers, network and dedicated volumes' : 'Database processes and local deployment files',
        ...(automatic ? ['Automatic S3 storage and all data stored in it'] : []), 'Local configuration, credentials, logs and WAL data'],
      preserves: automatic ? ['Shared server downloads and caches'] : ['Existing S3 storage and its contents', 'Shared server downloads and caches'],
    };
  }
  return {
    preview,
    async run(id, { confirmation, onEvent = () => {}, resume = false } = {}) {
      return withLock(join(root, 'names.lock'), () => withLock(join(root, 'local-setup.lock'), () => withLock(join(directory(id), 'setup.lock'), async () => {
        const { record, plan, path } = await load(id);
        const pending = record.management?.operation;
        if (!resume && confirmation !== record.settings.name) throw new Error('Type the current deployment name to confirm deletion');
        if (resume && pending?.action !== 'delete') throw new Error('There is no unfinished deletion');
        const blockedBy = await blockers(id, plan);
        if (blockedBy.length) throw conflict(`Storage is used by ${blockedBy.join(', ')}. Delete those deployments first or move them to different storage.`);
        const secrets = await readJson(join(path, 'secrets.json'), {});
        const cleanupOnly = pending?.action === 'delete' && pending.completed.includes('resources');
        const ctx = plan && !cleanupOnly ? await adapters.open({ record, directory: path, secrets }) : null;
        if (ctx) {
          await check(record.settings.target, { action: 'delete', protocol: record.settings.protocol, storage: record.settings.storage, sourceRequired: false });
          await ctx.driver.checkRemoval?.(ctx.paths, { environment: ctx.environment });
          if (record.settings.target === 'node-process') {
            const processes = await readJson(join(ctx.paths.root, 'processes.json'), []);
            const owned = new Set([...plan.nodes.map(node => node.id), 'objydb-caddy']);
            if (processes.some(process => !owned.has(process.nodeId))) throw new Error('The process list contains an unknown service; no processes were stopped');
          }
        }
        const operation = pending?.status === 'pending' && pending.action === 'delete' ? pending : { action: 'delete', status: 'pending', completed: [], startedAt: new Date().toISOString() };
        record.management = { ...record.management, state: 'deleting', operation };
        const save = () => { record.updatedAt = new Date().toISOString(); return writeJson(join(path, 'installation.json'), record); };
        const emit = message => { try { onEvent({ message: redact(message, secrets) }); } catch {} };
        async function phase(name, message, perform) {
          if (operation.completed.includes(name)) return;
          emit(message); await perform(); operation.completed.push(name); await save();
        }
        await save();
        try {
          if (ctx) {
            if (operation.completed.includes('stop') && !operation.completed.includes('resources')) {
              const current = await ctx.driver.status(ctx.paths, { environment: ctx.environment });
              if (current.some(node => plan.nodes.some(expected => expected.id === node.nodeId) && !['exited', 'inactive', 'stopped'].includes(node.state))) operation.completed = operation.completed.filter(step => step !== 'stop');
            }
            await phase('stop', 'Stopping database nodes', async () => {
              await ctx.driver.stop(ctx.paths, { environment: ctx.environment, services: plan.nodes.map(node => node.service || node.id) });
              const observed = await ctx.driver.status(ctx.paths, { environment: ctx.environment });
              if (observed.some(node => plan.nodes.some(expected => expected.id === node.nodeId) && !['exited', 'inactive', 'stopped'].includes(node.state))) throw new Error('Database nodes have not confirmed shutdown');
            });
            await phase('resources', 'Removing deployment resources and dedicated storage', async () => {
              if (record.settings.target === 'docker') await ctx.driver.destroy(ctx.paths, { environment: ctx.environment });
              else if (plan.storage.driver === 'local-s3') await ctx.storage.stop(plan, ctx.paths);
            });
          }
          // Retain the journal and credentials until the external resources are gone.
          emit('Removing local deployment state');
          for (const entry of await readdir(path)) {
            if (!['installation.json', 'setup.lock'].includes(entry)) await rm(join(path, entry), { recursive: true, force: true });
          }
          await rm(path, { recursive: true, force: true });
          emit('Deployment deleted');
          return { id, name: record.settings.name, target: targetName(record.settings.target), state: 'deleted' };
        } catch (error) {
          operation.error = redact(error.message, secrets); await save(); throw new Error(operation.error);
        }
      })));
    },
  };
}

function normalizeEndpoint(value) {
  const url = new URL(value);
  if (['localhost', 'host.docker.internal', '[::1]'].includes(url.hostname)) url.hostname = '127.0.0.1';
  return url.origin;
}
