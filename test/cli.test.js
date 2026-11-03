import test from 'node:test';
import assert from 'node:assert/strict';
import { main, parseCommand, logDelta } from '../src/cli.js';
import { normalizeAnswers, capacity, splitAnswers } from '../src/deployment/catalog.js';
import { runWizard } from '../src/deployment/wizard.js';
import { doctor } from '../src/doctor.js';

const base = { target: 'docker', name: 'demo', preset: 'tiny', adminPassword: 'not-a-real-password' };
function io() {
  const result = { stdout: '', stderr: '' };
  return { result, input: { isTTY: false }, output: { isTTY: false, write: text => { result.stdout += text; } }, error: { write: text => { result.stderr += text; } } };
}

test('presets match Terraform topology and secrets are separated', () => {
  for (const [preset, expected] of [['tiny', [1, 1, 2048]], ['small', [1, 3, 2048]], ['medium', [2, 3, 4096]], ['large', [4, 3, 8192]]]) {
    const values = normalizeAnswers({ ...base, preset });
    const size = capacity(values);
    assert.deepEqual([size.shards, size.replicas, size.heapMb], expected);
    assert.equal(size.nodes, expected[0] * expected[1]);
    const split = splitAnswers(values);
    assert.equal(split.settings.adminPassword, undefined);
    assert.equal(split.secrets.adminPassword, base.adminPassword);
  }
  assert.throws(() => normalizeAnswers({ ...base, name: '../escape' }), /name/);
  assert.throws(() => normalizeAnswers({ ...base, preset: 'custom', shards: 32, replicas: 3 }), /64/);
});

test('wizard asks only missing questions and never prints supplied secrets', async () => {
  let output = '';
  const prompts = [];
  const value = await runWizard({ initial: base, output: { write: text => { output += text; } }, ask: async (field) => {
    prompts.push(field.id);
    return field.id === 'confirm' ? 'y' : '';
  } });
  assert.equal(value.name, 'demo');
  assert.ok(!prompts.includes('target') && !prompts.includes('adminPassword'));
  assert.ok(!output.includes(base.adminPassword));
});

test('no run command, unknown flags and excess arguments are rejected', () => {
  assert.throws(() => parseCommand(['run']), /Unknown command/);
  assert.throws(() => parseCommand(['stop', 'demo', '--size', 'tiny']), /not valid/);
  assert.throws(() => parseCommand(['start', 'demo', 'oops']), /Too many/);
  assert.throws(() => parseCommand(['deploy', '--typo']), /Unknown option/);
});

test('noninteractive deployment requires explicit confirmation and size; JSON is machine-readable', async () => {
  const streams = io();
  let deployed;
  const managerFactory = () => ({ deploy: async values => { deployed = values; return { name: values.name, target: 'local', state: 'ready' }; } });
  let code = await main(['deploy', 'local', '--json'], { ...streams, managerFactory });
  assert.equal(code, 1); assert.match(JSON.parse(streams.result.stdout).error, /--yes/); assert.equal(deployed, undefined);
  streams.result.stdout = '';
  code = await main(['deploy', 'local', '--name', 'dev', '--size', 'tiny', '--yes', '--json'], { ...streams, managerFactory, environment: { OBJY_ADMIN_PASSWORD: 'secret-value' } });
  assert.equal(code, 0); assert.equal(deployed.target, 'node-process');
  assert.equal(deployed.adminPassword, 'secret-value');
  assert.equal(JSON.parse(streams.result.stdout).name, 'dev');
  assert.ok(!streams.result.stdout.includes('secret-value'));
});

test('read-only commands do not perform dependency checks', async () => {
  const streams = io();
  let queried = false;
  const code = await main(['status', 'demo', '--json'], { ...streams,
    doctorImpl: () => { throw new Error('must not run'); },
    managerFactory: () => ({ status: async name => { queried = true; return { name }; } }),
  });
  assert.equal(code, 0); assert.equal(queried, true);
});

test('Terraform is external, target-specific, version-checked and has an installation link', async () => {
  const commands = [];
  const run = async (binary) => { commands.push(binary); if (binary === 'terraform') throw new Error('ENOENT'); return { stdout: '22.0.0' }; };
  assert.equal((await doctor('local', { run })).ok, true);
  assert.ok(!commands.includes('terraform'));
  const cloud = await doctor('hetzner', { run, environment: {}, sourceRequired: false });
  assert.equal(cloud.ok, false);
  assert.equal(cloud.checks.find(c => c.name.startsWith('Terraform')).install, 'https://developer.hashicorp.com/terraform/install');
  const old = await doctor('hetzner', { sourceRequired: false, run: async binary => ({ stdout: binary === 'terraform' ? '{"terraform_version":"1.6.6"}' : '' }) });
  assert.equal(old.ok, false);
});

test('log following emits added content, including a rotated tail', () => {
  assert.equal(logDelta('a\nb\n', 'a\nb\nc\n'), 'c\n');
  assert.equal(logDelta('a\nb', 'b\nc'), 'c');
  assert.equal(logDelta('a\nb\n', 'b\nc\n'), 'c\n');
  assert.equal(logDelta('same', 'same'), '');
});
