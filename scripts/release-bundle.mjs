#!/usr/bin/env node
/**
 * Builds and signs a Studio bundle for the hub.
 *   node scripts/release-bundle.mjs --keygen                      one time: makes the release key pair
 *   node scripts/release-bundle.mjs [--version X.Y.Z] [--min-app X.Y.Z] [--out release] [--key-dir DIR] [--publish user@host:/path/to/releases]
 * The private key stays in ~/.sim-eyes-release on the developer's Mac; the VPS only ever holds signed files.
 */
import { execFile } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { SEMVER, canonicalManifest, depsHash, isSafeBundlePath, sha256 } from "../app/bundle-format.mjs";
import { protectFile } from "./protect.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const skipped = (name) => /^(test|eval)-/.test(name);
const run = promisify(execFile);

/** The files a tester's Mac needs to run Studio and the MCP server: the same set app/build-app.sh puts in the app. No .swift: the app ships ocr and pdf-facts compiled. */
export async function collectFiles(repo = REPO) {
  const paths = [];
  for (const name of await readdir(repo)) {
    if ((name.endsWith(".mjs") && !skipped(name)) || name === "package.json") paths.push(name);
  }
  for (const name of await readdir(join(repo, "studio"))) if (name.endsWith(".mjs") && !skipped(name)) paths.push(`studio/${name}`);
  for (const name of await readdir(join(repo, "studio", "public"))) paths.push(`studio/public/${name}`);
  return paths.sort();
}

/** `protect: false` is for tests that read the plain source; a release always protects (the signature then covers the protected bytes). */
export async function buildBundle({ repo = REPO, version, protect = true }) {
  if (!SEMVER.test(version)) throw new Error(`The version must be x.y.z, got ${version}.`);
  const files = [];
  for (const path of await collectFiles(repo)) {
    if (!isSafeBundlePath(path)) throw new Error(`Not a path a bundle may hold: ${path}`);
    const full = join(repo, path);
    const plain = await readFile(full);
    const data = protect ? await protectFile(path, plain, { version }) : plain;
    files.push({ path, mode: (await stat(full)).mode & 0o111 ? "0755" : "0644", sha256: sha256(data), b64: data.toString("base64") });
  }
  const versionFile = Buffer.from(`${version}\n`);
  files.push({ path: "VERSION", mode: "0644", sha256: sha256(versionFile), b64: versionFile.toString("base64") });
  return Buffer.from(JSON.stringify({ version, files }));
}

export function signManifest({ bundle, version, depsHash: deps, minAppVersion = "0.0.0", privateKeyPem, now = () => new Date() }) {
  const manifest = { version, bundleSha256: sha256(bundle), depsHash: deps, minAppVersion, publishedAt: now().toISOString() };
  return { ...manifest, signature: sign(null, Buffer.from(canonicalManifest(manifest)), privateKeyPem).toString("base64") };
}

export async function packageInfo(repo = REPO) {
  const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8"));
  return { version: pkg.version, depsHash: depsHash(pkg.dependencies, pkg.simEyes?.agentDevice) };
}

async function keygen(keyDir) {
  const privatePath = join(keyDir, "private.pem");
  if (await access(privatePath).then(() => true, () => false)) throw new Error(`${privatePath} already exists. Not overwriting it: a new key would need a new app.`);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  await mkdir(keyDir, { recursive: true, mode: 0o700 });
  await writeFile(privatePath, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await writeFile(join(REPO, "app", "release-public.pem"), publicKey.export({ type: "spki", format: "pem" }));
  console.log(`Private key: ${privatePath} (back it up; losing it means shipping a new app)\nPublic key: app/release-public.pem (commit it, build-app.sh puts it in the app)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  const keyDir = arg("--key-dir", join(homedir(), ".sim-eyes-release"));
  try {
    if (args.includes("--keygen")) {
      await keygen(keyDir);
    } else {
      const info = await packageInfo();
      const version = arg("--version", info.version);
      const deps = info.depsHash;
      const out = arg("--out", join(REPO, "release"));
      const bundle = await buildBundle({ version });
      const manifest = signManifest({ bundle, version, depsHash: deps, minAppVersion: arg("--min-app", "0.0.0"), privateKeyPem: await readFile(join(keyDir, "private.pem"), "utf8") });
      const dir = join(out, version);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "bundle.json"), bundle);
      await writeFile(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      await writeFile(join(out, "latest.json"), `${JSON.stringify({ version })}\n`);
      console.log(`Built ${dir} (${(bundle.length / 1024).toFixed(0)} KB, depsHash ${deps.slice(0, 12)}…)`);
      const target = arg("--publish");
      if (target) {
        // The version folder first, then latest.json: a tester never sees a version whose files are not there yet.
        await run("rsync", ["-a", `${dir}/`, `${target.replace(/\/+$/, "")}/${version}/`]);
        await run("rsync", ["-a", join(out, "latest.json"), `${target.replace(/\/+$/, "")}/latest.json`]);
        console.log(`Published ${version} to ${target}`);
      }
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
