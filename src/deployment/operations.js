import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { processExists } from '../core/process.js';
import { readJson } from './files.js';

export function conflict(message) { return Object.assign(new Error(message), { statusCode: 409 }); }
export function digest(value) { return createHash('sha256').update(JSON.stringify(value, (_key, v) =>
  v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v)).digest('hex'); }
export function installationId(id) {
  if (!/^odb-[a-f0-9]{12}$/.test(id)) throw new Error('Invalid installation ID');
  return id;
}
export function operationId(id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid operation ID');
  return id;
}
export async function acquireLock(path, token = randomUUID(), retry = true) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { await writeFile(path, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (retry) {
      const recovery = `${path}.recovery`;
      let held = false;
      try {
        await writeFile(recovery, token, { flag: 'wx', mode: 0o600 }); held = true;
        const lock = await readJson(path, null);
        if (lock && !processExists(lock.pid)) {
          await rm(path, { force: true });
          return await acquireLock(path, token, false);
        }
      } catch (e) { if (e.code !== 'EEXIST') throw e; }
      finally { if (held) await rm(recovery, { force: true }); }
    }
    throw conflict('An operation is already running for this cluster');
  }
  return token;
}
export async function releaseLock(path, token) {
  if ((await readJson(path, null))?.token === token) await rm(path, { force: true });
}
export async function withLock(path, fn) {
  const token = await acquireLock(path);
  try { return await fn(); } finally { await releaseLock(path, token); }
}
export async function lockActive(path) {
  const lock = await readJson(path, null);
  return Boolean(lock && processExists(lock.pid));
}
