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
import { mkdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolveLabel } from "./resolve-label.mjs";
import {
  PoolBusyError,
  acquireLease,
  defaultInstanceId,
  findSimPoolBin,
  poolStatusText,
  releaseLease,
  renewLease,
} from "./pool.mjs";

const INSTANCE_ID = process.env.SIM_EYES_INSTANCE_ID || defaultInstanceId();
const WORK_ROOT = join(homedir(), ".local", "sim-eyes", "work");
const TAP_TYPES = new Set([
  "Button",
  "Cell",
  "Switch",
  "Tab",
  "Link",
  "MenuItem",
  "SearchField",
  "TextField",
  "SecureTextField",
]);

/** @type {{ leaseId: string, udid: string, name: string, expiresAt: string, session: string } | null} */
let binding = null;
let recordingPath = null;
let screenSize = { width: 402, height: 874 };
let appReady = false;
let releasing = false;

function workDir() {
  const session = binding?.session ?? `sim-eyes-${INSTANCE_ID}`;
  return join(WORK_ROOT, session);
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
  if (binding) {
    await renewLease(binding.leaseId).catch(() => {});
    return binding;
  }

  const prefer =
    preferUdid ||
    process.env.SIM_EYES_PREFER_UDID ||
    process.env.DEVICE_ID ||
    undefined;
  const preferName =
    preferDevice ||
    process.env.SIM_EYES_PREFER_DEVICE ||
    process.env.SIM_EYES_DEVICE ||
    undefined;

  if (usePool()) {
    // Resolve preferred name → udid when only a name is set.
    let udid = prefer;
    if (!udid && preferName) {
      udid = await resolveDeviceNameToUdid(preferName);
    }
    binding = await acquireLease({
      instanceId: INSTANCE_ID,
      preferUdid: udid,
      preferDevice: preferName,
      project: process.env.SIM_EYES_PROJECT || "sim-eyes",
      worktree: process.env.SIM_EYES_WORKTREE || process.cwd(),
      ttl: process.env.SIM_EYES_LEASE_TTL
        ? Number(process.env.SIM_EYES_LEASE_TTL)
        : undefined,
    });
  } else {
    // Single-agent fallback: unique session, but still may share a physical sim.
    const device = prefer || preferName || (await pickAnyBootedDevice());
    binding = {
      leaseId: "",
      udid: device,
      name: device,
      expiresAt: "",
      session: `sim-eyes-${INSTANCE_ID}`,
    };
  }
  await mkdir(workDir(), { recursive: true });
  return binding;
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
  if (!binding) await acquireBinding();
  else if (binding.leaseId) {
    try {
      await renewLease(binding.leaseId);
    } catch (err) {
      binding = null;
      throw new Error(
        `Lease lost (${err.message}). Call acquire again or mark QA inconclusive.`
      );
    }
  }
  return binding;
}

async function releaseBinding({ closeSession = true } = {}) {
  if (releasing || !binding) return;
  releasing = true;
  const current = binding;
  binding = null;
  appReady = false;
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
    releasing = false;
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

function center(rect) {
  return {
    x: Math.round(rect.x + rect.width / 2),
    y: Math.round(rect.y + rect.height / 2),
  };
}

function listTargets(nodes) {
  const items = [];
  let n = 0;
  for (const node of nodes) {
    if (!node.enabled) continue;
    if (!node.rect || node.rect.width < 8 || node.rect.height < 8) continue;
    const isField =
      node.type?.includes("TextField") ||
      node.type === "SearchField" ||
      node.editable;
    const isTap =
      TAP_TYPES.has(node.type) ||
      node.type?.includes("Button") ||
      node.type === "Cell" ||
      isField;
    if (!isTap) continue;
    const label = (node.label || node.identifier || node.type || "item")
      .split("\n")[0]
      .slice(0, 60);
    const c = center(node.rect);
    n += 1;
    items.push({ n, label, x: c.x, y: c.y, editable: !!isField });
  }
  return items;
}

async function ensureApp() {
  if (appReady) return;
  await runAd(["open", "Settings", "--relaunch"], { timeoutMs: 180000 });
  appReady = true;
}

async function snapshotTargets() {
  await ensureApp();
  const data = await runAdJson(["snapshot", "-i"]);
  const nodes = data.data?.nodes ?? [];
  if (nodes[0]?.rect) {
    screenSize = {
      width: nodes[0].rect.width,
      height: nodes[0].rect.height,
    };
  }
  return listTargets(nodes);
}

async function captureScreenshot(tag = "screen") {
  const dir = workDir();
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${tag}-${Date.now()}.png`);
  await runAd(["screenshot", path, "--pixel-density", "1"]);
  const buf = await readFile(path);
  return { path, base64: buf.toString("base64") };
}

function formatTargets(targets) {
  if (targets.length === 0) return "No tappable controls found.";
  return targets
    .map((t) => `${t.n}. ${t.label} (${t.x}, ${t.y})`)
    .join("\n");
}

function bindingBanner() {
  if (!binding) return "";
  return `[session ${binding.session} · ${binding.name} · ${binding.udid}]\n`;
}

async function lookPayload() {
  const targets = await snapshotTargets();
  const shot = await captureScreenshot("look");
  return {
    text: bindingBanner() + formatTargets(targets),
    image: shot.base64,
    targets,
  };
}

async function afterMutation() {
  return lookPayload();
}

async function pressExactLabel(label) {
  const escaped = String(label).replace(/"/g, '\\"');
  try {
    await runAd(["press", `label="${escaped}"`, "--settle"]);
    return true;
  } catch {
    return false;
  }
}

async function tapByLabel(label) {
  if (await pressExactLabel(label)) {
    return { skipped: false, note: null };
  }

  const targets = await snapshotTargets();
  const resolved = await resolveLabel(label, targets);
  if (!resolved.target) {
    const list = formatTargets(targets);
    const hint = process.env.TYPESAFE_API_KEY
      ? "Could not match that label."
      : "Could not match that label. Set TYPESAFE_API_KEY for fuzzy matching.";
    return { note: `${hint}\n\n${list}`, skipped: true };
  }

  await runAd([
    "press",
    String(resolved.target.x),
    String(resolved.target.y),
    "--settle",
  ]);
  const via = resolved.typesafeUsed ? " (TypeSafe)" : "";
  return {
    skipped: false,
    note: `Tapped ${resolved.target.label}${via}`,
  };
}

function swipeCoords(direction) {
  const w = screenSize.width;
  const h = screenSize.height;
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

function statusText() {
  const lines = [
    `instance: ${INSTANCE_ID}`,
    `pool: ${usePool() ? findSimPoolBin() : "disabled/unavailable"}`,
  ];
  if (binding) {
    lines.push(
      `bound: yes`,
      `session: ${binding.session}`,
      `udid: ${binding.udid}`,
      `name: ${binding.name}`,
      `lease: ${binding.leaseId || "(none)"}`,
      `expires: ${binding.expiresAt || "(n/a)"}`
    );
  } else {
    lines.push(`bound: no (first look/open/tap will acquire)`);
  }
  return lines.join("\n");
}

const server = new Server(
  { name: "sim-eyes", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "acquire",
      description:
        "Lease an exclusive simulator via sim-pool for this agent. Call before QA when multiple agents share a Mac. Optional prefer_udid / prefer_device.",
      inputSchema: {
        type: "object",
        properties: {
          prefer_udid: { type: "string" },
          prefer_device: { type: "string" },
        },
      },
    },
    {
      name: "release",
      description:
        "Release this agent's simulator lease and close its agent-device session. Call when QA is done.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "status",
      description:
        "Show this MCP process binding and host sim-pool status (who holds which UDID).",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "look",
      description:
        "Screenshot of the frontmost simulator app plus numbered tappable controls with point coordinates. Auto-acquires a lease if needed.",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "open",
      description: "Launch an app by name or bundle id, then return look output.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
    {
      name: "tap",
      description:
        "Tap a control by label from look, or by x/y point coordinates. Returns the next screenshot.",
      inputSchema: {
        type: "object",
        properties: {
          label: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
        },
      },
    },
    {
      name: "swipe",
      description:
        "Swipe up, down, left, or right across the screen. Returns the next screenshot.",
      inputSchema: {
        type: "object",
        properties: {
          direction: {
            type: "string",
            enum: ["up", "down", "left", "right"],
          },
        },
        required: ["direction"],
      },
    },
    {
      name: "drag",
      description:
        "Slow press-and-drag between two points from look. Returns the next screenshot.",
      inputSchema: {
        type: "object",
        properties: {
          x1: { type: "number" },
          y1: { type: "number" },
          x2: { type: "number" },
          y2: { type: "number" },
        },
        required: ["x1", "y1", "x2", "y2"],
      },
    },
    {
      name: "type",
      description:
        "Type text into a named field, or the focused field when label is omitted. Returns the next screenshot.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string" },
          label: { type: "string" },
        },
        required: ["text"],
      },
    },
    {
      name: "record",
      description:
        'Start or stop screen recording. Stop returns changed frames from the clip with timestamps.',
      inputSchema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["start", "stop"] },
        },
        required: ["action"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    if (name === "status") {
      const pool = await poolStatusText();
      return toolResult(`${statusText()}\n\n--- sim-pool ---\n${pool}`);
    }

    if (name === "acquire") {
      if (binding) {
        await renewLease(binding.leaseId).catch(() => {});
        return toolResult(
          `Already bound.\n${statusText()}\n\nReuse this session until release.`
        );
      }
      await acquireBinding({
        preferUdid: args?.prefer_udid,
        preferDevice: args?.prefer_device,
      });
      return toolResult(
        `Acquired exclusive simulator for this agent.\n${statusText()}\n\nOther agents must acquire a different UDID (or wait if the pool is busy).`
      );
    }

    if (name === "release") {
      if (!binding) return toolResult("Nothing to release (not bound).");
      const before = statusText();
      await releaseBinding();
      return toolResult(`Released.\nWas:\n${before}`);
    }

    if (name === "look") {
      const payload = await lookPayload();
      return toolResult(payload.text, payload.image);
    }

    if (name === "open") {
      await runAd(["open", args.name, "--relaunch"], { timeoutMs: 180000 });
      appReady = true;
      const payload = await lookPayload();
      return toolResult(
        `${bindingBanner()}Opened ${args.name}\n\n${payload.text}`,
        payload.image
      );
    }

    if (name === "tap") {
      let tapNote = "";
      if (args.label) {
        const result = await tapByLabel(String(args.label));
        if (result.skipped) {
          const shot = await captureScreenshot("look");
          return toolResult(result.note, shot.base64);
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
        throw new Error("tap needs label or x and y");
      }
      const payload = await afterMutation();
      return toolResult(tapNote + payload.text, payload.image);
    }

    if (name === "swipe") {
      const [x1, y1, x2, y2] = swipeCoords(args.direction);
      await runAd(["swipe", String(x1), String(y1), String(x2), String(y2)]);
      const payload = await afterMutation();
      return toolResult(
        `Swiped ${args.direction}\n\n${payload.text}`,
        payload.image
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
      return toolResult(payload.text, payload.image);
    }

    if (name === "type") {
      if (args.label) {
        const escaped = String(args.label).replace(/"/g, '\\"');
        await runAd(["fill", `label="${escaped}"`, args.text, "--settle"]);
      } else {
        await runAd(["type", args.text]);
        await runAd(["snapshot", "-i"]);
      }
      const payload = await afterMutation();
      return toolResult(payload.text, payload.image);
    }

    if (name === "record") {
      if (args.action === "start") {
        const dir = workDir();
        await mkdir(dir, { recursive: true });
        if (recordingPath) {
          return toolResult(`Recording already running.\n${recordingPath}`);
        }
        recordingPath = join(dir, `clip-${Date.now()}.mp4`);
        try {
          await runAd([
            "record",
            "start",
            recordingPath,
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
            recordingPath,
            "--scope",
            "device",
          ]);
        }
        return toolResult(`Recording started.\n${recordingPath}`);
      }
      if (args.action === "stop") {
        if (!recordingPath) throw new Error("No recording in progress");
        const stopOut = await runAd(["record", "stop"]);
        const videoPath =
          stopOut.trim().split("\n").pop()?.trim() || recordingPath;
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
        recordingPath = null;
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
    };
  }
});

function toolResult(text, images) {
  const content = [{ type: "text", text }];
  const list = Array.isArray(images) ? images : images ? [images] : [];
  for (const img of list) {
    content.push({ type: "image", data: img, mimeType: "image/png" });
  }
  return { content };
}

function installExitHooks() {
  const cleanup = () => {
    releaseBinding().finally(() => process.exit(0));
  };
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
  process.on("beforeExit", () => {
    if (binding) releaseBinding({ closeSession: true }).catch(() => {});
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
