/**
 * The app under test: a simulator build the tester drops on the page (a .app folder, or a .zip / .ipa holding one).
 * Everything that touches the Mac goes through an injected `exec(file, args, opts) -> { stdout }` (execFile in
 * production, no shell), so a path with spaces or quotes is never a command.
 */
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, extname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { assertSlug, slug, stampOf, writeJson } from "./store.mjs";

const execFileAsync = promisify(execFile);
export const realExec = (file, args, opts = {}) => execFileAsync(file, args, { maxBuffer: 64 * 1024 * 1024, ...opts });

/** A refusal is the tester's to act on, so its message is shown on the page as it is; anything else is a Studio bug. */
export class Refusal extends Error {}

const HOW_TO = "Ask the developer for a **simulator** build: in Xcode pick an iPhone simulator, Product → Build, then zip the `.app` from Products (or `xcodebuild -sdk iphonesimulator`).";
export const MESSAGES = {
  device: `This is an iPhone (device) build. ${HOW_TO}`,
  deviceIpa: `This .ipa is an iPhone (device) build and cannot run on a simulator. ${HOW_TO}`,
  notOneApp: "The zip must hold exactly one .app.",
  notOneIpaApp: "The .ipa must hold exactly one app in its Payload folder.",
  notBuild: "Drop a simulator .app, or a .zip / .ipa that holds one.",
  codesign: "This .app could not be copied exactly through the browser. Right-click it in Finder → Compress, and drop the .zip instead.",
  bundleId: (id, app) => `This build is \`${id}\`, but the project tests \`${app}\`.`,
  unsafeZip: "The zip has a file outside its own folder, so it was not opened.",
};

/** Mach-O and universal-binary magic numbers, in both byte orders: the files a browser leaves without their executable bit. */
const MACHO = new Set(["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"]);
export const isMachO = (firstBytes) => firstBytes.length >= 4 && MACHO.has(Buffer.from(firstBytes).subarray(0, 4).toString("hex"));

const UDID = /^[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}$/;
const INSTALL_TIMEOUT_MS = 180_000;

const isApp = (name) => name.toLowerCase().endsWith(".app");
const subdirs = async (dir) => (await readdir(dir, { withFileTypes: true }).catch(() => [])).filter((e) => e.isDirectory() && e.name !== "__MACOSX");

/** The Info.plist fields a build is listed by. A missing key is null, not an error. */
export async function readAppInfo(appPath, { exec }) {
  const plist = join(appPath, "Info.plist");
  const get = async (key, format = "raw") => (await exec("plutil", ["-extract", key, format, "-o", "-", plist]).then((r) => r.stdout.trim(), () => null)) || null;
  const [bundleId, display, bundleName, version, build, platform, platforms] = await Promise.all([
    get("CFBundleIdentifier"),
    get("CFBundleDisplayName"),
    get("CFBundleName"),
    get("CFBundleShortVersionString"),
    get("CFBundleVersion"),
    get("DTPlatformName"),
    get("CFBundleSupportedPlatforms", "json"),
  ]);
  return {
    bundleId,
    name: display || bundleName || basename(appPath).replace(/\.app$/i, ""),
    version,
    build,
    platform,
    platforms: platforms ? JSON.parse(platforms) : [],
  };
}

export const isSimulatorBuild = (info) => info.platform === "iphonesimulator" || info.platforms.includes("iPhoneSimulator");

/** Entries of a zip that would be written outside the folder it is opened in. */
const unsafeEntry = (entry) => entry.startsWith("/") || entry.split(/[\\/]/).includes("..");

/** Opens a .zip / .ipa into `dest` and returns the one .app inside (in `Payload/` for an .ipa). */
async function unpack(file, name, dest, { exec }) {
  const ipa = extname(name).toLowerCase() === ".ipa";
  const entries = (await exec("unzip", ["-Z1", file])).stdout.split("\n").filter(Boolean);
  if (entries.some(unsafeEntry)) throw new Refusal(MESSAGES.unsafeZip);
  await exec("ditto", ["-x", "-k", file, dest]);
  const apps = [];
  if (ipa) {
    for (const e of await readdir(join(dest, "Payload"), { withFileTypes: true }).catch(() => [])) if (e.isDirectory() && isApp(e.name)) apps.push(join(dest, "Payload", e.name));
  } else {
    for (const top of await subdirs(dest)) {
      if (isApp(top.name)) apps.push(join(dest, top.name));
      else for (const inner of await subdirs(join(dest, top.name))) if (isApp(inner.name)) apps.push(join(dest, top.name, inner.name));
    }
  }
  if (apps.length !== 1) throw new Refusal(ipa ? MESSAGES.notOneIpaApp : MESSAGES.notOneApp);
  return { appPath: apps[0], ipa };
}

/**
 * A .app folder that came through the browser file by file. Browsers drop the file modes, so every Mach-O file gets its
 * executable bit back; then `codesign` has the last word on whether the copy is exact.
 */
export async function rebuildDroppedApp(uploadDir, { exec }) {
  const tops = (await readdir(uploadDir, { withFileTypes: true })).filter((e) => e.name !== ".DS_Store");
  if (tops.length !== 1 || !tops[0].isDirectory() || !isApp(tops[0].name)) throw new Refusal(MESSAGES.notBuild);
  const appPath = join(uploadDir, tops[0].name);
  const visit = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) await visit(path);
      else if (e.isFile()) {
        const handle = await open(path, "r");
        const head = Buffer.alloc(4);
        try {
          await handle.read(head, 0, 4, 0);
        } finally {
          await handle.close();
        }
        if (isMachO(head)) await chmod(path, 0o755);
      }
    }
  };
  await visit(appPath);
  await exec("codesign", ["--verify", "--deep", "--strict", appPath]).catch(() => {
    throw new Refusal(MESSAGES.codesign);
  });
  return { appPath, ipa: false };
}

/** Where an uploaded file goes under the upload folder. Refuses anything that would land outside it. */
export function uploadPath(uploadDir, relative) {
  let rel;
  try {
    rel = decodeURIComponent(relative);
  } catch {
    throw new Error("Not a valid upload path.");
  }
  const base = resolve(uploadDir);
  const target = resolve(base, rel);
  if (!rel || rel.includes("\0") || rel.startsWith("/") || rel.split(/[\\/]/).includes("..") || !target.startsWith(base + sep)) throw new Error("Not a valid upload path.");
  return target;
}

const matchesProject = (info, app) => !app || info.bundleId === app || info.name.toLowerCase() === app.toLowerCase();

/**
 * Turns a dropped build into an entry of the project's build list: `{ zip, name }` for a .zip / .ipa on disk, or
 * `{ upload }` for the folder a dropped .app was uploaded into. Returns the build.json it wrote.
 */
export async function addBuild({ buildsDir, expectedApp, zip, name, upload }, { exec, now = () => new Date() }) {
  if (zip && !/^\.(zip|ipa)$/i.test(extname(name))) throw new Refusal(MESSAGES.notBuild);
  const work = join(buildsDir, `.work-${randomBytes(4).toString("hex")}`);
  await mkdir(work, { recursive: true });
  try {
    const { appPath, ipa } = zip ? await unpack(zip, name, work, { exec }) : await rebuildDroppedApp(upload, { exec });
    const info = await readAppInfo(appPath, { exec });
    if (!isSimulatorBuild(info)) throw new Refusal(ipa ? MESSAGES.deviceIpa : MESSAGES.device);
    if (!info.bundleId) throw new Refusal(MESSAGES.notBuild);
    if (!matchesProject(info, expectedApp)) throw new Refusal(MESSAGES.bundleId(info.bundleId, expectedApp));

    const stamp = stampOf(now());
    const base = `${slug(`${info.version ?? "0"} ${info.build ?? "0"}`)}-${stamp}`;
    let id = base;
    for (let i = 2; await lstat(join(buildsDir, id)).then(() => true, () => false); i += 1) id = `${base}-${i}`;
    const dest = join(buildsDir, id);
    await mkdir(dest);
    const appName = basename(appPath);
    await rename(appPath, join(dest, appName));
    const build = {
      id,
      name: info.name,
      bundleId: info.bundleId,
      version: info.version ?? "",
      build: info.build ?? "",
      app: appName,
      source: basename(name || appName),
      addedAt: now().toISOString(),
    };
    await writeJson(join(dest, "build.json"), build);
    return build;
  } finally {
    await rm(work, { recursive: true, force: true });
    if (upload) await rm(upload, { recursive: true, force: true });
  }
}

/** Newest first. */
export async function listBuilds(buildsDir) {
  const builds = [];
  for (const d of await subdirs(buildsDir)) {
    if (d.name.startsWith(".")) continue;
    const build = await readFile(join(buildsDir, d.name, "build.json"), "utf8").then(JSON.parse, () => null);
    if (build) builds.push(build);
  }
  return builds.sort((a, b) => b.addedAt.localeCompare(a.addedAt));
}

export const buildAppPath = (buildsDir, build) => join(buildsDir, assertSlug(build.id, "build"), build.app);

export async function removeBuild(buildsDir, id) {
  await rm(join(buildsDir, assertSlug(id, "build")), { recursive: true, force: true });
}

/** Boots the simulator if it is shut down, then installs over any copy that is there (its data is kept). */
export async function installBuild({ udid, appPath }, { exec }) {
  if (!UDID.test(udid)) throw new Error(`Not a simulator id: ${JSON.stringify(udid)}`);
  const run = async (args) => {
    try {
      await exec("xcrun", ["simctl", ...args], { timeout: INSTALL_TIMEOUT_MS });
    } catch (err) {
      throw new Error(`simctl ${args[0]} failed: ${String(err.stderr || err.message).trim()}`);
    }
  };
  await run(["bootstatus", udid, "-b"]);
  await run(["install", udid, appPath]);
}

/** Abandoned folder uploads (a closed tab) are removed when Studio starts. */
export async function cleanUploads(buildsDir, { olderThanMs = 60 * 60 * 1000, now = Date.now() } = {}) {
  const root = join(buildsDir, ".uploads");
  for (const d of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    const stat = await lstat(join(root, d.name));
    if (now - stat.mtimeMs > olderThanMs) await rm(join(root, d.name), { recursive: true, force: true });
  }
}
