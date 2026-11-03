import { access, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { shellQuote as quote } from "./runtime-environment.js";
import { caddySystemdSetupCommand, renderCaddyfile, usesHttps } from "../core/public-access.js";

export function createSystemdNodeRuntime({
  run,
  remote,
  upload,
  follow,
  settings,
  environmentFile,
  nodeLabel = (node) => node.id,
  maxParallel = 4,
  archiveName = "node-release.tgz",
  manageHttps = true,
}) {
  const nodeUsesHttps = plan => manageHttps && usesHttps(plan);
  return {
    async validate(plan) {
      const runtime = settings(plan);
      await access(runtime.sourceDirectory).catch(() => {
        throw new Error(`OBJY DB directory does not exist: ${runtime.sourceDirectory}`);
      });
      const entrypoint = resolve(runtime.sourceDirectory, runtime.entrypoint);
      await access(entrypoint).catch(() => {
        throw new Error(`OBJY DB entrypoint does not exist: ${entrypoint}`);
      });
    },

    async check() {
      await run("tar", ["--version"]).catch((error) => {
        throw new Error(`tar is not available: ${error.message}`);
      });
    },

    async deploy(paths, environment = process.env, progress = () => {}, { start = true, nodeIds, releaseId } = {}) {
      const plan = await readJson(paths.plan);
      const runtime = settings(plan);
      const archive = join(paths.root, archiveName);
      progress("Packaging the OBJY DB release");
      await rm(archive, { force: true });
      await run("tar", [
        "-czf", archive,
        "--exclude=.git", "--exclude=node_modules", "--exclude=.objydb",
        "-C", runtime.sourceDirectory, ".",
      ]);
      const release = releaseId || `${safeSegment(plan.databaseVersion)}-${Date.now()}`;
      try {
        await eachNode(plan.nodes.filter(n => !nodeIds || nodeIds.includes(n.id)), maxParallel, (node) => deployNode(
          plan, node, paths, archive, release, runtime, environment, progress, start,
        ));
      } finally {
        await rm(archive, { force: true });
      }
    },

    async action(paths, action, environment = process.env) {
      const plan = await readJson(paths.plan);
      await eachNode(plan.nodes, maxParallel, (node) => remote(
        plan,
        node,
        `sudo systemctl ${action} ${[unitName(node), ...(nodeUsesHttps(plan) ? [caddyUnitName(node)] : [])].map(quote).join(" ")}`,
        { environment },
      ));
    },

    async remove(paths, environment = process.env) {
      const plan = await readJson(paths.plan);
      const runtime = settings(plan);
      await eachNode(plan.nodes, maxParallel, async (node) => {
        const unit = unitName(node);
        const caddyUnit = caddyUnitName(node);
        await remote(plan, node, [
          `sudo systemctl disable --now ${quote(unit)} ${quote(caddyUnit)} >/dev/null 2>&1 || true`,
          `sudo rm -f ${quote(`/etc/systemd/system/${unit}`)} ${quote(`/etc/systemd/system/${caddyUnit}`)} ${quote(`/etc/objydb/${node.id}.json`)} ${quote(`/etc/objydb/${node.id}.env`)} ${quote(caddyConfigPath(node))}`,
          `sudo rm -rf ${quote(caddyDataPath(node))}`,
          `sudo rm -rf ${quote(`${runtime.remoteDirectory}/${plan.deployment}`)}`,
          "sudo systemctl daemon-reload",
        ].join("; "), { environment });
      });
    },

    async status(paths, environment = process.env) {
      const plan = await readJson(paths.plan);
      return mapNodes(plan.nodes, maxParallel, async (node) => {
        try {
          const marker = "---OBJYDB-CADDY---";
          const { stdout } = await remote(
            plan,
            node,
            [
              `systemctl show ${quote(unitName(node))} --property=ActiveState,SubState,Result,NRestarts,ExecMainStatus`,
              ...(nodeUsesHttps(plan) ? [
                `printf '\n${marker}\n'`,
                `systemctl show ${quote(caddyUnitName(node))} --property=ActiveState,SubState,Result,NRestarts,ExecMainStatus`,
              ] : []),
            ].join("; "),
            { environment },
          );
          const [databaseSource, caddySource] = stdout.split(marker);
          const database = systemdStatus(node.id, nodeLabel(node), databaseSource);
          if (!nodeUsesHttps(plan)) return database;
          const edge = systemdStatus(node.id, `${nodeLabel(node)} HTTPS edge`, caddySource || "");
          return edge.state === "running" ? database : {
            ...database, state: edge.state, detail: `${database.detail}; ${edge.detail}`,
          };
        } catch (error) {
          return { nodeId: node.id, state: "offline", detail: `${nodeLabel(node)}: ${error.message}` };
        }
      });
    },

    async readLogs(paths, { node, tail = 200, environment = process.env } = {}) {
      const plan = await readJson(paths.plan);
      const selected = selectNodes(plan, node);
      const values = await mapNodes(selected, maxParallel, async (item) => {
        try {
          const units = [unitName(item), ...(nodeUsesHttps(plan) ? [caddyUnitName(item)] : [])];
          const { stdout, stderr } = await remote(
            plan,
            item,
            `journalctl ${units.map((unit) => `-u ${quote(unit)}`).join(" ")} -n ${Number(tail)} --no-pager -o short-iso`,
            { environment },
          );
          return selected.length > 1 ? `==> ${item.id} <==\n${stdout}${stderr}` : `${stdout}${stderr}`;
        } catch (error) {
          return `==> ${item.id} <==\n${error.message}\n`;
        }
      });
      return values.join("\n");
    },

    async followLogs(paths, { node, tail = 200, environment = process.env } = {}) {
      const plan = await readJson(paths.plan);
      await Promise.all(selectNodes(plan, node).map((item) => follow(
        plan,
        item,
        `journalctl ${[unitName(item), ...(nodeUsesHttps(plan) ? [caddyUnitName(item)] : [])]
          .map((unit) => `-u ${quote(unit)}`).join(" ")} -n ${Number(tail)} -f -o short-iso`,
        { environment },
      )));
    },
  };

  async function deployNode(plan, node, paths, archive, release, runtime, environment, progress, start) {
    const serviceUser = typeof runtime.serviceUser === "function" ? runtime.serviceUser(node) : runtime.serviceUser;
    const remoteRoot = `${runtime.remoteDirectory}/${plan.deployment}`;
    const remoteRelease = `${remoteRoot}/releases/${release}`;
    const stage = `/tmp/objydb-${plan.deployment}-${node.id}`;
    const remoteConfig = `/etc/objydb/${node.id}.json`;
    const remoteEnvironment = `/etc/objydb/${node.id}.env`;
    const unit = unitName(node);
    const caddyUnit = caddyUnitName(node);
    progress(`Preparing ${nodeLabel(node)}`);
    await remote(plan, node, `rm -rf ${quote(stage)}; mkdir -p ${quote(stage)}`, { environment });
    progress(`Uploading OBJY DB to ${nodeLabel(node)}`);
    await upload(plan, node, archive, `${stage}/release.tgz`, { environment });
    await upload(plan, node, paths.databaseConfig, `${stage}/objydb.json`, { environment });
    progress(`Installing OBJY DB dependencies on ${nodeLabel(node)}`);
    await remote(plan, node, [
      "set -eu",
      `sudo mkdir -p ${quote(remoteRelease)} /etc/objydb ${quote(runtime.walDirectory)}`,
      `sudo tar -xzf ${quote(`${stage}/release.tgz`)} -C ${quote(remoteRelease)}`,
      `sudo chown -R ${quote(serviceUser)} ${quote(remoteRelease)} ${quote(runtime.walDirectory)}`,
      `cd ${quote(remoteRelease)}`,
      "sudo -u " + quote(serviceUser) + " npm ci --omit=dev --ignore-scripts --no-audit --no-fund",
      `sudo install -m 644 ${quote(`${stage}/objydb.json`)} ${quote(remoteConfig)}`,
      `sudo ln -sfn ${quote(remoteRelease)} ${quote(`${remoteRoot}/current`)}`,
    ].join("; "), { environment });
    await remote(plan, node, `sudo tee ${quote(remoteEnvironment)} >/dev/null; sudo chmod 600 ${quote(remoteEnvironment)}`, {
      input: environmentFile(plan, environment), environment,
    });
    await remote(plan, node, `sudo tee ${quote(`/etc/systemd/system/${unit}`)} >/dev/null`, {
      input: systemdUnit(plan, node, runtime, serviceUser, remoteConfig, remoteEnvironment), environment,
    });
    if (nodeUsesHttps(plan)) {
      await remote(plan, node, `sudo mkdir -p ${quote(caddyDataPath(node))}; sudo chmod 700 ${quote(caddyDataPath(node))}; sudo chown -R caddy:caddy ${quote(caddyDataPath(node))}`, { environment });
      await remote(plan, node, `sudo tee ${quote(caddyConfigPath(node))} >/dev/null`, {
        input: renderCaddyfile({
          host: new URL(node.publicUrl).hostname,
          upstreams: [`127.0.0.1:${node.port}`],
        }),
        environment,
      });
      await remote(plan, node, `sudo tee ${quote(`/etc/systemd/system/${caddyUnit}`)} >/dev/null`, {
        input: caddySystemdUnit(node), environment,
      });
    } else if (manageHttps) {
      await remote(plan, node, [
        `sudo systemctl disable --now ${quote(caddyUnit)} >/dev/null 2>&1 || true`,
        `sudo rm -f ${quote(`/etc/systemd/system/${caddyUnit}`)} ${quote(caddyConfigPath(node))}`,
        `sudo rm -rf ${quote(caddyDataPath(node))}`,
      ].join("; "), { environment });
    }
    progress(`${start ? 'Starting' : 'Staging'} OBJY DB on ${nodeLabel(node)}`);
    await remote(plan, node, [
      "set -eu",
      "sudo systemctl daemon-reload",
      ...(start ? [`sudo systemctl enable ${quote(unit)}`, `sudo systemctl restart ${quote(unit)}`] : [`sudo systemctl disable ${quote(unit)}`]),
      ...(start && nodeUsesHttps(plan) ? [
        `sudo systemctl enable ${quote(caddyUnit)}`,
        `sudo systemctl restart ${quote(caddyUnit)}`,
      ] : []),
      `rm -rf ${quote(stage)}`,
    ].join("; "), { environment });
  }
}

function caddySystemdUnit(node) {
  const unit = unitName(node);
  const data = caddyDataPath(node);
  return `[Unit]
Description=OBJY DB HTTPS edge ${node.id}
After=network-online.target ${unit}
Wants=network-online.target
Requires=${unit}

[Service]
Type=notify
User=caddy
Group=caddy
Environment=XDG_DATA_HOME=${data}/data
Environment=XDG_CONFIG_HOME=${data}/config
ExecStart=/usr/bin/env caddy run --config ${caddyConfigPath(node)} --adapter caddyfile
TimeoutStopSec=5s
LimitNOFILE=1048576
AmbientCapabilities=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_ADMIN CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=full
ReadWritePaths=${data}

[Install]
WantedBy=multi-user.target
`;
}

function systemdUnit(plan, node, runtime, serviceUser, config, environment) {
  const current = `${runtime.remoteDirectory}/${plan.deployment}/current`;
  return `[Unit]
Description=OBJY DB ${node.id}
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=30
StartLimitBurst=5

[Service]
Type=simple
User=${serviceUser}
WorkingDirectory=${current}
EnvironmentFile=${environment}
ExecStart=/usr/bin/env node --max-old-space-size=${plan.runtime.heapMb} ${current}/${runtime.entrypoint} --config ${config} --node ${node.id} --url ${node.peerUrl} --port ${node.port}
Restart=always
RestartSec=2
TimeoutStopSec=90
SendSIGKILL=no
KillSignal=SIGTERM
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
`;
}

export function managedNodeRuntimeSetupCommand(serviceUser, { https = false } = {}) {
  return [
    "set -eu",
    "while sudo fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; do sleep 2; done",
    "if ! command -v node >/dev/null || ! node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) >= 22 ? 0 : 1)'; then sudo apt-get update -qq; sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq ca-certificates curl tar; curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/objydb-nodesource.sh; sudo -E bash /tmp/objydb-nodesource.sh >/dev/null; rm -f /tmp/objydb-nodesource.sh; sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs; fi",
    "command -v npm >/dev/null",
    "command -v tar >/dev/null",
    "command -v systemctl >/dev/null",
    "node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) >= 22 ? 0 : 1)'",
    `id -u ${serviceUser} >/dev/null 2>&1 || sudo useradd --system --home /var/lib/objydb --shell /usr/sbin/nologin ${serviceUser}`,
    "sudo mkdir -p /var/lib/objydb",
    `sudo chown ${serviceUser}:${serviceUser} /var/lib/objydb`,
    ...(https ? [caddySystemdSetupCommand()] : []),
  ].join("; ");
}

function systemdStatus(nodeId, label, output) {
  const values = Object.fromEntries(output.trim().split("\n").map((line) => {
    const separator = line.indexOf("=");
    return separator < 0 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
  }));
  const active = values.ActiveState || "unknown";
  const sub = values.SubState || "unknown";
  const result = values.Result || "unknown";
  const restarts = Number(values.NRestarts || 0);
  const exit = Number(values.ExecMainStatus || 0);
  let state = active === "active" ? "running" : active;
  if (active === "activating" && sub === "auto-restart") state = "restarting";
  if (active === "failed" || ["exit-code", "signal", "core-dump"].includes(result)) state = "failed";
  const facts = [sub];
  if (result !== "unknown" && result !== "success") facts.push(result);
  if (exit) facts.push(`exit ${exit}`);
  if (restarts) facts.push(`${restarts} restart${restarts === 1 ? "" : "s"}`);
  return { nodeId, state, detail: `${label}: ${state} (${facts.join(", ")})` };
}

function unitName(node) { return `objydb-${node.id}.service`; }
function caddyUnitName(node) { return `objydb-caddy-${node.id}.service`; }
function caddyConfigPath(node) { return `/etc/objydb/caddy-${node.id}.Caddyfile`; }
function caddyDataPath(node) { return `/var/lib/objydb/caddy/${node.id}`; }
function selectNodes(plan, node) { return node ? plan.nodes.filter(({ id }) => id === node) : plan.nodes; }
async function readJson(path) { return JSON.parse(await readFile(path, "utf8")); }
function safeSegment(value) { return String(value).replace(/[^a-zA-Z0-9._-]/g, "-"); }

async function eachNode(nodes, maximum, operation) {
  await mapNodes(nodes, maximum, operation);
}

async function mapNodes(values, maximum, operation) {
  const queue = values.map((value, index) => ({ value, index }));
  const results = new Array(queue.length);
  const workers = Array.from({ length: Math.min(maximum, queue.length) }, async () => {
    while (queue.length) {
      const { value, index } = queue.shift();
      results[index] = await operation(value);
    }
  });
  await Promise.all(workers);
  return results;
}
