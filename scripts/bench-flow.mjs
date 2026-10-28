#!/usr/bin/env node
// Benchmark: spawns server.mjs and drives a fixed flow in the iOS Settings app (General > About > back, repeated).
// Usage: node scripts/bench-flow.mjs [--udid <UDID>] [--rounds 5] [--check] [--toggles [--seq]]
// Default flow: General > About > back, repeated. --toggles: Appearance, then each round picks Dark, Light, Dark (and the reverse) on that one screen, as three taps or, with --seq, as one tap_seq.
// Prints wall time, step count, problem lines and the last look line. Set SIM_EYES_TIMING=1 to see per-phase timing on stderr.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : def;
};
const UDID = opt("udid", process.env.BENCH_UDID);
const ROUNDS = Number(opt("rounds", "5"));
const CHECK = argv.includes("--check");
const SEQ = argv.includes("--seq");
const TOGGLES = argv.includes("--toggles");
const APP = "com.apple.Preferences";
const server = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");

const child = spawn("node", [server], { stdio: ["pipe", "pipe", "inherit"], env: process.env });
let buf = "";
const waiters = new Map();
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    try {
      const m = JSON.parse(line);
      if (m.id && waiters.has(m.id)) {
        waiters.get(m.id)(m);
        waiters.delete(m.id);
      }
    } catch {}
  }
});
let n = 0;
const rpc = (method, params) =>
  new Promise((res) => {
    const id = ++n;
    waiters.set(id, res);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const text = (r) =>
  (r.result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n") || JSON.stringify(r.error ?? r.result).slice(0, 400);

await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "bench", version: "1" } });
child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
let r = await rpc("tools/call", { name: "acquire", arguments: { app: APP, ...(UDID ? { prefer_udid: UDID } : {}) } });
console.log(text(r).split("\n")[0]);
const sid = /session_id=(\S+)/.exec(text(r))?.[1];

const extra = CHECK ? { check: true } : {};
const t = (label, nth) => ({ tool: "tap", label, ...(nth ? { nth } : {}), ...extra });
// One round: Settings > General > About > back > back = 4 taps. Ends on the Settings root.
const round = () => [t("General"), t("About"), t("General"), t("Settings")];
const THEMES = ["09:41, Dark", "09:41, Light", "09:41, Dark"];
const flow = [{ tool: "launch", id: APP }];
if (TOGGLES) {
  flow.push(t("Appearance"));
  // Alternate Dark, Light, Dark / Light, Dark, Light: radio options on one screen that never move, and the last one is visible in a screenshot.
  for (let i = 0; i < ROUNDS * 2; i++) {
    const labels = i % 2 ? [...THEMES].reverse() : THEMES;
    flow.push(...(SEQ ? [{ tool: "tap_seq", labels, ...extra }] : labels.map((l) => t(l))));
  }
} else for (let i = 0; i < ROUNDS; i++) flow.push(...round());
flow.push({ tool: "look" });

const t0 = Date.now();
r = await rpc("tools/call", { name: "batch", arguments: { session_id: sid, app: APP, actions: flow } });
const ms = Date.now() - t0;
const out = text(r).split("\n");
const steps = out.filter((l) => /^\d+\. /.test(l));
const bad = out.filter((l) => /failed|stuck|stopped|not confirmed/.test(l));
console.log(`wall=${ms}ms steps=${steps.length} problems=${bad.length} perStep=${Math.round(ms / Math.max(1, steps.length))}ms`);
for (const l of bad.slice(0, 5)) console.log(l);
console.log(out.filter((l) => /screen:/.test(l)).slice(-1).join("\n"));
await rpc("tools/call", { name: "continue", arguments: { session_id: sid, discard: true } });
await rpc("tools/call", { name: "release", arguments: { session_id: sid } });
child.kill();
