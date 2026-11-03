import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAdapters } from '../src/deployment/adapters.js';
import { readJson, writeJson } from '../src/deployment/files.js';

for (const protocol of ['http', 'https']) test(`Docker ${protocol} topology shows live container IPs without changing peer or client URLs`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'objy-node-address-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const deployment = 'odb-0123456789ab';
  const nodes = [1, 2, 3].map(index => ({ id: `${deployment}-s1-r${index}`, shard: 'shard-0', replica: index - 1,
    internalPort: 8080, hostPort: 18000 + index, peerUrl: `http://${deployment}-s1-r${index}:8080`,
    healthUrl: `http://127.0.0.1:${18000 + index}`, publicUrl: protocol === 'https' ? 'https://localhost:18443' : `http://127.0.0.1:${18000 + index}` }));
  const plan = { driver: 'docker', target: { driver: 'docker', docker: { projectName: deployment } }, nodes,
    public: { protocol, bindAddress: '0.0.0.0' }, runtime: { heapMb: 1024 },
    edge: protocol === 'https' ? { service: 'objydb-caddy' } : undefined,
    storage: { driver: 'docker-minio' }, persistence: { bucket: 'test' } };
  const path = join(directory, 'runtime/plan.json');
  await writeJson(path, plan);
  const calls = [], probed = [];
  let firstIp = '172.23.0.3', inspectFailed = false;
  const adapters = createAdapters({
    fetchImpl: async url => { probed.push(url); return { ok: true, json: async () => ({ restore: { status: 'ready' } }) }; },
    lookup: async () => { throw new Error('Docker names must not be resolved on the host'); },
    run: async (command, args) => {
      calls.push({ command, args });
      assert.equal(command, 'docker');
      if (args[0] === 'compose') {
        assert.deepEqual(args.slice(3), ['ps', '--all', '--format', 'json']);
        return { stdout: [...nodes.map((node, i) => ({ ID: `container-${i}`, Service: node.id, State: 'running' })),
          { ID: 'edge', Service: 'objydb-caddy', State: 'running' }, { ID: 'storage', Service: 'objydb-minio', State: 'running' }].map(JSON.stringify).join('\n') };
      }
      assert.equal(args[0], 'inspect');
      assert.deepEqual(args.slice(-3), ['container-0', 'container-1', 'container-2']);
      assert.ok(!args.includes('edge') && !args.includes('storage'));
      if (inspectFailed) throw new Error('Container disappeared during inspection');
      return { stdout: nodes.map((node, i) => JSON.stringify({ service: node.id, networks: {
        unrelated: { IPAddress: '192.0.2.99' },
        [`${deployment}_objydb`]: i === 0 ? { IPAddress: firstIp } : i === 1 ? { IPAddress: '', GlobalIPv6Address: 'fd00::4' } : { IPAddress: '', GlobalIPv6Address: '' },
      } })).join('\n') };
    },
  });
  const inspect = () => adapters.inspect({ record: { settings: { target: 'docker' } }, directory, secrets: {} });
  const topology = await inspect();
  assert.deepEqual(topology.nodes.map(node => node.address), ['172.23.0.3:8080', '[fd00::4]:8080', null]);
  assert.ok(topology.nodes.every(node => node.status === 'ready'));
  assert.equal(topology.endpoint, nodes[0].publicUrl);
  assert.ok(probed.includes(`${nodes[0].healthUrl}/health`));
  firstIp = '172.23.0.9';
  assert.equal((await inspect()).nodes[0].address, '172.23.0.9:8080');
  inspectFailed = true;
  const unavailable = await inspect();
  assert.ok(unavailable.nodes.every(node => node.address === null));
  assert.ok(unavailable.nodes.every(node => node.status === 'ready'));
  assert.deepEqual((await readJson(path)).nodes, nodes);
  assert.ok(calls.every(call => ['compose', 'inspect'].includes(call.args[0])));
});
