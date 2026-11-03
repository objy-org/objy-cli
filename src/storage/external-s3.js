import { installationDataPrefix } from "../core/installation-identity.js";
import {
  S3_ACCESS_KEY_ENV,
  S3_SECRET_KEY_ENV,
  requiredString,
  s3StoragePlan,
} from "./common.js";

export function createExternalS3Driver() {
  return {
    id: "external-s3",
    label: "Existing S3",
    managed: false,
    description: "Use an existing AWS S3 or S3-compatible object store.",
    settingsKey: "externalS3",
    setupFields: fields(),
    configurationFields: fields(),
    secretFields: [
      { id: "accessKey", label: "S3 access key", environment: S3_ACCESS_KEY_ENV, referenceField: "accessKeyId", required: true },
      { id: "secretKey", label: "S3 secret key", environment: S3_SECRET_KEY_ENV, referenceField: "secretAccessKey", required: true },
    ],
    applySetup(manifest, value = {}) {
      manifest.storage = {
        driver: "external-s3",
        externalS3: {
          endpoint: requiredString(value.endpoint, "storage.endpoint"),
          region: requiredString(value.region, "storage.region"),
          bucket: requiredString(value.bucket, "storage.bucket"),
          prefix: installationDataPrefix(manifest.metadata.name),
          forcePathStyle: Boolean(value.forcePathStyle),
          accessKeyId: { fromEnvironment: S3_ACCESS_KEY_ENV },
          secretAccessKey: { fromEnvironment: S3_SECRET_KEY_ENV },
        },
      };
    },
    plan(manifest, targetPlan) {
      const settings = manifest.storage.externalS3;
      return s3StoragePlan("external-s3", settings, {
        runtimeEndpoint: runtimeEndpoint(settings.endpoint, targetPlan.driver),
      });
    },
    async configure(manifest, { output, question, text, boolean }) {
      output.write("\nObject storage\n");
      const current = manifest.storage?.externalS3 || {};
      this.applySetup(manifest, {
        endpoint: await text(question, "S3 endpoint", current.endpoint || "https://s3.example.com"),
        region: await text(question, "S3 region", current.region || "eu-central-1"),
        bucket: await text(question, "S3 bucket", current.bucket || "objydb"),
        forcePathStyle: await boolean(question, "Use path-style S3 URLs", Boolean(current.forcePathStyle)),
      });
    },
    async status(plan) {
      return {
        driver: "external-s3",
        managed: false,
        state: "external",
        detail: `${plan.persistence.endpoint}/${plan.persistence.bucket}`,
      };
    },
  };
}

function fields() {
  return [
    { id: "endpoint", label: "S3 endpoint", type: "url", required: true, placeholder: "https://s3.example.com" },
    { id: "region", label: "Region", required: true, defaultValue: "eu-central-1" },
    { id: "bucket", label: "Bucket", required: true, defaultValue: "objydb" },
    { id: "forcePathStyle", label: "Use path-style URLs", type: "checkbox", defaultValue: false },
  ];
}

function runtimeEndpoint(value, target) {
  if (target !== "docker") return value;
  const endpoint = new URL(value);
  if (!["localhost", "127.0.0.1", "::1", "[::1]"].includes(endpoint.hostname)) return value;
  endpoint.hostname = "host.docker.internal";
  return endpoint.toString().replace(/\/$/, "");
}
