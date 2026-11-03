import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await check(path);
    else if (path.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (result.status) process.exit(result.status);
    }
  }
}
for (const directory of ['bin', 'src', 'scripts', 'test']) await check(directory);
const pkg = JSON.parse(await readFile('package.json'));
if (Object.keys(pkg.dependencies).some(name => name.startsWith('@objy/'))) throw new Error('The CLI must not depend on the server or database library');
console.log('Syntax and package boundary checks passed.');
