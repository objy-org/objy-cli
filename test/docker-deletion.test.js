import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDockerDriver, renderDockerCompose } from '../src/drivers/docker/index.js';
import { sampleManifest } from '../src/core/manifest.js';
import { readJson, writeJson } from '../src/deployment/files.js';

async function fixture(t, { foreignVolume = false, unknownService = false, sharedNetwork = false, retainedVolume = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'objy-docker-delete-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const id = 'odb-0123456789ab', node = `${id}-s1-r1`, volume = `${id}_${node}-wal`, calls = [];
  const plan = { deployment: id, driver: 'docker', target: { docker: { projectName: id } },
    nodes: [{ id: node, service: node, internalPort: 8080, hostPort: 19000, peerUrl: 'http://node:8080' }], runtime: { heapMb: 2048 },
    public: { protocol: 'http', bindAddress: '127.0.0.1' }, image: 'fixture', configPath: join(root,'database.json'), database: sampleManifest().database, storage: {} };
  const paths = { root, plan: join(root, 'plan.json') };
  await writeJson(paths.plan, plan); await writeJson(join(root, 'compose.json'), JSON.parse(renderDockerCompose(plan)));
  let removed = false;
  const driver = createDockerDriver({ run: async (command, args, options) => {
    calls.push({ command, args, options }); assert.equal(command, 'docker');
    if (args[0] === 'ps') return { stdout: removed ? '' : 'abcdef123456' };
    if (args[0] === 'inspect') return { stdout: JSON.stringify({ 'com.docker.compose.project': id, 'com.docker.compose.service': unknownService ? 'unknown' : node }) };
    if (args[0] === 'volume' && args[1] === 'ls') return { stdout: !removed || retainedVolume ? volume : '' };
    if (args[0] === 'volume' && args[1] === 'inspect') return { stdout: JSON.stringify({ 'com.docker.compose.project': foreignVolume ? 'other-project' : id }) };
    if (args[0] === 'network' && args[1] === 'ls') return { stdout: removed ? '' : `${id}_objydb` };
    if (args[0] === 'network' && args[1] === 'inspect') return { stdout: JSON.stringify({ labels: { 'com.docker.compose.project': id }, containers: { [sharedNetwork ? 'unrelated-container' : 'abcdef1234567890']: {} } }) };
    if (args[0] === 'compose') { assert.deepEqual(args.slice(3), ['down', '--volumes']); removed = true; return { stdout: '' }; }
    throw new Error(`Unexpected command ${args.join(' ')}`);
  } });
  return { root, paths, driver, calls, id, plan };
}

test('Docker deletion removes only its project and volumes and preserves shared images', async t => {
  const { paths, driver, calls, id } = await fixture(t);
  await driver.destroy(paths, { environment: { OBJYDB_S3_SECRET_KEY: 'private-fixture' } });
  const removed = calls.find(call => call.args[0] === 'compose');
  assert.equal(removed.options.env.OBJYDB_S3_SECRET_KEY, 'private-fixture');
  assert.equal((await readJson(removed.args[2])).name, id);
  assert.ok(!calls.some(call => ['rmi','prune'].includes(call.args[0])));
});

for (const [option, message] of [['foreignVolume', /another owner/], ['unknownService', /unknown container/], ['sharedNetwork', /shared with another/]]) {
  test(`Docker deletion refuses ${option} before resource removal`, async t => {
    const { driver, paths, calls } = await fixture(t, { [option]: true });
    await assert.rejects(driver.destroy(paths), message);
    assert.ok(!calls.some(call => call.args[0] === 'compose'));
  });
}

test('Docker deletion rejects edited resource names and confirms that volumes disappeared', async t => {
  const { root, driver, paths, calls } = await fixture(t);
  const config = await readJson(join(root,'compose.json'));
  await writeJson(join(root,'compose.json'), { ...config, volumes: { shared: { name: 'unrelated-data' } } });
  await assert.rejects(driver.destroy(paths), /configuration changed/);
  assert.equal(calls.length, 0);
  const retained = await fixture(t, { retainedVolume: true });
  await assert.rejects(retained.driver.destroy(retained.paths), /volumes still exist/);
});

test('stopped HTTPS database containers remain stopped when the edge is stopped', async t => {
  const { paths, plan } = await fixture(t);
  await writeJson(paths.plan, { ...plan, public: { ...plan.public, protocol: 'https' }, edge: { service: 'objydb-caddy' } });
  const driver = createDockerDriver({ run: async () => ({ stdout: [plan.nodes[0].id, 'objydb-caddy'].map(Service => JSON.stringify({ Service, State: 'exited' })).join('\n') }) });
  assert.equal((await driver.status(paths))[0].state, 'exited');
});
