import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFixtures, expandPaths, onMyIphoneDir } from "./fixtures.mjs";

const UDID = "8F395E81-CF05-425A-B3C8-CA63CFDE8FD6";
const root = await mkdtemp(join(tmpdir(), "studio-fixtures-"));
const fixturesDir = join(root, "fixtures");
const ledgerPath = join(root, "ledger.json");
const devicesRoot = join(root, "Devices");
try {
  await mkdir(join(fixturesDir, "photos"), { recursive: true });
  await mkdir(join(fixturesDir, "files"), { recursive: true });
  for (const [n, c] of [["photo10.jpg", "J10"], ["photo2.jpg", "J2"], ["photo1.jpg", "J1"], ["copy-of-1.jpg", "J1"]]) await writeFile(join(fixturesDir, "photos", n), c);
  await writeFile(join(fixturesDir, "files", "a.pdf"), "PDF-A");
  await writeFile(join(fixturesDir, "files", "locked.pdf"), "PDF-LOCKED");
  await writeFile(join(fixturesDir, "files", "notes.txt"), "txt");
  // A simulator's app groups: only the LocalStorage group is "On My iPhone".
  const groups = join(devicesRoot, UDID, "data", "Containers", "Shared", "AppGroup");
  for (const [dir, id] of [["AAA", "group.com.apple.DocumentManager"], ["BBB", "group.com.apple.FileProvider.LocalStorage"]]) {
    await mkdir(join(groups, dir, "File Provider Storage"), { recursive: true });
    await writeFile(join(groups, dir, ".com.apple.mobile_container_manager.metadata.plist"), `bplist00 MCMMetadataIdentifier ${id}`);
  }
  const sets = {
    "photos-3": { photos: ["photos/photo1.jpg", "photos/photo2.jpg", "photos/photo10.jpg"] },
    "photos-all": { photos: ["photos/*.jpg"] },
    docs: { files: ["files/*.pdf"] },
    "fresh-permissions": { privacyReset: "all" },
    "photos-reset": { privacyReset: ["photos", "photos-add"] },
    bad: { photos: ["../outside.jpg"] },
    missing: { photos: ["photos/nope.jpg"] },
    typo: { privacyReset: "camera" },
  };
  const calls = [];
  const allCalls = [];
  const exec = async (file, args) => (allCalls.push([file, ...args]), args[1] === "bootstatus" ? {} : (calls.push([file, ...args]), {}));
  const apply = (names, extra = {}) => applyFixtures({ udid: UDID, names, sets, fixturesDir, exec, ledgerPath, devicesRoot, ...extra });

  // Globs are sorted the way a person counts (2 before 10), so the picker order does not change from run to run.
  assert.deepEqual((await expandPaths(fixturesDir, ["photos/photo*.jpg"])).map((f) => f.split("/").pop()), ["photo1.jpg", "photo2.jpg", "photo10.jpg"]);

  // Photos are added once per simulator: a second run on the same leased simulator must not pile up duplicates in the picker.
  // The simulator is waited for before anything is added or reset: on a device still booting, simctl fails with error 405.
  const first = await apply(["photos-3"]);
  assert.deepEqual(allCalls[0], ["xcrun", "simctl", "bootstatus", UDID, "-b"]);
  assert.equal(allCalls[1][2], "addmedia");
  assert.equal(first.photos, 3);
  assert.deepEqual(calls[0].slice(0, 3), ["xcrun", "simctl", "addmedia"]);
  assert.deepEqual(calls[0].slice(4).map((f) => f.split("/").pop()), ["photo1.jpg", "photo2.jpg", "photo10.jpg"], "one call, in the order the set lists them");
  const second = await apply(["photos-3"]);
  assert.equal(second.photos, 0);
  assert.equal(calls.length, 1, "photos are added once per simulator");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(ledger[UDID].photos.length, 3);
  // The same bytes under another name are the same photo; a different set adds only what is new.
  const third = await apply(["photos-all"]);
  assert.equal(third.photos, 0, "photo1.jpg and copy-of-1.jpg are one picture; the rest were added already");
  // Another simulator has its own library.
  const OTHER = "11111111-CF05-425A-B3C8-CA63CFDE8FD6";
  const other = await applyFixtures({ udid: OTHER, names: ["photos-3"], sets, fixturesDir, exec, ledgerPath, devicesRoot });
  assert.equal(other.photos, 3);

  // Files land in "On My iPhone", not in the other app groups.
  const docs = await apply(["docs"]);
  assert.equal(docs.files, 2);
  assert.deepEqual((await readdir(join(groups, "BBB", "File Provider Storage"))).sort(), ["a.pdf", "locked.pdf"]);
  assert.deepEqual(await readdir(join(groups, "AAA", "File Provider Storage")), []);
  assert.equal(await readFile(join(groups, "BBB", "File Provider Storage", "locked.pdf"), "utf8"), "PDF-LOCKED");
  assert.equal(await onMyIphoneDir(UDID, devicesRoot), join(groups, "BBB", "File Provider Storage"));
  await assert.rejects(onMyIphoneDir(OTHER, devicesRoot), /Could not find "On My iPhone"/);

  // The permission reset brings the first-run prompt back; with a bundle it touches only that app.
  calls.length = 0;
  await apply(["fresh-permissions"], { bundleId: "com.example.app" });
  assert.deepEqual(calls[0], ["xcrun", "simctl", "privacy", UDID, "reset", "all", "com.example.app"]);
  calls.length = 0;
  assert.deepEqual((await apply(["photos-reset"])).privacy, ["photos", "photos-add"]);
  assert.deepEqual(calls[0], ["xcrun", "simctl", "privacy", UDID, "reset", "photos"]);
  await assert.rejects(apply(["typo"]), /Unknown permission "camera"/, "simctl has no camera service: say so instead of failing inside it");

  // A bad set fails the fixtures phase with a sentence a tester can act on, and never reads outside the folder.
  await assert.rejects(apply(["nope"]), /fixture set "nope" is not defined/);
  await assert.rejects(apply(["bad"]), /outside the fixtures folder/);
  await assert.rejects(apply(["missing"]), /does not exist/);
  await writeFile(join(root, "secret.jpg"), "s");
  await symlink(join(root, "secret.jpg"), join(fixturesDir, "photos", "link.jpg"));
  await assert.rejects(expandPaths(fixturesDir, ["photos/link.jpg"]), /leads outside the fixtures folder/, "a symlink out of the folder is refused");
  await rm(join(fixturesDir, "photos", "link.jpg"));
  await assert.rejects(applyFixtures({ udid: "../x", names: ["docs"], sets, fixturesDir, exec, ledgerPath, devicesRoot }), /Not a simulator id/);
  assert.deepEqual(await apply([]), { applied: [], photos: 0, files: 0, privacy: [] }, "a test with no fixtures changes nothing");

  // The iOS 27 failure seen in Phase 0 is named, so the tester knows it is the simulator and not the test.
  const failing = async (_file, args) => args[1] !== "addmedia" ? {} : Promise.reject(Object.assign(new Error("x"), { stderr: "Failed to import 'a.jpg', error [PHPhotosErrorDomain] 3301: The operation couldn’t be completed.\n" }));
  await assert.rejects(applyFixtures({ udid: OTHER, names: ["photos-all"], sets, fixturesDir, exec: failing, ledgerPath: join(root, "l2.json"), devicesRoot }), /simctl addmedia failed.*iOS 26 simulator/s);
  assert.deepEqual(JSON.parse(await readFile(ledgerPath, "utf8"))[OTHER].photos.length, 3, "a failed add records nothing, so it is tried again");
  console.log("test-fixtures: ok");
} finally {
  await rm(root, { recursive: true, force: true });
}
