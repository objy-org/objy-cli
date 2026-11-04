import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, inflateRawSync } from 'node:zlib';
import { readJson, writeJson } from '../deployment/files.js';
import { withLock } from '../deployment/operations.js';

const manifest = JSON.parse(await readFile(new URL('../../releases/seaweedfs.json', import.meta.url)));
const maxDownload = 128 * 1024 * 1024, maxBinary = 512 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

export function seaweedRelease(platform = process.platform, arch = process.arch) {
  const asset = manifest.assets[`${platform}-${arch}`];
  if (!asset) throw new Error(`Automatic local storage is unavailable on ${platform}/${arch}. Choose existing S3 storage or Docker.`);
  return { version: manifest.version, platform: `${platform}-${arch}`, ...asset };
}

function validate(release) {
  if (!release || !/^\d+\.\d+(?:\.\d+)?$/.test(release.version) || !/^[a-f0-9]{64}$/.test(release.sha256)
    || !/^(darwin|linux|windows)_(amd64|arm64)\.(tar\.gz|zip)$/.test(release.file)
    || release.platform !== `${process.platform}-${process.arch}`) throw new Error('Invalid or incompatible saved local storage release');
  return release;
}

export function createStorageRuntimeStore({ root, fetchImpl = fetch } = {}) {
  return {
    async ensure(input = seaweedRelease(), { emit = () => {} } = {}) {
      const release = validate(input);
      const directory = join(root, 'storage-runtimes', release.sha256);
      const filename = release.file.endsWith('.zip') ? 'weed.exe' : 'weed';
      const binary = join(directory, filename);
      await withLock(`${directory}.lock`, async () => {
        const receipt = await readJson(join(directory, 'runtime.json'), null);
        if (receipt) {
          if (receipt.archiveSha256 !== release.sha256 || hash(await readFile(binary)) !== receipt.binarySha256) throw new Error('Cached local storage runtime failed its integrity check');
          return;
        }
        emit(`Downloading local S3 storage (SeaweedFS ${release.version})`);
        const url = `https://github.com/seaweedfs/seaweedfs/releases/download/${release.version}/${release.file}`;
        const response = await fetchImpl(url, { signal: AbortSignal.timeout(120000), redirect: 'follow' });
        if (!response.ok) throw new Error(`Local storage download failed (HTTP ${response.status}). Use objy resume to retry.`);
        if (response.url && !response.url.startsWith('https:')) throw new Error('Storage download redirected away from HTTPS');
        const chunks = []; let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > maxDownload) throw new Error('Local storage download exceeds the size limit');
          chunks.push(chunk);
        }
        const archive = Buffer.concat(chunks);
        if (hash(archive) !== release.sha256) throw new Error('Local storage download checksum mismatch. Nothing was installed.');
        const bytes = extractStorageBinary(archive, filename);
        const staging = `${directory}.${randomUUID()}.tmp`;
        try {
          await mkdir(staging, { recursive: true, mode: 0o700 });
          await writeFile(join(staging, filename), bytes, { flag: 'wx', mode: 0o700 });
          await chmod(join(staging, filename), 0o700);
          await writeJson(join(staging, 'runtime.json'), { ...release, archiveSha256: release.sha256, binarySha256: hash(bytes) });
          await rename(staging, directory);
        } finally { await rm(staging, { recursive: true, force: true }); }
      });
      return binary;
    },
  };
}

// Only return the expected executable; archive paths are never written to disk.
export function extractStorageBinary(archive, filename) {
  let binary;
  const accept = (name, bytes) => {
    if (name !== filename && name !== `./${filename}`) return;
    if (binary || !bytes.length || bytes.length > maxBinary) throw new Error('Invalid storage executable in archive');
    binary = Buffer.from(bytes);
  };
  if (filename === 'weed') {
    const tar = gunzipSync(archive, { maxOutputLength: maxBinary });
    for (let offset = 0; offset + 512 <= tar.length;) {
      const header = tar.subarray(offset, offset + 512);
      if (header.every(byte => byte === 0)) break;
      const string = (start, length) => header.subarray(start, start + length).toString('utf8').split('\0')[0];
      const expected = parseInt(string(148, 8).trim(), 8);
      if (header.reduce((sum, byte, i) => sum + (i >= 148 && i < 156 ? 32 : byte), 0) !== expected) throw new Error('Invalid storage archive header');
      const size = parseInt(string(124, 12).trim() || '0', 8), type = string(156, 1);
      if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid storage archive length');
      const name = [string(345, 155), string(0, 100)].filter(Boolean).join('/');
      if (['', '0'].includes(type)) accept(name, tar.subarray(offset + 512, offset + 512 + size));
      else if ([filename, `./${filename}`].includes(name)) throw new Error('Storage executable must be a regular file');
      offset += 512 + Math.ceil(size / 512) * 512;
    }
  } else if (filename === 'weed.exe') {
    // Read the ZIP central directory so data-descriptor archives work without an unzip dependency.
    let end = -1;
    for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65557); i--) {
      if (archive.readUInt32LE(i) === 0x06054b50 && i + 22 + archive.readUInt16LE(i + 20) === archive.length) { end = i; break; }
    }
    if (end < 0) throw new Error('Invalid storage ZIP archive');
    let offset = archive.readUInt32LE(end + 16);
    const entries = archive.readUInt16LE(end + 10);
    for (let i = 0; i < entries; i++) {
      if (offset + 46 > end || archive.readUInt32LE(offset) !== 0x02014b50) throw new Error('Invalid storage ZIP directory');
      const flags = archive.readUInt16LE(offset + 8), method = archive.readUInt16LE(offset + 10);
      const compressed = archive.readUInt32LE(offset + 20), size = archive.readUInt32LE(offset + 24);
      const nameLength = archive.readUInt16LE(offset + 28), extra = archive.readUInt16LE(offset + 30), comment = archive.readUInt16LE(offset + 32);
      const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString();
      if (name === filename) {
        const local = archive.readUInt32LE(offset + 42), mode = archive.readUInt32LE(offset + 38) >>> 16;
        if ((flags & 1) || ![0, 8].includes(method) || size > maxBinary || (mode & 0o170000) === 0o120000
          || local + 30 > offset || archive.readUInt32LE(local) !== 0x04034b50) throw new Error('Unsupported storage ZIP entry');
        const data = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
        if (data + compressed > offset) throw new Error('Invalid storage ZIP length');
        const source = archive.subarray(data, data + compressed);
        const bytes = method === 0 ? source : inflateRawSync(source, { maxOutputLength: maxBinary });
        if (bytes.length !== size) throw new Error('Invalid storage executable size');
        accept(name, bytes);
      }
      offset += 46 + nameLength + extra + comment;
    }
  }
  if (!binary) throw new Error(`Storage archive is missing ${filename}`);
  return binary;
}
