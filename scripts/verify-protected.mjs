#!/usr/bin/env node
/**
 * C11: the downloaded app shows none of our source.
 *   node scripts/verify-protected.mjs [--app dist/SimEyesStudio.app] [--zip dist/SimEyesStudio.zip] [--out DIR]
 * Counts the marker texts (scripts/protect-markers.txt) in the plain repo files that ship, then in the built app and in the
 * unzipped zip. The plain count must be high (or a zero proves nothing) and the app and zip counts must be zero. Also fails on any
 * .swift outside node_modules. Writes source-hidden.txt into --out (default .local/qa-evidence/mcp-in-app).
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collectFiles } from "./release-bundle.mjs";
import { findMarkers, loadMarkers } from "./protect.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const app = resolve(arg("--app", join(REPO, "dist", "SimEyesStudio.app")));
const zip = resolve(arg("--zip", join(REPO, "dist", "SimEyesStudio.zip")));
const outDir = resolve(arg("--out", join(REPO, ".local", "qa-evidence", "mcp-in-app")));
const lines = [];
const note = (t) => { lines.push(t); console.log(t); };

function* files(dir) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules") continue;
    const full = join(dir, name);
    const s = statSync(full);
    if (s.isDirectory()) yield* files(full);
    else if (s.isFile()) yield full;
  }
}
const textOf = (path) => readFileSync(path).toString("latin1");

const markers = await loadMarkers();
const plain = (await collectFiles(REPO)).map((p) => textOf(join(REPO, p))).join("\n");
const plainHits = findMarkers(plain, markers);
note(`markers: ${markers.length}; plain shipped source contains ${plainHits.length}`);

function scan(label, root) {
  const hits = new Map();
  const swift = [];
  for (const f of files(root)) {
    if (f.endsWith(".swift")) swift.push(relative(root, f));
    for (const m of findMarkers(textOf(f), markers)) hits.set(m, [...(hits.get(m) ?? []), relative(root, f)]);
  }
  note(`${label}: ${hits.size} marker hits, ${swift.length} .swift files`);
  for (const [m, where] of hits) note(`  HIT "${m}" in ${where.join(", ")}`);
  for (const s of swift) note(`  SWIFT ${s}`);
  return hits.size + swift.length;
}

let bad = plainHits.length < markers.length * 0.8 ? 1 : 0;
if (bad) note("FAIL the markers do not hit the plain source: a zero below proves nothing");
bad += scan("app", app);
const unzipped = mkdtempSync(join(tmpdir(), "unzipped-"));
execFileSync("ditto", ["-x", "-k", zip, unzipped]);
bad += scan("zip", unzipped);
note(bad ? "FAIL" : "PASS");
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "source-hidden.txt"), `${lines.join("\n")}\n`);
process.exit(bad ? 1 : 0);
