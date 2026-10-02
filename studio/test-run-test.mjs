import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSessionPrefix } from "../client-sessions.mjs";
import { runTest } from "./run-test.mjs";

const dir = await mkdtemp(join(tmpdir(), "studio-run-"));
const video = join(dir, "clip.mp4");
await writeFile(video, "mp4");

const UDID = "8F395E81-CF05-425A-B3C8-CA63CFDE8FD6";
const text = (t, extra = {}) => ({ content: [{ type: "text", text: `${formatSessionPrefix("se-1", false)}${t}` }], ...extra });
let runCount = 0;

/**
 * A fake sim-eyes. `failOn(step)` returns a failure text for a step; it writes the screenshot the way the server does
 * (`save`). Every call is logged in `calls`.
 */
function fakeServer({ busy = false, failOn = () => null, throwOn = () => false, noUdid = false } = {}) {
  const calls = [];
  const call = async (name, args = {}) => {
    calls.push({ name, args });
    if (name === "acquire") {
      if (busy) return text("SIM_POOL_BUSY: no free simulator\nReport QA inconclusive.", { isError: true });
      return text(noUdid ? "Acquired simulator." : `Acquired simulator.\nudid: ${UDID}\nname: iPhone 17`);
    }
    if (name === "release") return text("Released.");
    const [action] = args.actions;
    if (action.tool === "record" && action.action === "start") return text("1. record: started (/w/clip.mp4).");
    if (action.tool === "record" && action.action === "stop") {
      return { content: [{ type: "text", text: `${formatSessionPrefix("se-1", false)}1. record: stopped. sheet. Video: ${video}` }, { type: "image", data: Buffer.from("sheet").toString("base64"), mimeType: "image/png" }] };
    }
    if (throwOn(action)) throw new Error("transport closed");
    const why = failOn(action);
    await writeFile(action.save, "png");
    const lines = `1. ${why ?? `${action.tool}: done.`}\n   screen: "Settings"\n   saved ${action.save}`;
    return text(lines, why ? { isError: true } : {});
  };
  return { call, calls };
}

const lines = [
  { text: "# note", step: null, how: "comment" },
  { text: 'Tap "General"', step: { tool: "tap", label: "General" }, how: "phrase" },
  { text: "Check the About row is there", step: { tool: "look" }, expected: "the About row is there", how: "phrase" },
  { text: "Go back", step: { tool: "back" }, how: "phrase" },
];
const test = { name: "About", start: "relaunch", lines };
const newDir = async () => {
  const d = join(dir, `run${(runCount += 1)}`);
  await mkdir(d);
  return d;
};
const batches = (calls) => calls.filter((c) => c.name === "batch").map((c) => c.args.actions[0]);

try {
  // Each step saves NN.png in the run folder: the review has a screenshot for every step. Comment lines are not steps.
  {
    const runDir = await newDir();
    const events = [];
    const server = fakeServer();
    const run = await runTest({ test, app: "com.apple.Preferences", runDir, call: server.call, onEvent: (e) => events.push(e.type) });
    assert.equal(run.status, "completed");
    assert.deepEqual(run.steps.map((s) => [s.n, s.line, s.ok, s.shot]), [
      [0, "Start: restart the app", true, "00.png"],
      [1, 'Tap "General"', true, "01.png"],
      [2, "Check the About row is there", true, "02.png"],
      [3, "Go back", true, "03.png"],
    ]);
    assert.equal(run.steps[1].lineIndex, 1);
    for (const f of ["00.png", "03.png", "video.mp4", "sheet.png"]) assert.ok(existsSync(join(runDir, f)), f);
    assert.equal(run.video, "video.mp4");
    assert.deepEqual(server.calls.map((c) => c.name === "batch" ? c.args.actions[0].tool + (c.args.actions[0].action ?? "") : c.name), ["acquire", "open", "recordstart", "tap", "look", "back", "recordstop", "release"]);
    assert.deepEqual(batches(server.calls)[0], { tool: "open", relaunch: true, save: join(runDir, "00.png") });
    assert.ok(server.calls.every((c) => c.name !== "batch" || c.args.image === false && c.args.app === "com.apple.Preferences"));
    assert.deepEqual(events.filter((e) => e !== "phase"), ["step-start", "step-end", "step-start", "step-end", "step-start", "step-end", "step-start", "step-end", "run-end"]);
    assert.equal(run.build, null, "no selected build: no install, build is null");
    assert.equal(run.install, undefined);
  }

  // A failed step ends the run: later steps would run on a broken screen. The video is kept and the lease is not leaked.
  {
    const runDir = await newDir();
    const server = fakeServer({ failOn: (a) => (a.tool === "look" ? 'look: stopped, nothing matched' : null) });
    const run = await runTest({ test, app: "x", runDir, call: server.call });
    assert.equal(run.status, "failed");
    assert.equal(run.failedAt, 2);
    assert.equal(run.reason, "look: stopped, nothing matched");
    assert.equal(run.steps.length, 3, "the step after the failure did not run");
    const tapRun = await runTest({
      test: { ...test, lines: [lines[1]] },
      app: "x",
      runDir: await newDir(),
      call: async (name, args) => (name === "batch" && args.actions[0].tool === "tap"
        ? text('1. tap "General": the exact tap failed (no label). Fell back to a goal:\ngoal "tap General": stopped.\nThe goal fallback failed too.\n   screen: x', { isError: true })
        : fakeServer().call(name, args)),
    });
    assert.equal(tapRun.reason, 'tap "General": the exact tap failed (no label).', "the reason is the sentence, not the lead-in to the fallback");
    assert.equal(run.steps[2].shot, "02.png", "the failing step's screenshot is kept");
    assert.ok(!batches(server.calls).some((a) => a.tool === "back"));
    assert.ok(existsSync(join(runDir, "video.mp4")));
    assert.equal(server.calls.at(-1).name, "release");
  }

  // A busy pool is not a failure of the app, and the runner never takes another lease.
  {
    const server = fakeServer({ busy: true });
    const run = await runTest({ test, app: "x", runDir: await newDir(), call: server.call, build: { id: "b", version: "1", build: "1", bundleId: "x", appPath: "/b.app" }, install: async () => assert.fail("no install without a lease") });
    assert.equal(run.status, "inconclusive");
    assert.match(run.reason, /^SIM_POOL_BUSY/);
    assert.deepEqual(server.calls.map((c) => c.name), ["acquire"], "nothing else is called, and nothing is released that was never leased");
  }

  // A crash in the middle (the server dies, a call throws) still releases, so the lease does not sit until the TTL.
  {
    const server = fakeServer({ throwOn: (a) => a.tool === "back" });
    const run = await runTest({ test, app: "x", runDir: await newDir(), call: server.call });
    assert.equal(run.status, "error");
    assert.equal(run.reason, "transport closed");
    assert.equal(server.calls.at(-1).name, "release");
    assert.ok(batches(server.calls).some((a) => a.action === "stop"), "the recording is stopped too");
  }

  // The build lands on the leased simulator before sim-eyes opens the app: after, the app would be running the old copy.
  {
    const server = fakeServer();
    const order = [];
    const installs = [];
    const build = { id: "2.3.0-145", version: "2.3.0", build: "145", bundleId: "com.example.app", appPath: "/builds/X.app" };
    const run = await runTest({
      test: { ...test, start: "fresh" },
      app: "com.example.app",
      runDir: await newDir(),
      build,
      call: async (name, args) => (order.push(name === "batch" ? args.actions[0].tool : name), server.call(name, args)),
      install: async (p) => (order.push("install"), installs.push(p)),
    });
    assert.deepEqual(order.slice(0, 3), ["acquire", "install", "open"]);
    assert.deepEqual(installs, [{ udid: UDID, appPath: "/builds/X.app" }]);
    assert.deepEqual(run.build, { id: "2.3.0-145", version: "2.3.0", build: "145", bundleId: "com.example.app" });
    assert.equal(run.install.ok, true);
    assert.equal(run.install.udid, UDID);
    assert.equal(batches(server.calls)[0].reset, true, "a fresh start resets the app");
  }

  // A failed install: the run must not test a missing or old app, and must not leak the lease.
  {
    const server = fakeServer();
    const run = await runTest({
      test,
      app: "x",
      runDir: await newDir(),
      build: { id: "b", version: "1", build: "1", bundleId: "x", appPath: "/b.app" },
      call: server.call,
      install: async () => {
        throw new Error("simctl install failed: bad arch");
      },
    });
    assert.equal(run.status, "failed");
    assert.equal(run.failedAt, "install");
    assert.equal(run.reason, "simctl install failed: bad arch");
    assert.deepEqual(run.install, { ok: false, udid: UDID, ms: run.install.ms, error: "simctl install failed: bad arch" });
    assert.deepEqual(server.calls.map((c) => c.name), ["acquire", "release"]);
    // No udid in the reply: Studio does not guess where to install.
    const noUdid = fakeServer({ noUdid: true });
    const run2 = await runTest({ test, app: "x", runDir: await newDir(), build: { id: "b", version: "1", build: "1", bundleId: "x", appPath: "/b.app" }, call: noUdid.call, install: async () => assert.fail("no guess") });
    assert.equal(run2.failedAt, "install");
    assert.match(run2.reason, /did not say which simulator/);
  }

  // A failure that threw on the server returns its screenshot as an image but never saves it: the run writes the file.
  {
    const runDir = await newDir();
    const call = async (name, args) => {
      if (name === "batch" && args.actions[0].tool === "tap") {
        return { isError: true, content: [{ type: "text", text: "session_id=se-1\n1. failed: boom\n   screen: x" }, { type: "image", data: Buffer.from("fail").toString("base64"), mimeType: "image/png" }] };
      }
      return fakeServer().call(name, args);
    };
    const run = await runTest({ test, app: "x", runDir, call });
    assert.equal(run.steps[1].shot, "01.png");
    assert.equal(await readFile(join(runDir, "01.png"), "utf8"), "fail");
  }

  // The start step follows the test's setting.
  {
    for (const [start, tool] of [["fresh", { tool: "open", reset: true }], ["as-is", { tool: "look" }]]) {
      const server = fakeServer();
      await runTest({ test: { ...test, start }, app: "x", runDir: await newDir(), call: server.call });
      const { save, ...first } = batches(server.calls)[0];
      assert.deepEqual(first, tool);
    }
    await assert.rejects(runTest({ test: { ...test, start: "x" }, app: "x", runDir: dir, call: async () => assert.fail("not called") }), /Unknown start/);
  }
  console.log("test-run-test: ok");
} finally {
  await rm(dir, { recursive: true, force: true });
}
