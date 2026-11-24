/**
 * The second half of `pnpm run build`, after `tsc -p tsconfig.build.json`: the files n8n reads
 * beside each compiled node and credential — the icons and the codex `*.node.json` — copied into
 * `dist/` at the same relative paths. It is what `n8n-node build`'s own copy step does, plus the
 * codex files, which the template leaves to `tsc` and `tsc` emits only when something imports them.
 */
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const COPIED = /\.(svg|png)$|\.node\.json$/;

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

let copied = 0;
for (const folder of ["nodes", "credentials"]) {
  for (const file of walk(path.join(root, folder))) {
    if (!COPIED.test(file)) continue;
    const target = path.join(root, "dist", path.relative(root, file));
    mkdirSync(path.dirname(target), { recursive: true });
    cpSync(file, target);
    copied += 1;
  }
}
console.log(`Copied ${String(copied)} asset files into dist/.`);
