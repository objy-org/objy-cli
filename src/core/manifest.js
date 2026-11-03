import { readFile, writeFile } from "node:fs/promises";

export const MANIFEST_API_VERSION = "objydb.io/v1";
export const MANIFEST_KIND = "Installation";

export async function loadManifest(path) {
  let source;
  try {
    source = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`configuration not found: ${path}`);
    throw error;
  }
  try {
    return normalizeManifest(JSON.parse(source));
  } catch (error) {
    throw new Error(`failed to read configuration ${path}: ${error.message}`);
  }
}

export async function writeSampleManifest(path, { force = false } = {}) {
  try {
    await writeFile(path, `${JSON.stringify(sampleManifest(), null, 2)}\n`, {
      encoding: "utf8", flag: force ? "w" : "wx", mode: 0o644,
    });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error(`configuration already exists: ${path}; use --force to replace it`);
    throw error;
  }
}

export function normalizeManifest(value) {
  const manifest = plainObject(value, "configuration");
  if (manifest.apiVersion !== MANIFEST_API_VERSION) throw new Error(`apiVersion must be ${MANIFEST_API_VERSION}`);
  if (manifest.kind !== MANIFEST_KIND) throw new Error(`kind must be ${MANIFEST_KIND}`);

  const metadata = plainObject(manifest.metadata, "metadata");
  const name = installationName(metadata.name);
  const installation = plainObject(manifest.installation, "installation");
  const topology = plainObject(installation.topology, "installation.topology");
  const shards = positiveInteger(topology.shards, "installation.topology.shards");
  const replicas = positiveInteger(topology.replicas, "installation.topology.replicas");
  if (shards * replicas > 1024) throw new Error("topology may contain at most 1024 nodes");
  const runtime = plainObject(installation.runtime, "installation.runtime");
  const heapMb = positiveInteger(runtime.heapMb, "installation.runtime.heapMb");
  if (heapMb < 512) throw new Error("installation.runtime.heapMb must be at least 512");
  const publicConfig = plainObject(installation.public, "installation.public");
  const protocol = accessProtocol(publicConfig.protocol);
  const basePort = port(publicConfig.basePort, "installation.public.basePort");
  if (basePort + shards * replicas - 1 > 65535) throw new Error("public port range exceeds 65535");

  const database = normalizeDatabaseConfig(manifest.database);
  const storage = normalizeStorageConfig(manifest.storage, database);
  stripDerivedStorageConfig(database);
  const target = plainObject(manifest.target, "target");
  const driver = requiredString(target.driver, "target.driver");
  const targetSettings = structuredClone(target);
  delete targetSettings.driver;

  return {
    apiVersion: MANIFEST_API_VERSION,
    kind: MANIFEST_KIND,
    metadata: { name },
    installation: {
      version: requiredString(installation.version, "installation.version"),
      artifact: requiredString(installation.artifact, "installation.artifact"),
      topology: { shards, replicas },
      runtime: { heapMb },
      public: { protocol, bindAddress: optionalString(publicConfig.bindAddress, "0.0.0.0"), basePort },
    },
    storage,
    database,
    target: { driver, ...targetSettings },
  };
}

export function sampleManifest() {
  const prefix = "objydb/production";
  return {
    apiVersion: MANIFEST_API_VERSION,
    kind: MANIFEST_KIND,
    metadata: { name: "objydb" },
    installation: {
      version: "0.1.0",
      artifact: "objydb/server:0.1.0",
      topology: { shards: 1, replicas: 1 },
      runtime: { heapMb: 4096 },
      public: { protocol: "http", bindAddress: "0.0.0.0", basePort: 8080 },
    },
    storage: {
      driver: "external-s3",
      externalS3: {
        bucket: "objydb",
        endpoint: "https://s3.example.com",
        region: "eu-central-1",
        prefix,
        accessKeyId: { fromEnvironment: "OBJYDB_S3_ACCESS_KEY" },
        secretAccessKey: { fromEnvironment: "OBJYDB_S3_SECRET_KEY" },
        forcePathStyle: false,
      },
    },
    database: {
      node: { retainOps: 256, syncBatchSize: 50_000 },
      server: { port: 8080, maxJsonBytes: 67_108_864, cors: false },
      imports: {
        maxBulkObjects: 10_000,
        maxBulkBytes: 67_108_864,
        maxObjectBytes: 8_388_608,
        maxPendingPersistenceBytes: 268_435_456,
        retryAfterMs: 1000,
      },
      plugins: [],
      storage: { engine: "object" },
      files: { mode: "s3" },
      memoryGuard: { enabled: true, rejectWritesPercent: 85, resumeWritesPercent: 78, checkMs: 1000 },
      cluster: {
        syncMs: 2500,
        forwardTimeoutMs: 60_000,
        replicationTimeoutMs: 60_000,
        secret: { fromEnvironment: "OBJYDB_CLUSTER_SECRET" },
        hints: { enabled: true, debounceMs: 25, maxScopesPerHint: 128 },
        shardMapStore: { mode: "s3", key: "cluster/shard-map.json" },
      },
      auth: {
        jwtSecret: { fromEnvironment: "OBJYDB_JWT_SECRET" },
        accessTokenTtlSeconds: 3600,
        refreshTokenTtlSeconds: 1_209_600,
        users: [{
          _id: "admin", username: "admin",
          password: { fromEnvironment: "OBJYDB_ADMIN_PASSWORD" },
          role: "admin", admin: true,
        }],
      },
      persistence: {
        mode: "s3", flushMs: 5000, opBatchSize: 10_000,
        journalMaxBytes: 4_194_304, snapshotMs: 3_600_000,
        segmentBytes: 16_777_216, compactJournals: true,
        snapshotDirtyOnly: true, snapshotRole: "primary",
        snapshotRetention: { keepLatest: 5 }, restoreMode: "scoped",
        ack: "localWal",
        localWal: { mode: "on", dir: "/var/lib/objydb/wal", fsync: true, flushMs: 5000 },
      },
    },
    target: { driver: "docker", docker: { projectName: "objydb" } },
  };
}

function normalizeDatabaseConfig(value) {
  const database = structuredClone(plainObject(value, "database"));
  const persistence = plainObject(database.persistence, "database.persistence");
  const cluster = plainObject(database.cluster, "database.cluster");
  cluster.secret = secretReference(cluster.secret, "database.cluster.secret");
  const auth = plainObject(database.auth, "database.auth");
  auth.jwtSecret = secretReference(auth.jwtSecret, "database.auth.jwtSecret");
  if (!Array.isArray(auth.users) || auth.users.length === 0) throw new Error("database.auth.users must contain at least one user");
  auth.users = auth.users.map((user, index) => {
    const normalized = structuredClone(plainObject(user, `database.auth.users[${index}]`));
    normalized.password = secretReference(normalized.password, `database.auth.users[${index}].password`);
    return normalized;
  });
  return database;
}

function normalizeStorageConfig(value, database) {
  if (value !== undefined) {
    const storage = structuredClone(plainObject(value, "storage"));
    storage.driver = requiredString(storage.driver, "storage.driver");
    return storage;
  }

  const persistence = plainObject(database.persistence, "database.persistence");
  const s3 = plainObject(persistence.s3, "database.persistence.s3");
  const prefix = cleanPrefix(requiredString(persistence.prefix, "database.persistence.prefix"));
  return {
    driver: "external-s3",
    externalS3: {
      bucket: requiredString(s3.bucket, "database.persistence.s3.bucket"),
      endpoint: requiredString(s3.endpoint, "database.persistence.s3.endpoint"),
      region: requiredString(s3.region, "database.persistence.s3.region"),
      prefix,
      accessKeyId: secretReference(s3.accessKeyId, "database.persistence.s3.accessKeyId"),
      secretAccessKey: secretReference(s3.secretAccessKey, "database.persistence.s3.secretAccessKey"),
      forcePathStyle: Boolean(s3.forcePathStyle),
    },
  };
}

function stripDerivedStorageConfig(database) {
  delete database.persistence.s3;
  delete database.persistence.prefix;
  delete database.cluster?.shardMapStore?.prefix;
  delete database.files?.prefix;
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}
function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}
function optionalString(value, fallback) { return typeof value === "string" && value.trim() ? value.trim() : fallback; }
function positiveInteger(value, label) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}
function port(value, label) {
  const result = positiveInteger(value, label);
  if (result > 65535) throw new Error(`${label} must be at most 65535`);
  return result;
}
function accessProtocol(value) {
  const protocol = value === undefined ? "http" : requiredString(value, "installation.public.protocol").toLowerCase();
  if (!["http", "https"].includes(protocol)) throw new Error("installation.public.protocol must be http or https");
  return protocol;
}
function installationName(value) {
  const name = requiredString(value, "installation name").toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(name)) throw new Error("installation name must contain lowercase letters, numbers, and internal hyphens");
  return name;
}
function cleanPrefix(value) {
  const prefix = value.replace(/^\/+|\/+$/g, "");
  if (!prefix) throw new Error("database.persistence.prefix must not be empty");
  return prefix;
}
function secretReference(value, label) {
  const reference = plainObject(value, label);
  const fromEnvironment = requiredString(reference.fromEnvironment, `${label}.fromEnvironment`);
  if (!/^[A-Z_][A-Z0-9_]*$/.test(fromEnvironment)) throw new Error(`${label}.fromEnvironment must be an environment variable name`);
  return { fromEnvironment };
}
