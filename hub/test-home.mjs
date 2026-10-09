import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EYE, homePage, readLatest, resolveDownload } from "./downloads.mjs";

const dir = await mkdtemp(join(tmpdir(), "hub-home-"));
const downloads = join(dir, "downloads");
const good = { version: "1.5.0", file: "SimEyesStudio-1.5.0.zip", sha256: "b".repeat(64), bytes: 48_459_418, arch: "arm64", macos: "13", publishedAt: "2026-10-02T00:00:00Z" };
const publish = async (info, { withFile = true } = {}) => {
  await mkdir(downloads, { recursive: true });
  await writeFile(join(downloads, "latest.json"), typeof info === "string" ? info : JSON.stringify(info));
  if (withFile) await writeFile(join(downloads, good.file), "zip");
};

try {
  // With a published app the page offers exactly that file and shows what a tester needs to check it.
  const page = homePage({ latest: good });
  assert.ok(page.includes(`href="/downloads/${good.file}"`));
  assert.ok(page.includes("Version 1.5.0") && page.includes("46 MB") && page.includes("Apple silicon"));
  assert.ok(page.includes("b".repeat(64)) && page.includes(`shasum -a 256 ~/Downloads/${good.file}`), "the checksum and the command to check it are shown");
  assert.ok(page.includes("Open Anyway") && page.includes("Invite Token") && page.includes("Connect to AI Tools"), "the first-launch steps a tester gets stuck on are on the page");
  assert.ok(homePage({ latest: { ...good, arch: "x86_64" } }).includes("Intel Macs"));
  assert.ok(page.includes('name="viewport"') && page.includes("prefers-color-scheme: dark"), "readable on a phone and in dark mode");

  // The logo is the eye from the promo video: the page, the app icon source and the promo must not drift apart.
  assert.ok(page.includes(`<svg class="logo" viewBox="0 0 64 64"`) && page.includes(EYE) && page.includes('rel="icon"'), "the page shows the logo and uses it as the favicon");
  const promo = await readFile(new URL("../promo/launch.html", import.meta.url), "utf8");
  const icon = await readFile(new URL("../app/icon.svg", import.meta.url), "utf8");
  for (const part of EYE.match(/<(?:path|circle|rect)[^>]*\/>/g)) {
    assert.ok(promo.includes(part), `promo/launch.html no longer has ${part.slice(0, 40)}`);
    assert.ok(icon.includes(part), `app/icon.svg no longer has ${part.slice(0, 40)}`);
  }

  // Nothing published: no button that leads nowhere.
  const empty = homePage({ latest: null });
  assert.ok(!empty.includes("/downloads/") && !empty.includes('class="button"'));
  assert.ok(empty.includes("not been published yet"));

  // Values land in HTML, so they are escaped.
  const hostile = homePage({ latest: { ...good, macos: '<script>alert(1)</script>', arch: "x86_64" } });
  assert.ok(!hostile.includes("<script>alert(1)</script>") && hostile.includes("&lt;script&gt;"));

  // latest.json is only believed when it is well formed, names a published zip, and that zip exists.
  assert.equal(await readLatest(dir), null, "no downloads folder");
  await publish(good);
  assert.deepEqual(await readLatest(dir), good);
  await publish(good, { withFile: false });
  await rm(join(downloads, good.file));
  assert.equal(await readLatest(dir), null, "a page must not offer a file that is not there");
  await publish("{not json");
  assert.equal(await readLatest(dir), null);
  // A zip that exists but is not the version latest.json claims must not be offered either (only the name/version match can reject it).
  await writeFile(join(downloads, "SimEyesStudio-2.0.0.zip"), "zip");
  for (const broken of [{ ...good, file: "../tokens.json" }, { ...good, file: "SimEyesStudio-2.0.0.zip" }, { ...good, version: "latest" }, { ...good, sha256: "xyz" }, { ...good, bytes: 0 }, { ...good, bytes: "big" }]) {
    await publish(broken);
    assert.equal(await readLatest(dir), null, `rejected: ${JSON.stringify(broken).slice(0, 60)}`);
  }

  await publish(good);
  assert.equal((await resolveDownload(dir, good.file)).bytes, 3);
  for (const name of ["../x.zip", "SimEyesStudio-1.5.0.zip/../latest.json", "latest.json", "SimEyesStudio-1.5.zip", ""]) assert.equal(await resolveDownload(dir, name), null, name);
  console.log("hub/test-home: ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}
