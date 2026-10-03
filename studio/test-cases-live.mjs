#!/usr/bin/env node
// Manual: needs a free sim-pool simulator AND the judge (OPENROUTER_API_KEY in the environment). Runs the
// QA-sheet features end to end on a real simulator through server.mjs: Vietnamese lines, case fields, fixtures (a file in
// "On My iPhone", a permission reset, and photos, which fail on the iOS 27 beta), file checks, the judge's suggestions, a
// suite with a skipped case, and a verdict that overrides a suggestion. Writes the evidence to <out> (default
// .local/qa-evidence/test-cases/live). A busy pool exits 2 and proves nothing.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const { startStudio } = await import("./studio.mjs");
const here = dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? join(here, "..", ".local", "qa-evidence", "test-cases", "live");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const exec = promisify(execFile);
await mkdir(out, { recursive: true });

const root = await mkdtemp(join(tmpdir(), "studio-cases-live-"));
const studio = await startStudio({ root, port: 0 });
const api = async (method, path, body, raw = false) => {
  const res = await fetch(`${studio.url}${path}`, { method, headers: body && !raw ? { "content-type": "application/json" } : {}, body: raw ? body : body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  assert.ok(res.ok, `${method} ${path}: ${data.error}`);
  return data;
};
const idle = async () => {
  for (;;) {
    const s = await api("GET", "/api/status");
    if (!s.activeSuite && !s.activeRun) return;
    await new Promise((r) => setTimeout(r, 2000));
  }
};
const shot = async (name, hash, height = 1400) => {
  await exec(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--window-size=1100,${height}`, "--virtual-time-budget=8000", `--screenshot=${join(out, name)}`, `${studio.url}/${hash}`]).catch(() => {});
};

try {
  const status = await api("GET", "/api/status");
  assert.ok(status.judge, "no judge: set OPENROUTER_API_KEY");

  // Project 1: Settings (a system app): Vietnamese lines, judged checkpoints, fixtures that need no photos, a skip.
  await api("POST", "/api/projects", { name: "Settings QA", app: "com.apple.Preferences" });
  const s = "/api/projects/settings-qa";
  await api("PUT", `${s}/fixtures`, { sets: { "fresh-permissions": { privacyReset: "all" }, "photos-3": { photos: ["photos/*.jpg"] } } });
  await api("PUT", `${s}/fixtures/files/photos/a.jpg`, "A", true).catch(() => {});
  const cases = [
    ["Mở General rồi About", { id: "TC-SET-001", group: "Settings / About", priority: "P0", notes: "iOS 27.0", fixtures: ["fresh-permissions"] }, ["Chạm 'General'", "Kiểm tra màn hình General được mở", "Chạm 'About'", "Kiểm tra iOS Version là 27.0", "Quay lại", "Quay lại", "Kiểm tra danh sách Settings hiển thị Apple Account"]],
    ["Wi-Fi là hàng đầu tiên", { id: "TC-SET-002", group: "Settings / Danh sách", priority: "P1" }, ["Kiểm tra Wi-Fi là hàng đầu tiên của danh sách", "Chạm 'General'", "Kiểm tra màn hình About đang mở"]],
    ["Camera mở khi chụp", { id: "TC-SET-003", group: "Settings / Camera", priority: "P0", skip: { reason: "camera", note: "Cần camera thật" } }, ["Kiểm tra camera hoạt động"]],
    ["Ảnh trong thư viện", { id: "TC-SET-004", group: "Settings / Ảnh", priority: "P2", fixtures: ["photos-3"] }, ["Kiểm tra thư viện có 3 ảnh"]],
  ];
  for (const [name, extra, lines] of cases) {
    const slug = (await api("POST", `${s}/tests`, { name, ...extra })).slug;
    await api("PUT", `${s}/tests/${slug}`, { name, start: "relaunch", lines, ...extra });
  }
  const suite = await api("POST", `${s}/suites`, { selector: { group: "Settings" } });
  await idle();
  const done = await api("GET", `${s}/suites/${suite.stamp}`);
  await writeFile(join(out, "suite-settings.json"), `${JSON.stringify(done, null, 2)}\n`);
  if (done.status === "inconclusive") {
    console.log("inconclusive: no free simulator");
    process.exit(2);
  }
  const by = Object.fromEntries(done.items.map((i) => [i.id, i]));
  assert.equal(by["TC-SET-003"].state, "skipped");
  assert.equal(by["TC-SET-003"].reason, "camera");
  const run1 = await api("GET", `${s}/runs/${by["TC-SET-001"].test}/${by["TC-SET-001"].runStamp}`);
  await writeFile(join(out, "run-TC-SET-001.json"), `${JSON.stringify({ status: run1.status, fixtures: run1.fixtures, judge: run1.judge, suggestedVerdict: run1.suggestedVerdict, checkpoints: run1.checkpoints, warnings: run1.warnings }, null, 2)}\n`);
  assert.equal(run1.status, "completed", run1.reason);
  assert.equal(run1.fixtures.ok, true);
  assert.deepEqual(run1.fixtures.privacy, ["all"]);
  assert.equal(run1.checkpoints.length, 3, "three Kiểm tra lines");
  assert.ok(run1.checkpoints.every((c) => c.image && ["pass", "fail", "unsure"].includes(c.suggested)));
  const run2 = await api("GET", `${s}/runs/${by["TC-SET-002"].test}/${by["TC-SET-002"].runStamp}`);
  const run4 = await api("GET", `${s}/runs/${by["TC-SET-004"].test}/${by["TC-SET-004"].runStamp}`);
  await writeFile(join(out, "run-TC-SET-002.json"), `${JSON.stringify({ status: run2.status, suggestedVerdict: run2.suggestedVerdict, checkpoints: run2.checkpoints }, null, 2)}\n`);
  await writeFile(join(out, "run-TC-SET-004.json"), `${JSON.stringify({ status: run4.status, failedAt: run4.failedAt, reason: run4.reason, fixtures: run4.fixtures }, null, 2)}\n`);
  assert.equal(run4.failedAt, "fixtures", "photos need an iOS 26 simulator: on the iOS 27 beta the run says so");

  // The reviewer's verdict overrides the suggestion; the run keeps both.
  const wrong = run1.suggestedVerdict === "pass" ? "fail" : "pass";
  const judged = await api("PUT", `${s}/runs/${by["TC-SET-001"].test}/${by["TC-SET-001"].runStamp}/verdict`, { result: wrong, note: "override check" });
  assert.equal(judged.verdict.result, wrong);
  assert.equal(judged.suggestedVerdict, run1.suggestedVerdict);

  // Project 2: Files, with a PDF copied into "On My iPhone" and checked from the file itself.
  await api("POST", "/api/projects", { name: "Files QA", app: "com.apple.DocumentsApp" });
  const f = "/api/projects/files-qa";
  await api("PUT", `${f}/fixtures/files/files/sample3.pdf`, await readFile(join(here, "fixtures", "pdf", "color-3-pages-a4.pdf")), true);
  await api("PUT", `${f}/fixtures`, { sets: { docs: { files: ["files/sample3.pdf"] } } });
  const fileCase = ["Kiểm tra file PDF", { id: "TC-FILE-001", group: "Files / Kiểm tra file", priority: "P0", fixtures: ["docs"] },
    ["Chạm 'Browse'", "Kiểm tra file 'sample3.pdf' tồn tại", "Kiểm tra file 'sample3.pdf' có 3 trang", "Kiểm tra file 'sample3.pdf' có 2 trang", "Kiểm tra file 'sample3.pdf' là A4 dọc", "Kiểm tra file 'sample3.pdf' có màu xám", "Kiểm tra file 'sample3.pdf': trang 1 màu đỏ, trang 2 màu xanh lá, trang 3 màu xanh dương"]];
  const slug = (await api("POST", `${f}/tests`, { name: fileCase[0], ...fileCase[1] })).slug;
  await api("PUT", `${f}/tests/${slug}`, { name: fileCase[0], start: "relaunch", lines: fileCase[2], ...fileCase[1] });
  const filesRun = await api("POST", `${f}/tests/${slug}/run`);
  await idle();
  const run5 = await api("GET", `${f}/runs/${slug}/${filesRun.stamp}`);
  await writeFile(join(out, "run-TC-FILE-001.json"), `${JSON.stringify({ status: run5.status, fixtures: run5.fixtures, suggestedVerdict: run5.suggestedVerdict, judge: run5.judge, checkpoints: run5.checkpoints, warnings: run5.warnings }, null, 2)}\n`);
  assert.equal(run5.status, "completed", run5.reason);
  const got = Object.fromEntries(run5.checkpoints.map((c) => [c.expected, c.suggested]));
  assert.equal(got["file 'sample3.pdf' tồn tại"], "pass");
  assert.equal(got["file 'sample3.pdf' có 3 trang"], "pass");
  assert.equal(got["file 'sample3.pdf' có 2 trang"], "fail");
  assert.equal(got["file 'sample3.pdf' là A4 dọc"], "pass");
  assert.equal(got["file 'sample3.pdf' có màu xám"], "fail");
  assert.equal(got["file 'sample3.pdf': trang 1 màu đỏ, trang 2 màu xanh lá, trang 3 màu xanh dương"], "pass", "the judge reads the drawn pages in order");
  assert.equal(run5.suggestedVerdict, "fail");

  await shot("suite-table.png", `#/p/settings-qa/suite/${suite.stamp}`, 700);
  await shot("review-suggested.png", `#/p/settings-qa/t/${by["TC-SET-001"].test}/run/${by["TC-SET-001"].runStamp}`, 2600);
  await shot("review-fixtures-failed.png", `#/p/settings-qa/t/${by["TC-SET-004"].test}/run/${by["TC-SET-004"].runStamp}`, 900);
  await shot("review-file-checks.png", `#/p/files-qa/t/${slug}/run/${filesRun.stamp}`, 3200);
  await shot("project-list.png", "#/p/settings-qa", 900);
  console.log("test-cases-live: ok");
} finally {
  await studio.close();
  await rm(root, { recursive: true, force: true });
}
