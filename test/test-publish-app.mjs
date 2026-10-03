import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describeDownload } from "../scripts/publish-app.mjs";

const run = promisify(execFile);
const dir = await mkdtemp(join(tmpdir(), "publish-app-"));

/** A zip shaped like dist/SimEyesStudio.zip, made the way build-app.sh makes it. */
async function fakeZip(name, appJson) {
  const root = join(dir, `src-${name}`, "SimEyesStudio.app", "Contents", "Resources");
  await mkdir(root, { recursive: true });
  if (appJson) await writeFile(join(root, "app.json"), JSON.stringify(appJson));
  else await writeFile(join(root, "other.txt"), "x");
  const zip = join(dir, `${name}.zip`);
  await run("ditto", ["-c", "-k", "--keepParent", join(dir, `src-${name}`, "SimEyesStudio.app"), zip]);
  return zip;
}

try {
  // The page must describe the file it offers, so version and arch come from inside the zip, and the hash is of the bytes.
  const zip = await fakeZip("ok", { appVersion: "1.5.0", arch: "arm64", hubUrl: "https://x", depsHash: "d" });
  const info = await describeDownload({ zipPath: zip, now: () => new Date("2026-10-02T00:00:00Z") });
  assert.equal(info.version, "1.5.0");
  assert.equal(info.file, "SimEyesStudio-1.5.0.zip");
  assert.equal(info.arch, "arm64");
  assert.equal(info.sha256, createHash("sha256").update(await readFile(zip)).digest("hex"));
  assert.equal(info.bytes, (await readFile(zip)).length);
  assert.equal(info.publishedAt, "2026-10-02T00:00:00.000Z");

  // An older build without arch needs it said; a wrong value is refused rather than shown to testers.
  const old = await fakeZip("old", { appVersion: "1.4.0" });
  await assert.rejects(describeDownload({ zipPath: old }), /architecture is unknown/);
  assert.equal((await describeDownload({ zipPath: old, arch: "x86_64" })).arch, "x86_64");
  await assert.rejects(describeDownload({ zipPath: old, arch: "ppc" }), /architecture is unknown/);

  // Not our zip, or no version: nothing is published.
  await assert.rejects(describeDownload({ zipPath: await fakeZip("foreign", null) }), /does not hold/);
  await assert.rejects(describeDownload({ zipPath: await fakeZip("nover", { appVersion: "latest", arch: "arm64" }) }), /no usable version/);
  await assert.rejects(describeDownload({ zipPath: join(dir, "missing.zip") }), /does not hold/);

  console.log("test-publish-app: ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}
