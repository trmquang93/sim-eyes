#!/usr/bin/env node
// Measures what an agent pays for one batch: characters of text and base64 characters of images in the tool result.
// Usage: node scripts/measure-batch.mjs <app> '<actions json>' [more batches as further json args]
// Needs a free sim-pool simulator. Prints one line per batch and a total; releases the lease at the end.
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Optional env: SETUP_INSTALL=<.app path> installs it on the leased simulator, SETUP_LAUNCH="<bundle> <launch args>" relaunches it before each batch.
const [app, ...batches] = process.argv.slice(2);
const server = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
const child = spawn("node", [server], { stdio: ["pipe", "pipe", "inherit"] });
const waiting = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) if (line.trim()) { const m = JSON.parse(line); waiting.get(m.id)?.(m); }
});
let n = 0;
const rpc = (method, params) => new Promise((resolve) => { const id = ++n; waiting.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });
await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "measure", version: "1" } });
let session = null;
if (process.env.SETUP_INSTALL || process.env.PLATFORM) {
  const text = (await rpc("tools/call", { name: "acquire", arguments: { app: process.env.PLATFORM ? app : "Settings", ...(process.env.PLATFORM ? { platform: process.env.PLATFORM } : {}) } })).result.content[0].text;
  session = /^session_id=(\S+)/.exec(text)?.[1];
  const udid = /^udid: (\S+)/m.exec(text)?.[1];
  if (process.env.SETUP_INSTALL) spawnSync("xcrun", ["simctl", "install", udid, process.env.SETUP_INSTALL]);
}
let total = { text: 0, images: 0, imageChars: 0 };
for (const b of batches) {
  if (session && process.env.SETUP_LAUNCH) {
    const udid = /^udid: (\S+)/m.exec((await rpc("tools/call", { name: "status", arguments: { session_id: session } })).result.content[0].text)?.[1];
    const [bundle, ...rest] = process.env.SETUP_LAUNCH.split(" ");
    spawnSync("xcrun", ["simctl", "terminate", udid, bundle]);
    spawnSync("xcrun", ["simctl", "launch", udid, bundle, ...rest]);
    await new Promise((r) => setTimeout(r, 3000));
  }
  const t0 = Date.now();
  const r = (await rpc("tools/call", { name: "batch", arguments: { app, ...(session ? { session_id: session } : {}), ...JSON.parse(b) } })).result;
  const text = r.content.find((c) => c.type === "text").text;
  session ??= /^session_id=(\S+)/.exec(text)?.[1];
  const imgs = r.content.filter((c) => c.type === "image");
  const chars = imgs.reduce((s, c) => s + c.data.length, 0);
  total = { text: total.text + text.length, images: total.images + imgs.length, imageChars: total.imageChars + chars };
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`--- batch (${secs}s): text ${text.length} chars, ${imgs.length} image(s) ${chars} base64 chars, isError=${!!r.isError}\n${text}\n`);
}
console.log(`TOTAL text=${total.text} chars, images=${total.images}, image base64=${total.imageChars} chars`);
if (session) await rpc("tools/call", { name: "release", arguments: { session_id: session } });
child.kill();
