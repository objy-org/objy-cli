import test from 'node:test';
import assert from 'node:assert/strict';
import { main, parseCommand, logDelta } from '../src/cli.js';
import { normalizeAnswers, capacity, splitAnswers } from '../src/deployment/catalog.js';
import { runWizard } from '../src/deployment/wizard.js';
import { doctor } from '../src/doctor.js';
import { PassThrough } from 'node:stream';

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
  assert.throws(() => parseCommand(['deploy', '--release-manifest', 'custom.json']), /Unknown option/);
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

test('delete requires explicit confirmation and forwards the preview identity; rename uses two names', async () => {
  const streams = io(), calls = [];
  const preview = { id: 'odb-0123456789ab', name: 'demo', blockedBy: [], removes: ['data'], preserves: ['existing S3'] };
  const managerFactory = () => ({
    deletionInfo: async name => { calls.push(['preview', name]); return preview; },
    delete: async (id, options) => { calls.push(['delete', id, options.confirmation]); return { name: 'demo', state: 'deleted' }; },
    rename: async (name, next) => { calls.push(['rename', name, next]); return { name: next }; },
  });
  assert.equal(await main(['delete', 'demo', '--json'], { ...streams, managerFactory }), 1);
  assert.ok(!calls.some(call => call[0] === 'delete'));
  assert.equal(await main(['delete', 'demo', '--yes', '--json'], { ...streams, managerFactory }), 0);
  assert.deepEqual(calls.at(-1), ['delete', preview.id, 'demo']);
  assert.equal(await main(['rename', 'demo', 'new-name', '--json'], { ...streams, managerFactory }), 0);
  assert.deepEqual(calls.at(-1), ['rename', 'demo', 'new-name']);
  assert.throws(() => parseCommand(['rename', 'a', 'b', 'c']), /Too many/);
  assert.throws(() => parseCommand(['rename', 'a', 'b', '--yes']), /not valid/);
});

test('interactive deletion cancels when the typed deployment name differs', async () => {
  const input = new PassThrough(), output = new PassThrough(); input.isTTY = true; output.isTTY = true;
  let deleted = false, text = '';
  output.on('data', data => { text += data.toString(); if (data.toString().includes('to permanently delete')) queueMicrotask(() => input.write('different-name\n')); });
  const managerFactory = () => ({
    deletionInfo: async () => ({ id: 'odb-0123456789ab', name: 'demo', blockedBy: [], removes: ['stored data'], preserves: ['existing S3'] }),
    delete: async () => { deleted = true; },
  });
  assert.equal(await main(['delete', 'demo'], { input, output, managerFactory }), 0);
  assert.equal(deleted, false); assert.match(text, /stored data/); assert.match(text, /Cancelled/);
  input.destroy(); output.destroy();
});
