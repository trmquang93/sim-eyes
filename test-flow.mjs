#!/usr/bin/env node
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const serverPath = join(dirname(fileURLToPath(import.meta.url)), "server.mjs");
const child = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, SIM_EYES_DEVICE: "iPhone 17" },
});

let buf = "";
let nextId = 1;

function send(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return id;
}

const pending = new Map();

child.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  }
});

const ACTIONS = new Set(["look", "open", "tap", "swipe", "drag", "type", "press", "record"]);
/** Action tools only exist inside batch; wrap a single one. */
function toCall(name, args) {
  return ACTIONS.has(name)
    ? { name: "batch", arguments: { app: "Settings", actions: [{ tool: name, ...args }] } }
    : { name, arguments: args };
}

function callTool(name, args = {}) {
  return new Promise((resolve) => {
    const id = send("tools/call", toCall(name, args));
    pending.set(id, resolve);
  });
}

async function run() {
  const initId = send("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "flow", version: "1" },
  });
  await new Promise((r) => pending.set(initId, r));

  const look = await callTool("look");
  const lookText = look.result.content.find((c) => c.type === "text").text;
  console.log("LOOK:", lookText.split("\n").slice(0, 4).join("\n"));
  console.log("LOOK images:", look.result.content.filter((c) => c.type === "image").length);

  const tap = await callTool("tap", { label: "General" });
  const tapText = tap.result.content.find((c) => c.type === "text").text;
  console.log("TAP:", tapText.split("\n").slice(0, 4).join("\n"));
  console.log("TAP images:", tap.result.content.filter((c) => c.type === "image").length);
  console.log("TAP error:", tap.result.isError);

  const recStart = await callTool("record", { action: "start" });
  console.log("RECORD START:", recStart.result.content[0].text.split("\n")[0]);

  await callTool("swipe", { direction: "up" });
  const recStop = await callTool("record", { action: "stop" });
  const stopText = recStop.result.content.find((c) => c.type === "text").text;
  const stopImages = recStop.result.content.filter((c) => c.type === "image");
  console.log("RECORD STOP:", stopText);
  console.log("RECORD STOP images:", stopImages.length);
  console.log("PASS:", !recStop.result.isError && stopImages.length > 0);

  child.kill();
  process.exit(recStop.result.isError || stopImages.length === 0 ? 1 : 0);
}

run();
