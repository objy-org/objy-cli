import test from 'node:test';
import assert from 'node:assert/strict';
import { get } from 'node:http';
import { startUi } from '../src/ui/server.js';
import { parseCommand } from '../src/cli.js';

const answers = { target: 'docker', name: 'demo', preset: 'tiny', adminPassword: 'test-password-123' };

async function fixture(t, options = {}) {
  const calls = [];
  const record = { id: 'odb-0123456789ab', name: 'demo', target: 'docker', phase: 'ready', state: 'ready', topology: { nodes: [], endpoint: 'http://127.0.0.1:8080' } };
  const manager = {
    list: async () => [record], status: async name => { calls.push(['status', name]); return record; },
    logs: async (name, options) => { calls.push(['logs', name, options]); return 'ready\n'; },
    deploy: async (values, options) => { calls.push(['deploy', values]); options.onEvent({ message: 'Starting nodes' }); return record; },
    act: async (name, action) => { calls.push([action, name]); }, resume: async name => { calls.push(['resume', name]); },
    deletionInfo: async () => ({ id: record.id, name: record.name, target: record.target, removes: ['local data'], preserves: ['existing S3'], blockedBy: [] }),
    delete: async (id, options) => { calls.push(['delete', id, options.confirmation]); return { state: 'deleted' }; },
    rename: async (name, next, options) => { calls.push(['rename', name, next, options.expectedId]); return { ...record, name: next }; },
    ...options.manager,
  };
  const ui = await startUi({ environment: {}, openBrowser: false, port: 0, ...options, manager,
    doctorImpl: async (target, options) => { calls.push(['doctor', target, options.protocol]); return { ok: true, checks: [] }; },
  });
  t.after(async () => { await ui.settled(); await ui.close(); });
  const page = await fetch(ui.url);
  const html = await page.text();
  const token = html.match(/name="objy-token" content="([a-f0-9]+)"/)[1];
  const request = (path, body, headers = {}) => fetch(ui.url + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'x-objy-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { ui, request, calls, page, html, token };
}

test('UI is local-only and rejects unauthenticated or cross-origin commands', async t => {
  await assert.rejects(startUi({ host: '0.0.0.0' }), /127.0.0.1/);
  const { ui, request, calls, html, page } = await fixture(t);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.ok(!html.includes('__TOKEN__') && !html.includes('__NONCE__'));
  assert.ok(!html.includes('release-file') && !html.includes('Server release manifest'));
  assert.equal((await fetch(ui.url + '/api/clusters')).status, 403);
  const wrongHost = await new Promise((resolve, reject) => get(ui.url, { headers: { host: 'unrelated.example' } }, response => { response.resume(); resolve(response.statusCode); }).on('error', reject));
  assert.equal(wrongHost, 403);
  for (const headers of [{ origin: 'https://unrelated.example' }, { 'sec-fetch-site': 'cross-site' }, { 'x-objy-token': 'wrong' }]) {
    assert.equal((await request('/api/deploy', { answers }, headers)).status, 403, JSON.stringify(headers));
  }
  assert.equal(calls.length, 0);
  assert.equal((await request('/api/missing')).status, 404);
  assert.match(await (await fetch(ui.url + '/catalog.js')).text(), /export function wizardFields/);
});

test('browser reads topology, logs and dependency checks through the shared services', async t => {
  const { request, calls } = await fixture(t);
  assert.equal((await (await request('/api/clusters')).json())[0].name, 'demo');
  assert.equal((await (await request('/api/clusters/demo')).json()).state, 'ready');
  assert.deepEqual(await (await request('/api/clusters/demo/logs?node=first&lines=42')).json(), { logs: 'ready\n' });
  assert.equal((await request('/api/doctor', { target: 'hetzner', protocol: 'https' })).status, 200);
  assert.deepEqual(calls, [['status', 'demo'], ['logs', 'demo', { node: 'first', tail: 42 }], ['doctor', 'hetzner', 'https']]);
});

test('deployment uses environment credentials without sending them to the browser', async t => {
  const password = 'env-password-456';
  let received;
  const { request, ui, html } = await fixture(t, { environment: { OBJY_ADMIN_PASSWORD: password }, manager: {
    deploy: async (values, { onEvent }) => { received = values; onEvent({ message: `Connecting with ${password}` }); },
  } });
  assert.deepEqual(await (await request('/api/session')).json(), { providedCredentials: ['adminPassword'] });
  assert.ok(!html.includes(password));
  const response = await request('/api/deploy', { answers: { ...answers, adminPassword: '' } });
  assert.equal(response.status, 202);
  await ui.settled();
  assert.equal(received.adminPassword, password);
  assert.equal(received.storage, 'docker-minio');
  const jobs = await (await request('/api/jobs')).json();
  assert.equal(jobs[0].status, 'complete');
  assert.ok(!JSON.stringify(jobs).includes(password));
});

test('background jobs reject conflicting actions and expose redacted failures', async t => {
  let finish;
  const blocked = new Promise(resolve => { finish = resolve; });
  const { request, ui } = await fixture(t, { manager: {
    deploy: async (values, { onEvent }) => { onEvent({ message: 'Waiting' }); await blocked; throw new Error(`Failed using ${values.adminPassword}`); },
  } });
  try {
    assert.equal((await request('/api/deploy', { answers })).status, 202);
    assert.equal((await request('/api/clusters/demo/actions', { action: 'stop' })).status, 409);
  } finally { finish(); }
  await ui.settled();
  const jobs = await (await request('/api/jobs')).json();
  assert.equal(jobs[0].status, 'failed');
  assert.ok(!JSON.stringify(jobs).includes(answers.adminPassword));
  assert.equal((await request('/api/clusters/demo/actions', { action: 'resume' })).status, 202);
});

test('local and Docker storage choices reach the manager without unused credentials', async t => {
  const { request, ui, calls } = await fixture(t, { environment: { OBJY_S3_ACCESS_KEY: 'environment-access', OBJY_S3_SECRET_KEY: 'environment-secret' } });
  for (const target of ['docker', 'node-process']) {
    assert.equal((await request('/api/deploy', { answers: { ...answers, target, storage: 'auto', accessKey: 'unused-access', secretKey: 'unused-secret' } })).status, 202);
    await ui.settled();
    const automatic = calls.at(-1)[1];
    assert.equal(automatic.storage, target === 'docker' ? 'docker-minio' : 'local-s3');
    assert.equal(automatic.accessKey, undefined); assert.equal(automatic.secretKey, undefined);
    assert.equal((await request('/api/deploy', { answers: { ...answers, target, storage: 'external-s3' } })).status, 400);
    const existing = { ...answers, target, storage: 'external-s3', s3Endpoint: 'https://s3.example.com', s3Bucket: 'existing', accessKey: 'test-access', secretKey: 'test-secret' };
    assert.equal((await request('/api/deploy', { answers: existing })).status, 202);
    await ui.settled();
    assert.equal(calls.at(-1)[1].storage, 'external-s3'); assert.equal(calls.at(-1)[1].s3Bucket, 'existing');
    assert.equal(calls.at(-1)[1].secretKey, 'test-secret');
  }
});

test('invalid wizard submissions cannot start an operation; lifecycle actions use the manager', async t => {
  const { request, calls, ui } = await fixture(t);
  for (const body of [{}, { answers: { ...answers, name: '../escape' } }, { answers: { ...answers, adminPassword: 'short' } }, { answers: { ...answers, preset: 'custom', shards: 32, replicas: 3 } }]) {
    assert.equal((await request('/api/deploy', body)).status, 400);
  }
  assert.equal((await request('/api/clusters/demo/actions', { action: 'destroy' })).status, 400);
  assert.equal(calls.length, 0);
  for (const action of ['start', 'stop', 'restart', 'resume']) {
    assert.equal((await request('/api/clusters/demo/actions', { action })).status, 202);
    await ui.settled();
  }
  assert.deepEqual(calls, [['start', 'demo'], ['stop', 'demo'], ['restart', 'demo'], ['resume', 'demo']]);
});

test('UI command accepts its own flags and rejects a deployment name', () => {
  const { command, options } = parseCommand(['ui', '--port', '7341', '--no-open']);
  assert.equal(command, 'ui'); assert.equal(options.port, '7341'); assert.equal(options['no-open'], true);
  assert.throws(() => parseCommand(['ui', 'demo']), /does not take/);
  assert.throws(() => parseCommand(['ui', '--yes']), /not valid/);
});

test('UI deletion binds confirmation to the current identity and rename updates job history', async t => {
  const { request, ui, calls } = await fixture(t);
  const preview = await (await request('/api/clusters/demo/deletion')).json();
  for (const body of [{ action: 'delete' }, { action: 'delete', id: 'odb-ffffffffffff', confirmation: 'demo' }, { action: 'delete', id: preview.id, confirmation: 'wrong' }]) {
    assert.equal((await request('/api/clusters/demo/actions', body)).status, 400);
  }
  assert.ok(!calls.some(call => call[0] === 'delete'));
  assert.equal((await request('/api/clusters/demo/actions', { action: 'delete', id: preview.id, confirmation: 'demo' })).status, 202);
  await ui.settled();
  assert.deepEqual(calls.at(-1), ['delete', preview.id, 'demo']);
  assert.equal((await (await request('/api/jobs')).json())[0].resultState, 'deleted');
  assert.equal((await request('/api/clusters/demo/rename', { newName: 'renamed', id: preview.id })).status, 200);
  assert.deepEqual(calls.at(-1), ['rename', 'demo', 'renamed', preview.id]);
  assert.equal((await (await request('/api/jobs')).json())[0].name, 'renamed');
});

test('UI delete rejects unsupported targets, shared storage and concurrent renames', async t => {
  let finish;
  const blocked = new Promise(resolve => { finish = resolve; });
  const { request, ui, calls } = await fixture(t, { manager: {
    deletionInfo: async name => {
      if (name === 'cloud') throw new Error('Deletion is currently available only for Local and Docker deployments');
      return { id: 'odb-0123456789ab', name, blockedBy: ['dependent'] };
    }, deploy: async () => { await blocked; },
  } });
  assert.equal((await request('/api/clusters/cloud/deletion')).status, 400);
  assert.equal((await request('/api/clusters/cloud/actions', { action: 'delete', id: 'odb-0123456789ab', confirmation: 'cloud' })).status, 400);
  assert.equal((await request('/api/clusters/demo/actions', { action: 'delete', id: 'odb-0123456789ab', confirmation: 'demo' })).status, 409);
  try {
    await request('/api/deploy', { answers });
    assert.equal((await request('/api/clusters/demo/rename', { newName: 'renamed' })).status, 409);
  } finally { finish(); await ui.settled(); }
  assert.ok(!calls.some(call => ['delete','rename'].includes(call[0])));
});
