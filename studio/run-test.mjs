/**
 * Runs one test through an injected `call(name, args)` (the sim-eyes MCP tools). One step per `batch` call, so every step
 * has its own result and screenshot. The first step that fails ends the run; the video is still saved and the lease is
 * always released. Studio itself installs the selected build on the leased simulator (`install`), before sim-eyes touches it.
 */
import { copyFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { suggestVerdict } from "./judge.mjs";
import { leasedUdid, stepReport } from "./step-report.mjs";

const START_STEPS = {
  fresh: { tool: "open", reset: true },
  relaunch: { tool: "open", relaunch: true },
  "as-is": { tool: "look" },
};
const START_LABELS = { fresh: "Start: open the app fresh", relaunch: "Start: restart the app", "as-is": "Start: look at the screen as it is" };

export const startStepFor = (start) => {
  if (!START_STEPS[start]) throw new Error(`Unknown start "${start}": use fresh, relaunch or as-is.`);
  return { step: START_STEPS[start], label: START_LABELS[start] };
};

const firstLine = (text) => String(text).split("\n")[0];
/** Why a step failed, in one line: a failed tap's first line ends with "Fell back to a goal:", which says nothing to a tester. */
const reasonOf = (text) => firstLine(text).replace(/\s*Fell back to a goal:$/, "");
const shotName = (n) => `${String(n).padStart(2, "0")}.png`;

/** The screenshot file of a step, or null when the step left none. A failure that threw sends the image but never saves it. */
async function keepShot(report, file, name) {
  if (report.saved && report.saved !== file) await copyFile(report.saved, file);
  else if (!report.saved && report.image) await writeFile(file, Buffer.from(report.image, "base64"));
  else if (!report.saved) return null;
  return name;
}

/**
 * @param {object} p
 * @param {{ name: string, start: string, lines: Array<{ text: string, step: object | null, expected?: string }> }} p.test
 * @param {string} p.app bundle id (or name) the run attaches to
 * @param {{ id: string, version: string, build: string, bundleId: string, appPath: string } | null} [p.build]
 * @param {string} p.runDir existing folder for the run's files
 * @param {(name: string, args?: object) => Promise<{ content: Array<object>, isError?: boolean }>} p.call
 * @param {(p: { udid: string, appPath: string }) => Promise<void>} [p.install]
 * @param {(p: { udid: string, names: string[], bundleId?: string }) => Promise<object>} [p.fixtures] puts the test's fixture sets into the leased simulator
 * @param {(p: { file: object, udid: string, bundleId?: string, imageDir: string }) => Promise<{ suggested: string, p: number | null, detail: string, source: string, images?: string[] }>} [p.fileCheck] answers a "Check the file ..." line from the file on the simulator
 * @param {(p: { expected: string, screen: string | null, imagePath?: string | null, imagePaths?: string[] }) => Promise<{ suggested: string, p: number | null, error?: string }>} [p.judge] suggests a result for a checkpoint
 * @param {{ backend: string, model?: string } | null} [p.judgeInfo] recorded in the run
 * @param {() => boolean} [p.shouldStop] checked before every step: true ends the run as "stopped" (the video is saved and the lease released)
 * @param {(event: object) => void} [p.onEvent] `phase`, `step-start`, `step-end`, `checkpoint`, `run-end`
 */
export async function runTest({ test, app, build = null, runDir, call, install, fixtures, fileCheck, judge = null, judgeInfo = null, shouldStop = () => false, onEvent = () => {}, now = () => new Date() }) {
  const { step: startStep, label: startLabel } = startStepFor(test.start);
  const run = {
    test: { name: test.name, start: test.start, lines: test.lines },
    app,
    build: build ? { id: build.id, version: build.version, build: build.build, bundleId: build.bundleId } : null,
    status: "completed",
    startedAt: now().toISOString(),
    steps: [],
  };
  const warnings = [];
  const toJudge = []; // checkpoints in order; judged after the lease is released, so the simulator is free while the model thinks
  let leased = false;
  let leasedId = null;
  let recording = false;
  const fail = (failedAt, reason) => Object.assign(run, { status: "failed", failedAt, reason });

  /** One step; returns its record, and ends the run when it failed. */
  const runStepAt = async (n, line, lineIndex, step) => {
    onEvent({ type: "step-start", n, line, step });
    const started = Date.now();
    const file = join(runDir, shotName(n));
    const report = stepReport(await call("batch", { app, image: false, actions: [{ ...step, save: file }] }));
    const record = {
      n,
      line,
      ...(lineIndex == null ? {} : { lineIndex }),
      step,
      ok: report.ok,
      summary: report.summary,
      screen: report.screen,
      shot: await keepShot(report, file, shotName(n)),
      ms: Date.now() - started,
    };
    run.steps.push(record);
    onEvent({ type: "step-end", ...record });
    if (report.poolBusy) Object.assign(run, { status: "inconclusive", reason: firstLine(report.summary) });
    else if (!report.ok) fail(n, reasonOf(report.summary));
    return record;
  };

  async function drive() {
    onEvent({ type: "phase", phase: "leasing" });
    const acquired = stepReport(await call("acquire", { app }));
    if (acquired.poolBusy) return void Object.assign(run, { status: "inconclusive", reason: firstLine(acquired.summary) });
    if (!acquired.ok) throw new Error(firstLine(acquired.summary));
    leased = true;

    let udid;
    if (build) {
      onEvent({ type: "phase", phase: "installing" });
      const started = Date.now();
      try {
        udid = leasedUdid(acquired.text);
        await install({ udid, appPath: build.appPath });
        run.install = { ok: true, udid, ms: Date.now() - started };
      } catch (err) {
        run.install = { ok: false, ...(udid ? { udid } : {}), ms: Date.now() - started, error: err.message };
        return void fail("install", err.message);
      }
    }
    // A file check after the steps needs the simulator's id; a reply without it makes those checks "unsure", never a guess.
    leasedId = udid ?? (() => {
      try {
        return leasedUdid(acquired.text);
      } catch {
        return null;
      }
    })();

    // After the build and before the app starts: the photos, files and permissions the case assumes.
    if (test.fixtures?.length && fixtures) {
      onEvent({ type: "phase", phase: "fixtures" });
      const started = Date.now();
      try {
        udid ??= leasedUdid(acquired.text);
        const done = await fixtures({ udid, names: test.fixtures, bundleId: build?.bundleId ?? app });
        run.fixtures = { ok: true, ...done, ms: Date.now() - started };
      } catch (err) {
        run.fixtures = { ok: false, names: test.fixtures, ms: Date.now() - started, error: err.message };
        return void fail("fixtures", err.message);
      }
    }

    onEvent({ type: "phase", phase: "starting" });
    await runStepAt(0, startLabel, null, startStep);
    if (run.status !== "completed") return;

    const started = stepReport(await call("batch", { app, image: false, actions: [{ tool: "record", action: "start" }] }));
    if (started.ok) recording = true;
    else warnings.push(`The video could not start: ${firstLine(started.summary)}`);

    let n = 0;
    for (const [lineIndex, line] of test.lines.entries()) {
      if (!line.step) continue;
      if (shouldStop()) return void Object.assign(run, { status: "stopped", reason: "Stopped by the tester." });
      n += 1;
      const record = await runStepAt(n, line.text, lineIndex, line.step);
      if (record.ok && line.expected != null) {
        const item = { n, lineIndex, expected: line.expected, screen: record.screen, shot: record.shot };
        if (line.file && fileCheck) {
          // The file is on the simulator now; the answer is code's. Pages drawn for a visual check go to the judge later.
          const out = leasedId
            ? await fileCheck({ file: line.file, udid: leasedId, bundleId: build?.bundleId ?? app, imageDir: runDir }).catch((err) => ({ suggested: "unsure", p: null, source: "code", detail: err.message }))
            : { suggested: "unsure", p: null, source: "code", detail: "The simulator's id is unknown, so the file cannot be found." };
          if (out.images?.length) Object.assign(item, { images: out.images.map((f) => basename(f)), detail: out.detail });
          else Object.assign(item, { result: { suggested: out.suggested, p: out.p, ...(out.suggested === "unsure" ? { error: out.detail } : {}) }, detail: out.detail, source: out.source });
        }
        toJudge.push(item);
      }
      if (run.status !== "completed") return;
    }
  }

  /** A suggestion for every checkpoint; a failure to judge is "unsure" and one warning, never a failed run. */
  async function judgeCheckpoints() {
    if (!toJudge.length) return;
    onEvent({ type: "phase", phase: "judging" });
    run.checkpoints = [];
    for (const c of toJudge) {
      const pictures = c.images ? { imagePaths: c.images.map((f) => join(runDir, f)) } : { imagePath: c.shot ? join(runDir, c.shot) : null };
      const out =
        c.result ??
        (judge ? await judge({ expected: c.expected, screen: c.screen, ...pictures }) : { suggested: "unsure", p: null, error: "No judge is configured." });
      const checkpoint = {
        n: c.n,
        lineIndex: c.lineIndex,
        expected: c.expected,
        suggested: out.suggested,
        p: out.p,
        image: c.shot,
        ...(c.images ? { images: c.images } : {}),
        ...(c.source ? { source: c.source } : {}),
        ...(c.detail ? { detail: c.detail } : {}),
        ...(out.error ? { error: out.error } : {}),
      };
      run.checkpoints.push(checkpoint);
      onEvent({ type: "checkpoint", ...checkpoint });
    }
    if (judge) {
      const unread = run.checkpoints.filter((c) => c.error && c.source !== "code");
      if (unread.length) warnings.push(`The judge could not read ${unread.length} of ${run.checkpoints.length} checkpoints: ${unread[0].error}`);
    }
    run.judge = judge ? (judgeInfo ?? { backend: "unknown" }) : null;
    if (run.status === "completed") run.suggestedVerdict = suggestVerdict(run.checkpoints);
  }

  async function saveVideo() {
    const stopped = stepReport(await call("batch", { app, image: false, actions: [{ tool: "record", action: "stop" }] }));
    const video = /Video: (.+)$/m.exec(stopped.text)?.[1]?.trim();
    if (!stopped.ok || !video) throw new Error(firstLine(stopped.summary));
    await copyFile(video, join(runDir, "video.mp4"));
    run.video = "video.mp4";
    if (stopped.image) {
      await writeFile(join(runDir, "sheet.png"), Buffer.from(stopped.image, "base64"));
      run.sheet = "sheet.png";
    }
  }

  try {
    await drive();
  } catch (err) {
    Object.assign(run, { status: "error", reason: err.message });
  } finally {
    if (recording) await saveVideo().catch((err) => warnings.push(`The video was not saved: ${err.message}`));
    if (leased) await call("release").catch((err) => warnings.push(`The simulator may still be leased: ${err.message}`));
    await judgeCheckpoints().catch((err) => warnings.push(`The judge failed: ${err.message}`));
    if (warnings.length) run.warnings = warnings;
    run.endedAt = now().toISOString();
    onEvent({ type: "run-end", run });
  }
  return run;
}
