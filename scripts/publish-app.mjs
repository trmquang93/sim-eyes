#!/usr/bin/env node
/**
 * Publishes the built Mac app (dist/SimEyesStudio.zip) to the hub's public download page.
 *   node scripts/publish-app.mjs [--zip dist/SimEyesStudio.zip] [--arch arm64|x86_64] [--out downloads] [--publish user@host:/opt/apps/sim-eyes-hub/data/downloads]
 * The version and architecture are read from the zip itself (Contents/Resources/app.json), so the page always describes the file it offers.
 * The zip goes up first, then latest.json: the page never offers a file that is not there yet.
 */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const APP_JSON = "SimEyesStudio.app/Contents/Resources/app.json";

export const sha256File = (path) =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (c) => hash.update(c)).on("end", () => resolve(hash.digest("hex"))).on("error", reject);
  });

/** What the zip says about itself. */
export async function readAppJson(zipPath) {
  let stdout;
  try {
    ({ stdout } = await run("unzip", ["-p", zipPath, APP_JSON], { maxBuffer: 1024 * 1024 }));
  } catch {
    throw new Error(`${zipPath} does not hold ${APP_JSON}. Is it the zip from npm run build-app?`);
  }
  return JSON.parse(stdout);
}

/** The `latest.json` the hub's home page reads. */
export async function describeDownload({ zipPath, arch, now = () => new Date() }) {
  const app = await readAppJson(zipPath);
  if (!/^\d+\.\d+\.\d+$/.test(String(app.appVersion))) throw new Error(`The app in the zip has no usable version (${JSON.stringify(app.appVersion)}).`);
  const architecture = arch ?? app.arch;
  if (!["arm64", "x86_64"].includes(architecture)) throw new Error("The architecture is unknown: pass --arch arm64 or --arch x86_64 (rebuild the app to record it).");
  return {
    version: app.appVersion,
    file: `SimEyesStudio-${app.appVersion}.zip`,
    sha256: await sha256File(zipPath),
    bytes: (await stat(zipPath)).size,
    arch: architecture,
    macos: "13",
    publishedAt: now().toISOString(),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
  try {
    const zip = arg("--zip", join(REPO, "dist", "SimEyesStudio.zip"));
    const out = arg("--out", join(REPO, "downloads"));
    const info = await describeDownload({ zipPath: zip, arch: arg("--arch") });
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "latest.json"), `${JSON.stringify(info, null, 2)}\n`);
    console.log(`${info.file}: ${(info.bytes / 1024 / 1024).toFixed(1)} MB, ${info.arch}, sha256 ${info.sha256.slice(0, 12)}…`);
    const target = arg("--publish");
    if (target) {
      const base = target.replace(/\/+$/, "");
      await run("rsync", ["-a", "--partial", zip, `${base}/${info.file}`]);
      await run("rsync", ["-a", join(out, "latest.json"), `${base}/latest.json`]);
      console.log(`Published ${info.file} to ${target}`);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
