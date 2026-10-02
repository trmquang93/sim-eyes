#!/usr/bin/env node
/**
 * The app's updater. It lives in the app, not in a bundle, so it is the one piece of code that is never downloaded. It asks the hub
 * for the latest signed Studio bundle, checks everything, and stages it next to the older ones. Nothing is switched while Studio
 * runs: the launcher calls `choose` when it starts Studio.
 *
 * CLI (the launcher reads one JSON line from stdout; the invite token comes in the environment, never in argv):
 *   check  --hub URL --dir DIR --app app.json --key release-public.pem     env SIM_EYES_HUB_TOKEN
 *   choose --dir DIR --builtin PATH --builtin-version X.Y.Z --node-modules PATH
 *   bad    --dir DIR --version X.Y.Z
 */
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, readlink, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { MODES, SEMVER, canonicalManifest, compareVersions, isSafeBundlePath, sha256 } from "./bundle-format.mjs";

const MAX_BUNDLE_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

const readJsonOr = async (path, fallback) => {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return fallback;
    throw err;
  }
};

async function writeJson(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`);
  await rename(tmp, path);
}

/** Tokens travel only over HTTPS; plain HTTP is for this Mac (the hub run locally for checks). */
export function assertHubUrl(hubUrl) {
  const url = new URL(hubUrl);
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("The hub address must be https.");
  return url.origin;
}

/** Throws unless the signature covers exactly these manifest fields and was made by the release key. */
export function verifyManifest(manifest, publicKeyPem) {
  if (!manifest || typeof manifest !== "object") throw new Error("The update manifest is not valid.");
  for (const k of ["version", "bundleSha256", "depsHash", "minAppVersion", "publishedAt", "signature"]) {
    if (typeof manifest[k] !== "string") throw new Error(`The update manifest has no ${k}.`);
  }
  if (!SEMVER.test(manifest.version) || !SEMVER.test(manifest.minAppVersion)) throw new Error("The update manifest has a bad version.");
  const ok = verify(null, Buffer.from(canonicalManifest(manifest)), createPublicKey(publicKeyPem), Buffer.from(manifest.signature, "base64"));
  if (!ok) throw new Error("The update is not signed by the release key. It was not installed.");
}

/** The downloaded bytes must be the ones the signature names, and every file must be what it says and land only inside the bundle folder. */
export function verifyBundle(bytes, manifest) {
  if (sha256(bytes) !== manifest.bundleSha256) throw new Error("The downloaded update does not match its signature. It was not installed.");
  const bundle = JSON.parse(bytes.toString("utf8"));
  if (bundle.version !== manifest.version || !Array.isArray(bundle.files) || bundle.files.length === 0) throw new Error("The update bundle does not match its manifest.");
  const seen = new Set();
  const files = bundle.files.map((f) => {
    if (!isSafeBundlePath(f.path)) throw new Error(`The update has a file path that is not allowed: ${JSON.stringify(f.path)}`);
    if (seen.has(f.path)) throw new Error(`The update lists ${f.path} twice.`);
    seen.add(f.path);
    if (!MODES.has(f.mode)) throw new Error(`The update has a file mode that is not allowed: ${f.path}`);
    const data = Buffer.from(String(f.b64), "base64");
    if (sha256(data) !== f.sha256) throw new Error(`The update file ${f.path} is damaged.`);
    return { path: f.path, mode: parseInt(f.mode, 8), data };
  });
  if (!seen.has("studio/studio.mjs") || !seen.has("server.mjs")) throw new Error("The update bundle is missing Studio.");
  return files;
}

async function stage(dir, version, files) {
  const tmp = join(dir, "bundles", `.tmp-${randomBytes(6).toString("hex")}`);
  try {
    for (const f of files) {
      const target = join(tmp, f.path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, f.data);
      await chmod(target, f.mode);
    }
    const final = join(dir, "bundles", version);
    await rm(final, { recursive: true, force: true });
    await rename(tmp, final);
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
}

/** The newest version this app has ever installed or shipped with. */
async function highestKnown(dir, builtinVersion) {
  const { highestInstalled } = await readJsonOr(join(dir, "state.json"), {});
  return highestInstalled && SEMVER.test(highestInstalled) && compareVersions(highestInstalled, builtinVersion) > 0 ? highestInstalled : builtinVersion;
}

/**
 * One update check. Returns { status, version?, reason? }. status: up-to-date | staged | needs-new-app | unauthorized | offline | rejected.
 * @param {{ hubUrl: string, token: string, fetch?: typeof fetch, publicKeyPem: string, app: { appVersion: string, depsHash: string }, dir: string }} p
 */
export async function checkForUpdate({ hubUrl, token, fetch = globalThis.fetch, publicKeyPem, app, dir }) {
  const origin = assertHubUrl(hubUrl);
  const get = async (path) => {
    try {
      return await fetch(`${origin}${path}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    } catch {
      return null;
    }
  };
  const res = await get("/v1/manifest");
  if (!res) return { status: "offline", reason: "The hub could not be reached." };
  if (res.status === 401) return { status: "unauthorized", reason: "The invite token was not accepted. Ask for a new one." };
  if (res.status === 404) return { status: "up-to-date", reason: "No release is published yet." };
  if (!res.ok) return { status: "offline", reason: `The hub answered ${res.status}.` };

  let manifest;
  try {
    manifest = await res.json();
    verifyManifest(manifest, publicKeyPem);
  } catch (err) {
    return { status: "rejected", reason: err.message };
  }
  const highest = await highestKnown(dir, app.appVersion);
  if (compareVersions(manifest.version, highest) <= 0) return { status: "up-to-date", version: highest };
  const bad = await readJsonOr(join(dir, "bad.json"), []);
  if (bad.includes(manifest.version)) return { status: "rejected", version: manifest.version, reason: "This version failed to start on this Mac before." };
  if (manifest.depsHash !== app.depsHash || compareVersions(app.appVersion, manifest.minAppVersion) < 0) {
    return { status: "needs-new-app", version: manifest.version, reason: "This update needs a newer SimEyes Studio app. Ask for it." };
  }
  const download = await get(`/v1/bundles/${manifest.version}`);
  if (!download || !download.ok) return { status: "offline", reason: "The update could not be downloaded." };
  let bytes;
  try {
    bytes = Buffer.from(await download.arrayBuffer());
    if (bytes.length > MAX_BUNDLE_BYTES) throw new Error("The update is larger than expected. It was not installed.");
    await stage(dir, manifest.version, verifyBundle(bytes, manifest));
  } catch (err) {
    return { status: "rejected", version: manifest.version, reason: err.message };
  }
  await writeJson(join(dir, "state.json"), { highestInstalled: manifest.version });
  return { status: "staged", version: manifest.version };
}

const hasStudio = (path) => stat(join(path, "studio", "studio.mjs")).then((s) => s.isFile(), () => false);

/** A bundle has no node_modules of its own: it uses the app's. The link is made at every start, so it survives the app being moved. */
async function linkNodeModules(path, target) {
  const link = join(path, "node_modules");
  if ((await lstat(link).catch(() => null)) && (await readlink(link).catch(() => null)) === target) return;
  await rm(link, { recursive: true, force: true });
  await symlink(target, link);
}

/** The code folder to run: the newest installed version that is not marked bad, or the one built into the app. */
export async function chooseBundle({ dir, builtin, nodeModules }) {
  const bad = new Set(await readJsonOr(join(dir, "bad.json"), []));
  const names = (await readdir(join(dir, "bundles")).catch(() => [])).filter((n) => SEMVER.test(n) && !bad.has(n));
  names.sort((a, b) => compareVersions(b, a));
  for (const version of names) {
    if (compareVersions(version, builtin.version) <= 0) break;
    const path = join(dir, "bundles", version);
    if (!(await hasStudio(path))) continue;
    if (nodeModules) await linkNodeModules(path, nodeModules);
    return { path, version, builtin: false };
  }
  return { path: builtin.path, version: builtin.version, builtin: true };
}

export async function markBad({ dir, version }) {
  const bad = await readJsonOr(join(dir, "bad.json"), []);
  if (!bad.includes(version)) await writeJson(join(dir, "bad.json"), [...bad, version]);
}

/** Staged versions beyond the newest `keep` are deleted so a Mac does not collect them; the one in use is never deleted. */
export async function prune({ dir, keep = 2, current }) {
  const names = (await readdir(join(dir, "bundles")).catch(() => [])).filter((n) => SEMVER.test(n)).sort((a, b) => compareVersions(b, a));
  for (const n of names.slice(keep)) if (n !== current) await rm(join(dir, "bundles", n), { recursive: true, force: true });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(3);
  const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const out = (value) => console.log(JSON.stringify(value));
  try {
    const command = process.argv[2];
    const dir = arg("--dir");
    if (command === "check") {
      const app = JSON.parse(await readFile(arg("--app"), "utf8"));
      const token = process.env.SIM_EYES_HUB_TOKEN;
      if (!token) out({ status: "no-token", reason: "No invite token is set." });
      else out(await checkForUpdate({ hubUrl: arg("--hub") || app.hubUrl, token, publicKeyPem: await readFile(arg("--key"), "utf8"), app, dir }));
    } else if (command === "choose") {
      const chosen = await chooseBundle({ dir, builtin: { path: arg("--builtin"), version: arg("--builtin-version") }, nodeModules: arg("--node-modules") });
      await prune({ dir, current: chosen.version });
      out(chosen);
    } else if (command === "bad") {
      await markBad({ dir, version: arg("--version") });
      out({ ok: true });
    } else {
      console.error("Usage: updater.mjs check|choose|bad ...");
      process.exit(2);
    }
  } catch (err) {
    out({ status: "error", reason: err.message });
    process.exit(1);
  }
}
