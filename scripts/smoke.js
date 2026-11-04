// Opt-in integration check. Creates only disposable local deployments, then removes them.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManager } from '../src/manager.js';
import { createAdapters } from '../src/deployment/adapters.js';
import { runProcess } from '../src/core/process.js';

const root = await mkdtemp(join(tmpdir(), 'objy-cli-live-test-'));
const manager = createManager({ root, timeoutMs: 180000 });
const onEvent = event => console.log(event.message);
let cleanupFailed = false;
try {
  const docker = await manager.deploy({ target: 'docker', name: 'smoke-docker', preset: 'tiny', adminPassword: randomBytes(24).toString('hex') }, { onEvent });
  const storage = JSON.parse(await readFile(join(root, docker.id, 'runtime/plan.json'))).persistence;
  const credentials = JSON.parse(await readFile(join(root, docker.id, 'secrets.json')));
  await manager.deploy({ target: 'local', name: 'smoke-local', preset: 'small', adminPassword: randomBytes(24).toString('hex'),
    storage: 'external-s3', s3Endpoint: storage.endpoint, s3Region: storage.region, s3Bucket: storage.bucket,
    accessKey: credentials.accessKey, secretKey: credentials.secretKey }, { onEvent });
  await manager.deploy({ target: 'local', name: 'smoke-auto', preset: 'small', storage: 'auto', adminPassword: randomBytes(24).toString('hex') }, { onEvent });
  for (const name of ['smoke-local', 'smoke-auto', 'smoke-docker']) {
    const deployment = await manager.status(name);
    const secrets = JSON.parse(await readFile(join(root, deployment.id, 'secrets.json')));
    const endpoint = deployment.topology.endpoint;
    let token;
    async function request(path, method = 'GET', body) {
      const response = await fetch(endpoint + path, { method,
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
      assert.ok(response.ok, `${name}: ${method} ${path}: HTTP ${response.status}`);
      return response.json();
    }
    const login = async () => { token = (await request('/api/_global/users/auth', 'POST', { username: 'admin', password: secrets.adminPassword })).accessToken; };
    await login();
    await request('/api/databases', 'POST', { name: 'smoke' });
    await request('/api/smoke/collections', 'POST', { name: 'items' });
    await request('/api/smoke/items/object', 'POST', { _id: 'saved', value: 42 });
    assert.equal((await manager.act(name, 'stop', { onEvent })).state, 'stopped');
    if (name === 'smoke-auto') {
      const directory = join(root, deployment.id), record = JSON.parse(await readFile(join(directory, 'installation.json')));
      const context = await createAdapters().open({ record, directory, secrets });
      await context.storage.stop(context.plan, context.paths);
      // These are disposable test WALs. Force recovery from the persisted S3 data after storage restarts.
      await rm(join(directory, 'wal'), { recursive: true, force: true });
    }
    assert.equal((await manager.act(name, 'start', { onEvent })).state, 'running');
    await login();
    assert.equal((await request('/api/smoke/items/object/saved')).value, 42);
    await manager.act(name, 'restart', { onEvent });
    await login();
    assert.equal((await request('/api/smoke/items/object/saved')).value, 42);
    assert.ok((await manager.logs(name)).length);
    console.log(`${name}: deployment, topology, persistence, stop/start/restart and logs passed`);
  }
} finally {
  const deployments = await manager.list();
  // Stop database writers before removing their disposable backing store.
  for (const item of deployments.sort((a, b) => a.target === 'local' ? -1 : b.target === 'local' ? 1 : 0)) {
    try {
      const directory = join(root, item.id);
      const record = JSON.parse(await readFile(join(directory, 'installation.json')));
      const secrets = JSON.parse(await readFile(join(directory, 'secrets.json')));
      const context = await createAdapters().open({ record, directory, secrets });
      await context.driver.stop(context.paths, { environment: context.environment });
      if (context.plan.storage.driver === 'local-s3') await context.storage.stop(context.plan, context.paths);
      if (item.target === 'docker') await runProcess('docker', ['compose', '-f', join(directory, 'runtime/compose.json'), 'down', '-v'], { env: context.environment });
    } catch (error) { cleanupFailed = true; console.error(`Cleanup failed for ${item.name}: ${error.message}`); break; }
  }
  if (cleanupFailed) console.error(`Temporary state retained at ${root}`);
  else await rm(root, { recursive: true, force: true });
}
if (cleanupFailed) process.exitCode = 1;
