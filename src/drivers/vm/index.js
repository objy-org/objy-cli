import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createConnection } from "node:net";
import { createDeploymentPlan } from "../../core/planner.js";
import { caddySystemdSetupCommand, publicUrl, usesHttps } from "../../core/public-access.js";
import { runProcess } from "../../core/process.js";
import { findServerDirectory } from "../../core/runtime-source.js";
import { installationPresets } from "../../core/setup.js";
import { runtimeEnvironmentFile } from "../runtime-environment.js";
import { createSystemdNodeRuntime } from "../systemd-node-runtime.js";
import { createSshTransport } from "./ssh-transport.js";

const DEFAULT_REMOTE_DIRECTORY = "/opt/objydb";
const MAX_PARALLEL_HOSTS = 4;
const VM_FIELDS = [
  {
    id: "hosts", label: "VM connections", type: "ssh-connections", required: true,
    description: "Configure one SSH connection for every database node.",
  },
];

export function createVmDriver({ run = runProcess, transport = createSshTransport(), probe = probeTcpPort } = {}) {
  const runtime = createSystemdNodeRuntime({
    run,
    remote,
    upload: (_plan, node, source, destination, { environment } = {}) => transport.upload(
      connectionFor(node, environment), source, destination,
    ),
    follow: (_plan, node, command, { environment } = {}) => transport.follow(connectionFor(node, environment), command),
    settings: (plan) => {
      const value = planSettings(plan);
      return {
        ...value,
        serviceUser: (node) => node.machine.ssh.user,
        walDirectory: "/var/lib/objydb/wal",
      };
    },
    environmentFile: runtimeEnvironmentFile,
    nodeLabel: (node) => node.machine.host,
    maxParallel: MAX_PARALLEL_HOSTS,
    archiveName: "vm-release.tgz",
  });

  return {
    id: "vm",
    name: "vm",
    label: "Virtual machines",
    description: "Deploy OBJY DB to pre-existing Linux VMs over SSH.",
    presets: installationPresets(),
    setupFields: VM_FIELDS,
    configurationFields: VM_FIELDS,
    settingsKey: "vm",
    testConnection({ host, port = 22 }) {
      return probe(hostAddress(host), positivePort(port));
    },
    applySetup(manifest, settings) {
      const hosts = hostConfigurations(settings.hosts);
      const expected = manifest.installation.topology.shards * manifest.installation.topology.replicas;
      if (hosts.length !== expected) throw new Error(`targetSettings.hosts must contain exactly ${expected} VM connection(s)`);
      manifest.installation.artifact = "ssh-source";
      manifest.target.vm = {
        hosts,
        sourceDirectory: settings.sourceDirectory || "",
        remoteDirectory: DEFAULT_REMOTE_DIRECTORY,
        entrypoint: "src/index.js",
      };
    },
    nodePublicUrl: (_plan, node) => node.healthUrl || node.publicUrl,
    plan(manifest, options = {}) {
      const settings = vmSettings(manifest.target.vm);
      return createDeploymentPlan(manifest, {
        shardRevision: options.shardRevision,
        materializeNode(node) {
          const machine = settings.hosts[node.index];
          if (!machine) throw new Error(`target.vm.hosts requires one VM per node; missing VM ${node.index + 1}`);
          const port = manifest.installation.public.basePort + node.index;
          const peerHost = urlHost(machine.peerHost || machine.host);
          const publicIdentity = machine.publicHost || machine.host;
          const publicHost = urlHost(publicIdentity);
          const healthUrl = `http://${publicHost}:${port}`;
          return {
            machine,
            port,
            peerUrl: `http://${peerHost}:${port}`,
            healthUrl,
            publicUrl: usesHttps(manifest) ? publicUrl("https", publicIdentity, 443) : healthUrl,
          };
        },
      });
    },
    async configure(manifest, { output, question, text, integer, environmentName }) {
      output.write("\nVirtual machines\n");
      const current = manifest.target.vm || {};
      const expected = manifest.installation.topology.shards * manifest.installation.topology.replicas;
      const hosts = [];
      for (let index = 0; index < expected; index++) {
        const previous = current.hosts?.[index] || {};
        const previousSsh = previous.ssh || {};
        output.write(`\nVM ${index + 1} of ${expected}\n`);
        const host = await text(question, "SSH address", previous.host || `vm-${index + 1}.example.com`);
        const user = await text(question, "SSH user", previousSsh.user || "root");
        const port = await integer(question, "SSH port", previousSsh.port || 22, 1, 65535);
        const method = await authenticationMethod(question, previousSsh);
        const ssh = { user, port };
        if (method === "key") {
          ssh.identityFile = resolve(await text(question, "Private key file", previousSsh.identityFile || join(homedir(), ".ssh", "id_ed25519")));
        } else if (method === "password") {
          ssh.password = {
            fromEnvironment: await environmentName(
              question,
              "Password environment variable",
              previousSsh.password?.fromEnvironment || `OBJYDB_VM_${index + 1}_SSH_PASSWORD`,
            ),
          };
        }
        hosts.push({ host, ssh });
      }
      manifest.target.vm = {
        hosts,
        sourceDirectory: findServerDirectory(),
        remoteDirectory: DEFAULT_REMOTE_DIRECTORY,
        entrypoint: "src/index.js",
      };
      manifest.installation.artifact = "ssh-source";
    },
    async validatePlan(plan) {
      const settings = planSettings(plan);
      if (settings.hosts.length !== plan.nodes.length) {
        throw new Error(`target.vm.hosts must contain exactly ${plan.nodes.length} VM address(es)`);
      }
      if (new Set(settings.hosts.map(({ host }) => host)).size !== settings.hosts.length) {
        throw new Error("target.vm.hosts must contain unique VM addresses");
      }
      await runtime.validate(plan);
      for (const machine of settings.hosts) {
        if (machine.ssh.identityFile) {
          await access(machine.ssh.identityFile).catch(() => { throw new Error(`SSH identity file does not exist: ${machine.ssh.identityFile}`); });
        }
      }
      const storageHost = new URL(plan.persistence.endpoint).hostname;
      if (["localhost", "127.0.0.1", "::1", "[::1]"].includes(storageHost)) {
        throw new Error("VM deployments require an S3 endpoint reachable from the remote machines; localhost is not reachable from a VM");
      }
    },
    check: () => runtime.check(),
    async preflight(plan, { environment = process.env } = {}) {
      await eachNode(plan, async (node) => {
        await remote(plan, node, [
          "set -eu",
          "command -v node >/dev/null",
          "command -v npm >/dev/null",
          "command -v systemctl >/dev/null",
          "command -v tar >/dev/null",
          "node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) >= 22 ? 0 : 1)'",
          "sudo -n true",
          ...(usesHttps(plan) ? [caddySystemdSetupCommand()] : []),
        ].join("; "), { environment });
      });
    },
    up: (paths, { environment } = {}) => runtime.deploy(paths, environment),
    start: (paths, { environment } = {}) => runtime.action(paths, "start", environment),
    stop: (paths, { environment } = {}) => runtime.action(paths, "stop", environment),
    restart: (paths, { environment } = {}) => runtime.action(paths, "restart", environment),
    finalizeMigration: (paths, { environment } = {}) => runtime.deploy(paths, environment),
    remove: (paths, { environment } = {}) => runtime.remove(paths, environment),
    status: (paths, { environment } = {}) => runtime.status(paths, environment),
    readLogs: (paths, options) => runtime.readLogs(paths, options),
    logs: (paths, options) => runtime.followLogs(paths, options),
  };

  function remote(plan, node, command, options = {}) {
    return transport.run(connectionFor(node, options.environment), command, { input: options.input });
  }
}

function vmSettings(value = {}) {
  return {
    hosts: Array.isArray(value.hosts) ? value.hosts.map(normalizeHost) : [],
    sourceDirectory: resolve(requiredString(value.sourceDirectory, "target.vm.sourceDirectory")),
    remoteDirectory: remotePath(value.remoteDirectory || DEFAULT_REMOTE_DIRECTORY),
    entrypoint: relativePath(value.entrypoint || "src/index.js"),
  };
}

function planSettings(plan) {
  return vmSettings(plan.target?.vm);
}

function normalizeHost(value) {
  const host = hostAddress(value?.host);
  const result = { host, ssh: normalizeSsh(value.ssh) };
  if (value.peerHost) result.peerHost = requiredString(value.peerHost, "target.vm.hosts[].peerHost");
  if (value.publicHost) result.publicHost = requiredString(value.publicHost, "target.vm.hosts[].publicHost");
  return result;
}

function hostAddress(value) {
  if (!value || typeof value !== "string" || !/^[a-zA-Z0-9._:-]+$/.test(value)) throw new Error(`invalid VM address: ${value || "missing"}`);
  return value;
}

function probeTcpPort(host, port, timeoutMs = 5000) {
  return new Promise((resolveProbe, reject) => {
    const startedAt = Date.now();
    const socket = createConnection({ host, port });
    let settled = false;
    const timer = setTimeout(() => fail(new Error("connection timed out")), timeoutMs);
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`cannot reach ${host}:${port}: ${error.message}`));
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const latencyMs = Date.now() - startedAt;
      socket.destroy();
      resolveProbe({ reachable: true, latencyMs });
    });
  });
}

function hostConfigurations(value) {
  if (!Array.isArray(value)) throw new Error("targetSettings.hosts must be an array");
  return value.map(normalizeHost);
}

function normalizeSsh(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("target.vm.hosts[].ssh must be an object");
  const ssh = {
    user: requiredUser(value.user),
    port: positivePort(value.port ?? 22),
  };
  if (value.password) {
    ssh.password = secretReference(value.password, "target.vm.hosts[].ssh.password");
  } else if (value.identityFile) {
    ssh.identityFile = resolve(requiredString(value.identityFile, "target.vm.hosts[].ssh.identityFile"));
    if (value.passphrase) ssh.passphrase = secretReference(value.passphrase, "target.vm.hosts[].ssh.passphrase");
  }
  return ssh;
}

function connectionFor(node, environment = process.env) {
  const { host, ssh } = node.machine;
  const connection = { host, port: ssh.port, username: ssh.user };
  if (ssh.password) connection.password = requiredSecret(ssh.password, environment, `${host} SSH password`);
  else if (ssh.identityFile) {
    connection.identityFile = ssh.identityFile;
    if (ssh.passphrase) connection.passphrase = requiredSecret(ssh.passphrase, environment, `${host} private-key passphrase`);
  } else connection.agent = environment.SSH_AUTH_SOCK || process.env.SSH_AUTH_SOCK;
  return connection;
}

async function eachNode(plan, operation) {
  const nodes = [...plan.nodes];
  const workers = Array.from({ length: Math.min(MAX_PARALLEL_HOSTS, nodes.length) }, async () => {
    while (nodes.length) await operation(nodes.shift());
  });
  await Promise.all(workers);
}

function urlHost(value) { return value.includes(":") && !value.startsWith("[") ? `[${value}]` : value; }
function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}
function requiredUser(value) {
  const user = requiredString(value, "target.vm.hosts[].ssh.user");
  if (!/^[a-z_][a-z0-9_-]*$/i.test(user)) throw new Error("target.vm.hosts[].ssh.user is invalid");
  return user;
}

function secretReference(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be a secret reference`);
  const fromEnvironment = requiredString(value.fromEnvironment, `${label}.fromEnvironment`);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(fromEnvironment)) throw new Error(`${label}.fromEnvironment must be an environment variable name`);
  return { fromEnvironment };
}

function requiredSecret(reference, environment, label) {
  const value = environment?.[reference.fromEnvironment];
  if (typeof value !== "string" || !value) throw new Error(`required secret is missing: ${reference.fromEnvironment} (${label})`);
  return value;
}

async function authenticationMethod(question, ssh) {
  const current = ssh.password ? "password" : ssh.identityFile ? "key" : "agent";
  while (true) {
    const value = (await question(`SSH authentication: agent, key, or password [${current}]: `)).trim().toLowerCase() || current;
    if (["agent", "key", "password"].includes(value)) return value;
  }
}
function positivePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("target.vm.hosts[].ssh.port must be a valid port");
  return port;
}
function remotePath(value) {
  const path = requiredString(value, "target.vm.remoteDirectory");
  if (!/^\/[a-zA-Z0-9._/-]+$/.test(path) || path.includes("..")) throw new Error("target.vm.remoteDirectory must be a safe absolute path");
  return path.replace(/\/$/, "");
}
function relativePath(value) {
  const path = requiredString(value, "target.vm.entrypoint");
  if (path.startsWith("/") || path.split("/").includes("..")) throw new Error("target.vm.entrypoint must stay inside the source directory");
  return path;
}
