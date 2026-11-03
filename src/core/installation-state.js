import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export function installationPaths(directory = ".objydb") {
  const root = resolve(directory);
  return {
    root,
    shardMap: join(root, "shard-map.json"),
    plan: join(root, "plan.json"),
    databaseConfig: join(root, "database.json"),
    state: join(root, "installation.json"),
    transition: join(root, "transition.json"),
  };
}

export async function loadInstallation(directory) {
  const paths = installationPaths(directory);
  try {
    const [state, plan] = await Promise.all([
      readJson(paths.state),
      readJson(paths.plan),
    ]);
    return { paths, state, plan };
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`OBJY DB is not installed in ${paths.root}`);
    throw error;
  }
}

export async function saveInstallation(directory, value) {
  const { state } = installationPaths(directory);
  await writeJson(state, value);
}

export async function loadTransition(directory) {
  const { transition } = installationPaths(directory);
  try {
    return await readJson(transition);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function saveTransition(directory, value) {
  const { transition } = installationPaths(directory);
  await writeJson(transition, value);
}

export async function clearTransition(directory) {
  await rm(installationPaths(directory).transition, { force: true });
}

export async function removeInstallation(directory) {
  await rm(installationPaths(directory).root, { recursive: true, force: true });
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
