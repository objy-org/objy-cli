import { createServer } from "node:net";
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function assertPortAvailable(host, port) {
  return probeHosts(host).reduce(
    (previous, probeHost) => previous.then(() => assertSinglePortAvailable(probeHost, port)),
    Promise.resolve(),
  );
}

function assertSinglePortAvailable(host, port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      if (error.code === "EADDRINUSE") {
        reject(new Error(`public port ${host}:${port} is already in use`));
        return;
      }
      reject(error);
    });
    server.listen({ host, port, exclusive: true }, () => server.close(resolve));
  });
}

function probeHosts(host) {
  if (host === "0.0.0.0") return [host, "127.0.0.1"];
  if (["::", "[::]"].includes(host)) return ["::", "::1", "127.0.0.1"];
  return [host];
}

export async function findAvailablePortRange(count, {
  host = "127.0.0.1", hosts = [host], start = 8080, end = 65_535, reservedPorts = [],
} = {}) {
  if (!Number.isInteger(count) || count < 1) throw new Error("port range size must be a positive integer");
  const bindHosts = [...new Set(hosts.filter(Boolean))];
  const reserved = new Set(reservedPorts);
  if (!bindHosts.length) throw new Error("at least one port bind address is required");
  for (let first = start; first + count - 1 <= end; first += count) {
    let available = true;
    for (let port = first; port < first + count; port++) {
      if (reserved.has(port)) { available = false; break; }
      for (const bindHost of bindHosts) {
        try { await assertPortAvailable(bindHost, port); }
        catch { available = false; break; }
      }
      if (!available) break;
    }
    if (available) return first;
  }
  throw new Error(`no ${count}-port range is available on ${bindHosts.join(", ")}`);
}

export async function assignAvailableLocalPorts(manifest, {
  targetDriver, storageDriver, start = manifest.installation.public.basePort, preserveStorage = false, reservedPorts = [],
} = {}) {
  const targetAllocation = targetDriver?.localPorts?.(manifest);
  const storageAllocation = storageDriver?.localPorts?.(manifest);
  const allocations = [targetAllocation, ...(preserveStorage ? [] : [storageAllocation])]
    .filter((allocation) => allocation?.count > 0);
  if (!allocations.length) return { changed: false, count: 0, first: null };

  const count = allocations.reduce((total, allocation) => total + allocation.count, 0);
  const reserved = [...reservedPorts, ...(preserveStorage ? allocationPorts(storageAllocation) : [])];
  const first = await findAvailablePortRange(count, {
    hosts: allocations.map(({ host }) => host),
    start,
    reservedPorts: reserved,
  });
  let changed = false;
  let offset = 0;
  for (const allocation of allocations) {
    const next = first + offset;
    if (allocation.current !== next) changed = true;
    allocation.assign(next);
    offset += allocation.count;
  }
  return { changed, count, first };
}

export function dockerPublishedPorts(source) {
  const ports = new Set();
  for (const match of source.matchAll(/:(\d+)(?:-(\d+))?->/g)) {
    const first = Number(match[1]), last = Number(match[2] || match[1]);
    for (let port = first; port <= Math.min(last, 65535); port++) ports.add(port);
  }
  return ports;
}

export async function reservedLocalPorts(root, run, { requireDocker = false } = {}) {
  const ports = new Set();
  // Docker Desktop's forwarding can allow a host bind probe even though Docker owns the port.
  try {
    const result = await run('docker', ['ps', '--format', '{{json .Ports}}']);
    for (const port of dockerPublishedPorts(result.stdout)) ports.add(port);
  } catch (error) { if (requireDocker) throw error; }
  const entries = await readdir(root).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const id of entries.filter(name => /^odb-[a-f0-9]{12}$/.test(name))) {
    let plan;
    try { plan = JSON.parse(await readFile(join(root, id, 'runtime/plan.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!['docker', 'node-process'].includes(plan.driver)) continue;
    for (const node of plan.nodes) ports.add(node.hostPort || node.port);
    if (plan.edge?.port) ports.add(plan.edge.port);
    const localStorage = plan.storage?.local;
    if (Number.isInteger(localStorage?.basePort) && Number.isInteger(localStorage?.portCount)) {
      for (let i = 0; i < localStorage.portCount; i++) ports.add(localStorage.basePort + i);
    }
    const services = plan.storage?.targetExtensions?.docker?.services || {};
    for (const service of Object.values(services)) for (const mapping of service.ports || []) ports.add(Number(mapping.split(':').at(-2)));
  }
  return [...ports].filter(Number.isInteger);
}

function allocationPorts(allocation) {
  if (!allocation?.count || !Number.isInteger(allocation.current)) return [];
  return Array.from({ length: allocation.count }, (_, index) => allocation.current + index);
}
