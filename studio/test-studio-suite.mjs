import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSessionPrefix } from "../client-sessions.mjs";
import { startStudio } from "./studio.mjs";

const root = await mkdtemp(join(tmpdir(), "studio-suite-"));
const video = join(root, "clip.mp4");
await writeFile(video, "mp4");
const UDID = "8F395E81-CF05-425A-B3C8-CA63CFDE8FD6";
let gate = Promise.resolve();
const sim = { acquires: 0, releases: 0 };
const text = (t, extra = {}) => ({ content: [{ type: "text", text: `${formatSessionPrefix("se-1", false)}${t}` }], ...extra });
const openSim = async () => ({
  async call(name, args = {}) {
    if (name === "acquire") return sim.acquires++, text(`Acquired.\nudid: ${UDID}`);
    if (name === "release") return sim.releases++, text("Released.");
    const [a] = args.actions;
    if (a.tool === "record" && a.action === "stop") return text(`1. record: stopped. Video: ${video}`);
    if (a.tool === "record") return text("1. record: started.");
    await gate;
    await writeFile(a.save, "png");
    return text(`1. ${a.tool}: done.\n   screen: "Home"\n   saved ${a.save}`);
  },
  async close() {},
});
const execCalls = [];
const exec = async (file, args) => (execCalls.push([file, ...args]), {});
const judged = [];
const judge = { info: { backend: "openrouter", model: "pplx-test" }, run: async (p) => (judged.push(p), { suggested: "pass", p: 0.93 }) };

const studio = await startStudio({ root, port: 0, openSim, exec, judge, mapClient: () => null, ledgerPath: join(root, "ledger.json") });
const port = studio.server.address().port;
const call = async (method, path, body) => {
  const res = await fetch(`${studio.url}${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const put = (path, body = "x") => new Promise((resolve, reject) => {
  const req = http.request({ host: "127.0.0.1", port, method: "PUT", path }, (res) => (res.resume(), res.on("end", () => resolve({ status: res.statusCode }))));
  req.on("error", reject);
  req.end(body);
});
const waitFor = async (fn) => {
  for (let i = 0; i < 200; i += 1) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("timed out");
};
const idle = () => waitFor(async () => (await call("GET", "/api/status")).data.activeSuite === null && (await call("GET", "/api/status")).data.activeRun === null);

try {
  assert.deepEqual((await call("GET", "/api/status")).data.judge, { backend: "openrouter", model: "pplx-test" }, "the page can say which judge is on");
  await call("POST", "/api/projects", { name: "Pdf Tools", app: "com.example.pdf" });
  const base = "/api/projects/pdf-tools";
  const lines = ['Chạm "Image to PDF"', "Kiểm tra thư viện ảnh được mở"];
  for (const [name, extra] of [
    ["Open library", { id: "TC-IMG-001", group: "Image to PDF / Điểm vào", priority: "P0", fixtures: ["photos-3"] }],
    ["Scan camera", { id: "TC-IMG-009", group: "Image to PDF / Điểm vào", priority: "P0", skip: { reason: "camera", note: "camera" } }],
    ["Pick one", { id: "TC-IMG-004", group: "Image to PDF / Điểm vào", priority: "P1" }],
    ["Other feature", { id: "TC-PDF-001", group: "PDF Converter", priority: "P0" }],
  ]) {
    await call("POST", `${base}/tests`, { name, ...extra });
    await call("PUT", `${base}/tests/${name.toLowerCase().replace(/ /g, "-")}`, { name, start: "fresh", lines, ...extra });
  }

  // Fixtures: a set names files inside the project's fixtures folder; the folder cannot be left.
  assert.equal((await put(`${base}/fixtures/files/photos/a.jpg`, "A")).status, 200);
  assert.equal((await put(`${base}/fixtures/files/photos/b.jpg`, "B")).status, 200);
  for (const bad of ["..%2F..%2Fescaped.txt", "photos%2F..%2F..%2Fescaped.txt", ".hidden", "%2Fetc%2Fpasswd"]) assert.ok((await put(`${base}/fixtures/files/${bad}`)).status >= 400, bad);
  const sets = { "photos-3": { photos: ["photos/*.jpg"] }, "fresh-permissions": { privacyReset: "all" } };
  const saved = await call("PUT", `${base}/fixtures`, { sets });
  assert.deepEqual(saved.data.files.map((f) => f.path), ["photos/a.jpg", "photos/b.jpg"]);
  assert.deepEqual(saved.data.sets["photos-3"], { photos: ["photos/*.jpg"] });
  assert.equal((await call("PUT", `${base}/fixtures`, { sets: { x: { photos: ["../../etc/passwd"] } } })).status, 400);
  assert.equal((await call("PUT", `${base}/fixtures`, { sets: { "bad name": {} } })).status, 400);

  // A group runs its tests one after another, skips the tagged one, and every run leases and releases once.
  const started = await call("POST", `${base}/suites`, { selector: { group: "Image to PDF" } });
  assert.equal(started.status, 200);
  assert.equal((await call("POST", `${base}/suites`, { selector: { group: "Image to PDF" } })).status, 409, "one suite at a time");
  assert.equal((await call("POST", `${base}/tests/other-feature/run`)).status, 409, "a single run cannot start inside a suite");
  await idle();
  const suite = (await call("GET", `${base}/suites/${started.data.stamp}`)).data;
  assert.equal(suite.status, "completed");
  assert.deepEqual(suite.items.map((i) => [i.id, i.state, i.status, i.suggestedVerdict, i.reason]), [
    ["TC-IMG-001", "done", "completed", "pass", undefined],
    ["TC-IMG-004", "done", "completed", "pass", undefined],
    ["TC-IMG-009", "skipped", undefined, undefined, "camera"],
  ]);
  assert.equal(sim.acquires, 2, "the skipped test never leased a simulator");
  assert.equal(sim.releases, sim.acquires, "no lease is left behind");
  assert.deepEqual((await call("GET", `${base}/suites`)).data.map((s) => s.stamp), [started.data.stamp]);

  // The fixtures went in before the first test; the second test lists none; the run records both the judge and the suggestion.
  const adds = execCalls.filter((c) => c[2] === "addmedia");
  assert.equal(adds.length, 1, "photos are added once");
  assert.deepEqual(adds[0].slice(3).map((f) => f.split("/").pop()), [UDID, "a.jpg", "b.jpg"]);
  const run = (await call("GET", `${base}/runs/open-library/${suite.items[0].runStamp}`)).data;
  assert.deepEqual(run.fixtures.applied, ["photos-3"]);
  assert.equal(run.suggestedVerdict, "pass");
  assert.deepEqual(run.judge, { backend: "openrouter", model: "pplx-test" });
  assert.equal(run.checkpoints[0].expected, "thư viện ảnh được mở");
  assert.equal(judged.length, 2);
  assert.match(judged[0].imagePath, /02\.png$/);

  // Stop: the run in flight ends at its next step, the rest are not run, and the simulator is released.
  let release;
  gate = new Promise((r) => (release = r));
  const before = sim.acquires;
  const stopping = await call("POST", `${base}/suites`, { selector: { priority: "P0" } });
  await waitFor(() => sim.acquires > before);
  assert.equal((await call("POST", `${base}/suites/${stopping.data.stamp}/stop`)).status, 200);
  release();
  await idle();
  const stopped = (await call("GET", `${base}/suites/${stopping.data.stamp}`)).data;
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.items[0].status, "stopped");
  assert.deepEqual(stopped.items.slice(1).filter((i) => i.state !== "skipped").map((i) => [i.state, i.reason]), [["not-run", "stopped"]]);
  assert.equal(sim.releases, sim.acquires);
  assert.equal((await call("POST", `${base}/suites/${stopping.data.stamp}/stop`)).status, 409, "stopping a finished suite is refused");
  assert.equal((await call("POST", `${base}/suites`, { selector: { group: "Nope" } })).status, 400);
  gate = Promise.resolve();

  // A single run can be stopped too.
  gate = new Promise((r) => (release = r));
  const single = await call("POST", `${base}/tests/pick-one/run`);
  assert.equal((await call("POST", `${base}/runs/pick-one/${single.data.stamp}/stop`)).status, 200);
  release();
  await idle();
  assert.equal((await call("GET", `${base}/runs/pick-one/${single.data.stamp}`)).data.status, "stopped");
  console.log("test-studio-suite: ok");
} finally {
  await studio.close();
  await rm(root, { recursive: true, force: true });
}
