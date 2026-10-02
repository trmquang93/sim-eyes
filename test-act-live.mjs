#!/usr/bin/env node
// Manual: needs a free simulator and TYPESAFE_API_KEY. Runs act cases against Settings.
// Usage: node test-act-live.mjs [case name]
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverPath = join(dirname(fileURLToPath(import.meta.url)), "server.mjs");
const child = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "inherit"] });
const pending = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines.filter((l) => l.trim())) {
    const msg = JSON.parse(line);
    pending.get(msg.id)?.(msg);
  }
});
let nextId = 0;
function rpc(method, params) {
  const id = ++nextId;
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  return new Promise((resolve) => pending.set(id, resolve));
}
async function batch(actions) {
  const res = (await rpc("tools/call", { name: "batch", arguments: { app: "Settings", actions } })).result;
  const text = res.content[0].text;
  return { error: !!res.isError, text };
}

const cases = [
  ["already there", [{ tool: "open", name: "Settings" }, { tool: "goal", goal: "tap Allow if a permission alert is showing" }]],
  ["one screen", [{ tool: "open", name: "Settings" }, { tool: "goal", goal: "open General settings" }]],
  ["two screens", [{ tool: "open", name: "Settings" }, { tool: "goal", goal: "open the About page inside General settings" }]],
  ["off screen", [{ tool: "open", name: "Settings" }, { tool: "goal", goal: "open Privacy & Security settings" }]],
  ["impossible", [{ tool: "open", name: "Settings" }, { tool: "goal", goal: "turn on Airplane Mode", max_steps: 3 }]],
  ["type text", [{ tool: "open", name: "Settings" }, { tool: "goal", goal: "search settings for the text and submit", text: "Wallpaper" }]],
];
try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "act-live", version: "1" } });
  const only = process.argv[2];
  for (const [name, actions] of cases.filter(([n]) => !only || n === only)) {
    const r = await batch(actions);
    const head = r.text.split("\n\n").slice(0, 2).join("\n");
    const screen = r.text.split("\n").filter((l) => /^\d+\. /.test(l)).slice(0, 5).join(" | ");
    console.log(`=== ${name} (${r.error ? "STOPPED" : "ok"})\n${head}\nscreen: ${screen}\n`);
  }
  await rpc("tools/call", { name: "release", arguments: {} });
} finally {
  child.kill();
}
