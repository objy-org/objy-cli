import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readJson, writeJson } from './files.js';

// Release files only: never upload the developer's configs, credentials or data.
const releaseFiles = ['package.json', 'package-lock.json', 'Dockerfile', '.dockerignore', 'src', 'bin', 'client', 'plugins', 'public', 'API.md', 'LICENSE'];
export async function verifyServerSnapshot(directory) {
  const metadata = await readJson(join(directory, 'server-source.json'));
  const hash = createHash('sha256');
  async function collect(name) {
    const entry = (await readdir(dirname(join(directory, name)), { withFileTypes: true })).find(e => e.name === name.split('/').at(-1));
    if (!entry) return;
    if (entry.isSymbolicLink()) throw new Error('The saved server release contains a symbolic link');
    if (entry.isDirectory()) for (const child of (await readdir(join(directory, name))).sort()) await collect(`${name}/${child}`);
    else if (entry.isFile()) hash.update(name).update('\0').update(await readFile(join(directory, name))).update('\0');
  }
  for (const name of releaseFiles) await collect(name);
  if (hash.digest('hex') !== metadata.digest) throw new Error('The pinned server release changed. Restore its original files before continuing.');
  return metadata;
}
export async function snapshotServer(source, destination) {
  if (await readJson(join(destination, 'server-source.json'), null)) return destination;
  await access(join(source, 'src/index.js'));
  const staged = `${destination}.${randomUUID()}.tmp`;
  const hash = createHash('sha256');
  await mkdir(staged, { recursive: true, mode: 0o700 });
  async function copy(name) {
    const entries = await readdir(dirname(join(source, name)), { withFileTypes: true });
    const entry = entries.find(e => e.name === name.split('/').at(-1));
    if (!entry) return;
    if (entry.isSymbolicLink()) throw new Error(`Server release files cannot be symbolic links: ${name}`);
    if (entry.isDirectory()) {
      for (const child of (await readdir(join(source, name))).sort()) await copy(`${name}/${child}`);
    } else if (entry.isFile()) {
      const content = await readFile(join(source, name));
      hash.update(name).update('\0').update(content).update('\0');
      await mkdir(dirname(join(staged, name)), { recursive: true, mode: 0o700 });
      const mode = (await stat(join(source, name))).mode & 0o111 ? 0o755 : 0o644;
      await writeFile(join(staged, name), content, { mode });
    }
  }
  for (const name of releaseFiles) await copy(name);
  const manifest = await readJson(join(staged, 'package.json'));
  await writeJson(join(staged, 'server-source.json'), { path: source, version: manifest.version, digest: hash.digest('hex'), capturedAt: new Date().toISOString() });
  await rename(staged, destination);
  return destination;
}
