import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const INSTALLATION_ROOT = join(homedir(), ".objydb", "installations");

export function createInstallationId() {
  return `odb-${randomBytes(6).toString("hex")}`;
}

export function installationLocation(id, root = INSTALLATION_ROOT) {
  const name = installationId(id);
  const directory = resolve(root, name);
  return {
    id: name,
    directory,
    configPath: join(directory, "objydb.json"),
    stateDirectory: join(directory, "state"),
  };
}

export function installationDataPrefix(id) {
  return `objydb/installations/${resourceId(id)}`;
}

export function installationBucketName(id) {
  return `objydb-${resourceId(id)}`;
}

function installationId(value) {
  if (typeof value !== "string" || !/^odb-[a-f0-9]{12}$/.test(value)) {
    throw new Error("installation id is invalid");
  }
  return value;
}

function resourceId(value) {
  if (typeof value !== "string" || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error("installation resource id is invalid");
  }
  return value;
}
