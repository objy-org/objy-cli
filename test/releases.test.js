import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createReleaseStore, extractRelease, validateRelease } from '../src/releases.js';

function archive(entries) {
  return gzipSync(Buffer.concat([...entries.flatMap(([name, text, type = '0']) => {
    const body = Buffer.from(text);
    const h = Buffer.alloc(512);
    h.write(name); h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write(body.length.toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
    h.fill(32, 148, 156); h.write(type, 156); h.write('ustar\0', 257);
    h.write(h.reduce((sum, value) => sum + value, 0).toString(8).padStart(6, '0') + '\0 ', 148);
    return [h, body, Buffer.alloc((512 - body.length % 512) % 512)];
  }), Buffer.alloc(1024)]));
}
const files = [['release/src/index.js', 'console.log("runtime")'], ['release/package.json', '{"name":"fixture","version":"1.0.0"}'], ['release/package-lock.json', '{}']];
async function temporary(t) {
  const path = await mkdtemp(join(tmpdir(), 'objy-release-test-')); t.after(() => rm(path, { recursive: true, force: true })); return path;
}
const manifest = bytes => ({ version: 'test', url: 'https://example.com/server.tgz', sha256: createHash('sha256').update(bytes).digest('hex'), entrypoint: 'src/index.js', nodeMajor: 22 });

test('verified server releases download once and are not CLI dependencies', async t => {
  const root = await temporary(t), bytes = archive([...files, ['release/.env', 'never-copy']]);
  let downloads = 0;
  const store = createReleaseStore({ root, fetchImpl: async () => { downloads++; return new Response(bytes); } });
  const dir = await store.ensure(manifest(bytes));
  await store.ensure(manifest(bytes));
  assert.equal(downloads, 1);
  assert.ok(!(await readdir(dir)).includes('.env'));
  assert.match(await readFile(join(dir, 'src/index.js'), 'utf8'), /runtime/);
});

test('checksum failure never extracts or installs anything', async t => {
  const root = await temporary(t), bytes = archive(files);
  const store = createReleaseStore({ root, fetchImpl: async () => new Response(bytes), run: () => { throw new Error('must not install'); } });
  await assert.rejects(store.ensure({ ...manifest(bytes), sha256: 'a'.repeat(64) }, { install: true }), /checksum mismatch/);
  assert.deepEqual(await readdir(join(root, 'releases')), []);
});

test('archive traversal, links and duplicate entries are rejected', async t => {
  for (const entry of [['release/../../outside', 'x'], ['release/src/link', '', '2'], files[0]]) {
    const root = await temporary(t);
    await assert.rejects(extractRelease(archive([...files, entry]), root), /Unsafe|regular files|Duplicate/);
  }
});

test('release manifests cannot select insecure URLs or arbitrary entrypoints', () => {
  const valid = manifest(archive(files));
  assert.throws(() => validateRelease({ ...valid, url: 'http://example.com/source' }), /HTTPS/);
  assert.throws(() => validateRelease({ ...valid, entrypoint: '../other.js' }), /Invalid/);
});
