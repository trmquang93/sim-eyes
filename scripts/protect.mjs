#!/usr/bin/env node
/**
 * The one transform that hides our source in what a user downloads: the app (build-app.sh) and the signed hub bundles
 * (release-bundle.mjs) both call it, so the two channels cannot drift. The repo and the npm package stay plain.
 *   node scripts/protect.mjs --out DIR [--src DIR] [--version X.Y.Z]   protect a whole tree into DIR (tests are copied as they are)
 *   node scripts/protect.mjs --in-place FILE...                        protect single files where they are
 * Per file and at the same path, still .mjs: code reads neighbours through import.meta.url and cli.mjs imports doctor.mjs
 * dynamically, so the updater, bundle-format.mjs and isSafeBundlePath need no change. No property renaming (zod schemas,
 * JSON shapes and the MCP tool schema depend on names), no control-flow flattening (hot paths), no self-defending code.
 */
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { transform } from "esbuild";
import JavaScriptObfuscator from "javascript-obfuscator";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".cache", ".local", ".claude", "dist", "release", "work"]);
const isTest = (name) => /^(test|eval)-/.test(name);

/** A number from the version: the same version always gives the same bytes, so a user's file can be rebuilt from the tag. */
export const seedFor = (version) => parseInt(createHash("sha256").update(`sim-eyes-protect:${version}`).digest("hex").slice(0, 8), 16);

const obfuscatorOptions = ({ module, version }) => ({
  compact: true,
  seed: seedFor(version),
  sourceType: module ? "module" : "script",
  target: module ? "node" : "browser",
  stringArray: true,
  stringArrayEncoding: ["base64"],
  stringArrayThreshold: 1,
  rotateStringArray: true,
  shuffleStringArray: true,
  identifierNamesGenerator: "hexadecimal",
  renameGlobals: false,
  renameProperties: false,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  selfDefending: false,
  debugProtection: false,
  disableConsoleOutput: false,
  transformObjectKeys: false,
  splitStrings: false,
  numbersToExpressions: false,
  simplify: true,
});

async function protectScript(text, { module, version }) {
  const min = await transform(text, { minify: true, legalComments: "none", target: module ? "node22" : "es2020", ...(module ? { format: "esm" } : {}) });
  return JavaScriptObfuscator.obfuscate(min.code, obfuscatorOptions({ module, version })).getObfuscatedCode();
}

const stripHtmlComments = (html) => html.replace(/<!--[\s\S]*?-->/g, "");

/** Returns the bytes to ship for one file. Files that hold no source of ours (JSON, keys, images) pass through. */
export async function protectFile(path, bytes, { version }) {
  if (!version) throw new Error("protectFile needs the release version (it seeds the build).");
  const name = path.split("/").pop();
  if (isTest(name)) return bytes;
  const text = () => bytes.toString("utf8");
  if (path.endsWith(".mjs")) return Buffer.from(`${await protectScript(text(), { module: true, version })}\n`);
  if (path.endsWith(".js")) return Buffer.from(`${await protectScript(text(), { module: false, version })}\n`);
  if (path.endsWith(".css")) return Buffer.from((await transform(text(), { loader: "css", minify: true, legalComments: "none" })).code);
  if (path.endsWith(".html")) return Buffer.from(stripHtmlComments(text()));
  return bytes;
}

export function parseMarkers(text) {
  return text.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

export async function loadMarkers(file = join(REPO, "scripts", "protect-markers.txt")) {
  return parseMarkers(await readFile(file, "utf8").catch(() => ""));
}

/** The markers that appear in `text`. Used on protected output: any hit means source leaked through. */
export const findMarkers = (text, markers) => markers.filter((m) => text.includes(m));

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else if (entry.isFile()) yield full;
  }
}

/** Protects every file under `src` into `out` (may be the same folder), keeping paths and modes. Fails closed when a marker survives. */
export async function protectTree({ src, out = src, version, markers = [] }) {
  const written = [];
  for await (const file of walk(src)) {
    const rel = relative(src, file);
    const target = join(out, rel);
    await mkdir(dirname(target), { recursive: true });
    const mode = (await stat(file)).mode & 0o777;
    const bytes = await readFile(file);
    const result = await protectFile(rel, bytes, { version });
    const leaked = rel.endsWith(".mjs") || rel.endsWith(".js") || rel.endsWith(".css") || rel.endsWith(".html") ? (isTest(rel.split("/").pop()) ? [] : findMarkers(result.toString("utf8"), markers)) : [];
    if (leaked.length) throw new Error(`${rel} still contains source text after protection: ${leaked.join(", ")}`);
    if (file === target && result.equals(bytes)) { written.push(rel); continue; }
    await writeFile(target, result);
    await chmod(target, mode);
    written.push(rel);
  }
  return written.sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  try {
    const version = arg("--version", JSON.parse(await readFile(join(REPO, "package.json"), "utf8")).version);
    const markers = await loadMarkers();
    if (args.includes("--in-place")) {
      for (const file of args.slice(args.indexOf("--in-place") + 1)) {
        const bytes = await readFile(file);
        const result = await protectFile(file, bytes, { version });
        const leaked = findMarkers(result.toString("utf8"), markers);
        if (leaked.length) throw new Error(`${file} still contains source text after protection: ${leaked.join(", ")}`);
        await writeFile(file, result);
      }
    } else {
      const files = await protectTree({ src: arg("--src", REPO), out: arg("--out"), version, markers });
      console.log(`protected ${files.length} files into ${arg("--out")}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
