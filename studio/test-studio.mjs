import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSessionPrefix } from "../client-sessions.mjs";
import { startStudio } from "./studio.mjs";

const root = await mkdtemp(join(tmpdir(), "studio-http-"));
const video = join(root, "clip.mp4");
await writeFile(video, "0123456789");

// A sim-eyes whose steps wait on `gate`, so a run can be held open.
let gate = Promise.resolve();
const text = (t, extra = {}) => ({ content: [{ type: "text", text: `${formatSessionPrefix("se-1", false)}${t}` }], ...extra });
const openSim = async () => ({
  async call(name, args = {}) {
    if (name === "acquire") return text("Acquired.\nudid: 8F395E81-CF05-425A-B3C8-CA63CFDE8FD6");
    if (name === "release") return text("Released.");
    const [a] = args.actions;
    if (a.tool === "record" && a.action === "stop") return text(`1. record: stopped. Video: ${video}`);
    if (a.tool === "record") return text("1. record: started.");
    await gate;
    await writeFile(a.save, "png");
    return text(`1. ${a.tool}: done.\n   screen: "Home"\n   saved ${a.save}`);
  },
  async close() {},
});

const studio = await startStudio({ root, port: 0, openSim, mapClient: () => null });
const port = studio.server.address().port;
const get = (path, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: "127.0.0.1", port, path, headers }, (res) => {
    const chunks = [];
    res.on("data", (c) => chunks.push(c));
    res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
  }).on("error", reject);
});
const call = async (method, path, body, headers = {}) => {
  const res = await fetch(`${studio.url}${path}`, { method, headers: body === undefined ? headers : { "content-type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, data: await res.json().catch(() => null) };
};
const waitFor = async (fn) => {
  for (let i = 0; i < 100; i += 1) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.fail("timed out");
};

try {
  // The launcher and the review page show which code is running: VERSION in a downloaded bundle, package.json otherwise.
  assert.equal((await call("GET", "/api/status")).data.bundleVersion, JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version);

  assert.equal((await call("POST", "/api/projects", { name: "Settings QA", app: "com.apple.Preferences" })).status, 200);
  assert.equal((await call("POST", "/api/projects/settings-qa/tests", { name: "Open About" })).data.slug, "open-about");
  assert.equal((await call("POST", "/api/projects/settings-qa/tests", { name: "Open About" })).status, 409);

  // Save maps each line; with no key the free line is a goal with a warning.
  const saved = await call("PUT", "/api/projects/settings-qa/tests/open-about", { name: "Open About", start: "relaunch", lines: ['Tap "General"', "open the About page", "# note", "Check the iOS version is shown"] });
  assert.deepEqual(saved.data.lines.map((l) => l.how), ["phrase", "goal-fallback", "comment", "phrase"]);
  assert.match(saved.data.lines[1].warning, /TYPESAFE_API_KEY/);
  assert.equal((await call("PUT", "/api/projects/settings-qa/tests/open-about", { name: "x", start: "sometimes", lines: [] })).status, 400);

  // One run at a time: a second Run is refused while one is open.
  let release;
  gate = new Promise((r) => (release = r));
  const started = await call("POST", "/api/projects/settings-qa/tests/open-about/run");
  assert.equal(started.status, 200);
  const second = await call("POST", "/api/projects/settings-qa/tests/open-about/run");
  assert.equal(second.status, 409);
  assert.match(second.data.error, /already in progress/);
  assert.equal((await call("GET", `/api/projects/settings-qa/runs/open-about/${started.data.stamp}`)).data.status, "running");

  // Events replay from the start and end with run-end.
  const sse = fetch(`${studio.url}/api/runs/${encodeURIComponent(started.data.runId)}/events`).then((r) => r.text());
  release();
  const events = (await sse).split("\n\n").filter(Boolean).map((e) => JSON.parse(e.replace(/^data: /, "")));
  assert.deepEqual(events.filter((e) => e.type === "step-end").map((e) => e.n), [0, 1, 2, 3]);
  assert.equal(events.at(-1).type, "run-end");
  const run = (await call("GET", `/api/projects/settings-qa/runs/open-about/${started.data.stamp}`)).data;
  assert.equal(run.status, "completed");
  assert.equal(run.steps.length, 4);
  assert.ok(existsSync(join(root, "settings-qa", "runs", "open-about", started.data.stamp, "03.png")));

  // A run that is still going cannot be deleted (it is writing into its folder); a finished one can.
  assert.equal((await call("DELETE", `/api/projects/settings-qa/runs/open-about/${started.data.stamp}`)).status, 200);
  assert.equal((await call("GET", "/api/projects/settings-qa/runs/open-about")).data.length, 0);
  assert.ok(!existsSync(join(root, "settings-qa", "runs", "open-about", started.data.stamp)), "the run folder with its screenshots is gone");
  gate = new Promise((r) => (release = r));
  const again = await call("POST", "/api/projects/settings-qa/tests/open-about/run");
  assert.equal((await call("DELETE", `/api/projects/settings-qa/runs/open-about/${again.data.stamp}`)).status, 409);
  assert.equal((await call("DELETE", "/api/projects/settings-qa/runs/open-about")).data.deleted, 0, "delete-all skips the active run");
  assert.equal((await call("DELETE", "/api/projects/settings-qa/runs/open-about/notastamp")).status, 400);
  release();
  await waitFor(async () => (await call("GET", "/api/status")).data.activeRun === null);
  started.data.stamp = again.data.stamp;

  // The verdict survives a reload because it is in run.json and the history lists it.
  assert.equal((await call("PUT", `/api/projects/settings-qa/runs/open-about/${started.data.stamp}/verdict`, { result: "pass", note: "ok" })).data.verdict.result, "pass");
  const history = (await call("GET", "/api/projects/settings-qa/runs/open-about")).data;
  assert.equal(history[0].verdict.note, "ok");
  assert.equal((await call("POST", "/api/projects/settings-qa/tests/open-about/run")).status, 200, "a new run starts once the last one ended");
  await waitFor(async () => (await call("GET", "/api/status")).data.activeRun === null);

  // A run cut off by a Studio restart must not show as running forever.
  const stale = "20200101-000000";
  await (await import("./store.mjs")).writeRun(root, "settings-qa", "open-about", stale, { test: { name: "x", start: "fresh", lines: [] }, status: "running", steps: [], startedAt: "2020-01-01T00:00:00Z" });
  assert.equal((await call("GET", `/api/projects/settings-qa/runs/open-about/${stale}`)).data.status, "error");

  // Files: inside the project folder only; video supports ranges.
  const png = await get(`/files/settings-qa/runs/open-about/${started.data.stamp}/01.png`);
  assert.equal(png.status, 200);
  assert.equal(png.headers["content-type"], "image/png");
  assert.equal((await get("/files/..%2f..%2fetc%2fpasswd")).status, 404);
  assert.notEqual((await get("/files/settings-qa/../../../etc/passwd")).status, 200);
  const ranged = await get(`/files/settings-qa/runs/open-about/${started.data.stamp}/video.mp4`, { range: "bytes=2-5" });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.body, "2345");

  // Another web page must not drive Studio through the tester's browser.
  assert.equal((await get("/api/projects", { host: "evil.example" })).status, 403);
  assert.equal((await get("/api/projects", { origin: "http://evil.example" })).status, 403);
  assert.equal((await get("/api/projects", { origin: studio.url })).status, 200);

  // Uploads: a path out of the upload folder writes nothing; a wrong kind of file is refused with the page's message.
  const { uploadId } = (await call("POST", "/api/projects/settings-qa/uploads")).data;
  // Raw requests: fetch would fold %2e%2e into the URL path before sending it.
  const put = (path) => new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "PUT", path: `/api/projects/settings-qa/uploads/${uploadId}/${path}` }, (res) => (res.resume(), res.on("end", () => resolve({ status: res.statusCode }))));
    req.on("error", reject);
    req.end("x");
  });
  assert.equal((await put("X.app/Info.plist")).status, 200);
  for (const bad of ["%2e%2e/%2e%2e/escaped.txt", "X.app%2f..%2f..%2f..%2fescaped.txt", "..%2f..%2fescaped.txt"]) assert.ok((await put(bad)).status >= 400, bad);
  assert.ok(!existsSync(join(root, "settings-qa", "escaped.txt")) && !existsSync(join(root, "settings-qa", "builds", "escaped.txt")));
  assert.equal((await call("DELETE", `/api/projects/settings-qa/uploads/${uploadId}`)).status, 200);
  const dmg = await fetch(`${studio.url}/api/projects/settings-qa/builds?name=app.dmg`, { method: "POST", body: "x" });
  assert.equal(dmg.status, 400);
  assert.match((await dmg.json()).error, /Drop a simulator \.app/);
  assert.equal((await call("PUT", "/api/projects/settings-qa/build", { id: "nope" })).status, 404);

  // The page is served.
  assert.match((await get("/")).body, /sim-eyes Studio/);
  assert.equal((await get("/server.mjs")).status, 404);
  console.log("test-studio: ok");
} finally {
  await studio.close();
  await rm(root, { recursive: true, force: true });
}
