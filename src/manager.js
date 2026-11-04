import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createSetupService } from './deployment/service.js';
import { createAdapters } from './deployment/adapters.js';
import { cliHome } from './deployment/state.js';
import { readJson, writeJson, redact } from './deployment/files.js';
import { withLock, lockActive } from './deployment/operations.js';
import { normalizeAnswers } from './deployment/catalog.js';
import { createReleaseStore, readRelease } from './releases.js';
import { requireDependencies, targetId, targetName } from './doctor.js';
import { createSshTransport } from './drivers/vm/ssh-transport.js';

export function createManager({ environment = process.env, root = cliHome(environment), adapters, setup, check = requireDependencies, timeoutMs = 600000 } = {}) {
  root = resolve(root);
  const releases = createReleaseStore({ root });
  adapters ||= createAdapters({ environment, transport: createSshTransport({ knownHostsDirectory: join(root, 'ssh', 'known-hosts') }),
    resolveRelease: (record, emit) => releases.ensure(record.release, { install: record.settings.target === 'node-process', emit }) });
  setup ||= createSetupService({ root, adapters, timeoutMs });
  const directory = id => join(root, id);
  const recordPath = id => join(directory(id), 'installation.json');
  const read = id => readJson(recordPath(id));
  const save = record => writeJson(recordPath(record.id), record);
  const output = async value => {
    const pending = value.management?.operation?.status === 'pending';
    const busy = pending && await lockActive(join(directory(value.id), 'setup.lock'));
    return { ...value, target: targetName(value.target), state: pending ? busy ? 'working' : 'interrupted' : value.management?.state || value.phase };
  };
  async function find(name) {
    const matches = (await setup.list()).filter(record => record.name === name || record.id === name);
    if (matches.length !== 1) throw new Error(matches.length ? `Deployment name is ambiguous: ${name}` : `Unknown deployment: ${name}`);
    return matches[0];
  }
  async function context(id) {
    const record = await read(id);
    const secrets = await readJson(join(directory(id), 'secrets.json'));
    return { record, secrets, directory: directory(id), ...await adapters.open({ record, secrets, directory: directory(id) }) };
  }
  async function ready(ctx, onEvent) {
    const deadline = Date.now() + timeoutMs;
    let count = -1;
    while (Date.now() < deadline) {
      const topology = await ctx.observe();
      const next = topology.nodes.filter(n => n.status === 'ready').length;
      if (next !== count) { onEvent({ message: `${next}/${ctx.plan.nodes.length} nodes ready` }); count = next; }
      if (next === ctx.plan.nodes.length && topology.endpointReady) return topology;
      await delay(2000);
    }
    throw new Error('Nodes did not become ready in time. Inspect logs, then use objy resume.');
  }
  async function lifecycle(id, action, { onEvent = () => {}, resume = false } = {}) {
    return withLock(join(directory(id), 'setup.lock'), async () => {
      const ctx = await context(id);
      const { record, secrets, driver, paths } = ctx;
      if (record.phase !== 'ready') throw new Error('Finish setup with objy resume first.');
      const pending = record.management?.operation;
      if (pending?.status === 'pending' && !resume) throw new Error('An operation is unfinished. Use objy resume first.');
      if (resume) {
        if (!pending || pending.status !== 'pending') throw new Error('There is no unfinished operation.');
        action = pending.action;
      }
      await check(record.settings.target, { environment, action, protocol: record.settings.protocol, storage: record.settings.storage, sourceRequired: false });
      const emit = message => { try { onEvent({ message: redact(message, secrets) }); } catch {} };
      record.management ||= {};
      const operation = resume ? pending : { id: randomUUID(), action, status: 'pending', completed: [], startedAt: new Date().toISOString() };
      record.management.operation = operation;
      record.management.state = 'unknown';
      await save(record);
      async function phase(name, perform) {
        if (operation.completed.includes(name)) return;
        emit(name === 'stop' ? 'Stopping database nodes' : 'Starting database nodes');
        await perform();
        operation.completed.push(name);
        await save(record);
      }
      try {
        if (['stop', 'restart'].includes(action)) await phase('stop', async () => {
          await driver.stop(paths, { environment: ctx.environment, services: ctx.plan.nodes.map(node => node.service || node.id) });
          const observed = await driver.status(paths, { environment: ctx.environment });
          const nodes = ctx.plan.nodes.map(node => observed.find(item => item.nodeId === node.id));
          if (nodes.some(node => !node || !['exited', 'inactive', 'stopped'].includes(node.state))) throw new Error('Not all nodes have confirmed shutdown. Use objy resume after checking logs.');
        });
        if (['start', 'restart'].includes(action)) {
          if (ctx.storage?.start) {
            emit('Checking cluster storage');
            await ctx.storage.start(ctx.plan, paths, { environment: ctx.environment, targetDriver: driver, progress: emit });
          }
          await phase('start', () => driver.start(paths, { environment: ctx.environment }));
          record.topology = await ready(ctx, emitEvent => emit(emitEvent.message));
        }
        record.management.state = action === 'stop' ? 'stopped' : 'running';
        operation.status = 'complete';
        operation.finishedAt = new Date().toISOString();
        delete operation.error;
        record.updatedAt = operation.finishedAt;
        await save(record);
        return output(await setup.describe(id));
      } catch (error) {
        operation.completed = operation.completed.filter(step => step !== 'start');
        operation.error = redact(error.message, secrets);
        record.management.state = 'unknown';
        await save(record);
        throw new Error(operation.error);
      }
    });
  }
  return {
    root,
    async list() { return Promise.all((await setup.list()).map(output)); },
    async deploy(input, { releaseFile, onEvent = () => {} } = {}) {
      const values = normalizeAnswers({ ...input, target: targetId(input.target) });
      const release = await readRelease(releaseFile);
      await check(values.target, { environment, protocol: values.protocol, storage: values.storage });
      const record = await withLock(join(root, 'names.lock'), async () => {
        if ((await setup.list()).some(record => record.name === values.name)) throw new Error(`Deployment ${values.name} already exists. Use status, start or resume.`);
        return setup.create(values, randomUUID(), release);
      });
      return output(await setup.run(record.id, { onEvent }));
    },
    async status(name) { return output(await setup.describe((await find(name)).id)); },
    async act(name, action, options) {
      if (!['start', 'stop', 'restart'].includes(action)) throw new Error(`Unknown action: ${action}`);
      return lifecycle((await find(name)).id, action, options);
    },
    async resume(name, options = {}) {
      const record = await find(name);
      if (record.phase !== 'ready') {
        const snapshot = await readJson(join(directory(record.id), 'terraform/module-source.json'), null);
        await check(targetId(record.target), { environment, sourceRequired: !snapshot, protocol: record.protocol, storage: record.storage });
        return output(await setup.run(record.id, options));
      }
      return lifecycle(record.id, null, { ...options, resume: true });
    },
    async logs(name, { node, tail = 100 } = {}) {
      if (!Number.isInteger(tail) || tail < 1 || tail > 10000) throw new Error('Lines must be an integer between 1 and 10000');
      const record = await find(name);
      const ctx = await context(record.id);
      if (node && !ctx.plan.nodes.some(n => n.id === node)) throw new Error(`Unknown node: ${node}`);
      const source = await ctx.driver.readLogs(ctx.paths, { node, tail, environment: ctx.environment });
      return redactLogs(source, ctx.secrets);
    },
  };
}

function redactLogs(source, secrets) {
  // Unlike errors, a requested log tail is not truncated to 5 KB.
  let text = String(source);
  for (const value of Object.values(secrets).filter(v => typeof v === 'string' && v.length).sort((a, b) => b.length - a.length)) {
    text = text.split(value).join('[redacted]');
    text = text.split(JSON.stringify(value).slice(1, -1)).join('[redacted]');
  }
  return text;
}
