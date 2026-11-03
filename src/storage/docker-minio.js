import { randomBytes } from "node:crypto";
import { installationDataPrefix } from "../core/installation-identity.js";
import { assertPortAvailable } from "../core/ports.js";
import { S3_ACCESS_KEY_ENV, S3_SECRET_KEY_ENV, optionalString, port, s3StoragePlan } from "./common.js";
import { waitForS3Bucket } from "./s3-access.js";

const SERVICE = "objydb-minio";
const ACTIONS = ["start", "stop", "restart"];

export function createDockerMinioDriver({ ensureBucket = (plan, environment) => waitForS3Bucket(plan, environment, { create: true }) } = {}) {
  return {
    id: "docker-minio",
    label: "Bundled MinIO",
    managed: true,
    description: "Run a persistent MinIO object store beside OBJY DB with Docker Compose.",
    compatibleTargets: ["docker"],
    settingsKey: "dockerMinio",
    setupFields: [],
    configurationFields: [
      {
        id: "apiPort", label: "Host API port", type: "number", required: true, min: 1, max: 65_535,
        description: "Host access to MinIO. Database nodes use port 9000 inside Docker.",
      },
      {
        id: "consolePort", label: "Host console port", type: "number", required: true, min: 1, max: 65_535,
        description: "Browser access to the MinIO console. MinIO uses port 9001 inside Docker.",
      },
    ],
    secretFields: [
      { id: "accessKey", environment: S3_ACCESS_KEY_ENV, referenceField: "accessKeyId", generated: true },
      { id: "secretKey", environment: S3_SECRET_KEY_ENV, referenceField: "secretAccessKey", generated: true },
    ],
    localPorts(manifest) {
      const settings = manifest.storage.dockerMinio;
      return {
        count: 2,
        current: settings.apiPort,
        host: "127.0.0.1",
        assign(first) {
          settings.apiPort = first;
          settings.consolePort = first + 1;
        },
      };
    },
    applySetup(manifest, value = {}) {
      manifest.storage = {
        driver: "docker-minio",
        dockerMinio: {
          bucket: "objydb",
          prefix: installationDataPrefix(manifest.metadata.name),
          apiPort: Number(value.apiPort || 9000),
          consolePort: Number(value.consolePort || 9001),
          image: optionalString(value.image, "minio/minio:latest"),
          accessKeyId: { fromEnvironment: S3_ACCESS_KEY_ENV },
          secretAccessKey: { fromEnvironment: S3_SECRET_KEY_ENV },
        },
      };
    },
    plan(manifest, targetPlan) {
      if (targetPlan.driver !== "docker") throw new Error("docker-minio storage requires the Docker target");
      const settings = normalize(manifest.storage.dockerMinio);
      return s3StoragePlan("docker-minio", {
        endpoint: `http://127.0.0.1:${settings.apiPort}`,
        region: "us-east-1",
        bucket: settings.bucket,
        prefix: settings.prefix,
        forcePathStyle: true,
        accessKeyId: settings.accessKeyId,
        secretAccessKey: settings.secretAccessKey,
      }, {
        managed: true,
        runtimeEndpoint: `http://${SERVICE}:9000`,
        targetExtensions: { docker: composeExtension(settings) },
      });
    },
    async configure(manifest) {
      this.applySetup(manifest);
    },
    async ensureSecrets(plan, { environment }) {
      const generated = {};
      const accessName = plan.persistence.credentials.accessKeyId.fromEnvironment;
      const secretName = plan.persistence.credentials.secretAccessKey.fromEnvironment;
      if (!environment[accessName]) generated[accessName] = `objydb-${randomBytes(6).toString("hex")}`;
      if (!environment[secretName]) generated[secretName] = randomBytes(32).toString("base64url");
      return generated;
    },
    async preflight(plan) {
      const settings = plan.storage.targetExtensions.docker.services[SERVICE];
      for (const mapping of settings.ports) {
        const [, hostPort] = mapping.split(":");
        await assertPortAvailable("127.0.0.1", Number(hostPort));
      }
    },
    async provision(plan, paths, { targetDriver, environment }) {
      await startService(plan, paths, targetDriver, environment);
    },
    async start(plan, paths, { targetDriver, environment }) {
      await startService(plan, paths, targetDriver, environment);
    },
    async stop(_plan, paths, { targetDriver }) {
      assertServiceControl(targetDriver, "stopServices");
      await targetDriver.stopServices(paths, [SERVICE]);
    },
    async restart(plan, paths, { targetDriver, environment }) {
      assertServiceControl(targetDriver, "restartServices");
      await targetDriver.restartServices(paths, [SERVICE], { environment });
      await ensureBucket(plan, environment);
    },
    async status(plan, paths, { targetDriver, environment }) {
      const services = await targetDriver.serviceStatus?.(paths, [SERVICE], { environment }) || [];
      const service = services[0];
      return {
        driver: "docker-minio", managed: true, state: service?.state || "unknown",
        detail: service?.detail || null, actions: ACTIONS,
      };
    },
  };

  async function startService(plan, paths, targetDriver, environment) {
    assertServiceControl(targetDriver, "startServices");
    await targetDriver.startServices(paths, [SERVICE], { environment });
    await ensureBucket(plan, environment);
  }
}

function assertServiceControl(targetDriver, method) {
  if (typeof targetDriver[method] !== "function") {
    throw new Error(`Docker target does not support managed storage ${method.replace("Services", "")}`);
  }
}

function normalize(value = {}) {
  const apiPort = port(value.apiPort, "storage.dockerMinio.apiPort", 9000);
  const consolePort = port(value.consolePort, "storage.dockerMinio.consolePort", 9001);
  if (apiPort === consolePort) throw new Error("MinIO API and console ports must differ");
  return {
    bucket: optionalString(value.bucket, "objydb"),
    prefix: optionalString(value.prefix, "objydb/production"),
    apiPort,
    consolePort,
    image: optionalString(value.image, "minio/minio:latest"),
    accessKeyId: value.accessKeyId,
    secretAccessKey: value.secretAccessKey,
  };
}

function composeExtension(settings) {
  return {
    services: {
      [SERVICE]: {
        image: settings.image,
        restart: "unless-stopped",
        command: ["server", "/data", "--console-address", ":9001"],
        ports: [
          `127.0.0.1:${settings.apiPort}:9000`,
          `127.0.0.1:${settings.consolePort}:9001`,
        ],
        volumes: ["objydb-minio-data:/data"],
        environment: [
          `MINIO_ROOT_USER=$${S3_ACCESS_KEY_ENV}`,
          `MINIO_ROOT_PASSWORD=$${S3_SECRET_KEY_ENV}`,
        ],
        networks: ["objydb"],
      },
    },
    volumes: { "objydb-minio-data": {} },
  };
}
