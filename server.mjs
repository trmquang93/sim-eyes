#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { resolveLabel } from "./resolve-label.mjs";

const SESSION = "sim-eyes";
const WORK = join(homedir(), ".local", "sim-eyes", "work");
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

let recordingPath = null;
let screenSize = { width: 402, height: 874 };

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

async function runAd(args, opts) {
  const device = await resolveDevice();
  return spawnAd(
    [
      ...args,
      "--session",
      SESSION,
      "--platform",
      "ios",
      "--device",
      device,
    ],
    opts
  );
}

async function runAdJson(args, opts) {
  const out = await runAd(args, { ...opts, json: true });
  return JSON.parse(out);
}

let cachedDevice = null;

async function resolveDevice() {
  if (cachedDevice) return cachedDevice;
  if (process.env.SIM_EYES_DEVICE) {
    cachedDevice = process.env.SIM_EYES_DEVICE;
    return cachedDevice;
  }
  const out = await spawnAd(["devices"], { json: true, timeoutMs: 30000 });
  const data = JSON.parse(out);
  const sims = (data.data?.devices ?? []).filter(
    (d) => d.platform === "ios" && d.kind === "simulator" && d.booted
  );
  if (sims.length === 0) {
    const name = process.env.SIM_EYES_BOOT_DEVICE ?? "iPhone 17";
    await spawnAd(
      ["boot", "--platform", "ios", "--device", name],
      { timeoutMs: 180000 }
    );
    cachedDevice = name;
    return cachedDevice;
  }
  const ours = sims.find((d) => d.claimedBy?.session === SESSION);
  if (ours) {
    cachedDevice = ours.name;
    return cachedDevice;
  }
  const free = sims.find((d) => !d.claimedBy);
  cachedDevice = (free ?? sims[0]).name;
  return cachedDevice;
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

let appReady = false;

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
  await mkdir(WORK, { recursive: true });
  const path = join(WORK, `${tag}-${Date.now()}.png`);
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

async function lookPayload() {
  const targets = await snapshotTargets();
  const shot = await captureScreenshot("look");
  return {
    text: formatTargets(targets),
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
  await mkdir(WORK, { recursive: true });
  const outDir = join(WORK, `frames-${Date.now()}`);
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

const server = new Server(
  { name: "sim-eyes", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "look",
      description:
        "Screenshot of the frontmost simulator app plus numbered tappable controls with point coordinates.",
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
    if (name === "look") {
      const payload = await lookPayload();
      return toolResult(payload.text, payload.image);
    }

    if (name === "open") {
      await runAd(["open", args.name, "--relaunch"], { timeoutMs: 180000 });
      appReady = true;
      const payload = await lookPayload();
      return toolResult(`Opened ${args.name}\n\n${payload.text}`, payload.image);
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
      await runAd([
        "swipe",
        String(x1),
        String(y1),
        String(x2),
        String(y2),
      ]);
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
        await mkdir(WORK, { recursive: true });
        if (recordingPath) {
          return toolResult(`Recording already running.\n${recordingPath}`);
        }
        recordingPath = join(WORK, `clip-${Date.now()}.mp4`);
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
    return {
      content: [{ type: "text", text: `Error: ${err.message}` }],
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

async function main() {
  await mkdir(WORK, { recursive: true });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
