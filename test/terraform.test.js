import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createTerraformProvisioner, assertCreationPlan, snapshotModule } from '../src/deployment/terraform.js';

test('setup plans reject deletion, replacement and updates to existing infrastructure', () => {
  for (const actions of [['delete'], ['delete', 'create'], ['update']]) assert.throws(() => assertCreationPlan({ resource_changes: [{ change: { actions } }] }), /modify or remove/);
  assert.doesNotThrow(() => assertCreationPlan({ resource_changes: [{ change: { actions: ['create'] } }] }));
});

test('Terraform snapshots exclude credentials and state and remain stable on retry', async t => {
  const root = await mkdtemp(join(tmpdir(), 'objy-terraform-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'source'), snapshot = join(root, 'snapshot');
  await mkdir(source);
  await writeFile(join(source, 'main.tf'), '# original');
  await writeFile(join(source, 'terraform.tfvars'), 'secret = "not copied"');
  await writeFile(join(source, 'terraform.tfstate'), 'private-state');
  const first = await snapshotModule(source, snapshot);
  await writeFile(join(source, 'main.tf'), '# changed');
  assert.deepEqual(await snapshotModule(source, snapshot), first);
  assert.equal(await readFile(join(snapshot, 'main.tf'), 'utf8'), '# original');
  await assert.rejects(readFile(join(snapshot, 'terraform.tfvars')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(snapshot, 'terraform.tfstate')), { code: 'ENOENT' });
});

test('cloud creation uses a saved plan, isolated TF variables and a private module snapshot', async t => {
  const root = await mkdtemp(join(tmpdir(), 'objy-terraform-flow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, 'modules'), directory = join(root, 'deployment');
  await mkdir(join(source, 'installer/hetzner'), { recursive: true });
  await mkdir(directory);
  await writeFile(join(source, 'installer/hetzner/main.tf'), '# mock module');
  const calls = [];
  const id = 'odb-0123456789ab';
  const inventory = { schema_version: 2, endpoint: 'http://192.0.2.1', nodes: { 's1-r1': { id: `${id}-s1-r1`, host: '192.0.2.2', peer_host: '10.42.0.2', shard: 0, replica: 0 } } };
  const provisioner = createTerraformProvisioner({
    environment: { PATH: process.env.PATH, OBJY_TERRAFORM_DIRECTORY: source, TF_VAR_shards: '999', TF_CLI_ARGS_apply: '-destroy', TF_WORKSPACE: 'unrelated' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ server_types: [{ name: 'cx23', architecture: 'x86', memory: 4, cores: 2, prices: [{ location: 'fsn1' }] }] }) }),
    run: async (_binary, args, options) => {
      calls.push({ args, options });
      if (args[0] === 'version') return { stdout: '{"terraform_version":"1.16.6"}' };
      assert.equal(options.env.TF_VAR_shards, undefined);
      assert.equal(options.env.TF_CLI_ARGS_apply, undefined);
      assert.equal(options.env.TF_WORKSPACE, undefined);
      assert.equal(options.env.HCLOUD_TOKEN, 'fake-token');
      if (args[0] === 'show') return { stdout: JSON.stringify({ resource_changes: [{ change: { actions: ['create'] } }] }) };
      if (args[0] === 'output') return { stdout: JSON.stringify(inventory) };
      return { stdout: '' };
    },
  });
  const ctx = { directory, record: { id, settings: { protocol: 'http', region: 'fsn1' }, capacity: { nodes: 1, shards: 1, replicas: 1, heapMb: 2048 } }, secrets: { cloudToken: 'fake-token' }, emit() {} };
  await provisioner.create(ctx);
  assert.deepEqual(calls.find(c => c.args[0] === 'apply').args, ['apply', '-input=false', '-no-color', '-lock-timeout=30s', 'setup.tfplan']);
  const count = calls.length;
  await provisioner.create(ctx);
  assert.equal(calls.length, count);
});
