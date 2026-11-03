import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && arguments.length > 1) return fallback; throw error; }
}
export async function writeJson(path, value) {
  return writePrivateFile(path, JSON.stringify(value, null, 2) + '\n');
}
export async function writePrivateFile(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(value); await file.sync(); }
  finally { await file.close(); }
  await rename(temporary, path);
  const parent = await open(dirname(path), 'r');
  try { await parent.sync(); } finally { await parent.close(); }
}
export function redact(message, secrets) {
  let text = String(message);
  for (const value of Object.values(secrets).filter(v => typeof v === 'string' && v.length).sort((a, b) => b.length - a.length)) {
    text = text.split(value).join('[redacted]');
    text = text.split(JSON.stringify(value).slice(1, -1)).join('[redacted]');
  }
  return text.slice(-5000);
}
