#!/usr/bin/env node
// Manual: needs the iPhone attached, unlocked, trusted, Developer Mode on, and signing env:
//   AGENT_DEVICE_IOS_TEAM_ID=<team> AGENT_DEVICE_IOS_BUNDLE_ID=<id> node test/test-device-live.mjs
// Drives server.mjs over MCP: acquire target:"device", Settings > General > About, tap_at, a second
// session getting DEVICE_BUSY, reset refusal, release. Evidence goes to .local/qa-evidence/real-device/.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const phone = process.env.DEVICE_UDID ?? "00008120-001429D11A42201E"; // several devices can be connected: never guess
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const evidence = join(root, ".local", "qa-evidence", "real-device");
mkdirSync(evidence, { recursive: true });
const lockDir = join(homedir(), ".local", "sim-eyes", "device-locks");
const locks = () => (readdirSync(lockDir, { withFileTypes: true }).length ? readdirSync(lockDir) : []);

const child = spawn("node", [join(root, "server.mjs")], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, SIM_EYES_USE_POOL: "0", AGENT_DEVICE_STATE_DIR: process.env.AGENT_DEVICE_STATE_DIR ?? "/tmp/ad-live" },
});
const waiting = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines.filter((l) => l.trim())) waiting.get(JSON.parse(line).id)?.(JSON.parse(line));
});
let nextId = 0;
const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = ++nextId;
    waiting.set(id, resolve);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
const call = async (name, args) => (await rpc("tools/call", { name, arguments: args })).result;
const text = (r) => r.content.find((c) => c.type === "text").text;
const save = (name, body) => writeFileSync(join(evidence, name), body);
const savePng = (name, r) => {
  const img = r.content.find((c) => c.type === "image");
  if (img) writeFileSync(join(evidence, name), Buffer.from(img.data, "base64"));
};

let sessionId;
try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test-device-live", version: "1" } });
  const app = "com.apple.Preferences";

  // S1
  const acq = await call("acquire", { app, target: "device", prefer_udid: phone });
  const acqText = text(acq);
  save("s1-acquire.txt", `${acqText}\n\nlocks: ${locks().join(", ")}\n`);
  assert.ok(!acq.isError, acqText);
  sessionId = /session_id=(\S+)/.exec(acqText)[1];
  assert.match(acqText, /kind: device/);
  assert.match(acqText, /lease: \(none\)/);
  assert.equal(locks().length, 1, "one lock file");

  // S4: another session_id must not get the phone.
  const second = await call("acquire", { app, target: "device", prefer_udid: phone });
  save("s4-busy.txt", text(second));
  assert.ok(second.isError);
  assert.match(text(second), /DEVICE_BUSY/);

  // S7
  const reset = await call("batch", { session_id: sessionId, app, image: false, actions: [{ tool: "open", reset: true }] });
  save("s7-reset.txt", text(reset));
  assert.match(text(reset), /reset:true needs simctl and a simulator/);

  // S8: record is refused up front on hardware (the runner restart loses the clip).
  const rec = await call("batch", { session_id: sessionId, app, image: false, actions: [{ tool: "record", action: "start" }] });
  save("s8-record.txt", text(rec));
  assert.match(text(rec), /record is not supported on a real device/);

  // S2: Settings > General > About
  // Settings keeps its scroll position between runs: go to the top, then down one page only if General is not visible.
  await call("batch", { session_id: sessionId, app, image: false, continue_on_fail: true, actions: [{ tool: "scroll", direction: "up", times: 8 }] });
  const start = await call("batch", { session_id: sessionId, app, image: false, actions: [{ tool: "look", controls: true }] });
  if (!/General \(\d+, \d+\)/.test(text(start))) {
    await call("batch", { session_id: sessionId, app, image: false, actions: [{ tool: "swipe", from: { x: 197, y: 600 }, to: { x: 197, y: 350 } }] });
  }
  const about = await call("batch", {
    session_id: sessionId,
    app,
    actions: [{ tool: "tap", label: "General" }, { tool: "tap", label: "About" }],
  });
  save("s2-batch.txt", text(about));
  savePng("s2-about.png", about);
  console.log(text(about));
  assert.match(text(about), /About/);

  // S3: a point read off the shot lands on the intended row. Back to General, read the About row's point from the
  // controls list (points, same frame as the 1x screenshot), tap_at it.
  const before = await call("batch", { session_id: sessionId, app, actions: [{ tool: "back" }, { tool: "look", controls: true }] });
  save("s3-before.txt", text(before));
  savePng("s3-before.png", before);
  const point = /About \((\d+), (\d+)\)/.exec(text(before));
  assert.ok(point, "the About row has a point");
  const after = await call("batch", { session_id: sessionId, app, actions: [{ tool: "tap_at", x: Number(point[1]), y: Number(point[2]) }] });
  save("s3-batch.txt", text(after));
  savePng("s3-after.png", after);
  assert.match(text(after), /screen: "About"/);
  // S9: a goal on the phone (needs TYPESAFE_API_KEY; skipped, not passed, without it).
  if (process.env.TYPESAFE_API_KEY) {
    await call("batch", { session_id: sessionId, app, image: false, continue_on_fail: true, actions: [{ tool: "back" }, { tool: "back" }] });
    const goal = await call("batch", {
      session_id: sessionId,
      app,
      actions: [{ tool: "goal", goal: "open the About page under General", max_steps: 10 }],
    });
    save("s9-goal.txt", text(goal));
    savePng("s9-goal.png", goal);
    assert.match(text(goal), /screen: "About"/);
    assert.doesNotMatch(text(goal), /after 0 step/, "the goal must have navigated, not found About already open");
  } else console.log("S9 skipped: no TYPESAFE_API_KEY");
} finally {
  // S5
  if (sessionId) {
    const rel = await call("release", { session_id: sessionId });
    save("s5-release.txt", `${text(rel)}\n\nlocks after release: ${JSON.stringify(locks())}\n`);
    assert.equal(locks().length, 0, "release removes the lock");
  }
  child.kill();
}
console.log("test-device-live: ok");
