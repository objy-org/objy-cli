import { randomBytes, createHash } from 'node:crypto';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { normalizeAnswers, splitAnswers, capacity } from './catalog.js';
import { createAdapters } from './adapters.js';
import { readJson, writeJson, redact } from './files.js';
import { processExists } from '../core/process.js';
import { ensureShardMap } from '../core/shard-map.js';
import { resolvePlanSecrets } from '../core/secrets.js';
import { waitForS3Bucket } from '../storage/s3-access.js';
import { acquireLock as acquire } from './operations.js';
import { cliHome, ensurePrivateDirectory } from './state.js';

export function createSetupService({
  root = cliHome(),
  adapters = createAdapters(), publishShardMap = ensureShardMap, checkStorage = waitForS3Bucket,
  timeoutMs = 600000, wait = ms => new Promise(r => setTimeout(r, ms)),
} = {}) {
  root = resolve(root);
  const directoryFor = id => {
    if (!/^odb-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid installation ID');
    return join(root, id);
  };
  async function read(id) { return readJson(join(directoryFor(id), 'installation.json')); }
  async function save(record) { return writeJson(join(directoryFor(record.id), 'installation.json'), record); }
  return {
    root,
    async create(input, requestId, release) {
      if (typeof requestId !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw new Error('A valid setup request ID is required');
      const values = normalizeAnswers(input);
      const { settings, secrets } = splitAnswers(values);
      const id = `odb-${createHash('sha256').update(requestId).digest('hex').slice(0, 12)}`;
      const directory = directoryFor(id);
      const previous = await readJson(join(directory, 'installation.json'), null);
      if (previous) {
        if (JSON.stringify(previous.settings) !== JSON.stringify(settings)) throw new Error('This setup request was already used for another configuration');
        return publicRecord(previous);
      }
      // Exclusive directory creation also serializes duplicate submissions across managers.
      await ensurePrivateDirectory(root);
      try { await mkdir(directory, { mode: 0o700 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const conflict = new Error('This setup request is being saved; retry the same request'); conflict.statusCode = 409; throw conflict;
      }
      await writeJson(join(directory, 'secrets.json'), {
        ...secrets, jwtSecret: randomBytes(32).toString('base64url'), clusterSecret: randomBytes(32).toString('base64url'),
      });
      const record = { version: 1, id, settings, release, capacity: capacity(values), phase: 'pending', completed: [], events: [], topology: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null };
      await save(record);
      return publicRecord(record);
    },
    async list() {
      const entries = await readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
      const records = await Promise.all(entries.filter(n => /^odb-[a-f0-9]{12}$/.test(n)).map(async id => {
        const record = await read(id).catch(() => null);
        return record ? publicRecord(await withInterruptedStatus(record)) : null;
      }));
      return records.filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async describe(id, { refresh = true } = {}) {
      const record = await withInterruptedStatus(await read(id));
      const result = publicRecord(record);
      const operation = record.management?.operationId ? await readJson(join(directoryFor(id), 'operations', `${record.management.operationId}.json`), null) : null;
      if (operation && !['complete', 'discarded'].includes(operation.status)) result.stale = true;
      if (refresh && record.phase === 'ready' && !result.stale) {
        try {
          result.topology = await adapters.inspect({ record, directory: directoryFor(id), secrets: await readJson(join(directoryFor(id), 'secrets.json')) });
          result.observationError = null;
        } catch {
          result.observationError = 'The cluster could not be reached. Showing the last saved topology.';
          result.stale = true;
        }
      }
      return result;
    },
    async run(id, { onEvent = () => {} } = {}) {
      const directory = directoryFor(id);
      const lockPath = join(directory, 'setup.lock');
      const lockToken = randomBytes(16).toString('hex');
      await acquire(lockPath, lockToken);
      let record, secrets, localLock;
      let saving = Promise.resolve();
      try {
        record = await read(id);
        if (record.phase === 'ready') return publicRecord(record);
        secrets = await readJson(join(directory, 'secrets.json'));
        record.error = null;
        const emit = message => {
          const event = { at: new Date().toISOString(), message: redact(message, secrets) };
          record.events = [...record.events.slice(-99), event];
          record.updatedAt = event.at;
          // Capture each snapshot now so concurrent progress reporters cannot reorder state.
          const snapshot = structuredClone(record);
          saving = saving.then(() => save(snapshot));
          try { onEvent(event); } catch { /* reporting cannot interrupt setup */ }
        };
        async function phase(name, message, operation, { always = false } = {}) {
          if (!always && record.completed.includes(name)) return;
          record.phase = name;
          emit(message);
          await saving;
          await operation();
          if (!record.completed.includes(name)) record.completed.push(name);
          await saving;
          await save(record);
        }
        if (['docker', 'node-process'].includes(record.settings.target)) {
          // Hold the local allocation lock until services have bound their ports.
          const path = join(root, 'local-setup.lock');
          const deadline = Date.now() + timeoutMs;
          let reported = false;
          while (true) {
            try { await acquire(path, lockToken); localLock = path; break; }
            catch (error) {
              if (error.statusCode !== 409) throw error;
              if (Date.now() >= deadline) throw new Error('Another local setup is still running. Retry this setup after it finishes.');
              if (!reported) { record.phase = 'preparing'; emit('Waiting for another local setup to finish'); reported = true; }
              await wait(1000);
            }
          }
        }
        let prepared;
        await phase('preparing', 'Checking your installation settings', async () => {
          prepared = await adapters.prepare({ record, directory, secrets, emit });
        }, { always: true });
        const { plan, paths, driver, storage, environment } = prepared;
        await phase('storage', 'Preparing cluster storage', async () => {
          const generated = await storage.ensureSecrets?.(plan, { environment }) || {};
          if (generated.OBJYDB_S3_ACCESS_KEY) secrets.accessKey = generated.OBJYDB_S3_ACCESS_KEY;
          if (generated.OBJYDB_S3_SECRET_KEY) secrets.secretKey = generated.OBJYDB_S3_SECRET_KEY;
          Object.assign(environment, generated);
          await writeJson(join(directory, 'secrets.json'), secrets);
          if (storage.id === 'external-s3') await checkStorage(plan, environment, { timeoutMs: 15000 });
          await storage.provision?.(plan, paths, { targetDriver: driver, environment });
        });
        await phase('shard-map', 'Connecting shards and replicas', () => publishShardMap(plan, resolvePlanSecrets(plan, environment)));
        await phase('runtime', 'Installing and starting database nodes', () => prepared.start());
        await phase('readiness', 'Waiting for all nodes to restore their data', async () => {
          const deadline = Date.now() + timeoutMs;
          let lastReady = -1;
          while (Date.now() < deadline) {
            const topology = await prepared.observe();
            record.topology = topology;
            const ready = topology.nodes.filter(n => n.status === 'ready').length;
            if (ready !== lastReady) { emit(`${ready}/${plan.nodes.length} nodes ready`); lastReady = ready; }
            if (topology.nodes.length === plan.nodes.length && ready === plan.nodes.length && topology.endpointReady) return;
            await wait(2000);
          }
          throw new Error('The cluster did not become reachable in time. Check its nodes, storage and client endpoint, then retry setup.');
        });
        record.phase = 'ready';
        emit('Your cluster is ready');
        await saving;
        await save(record);
        return publicRecord(record);
      } catch (error) {
        if (record && secrets) {
          await saving;
          record.phase = 'failed';
          record.error = redact(error.message, secrets);
          // A retry may finish a partially started runtime, but never changes desired topology.
          record.completed = record.completed.filter(p => !['runtime', 'readiness'].includes(p));
          record.updatedAt = new Date().toISOString();
          await save(record);
          const safeError = new Error(record.error); safeError.statusCode = error.statusCode; throw safeError;
        }
        throw error;
      } finally {
        if (localLock && (await readJson(localLock, null))?.token === lockToken) await rm(localLock, { force: true });
        const lock = await readJson(lockPath, null);
        if (lock?.token === lockToken) await rm(lockPath, { force: true });
      }
    },
  };

  async function withInterruptedStatus(record) {
    if (!['pending', 'ready', 'failed'].includes(record.phase)) {
      const lock = await readJson(join(directoryFor(record.id), 'setup.lock'), null);
      if (!lock || !processExists(lock.pid)) return { ...record, phase: 'interrupted', error: 'Setup was interrupted. Retry to continue with the same resources.' };
    }
    return record;
  }
}

function publicRecord(record) {
  return {
    release: record.release, management: record.management || null,
    id: record.id, name: record.settings.name, target: record.settings.target,
    region: record.settings.region, protocol: record.settings.protocol, capacity: record.capacity, dns: record.dns || null,
    phase: record.phase, error: record.error, events: record.events, topology: record.topology,
    createdAt: record.createdAt, updatedAt: record.updatedAt,
  };
}
