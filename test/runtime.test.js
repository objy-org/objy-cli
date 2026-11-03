import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createNodeProcessDriver } from '../src/drivers/node-process/index.js';
import { createSystemdNodeRuntime } from '../src/drivers/systemd-node-runtime.js';
import { writeJson } from '../src/deployment/files.js';
import { pinHostKey } from '../src/drivers/vm/ssh-transport.js';

async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'objy-runtime-test-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('SSH pins the first host key and refuses changed keys', async t => {
  const root = await temporary(t), connection = { host: '192.0.2.1', port: 22 };
  assert.equal(await pinHostKey(root, connection, 'a'.repeat(64)), true);
  assert.equal(await pinHostKey(root, connection, 'a'.repeat(64)), true);
  assert.equal(await pinHostKey(root, connection, 'b'.repeat(64)), false);
});

test('local lifecycle manages a real separate process and stops it gracefully', async t => {
  const root = await temporary(t), port = await freePort();
  await writeFile(join(root, 'server.cjs'), `const timer = setInterval(() => {}, 1000); process.on('SIGTERM', () => { console.log('graceful'); clearInterval(timer); });`);
  const paths = { root, plan: join(root, 'plan.json') };
  await writeJson(paths.plan, { target: { nodeProcess: { directory: root, entrypoint: 'server.cjs' } }, nodes: [{ id: 'fixture', port, peerUrl: `http://127.0.0.1:${port}` }], public: { protocol: 'http', bindAddress: '127.0.0.1' }, runtime: { heapMb: 128 }, configPath: join(root, 'config.json') });
  const driver = createNodeProcessDriver();
  try {
    await driver.start(paths);
    assert.equal((await driver.status(paths))[0].state, 'running');
    const records = JSON.parse(await readFile(join(root, 'processes.json')));
    assert.ok(records[0].identity.includes('server.cjs'));
    await driver.start(paths); // Already running is idempotent.
    await driver.stop(paths);
    assert.equal((await driver.status(paths))[0].state, 'exited');
    assert.match(await driver.readLogs(paths), /graceful/);
  } finally { await driver.stop(paths); }
});

test('stale PID records never signal an unrelated process', async t => {
  const root = await temporary(t);
  await writeJson(join(root, 'processes.json'), [{ nodeId: 'stale', pid: process.pid, identity: 'not this process' }]);
  await createNodeProcessDriver().stop({ root });
  assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test('VM runtime uses separate server releases and graceful systemd units; cloud TLS stays off nodes', async t => {
  const root = await temporary(t);
  const paths = { root, plan: join(root, 'plan.json'), databaseConfig: join(root, 'database.json') };
  await writeJson(paths.plan, { deployment: 'fixture', databaseVersion: 'test', public: { protocol: 'https' }, runtime: { heapMb: 2048 }, nodes: [{ id: 'fixture-s1-r1', port: 8080, peerUrl: 'http://10.0.0.2:8080' }] });
  await writeJson(paths.databaseConfig, {});
  const remote = [], local = [];
  const runtime = createSystemdNodeRuntime({
    run: async (command, args) => { local.push([command, args]); return { stdout: '' }; },
    remote: async (_plan, _node, command, options = {}) => { remote.push({ command, input: options.input }); return { stdout: '' }; },
    upload: async () => {}, follow: async () => {}, manageHttps: false,
    settings: () => ({ sourceDirectory: root, entrypoint: 'src/index.js', remoteDirectory: '/opt/objydb', walDirectory: '/var/lib/objydb/wal', serviceUser: 'objydb' }),
    environmentFile: () => 'OBJYDB_ADMIN_PASSWORD=fixture-secret',
  });
  await runtime.deploy(paths);
  const unit = remote.find(call => call.input?.includes('[Unit]')).input;
  assert.match(unit, /SendSIGKILL=no/);
  assert.match(unit, /current\/src\/index.js/);
  assert.ok(remote.some(call => call.command.includes('npm ci --omit=dev --ignore-scripts')));
  assert.ok(!remote.some(call => call.command.includes('caddy')));
  assert.equal(local[0][0], 'tar');
  await runtime.action(paths, 'stop');
  assert.match(remote.at(-1).command, /systemctl stop 'objydb-fixture-s1-r1.service'/);
});
