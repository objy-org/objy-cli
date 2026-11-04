import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { normalizeAnswers, wizardFields, splitAnswers } from '../src/deployment/catalog.js';
import { runWizard } from '../src/deployment/wizard.js';
import { createStorageRuntimeStore, extractStorageBinary, seaweedRelease } from '../src/storage/native-runtime.js';
import { createLocalS3Driver, localStorageArgs } from '../src/storage/local-s3.js';
import { findAvailablePortRange, reservedLocalPorts } from '../src/core/ports.js';
import { writeJson } from '../src/deployment/files.js';
import { sampleManifest } from '../src/core/manifest.js';
import { createAdapters } from '../src/deployment/adapters.js';

async function temporary(t) { const root = await mkdtemp(join(tmpdir(), 'objy-storage-test-')); t.after(() => rm(root, { recursive: true, force: true })); return root; }
function tar(entries) {
  return gzipSync(Buffer.concat([...entries.flatMap(([name, source, type = '0']) => {
    const body = Buffer.from(source), header = Buffer.alloc(512);
    header.write(name); header.write(body.length.toString(8).padStart(11, '0') + '\0', 124); header.fill(32, 148, 156); header.write(type, 156);
    header.write(header.reduce((sum, n) => sum + n, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    return [header, body, Buffer.alloc((512 - body.length % 512) % 512)];
  }), Buffer.alloc(1024)]));
}
function zip(name, source) {
  const body = Buffer.from(source), filename = Buffer.from(name), local = Buffer.alloc(30), central = Buffer.alloc(46), end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50); local.writeUInt32LE(body.length, 18); local.writeUInt32LE(body.length, 22); local.writeUInt16LE(filename.length, 26);
  central.writeUInt32LE(0x02014b50); central.writeUInt32LE(body.length, 20); central.writeUInt32LE(body.length, 24); central.writeUInt16LE(filename.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10); end.writeUInt32LE(46 + filename.length, 12); end.writeUInt32LE(30 + filename.length + body.length, 16);
  return Buffer.concat([local, filename, body, central, filename, end]);
}

test('both local wizards offer automatic storage and require credentials only for existing S3', async () => {
  for (const target of ['docker', 'node-process']) {
    const automatic = normalizeAnswers({ name: 'demo', target, preset: 'tiny', storage: 'auto', adminPassword: 'test-password', accessKey: 'unused', secretKey: 'unused', s3Endpoint: 'https://unused.example' });
    assert.equal(automatic.storage, target === 'docker' ? 'docker-minio' : 'local-s3');
    assert.ok(!wizardFields(automatic, 2).some(field => ['accessKey', 'secretKey', 's3Endpoint'].includes(field.id)));
    assert.equal(splitAnswers(automatic).secrets.accessKey, undefined);
    assert.equal(automatic.s3Endpoint, undefined);
    assert.throws(() => normalizeAnswers({ ...automatic, storage: 'external-s3' }), /Storage endpoint/);
    const existing = normalizeAnswers({ ...automatic, storage: 'external-s3', s3Endpoint: 'https://s3.example.com', s3Bucket: 'existing', s3Region: 'test', accessKey: 'access', secretKey: 'secret' });
    assert.equal(existing.storage, 'external-s3'); assert.equal(existing.accessKey, 'access');
    const asked = [];
    const result = await runWizard({ initial: { name: 'demo', target, preset: 'tiny', storage: 'auto', adminPassword: 'test-password' },
      output: { write() {} }, ask: async field => { asked.push(field.id); return field.id === 'confirm' ? 'y' : ''; } });
    assert.equal(result.storage, automatic.storage); assert.ok(!asked.includes('accessKey') && !asked.includes('s3Endpoint'));
  }
  assert.throws(() => normalizeAnswers({ target: 'vm', storage: 'auto' }), /local and Docker/);
});

test('native storage download is pinned, cached and checked before use', async t => {
  const root = await temporary(t), filename = process.platform === 'win32' ? 'weed.exe' : 'weed';
  const bytes = filename === 'weed' ? tar([['weed', 'binary-fixture']]) : zip('weed.exe', 'binary-fixture');
  const release = { ...seaweedRelease(), sha256: createHash('sha256').update(bytes).digest('hex') };
  let downloads = 0;
  const store = createStorageRuntimeStore({ root, fetchImpl: async url => { downloads++; assert.ok(url.startsWith('https://github.com/seaweedfs/seaweedfs/releases/download/4.52/')); return new Response(bytes); } });
  const path = await store.ensure(release);
  assert.equal(await readFile(path, 'utf8'), 'binary-fixture');
  assert.equal(await store.ensure(release), path); assert.equal(downloads, 1);
  await writeFile(path, 'changed'); await assert.rejects(store.ensure(release), /integrity/);
  await assert.rejects(store.ensure({ ...release, sha256: 'a'.repeat(64) }), /checksum mismatch/);
  assert.deepEqual((await readdir(join(root, 'storage-runtimes'))).filter(name => name === 'a'.repeat(64)), []);
  assert.throws(() => seaweedRelease('win32', 'arm64'), /existing S3/);
});

test('native executable extraction handles TAR and ZIP without extracting arbitrary paths', () => {
  assert.equal(extractStorageBinary(tar([['../outside', 'ignore'], ['weed', 'native']]), 'weed').toString(), 'native');
  assert.equal(extractStorageBinary(zip('weed.exe', 'windows-native'), 'weed.exe').toString(), 'windows-native');
  assert.throws(() => extractStorageBinary(tar([['weed', '', '2']]), 'weed'), /regular file/);
  assert.throws(() => extractStorageBinary(tar([['weed', 'a'], ['weed', 'b']]), 'weed'), /Invalid storage executable/);
  assert.throws(() => extractStorageBinary(zip('../weed.exe', 'bad'), 'weed.exe'), /missing/);
  assert.throws(() => extractStorageBinary(Buffer.alloc(10), 'weed.exe'), /Invalid/);
});

test('local storage is a separate managed process with private credentials and persistent data', async t => {
  const root = await temporary(t), paths = { root }, basePort = await findAvailablePortRange(10, { start: 19000 });
  const fixture = join(root, 'fixture.cjs');
  await writeFile(fixture, "const timer=setInterval(()=>{},1000);process.on('SIGTERM',()=>clearInterval(timer));");
  const spawns = [];
  const driver = createLocalS3Driver({ ensureRuntime: async () => process.execPath, ensureBucket: async () => {},
    spawnProcess: (binary, args, options) => { spawns.push({ binary, args, options }); return spawn(binary, [fixture], options); } });
  const manifest = sampleManifest(); driver.applySetup(manifest); driver.localPorts(manifest).assign(basePort);
  const storage = driver.plan(manifest, { driver: 'node-process' }), plan = { storage, persistence: storage };
  const environment = await driver.ensureSecrets(plan, { environment: {} });
  assert.deepEqual(await driver.ensureSecrets(plan, { environment }), {});
  try {
    await driver.provision(plan, paths, { environment });
    await writeFile(join(root, 'storage/data/retain'), 'persistent');
    await driver.start(plan, paths, { environment });
    assert.equal(spawns.length, 1); assert.equal((await driver.status(plan, paths)).state, 'running');
    const credentials = await readFile(join(root, 'storage/credentials.json'), 'utf8');
    assert.equal(JSON.parse(credentials).identities[0].credentials[0].secretKey, environment.OBJYDB_S3_SECRET_KEY);
    assert.equal((await stat(join(root, 'storage/credentials.json'))).mode & 0o777, 0o600);
    assert.ok(spawns[0].args.includes('-ip.bind=127.0.0.1')); assert.ok(spawns[0].args.includes('-master.telemetry=false'));
    assert.ok(!JSON.stringify(spawns[0].args).includes(environment.OBJYDB_S3_SECRET_KEY));
    await driver.stop(plan, paths); assert.equal((await driver.status(plan, paths)).state, 'stopped');
    await driver.start(plan, paths, { environment }); assert.equal(spawns.length, 2);
    assert.equal(await readFile(join(root, 'storage/credentials.json'), 'utf8'), credentials);
    assert.equal(await readFile(join(root, 'storage/data/retain'), 'utf8'), 'persistent');
  } finally { await driver.stop(plan, paths); }
  await writeJson(join(root, 'storage/process.json'), { pid: process.pid, identity: 'unrelated process' });
  await driver.stop(plan, paths); assert.doesNotThrow(() => process.kill(process.pid, 0));
});

test('all local storage ports stay reserved while the deployment is stopped', async t => {
  const root = await temporary(t);
  await writeJson(join(root, 'odb-0123456789ab/runtime/plan.json'), { driver: 'node-process', nodes: [{ port: 21000 }], storage: { local: { basePort: 21001, portCount: 10 } } });
  const ports = await reservedLocalPorts(root, async () => ({ stdout: '' }));
  assert.deepEqual(ports, Array.from({ length: 11 }, (_, i) => 21000 + i));
  const args = localStorageArgs('/private/storage', { basePort: 21001 });
  assert.equal(args.filter(arg => /\.(?:port|port.grpc)=/.test(arg)).length, 10);
  assert.ok(args.includes('-admin.port.legacy=0'));
});

test('automatic storage ignores ambient server credentials and restores saved credentials', async t => {
  const directory = await temporary(t);
  await writeJson(join(directory, 'runtime/plan.json'), { storage: { driver: 'local-s3' } });
  const adapters = createAdapters({ environment: { OBJYDB_S3_ACCESS_KEY: 'unrelated-access', OBJYDB_S3_SECRET_KEY: 'unrelated-secret' }, resolveRelease: async () => '/unused' });
  const record = { settings: { target: 'node-process' } };
  const first = await adapters.prepare({ record, directory, secrets: {}, emit() {} });
  assert.equal(first.environment.OBJYDB_S3_ACCESS_KEY, undefined);
  const generated = await first.storage.ensureSecrets(first.plan, { environment: first.environment });
  assert.ok(generated.OBJYDB_S3_ACCESS_KEY && generated.OBJYDB_S3_SECRET_KEY !== 'unrelated-secret');
  const restored = await adapters.open({ record, directory, secrets: { accessKey: generated.OBJYDB_S3_ACCESS_KEY, secretKey: generated.OBJYDB_S3_SECRET_KEY } });
  assert.equal(restored.environment.OBJYDB_S3_ACCESS_KEY, generated.OBJYDB_S3_ACCESS_KEY);
  assert.equal(restored.environment.OBJYDB_S3_SECRET_KEY, generated.OBJYDB_S3_SECRET_KEY);
});
