/**
 * Runs one test through an injected `call(name, args)` (the sim-eyes MCP tools). One step per `batch` call, so every step
 * has its own result and screenshot. The first step that fails ends the run; the video is still saved and the lease is
 * always released. Studio itself installs the selected build on the leased simulator (`install`), before sim-eyes touches it.
 */
import { copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
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
 * @param {(event: object) => void} [p.onEvent] `phase`, `step-start`, `step-end`, `run-end`
 */
export async function runTest({ test, app, build = null, runDir, call, install, onEvent = () => {}, now = () => new Date() }) {
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
  let leased = false;
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

    if (build) {
      onEvent({ type: "phase", phase: "installing" });
      const started = Date.now();
      let udid;
      try {
        udid = leasedUdid(acquired.text);
        await install({ udid, appPath: build.appPath });
        run.install = { ok: true, udid, ms: Date.now() - started };
      } catch (err) {
        run.install = { ok: false, ...(udid ? { udid } : {}), ms: Date.now() - started, error: err.message };
        return void fail("install", err.message);
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
      n += 1;
      await runStepAt(n, line.text, lineIndex, line.step);
      if (run.status !== "completed") return;
    }
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
    if (warnings.length) run.warnings = warnings;
    run.endedAt = now().toISOString();
    onEvent({ type: "run-end", run });
  }
  return run;
}
