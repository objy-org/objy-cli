import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isIP } from "node:net";
import { createDeploymentPlan } from "../../core/planner.js";
import { runProcess } from "../../core/process.js";
import { assertPortAvailable } from "../../core/ports.js";
import { localAccessHost, publicUrl, renderCaddyfile, usesHttps } from "../../core/public-access.js";
import { secretEnvironmentNames } from "../../core/secrets.js";
import { installationPresets } from "../../core/setup.js";

const CONFIG_PATH = "/etc/objydb/objydb.json";
const WAL_PATH = "/var/lib/objydb/wal";

export function renderDockerCompose(plan) {
  const services = {};
  const volumes = {};
  const environment = secretEnvironmentNames(plan.database);
  const healthScript = [
    "fetch('http://127.0.0.1:8080/health')",
    ".then(async response => ({ response, body: await response.json() }))",
    ".then(({ response, body }) => { if (!response.ok || body.restore?.status !== 'ready') process.exit(1); })",
    ".catch(() => process.exit(1));",
  ].join("");

  for (const node of plan.nodes) {
    const volume = `${node.service}-wal`;
    services[node.service] = {
      image: plan.image,
      restart: "unless-stopped",
      command: [
        "node",
        `--max-old-space-size=${plan.runtime.heapMb}`,
        "src/index.js",
        "--config", CONFIG_PATH,
        "--node", node.id,
        "--url", node.peerUrl,
        "--port", String(node.internalPort),
      ],
      ports: [`${usesHttps(plan) ? "127.0.0.1" : plan.public.bindAddress}:${node.hostPort}:${node.internalPort}`],
      volumes: [
        `${plan.configPath}:${CONFIG_PATH}:ro`,
        `${volume}:${WAL_PATH}`,
      ],
      environment,
      healthcheck: {
        test: ["CMD", "node", "--input-type=module", "-e", healthScript],
        interval: "10s",
        timeout: "5s",
        retries: 60,
        start_period: "10s",
      },
      stop_grace_period: "60s",
      networks: ["objydb"],
      extra_hosts: ["host.docker.internal:host-gateway"],
      labels: {
        "io.objydb.deployment": plan.deployment,
        "io.objydb.node": node.id,
        "io.objydb.shard": node.shard,
      },
    };
    volumes[volume] = {};
  }

  if (usesHttps(plan)) {
    services["objydb-caddy"] = {
      image: "caddy:2.10.2-alpine",
      restart: "unless-stopped",
      ports: [
        `${plan.public.bindAddress}:${plan.edge.port}:443`,
        `${plan.public.bindAddress}:${plan.edge.port}:443/udp`,
      ],
      volumes: [
        "./Caddyfile:/etc/caddy/Caddyfile:ro",
        "objydb-caddy-data:/data",
        "objydb-caddy-config:/config",
      ],
      depends_on: Object.fromEntries(plan.nodes.map((node) => [node.service, { condition: "service_healthy" }])),
      networks: ["objydb"],
      labels: { "io.objydb.deployment": plan.deployment, "io.objydb.edge": "caddy" },
    };
    volumes["objydb-caddy-data"] = {};
    volumes["objydb-caddy-config"] = {};
  }

  const extension = plan.storage?.targetExtensions?.docker;
  mergeUnique(services, extension?.services, "Docker service");
  mergeUnique(volumes, extension?.volumes, "Docker volume");
  assertUniquePublishedPorts(services);

  return `${JSON.stringify({
    name: plan.target.docker.projectName,
    services,
    volumes,
    networks: { objydb: {} },
  }, null, 2)}\n`;
}

export function createDockerDriver({ run = runProcess } = {}) {
  const compose = (paths, args, options = {}) => run("docker", ["compose", "-f", join(paths.root, "compose.json"), ...args], {
    cwd: paths.root,
    env: options.environment ? { ...process.env, ...options.environment } : process.env,
    ...options,
  });

  return {
    id: "docker",
    name: "docker",
    label: "Docker",
    description: "Run OBJY DB with Docker Compose on this machine.",
    presets: installationPresets(),
    settingsKey: "docker",
    preferredStorage: "docker-minio",
    setupFields: [],
    configurationFields: [],
    localPorts: localNodePorts,
    applySetup(manifest) {
      manifest.target.docker = { projectName: manifest.metadata.name };
    },
    nodePublicUrl(plan, node) {
      if (node.healthUrl) return node.healthUrl;
      if (node.publicUrl) return node.publicUrl;
      const bindAddress = plan.public.bindAddress;
      const host = ["0.0.0.0", "::", "[::]"].includes(bindAddress) ? "127.0.0.1" : bindAddress;
      return `http://${host}:${node.hostPort}`;
    },
    plan(manifest, options = {}) {
      const edgeHost = localAccessHost(manifest.installation.public.bindAddress);
      const edgePort = manifest.installation.public.basePort
        + manifest.installation.topology.shards * manifest.installation.topology.replicas;
      const plan = createDeploymentPlan(manifest, {
        shardRevision: options.shardRevision,
        materializeNode(node) {
          const internalPort = 8080;
          const hostPort = manifest.installation.public.basePort + node.index;
          const bindAddress = manifest.installation.public.bindAddress;
          const publicHost = ["0.0.0.0", "::", "[::]"].includes(bindAddress) ? "127.0.0.1" : bindAddress;
          const healthUrl = `http://${usesHttps(manifest) ? "127.0.0.1" : publicHost}:${hostPort}`;
          return {
            service: node.id,
            internalPort,
            hostPort,
            peerUrl: `http://${node.id}:${internalPort}`,
            healthUrl,
            publicUrl: usesHttps(manifest)
              ? publicUrl("https", edgeHost, edgePort)
              : healthUrl,
          };
        },
      });
      if (usesHttps(manifest)) plan.edge = {
        type: "caddy", service: "objydb-caddy", host: edgeHost, port: edgePort,
      };
      return plan;
    },
    async configure(manifest) {
      manifest.target.docker = { projectName: manifest.metadata.name };
    },
    validatePlan(plan) {
      if (!plan.target?.docker?.projectName) throw new Error("target.docker.projectName is required");
    },
    databaseConfig(plan) {
      const config = structuredClone(plan.database);
      config.persistence.s3.endpoint = runtimeS3Endpoint(config.persistence.s3.endpoint);
      if (config.files?.s3?.endpoint) config.files.s3.endpoint = runtimeS3Endpoint(config.files.s3.endpoint);
      return config;
    },
    renderFiles: (plan) => [
      { key: "compose", name: "compose.json", content: renderDockerCompose(plan), mode: 0o644 },
      ...(usesHttps(plan) ? [{
        key: "caddy", name: "Caddyfile", mode: 0o644,
        content: renderCaddyfile({
          host: plan.edge.host,
          upstreams: plan.nodes.map((node) => `${node.service}:${node.internalPort}`),
        }),
      }] : []),
    ],
    async check() {
      await run("docker", ["version", "--format", "{{.Server.Version}}"]).catch((error) => {
        throw new Error(`Docker is not ready: ${error.message}`);
      });
      await run("docker", ["compose", "version", "--short"]).catch((error) => {
        throw new Error(`Docker Compose is not available: ${error.message}`);
      });
    },
    preflight: checkLocalPorts,
    preflightLocalPorts: checkLocalPorts,
    up: (paths, { pull = false, environment, removeOrphans = false } = {}) => compose(paths, [
      "up", "-d",
      ...(pull ? ["--pull", "always"] : []),
      ...(removeOrphans ? ["--remove-orphans"] : []),
    ], { environment }),
    start: (paths, { environment, services = [] } = {}) => compose(paths, ["up", "-d", ...services], { environment }),
    async stop(paths, { services = [], environment } = {}) {
      // Keep object storage running while database nodes flush. Never force-kill them.
      const plan = await readJson(paths.plan);
      const selected = services.length ? services : plan.nodes.map(node => node.service);
      const { stdout } = await compose(paths, ['ps', '-q', ...selected], { environment });
      const ids = stdout.trim().split(/\s+/).filter(Boolean);
      if (ids.length) await run('docker', ['stop', '--timeout', '-1', ...ids]);
    },
    restart: (paths, { environment, services = [] } = {}) => compose(paths, ["up", "-d", "--force-recreate", ...services], { environment }),
    remove: (paths) => compose(paths, ["down", "--remove-orphans"]),
    async cleanupFailedInstall(paths) {
      try {
        await access(join(paths.root, "compose.json"));
      } catch (error) {
        if (error.code === "ENOENT") return;
        throw error;
      }
      await compose(paths, ["down", "--remove-orphans"]);
    },
    startServices: (paths, services, { environment } = {}) => compose(paths, ["up", "-d", ...services], { environment }),
    stopServices: (paths, services) => compose(paths, ["stop", ...services]),
    restartServices: (paths, services, { environment } = {}) => compose(paths, ["up", "-d", "--force-recreate", ...services], { environment }),
    async serviceStatus(paths, services, { environment } = {}) {
      const { stdout } = await compose(paths, ["ps", "--format", "json", ...services], { environment });
      return parseComposeStatus(stdout);
    },
    async status(paths, { environment } = {}) {
      const [{ stdout }, plan] = await Promise.all([
        compose(paths, ["ps", "--all", "--format", "json"], { environment }),
        readJson(join(paths.root, "plan.json")),
      ]);
      const records = parseComposeStatus(stdout);
      const nodeIds = new Set(plan.nodes.map(({ id }) => id));
      const containers = records.filter(record => nodeIds.has(record.nodeId) && record.containerId);
      if (containers.length) {
        try {
          // Inspect only network metadata; full container inspection includes credentials.
          const format = '{"service":{{json (index .Config.Labels "com.docker.compose.service")}},"networks":{{json .NetworkSettings.Networks}}}';
          const inspected = await run("docker", ["inspect", "--type", "container", "--format", format, ...containers.map(record => record.containerId)]);
          const networkName = `${plan.target.docker.projectName}_objydb`;
          const addresses = new Map(inspected.stdout.trim().split("\n").filter(Boolean).map(line => {
            const value = JSON.parse(line), network = value.networks?.[networkName];
            return [value.service, [network?.IPAddress, network?.GlobalIPv6Address].find(address => isIP(address || ""))];
          }));
          for (const record of containers) record.address = addresses.get(record.nodeId) || null;
        } catch { /* A container can disappear during observation. Never substitute its DNS name for an IP. */ }
      }
      if (!usesHttps(plan)) return records;
      const edge = records.find(({ nodeId }) => nodeId === plan.edge?.service);
      if (edge?.state === "running") return records;
      const fatal = ["dead", "exited", "failed", "restarting"].includes(edge?.state);
      return records.map((record) => nodeIds.has(record.nodeId)
        ? { ...record, state: fatal ? "failed" : edge?.state || "starting", detail: `HTTPS edge is ${edge?.state || "starting"}` }
        : record);
    },
    logs: (paths, { node, tail = 200 } = {}) => compose(paths, [
      "logs",
      "--follow",
      "--tail", String(tail),
      ...(node ? [node] : []),
    ], { stdio: "inherit" }),
    async readLogs(paths, { node, tail = 200, environment } = {}) {
      const result = await compose(paths, [
        "logs",
        "--no-color",
        "--tail", String(tail),
        ...(node ? [node] : []),
      ], { environment });
      return `${result.stdout}${result.stderr}`;
    },
  };
}

function localNodePorts(manifest) {
  const nodes = manifest.installation.topology.shards * manifest.installation.topology.replicas;
  return {
    count: nodes + (usesHttps(manifest) ? 1 : 0),
    current: manifest.installation.public.basePort,
    host: manifest.installation.public.bindAddress,
    assign(first) { manifest.installation.public.basePort = first; },
  };
}

async function checkLocalPorts(plan) {
  const nodeHost = usesHttps(plan) ? "127.0.0.1" : plan.public.bindAddress;
  for (const node of plan.nodes) await assertPortAvailable(nodeHost, node.hostPort);
  if (usesHttps(plan)) await assertPortAvailable(plan.public.bindAddress, plan.edge.port);
}

function assertUniquePublishedPorts(services) {
  const bindings = [];
  for (const [service, definition] of Object.entries(services)) {
    for (const mapping of definition.ports || []) {
      const binding = publishedBinding(mapping);
      if (!binding) continue;
      const conflict = bindings.find((other) => other.port === binding.port
        && other.protocol === binding.protocol
        && (other.host === binding.host || isWildcard(other.host) || isWildcard(binding.host)));
      if (conflict) {
        throw new Error(`Docker port ${binding.host}:${binding.port} is assigned to both ${conflict.service} and ${service}`);
      }
      bindings.push({ ...binding, service });
    }
  }
}

function publishedBinding(mapping) {
  if (typeof mapping !== "string") return null;
  const match = mapping.match(/^(?:(.+):)?(\d+):\d+(?:\/([a-z]+))?$/i);
  return match ? { host: match[1] || "0.0.0.0", port: Number(match[2]), protocol: match[3] || "tcp" } : null;
}

function isWildcard(host) {
  return ["0.0.0.0", "::", "[::]"].includes(host);
}

function mergeUnique(target, source = {}, label) {
  for (const [name, value] of Object.entries(source)) {
    if (target[name]) throw new Error(`${label} name is already in use: ${name}`);
    target[name] = value;
  }
}

function runtimeS3Endpoint(value) {
  const endpoint = new URL(value);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(endpoint.hostname)) return value;
  endpoint.hostname = "host.docker.internal";
  return endpoint.toString().replace(/\/$/, "");
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

function parseComposeStatus(source) {
  const value = source.trim();
  if (!value) return [];
  let records;
  try {
    const parsed = JSON.parse(value);
    records = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    records = value.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  }
  return records.map((record) => ({
    nodeId: record.Service || record.Name?.replace(/-1$/, ""),
    ...(record.ID ? { containerId: record.ID } : {}),
    state: String(record.State || "unknown").toLowerCase(),
    detail: record.Status || record.State || "unknown",
  }));
}
