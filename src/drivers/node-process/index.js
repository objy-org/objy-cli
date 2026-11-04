import { spawn } from "node:child_process";
import { access, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { join, relative, resolve } from "node:path";
import { assertPortAvailable } from "../../core/ports.js";
import { createDeploymentPlan } from "../../core/planner.js";
import { processExists, runProcess } from "../../core/process.js";
import { localAccessHost, publicUrl, renderCaddyfile, usesHttps } from "../../core/public-access.js";
import { findServerDirectory } from "../../core/runtime-source.js";
import { installationPresets } from "../../core/setup.js";

const PROCESS_FILE = "processes.json";
const LOG_DIRECTORY = "logs";
const MAX_TAIL_BYTES = 1024 * 1024;
const PROCESS_STARTUP_TIMEOUT_MS = 120_000;
const CADDY_PROCESS = "objydb-caddy";
const CADDY_FILE = "Caddyfile";

export function createNodeProcessDriver({
  spawnProcess = spawn,
  nodeBinary = process.execPath,
  caddyBinary = "caddy",
  run = runProcess,
} = {}) {
  return {
    id: "node-process",
    name: "node-process",
    label: "Node process",
    description: "Run OBJY DB directly as local Node.js processes.",
    presets: installationPresets(),
    settingsKey: "nodeProcess",
    setupFields: [],
    configurationFields: [],
    localPorts: localNodePorts,
    applySetup(manifest) {
      manifest.installation.artifact = "local-node";
      manifest.target.nodeProcess = {
        directory: findServerDirectory(),
        entrypoint: "src/index.js",
      };
    },
    nodePublicUrl: (_plan, node) => node.healthUrl || node.publicUrl,
    plan(manifest, options = {}) {
      const directory = resolve(manifest.target.nodeProcess?.directory || ".");
      const entrypoint = manifest.target.nodeProcess?.entrypoint || "src/index.js";
      const edgeHost = localAccessHost(manifest.installation.public.bindAddress);
      const edgePort = manifest.installation.public.basePort
        + manifest.installation.topology.shards * manifest.installation.topology.replicas;
      const plan = createDeploymentPlan(manifest, {
        shardRevision: options.shardRevision,
        materializeNode(node) {
          const port = manifest.installation.public.basePort + node.index;
          const bindAddress = manifest.installation.public.bindAddress;
          const host = publicHost(bindAddress);
          const healthUrl = `http://${host}:${port}`;
          return {
            processName: node.id,
            port,
            peerUrl: `http://${host}:${port}`,
            healthUrl,
            publicUrl: usesHttps(manifest) ? publicUrl("https", edgeHost, edgePort) : healthUrl,
            directory,
            entrypoint,
          };
        },
      });
      if (usesHttps(manifest)) plan.edge = { type: "caddy", host: edgeHost, port: edgePort };
      return plan;
    },
    async configure(manifest) {
      manifest.target.nodeProcess = {
        directory: findServerDirectory(),
        entrypoint: "src/index.js",
      };
      manifest.installation.artifact = "local-node";
    },
    async validatePlan(plan) {
      const target = nodeTarget(plan);
      await access(target.directory).catch(() => { throw new Error(`OBJY DB directory does not exist: ${target.directory}`); });
      await access(target.entrypoint).catch(() => { throw new Error(`OBJY DB entrypoint does not exist: ${target.entrypoint}`); });
    },
    async check(plan) {
      await run(nodeBinary, ["--version"]).catch((error) => {
        throw new Error(`Node.js is not ready: ${error.message}`);
      });
      if (usesHttps(plan)) {
        await run(caddyBinary, ["version"]).catch((error) => {
          throw new Error(`HTTPS requires Caddy on this machine: ${error.message}`);
        });
      }
    },
    renderFiles: (plan) => usesHttps(plan) ? [{
      key: "caddy", name: CADDY_FILE, mode: 0o644,
      content: renderCaddyfile({
        host: plan.edge.host,
        port: plan.edge.port,
        upstreams: plan.nodes.map((node) => `127.0.0.1:${node.port}`),
      }),
    }] : [],
    preflight: checkLocalPorts,
    preflightLocalPorts: checkLocalPorts,
    up: (paths, { environment } = {}) => startProcesses(paths, environment),
    start: (paths, { environment } = {}) => startProcesses(paths, environment),
    stop: (paths) => stopProcesses(paths),
    async restart(paths, { environment } = {}) {
      await stopProcesses(paths);
      await startProcesses(paths, environment);
    },
    remove: (paths) => stopProcesses(paths),
    async status(paths) {
      const [plan, records] = await Promise.all([readJson(paths.plan), readRecords(paths)]);
      const edge = usesHttps(plan) ? records.find(({ nodeId }) => nodeId === CADDY_PROCESS) : null;
      const edgeRunning = !usesHttps(plan) || Boolean(edge && await ownsProcess(edge));
      return Promise.all(plan.nodes.map(async (node) => {
        const record = records.find(({ nodeId }) => nodeId === node.id);
        const running = Boolean(record && await ownsProcess(record));
        return {
          nodeId: node.id,
          state: running && edgeRunning ? "running" : "exited",
          detail: !running ? "not running" : !edgeRunning ? "HTTPS edge is not running" : `pid ${record.pid}`,
        };
      }));
    },
    readLogs: (paths, options) => readLogs(paths, options),
    logs: (paths, options) => followLogs(paths, options),
  };

  async function startProcesses(paths, environment = process.env) {
    const [plan, existing] = await Promise.all([readJson(paths.plan), readRecords(paths)]);
    const live = (await Promise.all(existing.map(async record => await ownsProcess(record) ? record : null))).filter(Boolean);
    const expected = [...plan.nodes.map(({ id }) => id), ...(usesHttps(plan) ? [CADDY_PROCESS] : [])];
    if (live.length === expected.length && expected.every((id) => live.some(({ nodeId }) => nodeId === id))) {
      return live;
    }
    if (live.some(record => !expected.includes(record.nodeId))) throw new Error("Unexpected process in deployment state");
    const target = nodeTarget(plan);
    const logDirectory = join(paths.root, LOG_DIRECTORY);
    await mkdir(logDirectory, { recursive: true, mode: 0o700 });
    const records = [...live];
    try {
      for (const node of plan.nodes) {
        if (live.some(record => record.nodeId === node.id)) continue;
        await assertPortAvailable(plan.public.bindAddress, node.port);
        const log = join(logDirectory, `${node.id}.log`);
        const output = await open(log, "a", 0o600);
        let child;
        try {
          child = spawnProcess(nodeBinary, [
            `--max-old-space-size=${plan.runtime.heapMb}`,
            target.entrypoint,
            "--config", plan.configPath,
            "--node", node.id,
            "--url", node.peerUrl,
            "--port", String(node.port),
          ], {
            cwd: target.directory,
            env: { ...process.env, ...environment },
            stdio: ["ignore", output.fd, output.fd],
            detached: true,
          });
          await childStarted(child, node.id);
        } finally {
          await output.close();
        }
        child.unref();
        records.push({ nodeId: node.id, pid: child.pid, identity: await processIdentity(child.pid), log, startedAt: new Date().toISOString() });
        await writeRecords(paths, records);
      }
      if (usesHttps(plan) && !live.some(record => record.nodeId === CADDY_PROCESS)) {
        await waitForEndpoints(plan.nodes.map((node) => `${node.healthUrl}/health`));
        const log = join(logDirectory, `${CADDY_PROCESS}.log`);
        const output = await open(log, "a", 0o600);
        let child;
        try {
          child = spawnProcess(caddyBinary, [
            "run", "--config", join(paths.root, CADDY_FILE), "--adapter", "caddyfile",
          ], {
            cwd: paths.root,
            env: { ...process.env, ...environment },
            stdio: ["ignore", output.fd, output.fd],
            detached: true,
          });
          await childStarted(child, CADDY_PROCESS);
        } finally {
          await output.close();
        }
        child.unref();
        records.push({ nodeId: CADDY_PROCESS, pid: child.pid, identity: await processIdentity(child.pid), log, startedAt: new Date().toISOString() });
        await writeRecords(paths, records);
        await waitForEndpoints([`${plan.nodes[0].publicUrl}/health`], { allowUntrustedTls: true });
      }
      await writeRecords(paths, records);
      await delay(100);
      const failed = records.find(({ pid }) => !processExists(pid));
      if (failed) throw new Error(`${failed.nodeId} exited during startup; inspect its log`);
      return records;
    } catch (error) {
      await terminate(records);
      await rm(processPath(paths), { force: true });
      throw error;
    }
  }
}

async function checkLocalPorts(plan) {
  for (const node of plan.nodes) await assertPortAvailable(plan.public.bindAddress, node.port);
  if (usesHttps(plan)) await assertPortAvailable(plan.public.bindAddress, plan.edge.port);
}

async function stopProcesses(paths) {
  const records = await readRecords(paths);
  await terminate(records);
  await rm(processPath(paths), { force: true });
}

export async function processIdentity(pid) {
  if (!processExists(pid)) return null;
  try {
    if (process.platform === 'win32') {
      const { stdout } = await runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "ProcessId = ${Number(pid)}" | Select-Object CreationDate,CommandLine | ConvertTo-Json -Compress`]);
      return stdout.trim() || null;
    }
    const { stdout } = await runProcess('ps', ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'args=']);
    return stdout.trim() || null;
  } catch { return null; }
}
export async function ownsProcess(record) {
  if (!processExists(record.pid)) return false;
  const observed = await processIdentity(record.pid);
  if (!observed) {
    if (!processExists(record.pid)) return false;
    throw new Error(`Cannot verify ownership of process ${record.pid}; no signal was sent`);
  }
  return Boolean(record.identity && record.identity === observed);
}
export async function terminate(records) {
  for (const record of records) {
    if (!await ownsProcess(record)) continue;
    try { process.kill(record.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (!(await Promise.all(records.map(ownsProcess))).some(Boolean)) return;
    await delay(250);
  }
  throw new Error('Graceful shutdown is still pending. Processes were not force-killed; check logs and use objy resume.');
}

async function readLogs(paths, { node, tail = 200 } = {}) {
  const plan = await readJson(paths.plan);
  const nodes = node ? plan.nodes.filter(({ id }) => id === node) : [
    ...plan.nodes,
    ...(usesHttps(plan) ? [{ id: CADDY_PROCESS }] : []),
  ];
  const sections = [];
  for (const item of nodes) {
    const source = await tailFile(join(paths.root, LOG_DIRECTORY, `${item.id}.log`), tail);
    if (nodes.length > 1) sections.push(`==> ${item.id} <==\n${source}`);
    else sections.push(source);
  }
  return sections.join("\n");
}

async function followLogs(paths, options = {}) {
  process.stdout.write(await readLogs(paths, options));
  const plan = await readJson(paths.plan);
  const nodes = options.node ? plan.nodes.filter(({ id }) => id === options.node) : plan.nodes;
  const files = nodes.map(({ id }) => join(paths.root, LOG_DIRECTORY, `${id}.log`));
  const positions = new Map();
  for (const file of files) positions.set(file, await fileSize(file));
  await new Promise((resolveFollow) => {
    const timer = setInterval(async () => {
      for (const file of files) {
        const previous = positions.get(file) || 0;
        const next = await fileSize(file);
        if (next <= previous) continue;
        const handle = await open(file, "r");
        try {
          const buffer = Buffer.alloc(next - previous);
          await handle.read(buffer, 0, buffer.length, previous);
          process.stdout.write(buffer);
        } finally { await handle.close(); }
        positions.set(file, next);
      }
    }, 500);
    const finish = () => { clearInterval(timer); resolveFollow(); };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
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

function nodeTarget(plan) {
  const settings = plan.target?.nodeProcess;
  if (!settings) throw new Error("target.nodeProcess is required");
  const directory = resolve(requiredString(settings.directory, "target.nodeProcess.directory"));
  const entrypoint = resolve(directory, settings.entrypoint || "src/index.js");
  const pathWithinDirectory = relative(directory, entrypoint);
  if (pathWithinDirectory.startsWith("..") || pathWithinDirectory === "") {
    throw new Error("target.nodeProcess.entrypoint must be inside the OBJY DB directory");
  }
  return { directory, entrypoint };
}

function publicHost(bindAddress) {
  return ["0.0.0.0", "::", "[::]"].includes(bindAddress) ? "127.0.0.1" : bindAddress;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function processPath(paths) { return join(paths.root, PROCESS_FILE); }
async function readRecords(paths) {
  try { return await readJson(processPath(paths)); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function writeRecords(paths, records) {
  const path = processPath(paths);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
async function fileSize(path) { try { return (await stat(path)).size; } catch (error) { if (error.code === "ENOENT") return 0; throw error; } }
async function tailFile(path, lines) {
  let info;
  try { info = await stat(path); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
  const length = Math.min(info.size, MAX_TAIL_BYTES);
  const buffer = Buffer.alloc(length);
  const handle = await open(path, "r");
  try { await handle.read(buffer, 0, length, info.size - length); }
  finally { await handle.close(); }
  let source = buffer.toString("utf8");
  if (info.size > length) source = source.slice(Math.max(0, source.indexOf("\n") + 1));
  const values = source.split("\n");
  return values.slice(Math.max(0, values.length - lines - 1)).join("\n");
}
function childStarted(child, nodeId) {
  return new Promise((resolveStarted, reject) => {
    child.once("spawn", resolveStarted);
    child.once("error", (error) => reject(new Error(`${nodeId} could not be started: ${error.message}`)));
  });
}
function delay(ms) { return new Promise((resolveDelay) => setTimeout(resolveDelay, ms)); }

async function waitForEndpoints(urls, { allowUntrustedTls = false } = {}) {
  const deadline = Date.now() + PROCESS_STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if ((await Promise.all(urls.map((url) => endpointReady(url, allowUntrustedTls)))).every(Boolean)) return;
    await delay(100);
  }
  throw new Error(`timed out waiting for ${urls.join(", ")}`);
}

function endpointReady(url, allowUntrustedTls) {
  return new Promise((resolveReady) => {
    const secure = url.startsWith("https:");
    const request = (secure ? httpsGet : httpGet)(url, {
      ...(secure ? { rejectUnauthorized: !allowUntrustedTls } : {}),
      timeout: 1_000,
    }, (response) => {
      response.resume();
      response.once("end", () => resolveReady(response.statusCode === 200));
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolveReady(false));
  });
}
