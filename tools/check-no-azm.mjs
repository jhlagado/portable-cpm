import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { extname, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const inspectedRoots = ["src", "test", "tools"];
const sourceExtensions = new Set([".asm", ".js", ".mjs", ".ts"]);
const forbidden = /(?:@jhlagado\/azm|\bazm\b)/iu;
const findings = [];

async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await inspect(path);
    } else if (
      sourceExtensions.has(extname(entry.name)) &&
      path !== join(root, "tools", "check-no-azm.mjs")
    ) {
      const source = await readFile(path, "utf8");
      if (forbidden.test(source)) findings.push(path.slice(root.length + 1));
    }
  }
}

for (const directory of inspectedRoots) await inspect(join(root, directory));
assert.deepEqual(
  findings,
  [],
  `forbidden historical assembler imports: ${findings}`,
);
console.log("ATOM-only source guard passed");
