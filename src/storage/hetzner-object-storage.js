import { installationBucketName } from "../core/installation-identity.js";
import { S3_ACCESS_KEY_ENV, S3_SECRET_KEY_ENV, requiredString, s3StoragePlan } from "./common.js";
import { waitForS3Bucket } from "./s3-access.js";

const LOCATIONS = ["fsn1", "nbg1", "hel1"];
const PROJECTS_URL = "https://console.hetzner.com/projects";
const CREDENTIALS_GUIDE_URL = "https://docs.hetzner.com/storage/object-storage/getting-started/generating-s3-keys/";

export function createHetznerObjectStorageDriver({ ensureAccess = waitForS3Bucket } = {}) {
  return {
    id: "hetzner-object-storage",
    label: "Hetzner Object Storage",
    managed: true,
    description: "Create and use a private S3-compatible bucket in Hetzner Object Storage.",
    compatibleTargets: ["hetzner"],
    settingsKey: "hetznerObjectStorage",
    setupFields: fields(),
    configurationFields: fields(),
    secretActions: [
      { label: "Create S3 credentials", url: PROJECTS_URL },
      { label: "Credential instructions", url: CREDENTIALS_GUIDE_URL },
    ],
    secretFields: [
      { id: "accessKey", label: "S3 access key", environment: S3_ACCESS_KEY_ENV, referenceField: "accessKeyId", required: true },
      { id: "secretKey", label: "S3 secret key", environment: S3_SECRET_KEY_ENV, referenceField: "secretAccessKey", required: true },
    ],
    applySetup(manifest, value = {}) {
      const location = locationName(value.location);
      manifest.storage = {
        driver: "hetzner-object-storage",
        hetznerObjectStorage: {
          location,
          bucket: installationBucketName(manifest.metadata.name),
          prefix: "data",
          accessKeyId: { fromEnvironment: S3_ACCESS_KEY_ENV },
          secretAccessKey: { fromEnvironment: S3_SECRET_KEY_ENV },
        },
      };
    },
    plan(manifest) {
      const settings = manifest.storage.hetznerObjectStorage;
      const location = locationName(settings.location);
      return s3StoragePlan("hetzner-object-storage", {
        endpoint: `https://${location}.your-objectstorage.com`,
        region: location,
        bucket: settings.bucket,
        prefix: settings.prefix,
        forcePathStyle: true,
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      }, { managed: true });
    },
    async configure(manifest, { output, question, text }) {
      output.write("\nHetzner Object Storage\n");
      const current = manifest.storage?.hetznerObjectStorage || {};
      this.applySetup(manifest, {
        location: await text(question, "Object Storage location", current.location || "fsn1"),
      });
    },
    async provision(plan, _paths, { environment }) {
      await ensureAccess(plan, environment, { create: true });
      return {};
    },
    async status(plan, _paths, { environment = process.env } = {}) {
      try {
        await ensureAccess(plan, environment, { timeoutMs: 5000 });
        return { driver: "hetzner-object-storage", managed: true, state: "ready", detail: plan.persistence.bucket };
      } catch (error) {
        return { driver: "hetzner-object-storage", managed: true, state: "unavailable", detail: error.message };
      }
    },
  };
}

function fields() {
  return [
    {
      id: "location", label: "Storage location", type: "select", required: true, defaultValue: "fsn1",
      options: [
        { value: "fsn1", label: "Falkenstein (fsn1)" },
        { value: "nbg1", label: "Nuremberg (nbg1)" },
        { value: "hel1", label: "Helsinki (hel1)" },
      ],
    },
  ];
}

function locationName(value) {
  const location = requiredString(value, "storage.hetznerObjectStorage.location");
  if (!LOCATIONS.includes(location)) throw new Error(`unsupported Hetzner Object Storage location: ${location}`);
  return location;
}
