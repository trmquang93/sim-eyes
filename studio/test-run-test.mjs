import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatSessionPrefix } from "../client-sessions.mjs";
import { SESSION_LOST_REASON, runTest } from "./run-test.mjs";

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
    assert.deepEqual(events.filter((e) => e !== "phase"), ["step-start", "step-end", "step-start", "step-end", "step-start", "step-end", "step-start", "step-end", "checkpoint", "run-end"]);
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
    const daemonJson = JSON.stringify({ success: false, error: { code: "COMMAND_FAILED", message: "Failed to start daemon", details: { kind: "daemon_startup_failed" } } }, null, 2);
    const daemonRun = await runTest({
      test: { ...test, lines: [lines[1]] },
      app: "x",
      runDir: await newDir(),
      call: async (name, args) => (name === "batch" && args.actions[0].tool === "tap" ? text(`1. tap "General": failed: ${daemonJson}\n   screen: x`, { isError: true }) : fakeServer().call(name, args)),
    });
    assert.match(daemonRun.reason, /Failed to start daemon/, "a multi-line JSON error still names the daemon, so a suite can run the test again");
    const lostJson = (dispatched) => JSON.stringify({ success: false, error: { code: "SESSION_NOT_FOUND", message: "iOS snapshot requires an active app session", details: { reason: "ios_app_session_required", dispatched } } }, null, 2);
    const lostRun = async (dispatched) =>
      runTest({
        test: { ...test, lines: [lines[1]] },
        app: "x",
        runDir: await newDir(),
        call: async (name, args) => (name === "batch" && args.actions[0].tool === "tap" ? text(`1. tap "General": failed: ${lostJson(dispatched)}\n   screen: x`, { isError: true }) : fakeServer().call(name, args)),
      });
    assert.equal((await lostRun("no")).reason, SESSION_LOST_REASON, "a session the daemon lost before the step ran is named, so a suite can run the test again");
    assert.doesNotMatch((await lostRun("yes")).reason, /session was lost before the step ran/, "a step that may have run is never retried as if it had not");
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

  // Fixtures go in after the build and before the app starts: photos added after the app opened would not be in its first picker.
  {
    const server = fakeServer();
    const order = [];
    const applied = [];
    const withFixtures = { ...test, start: "fresh", fixtures: ["photos-3", "fresh-permissions"] };
    const run = await runTest({
      test: withFixtures,
      app: "com.example.app",
      runDir: await newDir(),
      build: { id: "b", version: "1", build: "1", bundleId: "com.example.app", appPath: "/b.app" },
      call: async (name, args) => (order.push(name === "batch" ? args.actions[0].tool : name), server.call(name, args)),
      install: async () => order.push("install"),
      fixtures: async (p) => (order.push("fixtures"), applied.push(p), { applied: p.names, photos: 3, files: 0, privacy: ["all"] }),
    });
    assert.deepEqual(order.slice(0, 4), ["acquire", "install", "fixtures", "open"]);
    assert.deepEqual(applied, [{ udid: UDID, names: ["photos-3", "fresh-permissions"], bundleId: "com.example.app" }]);
    assert.equal(run.fixtures.ok, true);
    assert.equal(run.fixtures.photos, 3);
    assert.equal(run.status, "completed");
    // A test with no fixtures never calls them, and without a build the udid is still read from the lease.
    const none = await runTest({ test, app: "x", runDir: await newDir(), call: fakeServer().call, fixtures: async () => assert.fail("not asked for") });
    assert.equal(none.fixtures, undefined);
    const noBuild = [];
    await runTest({ test: withFixtures, app: "x", runDir: await newDir(), call: fakeServer().call, fixtures: async (p) => (noBuild.push(p.udid), {}) });
    assert.deepEqual(noBuild, [UDID]);
  }

  // A failed fixture phase must not run the test on a simulator without its photos, and must not leak the lease.
  {
    const server = fakeServer();
    const run = await runTest({
      test: { ...test, fixtures: ["photos-3"] },
      app: "x",
      runDir: await newDir(),
      call: server.call,
      fixtures: async () => {
        throw new Error("simctl addmedia failed: error 3301.");
      },
    });
    assert.equal(run.status, "failed");
    assert.equal(run.failedAt, "fixtures");
    assert.equal(run.reason, "simctl addmedia failed: error 3301.");
    assert.equal(run.fixtures.ok, false);
    assert.deepEqual(server.calls.map((c) => c.name), ["acquire", "release"]);
    const noUdid = await runTest({ test: { ...test, fixtures: ["photos-3"] }, app: "x", runDir: await newDir(), call: fakeServer({ noUdid: true }).call, fixtures: async () => assert.fail("no guess") });
    assert.equal(noUdid.failedAt, "fixtures");
    assert.match(noUdid.reason, /did not say which simulator/);
  }

  // Every Check line carries a suggestion with the screenshot it judged; the verdict is for the case as a whole.
  {
    const server = fakeServer();
    const order = [];
    const judged = [];
    const checks = {
      ...test,
      lines: [
        { text: 'Tap "General"', step: { tool: "tap", label: "General" } },
        { text: "Check A", step: { tool: "look" }, expected: "A is shown" },
        { text: "Go back", step: { tool: "back" } },
        { text: "Kiểm tra B", step: { tool: "look" }, expected: "B is gone" },
      ],
    };
    const runDir = await newDir();
    const run = await runTest({
      test: checks,
      app: "x",
      runDir,
      call: async (name, args) => (order.push(name), server.call(name, args)),
      judge: async (p) => (order.push("judge"), judged.push(p), p.expected === "A is shown" ? { suggested: "pass", p: 0.95 } : { suggested: "fail", p: 0.03 }),
      judgeInfo: { backend: "openrouter", model: "perplexity/pplx-decider-v1-27b" },
    });
    assert.equal(run.status, "completed");
    assert.deepEqual(run.checkpoints.map((c) => [c.n, c.expected, c.suggested, c.p, c.image]), [
      [2, "A is shown", "pass", 0.95, "02.png"],
      [4, "B is gone", "fail", 0.03, "04.png"],
    ]);
    assert.equal(run.suggestedVerdict, "fail", "any failing checkpoint makes the case fail");
    assert.deepEqual(run.judge, { backend: "openrouter", model: "perplexity/pplx-decider-v1-27b" });
    assert.deepEqual(judged.map((j) => j.imagePath), [join(runDir, "02.png"), join(runDir, "04.png")], "the judge gets the screenshot the step saved");
    assert.equal(judged[0].screen, 'screen: "Settings"', "and the screen text the step reported");
    assert.ok(order.indexOf("release") < order.indexOf("judge"), "the simulator is released before the model is asked: it can take a minute per screenshot");
  }

  // Which judge decided (screen text or screenshot) and why the text did not settle it is saved with the checkpoint: a reviewer weighs them differently.
  {
    const checks = { ...test, lines: [{ text: "Check A", step: { tool: "look" }, expected: "A" }, { text: "Check B", step: { tool: "look" }, expected: "B" }] };
    const run = await runTest({
      test: checks,
      app: "x",
      runDir: await newDir(),
      call: fakeServer().call,
      judge: async (p) => (p.expected === "A" ? { suggested: "pass", p: 0.95, via: "screen" } : { suggested: "fail", p: 0.05, via: "screenshot", fallback: "the screen text does not carry what the expected result is about" }),
      judgeInfo: { backend: "openrouter", screenText: true },
    });
    assert.deepEqual(run.checkpoints.map((c) => [c.via, c.fallback]), [["screen", undefined], ["screenshot", "the screen text does not carry what the expected result is about"]]);
  }

  // No judge, or a judge that breaks: the run still completes, every checkpoint is "unsure", and the reviewer is told once.
  {
    const checks = { ...test, lines: [{ text: "Check A", step: { tool: "look" }, expected: "A is shown" }, { text: "Check B", step: { tool: "look" }, expected: "B" }] };
    const off = await runTest({ test: checks, app: "x", runDir: await newDir(), call: fakeServer().call });
    assert.equal(off.status, "completed");
    assert.deepEqual(off.checkpoints.map((c) => c.suggested), ["unsure", "unsure"], "no judge means unsure");
    assert.equal(off.suggestedVerdict, "unsure");
    assert.equal(off.judge, null);
    assert.equal(off.warnings, undefined, "a Mac with no judge configured is not a warning on every run");
    const broken = await runTest({ test: checks, app: "x", runDir: await newDir(), call: fakeServer().call, judge: async () => ({ suggested: "unsure", p: null, error: "The judge is unreachable through OpenRouter" }), judgeInfo: { backend: "openrouter" } });
    assert.equal(broken.status, "completed", "a judge that cannot answer never fails the run");
    assert.match(broken.warnings[0], /could not read 2 of 2 checkpoints: The judge is unreachable/);
    const thrown = await runTest({ test: checks, app: "x", runDir: await newDir(), call: fakeServer().call, judge: async () => { throw new Error("boom"); }, judgeInfo: { backend: "openrouter" } });
    assert.equal(thrown.status, "completed");
    assert.match(thrown.warnings[0], /The judge failed: boom/);
    // A failed run is not given a suggested verdict: the app was not tested to the end. Checkpoints before the failure are still judged.
    const failing = await runTest({ test: { ...test, lines: [{ text: "Check A", step: { tool: "look" }, expected: "A" }, { text: "Go back", step: { tool: "back" } }] }, app: "x", runDir: await newDir(), call: fakeServer({ failOn: (a) => (a.tool === "back" ? "back: stopped" : null) }).call, judge: async () => ({ suggested: "pass", p: 0.9 }), judgeInfo: { backend: "openrouter" } });
    assert.equal(failing.status, "failed");
    assert.equal(failing.checkpoints.length, 1);
    assert.equal(failing.suggestedVerdict, undefined);
    // A look that is not a Check (a plain look) is not a checkpoint.
    const plain = await runTest({ test: { ...test, lines: [{ text: "Look", step: { tool: "look" } }] }, app: "x", runDir: await newDir(), call: fakeServer().call, judge: async () => assert.fail("nothing to judge") });
    assert.equal(plain.checkpoints, undefined);
  }

  // A "Check the file" line is answered from the file on the simulator, with the simulator the run leased.
  {
    const asked = [];
    const judged = [];
    const fileLines = {
      ...test,
      lines: [
        { text: 'Check the file "Doc.pdf" has 3 pages', step: { tool: "look" }, expected: 'the file "Doc.pdf" has 3 pages', file: { name: "Doc.pdf", op: "pages", n: 3 } },
        { text: "Check the file \"Doc.pdf\": pages in order", step: { tool: "look" }, expected: "pages in order", file: { name: "Doc.pdf", op: "visual", about: "pages in order" } },
        { text: "Check the list", step: { tool: "look" }, expected: "the list is shown" },
      ],
    };
    const runDir = await newDir();
    const run = await runTest({
      test: fileLines,
      app: "com.example.app",
      runDir,
      call: fakeServer().call,
      fileCheck: async (p) => (asked.push(p), p.file.op === "visual" ? { suggested: "unsure", p: null, source: "judge", detail: "2 pages drawn", images: [join(runDir, "Doc.pdf-page-1.jpg"), join(runDir, "Doc.pdf-page-2.jpg")] } : { suggested: "fail", p: 1, source: "code", detail: "The file has 2 pages; expected 3." }),
      judge: async (p) => (judged.push(p), { suggested: "pass", p: 0.9 }),
      judgeInfo: { backend: "openrouter" },
    });
    assert.deepEqual(asked.map((a) => [a.udid, a.bundleId, a.imageDir, a.file.op]), [[UDID, "com.example.app", runDir, "pages"], [UDID, "com.example.app", runDir, "visual"]]);
    assert.deepEqual(run.checkpoints.map((c) => [c.expected, c.suggested, c.p, c.source, c.detail]), [
      ['the file "Doc.pdf" has 3 pages', "fail", 1, "code", "The file has 2 pages; expected 3."],
      ["pages in order", "pass", 0.9, undefined, "2 pages drawn"],
      ["the list is shown", "pass", 0.9, undefined, undefined],
    ]);
    assert.deepEqual(run.checkpoints[1].images, ["Doc.pdf-page-1.jpg", "Doc.pdf-page-2.jpg"]);
    assert.equal(judged.length, 2, "code's answer is not sent to the model; the pages and the screen are");
    assert.deepEqual(judged[0].imagePaths, [join(runDir, "Doc.pdf-page-1.jpg"), join(runDir, "Doc.pdf-page-2.jpg")], "the judge looks at the drawn pages in order");
    assert.equal(run.suggestedVerdict, "fail", "a certain failure from code fails the case");
    // A file check that throws, or a lease without an id, is unsure and does not fail the run.
    const thrown = await runTest({ test: { ...test, lines: [fileLines.lines[0]] }, app: "x", runDir: await newDir(), call: fakeServer().call, fileCheck: async () => { throw new Error("swiftc missing"); } });
    assert.equal(thrown.status, "completed");
    assert.deepEqual([thrown.checkpoints[0].suggested, thrown.checkpoints[0].error], ["unsure", "swiftc missing"]);
    const noId = await runTest({ test: { ...test, lines: [fileLines.lines[0]] }, app: "x", runDir: await newDir(), call: fakeServer({ noUdid: true }).call, fileCheck: async () => assert.fail("no guess") });
    assert.equal(noId.checkpoints[0].suggested, "unsure");
    assert.match(noId.checkpoints[0].error, /id is unknown/);
    // Without a file checker (an old Studio), the line is judged like any screen check.
    const plain = await runTest({ test: { ...test, lines: [fileLines.lines[0]] }, app: "x", runDir: await newDir(), call: fakeServer().call, judge: async () => ({ suggested: "pass", p: 0.9 }), judgeInfo: { backend: "openrouter" } });
    assert.equal(plain.checkpoints[0].suggested, "pass");
  }

  // Stop ends the run before the next step; the video is saved and the lease released like any other end.
  {
    const server = fakeServer();
    let stop = false;
    const run = await runTest({
      test,
      app: "x",
      runDir: await newDir(),
      call: async (name, args) => {
        const out = await server.call(name, args);
        if (name === "batch" && args.actions[0].tool === "tap") stop = true;
        return out;
      },
      shouldStop: () => stop,
    });
    assert.equal(run.status, "stopped");
    assert.equal(run.reason, "Stopped by the tester.");
    assert.equal(run.steps.length, 2, "the step in flight finished, the next did not start");
    assert.equal(server.calls.at(-1).name, "release");
    assert.ok(batches(server.calls).some((a) => a.action === "stop"), "the recording is stopped");
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
