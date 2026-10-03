#!/usr/bin/env node
// Manual: needs a free simulator in sim-pool. A tap on a label that does not exist fails, its goal fallback
// fails too (or cannot run without TYPESAFE_API_KEY), so the batch must pause; the agent's own batch must not
// discard the waiting steps; continue must run them, numbered on from the pause.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const child = spawn("node", [join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs")], { stdio: ["pipe", "pipe", "inherit"] });
const waiting = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines.filter((l) => l.trim())) {
    const msg = JSON.parse(line);
    waiting.get(msg.id)?.(msg);
  }
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

let sessionId;
try {
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test-recovery-live", version: "1" } });
  const app = "com.apple.Preferences";

  const first = await call("batch", {
    app,
    image: false,
    actions: [{ tool: "tap", label: "Zzz Not A Control" }, { tool: "look" }, { tool: "scroll", direction: "down" }],
  });
  const firstText = text(first);
  console.log(firstText);
  sessionId = /session_id=(\S+)/.exec(firstText)[1];
  assert.match(firstText, /1\. tap "Zzz Not A Control": the exact tap failed/);
  assert.match(firstText, /Step 1 needs your help/);
  assert.match(firstText, /2 step\(s\) wait: look; scroll "down"/);
  assert.doesNotMatch(firstText, /remaining step\(s\) not run/);

  // The agent does the tap itself; the paused steps survive and the reminder says how to resume.
  const help = text(await call("batch", { session_id: sessionId, app, image: false, actions: [{ tool: "tap", label: "General" }] }));
  console.log(help);
  assert.match(help, /a batch is paused after step 1 with 2 step\(s\) waiting\. Call continue/);

  const resumed = text(await call("continue", { session_id: sessionId }));
  console.log(resumed);
  assert.match(resumed, /Resumed after your action \(steps 2–3\)/);
  assert.match(resumed, /2\. look: done/);
  assert.match(resumed, /3\. scroll: /);

  const again = await call("continue", { session_id: sessionId });
  assert.equal(again.isError, true);
  assert.match(text(again), /Nothing to continue/);

  // Any other failed step ends the batch and names the steps it did not run (no pause: only a tap asks for help).
  const failed = await call("batch", { session_id: sessionId, app, image: false, actions: [{ tool: "type", text: "x", into: "Nope" }, { tool: "look" }, { tool: "scroll", direction: "down" }] });
  assert.equal(failed.isError, true);
  assert.match(text(failed), /2 remaining step\(s\) not run: look; scroll "down"\./);
  assert.doesNotMatch(text(failed), /needs your help/);
  assert.equal((await call("continue", { session_id: sessionId })).isError, true, "a failed type does not pause");

  // discard drops the waiting steps; nothing is left to continue.
  const paused = text(await call("batch", { session_id: sessionId, app, image: false, actions: [{ tool: "tap", label: "Zzz Not A Control" }, { tool: "look" }] }));
  assert.match(paused, /1 step\(s\) wait: look/);
  const dropped = await call("continue", { session_id: sessionId, discard: true });
  assert.notEqual(dropped.isError, true);
  assert.match(text(dropped), /Discarded the 1 step\(s\) that were waiting after step 1/);
  assert.match(text(await call("continue", { session_id: sessionId })), /Nothing to continue/);
  console.log("test-recovery-live: ok");
} finally {
  if (sessionId) await call("release", { session_id: sessionId });
  child.kill();
}
