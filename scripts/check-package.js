import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const run = promisify(execFile);
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

if (packageJson.name !== "@objy/cli") throw new Error("package must be named @objy/cli");
if (packageJson.bin?.objy !== "bin/objy.js" || Object.keys(packageJson.bin).length !== 1) {
  throw new Error("@objy/cli must be the sole owner of the objy binary");
}
if (packageJson.publishConfig?.access !== "public") throw new Error("@objy/cli must publish publicly");

const { stdout } = await run("npm", ["pack", "--dry-run", "--ignore-scripts", "--json"], {
  maxBuffer: 10 * 1024 * 1024,
});
const result = JSON.parse(stdout);
const packs = Array.isArray(result)
  ? result
  : result?.filename
    ? [result]
    : Object.values(result || {});
const matches = packs.filter(pack => pack && typeof pack === "object" && pack.filename);
if (matches.length !== 1) throw new Error(`npm pack returned ${matches.length} package results`);
const [packed] = matches;
const files = new Set(packed.files.map(({ path }) => path));

for (const path of ["README.md", "bin/objy.js", "package.json", "src/index.js"]) {
  if (!files.has(path)) throw new Error(`CLI package is missing ${path}`);
}

console.log(`${packed.name}@${packed.version}: ${files.size} files, ${packed.size} bytes`);
