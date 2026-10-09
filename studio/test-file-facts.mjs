import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkFile, ensurePdfBinary, evaluateFileOp, findSavedFile, pdfFacts, renderPages } from "./file-facts.mjs";

const PDF = (name) => new URL(`./fixtures/pdf/${name}`, import.meta.url).pathname;
const UDID = "8F395E81-CF05-425A-B3C8-CA63CFDE8FD6";

// The real PDFKit helper, compiled from pdf-facts.swift on this Mac: facts must come from the file, not from a stub.
assert.equal(await ensurePdfBinary({ prebuilt: "/app/bin/pdf-facts", exists: (p) => p === "/app/bin/pdf-facts" }), "/app/bin/pdf-facts", "the app ships pdf-facts compiled and has no .swift: the named binary is used without compiling");
const binary = await ensurePdfBinary({ prebuilt: undefined });
const deps = { binary };

const three = await pdfFacts(PDF("color-3-pages-a4.pdf"), deps);
assert.equal(three.pages, 3);
assert.deepEqual(three.sizes[0], { width: 595, height: 842 }, "A4 portrait is 595 x 842 pt");
assert.deepEqual(three.grayscale, [false, false, false], "a coloured export is not grayscale");
assert.equal(three.locked, false);
const gray = await pdfFacts(PDF("gray-2-pages-a4.pdf"), deps);
assert.deepEqual([gray.pages, gray.grayscale], [2, [true, true]]);
const mixed = await pdfFacts(PDF("mixed-portrait-landscape.pdf"), deps);
assert.deepEqual(mixed.sizes, [{ width: 595, height: 842 }, { width: 842, height: 595 }], "a rotated or landscape page keeps its real width and height");
const locked = await pdfFacts(PDF("locked.pdf"), deps);
assert.deepEqual([locked.locked, locked.pages], [true, 0]);

// Each op answers from the facts; a locked file is "cannot read", never a pass or a fail.
const ev = (file, facts, other) => evaluateFileOp(file, facts, other);
assert.equal(ev({ op: "pages", n: 3 }, three).ok, true);
assert.equal(ev({ op: "pages", n: 2 }, three).ok, false);
assert.match(ev({ op: "pages", n: 2 }, three).detail, /has 3 pages; expected 2/);
assert.equal(ev({ op: "a4" }, three).ok, true);
assert.equal(ev({ op: "a4", orientation: "portrait" }, three).ok, true);
assert.equal(ev({ op: "a4", orientation: "landscape" }, three).ok, false, "A4 portrait pages are not A4 landscape");
assert.equal(ev({ op: "a4" }, mixed).ok, true, "either orientation is A4");
assert.equal(ev({ op: "a4", orientation: "portrait" }, mixed).ok, false);
assert.match(ev({ op: "a4", orientation: "portrait" }, mixed).detail, /Page 2 is 842 x 595/);
assert.equal(ev({ op: "a4" }, { ...three, sizes: [{ width: 612, height: 792 }] }).ok, false, "US Letter is not A4");
assert.equal(ev({ op: "a4" }, { ...three, sizes: [{ width: 596, height: 841 }] }).ok, true, "rounding of a point or two is still A4");
assert.equal(ev({ op: "gray" }, gray).ok, true);
assert.equal(ev({ op: "gray" }, three).ok, false);
assert.match(ev({ op: "gray" }, three).detail, /Page 1 has color/);
assert.equal(ev({ op: "color" }, three).ok, true);
assert.equal(ev({ op: "color" }, gray).ok, false);
assert.equal(ev({ op: "locked" }, locked).ok, true);
assert.equal(ev({ op: "locked" }, three).ok, false);
assert.equal(ev({ op: "pages", n: 3 }, locked).ok, null, "a locked PDF cannot be counted");
assert.equal(ev({ op: "smaller", other: "b.pdf" }, gray, three).ok, true, "the grayscale export is the smaller file");
assert.equal(ev({ op: "smaller", other: "b.pdf" }, three, gray).ok, false);
assert.equal(ev({ op: "smaller", other: "b.pdf" }, three, null).ok, null);
assert.equal(ev({ op: "nonsense" }, three).ok, null);

// Pages are drawn upright and as JPEGs, for the judge.
const scratch = await mkdtemp(join(tmpdir(), "studio-file-facts-"));
try {
  const pages = await renderPages(PDF("color-3-pages-a4.pdf"), join(scratch, "out"), { maxPages: 2, ...deps });
  assert.deepEqual(pages.map((p) => p.split("/").pop()), ["page-1.jpg", "page-2.jpg"], "page order is the file's order");
  const head = await readFile(pages[0]);
  assert.deepEqual([head[0], head[1]], [0xff, 0xd8], "a JPEG");
  await assert.rejects(renderPages(PDF("locked.pdf"), join(scratch, "o2"), deps), /locked/);

  // Where the app saves: "On My iPhone" (the LocalStorage app group) and the app's own Documents; the newest copy wins.
  const devicesRoot = join(scratch, "Devices");
  const group = join(devicesRoot, UDID, "data", "Containers", "Shared", "AppGroup", "BBB");
  const myIphone = join(group, "File Provider Storage");
  await mkdir(join(myIphone, "Exports"), { recursive: true });
  await writeFile(join(group, ".com.apple.mobile_container_manager.metadata.plist"), "bplist00 group.com.apple.FileProvider.LocalStorage");
  const appData = join(scratch, "AppData");
  await mkdir(join(appData, "Documents"), { recursive: true });
  await copyFile(PDF("color-3-pages-a4.pdf"), join(myIphone, "Exports", "Doc.pdf"));
  await copyFile(PDF("gray-2-pages-a4.pdf"), join(appData, "Documents", "Doc.pdf"));
  await utimes(join(myIphone, "Exports", "Doc.pdf"), new Date("2026-10-01"), new Date("2026-10-01"));
  await utimes(join(appData, "Documents", "Doc.pdf"), new Date("2026-10-02"), new Date("2026-10-02"));
  const exec = async (cmd, args) => (assert.deepEqual([cmd, ...args], ["xcrun", "simctl", "get_app_container", UDID, "com.example.app", "data"]), { stdout: `${appData}\n` });
  const found = await findSavedFile({ udid: UDID, name: "Doc.pdf", bundleId: "com.example.app", exec, devicesRoot });
  assert.equal(found.path, join(appData, "Documents", "Doc.pdf"), "the file saved last is the one under test");
  assert.equal((await findSavedFile({ udid: UDID, name: "Doc.pdf", exec, devicesRoot })).path, join(myIphone, "Exports", "Doc.pdf"));
  assert.equal((await findSavedFile({ udid: UDID, name: "Nope.pdf", exec, devicesRoot })).path, null);
  await assert.rejects(findSavedFile({ udid: UDID, name: "../x.pdf", exec, devicesRoot }), /no folders/);
  const notInstalled = await findSavedFile({ udid: UDID, name: "Doc.pdf", bundleId: "com.example.app", exec: async () => { throw new Error("not installed"); }, devicesRoot });
  assert.ok(notInstalled.path, "an app that is not installed still leaves 'On My iPhone' to search");

  // The checkpoint answer for a file line: code's answer is certain; what cannot be read is "unsure".
  const check = (file, extra = {}) => checkFile({ file, udid: UDID, bundleId: "com.example.app", imageDir: join(scratch, "images"), deps: { ...deps, exec, devicesRoot, ...extra } });
  assert.deepEqual(await check({ name: "Doc.pdf", op: "exists" }), { suggested: "pass", p: 1, source: "code", detail: "The file exists." });
  const missing = await check({ name: "Gone.pdf", op: "exists" });
  assert.deepEqual([missing.suggested, missing.p], ["fail", 1]);
  assert.match(missing.detail, /not on the simulator \(searched 2 locations\)/);
  assert.equal((await check({ name: "Doc.pdf", op: "pages", n: 2 })).suggested, "pass", "the newest Doc.pdf has 2 pages");
  assert.equal((await check({ name: "Doc.pdf", op: "pages", n: 3 })).suggested, "fail");
  assert.equal((await check({ name: "Doc.pdf", op: "gray" })).suggested, "pass");
  await copyFile(PDF("locked.pdf"), join(myIphone, "Exports", "Secret.pdf"));
  const lockedCheck = await check({ name: "Secret.pdf", op: "pages", n: 3 });
  assert.deepEqual([lockedCheck.suggested, lockedCheck.p], ["unsure", null]);
  assert.equal((await check({ name: "Secret.pdf", op: "locked" })).suggested, "pass");
  await writeFile(join(myIphone, "Exports", "notes.txt"), "t");
  assert.equal((await check({ name: "notes.txt", op: "exists" })).suggested, "pass");
  assert.equal((await check({ name: "notes.txt", op: "pages", n: 1 })).suggested, "unsure", "only a PDF can be counted");
  const smaller = await check({ name: "Doc.pdf", op: "smaller", other: "Secret.pdf" });
  assert.equal(smaller.suggested, "pass", "size is the file's bytes: a locked file can still be compared");
  const visual = await check({ name: "Doc.pdf", op: "visual", about: "pages in order" });
  assert.equal(visual.source, "judge");
  assert.equal(visual.images.length, 2);
  assert.ok((await readFile(visual.images[0])).length > 100, "the drawn pages were kept beside the run");
  const noSim = await checkFile({ file: { name: "Doc.pdf", op: "exists" }, udid: "11111111-CF05-425A-B3C8-CA63CFDE8FD6", imageDir: scratch, deps: { exec, devicesRoot } });
  assert.equal(noSim.suggested, "unsure", "a simulator that cannot be searched is unsure, not a failed file");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
console.log("test-file-facts: ok");
