// Why: strangers run what `npm pack` ships. A module the files whitelist forgot crashes the server at start on their
// Mac; a leaked key or plan file is public forever; a drifting agent-device pin splits npm users from the Mac app.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const requireBinary = process.argv.includes("--require-binary");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

/** Files `npm pack` would put in the tarball, relative to the package root. */
export function packedFiles() {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: root, encoding: "utf8" });
  return JSON.parse(out)[0].files.map((f) => f.path);
}

/** Relative modules reachable from `entry` through static and dynamic imports. */
export function importedModules(entry, read = (p) => readFileSync(join(root, p), "utf8")) {
  const seen = new Set();
  const queue = [entry];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    const source = read(file);
    for (const m of source.matchAll(/(?:from\s+|import\s*\(\s*)["'](\.[^"']+)["']/g)) {
      queue.push(normalize(join(dirname(file), m[1])));
    }
  }
  return [...seen];
}

const FORBIDDEN = [
  /^test-/, /^eval-/, /^studio\//, /^hub\//, /^app\//, /^promo\//, /^fixtures\//, /-plan\.md$/, /^\.local\//, /^work\//,
  /^dist\//, /^release\//, /^downloads\//, /\.pem$/, /(^|\/)\.env/, /typesafe\.key$/, /^CLAUDE\.md$/, /^scripts\//,
];

const files = packedFiles();

// A new import in the server that the whitelist forgot.
const missing = importedModules("cli.mjs").filter((m) => !files.includes(m));
assert.deepEqual(missing, [], `tarball lacks modules the server imports: ${missing.join(", ")}`);
for (const required of ["ocr.swift", "vendor/sim-pool/sim-pool", "LICENSE", "README.md", "package.json"]) {
  assert.ok(files.includes(required), `tarball lacks ${required}`);
}
if (requireBinary) {
  for (const built of ["bin/ocr", "bin/ocr.json"]) assert.ok(files.includes(built), `tarball lacks ${built}: run scripts/build-ocr.mjs`);
}

// The signing key, plans and 50 MB of junk must stay out.
const leaked = files.filter((f) => FORBIDDEN.some((re) => re.test(f)));
assert.deepEqual(leaked, [], `tarball ships files that must stay private: ${leaked.join(", ")}`);
for (const f of files) {
  const path = join(root, f);
  if (!existsSync(path) || /\.(png|jpg|zip)$/.test(f) || f === "bin/ocr") continue;
  assert.ok(!/PRIVATE KEY/.test(readFileSync(path, "utf8")), `${f} contains a private key`);
}

// One pin, two consumers: npm users get dependencies, the Mac app hashes both.
assert.equal(pkg.dependencies["agent-device"], pkg.simEyes.agentDevice, "dependencies.agent-device must equal simEyes.agentDevice");
assert.equal(pkg.bin["sim-eyes"], "./cli.mjs");
assert.deepEqual(pkg.os, ["darwin"]);
assert.ok(pkg.license && pkg.engines?.node, "package.json needs license and engines.node");

console.log(`test-pack: ok (${files.length} files)`);
