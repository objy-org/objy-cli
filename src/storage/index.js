import { createDockerMinioDriver } from "./docker-minio.js";
import { createExternalS3Driver } from "./external-s3.js";
import { createHetznerObjectStorageDriver } from "./hetzner-object-storage.js";
import { createLocalS3Driver } from './local-s3.js';

export function createDefaultStorageDrivers() {
  const drivers = [
    createExternalS3Driver(), createDockerMinioDriver(), createLocalS3Driver(), createHetznerObjectStorageDriver(),
  ];
  return Object.fromEntries(drivers.map((driver) => [driver.id, driver]));
}

export function storageDescriptors(drivers = createDefaultStorageDrivers()) {
  return Object.values(drivers).map(({
    id, label, description, compatibleTargets, settingsKey, managed = false,
    setupFields = [], configurationFields = [], secretFields = [], secretActions = [],
  }) => ({
    id,
    label: label || id,
    description: description || "",
    managed,
    compatibleTargets: structuredClone(compatibleTargets || []),
    settingsKey,
    setupFields: structuredClone(setupFields),
    configurationFields: structuredClone(configurationFields),
    secretFields: structuredClone(secretFields),
    secretActions: structuredClone(secretActions),
  }));
}

export function createDesiredPlan(manifest, {
  targetDrivers,
  storageDrivers,
  shardRevision,
} = {}) {
  const targetDriver = targetDrivers?.[manifest.target.driver];
  if (!targetDriver?.plan) throw new Error(`target driver is not installed: ${manifest.target.driver}`);
  const storageDriver = storageDrivers?.[manifest.storage.driver];
  if (!storageDriver?.plan) throw new Error(`storage driver is not installed: ${manifest.storage.driver}`);
  if (storageDriver.compatibleTargets?.length && !storageDriver.compatibleTargets.includes(manifest.target.driver)) {
    throw new Error(`${storageDriver.label || storageDriver.id} storage is not compatible with ${manifest.target.driver}`);
  }

  const plan = targetDriver.plan(manifest, { shardRevision });
  const storage = storageDriver.plan(manifest, plan);
  plan.storage = storage;
  plan.persistence = {
    mode: "s3",
    endpoint: storage.endpoint,
    region: storage.region,
    bucket: storage.bucket,
    prefix: storage.prefix,
    forcePathStyle: storage.forcePathStyle,
    credentials: structuredClone(storage.credentials),
  };
  plan.database.persistence.prefix = storage.prefix;
  plan.database.persistence.s3 = {
    bucket: storage.bucket,
    endpoint: storage.runtimeEndpoint,
    region: storage.region,
    accessKeyId: structuredClone(storage.credentials.accessKeyId),
    secretAccessKey: structuredClone(storage.credentials.secretAccessKey),
    forcePathStyle: storage.forcePathStyle,
  };
  plan.database.cluster.shardMapStore.prefix = storage.prefix;
  plan.database.files.prefix = `${storage.prefix}/files`;
  return plan;
}
