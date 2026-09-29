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
import { spawn } from "node:child_process";
import { appendFile, copyFile, mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolveLabel } from "./resolve-label.mjs";
import {
  ACT_CONFIDENCE_MIN,
  ACT_DEFAULT_STEPS,
  ACT_DONE_MIN,
  ACT_MAX_STEPS,
  decideStep,
  screenSignature,
  stepRecord,
  typesafeClient,
} from "./act.mjs";
import {
  ambiguousLabelNote,
  exactLabelMatches,
  formatTargets,
  keyboardDeleteTarget,
  listTargets,
  screenContext,
  targetByIndex,
} from "./targets.mjs";
import {
  PoolBusyError,
  acquireLease,
  defaultInstanceId,
  findSimPoolBin,
  poolStatusText,
  releaseLease,
  renewLease,
} from "./pool.mjs";
import { preferDiffersFromBinding, SESSION_ID_RULE } from "./binding-prefer.mjs";
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
  return ["npx", "-y", "agent-device"];
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

async function acquireBinding({ preferUdid, preferDevice } = {}) {
  if (ctx.binding) {
    await renewLease(ctx.binding.leaseId).catch(() => {});
    return ctx.binding;
  }

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

async function runAd(args, opts) {
  const b = await ensureBound();
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
  await runAd(["open", "Settings", "--relaunch"], { timeoutMs: 180000 });
  ctx.appReady = true;
}

async function snapshotTargets() {
  await ensureApp();
  const data = await runAdJson(["snapshot", "-i"]);
  const nodes = data.data?.nodes ?? [];
  if (nodes[0]?.rect) {
    ctx.screenSize = {
      width: nodes[0].rect.width,
      height: nodes[0].rect.height,
    };
  }
  const targets = listTargets(nodes);
  ctx.lastTargets = targets;
  ctx.lastScreen = screenContext(nodes);
  return targets;
}

async function captureScreenshot(tag = "screen") {
  const dir = workDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${tag}-${Date.now()}.png`);
  await runAd(["screenshot", path, "--pixel-density", "1"]);
  const buf = await readFile(path);
  return { path, base64: buf.toString("base64") };
}

function bindingBanner() {
  if (!ctx.binding) return "";
  return `[session ${ctx.binding.session} · ${ctx.binding.name} · ${ctx.binding.udid}]\n`;
}

async function lookPayload() {
  const targets = await snapshotTargets();
  const shot = await captureScreenshot("look");
  return {
    text: bindingBanner() + formatTargets(targets),
    image: shot.base64,
    targets,
    shotPath: shot.path,
  };
}

async function saveShot(shotPath, save) {
  if (!save) return "";
  const dest = isAbsolute(save) ? save : join(process.cwd(), save);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(shotPath, dest);
  return `\nSaved ${dest}`;
}

async function respond(text, payload, save) {
  const note = await saveShot(payload.shotPath, save);
  return toolResult(text + note, payload.image);
}

async function afterMutation() {
  return lookPayload();
}

async function pressPoint(target) {
  await runAd([
    "press",
    String(target.x),
    String(target.y),
    "--settle",
  ]);
}

function requireIndex(index) {
  const target = targetByIndex(ctx.lastTargets, index);
  if (!target) {
    const list = formatTargets(ctx.lastTargets);
    throw new Error(
      `No control #${index} in the last look. Pass a number from that list.\n\n${list}`
    );
  }
  return target;
}

async function tapByLabel(label) {
  const targets = await snapshotTargets();
  const exact = exactLabelMatches(targets, label);
  if (exact.length > 1) {
    return { skipped: true, note: ambiguousLabelNote(label, exact) };
  }
  if (exact.length === 1) {
    await pressPoint(exact[0]);
    return { skipped: false, note: `Tapped #${exact[0].n} ${exact[0].label}` };
  }

  const resolved = await resolveLabel(label, targets);
  if (!resolved.target) {
    const list = formatTargets(targets);
    const hint = process.env.TYPESAFE_API_KEY
      ? "Could not match that label."
      : "Could not match that label. Set TYPESAFE_API_KEY for fuzzy matching, or pass index.";
    return { note: `${hint}\n\n${list}`, skipped: true };
  }

  await pressPoint(resolved.target);
  const via = resolved.typesafeUsed ? " (TypeSafe)" : "";
  return {
    skipped: false,
    note: `Tapped #${resolved.target.n} ${resolved.target.label}${via}`,
  };
}

async function fillField(target, text) {
  await runAd([
    "fill",
    String(target.x),
    String(target.y),
    String(text),
    "--settle",
  ]);
}

async function typeText(args) {
  const text = String(args.text ?? "");
  const replace = args.replace === true;

  if (args.index != null) {
    const target = requireIndex(args.index);
    if (!target.editable) {
      throw new Error(
        `#${target.n} ${target.label} is not a text field. Pass the field's index.`
      );
    }
    if (replace) {
      await fillField(target, text);
    } else {
      await pressPoint(target);
      await runAd(["type", text]);
    }
    return { skipped: false, note: null };
  }

  if (args.label) {
    const targets = await snapshotTargets();
    const fields = exactLabelMatches(targets, args.label).filter(
      (t) => t.editable
    );
    if (fields.length > 1) {
      return { skipped: true, note: ambiguousLabelNote(args.label, fields) };
    }
    if (fields.length === 1) {
      // A named field has always been replaced. replace:false appends.
      if (args.replace === false) {
        await pressPoint(fields[0]);
        await runAd(["type", text]);
      } else {
        await fillField(fields[0], text);
      }
      return { skipped: false, note: null };
    }
    const escaped = String(args.label).replace(/"/g, '\\"');
    await runAd(["fill", `label="${escaped}"`, text, "--settle"]);
    return { skipped: false, note: null };
  }

  if (replace) {
    await runAd(["fill", "focused=true", text, "--settle"]);
  } else {
    await runAd(["type", text]);
    await runAd(["snapshot", "-i"]);
  }
  return { skipped: false, note: null };
}

async function pressKey(key) {
  if (key === "search" || key === "return") {
    await runAd(["keyboard", "enter"]);
    return `Pressed keyboard ${key}`;
  }
  if (key === "dismiss") {
    await runAd(["keyboard", "dismiss"]);
    return "Dismissed keyboard";
  }
  if (key === "delete") {
    const keyTarget = keyboardDeleteTarget(ctx.lastTargets, ctx.screenSize.height);
    if (!keyTarget) {
      throw new Error(
        "No keyboard delete key in the last look. Use type with replace:true to set the whole field."
      );
    }
    await pressPoint(keyTarget);
    return "Pressed keyboard delete";
  }
  throw new Error('press key must be "search", "return", "delete", or "dismiss"');
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

async function extractFrames(videoPath, maxFrames = 6) {
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
    const buf = await readFile(p);
    frames.push({ path: p, base64: buf.toString("base64") });
  }
  return frames;
}

function execCmd(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`${cmd} timed out`));
    }, timeoutMs);
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(stderr || `${cmd} failed`));
      else resolve();
    });
  });
}

async function runActAction(action) {
  if (action.kind === "tap") {
    await pressPoint(action.target);
    return `Tapped #${action.target.n} ${action.target.label}`;
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

/**
 * Carry out a plain-language instruction on a screen the agent cannot predict.
 * Code owns the loop and the stop rules; TypeSafe only judges "done?" and picks the next action.
 */
async function actOn(args) {
  const instruction = String(args.instruction ?? "").trim();
  if (!instruction) throw new Error("act needs instruction");
  const client = typesafeClient();
  const maxSteps = Math.min(
    Math.max(Math.round(Number(args.max_steps) || ACT_DEFAULT_STEPS), 1),
    ACT_MAX_STEPS
  );
  const text = args.text != null ? String(args.text) : undefined;
  const history = [];
  const log = [];
  const tried = new Set();
  const note = (end, done) => ({
    done,
    note: [`act "${instruction}": ${end}`, ...log.map((h, i) => `  ${i + 1}) ${h}`)].join("\n"),
  });

  for (;;) {
    const targets = await snapshotTargets();
    const step = await decideStep({ instruction, text, targets, history, client, screen: ctx.screenSize, context: ctx.lastScreen });
    const doneP = step.doneProbability.toFixed(2);
    if (process.env.SIM_EYES_ACT_DUMP) {
      // Replayable decision states for eval-act.mjs.
      await appendFile(
        process.env.SIM_EYES_ACT_DUMP,
        JSON.stringify({ instruction, text, targets, history, screen: ctx.screenSize, context: ctx.lastScreen, step: { ...step, action: undefined } }) + "\n"
      );
    }
    if (step.doneProbability >= ACT_DONE_MIN) {
      return note(`done after ${history.length} step(s) (done p=${doneP}).`, true);
    }
    if (history.length >= maxSteps) {
      return note(`not done after ${maxSteps} step(s) (done p=${doneP}). Look at the screen and continue with explicit steps.`, false);
    }
    if (!step.action || step.confidence < ACT_CONFIDENCE_MIN) {
      const why = step.action
        ? `unsure of the next step (${step.key}, confidence ${step.confidence.toFixed(2)})`
        : "no action on this screen helps";
      return note(`stopped, ${why}. Pass explicit steps or a clearer instruction.`, false);
    }
    const attempt = `${screenSignature(targets)}#${step.key}`;
    if (tried.has(attempt)) {
      return note(`stuck: "${step.key}" again on an unchanged screen.`, false);
    }
    tried.add(attempt);
    history.push(stepRecord(step.action, ctx.lastScreen?.title));
    const done = await runActAction(step.action);
    log.push(`${done} (confidence ${step.confidence.toFixed(2)})`);
  }
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

const BATCH_TOOLS = new Set(["look", "open", "tap", "swipe", "drag", "type", "press", "record", "wait", "act"]);

/** Shared catalog for MCP instructions and the batch tool description (keep in sync with README). */
const BATCH_ACTION_CATALOG = `MCP tools (not batch steps): acquire, release, status, batch — each takes session_id (omit only on the first acquire/batch). Simulator input is ONLY batch.actions[] — calling look/tap/… as top-level tools returns an error.

Each action is one object: { "tool": "<name>", ...args }. Optional on every action: save (file path for that step's screenshot).

| tool | Use when | Arguments (besides save) |
| --- | --- | --- |
| look | Refresh screenshot + numbered controls without tapping | (none) |
| open | Launch or relaunch an app | name (display name or bundle id) |
| tap | Target is known from the last step's control list | index (from list), or label, or x + y |
| swipe | Scroll or page | direction: up, down, left, or right |
| drag | Custom pan gesture | x1, y1, x2, y2 (points) |
| type | Enter text in a known field | text + index or label; optional replace:true (replace whole field) |
| press | Keyboard key (not a row with the same name) | key: search, return, delete, or dismiss |
| record | Screen capture to mp4 | action: start or stop (stop also returns contact sheet / frames) |
| wait | Animation or load time | ms (0–10000) |
| act | Screen is unpredictable — do not guess tap/type | instruction (required); optional text (only text act may type); optional max_steps (default ${ACT_DEFAULT_STEPS}, max ${ACT_MAX_STEPS}) |

Rules:
- Queue predictable steps in one batch (e.g. open → wait → tap → type → press). index/label always refer to the control list from the step before.
- The batch stops on the first error, ambiguous label (two indexes share a label), skipped tap/type, or act stuck/skipped. Remaining queued steps are not run — continue in a new batch.
- Unpredictable UI (permissions, alerts, lists you have not seen): use act, read the step log + final screenshot, then batch explicit tap/type steps.
- act repeats look → TypeSafe picks one action → run until goal met, max_steps, low confidence, no helpful action, or same action on an unchanged screen. Needs TYPESAFE_API_KEY.`;

const INSTRUCTIONS = `sim-eyes drives one leased iOS simulator per session_id. ${SESSION_ID_RULE}

First acquire or batch in a chat: omit session_id; the response begins with session_id=…. Every later call (batch, acquire, status, release) must pass that same session_id. Call release with session_id when QA ends.

${BATCH_ACTION_CATALOG}

Example: { "actions": [{ "tool": "open", "name": "VideoTools" }, { "tool": "wait", "ms": 1500 }, { "tool": "act", "instruction": "allow notifications if a system dialog appears" }] }`;

const server = new Server(
  { name: "sim-eyes", version: "1.3.0" },
  { capabilities: { tools: {} }, instructions: INSTRUCTIONS }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "acquire",
      description: `Lease one simulator for this session_id via sim-pool (no UDID in mcp.json). ${SESSION_ID_RULE} Optional prefer_udid / prefer_device on the tool args only. rebind:true switches simulators for this session_id.`,
      inputSchema: {
        type: "object",
        properties: {
          ...SESSION_ID_PROPERTY,
          prefer_udid: {
            type: "string",
            description: "Whitelisted simulator UDID. Fails if leased to another owner unless pool assigns you a different free device when omitted.",
          },
          prefer_device: {
            type: "string",
            description: "Simulator display name (resolved to UDID). Ignored when prefer_udid is set.",
          },
          rebind: {
            type: "boolean",
            description:
              "When this session_id is already bound: release its lease and acquire again (honors prefer_*).",
          },
        },
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
      description: `Run simulator steps in order. Pass one action or queue many to save round-trips.

${BATCH_ACTION_CATALOG}

Response: one log line per completed step, then the final screenshot (image) and numbered tappable controls (text). act steps include a multi-line log in the first paragraph; the control list follows after a blank line.`,
      inputSchema: {
        type: "object",
        properties: {
          ...SESSION_ID_PROPERTY,
          actions: {
            type: "array",
            minItems: 1,
            description:
              "Steps to run in order. Each element is { tool, ... }. Allowed tool values: look, open, tap, swipe, drag, type, press, record, wait, act. See the batch tool description for which fields each tool needs.",
            items: {
              type: "object",
              description:
                "One simulator step. Required: tool. Other fields depend on tool (see catalog in batch description). save is optional on any tool.",
              properties: {
                tool: {
                  type: "string",
                  enum: [...BATCH_TOOLS],
                  description:
                    "Step kind. look=screenshot; open=name; tap=index|label|x+y; swipe=direction; drag=x1,y1,x2,y2; type=text+(index|label); press=key; record=action start|stop; wait=ms; act=instruction (+ optional text, max_steps).",
                },
                index: {
                  type: "number",
                  description: "tap, type: control number from the previous step's list (not from an earlier step).",
                },
                label: {
                  type: "string",
                  description: "tap, type: accessibility label. Fails if two controls share the label (reply lists indexes).",
                },
                x: { type: "number", description: "tap: x coordinate (use with y instead of index/label)." },
                y: { type: "number", description: "tap: y coordinate (use with x)." },
                x1: { type: "number", description: "drag: start x." },
                y1: { type: "number", description: "drag: start y." },
                x2: { type: "number", description: "drag: end x." },
                y2: { type: "number", description: "drag: end y." },
                direction: {
                  type: "string",
                  enum: ["up", "down", "left", "right"],
                  description: "swipe: scroll/page direction.",
                },
                text: {
                  type: "string",
                  description: "type: characters to enter. act: only text the agent may type into a field (act never invents text).",
                },
                replace: {
                  type: "boolean",
                  description: "type only: true replaces the whole field; false appends.",
                },
                key: {
                  type: "string",
                  enum: ["search", "return", "delete", "dismiss"],
                  description: "press: keyboard key (search/return submit, dismiss hides keyboard, delete is backspace).",
                },
                name: { type: "string", description: "open: app display name or bundle identifier." },
                action: {
                  type: "string",
                  enum: ["start", "stop"],
                  description: "record: start begins mp4 capture; stop ends it and returns frames.",
                },
                ms: { type: "number", description: "wait: delay in milliseconds (capped at 10000)." },
                instruction: {
                  type: "string",
                  description:
                    "act: plain-language goal for an unpredictable screen, e.g. \"dismiss any alert\", \"open the first video in the list\", \"open Wi-Fi settings\".",
                },
                max_steps: {
                  type: "number",
                  description: `act only: cap on TypeSafe-driven actions in this act step (default ${ACT_DEFAULT_STEPS}, max ${ACT_MAX_STEPS}).`,
                },
                save: {
                  type: "string",
                  description: "Optional on any tool: write this step's screenshot to this path (relative to process cwd).",
                },
              },
              required: ["tool"],
            },
          },
        },
        required: ["actions"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  if (BATCH_TOOLS.has(name)) {
    return {
      content: [
        {
          type: "text",
          text: `Error: "${name}" is not a tool. Call batch with actions: [{"tool": "${name}", ...args}]. You can queue several actions in one call.`,
        },
      ],
      isError: true,
    };
  }
  const result = await handleMcpTool(name, args ?? {});
  delete result.poolBusy;
  delete result.skipped;
  return result;
});

async function handleMcpTool(name, rawArgs) {
  let sessionId = null;
  let created = false;
  /** @type {import("./client-sessions.mjs").ClientSession | null} */
  let callCtx = null;
  try {
    const resolved = registry.resolve(rawArgs?.session_id, {
      allowCreate: name === "acquire" || name === "batch",
      toolName: name,
    });
    callCtx = resolved.ctx;
    ctx = callCtx;
    sessionId = ctx.id;
    created = resolved.created;
    const args = stripSessionArgs(rawArgs);

    let result;
    if (name === "batch") result = await runBatch(args.actions);
    else result = await handleToolCore(name, args ?? {});

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

async function handleToolCore(name, args) {
  try {
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
      return toolResult(
        `Acquired simulator for this session_id.\n${statusText()}\n\nOther session_ids get other free devices from sim-pool (or SIM_POOL_BUSY).`
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

    if (name === "look") {
      const payload = await lookPayload();
      return respond(payload.text, payload, args.save);
    }

    if (name === "open") {
      await runAd(["open", args.name, "--relaunch"], { timeoutMs: 180000 });
      ctx.appReady = true;
      const payload = await lookPayload();
      return respond(
        `${bindingBanner()}Opened ${args.name}\n\n${payload.text}`,
        payload,
        args.save
      );
    }

    if (name === "tap") {
      let tapNote = "";
      if (args.index != null) {
        const target = requireIndex(args.index);
        await pressPoint(target);
        tapNote = `Tapped #${target.n} ${target.label}\n\n`;
      } else if (args.label) {
        const result = await tapByLabel(String(args.label));
        if (result.skipped) {
          const shot = await captureScreenshot("look");
          const saved = await saveShot(shot.path, args.save);
          return {
            ...toolResult(`${result.note}${saved}`, shot.base64),
            skipped: true,
          };
        }
        tapNote = result.note ? `${result.note}\n\n` : "";
      } else if (args.x != null && args.y != null) {
        await runAd([
          "press",
          String(Math.round(args.x)),
          String(Math.round(args.y)),
          "--settle",
        ]);
      } else {
        throw new Error("tap needs index, label, or x and y");
      }
      const payload = await afterMutation();
      return respond(tapNote + payload.text, payload, args.save);
    }

    if (name === "swipe") {
      const [x1, y1, x2, y2] = swipeCoords(args.direction);
      await runAd(["swipe", String(x1), String(y1), String(x2), String(y2)]);
      const payload = await afterMutation();
      return respond(
        `Swiped ${args.direction}\n\n${payload.text}`,
        payload,
        args.save
      );
    }

    if (name === "drag") {
      const dx = Math.round(args.x2 - args.x1);
      const dy = Math.round(args.y2 - args.y1);
      await runAd([
        "gesture",
        "pan",
        String(Math.round(args.x1)),
        String(Math.round(args.y1)),
        String(dx),
        String(dy),
        "600",
      ]);
      const payload = await afterMutation();
      return respond(payload.text, payload, args.save);
    }

    if (name === "type") {
      const typed = await typeText(args);
      if (typed.skipped) {
        const shot = await captureScreenshot("look");
        const saved = await saveShot(shot.path, args.save);
        return { ...toolResult(`${typed.note}${saved}`, shot.base64), skipped: true };
      }
      const payload = await afterMutation();
      return respond(payload.text, payload, args.save);
    }

    if (name === "press") {
      const note = await pressKey(String(args.key));
      const payload = await afterMutation();
      return respond(`${note}\n\n${payload.text}`, payload, args.save);
    }

    if (name === "record") {
      if (args.action === "start") {
        const dir = workDir();
        await mkdir(dir, { recursive: true });
        if (ctx.recordingPath) {
          return toolResult(`Recording already running.\n${ctx.recordingPath}`);
        }
        ctx.recordingPath = join(dir, `clip-${Date.now()}.mp4`);
        try {
          await runAd([
            "record",
            "start",
            ctx.recordingPath,
            "--scope",
            "device",
          ]);
        } catch (err) {
          if (!String(err.message).includes("recording already in progress")) {
            throw err;
          }
          await runAd(["record", "stop"]).catch(() => {});
          await runAd([
            "record",
            "start",
            ctx.recordingPath,
            "--scope",
            "device",
          ]);
        }
        return toolResult(`Recording started.\n${ctx.recordingPath}`);
      }
      if (args.action === "stop") {
        if (!ctx.recordingPath) throw new Error("No recording in progress");
        const stopOut = await runAd(["record", "stop"]);
        const videoPath =
          stopOut.trim().split("\n").pop()?.trim() || ctx.recordingPath;
        const sheetPath = videoPath.replace(/\.mp4$/, ".sheet.png");
        const sheetOut = await runAd([
          "record",
          "contact-sheet",
          videoPath,
          "--out",
          sheetPath,
        ]);
        const sheetBase64 = existsSync(sheetPath)
          ? (await readFile(sheetPath)).toString("base64")
          : null;
        const frames = await extractFrames(videoPath, 6);
        const images = [];
        if (sheetBase64) images.push(sheetBase64);
        for (const f of frames) images.push(f.base64);
        ctx.recordingPath = null;
        const summary = [
          "Recording stopped.",
          sheetOut.trim(),
          `Video: ${videoPath}`,
          `Extracted ${frames.length} frame(s).`,
        ].join("\n");
        return toolResult(summary, images);
      }
      throw new Error('record action must be "start" or "stop"');
    }

    if (name === "act") {
      const result = await actOn(args);
      const payload = await lookPayload();
      const text = `${result.note}\n\n${payload.text}`;
      const response = await respond(text, payload, args.save);
      return result.done ? response : { ...response, skipped: true };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    const busy =
      err instanceof PoolBusyError || err?.code === "SIM_POOL_BUSY";
    const text = busy
      ? `SIM_POOL_BUSY: ${err.message}\nReport QA inconclusive — do not steal another agent's simulator.`
      : `Error: ${err.message}`;
    return {
      content: [{ type: "text", text }],
      isError: true,
      poolBusy: busy,
    };
  }
}

/** First line of a step's text plus any "Saved" line; the full target list is only shown for the last step. */
function stepSummary(text) {
  const lines = text.split("\n").filter((l) => l && !l.startsWith("[session"));
  const saved = lines.filter((l) => l.startsWith("Saved "));
  return [lines[0] ?? "", ...saved.filter((l) => l !== lines[0])].join(" · ");
}

async function runBatch(actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    throw new Error("batch needs actions: [{tool, ...args}]");
  }
  const bad = actions.find((a) => !BATCH_TOOLS.has(a?.tool));
  if (bad) {
    throw new Error(
      `batch cannot run "${bad?.tool}". Allowed: ${[...BATCH_TOOLS].join(", ")}`
    );
  }
  const log = [];
  let last = null;
  for (const [i, action] of actions.entries()) {
    const { tool, ...args } = action;
    const step = `${i + 1}. ${tool}`;
    if (tool === "wait") {
      const ms = Math.min(Math.max(Number(args.ms) || 500, 0), 10000);
      await new Promise((resolve) => setTimeout(resolve, ms));
      log.push(`${step}: waited ${ms}ms`);
      last = null; // a trailing wait should end on a fresh screenshot
      continue;
    }
    const result = await handleToolCore(tool, args);
    const text = result.content[0]?.text ?? "";
    if (result.isError || result.skipped) {
      const why = result.isError ? "failed" : "skipped";
      const rest = actions.length - i - 1;
      log.push(`${step} ${why}; ${rest} remaining step(s) not run.\n\n${text}`);
      return {
        ...result,
        content: [{ type: "text", text: log.join("\n") }, ...result.content.slice(1)],
        isError: true,
      };
    }
    const summary =
      tool === "act"
        ? text.split("\n\n")[0]
        : tool === "look" ? `${ctx.lastTargets.length} controls${stepSummary(text).match(/ · Saved .*/)?.[0] ?? ""}` : stepSummary(text);
    log.push(`${step}: ${summary}`);
    last = result;
  }
  if (!last) {
    const payload = await lookPayload();
    return toolResult(`${log.join("\n")}\n\n${payload.text}`, payload.image);
  }
  let lastText = last.content[0]?.text ?? "";
  if (actions.at(-1)?.tool === "act") lastText = lastText.split("\n\n").slice(1).join("\n\n");
  return {
    content: [
      { type: "text", text: `${log.join("\n")}\n\n${lastText}` },
      ...last.content.slice(1),
    ],
  };
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
