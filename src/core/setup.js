import { normalizeManifest, sampleManifest } from "./manifest.js";

const PRESETS = [
  {
    id: "development",
    label: "Development",
    description: "One lightweight node for local evaluation.",
    topology: { shards: 1, replicas: 1 },
    heapMb: 2048,
  },
  {
    id: "production",
    label: "Small production",
    description: "One shard with a second copy for availability.",
    topology: { shards: 1, replicas: 2 },
    heapMb: 4096,
  },
  {
    id: "scalable",
    label: "Scalable",
    description: "Two replicated shards for larger workloads.",
    topology: { shards: 2, replicas: 2 },
    heapMb: 8192,
  },
  {
    id: "custom",
    label: "Custom",
    description: "Choose the topology and memory explicitly.",
    topology: { shards: 1, replicas: 1 },
    heapMb: 4096,
    custom: true,
  },
];

export function installationPresets() {
  return structuredClone(PRESETS);
}

export function createInstallationManifest(setup, { driver, storageDriver } = {}) {
  if (!driver?.id) throw new Error("installation target driver is required");
  if (!storageDriver?.id) throw new Error("installation storage driver is required");
  const input = object(setup, "setup");
  if (input.target !== driver.id) throw new Error(`setup target must be ${driver.id}`);
  const preset = PRESETS.find(({ id }) => id === input.preset);
  if (!preset) throw new Error(`unknown installation preset: ${input.preset || "missing"}`);

  const manifest = sampleManifest();
  const name = requiredString(input.id, "installation id");
  const storage = object(input.storage, "storage");
  if (storage.driver !== storageDriver.id) throw new Error(`setup storage must be ${storageDriver.id}`);
  const admin = object(input.admin, "admin");
  const custom = input.custom === undefined ? {} : object(input.custom, "custom");

  manifest.metadata.name = name;
  manifest.installation.topology = preset.custom
    ? { shards: integer(custom.shards, "custom.shards"), replicas: integer(custom.replicas, "custom.replicas") }
    : structuredClone(preset.topology);
  manifest.installation.runtime.heapMb = preset.custom
    ? integer(custom.heapMb, "custom.heapMb")
    : preset.heapMb;
  manifest.installation.public.protocol = accessProtocol(input.protocol);
  manifest.installation.public.bindAddress = optionalString(input.bindAddress, "0.0.0.0", "bindAddress");
  manifest.installation.public.basePort = optionalInteger(input.basePort, 8080, "basePort");

  storageDriver.applySetup?.(manifest, object(storage.settings || {}, "storage.settings"));
  manifest.database.auth.users[0].username = "admin";
  manifest.target = { driver: driver.id };
  driver.applySetup?.(manifest, object(input.targetSettings || {}, "targetSettings"));

  return normalizeManifest(manifest);
}

function object(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function integer(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

function optionalInteger(value, fallback, label) {
  return value === undefined || value === null || value === "" ? fallback : integer(value, label);
}

function optionalString(value, fallback, label) {
  if (value === undefined || value === null || value === "") return fallback;
  return requiredString(value, label);
}

function accessProtocol(value) {
  const protocol = optionalString(value, "http", "protocol").toLowerCase();
  if (!["http", "https"].includes(protocol)) throw new Error("protocol must be http or https");
  return protocol;
}
