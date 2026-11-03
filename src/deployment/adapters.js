import { dirname, join, resolve } from 'node:path';
import { access, readFile } from 'node:fs/promises';
import { lookup as lookupAddress } from 'node:dns/promises';
import { isIP } from 'node:net';
import { sampleManifest, normalizeManifest } from '../core/manifest.js';
import { createDeploymentPlan } from '../core/planner.js';
import { installationPaths } from '../core/installation-state.js';
import { assignAvailableLocalPorts, reservedLocalPorts } from '../core/ports.js';
import { renderDeployment } from '../core/render.js';
import { runProcess } from '../core/process.js';
import { createDockerDriver } from '../drivers/docker/index.js';
import { createNodeProcessDriver } from '../drivers/node-process/index.js';
import { createVmDriver } from '../drivers/vm/index.js';
import { createSshTransport } from '../drivers/vm/ssh-transport.js';
import { createSystemdNodeRuntime } from '../drivers/systemd-node-runtime.js';
import { runtimeEnvironmentFile } from '../drivers/runtime-environment.js';
import { createDefaultStorageDrivers, createDesiredPlan } from '../storage/index.js';
import { createTerraformProvisioner } from './terraform.js';
import { healthReady } from './health.js';
import { isLocalIdentity } from '../core/public-access.js';
import { readJson, writeJson, writePrivateFile } from './files.js';

export function secretEnvironment(secrets) {
  const env = {
    OBJYDB_ADMIN_PASSWORD: secrets.adminPassword,
    OBJYDB_JWT_SECRET: secrets.jwtSecret,
    OBJYDB_CLUSTER_SECRET: secrets.clusterSecret,
    OBJYDB_S3_ACCESS_KEY: secrets.accessKey,
    OBJYDB_S3_SECRET_KEY: secrets.secretKey,
  };
  for (const [key, value] of Object.entries(secrets)) {
    const match = key.match(/^vm(\d+)(Password|Passphrase)$/);
    if (match) env[`OBJYDB_VM_${match[1]}_${match[2].toUpperCase()}`] = value;
  }
  return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined));
}

export function createAdapters({ environment = process.env, run = runProcess, transport = createSshTransport(), fetchImpl = fetch, lookup = lookupAddress, resolveRelease = () => { throw new Error('No server release selected'); }, terraform = createTerraformProvisioner({ environment, run, fetchImpl }) } = {}) {
  const storageDrivers = createDefaultStorageDrivers();
  const drivers = { docker: createDockerDriver({ run }), 'node-process': createNodeProcessDriver({ run }), vm: createVmDriver({ run, transport }) };
  return {
    async open({ record, directory, secrets }) {
      const paths = installationPaths(join(directory, 'runtime'));
      const plan = await readJson(paths.plan);
      let driver = drivers[record.settings.target];
      if (record.settings.target === 'hetzner') {
        const infrastructure = await readJson(join(directory, 'infrastructure.json'));
        driver = cloudDriver(infrastructure, plan.target.hetzner.sourceDirectory);
      }
      if (!driver) throw new Error('Unknown deployment target');
      const env = { ...environment, ...secretEnvironment(secrets) };
      return { plan, paths, driver, environment: env, observe: () => observe(plan, paths, driver, env) };
    },
    async prepare(context) {
      const { record, directory, secrets, emit } = context;
      const paths = installationPaths(join(directory, 'runtime'));
      const env = { ...environment, ...secretEnvironment(secrets) };
      let plan = await readJson(paths.plan, null);
      let driver = drivers[record.settings.target];
      const target = record.settings.target;
      const sourceDirectory = await resolveRelease(record, emit);
      if (record.settings.target === 'hetzner') {
        emit('Checking cloud setup prerequisites');
        await run('tar', ['--version']);
        await terraform.check?.({ sourceRequired: false });
        const infrastructure = await terraform.create(context);
        if (record.settings.protocol === 'https' && infrastructure.inventory.https_mode !== 'load-balancer') throw new Error('This saved installation uses node-based TLS. Create a new installation to use load-balancer TLS; existing infrastructure has been left untouched.');
        if (record.settings.domain) {
          record.dns = { domain: record.settings.domain, address: infrastructure.inventory.public_ip };
          emit(`Point the DNS A record for ${record.dns.domain} to ${record.dns.address}, and remove any AAAA record for this name. HTTPS will become ready after DNS updates.`);
        }
        driver = cloudDriver(infrastructure, sourceDirectory);
      }
      if (!driver) throw new Error('Unknown installation destination');
      if (!plan) {
        const manifest = sampleManifest();
        manifest.installation.version = record.release.version;
        manifest.metadata.name = record.id;
        manifest.installation.topology = { shards: record.capacity.shards, replicas: record.capacity.replicas };
        manifest.installation.runtime.heapMb = record.capacity.heapMb;
        manifest.database.memoryGuard.limitMb = record.capacity.heapMb;
        manifest.installation.public.protocol = record.settings.protocol;
        manifest.installation.public.bindAddress = ['node-process', 'docker'].includes(record.settings.target) ? '127.0.0.1' : '0.0.0.0';
        manifest.target = { driver: record.settings.target };
        const storage = storageDrivers[record.settings.storage];
        const storageSettings = record.settings.storage === 'external-s3'
          ? { endpoint: record.settings.s3Endpoint, region: record.settings.s3Region, bucket: record.settings.s3Bucket, forcePathStyle: true }
          : record.settings.storage === 'hetzner-object-storage' ? { location: record.settings.region } : {};
        storage.applySetup(manifest, storageSettings);
        if (record.settings.target === 'vm') {
          const hosts = await Promise.all(Array.from({ length: record.capacity.nodes }, async (_, i) => {
            const v = record.settings, key = `vm${i}`;
            const ssh = { user: v[`${key}User`], port: v[`${key}Port`] };
            if (v[`${key}Auth`] === 'key') {
              ssh.identityFile = join(directory, 'ssh', `${key}-key`);
              try { await access(ssh.identityFile); }
              catch (error) {
                if (error.code !== 'ENOENT') throw error;
                await writePrivateFile(ssh.identityFile, await readFile(expandHome(v[`${key}Key`], environment)));
              }
              if (secrets[`${key}Passphrase`]) ssh.passphrase = { fromEnvironment: `OBJYDB_VM_${i}_PASSPHRASE` };
            } else if (v[`${key}Auth`] === 'password') ssh.password = { fromEnvironment: `OBJYDB_VM_${i}_PASSWORD` };
            return { host: v[`${key}Host`], ssh };
          }));
          if (new Set(hosts.map(h => `${h.host}:${h.ssh.port}`)).size !== hosts.length) throw new Error('Choose a different VM for each node');
          driver.applySetup(manifest, { hosts, sourceDirectory });
          manifest.target.vm.sourceDirectory = sourceDirectory;
        } else if (record.settings.target === 'hetzner') {
          manifest.installation.artifact = 'terraform-ssh';
          manifest.target.hetzner = { sourceDirectory };
        } else if (record.settings.target === 'node-process') {
          manifest.installation.artifact = 'local-node';
          manifest.target.nodeProcess = { directory: sourceDirectory, entrypoint: 'src/index.js' };
          manifest.database.persistence.localWal.dir = join(directory, 'wal');
        } else {
          driver.applySetup(manifest);
          manifest.installation.artifact = `objy-server:${record.release.sha256.slice(0, 20)}`;
        }
        await driver.check?.(manifest, { environment: env });
        const reserved = ['docker', 'node-process'].includes(target) ? await reservedLocalPorts(dirname(directory), run, { requireDocker: target === 'docker' }) : [];
        await assignAvailableLocalPorts(manifest, { targetDriver: driver, storageDriver: storage, reservedPorts: reserved });
        const normalized = normalizeManifest(manifest);
        plan = createDesiredPlan(normalized, { targetDrivers: { [driver.id]: driver }, storageDrivers });
        plan.configPath = paths.databaseConfig;
        if (record.settings.target === 'node-process') plan.database.persistence.localWal.dir = join(directory, 'wal');
        await driver.validatePlan?.(plan);
        await driver.preflight?.(plan, { environment: env, progress: emit });
        await storage.preflight?.(plan, { environment: env });
        await writeJson(join(directory, 'manifest.json'), normalized);
        await renderDeployment(plan, {
          outputDirectory: paths.root, force: true,
          targetFiles: await driver.renderFiles?.(plan) || [],
          databaseConfig: driver.databaseConfig?.(plan) || plan.database,
        });
      }
      return {
        plan, paths, driver, storage: storageDrivers[plan.storage.driver], environment: env,
        async start() {
          if (record.settings.target === 'docker') {
            emit('Building the local database image');
            const dockerfile = join(paths.root, 'Dockerfile');
            await writePrivateFile(dockerfile, `FROM node:${record.release.nodeMajor}-bookworm-slim\nWORKDIR /app\nCOPY package*.json ./\nRUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund\nCOPY --chown=node:node . .\nRUN mkdir -p /var/lib/objydb/wal && chown -R node:node /var/lib/objydb /app\nUSER node\nCMD ["node", "src/index.js"]\n`);
            await run('docker', ['build', '-f', dockerfile, '-t', plan.image, sourceDirectory]);
          }
          if (record.settings.target === 'node-process') {
            const existing = await driver.status(paths);
            if (existing.some(n => n.state === 'running') && existing.some(n => n.state !== 'running')) await driver.stop(paths);
          }
          await driver.up(paths, { environment: env, progress: emit });
        },
        observe: () => observe(plan, paths, driver, env),
      };
    },
    async inspect({ record, directory, secrets }) {
      const paths = installationPaths(join(directory, 'runtime'));
      const plan = await readJson(paths.plan, null);
      if (!plan) return null;
      let driver = drivers[record.settings.target];
      if (record.settings.target === 'hetzner') {
        const infrastructure = await readJson(join(directory, 'infrastructure.json'), null);
        if (!infrastructure) return null;
        driver = cloudDriver(infrastructure, plan.target.hetzner.sourceDirectory);
      }
      return observe(plan, paths, driver, { ...environment, ...secretEnvironment(secrets) });
    },
  };

  function cloudDriver(infrastructure, sourceDirectory) {
    const { inventory, identityFile } = infrastructure;
    const connection = node => ({ host: node.machine.host, port: 22, username: 'root', identityFile });
    const remote = (_plan, node, command, options = {}) => transport.run(connection(node), command, options);
    const runtime = createSystemdNodeRuntime({
      run, remote,
      upload: (_plan, node, source, destination) => transport.upload(connection(node), source, destination),
      follow: (_plan, node, command) => transport.follow(connection(node), command),
      settings: () => ({ sourceDirectory, entrypoint: 'src/index.js', serviceUser: 'objydb', remoteDirectory: '/opt/objydb', walDirectory: '/var/lib/objydb/wal' }),
      environmentFile: runtimeEnvironmentFile, maxParallel: 4, manageHttps: false,
    });
    return {
      id: 'hetzner',
      plan(manifest, options) {
        const plan = createDeploymentPlan(manifest, { ...options, materializeNode(logical) {
          const node = inventory.nodes[`s${Number(logical.shard.slice(6)) + 1}-r${logical.replica + 1}`];
          if (!node) throw new Error('The cloud inventory does not match the requested topology');
          return { ...logical, port: 8080, machine: { host: node.host }, peerUrl: `http://${node.peer_host}:8080`,
            publicUrl: inventory.endpoint };
        } });
        plan.endpoint = inventory.endpoint;
        return plan;
      },
      validatePlan: plan => runtime.validate(plan),
      async preflight(plan, { progress }) {
        progress('Waiting for machines to finish their initial setup');
        await each(plan.nodes, async node => {
          const deadline = Date.now() + 600000;
          let lastError;
          while (Date.now() < deadline) {
            try {
              await remote(plan, node, 'timeout 600 cloud-init status --wait >/dev/null && command -v node >/dev/null && mountpoint -q /var/lib/objydb/wal');
              return;
            } catch (error) { lastError = error; await new Promise(r => setTimeout(r, 3000)); }
          }
          throw new Error(`Machine setup did not finish for ${node.id}: ${lastError?.message}`);
        });
      },
      up: (paths, { environment, progress }) => runtime.deploy(paths, environment, progress),
      start: (paths, { environment }) => runtime.action(paths, 'start', environment),
      stop: (paths, { environment }) => runtime.action(paths, 'stop', environment),
      readLogs: (paths, options) => runtime.readLogs(paths, options),
      logs: (paths, options) => runtime.followLogs(paths, options),
      status: (paths, { environment }) => runtime.status(paths, environment),
      async probe(plan, node) {
        const result = await remote(plan, node, 'curl -fsS --max-time 3 http://127.0.0.1:8080/health');
        return JSON.parse(result.stdout).restore?.status === 'ready';
      },
    };
  }

  async function observe(plan, paths, driver, env) {
    const runtime = await driver.status(paths, { environment: env });
    const addresses = new Map();
    async function nodeAddress(node, state) {
      let host, port;
      if (driver.id === 'docker') {
        host = state?.address;
        port = node.internalPort;
      } else {
        const peer = new URL(node.peerUrl);
        host = node.machine?.host || peer.hostname;
        port = node.port || peer.port || (peer.protocol === 'https:' ? 443 : 80);
      }
      host = host?.replace(/^\[|\]$/g, '');
      if (!host) return null;
      if (!isIP(host)) {
        if (driver.id === 'docker') return null;
        if (!addresses.has(host)) addresses.set(host, lookup(host, { all: true }).catch(() => []));
        const resolved = await addresses.get(host);
        host = (resolved.find(entry => entry.family === 4) || resolved[0])?.address;
      }
      if (!isIP(host || '')) return null;
      return port ? `${isIP(host) === 6 ? `[${host}]` : host}:${port}` : host;
    }
    const nodes = await each(plan.nodes, async node => {
      const state = runtime.find(n => n.nodeId === node.id);
      let ready = false;
      try {
        if (driver.probe) ready = await driver.probe(plan, node);
        else {
          const url = driver.nodePublicUrl?.(plan, node) || node.publicUrl;
          ready = await healthReady(url, fetchImpl);
        }
      } catch { /* An unreachable node is an observation, not a setup command. */ }
      return { id: node.id, shard: node.shard, replica: node.replica + 1, address: await nodeAddress(node, state),
        url: node.publicUrl, heapMb: plan.runtime.heapMb,
        status: ready && state?.state === 'running' ? 'ready' : state?.state === 'running' ? 'starting' : 'unavailable' };
    });
    const endpoint = plan.endpoint || plan.nodes[0]?.publicUrl;
    const endpointReady = endpoint ? await healthReady(endpoint, fetchImpl) : false;
    const localCertificate = endpoint?.startsWith('https:') && isLocalIdentity(new URL(endpoint).hostname.replace(/^\[|\]$/g, ''));
    return { nodes, endpoint, endpointReady, localCertificate: Boolean(localCertificate), storage: { label: plan.storage.driver, bucket: plan.persistence.bucket }, checkedAt: new Date().toISOString() };
  }
}

async function each(values, operation) {
  const results = new Array(values.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, values.length) }, async () => {
    while (next < values.length) { const i = next++; results[i] = await operation(values[i]); }
  }));
  return results;
}
function expandHome(path, environment) {
  return path.startsWith('~/') ? resolve(environment.HOME, path.slice(2)) : resolve(path);
}
