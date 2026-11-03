import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

export async function renderDeployment(plan, {
  outputDirectory = ".objydb",
  force = false,
  targetFiles = [],
  databaseConfig = plan.database,
} = {}) {
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const files = {
    shardMap: join(output, "shard-map.json"),
    plan: join(output, "plan.json"),
    databaseConfig: join(output, "database.json"),
  };
  for (const file of targetFiles) {
    if (!file.key || !file.name || file.name !== file.name.split(/[\\/]/).pop()) {
      throw new Error("target render files require a safe key and file name");
    }
    files[file.key] = join(output, file.name);
  }
  if (!force) {
    for (const path of Object.values(files)) {
      if (await exists(path)) throw new Error(`generated file already exists: ${path}; use --force to replace it`);
    }
  }

  for (const file of targetFiles) {
    await atomicWrite(files[file.key], file.content, file.mode ?? 0o644);
  }
  await atomicWrite(files.databaseConfig, `${JSON.stringify(databaseConfig, null, 2)}\n`, 0o600);
  await atomicWrite(files.shardMap, `${JSON.stringify(plan.shardMap, null, 2)}\n`, 0o600);
  await atomicWrite(files.plan, `${JSON.stringify(publicPlan(plan), null, 2)}\n`, 0o600);
  return files;
}

function publicPlan(plan) {
  return plan;
}

async function atomicWrite(path, content, mode) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode });
  await rename(temporary, path);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
