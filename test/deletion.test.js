import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManager } from '../src/manager.js';
import { createSetupService } from '../src/deployment/service.js';
import { readJson, writeJson, writePrivateFile } from '../src/deployment/files.js';
import { withLock } from '../src/deployment/operations.js';

async function fixture(t, { failRemove = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'objy-delete-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const calls = [], stopped = new Set();
  const driver = {
    checkRemoval: async () => calls.push('ownership'),
    stop: async paths => { calls.push('stop'); stopped.add(paths.root); },
    status: async paths => { const plan = await readJson(paths.plan); return plan.nodes.map(node => ({ nodeId: node.id, state: stopped.has(paths.root) ? 'exited' : 'running' })); },
    destroy: async () => { calls.push('destroy'); if (failRemove) { failRemove = false; throw new Error('cleanup failed using private-secret'); } },
  };
  const adapters = { inspect: async () => null, async open({ directory }) {
    const paths = { root: join(directory, 'runtime'), plan: join(directory, 'runtime/plan.json') };
    return { paths, plan: await readJson(paths.plan), driver, environment: {}, storage: { stop: async () => calls.push('storage-stop') } };
  } };
  const setup = createSetupService({ root, adapters });
  const manager = createManager({ root, setup, adapters, check: async () => calls.push('check') });
  async function create(name = 'demo', { target = 'node-process', storage = target === 'docker' ? 'docker-minio' : 'local-s3', plan = true } = {}) {
    const values = { name, target, preset: 'tiny', storage, adminPassword: 'private-secret',
      ...(storage === 'external-s3' ? { s3Endpoint: 'http://localhost:19333', s3Region: 'test', s3Bucket: 'shared', accessKey: 'access', secretKey: 'secret' } : {}) };
    // VM and cloud fixtures are created as local deployments then only their target is changed.
    const item = await setup.create({ ...values, target: ['vm','hetzner'].includes(target) ? 'node-process' : target }, randomUUID(), { version: 'test' });
    const directory = join(root, item.id), record = await readJson(join(directory, 'installation.json'));
    record.settings.target = target; record.phase = plan ? 'ready' : 'failed'; await writeJson(join(directory, 'installation.json'), record);
    if (plan) await writeJson(join(directory, 'runtime/plan.json'), { deployment: item.id, driver: target, target: { docker: { projectName: item.id } },
      nodes: [{ id: `${item.id}-s1-r1`, service: `${item.id}-s1-r1` }], storage: { driver: storage, runtimeEndpoint: 'http://127.0.0.1:19333' },
      persistence: { endpoint: 'http://127.0.0.1:19333', bucket: 'shared' } });
    await writePrivateFile(join(directory, 'wal/data'), 'disposable local data');
    return { ...item, directory };
  }
  return { root, manager, create, calls, stopped };
}

for (const target of ['node-process', 'docker']) test(`delete removes only a ${target} deployment and its dedicated data`, async t => {
  const { root, manager, create, calls } = await fixture(t);
  const item = await create('demo', { target });
  await writePrivateFile(join(root, 'releases/shared-cache'), 'retain');
  const preview = await manager.deletionInfo('demo');
  assert.equal(preview.id, item.id); assert.deepEqual(preview.blockedBy, []);
  assert.ok(preview.removes.some(line => line.includes('all data')));
  await assert.rejects(manager.delete('demo', { confirmation: 'wrong-name' }), /confirm deletion/);
  assert.deepEqual(calls, []);
  assert.equal((await manager.delete('demo', { confirmation: 'demo' })).state, 'deleted');
  await assert.rejects(readFile(join(item.directory, 'installation.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'releases/shared-cache'), 'utf8'), 'retain');
  assert.equal((await manager.list()).length, 0);
  assert.ok(calls.indexOf('stop') < calls.indexOf(target === 'docker' ? 'destroy' : 'storage-stop'));
});

test('existing S3 storage remains untouched and blocks deleting its storage provider', async t => {
  const { manager, create, calls } = await fixture(t);
  await create('provider'); await create('consumer', { storage: 'external-s3' });
  assert.deepEqual((await manager.deletionInfo('provider')).blockedBy, ['consumer']);
  await assert.rejects(manager.delete('provider', { confirmation: 'provider' }), /Storage is used by consumer/);
  assert.deepEqual(calls, []);
  const preview = await manager.deletionInfo('consumer');
  assert.ok(preview.preserves.includes('Existing S3 storage and its contents'));
  await manager.delete('consumer', { confirmation: 'consumer' });
  assert.ok(!calls.includes('storage-stop'));
  await manager.delete('provider', { confirmation: 'provider' });
  assert.equal((await manager.list()).length, 0);
});

test('failed deletion retains private state, blocks other mutations and resumes', async t => {
  const { manager, create, calls } = await fixture(t, { failRemove: true });
  const item = await create('demo', { target: 'docker' });
  await assert.rejects(manager.delete('demo', { confirmation: 'demo' }), /cleanup failed using \[redacted\]/);
  const state = await readJson(join(item.directory, 'installation.json'));
  assert.deepEqual(state.management.operation.completed, ['stop']);
  assert.equal((await readJson(join(item.directory, 'secrets.json'))).adminPassword, 'private-secret');
  assert.equal((await manager.status('demo')).state, 'interrupted');
  await assert.rejects(manager.act('demo', 'start'), /Deletion is unfinished/);
  await assert.rejects(manager.rename('demo', 'renamed'), /current operation/);
  assert.equal((await manager.resume('demo')).state, 'deleted');
  assert.equal(calls.filter(call => call === 'stop').length, 1);
  assert.equal(calls.filter(call => call === 'destroy').length, 2);
});

test('deletion rejects cloud and VM deployments before inspecting or changing resources', async t => {
  const { manager, create, calls } = await fixture(t);
  for (const target of ['hetzner','vm']) {
    await create(target, { target });
    await assert.rejects(manager.deletionInfo(target), /only for Local and Docker/);
    await assert.rejects(manager.delete(target, { confirmation: target }), /only for Local and Docker/);
  }
  assert.deepEqual(calls, []);
});

test('resumed deletion stops database nodes again if they were restarted outside the CLI', async t => {
  const { manager, create, calls, stopped } = await fixture(t, { failRemove: true });
  const item = await create('demo', { target: 'docker' });
  await assert.rejects(manager.delete('demo', { confirmation: 'demo' }), /cleanup failed/);
  stopped.delete(join(item.directory, 'runtime'));
  await manager.resume('demo');
  assert.equal(calls.filter(call => call === 'stop').length, 2);
});

test('deletion can finish partial local-state cleanup without runtime files or dependencies', async t => {
  const { manager, create, calls } = await fixture(t);
  const item = await create('demo', { target: 'docker' });
  const state = await readJson(join(item.directory, 'installation.json'));
  state.management = { operation: { action: 'delete', status: 'pending', completed: ['stop','resources'] } };
  await writeJson(join(item.directory, 'installation.json'), state);
  await rm(join(item.directory, 'runtime/plan.json')); await rm(join(item.directory, 'secrets.json'));
  await writeJson(join(item.directory, 'runtime/compose.json'), {});
  assert.equal((await manager.resume('demo')).state, 'deleted');
  assert.deepEqual(calls, []);
});

test('failed setup without a runtime can be deleted and active operations prevent deletion', async t => {
  const { manager, create, calls } = await fixture(t);
  const item = await create('unfinished', { plan: false });
  await withLock(join(item.directory, 'setup.lock'), async () => {
    await assert.rejects(manager.delete('unfinished', { confirmation: 'unfinished' }), /already running/);
    await assert.rejects(manager.rename('unfinished', 'renamed'), /already running/);
  });
  assert.equal((await manager.delete('unfinished', { confirmation: 'unfinished' })).state, 'deleted');
  assert.deepEqual(calls, []);
});

test('changed deployment identities and symlinked directories are never deleted', async t => {
  const { root, manager, create, calls } = await fixture(t);
  const item = await create();
  const planPath = join(item.directory, 'runtime/plan.json'), plan = await readJson(planPath);
  await writeJson(planPath, { ...plan, deployment: 'unrelated' });
  await assert.rejects(manager.delete('demo', { confirmation: 'demo' }), /does not belong/);
  await writeJson(planPath, plan);
  const preserved = join(root, 'preserved-data');
  await rename(item.directory, preserved); await symlink(preserved, item.directory, 'dir');
  await assert.rejects(manager.delete(item.id, { confirmation: 'demo' }), /regular directory/);
  assert.equal((await readJson(join(preserved, 'installation.json'))).settings.name, 'demo');
  assert.deepEqual(calls, []);
});

test('renaming preserves identity, resources, credentials and access through a fresh manager', async t => {
  const { root, manager, create, calls } = await fixture(t);
  const item = await create();
  const plan = await readFile(join(item.directory, 'runtime/plan.json')), secrets = await readFile(join(item.directory, 'secrets.json'));
  const renamed = await manager.rename('demo', 'new-name', { expectedId: item.id });
  assert.equal(renamed.id, item.id); assert.equal(renamed.name, 'new-name');
  assert.deepEqual(await readFile(join(item.directory, 'runtime/plan.json')), plan);
  assert.deepEqual(await readFile(join(item.directory, 'secrets.json')), secrets);
  await assert.rejects(manager.status('demo'), /Unknown deployment/);
  assert.equal((await createManager({ root }).list())[0].name, 'new-name');
  assert.deepEqual(calls, []);
  await manager.delete('new-name', { confirmation: 'new-name' });
});

test('renaming rejects invalid, duplicate and stale names and works for cloud deployments', async t => {
  const { manager, create, calls } = await fixture(t);
  const item = await create('demo'); const other = await create('occupied', { target: 'hetzner' });
  for (const name of ['../outside', 'Uppercase', '']) await assert.rejects(manager.rename('demo', name));
  await assert.rejects(manager.rename('demo', 'occupied'), /already exists/);
  await assert.rejects(manager.rename('demo', other.id), /already exists/);
  await assert.rejects(manager.rename('demo', 'new-name', { expectedId: other.id }), /deployment changed/);
  assert.equal((await manager.rename('occupied', 'cloud-name')).id, other.id);
  assert.equal((await manager.status('demo')).id, item.id);
  assert.deepEqual(calls, []);
});
