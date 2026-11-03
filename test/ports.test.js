import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dockerPublishedPorts, reservedLocalPorts, findAvailablePortRange } from '../src/core/ports.js';
import { writeJson } from '../src/deployment/files.js';

test('Docker published port ranges are excluded even when host bind probes succeed', async () => {
  const reserved = dockerPublishedPorts('"0.0.0.0:8140-8143->8080-8083/tcp, [::]:9000->9000/tcp, 127.0.0.1:9001->9001/tcp"');
  assert.deepEqual([...reserved], [8140, 8141, 8142, 8143, 9000, 9001]);
  await assert.rejects(findAvailablePortRange(1, { start: 8140, end: 8143, reservedPorts: [...reserved] }), /no 1-port range/);
});

test('stopped deployments retain their port allocations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'objy-ports-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeJson(join(root, 'odb-0123456789ab/runtime/plan.json'), { driver: 'docker', nodes: [{ hostPort: 18080 }], edge: { port: 18081 }, storage: { targetExtensions: { docker: { services: { minio: { ports: ['127.0.0.1:19000:9000'] } } } } } });
  const ports = await reservedLocalPorts(root, async () => ({ stdout: '0.0.0.0:18090->8080/tcp' }));
  assert.deepEqual(new Set(ports), new Set([18090, 18080, 18081, 19000]));
});
