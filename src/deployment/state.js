import { chmod, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function cliHome(environment = process.env) {
  return resolve(environment.OBJY_HOME || join(homedir(), '.objy'));
}

export async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}
