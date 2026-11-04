import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { runProcess } from './core/process.js';
import { readJson, writeJson } from './deployment/files.js';
import { withLock } from './deployment/operations.js';
import { snapshotServer, verifyServerSnapshot } from './deployment/server-bundle.js';

const maxBytes = 128 * 1024 * 1024;
const repository = 'objy-org/objy';
const releaseFiles = new Set(['src', 'public', 'client', 'plugins', 'package.json', 'package-lock.json', 'LICENSE', 'API.md']);

export function validateRelease(value) {
  if (!value || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(value.version || '')
    || !/^[a-f0-9]{64}$/.test(value.sha256 || '') || value.entrypoint !== 'src/index.js'
    || value.nodeMajor !== 22) throw new Error('Invalid release manifest. This version supports releases targeting Node.js 22.');
  const url = new URL(value.url);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('Release downloads require an HTTPS URL without credentials');
  return { version: value.version, url: url.href, sha256: value.sha256, entrypoint: value.entrypoint, nodeMajor: value.nodeMajor };
}

async function latestSource(fetchImpl) {
  const api = path => fetchImpl(`https://api.github.com/repos/${repository}/${path}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'objy-cli' }, signal: AbortSignal.timeout(30000),
  });
  let response = await api('releases/latest'), release;
  if (response.status === 404) {
    response = await api('releases?per_page=100');
    if (!response.ok) throw new Error(`Cannot find the latest server release (HTTP ${response.status}). Try deploying again later.`);
    const releases = await response.json();
    if (!Array.isArray(releases)) throw new Error('Invalid server release response');
    const published = releases.filter(item => !item.draft && item.published_at).sort((a, b) => Date.parse(b.published_at) - Date.parse(a.published_at));
    release = published.find(item => !item.prerelease) || published[0];
  } else {
    if (!response.ok) throw new Error(`Cannot find the latest server release (HTTP ${response.status}). Try deploying again later.`);
    release = await response.json();
  }
  if (!release || release.draft || typeof release.tag_name !== 'string' || !release.tag_name) throw new Error('No published Objy server release is available yet.');
  response = await api(`commits/${encodeURIComponent(release.tag_name)}`);
  if (!response.ok) throw new Error(`Cannot resolve the latest server release (HTTP ${response.status}). Try deploying again later.`);
  const { sha } = await response.json();
  if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('Invalid server release commit');
  return { commit: sha, version: release.tag_name, url: `https://codeload.github.com/${repository}/tar.gz/${sha}`, entrypoint: 'src/index.js', nodeMajor: 22 };
}

async function downloadRelease(fetchImpl, url) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(120000), redirect: 'follow' });
  if (!response.ok) throw new Error(`Server download failed (HTTP ${response.status})`);
  if (response.url && !response.url.startsWith('https:')) throw new Error('Release download redirected away from HTTPS');
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) throw new Error('Server archive exceeds the download limit');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function withReleaseLock(path, operation) {
  const deadline = Date.now() + 180000;
  while (true) {
    let acquired = false;
    try { return await withLock(path, () => { acquired = true; return operation(); }); }
    catch (error) {
      if (acquired || error.statusCode !== 409 || Date.now() >= deadline) throw error;
      await delay(100);
    }
  }
}

// Extract only regular release files. No shell, links, device entries or path traversal.
export async function extractRelease(archive, destination) {
  const tar = gunzipSync(archive, { maxOutputLength: maxBytes });
  const written = new Set();
  let root;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const string = (start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0];
    const expected = parseInt(string(148, 8).trim(), 8);
    const checksum = header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0);
    if (checksum !== expected) throw new Error('Invalid release archive checksum');
    const size = parseInt(string(124, 12).trim() || '0', 8);
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid release archive length');
    const type = string(156, 1);
    const name = [string(345, 155), string(0, 100)].filter(Boolean).join('/').replace(/\/$/, '');
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    // GitHub's global PAX record contains the source commit, not a file.
    if (type === 'g') {
      if (/\b(?:path|linkpath|size)=/.test(body.toString())) throw new Error('Unsupported archive metadata');
      continue;
    }
    if (!['', '0', '5'].includes(type)) throw new Error('Release archives may contain only regular files and directories');
    const segments = name.split('/');
    if (!name || name.includes('\\') || name.includes(':') || segments.some(part => !part || part === '.' || part === '..')) throw new Error('Unsafe path in release archive');
    root ||= segments[0];
    if (root !== segments[0]) throw new Error('Release archive must contain one root directory');
    const relative = segments.slice(1).join('/');
    if (!relative || type === '5' || !releaseFiles.has(segments[1])) continue;
    if (written.has(relative)) throw new Error('Duplicate file in release archive');
    written.add(relative);
    const path = join(destination, relative);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await writeFile(path, body, { flag: 'wx', mode: 0o600 });
  }
  for (const path of ['src/index.js', 'package.json', 'package-lock.json']) {
    if (!written.has(path)) throw new Error(`Release is missing ${path}`);
  }
}

export function createReleaseStore({ root, fetchImpl = fetch, run = runProcess } = {}) {
  const store = {
    async latest({ emit = () => {} } = {}) {
      emit('Finding the latest Objy server release');
      const source = await latestSource(fetchImpl);
      const path = join(root, 'release-refs', `${source.commit}.json`);
      return withReleaseLock(`${path}.lock`, async () => {
        const cached = await readJson(path, null);
        if (cached && cached.url === source.url) {
          const release = validateRelease({ ...cached, version: source.version });
          await store.ensure(release, { emit });
          return release;
        }
        emit(`Downloading Objy Server ${source.version}`);
        const archive = await downloadRelease(fetchImpl, source.url);
        const release = validateRelease({ ...source, sha256: createHash('sha256').update(archive).digest('hex') });
        await store.ensure(release, { emit, archive });
        await writeJson(path, release);
        return release;
      });
    },
    async ensure(manifest, { install = false, emit = () => {}, archive } = {}) {
      const release = validateRelease(manifest);
      if (install && Number(process.versions.node.split('.')[0]) < release.nodeMajor) throw new Error(`This server release requires Node.js ${release.nodeMajor}+. https://nodejs.org/en/download`);
      const directory = join(root, 'releases', release.sha256);
      await withReleaseLock(`${directory}.lock`, async () => {
        const existing = await readJson(join(directory, 'release.json'), null);
        if (!existing) {
          if (!archive) emit(`Downloading Objy Server ${release.version}`);
          const bytes = archive || await downloadRelease(fetchImpl, release.url);
          if (createHash('sha256').update(bytes).digest('hex') !== release.sha256) throw new Error('Server checksum mismatch. Nothing was installed.');
          const stage = `${directory}.${randomUUID()}.tmp`;
          const source = `${stage}.source`;
          try {
            await mkdir(source, { recursive: true, mode: 0o700 });
            await extractRelease(bytes, source);
            await writeFile(join(source, '.dockerignore'), 'node_modules\n*.json.tmp\n', { mode: 0o600 });
            await snapshotServer(source, stage);
            await writeJson(join(stage, 'release.json'), release);
            await rename(stage, directory);
          } finally {
            await rm(stage, { recursive: true, force: true });
            await rm(source, { recursive: true, force: true });
          }
        } else if (existing.sha256 !== release.sha256) throw new Error('Cached server release does not match the deployment');
        await verifyServerSnapshot(directory);
        if (install) {
          let installed = false;
          try { await access(join(directory, '.dependencies-ready')); await access(join(directory, 'node_modules')); installed = true; } catch {}
          if (!installed) {
            emit('Installing server dependencies into the release cache');
            await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: directory, env: { ...process.env, npm_config_cache: join(root, 'npm-cache') } });
            await writeFile(join(directory, '.dependencies-ready'), release.sha256, { mode: 0o600 });
          }
        }
      });
      return directory;
    },
  };
  return store;
}
