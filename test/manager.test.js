import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManager } from '../src/manager.js';
import { createSetupService } from '../src/deployment/service.js';
import { sampleManifest } from '../src/core/manifest.js';
import { readJson } from '../src/deployment/files.js';

async function fixture(t, { failSetup = false, failStop = false, managedStorage = false, failStorageStart = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'objy-manager-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [];
  let running = true;
  const plan = { nodes: [{ id: 'node-1', service: 'node-1' }], database: sampleManifest().database,
    persistence: { credentials: { accessKeyId: { fromEnvironment: 'OBJYDB_S3_ACCESS_KEY' }, secretAccessKey: { fromEnvironment: 'OBJYDB_S3_SECRET_KEY' } } } };
  const observe = async () => ({ nodes: [{ id: 'node-1', status: running ? 'ready' : 'unavailable' }], endpointReady: running });
  const driver = {
    async start() { calls.push('start'); running = true; },
    async stop(_paths, options) { calls.push('stop'); assert.deepEqual(options.services, ['node-1']); if (failStop) { failStop = false; throw new Error('temporary stop failure'); } running = false; },
    async status() { return [{ nodeId: 'node-1', state: running ? 'running' : 'exited' }]; },
    async readLogs() { return 'hello top-secret-password'; },
  };
  const storage = {
    id: managedStorage ? 'local-s3' : 'docker-minio',
    provision: async () => calls.push('storage'),
    ...(managedStorage ? { async start() {
      calls.push('storage-start');
      if (failStorageStart) { failStorageStart = false; throw new Error('storage is unavailable'); }
    } } : {}),
  };
  const adapters = {
    async prepare({ secrets }) {
      calls.push('prepare');
      return { plan, paths: {}, driver, environment: { OBJYDB_ADMIN_PASSWORD: secrets.adminPassword, OBJYDB_JWT_SECRET: secrets.jwtSecret, OBJYDB_CLUSTER_SECRET: secrets.clusterSecret, OBJYDB_S3_ACCESS_KEY: 'fixture-access', OBJYDB_S3_SECRET_KEY: 'fixture-secret' }, storage,
        start: async () => { calls.push('install'); if (failSetup) { failSetup = false; throw new Error('failure top-secret-password'); } }, observe };
    },
    inspect: observe,
    async open() { return { plan, paths: {}, driver, storage, environment: {}, observe }; },
  };
  const setup = createSetupService({ root, adapters, publishShardMap: async () => calls.push('shard-map') });
  const manager = createManager({ root, adapters, setup, check: async () => calls.push('check'),
    resolveLatestRelease: async () => { calls.push('latest-release'); return { version: 'v1.2.3' }; },
  });
  return { root, calls, manager };
}
const input = { name: 'test', target: 'docker', preset: 'tiny', adminPassword: 'top-secret-password' };

test('deployment names are unique, state is private, and secrets never appear in public records', async t => {
  const { root, manager } = await fixture(t);
  const record = await manager.deploy(input);
  assert.equal(record.phase, 'ready');
  assert.equal(record.release.version, 'v1.2.3');
  assert.ok(!JSON.stringify(record).includes(input.adminPassword));
  assert.ok(!JSON.stringify(await manager.list()).includes(input.adminPassword));
  const dir = join(root, record.id);
  assert.equal((await stat(join(dir, 'secrets.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  await assert.rejects(manager.deploy(input), /already exists/);
  assert.equal((await readdir(root)).filter(n => n.startsWith('odb-')).length, 1);
  assert.equal(await manager.logs('test'), 'hello [redacted]');
});

test('failed setup resumes the same deployment without recreating durable storage or shard map', async t => {
  const { manager, calls } = await fixture(t, { failSetup: true });
  await assert.rejects(manager.deploy(input), error => error.message.includes('[redacted]') && !error.message.includes(input.adminPassword));
  const before = (await manager.list())[0];
  assert.equal(before.phase, 'failed');
  const after = await manager.resume('test');
  assert.equal(after.id, before.id);
  assert.equal(after.phase, 'ready');
  assert.equal(calls.filter(c => c === 'storage').length, 1);
  assert.equal(calls.filter(c => c === 'shard-map').length, 1);
  assert.equal(calls.filter(c => c === 'latest-release').length, 1);
  assert.equal(after.release.version, before.release.version);
});

test('lifecycle failures persist, block competing actions and resume', async t => {
  const { manager, root, calls } = await fixture(t, { failStop: true });
  const record = await manager.deploy(input);
  await assert.rejects(manager.act('test', 'stop'), /temporary stop failure/);
  await assert.rejects(manager.act('test', 'start'), /unfinished/);
  assert.equal((await manager.status('test')).state, 'interrupted');
  assert.equal((await manager.resume('test')).state, 'stopped');
  assert.equal((await manager.act('test', 'start')).state, 'running');
  assert.equal((await manager.act('test', 'restart')).state, 'running');
  const state = await readJson(join(root, record.id, 'installation.json'));
  assert.deepEqual(state.management.operation.completed, ['stop', 'start']);
  assert.equal(state.management.operation.status, 'complete');
  assert.equal(calls.filter(c => c === 'latest-release').length, 1);
});

test('concurrent deployment submissions do not create duplicate names', async t => {
  const { manager } = await fixture(t);
  const results = await Promise.allSettled([manager.deploy(input), manager.deploy(input)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await manager.list()).length, 1);
});

test('starting waits for managed storage and resumes a failed storage start', async t => {
  const { manager, calls } = await fixture(t, { managedStorage: true, failStorageStart: true });
  await manager.deploy(input);
  await manager.act('test', 'stop');
  calls.length = 0;
  await assert.rejects(manager.act('test', 'start'), /storage is unavailable/);
  assert.ok(!calls.includes('start'));
  assert.equal((await manager.status('test')).state, 'interrupted');
  assert.equal((await manager.resume('test')).state, 'running');
  assert.deepEqual(calls.filter(c => ['storage-start', 'start'].includes(c)), ['storage-start', 'storage-start', 'start']);
});

test('missing dependencies fail before deployment state or resources are created', async t => {
  const { root, calls } = await fixture(t);
  const manager = createManager({ root, check: async () => { throw new Error('Install Terraform'); } });
  await assert.rejects(manager.deploy(input), /Install Terraform/);
  assert.deepEqual(await readdir(root), []);
  assert.deepEqual(calls, []);
});
