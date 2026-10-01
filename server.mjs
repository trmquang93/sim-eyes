#!/usr/bin/env node
/**
 * sim-eyes MCP — one Cursor agent ↔ one leased simulator.
 *
 * Multi-agent safety:
 * - Unique agent-device session per MCP process (`sim-eyes-<pid>-<hex>`)
 * - Simulator leased via sim-pool (never hardcode a shared device name)
 * - Renew on every tool call; release on process exit
 * - Per-session screenshot work dir
 */
import { execFileSync, spawn } from "node:child_process";
import { appendFile, copyFile, cp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { needsShot } from "./batch-plan.mjs";
import { staleSimEyesSessions } from "./stale-sessions.mjs";
import { BACK_GOAL, backTargets, directTapTarget, dragEnds, gestureNode } from "./act-direct.mjs";
import { controlsLine, coveredControlsLine, coveredScreenLine, screenLine } from "./screen-summary.mjs";
import { screenCover } from "./cover-check.mjs";
import { needsOcr, ocrTargets, recognizeText, screenDiff } from "./ocr.mjs";
import {
  ACT_CONFIDENCE_MIN,
  ACT_DEFAULT_STEPS,
  ACT_DONE_MIN,
  ACT_MAX_STEPS,
  EFFECT_BAND,
  decideStep,
  effectRecord,
  effectText,
  screenSignature,
  stepRecord,
  typesafeClient,
} from "./act.mjs";
import { formatTargets, listTargets, screenContext } from "./targets.mjs";
import {
  PoolBusyError,
  acquireLease,
  defaultInstanceId,
  findSimPoolBin,
  poolStatusText,
  releaseLease,
  renewLease,
} from "./pool.mjs";
import { preferDiffersFromBinding, preferHonored, SESSION_ID_RULE } from "./binding-prefer.mjs";
import {
  SessionRegistry,
  formatSessionPrefix,
} from "./client-sessions.mjs";
import { SESSION_ID_PROPERTY } from "./session-schema.mjs";

const INSTANCE_ID = process.env.SIM_EYES_INSTANCE_ID || defaultInstanceId();
const WORK_ROOT = join(homedir(), ".local", "sim-eyes", "work");
const registry = new SessionRegistry();
/** Active client session for the current MCP tool call (set in handleMcpTool). */
let ctx = null;

function workDir() {
  const session =
    ctx.binding?.session ?? `sim-eyes-${INSTANCE_ID}-${ctx.id}`;
  return join(WORK_ROOT, session);
}

function stripSessionArgs(args) {
  if (!args) return {};
  const { session_id, ...rest } = args;
  return rest;
}

function prefixSession(result, sessionId, created) {
  if (!sessionId || !result?.content?.[0] || result.content[0].type !== "text") {
    return result;
  }
  const head = formatSessionPrefix(sessionId, created);
  if (result.content[0].text.startsWith("session_id=")) return result;
  result.content[0].text = head + result.content[0].text;
  return result;
}

function adCommand() {
  if (process.env.SIM_EYES_AD) return process.env.SIM_EYES_AD.split(" ");
  if (existsSync("/opt/homebrew/bin/agent-device"))
    return ["/opt/homebrew/bin/agent-device"];
  if (existsSync("/usr/local/bin/agent-device"))
    return ["/usr/local/bin/agent-device"];
  const bin = npxAgentDevice();
  return bin === "npx" ? ["npx", "-y", "agent-device"] : [bin];
}

let cachedNpxBin = null;
/** Resolve npx's agent-device binary once: going through `npx` on every call adds ~1 s per step. */
function npxAgentDevice() {
  if (cachedNpxBin) return cachedNpxBin;
  try {
    const out = execFileSync("npx", ["-y", "-p", "agent-device", "sh", "-c", "command -v agent-device"], {
      encoding: "utf8",
      timeout: 120000,
    }).trim();
    if (out && existsSync(out)) cachedNpxBin = out;
  } catch {
    /* fall through to plain npx */
  }
  return cachedNpxBin ?? "npx";
}

function spawnAd(argv, { json = false, timeoutMs = 120000 } = {}) {
  const cmd = adCommand();
  const full = json ? [...argv, "--json"] : argv;
  const base = cmd[0];
  const args = cmd.slice(1).concat(full);

  return new Promise((resolve, reject) => {
    const child = spawn(base, args, {
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`agent-device timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error((stderr || stdout).trim() || `exit ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

function usePool() {
  if (process.env.SIM_EYES_USE_POOL === "0") return false;
  return !!findSimPoolBin();
}

/** Close agent-device sessions whose sim-eyes process died, so their simulators are usable again. */
async function sweepStaleSessions() {
  try {
    const data = JSON.parse(await spawnAd(["session", "list"], { json: true, timeoutMs: 30000 }));
    for (const name of staleSimEyesSessions(data.data?.sessions ?? [])) {
      await spawnAd(["close", "--session", name], { timeoutMs: 30000 }).catch(() => {});
      console.error(`sim-eyes: closed stale agent-device session ${name}`);
    }
  } catch {
    /* best effort: a failed sweep must not block acquire */
  }
}

async function acquireBinding({ preferUdid, preferDevice } = {}) {
  if (ctx.binding) {
    await renewLease(ctx.binding.leaseId).catch(() => {});
    return ctx.binding;
  }
  await sweepStaleSessions();

  const prefer = preferUdid || undefined;
  const preferName = preferDevice || undefined;

  if (usePool()) {
    let udid = prefer;
    if (!udid && preferName) {
      udid = await resolveDeviceNameToUdid(preferName);
    }
    ctx.binding = await acquireLease({
      instanceId: `${INSTANCE_ID}-${ctx.id}`,
      preferUdid: udid,
      preferDevice: preferName,
      project: process.env.SIM_EYES_PROJECT || "sim-eyes",
      worktree: process.env.SIM_EYES_WORKTREE || process.cwd(),
      ttl: process.env.SIM_EYES_LEASE_TTL
        ? Number(process.env.SIM_EYES_LEASE_TTL)
        : undefined,
    });
    await requirePreferred(udid, preferName);
  } else {
    const device = prefer || preferName || (await pickAnyBootedDevice());
    ctx.binding = {
      leaseId: "",
      udid: device,
      name: device,
      expiresAt: "",
      session: `sim-eyes-${INSTANCE_ID}-${ctx.id}`,
    };
  }
  await mkdir(workDir(), { recursive: true });
  return ctx.binding;
}

/** sim-pool treats a preferred simulator as a hint and hands out any free one. A QA run on the wrong device is worse than none, so a miss is an error. */
async function requirePreferred(udid, name) {
  const got = ctx.binding;
  if (preferHonored(got, { udid: udid && isUdid(udid) ? udid : undefined, name })) return;
  ctx.binding = null;
  await releaseLease(got.leaseId).catch(() => {});
  const row = (await poolStatusText().catch(() => "")).split("\n").find((l) => udid && l.includes(udid));
  throw new Error(
    `sim-pool did not grant ${name ?? udid}; it offered ${got.name} (${got.udid}) and that lease is released. ${
      row ? `Pool row: ${row.replace(/\s+/g, " ")}.` : "That simulator is not on the pool whitelist."
    } Acquire again without prefer_udid/prefer_device to take any free simulator, or mark QA inconclusive.`
  );
}

async function resolveDeviceNameToUdid(nameOrId) {
  try {
    const out = await spawnAd(["devices"], { json: true, timeoutMs: 30000 });
    const data = JSON.parse(out);
    const sims = (data.data?.devices ?? []).filter(
      (d) => d.platform === "ios" && d.kind === "simulator"
    );
    const hit =
      sims.find((d) => d.id === nameOrId) ||
      sims.find((d) => d.name === nameOrId);
    return hit?.id ?? nameOrId;
  } catch {
    return nameOrId;
  }
}

async function pickAnyBootedDevice() {
  const out = await spawnAd(["devices"], { json: true, timeoutMs: 30000 });
  const data = JSON.parse(out);
  const sims = (data.data?.devices ?? []).filter(
    (d) => d.platform === "ios" && d.kind === "simulator" && d.booted
  );
  if (sims.length === 0) {
    const name = process.env.SIM_EYES_BOOT_DEVICE ?? "iPhone 17";
    await spawnAd(["boot", "--platform", "ios", "--device", name], {
      timeoutMs: 180000,
    });
    return name;
  }
  const free = sims.find((d) => !d.claimedBy);
  return (free ?? sims[0]).id;
}

async function ensureBound() {
  if (!ctx.binding) await acquireBinding();
  else if (ctx.binding.leaseId) {
    try {
      await renewLease(ctx.binding.leaseId);
    } catch (err) {
      ctx.binding = null;
      throw new Error(
        `Lease lost (${err.message}). Call acquire again or mark QA inconclusive.`
      );
    }
  }
  return ctx.binding;
}

async function releaseBinding({ closeSession = true } = {}) {
  if (ctx.releasing || !ctx.binding) return;
  ctx.releasing = true;
  const current = ctx.binding;
  ctx.binding = null;
  ctx.appReady = false;
  try {
    if (closeSession) {
      await spawnAd(
        [
          "close",
          "--session",
          current.session,
          "--platform",
          "ios",
          ...deviceSelectArgs(current.udid),
        ],
        { timeoutMs: 60000 }
      ).catch(() => {});
    }
    if (current.leaseId) await releaseLease(current.leaseId);
  } finally {
    ctx.releasing = false;
  }
}

function isUdid(value) {
  return /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/.test(
    value
  );
}

/** agent-device: `--udid` for UUIDs, `--device` for display names. */
function deviceSelectArgs(udidOrName) {
  return isUdid(udidOrName)
    ? ["--udid", udidOrName]
    : ["--device", udidOrName];
}

/** Commands that cannot change what is on screen; everything else invalidates the cached snapshot and screenshot. */
const READ_ONLY_AD = new Set(["snapshot", "screenshot"]);

async function runAd(args, opts) {
  const b = await ensureBound();
  if (!READ_ONLY_AD.has(args[0])) ctx.version += 1;
  return spawnAd(
    [
      ...args,
      "--session",
      b.session,
      "--platform",
      "ios",
      ...deviceSelectArgs(b.udid),
    ],
    opts
  );
}

async function runAdJson(args, opts) {
  const out = await runAd(args, { ...opts, json: true });
  return JSON.parse(out);
}

async function ensureApp() {
  if (ctx.appReady) return;
  if (typeof ctx.app !== "string" || !ctx.app.trim()) {
    throw new Error(
      "batch/acquire requires app (display name or bundle id). Omitting it attaches to the home screen and backgrounds the app under test."
    );
  }
  // agent-device needs an app session before it can snapshot. Open the caller's app without
  // relaunching: a relaunch would kill an app they already started (e.g. from Xcode).
  await runAd(["open", ctx.app], { timeoutMs: 180000 });
  ctx.appReady = true;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function takeSnapshot() {
  const data = await runAdJson(["snapshot", "-i"]);
  const nodes = data.data?.nodes ?? [];
  if (nodes[0]?.rect) {
    ctx.screenSize = {
      width: nodes[0].rect.width,
      height: nodes[0].rect.height,
    };
  }
  const targets = listTargets(nodes);
  ctx.lastNodes = nodes;
  ctx.lastTargets = targets;
  ctx.lastScreen = screenContext(nodes);
  ctx.snapVersion = ctx.version;
  return targets;
}

/** The screen's controls. Reused while nothing has changed the screen; a sheet that has just been presented can come back empty, so an empty list is read again. */
async function snapshotTargets() {
  await ensureApp();
  if (ctx.snapVersion === ctx.version) return ctx.lastTargets;
  let targets = await takeSnapshot();
  for (const delay of [400, 800]) {
    if (targets.length > 0) break;
    await sleep(delay);
    targets = await takeSnapshot();
  }
  return targets;
}

/**
 * Whether a view outside the app's accessibility tree (the Photos picker, a permission sheet) covers the
 * screen, so the snapshot describes what is underneath. Read from the screenshot; reused until the screen changes.
 */
async function coverOf() {
  if (ctx.cover?.version === ctx.version) return ctx.cover;
  let found = { hidden: false, texts: [] };
  let items = [];
  try {
    items = await recognizeText((await currentShot("look")).path);
    found = screenCover(ctx.lastTargets, items);
  } catch {
    // OCR is a cross-check; without it the tree is taken as it is.
  }
  ctx.cover = { version: ctx.version, items, ...found };
  return ctx.cover;
}

/** A screenshot of the screen as it is now; the one already taken is reused while nothing has changed it. */
async function currentShot(tag = "screen") {
  if (ctx.shot?.version === ctx.version) return ctx.shot;
  const dir = workDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${tag}-${Date.now()}.png`);
  await runAd(["screenshot", path, "--pixel-density", "1"]);
  ctx.shot = { path, version: ctx.version };
  return ctx.shot;
}

async function readBase64(path) {
  return (await readFile(path)).toString("base64");
}

/** Relative save paths go to the session work dir, never the server's cwd (which is whatever repo the client started in). */
async function saveShot(shotPath, save) {
  const dest = isAbsolute(save) ? save : join(workDir(), "saves", save);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(shotPath, dest);
  return dest;
}

async function pressPoint(target) {
  await runAd(["press", String(target.x), String(target.y), "--settle"]);
}

async function fillField(target, text) {
  await runAd(["fill", String(target.x), String(target.y), String(text), "--settle"]);
}

async function pressKey(key) {
  if (key === "return") {
    await runAd(["keyboard", "enter"]);
    return "Pressed keyboard return";
  }
  if (key === "dismiss") {
    await runAd(["keyboard", "dismiss"]);
    return "Dismissed keyboard";
  }
  throw new Error('press key must be "return" or "dismiss"');
}

function swipeCoords(direction) {
  const w = ctx.screenSize.width;
  const h = ctx.screenSize.height;
  const mx = Math.round(w / 2);
  const my = Math.round(h / 2);
  const margin = 0.2;
  const x1 = Math.round(w * margin);
  const x2 = Math.round(w * (1 - margin));
  const y1 = Math.round(h * margin);
  const y2 = Math.round(h * (1 - margin));
  switch (direction) {
    case "up":
      return [mx, y2, mx, y1];
    case "down":
      return [mx, y1, mx, y2];
    case "left":
      return [x2, my, x1, my];
    case "right":
      return [x1, my, x2, my];
    default:
      throw new Error(`Unknown direction: ${direction}`);
  }
}

/** `maxFrames` evenly sampled stills from the clip; none by default, since the contact sheet already shows the whole recording. */
async function extractFrames(videoPath, maxFrames = 0) {
  if (maxFrames <= 0) return [];
  const dir = workDir();
  await mkdir(dir, { recursive: true });
  const outDir = join(dir, `frames-${Date.now()}`);
  await mkdir(outDir, { recursive: true });
  const pattern = join(outDir, "frame-%03d.png");
  await execCmd(
    "ffmpeg",
    [
      "-y",
      "-i",
      videoPath,
      "-vf",
      `fps=${Math.min(4, maxFrames)}`,
      "-frames:v",
      String(maxFrames),
      pattern,
    ],
    60000
  );
  const frames = [];
  for (let i = 1; i <= maxFrames; i += 1) {
    const p = join(outDir, `frame-${String(i).padStart(3, "0")}.png`);
    if (!existsSync(p)) break;
    frames.push(await readBase64(p));
  }
  return frames;
}

/** Runs a command and resolves with its stdout. */
function execCmd(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr || `${cmd} failed`));
      else resolve(stdout);
    });
  });
}

/** Reinstall the app from a copy of its own bundle, which empties its data container and preferences. */
async function resetApp(bundleId) {
  await ensureBound();
  const udid = ctx.binding?.udid;
  if (!/^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/.test(bundleId) || !isUdid(udid ?? "")) {
    throw new Error("open reset:true needs the app's bundle id (for example com.example.app) and a leased simulator.");
  }
  const appPath = (await execCmd("xcrun", ["simctl", "get_app_container", udid, bundleId, "app"])).trim();
  const copy = join(workDir(), `reset-${bundleId}.app`);
  await rm(copy, { recursive: true, force: true });
  await cp(appPath, copy, { recursive: true });
  try {
    await execCmd("xcrun", ["simctl", "terminate", udid, bundleId]).catch(() => {});
    await execCmd("xcrun", ["simctl", "uninstall", udid, bundleId]);
    await execCmd("xcrun", ["simctl", "install", udid, copy], 120000);
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
  ctx.version += 1;
}

/** The accessibility controls plus the screenshot's text as tap targets. `warning` says why OCR was skipped. */
async function withOcr(targets) {
  try {
    const shot = await currentShot("act-ocr");
    const found = ocrTargets(await recognizeText(shot.path), targets);
    return { targets: [...targets, ...found], ocr: true };
  } catch (err) {
    return { targets, warning: `OCR failed: ${err.message}` };
  }
}

async function runActAction(action) {
  if (action.kind === "tap") {
    await pressPoint(action.target);
    const via = action.target.ocr ? " (text read from the screenshot)" : "";
    return `Tapped #${action.target.n} ${action.target.label}${via}`;
  }
  if (action.kind === "type") {
    await fillField(action.target, action.text);
    return `Filled #${action.target.n} ${action.target.label}`;
  }
  if (action.kind === "swipe") {
    const [x1, y1, x2, y2] = swipeCoords(action.direction);
    await runAd(["swipe", String(x1), String(y1), String(x2), String(y2)]);
    return `Swiped ${action.direction}`;
  }
  return pressKey(action.key);
}

const quoted = (text) => JSON.stringify(text);

/** How a node reads in a result: its label, or its type and position when it has none. */
function nodeName(node) {
  if (node.label) return quoted(node.label);
  return `${node.type} at (${Math.round(node.rect.x + node.rect.width / 2)}, ${Math.round(node.rect.y + node.rect.height / 2)})`;
}

/** Run one gesture and report whether the screen changed anywhere; `what` says what was done. */
async function measuredGesture(instruction, what, perform) {
  const before = await currentShot("act-before");
  await perform();
  const after = await currentShot("act-after");
  const diff = await screenDiff(before.path, after.path, [0, ctx.screenSize.height]);
  const label = instruction ? `act ${quoted(instruction)}: ` : "act: ";
  if (diff.changed !== 0) return { outcome: "done", landed: true, summary: `${label}done, ${what}; the screen changed.` };
  return {
    outcome: "stopped",
    landed: false,
    summary: `${label}stopped, ${what} but the screen did not change. The target may not accept it, or it needs a longer hold_ms.`,
  };
}

const clampMs = (value, fallback, min, max) => Math.min(Math.max(Number(value) || fallback, min), max);

async function dragStep(args, instruction) {
  const { from, to, hold_ms: hold } = args.drag;
  if (from == null || to == null) throw new Error("drag needs from and to (a visible label or {x, y}).");
  await snapshotTargets();
  const { source, destination } = dragEnds(ctx.lastNodes, from, to);
  const holdMs = clampMs(hold, 600, 100, 3000);
  return measuredGesture(instruction, `dragged ${nodeName(source)} onto ${nodeName(destination)} (held ${holdMs} ms first)`, () =>
    runAd(["gesture", "drag", `@${source.ref}`, `@${destination.ref}`, String(holdMs), "900", "300"])
  );
}

async function longPressStep(args, instruction) {
  const spec = args.long_press;
  const hold = typeof spec === "object" && spec !== null ? spec.hold_ms : undefined;
  await snapshotTargets();
  const node = gestureNode(ctx.lastNodes, spec);
  const holdMs = clampMs(hold, 800, 100, 5000);
  return measuredGesture(instruction, `long-pressed ${nodeName(node)} for ${holdMs} ms`, () =>
    runAd(["longpress", `@${node.ref}`, String(holdMs), "--settle"])
  );
}

/** "tap <label>" with exactly one control of that label: code answers, no model call. Done only if the screen visibly changed. */
async function directTapStep(instruction, target) {
  const before = await currentShot("act-before");
  await pressPoint(target);
  const after = await currentShot("act-after");
  const effect = effectRecord(await screenDiff(before.path, after.path, [target.y - EFFECT_BAND, target.y + EFFECT_BAND]));
  const tapped = `tapped ${quoted(target.label)}, ${effectText(effect)}`;
  if (effect.screenChanged) {
    return { outcome: "done", landed: true, summary: `act ${quoted(instruction)}: done, ${tapped}.` };
  }
  return { outcome: "acted", landed: false, summary: `act ${quoted(instruction)}: acted but not confirmed, ${tapped}.` };
}

/**
 * Carry out a plain-language instruction on a screen the agent cannot predict.
 * Code owns the loop and the stop rules; TypeSafe only judges "done?" and picks the next action.
 * Outcome: "done" (goal confirmed), "acted" (steps ran, goal unconfirmed; `landed` says whether the last one visibly did something), "stopped" (nothing useful happened).
 */
async function actOn(instruction, args) {
  const client = typesafeClient();
  const maxSteps = Math.min(
    Math.max(Math.round(Number(args.max_steps) || ACT_DEFAULT_STEPS), 1),
    ACT_MAX_STEPS
  );
  const text = args.text != null ? String(args.text) : undefined;
  const history = [];
  const log = [];
  const tried = new Set();
  const notices = new Set();
  let lastEffect = "";
  let landed = false;
  const finish = (outcome, end) => ({
    outcome,
    landed,
    summary: [
      `act "${instruction}": ${end}`,
      ...[...notices].map((n) => `  note: ${n}`),
      ...log.map((h, i) => `  ${i + 1}) ${h}`),
    ].join("\n"),
  });

  for (;;) {
    let targets = await snapshotTargets();
    const cover = await coverOf();
    if (cover.hidden) {
      targets = ocrTargets(cover.items);
      notices.add("a view outside the app's accessibility tree covers the screen, so only the text read from the screenshot (OCR) is offered as tap targets; its icon-only buttons (a close X, a checkmark) have no text, and open with relaunch:true restarts the app");
    }
    const decide = () =>
      decideStep({ instruction, text, targets, history, client, screen: ctx.screenSize, context: cover.hidden ? null : ctx.lastScreen, nodes: cover.hidden ? [] : ctx.lastNodes });
    const useOcr = async (why) => {
      const r = await withOcr(targets);
      if (r.warning) notices.add(r.warning);
      if (r.ocr) notices.add(`${why}, so screenshot text (OCR) is offered as tap targets`);
      targets = r.targets;
    };
    if (needsOcr(targets)) await useOcr("no control has an accessibility label");
    let step = await decide();
    const settled = () => step.doneProbability >= ACT_DONE_MIN || (step.action && step.confidence >= ACT_CONFIDENCE_MIN);
    // Labelled controls can still miss what the goal needs (list rows, ad views): retry once with OCR.
    if (!settled() && !targets.some((t) => t.ocr)) {
      await useOcr("the accessibility controls did not cover the goal");
      step = await decide();
    }
    const doneP = step.doneProbability.toFixed(2);
    if (process.env.SIM_EYES_ACT_DUMP) {
      // Replayable decision states for eval-act.mjs.
      await appendFile(
        process.env.SIM_EYES_ACT_DUMP,
        JSON.stringify({ instruction, text, targets, history, screen: ctx.screenSize, context: ctx.lastScreen, nodes: ctx.lastNodes, step: { ...step, action: undefined } }) + "\n"
      );
    }
    if (step.doneProbability >= ACT_DONE_MIN) {
      return finish("done", `done after ${history.length} step(s) (done p=${doneP}).`);
    }
    const acted = history.length > 0;
    // Taken steps whose result the screen's controls and text cannot confirm (a checkmark, a switch).
    const unconfirmed = (why) =>
      finish(
        "acted",
        `acted but not confirmed (${why}). ${history.length} step(s) taken${
          lastEffect ? `; the last one ${lastEffect}` : ""
        }. The goal could not be confirmed from the controls or text on screen: check the screenshot.`
      );
    if (history.length >= maxSteps) {
      return unconfirmed(`done p=${doneP} after ${maxSteps} step(s)`);
    }
    if (!step.action || step.confidence < ACT_CONFIDENCE_MIN) {
      const noBack = !acted && BACK_GOAL.test(instruction) && !cover.hidden && backTargets(targets).length === 0;
      const why = step.action
        ? `unsure of the next step (${step.key}, confidence ${step.confidence.toFixed(2)})`
        : noBack
          ? "this screen has no Back button, so there is nothing to go back to (a tab root?)"
          : "no action on this screen helps";
      if (acted) return unconfirmed(why);
      return finish(
        "stopped",
        `stopped, ${why}. Word the goal as one step ("tap <label>", "scroll down"), or use drag / long_press for gestures. If the control appears after a delay (an ad's Close button, a loading screen), run act again with wait_ms.`
      );
    }
    const attempt = `${screenSignature(targets)}#${step.key}`;
    if (tried.has(attempt)) {
      return finish("stopped", `stuck: "${step.key}" again on an unchanged screen.`);
    }
    tried.add(attempt);
    const record = stepRecord(step.action, ctx.lastScreen?.title, ctx.lastScreen?.page);
    history.push(record);
    const measure = step.action.kind === "tap";
    const before = measure ? await currentShot("act-before") : null;
    const done = await runActAction(step.action);
    lastEffect = "";
    landed = true;
    if (measure) {
      const after = await currentShot("act-after");
      const y = step.action.target.y;
      const effect = effectRecord(await screenDiff(before.path, after.path, [y - EFFECT_BAND, y + EFFECT_BAND]));
      record.effect = effect;
      lastEffect = effectText(effect);
      landed = effect.screenChanged;
    }
    log.push(`${done} (confidence ${step.confidence.toFixed(2)})${lastEffect ? `, ${lastEffect}` : ""}`);
  }
}

/** One act step: wait, then a gesture, a direct tap, a plain look (no instruction), or the model-driven loop. */
async function actStep(args) {
  const instruction = String(args.instruction ?? "").trim();
  if (args.wait_ms != null) {
    await sleep(clampMs(args.wait_ms, 0, 0, 10000));
    ctx.version += 1; // a screen that was loading or animating is not the one cached
  }
  if (args.drag) return dragStep(args, instruction);
  if (args.long_press) return longPressStep(args, instruction);
  const targets = await snapshotTargets();
  if (!instruction) return { outcome: "done", landed: true, summary: "act: looked at the screen." };
  // Under a cover the tree's controls are not the ones on screen: a tap by their position would hit the cover.
  const direct = (await coverOf()).hidden ? null : directTapTarget(instruction, targets, ctx.lastNodes);
  if (direct) return directTapStep(instruction, direct);
  return actOn(instruction, args);
}

function statusText() {
  const lines = [
    `instance: ${INSTANCE_ID}`,
    `pool: ${usePool() ? findSimPoolBin() : "disabled/unavailable"}`,
  ];
  lines.push(`client_session_id: ${ctx.id}`);
  if (ctx.binding) {
    lines.push(
      `bound: yes`,
      `agent_device_session: ${ctx.binding.session}`,
      `udid: ${ctx.binding.udid}`,
      `name: ${ctx.binding.name}`,
      `lease: ${ctx.binding.leaseId || "(none)"}`,
      `expires: ${ctx.binding.expiresAt || "(n/a)"}`
    );
  } else {
    lines.push(`bound: no (batch/acquire will lease via sim-pool)`);
  }
  return lines.join("\n");
}

const APP_DESCRIPTION =
  "Required. Display name or bundle id this session attaches to, without relaunching it. Omitting it attaches to the home screen and backgrounds the app under test.";

/** The only steps a batch runs. Everything that touches the screen goes through act. */
const STEP_TOOLS = new Set(["act", "open", "record"]);

/** Tools that existed before sim-eyes became act-only, and what to send instead. */
const RETIRED_TOOLS = {
  look: '{"tool":"act"} (no instruction: the step reports the screen)',
  tap: '{"tool":"act","instruction":"tap <label>"}',
  swipe: '{"tool":"act","instruction":"scroll down"}',
  drag: '{"tool":"act","drag":{"from":"<label>","to":"<label>"}}',
  type: '{"tool":"act","instruction":"type into <field>","text":"…"}',
  press: '{"tool":"act","instruction":"press return"}',
  wait: '{"tool":"act","wait_ms":700}',
};

function retiredToolMessage(name) {
  return `"${name}" is not available: sim-eyes is act-only. Send ${RETIRED_TOOLS[name]} as a step of batch.actions[]. Several steps can be queued in one call.`;
}

/** Shared catalog for MCP instructions and the batch tool description (keep in sync with README). */
const BATCH_ACTION_CATALOG = `MCP tools: acquire, release, status, batch — each takes session_id (omit only on the first acquire/batch). Simulator input is ONLY batch.actions[], and there it is act: sim-eyes has no tap, swipe, type, look or wait tools.

Each step is one object: { "tool": "act" | "open" | "record", ...args }.

| tool | Use when | Arguments |
| --- | --- | --- |
| act | Every interaction, and every look at the screen | instruction (plain language, one goal); optional text (the only text act may type), max_steps (default ${ACT_DEFAULT_STEPS}, max ${ACT_MAX_STEPS}), wait_ms (pause first, max 10000), drag {from, to, hold_ms}, long_press (label, {x, y} or {label|x,y, hold_ms}), controls:true (list controls with positions), save (screenshot path) |
| open | Launch or restart the app | name (default: the batch app); relaunch:true restarts it; reset:true wipes its data first (bundle id required) |
| record | Capture video | action: start or stop; stop returns a contact sheet, plus frames (0–6, default 0) |

Rules:
- Queue whole flows: put 5–20 steps in ONE batch. Every extra call costs a round-trip and an agent turn. Split only where you must read the screen to decide the next step.
- Give each act one goal, worded the way the screen does: "tap Next", "select English", "open Rearrange pages", "scroll down", "go back". "tap <label>" where exactly one control has that exact label is carried out by code with no model call, so it is the fastest and most exact form. Other goals use one model call per step taken and need TYPESAFE_API_KEY.
- Every step reports the screen afterwards in text: its title, the pager position ("Page 2 of 3"), any alert, visible texts and control labels. Read that instead of asking for a screenshot. act with no instruction only reports the screen.
- Only the last step returns a screenshot (and any step that fails). Pass image:false on the batch to leave it out when the text is enough, and save with an absolute path to keep one of an earlier step.
- Reorder, move or hold-to-act: drag {"from":"1","to":"5"} holds the source, then drags it onto the target. from, to and long_press name a visible label (page numbers and row titles count) or a point {"x":…,"y":…}. A label shared by two elements is an error that lists them. Add hold_ms (default 600 for drag, 800 for long_press) if the item does not pick up.
- Typing: pass text with the instruction ("type into Search", text "clip"); act never invents text.
- Results: "done" means the goal was confirmed. "acted but not confirmed" means steps ran but the goal could not be read from the screen: when the last step visibly changed the screen the batch continues, otherwise it stops. "stopped" or "stuck" means nothing useful happened and the batch stops. Pass continue_on_fail:true on the batch to keep going anyway.
- act sees the accessibility controls. When no control has a label, or none of them gets it anywhere, it also reads the screenshot's text (OCR). After every tap it compares the screen before and after, which is how a checkmark or switch is confirmed.`;

const INSTRUCTIONS = `sim-eyes drives one leased iOS simulator per session_id. ${SESSION_ID_RULE}

First acquire or batch in a chat: omit session_id; the response begins with session_id=…. Every later call (batch, acquire, status, release) must pass that same session_id. Call release with session_id when QA ends.

${BATCH_ACTION_CATALOG}

Example (one call for a whole flow): { "app": "com.example.app", "actions": [{ "tool": "act", "instruction": "tap Settings" }, { "tool": "act", "instruction": "tap Files", "wait_ms": 700 }, { "tool": "act", "drag": { "from": "1", "to": "5" } }, { "tool": "act", "instruction": "tap Save", "save": "/abs/path/evidence/saved.png" }] }`;

const server = new Server(
  { name: "sim-eyes", version: "1.4.0" },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
);

const GESTURE_TARGET = {
  anyOf: [
    { type: "string", description: "Label of a visible element." },
    {
      type: "object",
      properties: { x: { type: "number" }, y: { type: "number" } },
      required: ["x", "y"],
      description: "A point in points; the smallest element containing it is used.",
    },
  ],
};

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "acquire",
      description: `Lease one simulator for this session_id via sim-pool (no UDID in mcp.json). ${SESSION_ID_RULE} app is required (name or bundle id): the session attaches to that app without relaunching it. Optional prefer_udid / prefer_device on the tool args only: if sim-pool cannot grant that simulator the call fails and says why, it never hands you a different one silently. rebind:true switches simulators for this session_id.`,
      inputSchema: {
        type: "object",
        properties: {
          ...SESSION_ID_PROPERTY,
          prefer_udid: {
            type: "string",
            description: "Whitelisted simulator UDID. The call fails if it is leased to another owner or not whitelisted. Omit it to take any free device.",
          },
          prefer_device: {
            type: "string",
            description: "Simulator display name (resolved to UDID). Ignored when prefer_udid is set. Fails like prefer_udid when not granted.",
          },
          app: {
            type: "string",
            description: APP_DESCRIPTION,
          },
          rebind: {
            type: "boolean",
            description:
              "When this session_id is already bound: release its lease and acquire again (honors prefer_*).",
          },
        },
        required: ["app"],
      },
    },
    {
      name: "release",
      description: `Release this session_id's sim-pool lease. session_id is required.`,
      inputSchema: {
        type: "object",
        properties: { ...SESSION_ID_PROPERTY },
        required: ["session_id"],
      },
    },
    {
      name: "status",
      description:
        "Show this session_id's simulator binding and host sim-pool status. session_id is required.",
      inputSchema: {
        type: "object",
        properties: { ...SESSION_ID_PROPERTY },
        required: ["session_id"],
      },
    },
    {
      name: "batch",
      description: `Run simulator steps in order. Pass one step or queue many to save round-trips.

${BATCH_ACTION_CATALOG}

Response: one entry per step (the act result, then the screen it left behind), a line of control labels, and the final screenshot. A failed step ends the batch with the controls listed with positions and a screenshot.`,
      inputSchema: {
        type: "object",
        properties: {
          ...SESSION_ID_PROPERTY,
          app: {
            type: "string",
            description: APP_DESCRIPTION,
          },
          image: {
            type: "boolean",
            description: "Return the final screenshot (default true). false returns text only, which is cheaper when the screen summary is enough. A failed step always returns one.",
          },
          continue_on_fail: {
            type: "boolean",
            description: "Keep running the remaining steps after a step stops or fails (default false: the batch ends there).",
          },
          actions: {
            type: "array",
            minItems: 1,
            description:
              "Steps to run in order. Each element is { tool, ... } with tool act, open or record. See the batch tool description for the fields.",
            items: {
              type: "object",
              description: "One simulator step. Required: tool. Other fields depend on tool.",
              properties: {
                tool: {
                  type: "string",
                  enum: [...STEP_TOOLS],
                  description: "act = every interaction and look; open = launch/restart/reset the app; record = video.",
                },
                instruction: {
                  type: "string",
                  description:
                    'act: one goal in plain language, e.g. "tap Next", "select English", "open Wi-Fi settings", "dismiss any alert", "scroll down". Omit it to only look at the screen.',
                },
                text: {
                  type: "string",
                  description: "act: only text the agent may type into a field (act never invents text).",
                },
                max_steps: {
                  type: "number",
                  description: `act: cap on model-driven actions in this step (default ${ACT_DEFAULT_STEPS}, max ${ACT_MAX_STEPS}).`,
                },
                wait_ms: {
                  type: "number",
                  description: "act: pause this long (max 10000) before the step, for a transition, an alert or a loading screen.",
                },
                drag: {
                  type: "object",
                  description: "act: hold the source, then drag it onto the target (reorder a grid or list). No instruction needed.",
                  properties: {
                    from: GESTURE_TARGET,
                    to: GESTURE_TARGET,
                    hold_ms: { type: "number", description: "Hold on the source before moving (default 600, 100–3000)." },
                  },
                  required: ["from", "to"],
                },
                long_press: {
                  ...GESTURE_TARGET,
                  description: "act: long-press a visible label or point. Use {label|x,y, hold_ms} fields via the object form to change the 800 ms default.",
                },
                controls: {
                  type: "boolean",
                  description: "act: list every control with its position after the step (default: control labels only).",
                },
                name: { type: "string", description: "open: app display name or bundle identifier (default: the batch app)." },
                relaunch: {
                  type: "boolean",
                  description: "open: true terminates the app first and starts it fresh (default false: keep a running app).",
                },
                reset: {
                  type: "boolean",
                  description: "open: true reinstalls the app from its own bundle first, so its data, preferences and first-launch state are fresh. Needs the bundle id.",
                },
                action: {
                  type: "string",
                  enum: ["start", "stop"],
                  description: "record: start begins mp4 capture; stop ends it and returns the contact sheet.",
                },
                frames: {
                  type: "number",
                  description: "record stop: extra full-size frames to return, 0–6 (default 0).",
                },
                save: {
                  type: "string",
                  description: "Optional: write this step's screenshot here. Use an absolute path to keep it somewhere; a relative path lands in the session work dir. The reply gives the full path.",
                },
              },
              required: ["tool"],
            },
          },
        },
        required: ["app", "actions"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (Object.hasOwn(RETIRED_TOOLS, name) || STEP_TOOLS.has(name)) {
    const hint = Object.hasOwn(RETIRED_TOOLS, name) ? retiredToolMessage(name) : `"${name}" is a batch step, not a tool. Call batch with actions: [{"tool": "${name}", ...args}].`;
    return { content: [{ type: "text", text: `Error: ${hint}` }], isError: true };
  }
  const result = await handleMcpTool(name, args ?? {});
  delete result.poolBusy;
  return result;
});

async function handleMcpTool(name, rawArgs) {
  let sessionId = null;
  let created = false;
  /** @type {import("./client-sessions.mjs").ClientSession | null} */
  let callCtx = null;
  try {
    if (name === "acquire" || name === "batch") {
      const app = rawArgs?.app;
      if (typeof app !== "string" || !app.trim()) {
        throw new Error(
          `${name} requires app (display name or bundle id). Omitting it attaches to the home screen and backgrounds the app under test.`
        );
      }
    }
    const resolved = registry.resolve(rawArgs?.session_id, {
      allowCreate: name === "acquire" || name === "batch",
      toolName: name,
    });
    callCtx = resolved.ctx;
    ctx = callCtx;
    sessionId = ctx.id;
    created = resolved.created;
    const args = stripSessionArgs(rawArgs);
    if (typeof args?.app === "string" && args.app && args.app !== ctx.app) {
      ctx.app = args.app;
      ctx.appReady = false;
    }

    let result;
    if (name === "batch") {
      result = await runBatch(args.actions, { image: args.image !== false, continueOnFail: args.continue_on_fail === true });
    } else result = await handleToolCore(name, args ?? {});

    return prefixSession(result, sessionId, created);
  } catch (err) {
    const busy =
      err instanceof PoolBusyError || err?.code === "SIM_POOL_BUSY";
    const text = busy
      ? `SIM_POOL_BUSY: ${err.message}\nReport QA inconclusive — do not steal another agent's simulator.`
      : `Error: ${err.message}`;
    return prefixSession(
      {
        content: [{ type: "text", text }],
        isError: true,
        poolBusy: busy,
      },
      sessionId ?? "unknown",
      created
    );
  } finally {
    if (ctx === callCtx) ctx = null;
  }
}

/** acquire, release and status: the tools that are not batch steps. */
async function handleToolCore(name, args) {
  if (name === "status") {
    const pool = await poolStatusText();
    return toolResult(`${statusText()}\n\n--- sim-pool ---\n${pool}`);
  }

  if (name === "acquire") {
    const prefer = {
      preferUdid: args?.prefer_udid,
      preferDevice: args?.prefer_device,
    };
    const rebind = args?.rebind === true;
    if (ctx.binding) {
      if (preferDiffersFromBinding(ctx.binding, prefer) && !rebind) {
        return {
          content: [
            {
              type: "text",
              text: [
                `Already bound to ${ctx.binding.name} (${ctx.binding.udid}).`,
                prefer.preferUdid || prefer.preferDevice
                  ? `You asked for a different simulator (${prefer.preferUdid ?? prefer.preferDevice}).`
                  : "",
                "Use status + sim-pool to see other leases. To switch: acquire with rebind:true and prefer_udid or prefer_device (same session_id).",
                statusText(),
              ]
                .filter(Boolean)
                .join("\n\n"),
            },
          ],
          isError: true,
        };
      }
      if (rebind) {
        await releaseBinding();
      } else {
        await renewLease(ctx.binding.leaseId).catch(() => {});
        return toolResult(
          `Already bound.\n${statusText()}\n\nReuse this session_id until release (or rebind:true to switch simulators).`
        );
      }
    }
    await acquireBinding(prefer);
    const asked = prefer.preferUdid || prefer.preferDevice;
    return toolResult(
      `Acquired simulator for this session_id.${asked ? `\npreference: honored (${asked})` : ""}\n${statusText()}\n\nOther session_ids get other free devices from sim-pool (or SIM_POOL_BUSY).`
    );
  }

  if (name === "release") {
    if (!ctx.binding) {
      registry.delete(ctx.id);
      return toolResult("Nothing to release (not bound). session_id discarded.");
    }
    const before = statusText();
    await releaseBinding();
    registry.delete(ctx.id);
    return toolResult(`Released.\n\nWas:\n${before}`);
  }

  throw new Error(`Unknown tool: ${name}`);
}

/**
 * What a finished step leaves for the batch response: the screen it left behind (snapshot, plus a
 * screenshot when it is wanted), and `failed` when the batch should stop there.
 */
async function reportScreen({ summary, failed = false }, args, { wantShot, last, image }) {
  await snapshotTargets();
  const cover = await coverOf();
  const shot = failed || wantShot ? await currentShot("look") : null;
  const saved = args.save && shot ? await saveShot(shot.path, args.save) : null;
  const lines = [summary, `   ${cover.hidden ? coveredScreenLine(cover) : screenLine(ctx.lastScreen)}`];
  if (saved) lines.push(`   saved ${saved}`);
  return {
    summary: lines.join("\n"),
    // A failed step lists the controls with positions so the next instruction can be exact.
    detail: cover.hidden
      ? coveredControlsLine()
      : failed || args.controls === true
        ? formatTargets(ctx.lastTargets)
        : controlsLine(ctx.lastTargets),
    image: shot && (failed || (last && image)) ? await readBase64(shot.path) : null,
    failed,
  };
}

async function runStep(tool, args, flags) {
  if (tool === "act") {
    const result = await actStep(args);
    const failed = result.outcome === "stopped" || (result.outcome === "acted" && !result.landed);
    return reportScreen({ summary: result.summary, failed }, args, flags);
  }

  if (tool === "open") {
    const target = args.name ?? ctx.app;
    if (typeof target !== "string" || !target.trim()) throw new Error("open needs name (or the batch app).");
    if (args.reset === true) await resetApp(target);
    await runAd(["open", target, ...(args.relaunch === true || args.reset === true ? ["--relaunch"] : [])], {
      timeoutMs: 180000,
    });
    ctx.appReady = true;
    return reportScreen({ summary: `open: opened ${target}${args.reset === true ? " with its data reset" : ""}.` }, args, flags);
  }

  if (tool === "record") {
    if (args.action === "start") {
      const dir = workDir();
      await mkdir(dir, { recursive: true });
      if (ctx.recordingPath) return { summary: `record: already running (${ctx.recordingPath}).`, detail: "", image: null };
      ctx.recordingPath = join(dir, `clip-${Date.now()}.mp4`);
      try {
        await runAd(["record", "start", ctx.recordingPath, "--scope", "device"]);
      } catch (err) {
        if (!String(err.message).includes("recording already in progress")) throw err;
        await runAd(["record", "stop"]).catch(() => {});
        await runAd(["record", "start", ctx.recordingPath, "--scope", "device"]);
      }
      return { summary: `record: started (${ctx.recordingPath}).`, detail: "", image: null };
    }
    if (args.action === "stop") {
      if (!ctx.recordingPath) throw new Error("No recording in progress");
      const stopOut = await runAd(["record", "stop"]);
      const videoPath = stopOut.trim().split("\n").pop()?.trim() || ctx.recordingPath;
      const sheetPath = videoPath.replace(/\.mp4$/, ".sheet.png");
      const sheetOut = await runAd(["record", "contact-sheet", videoPath, "--out", sheetPath]);
      const images = existsSync(sheetPath) ? [await readBase64(sheetPath)] : [];
      images.push(...(await extractFrames(videoPath, Math.min(Math.max(Math.round(Number(args.frames) || 0), 0), 6))));
      ctx.recordingPath = null;
      return { summary: `record: stopped. ${sheetOut.trim()} Video: ${videoPath}`, detail: "", images };
    }
    throw new Error('record action must be "start" or "stop"');
  }

  throw new Error(`Unknown step: ${tool}`);
}

/** A step that threw: the batch ends there with whatever the screen shows, so the agent can see why. */
async function failedStep(err) {
  if (err instanceof PoolBusyError || err?.code === "SIM_POOL_BUSY") throw err;
  try {
    const screen = await reportScreen({ summary: `failed: ${err.message}`, failed: true }, {}, { wantShot: true, last: true, image: true });
    return screen;
  } catch {
    return { summary: `failed: ${err.message}`, detail: "", image: null, failed: true };
  }
}

async function runBatch(actions, { image = true, continueOnFail = false } = {}) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("batch needs actions: [{tool, ...args}]");
  }
  const bad = actions.find((a) => !STEP_TOOLS.has(a?.tool));
  if (bad) {
    throw new Error(
      Object.hasOwn(RETIRED_TOOLS, bad?.tool)
        ? retiredToolMessage(bad.tool)
        : `batch cannot run "${bad?.tool}". Allowed: ${[...STEP_TOOLS].join(", ")}`
    );
  }
  const log = [];
  const recorded = [];
  let result = null;
  for (const [i, action] of actions.entries()) {
    const { tool, ...args } = action;
    const flags = { wantShot: needsShot(actions, i), last: i === actions.length - 1, image };
    try {
      result = await runStep(tool, args, flags);
    } catch (err) {
      result = await failedStep(err);
    }
    if (result.images) recorded.push(...result.images);
    log.push(`${i + 1}. ${result.summary}`);
    if (result.failed && !continueOnFail) {
      const rest = actions.length - i - 1;
      if (rest > 0) log.push(`${rest} remaining step(s) not run.`);
      break;
    }
  }
  const text = `${log.join("\n")}${result.detail ? `\n\n${result.detail}` : ""}`;
  const images = [...recorded, ...(result.image ? [result.image] : [])];
  return { ...toolResult(text, images), ...(result.failed ? { isError: true } : {}) };
}

function toolResult(text, images) {
  const content = [{ type: "text", text }];
  const list = Array.isArray(images) ? images : images ? [images] : [];
  for (const img of list) {
    content.push({ type: "image", data: img, mimeType: "image/png" });
  }
  return { content };
}

async function releaseAllSessions() {
  for (const session of registry.all()) {
    ctx = session;
    try {
      if (session.binding) await releaseBinding({ closeSession: true });
    } catch {
      /* best effort */
    }
    registry.delete(session.id);
  }
  ctx = null;
}

function installExitHooks() {
  const cleanup = () => {
    releaseAllSessions().finally(() => process.exit(0));
  };
  process.on("SIGINT", cleanup);
  // MCP clients usually end a server by closing stdin; SIGKILL can't be caught (the sweep covers it).
  process.stdin.on("end", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("beforeExit", () => {
    releaseAllSessions().catch(() => {});
  });
}

async function main() {
  await mkdir(WORK_ROOT, { recursive: true });
  installExitHooks();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
