import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, open, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertPortAvailable } from '../core/ports.js';
import { installationDataPrefix } from '../core/installation-identity.js';
import { ownsProcess, processIdentity, terminate } from '../drivers/node-process/index.js';
import { readJson, writeJson, writePrivateFile } from '../deployment/files.js';
import { S3_ACCESS_KEY_ENV, S3_SECRET_KEY_ENV, s3StoragePlan, port } from './common.js';
import { createStorageRuntimeStore, seaweedRelease } from './native-runtime.js';
import { waitForS3Bucket } from './s3-access.js';

const portFlags = ['s3.port', 's3.port.grpc', 'master.port', 'master.port.grpc', 'volume.port', 'volume.port.grpc', 'filer.port', 'filer.port.grpc', 'admin.port', 'admin.port.grpc'];
export const localStoragePortCount = portFlags.length;

export function localStorageArgs(directory, settings) {
  return ['mini', `-dir=${join(directory, 'data')}`, '-ip=127.0.0.1', '-ip.bind=127.0.0.1',
    `-s3.config=${join(directory, 'credentials.json')}`, '-master.telemetry=false', '-webdav=false', '-admin.ui=false', '-admin.port.legacy=0',
    '-s3.port.iceberg=0', '-s3.port.lance=0', '-s3.iam=false',
    ...portFlags.map((flag, i) => `-${flag}=${settings.basePort + i}`)];
}

export function createLocalS3Driver({ spawnProcess = spawn,
  ensureRuntime = (release, paths, emit) => createStorageRuntimeStore({ root: resolve(paths.root, '../..') }).ensure(release, { emit }),
  ensureBucket = (plan, environment) => waitForS3Bucket(plan, environment, { create: true, probeWrite: true }),
} = {}) {
  return {
    id: 'local-s3', label: 'Automatic local S3', managed: true, compatibleTargets: ['node-process'], settingsKey: 'localS3',
    applySetup(manifest) {
      manifest.storage = { driver: 'local-s3', localS3: {
        bucket: 'objydb', prefix: installationDataPrefix(manifest.metadata.name), basePort: 8333, release: seaweedRelease(),
        accessKeyId: { fromEnvironment: S3_ACCESS_KEY_ENV }, secretAccessKey: { fromEnvironment: S3_SECRET_KEY_ENV },
      } };
    },
    localPorts(manifest) {
      return { count: localStoragePortCount, host: '127.0.0.1', current: manifest.storage.localS3.basePort,
        assign(first) { manifest.storage.localS3.basePort = first; } };
    },
    plan(manifest, targetPlan) {
      if (targetPlan.driver !== 'node-process') throw new Error('Automatic local S3 requires a local Node.js deployment');
      const settings = manifest.storage.localS3;
      const basePort = port(settings.basePort, 'Local storage port', 8333);
      if (basePort + localStoragePortCount - 1 > 65535) throw new Error('Local storage port range exceeds 65535');
      return { ...s3StoragePlan('local-s3', { ...settings, endpoint: `http://127.0.0.1:${basePort}`, region: 'us-east-1', forcePathStyle: true }, { managed: true }),
        local: { basePort, portCount: localStoragePortCount, release: structuredClone(settings.release) } };
    },
    async ensureSecrets(_plan, { environment }) {
      const generated = {};
      if (!environment[S3_ACCESS_KEY_ENV]) generated[S3_ACCESS_KEY_ENV] = `objy-${randomBytes(12).toString('hex')}`;
      if (!environment[S3_SECRET_KEY_ENV]) generated[S3_SECRET_KEY_ENV] = randomBytes(32).toString('base64url');
      return generated;
    },
    preflight: checkPorts,
    provision: start,
    start,
    async stop(_plan, paths) {
      const path = join(paths.root, 'storage', 'process.json'), record = await readJson(path, null);
      if (record) await terminate([record]);
      await rm(path, { force: true });
    },
    async status(_plan, paths) {
      const record = await readJson(join(paths.root, 'storage', 'process.json'), null);
      return { driver: 'local-s3', managed: true, state: record && await ownsProcess(record) ? 'running' : 'stopped' };
    },
  };

  async function start(plan, paths, { environment, progress = () => {} }) {
    const directory = join(paths.root, 'storage'), processFile = join(directory, 'process.json');
    await mkdir(join(directory, 'data'), { recursive: true, mode: 0o700 });
    const record = await readJson(processFile, null);
    if (record && await ownsProcess(record)) { await ensureBucket(plan, environment); return; }
    const accessKey = environment[S3_ACCESS_KEY_ENV], secretKey = environment[S3_SECRET_KEY_ENV];
    if (!accessKey || !secretKey) throw new Error('Saved local storage credentials are missing');
    const binary = await ensureRuntime(plan.storage.local.release, paths, progress);
    await checkPorts(plan);
    await writeJson(join(directory, 'credentials.json'), { identities: [{ name: 'objy', credentials: [{ accessKey, secretKey }], actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'] }] });
    // Explicit local configuration takes precedence over any user-wide SeaweedFS settings.
    await writePrivateFile(join(directory, 'filer.toml'), `[leveldb2]\nenabled = true\ndir = ${JSON.stringify(join(directory, 'data', 'metadata'))}\n`);
    await writePrivateFile(join(directory, 'security.toml'), '');
    const log = join(directory, 'storage.log'), output = await open(log, 'a', 0o600);
    let child;
    try {
      const env = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
      child = spawnProcess(binary, localStorageArgs(directory, plan.storage.local), { cwd: directory, env, detached: true, stdio: ['ignore', output.fd, output.fd] });
      await new Promise((resolveStarted, reject) => { child.once('spawn', resolveStarted); child.once('error', reject); });
      child.unref();
      const identity = await processIdentity(child.pid);
      if (!identity) throw new Error('Local storage exited during startup; inspect storage.log');
      await writeJson(processFile, { pid: child.pid, identity, log, startedAt: new Date().toISOString() });
    } catch (error) {
      // This handle is the child just spawned, not a PID recovered from state.
      if (child?.pid) child.kill('SIGTERM');
      throw error;
    } finally { await output.close(); }
    try { await ensureBucket(plan, environment); }
    catch (error) { throw new Error(`Local storage is not ready: ${error.message}. Inspect ${log}, then use objy resume.`); }
  }
}

async function checkPorts(plan) {
  for (let i = 0; i < localStoragePortCount; i++) await assertPortAvailable('127.0.0.1', plan.storage.local.basePort + i);
}
