#!/usr/bin/env node
// Manual: needs a free simulator in sim-pool (and TYPESAFE_API_KEY for the AI-mapped line). Starts Studio on a temp
// folder, saves a test through its API, runs it on a real simulator through server.mjs and checks the run folder.
// A busy pool makes the run inconclusive; this script then exits 2 and proves nothing.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStudio } from "./studio.mjs";

const root = await mkdtemp(join(tmpdir(), "studio-live-"));
const studio = await startStudio({ root, port: 0 });
const api = async (method, path, body) => {
  const res = await fetch(`${studio.url}${path}`, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  assert.ok(res.ok, `${method} ${path}: ${data.error}`);
  return data;
};
async function runAndWait(test) {
  const { stamp } = await api("POST", `/api/projects/live/tests/${test}/run`);
  for (;;) {
    const run = await api("GET", `/api/projects/live/runs/${test}/${stamp}`);
    if (run.status !== "running") return { run, dir: join(root, "live", "runs", test, stamp) };
    await new Promise((r) => setTimeout(r, 2000));
  }
}

try {
  await api("POST", "/api/projects", { name: "Live", app: "com.apple.Preferences" });
  for (const name of ["Passes", "Missing tap"]) await api("POST", "/api/projects/live/tests", { name });
  const saved = await api("PUT", "/api/projects/live/tests/passes", { name: "Passes", start: "relaunch", lines: ["# a note", "Check the Settings app is open", "Wait 1 seconds", "Check it is still open"] });
  assert.deepEqual(saved.lines.map((l) => l.how), ["comment", "phrase", "phrase", "phrase"]);
  await api("PUT", "/api/projects/live/tests/missing-tap", { name: "Missing tap", start: "relaunch", lines: ['Tap "Zzz Not A Control"', "Go back"] });

  const passed = await runAndWait("passes");
  if (passed.run.status === "inconclusive") {
    console.log(`inconclusive: ${passed.run.reason}`);
    process.exit(2);
  }
  assert.equal(passed.run.status, "completed", passed.run.reason);
  const files = await readdir(passed.dir);
  for (const f of ["00.png", "01.png", "02.png", "03.png", "video.mp4", "sheet.png", "run.json"]) assert.ok(files.includes(f), `${f} in ${files}`);
  assert.equal(passed.run.steps.length, 4);
  assert.ok(passed.run.steps.every((s) => s.ok && s.shot));

  const failed = await runAndWait("missing-tap");
  assert.equal(failed.run.status, "failed");
  assert.equal(failed.run.failedAt, 1);
  assert.equal(failed.run.steps.length, 2, "start step + the failed tap; Go back did not run");
  assert.ok(existsSync(join(failed.dir, "01.png")) && existsSync(join(failed.dir, "video.mp4")), "failed run keeps its screenshot and video");
  console.log("test-studio-live: ok");
} finally {
  await studio.close();
  await rm(root, { recursive: true, force: true });
}
