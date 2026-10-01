import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The server exposes the simulator only through batch, and inside batch only through act (plus open and record).
const serverPath = join(dirname(fileURLToPath(import.meta.url)), "server.mjs");
const child = spawn("node", [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, SIM_EYES_USE_POOL: "0" },
});

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

try {
  const init = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-tools", version: "1" },
  });
  assert.match(init.result.instructions, /session_id/);

  const { tools } = (await rpc("tools/list", {})).result;
  assert.deepEqual(tools.map((t) => t.name).sort(), ["acquire", "batch", "release", "status"]);
  const batch = tools.find((t) => t.name === "batch");
  assert.match(batch.description, /\| tool \| Use when \|/);
  assert.match(batch.description, /\| act \|/);
  // Agents must be told there is nothing but act, and what a "not confirmed" result means.
  assert.match(batch.description, /no tap, swipe, type, look or wait tools/);
  assert.match(batch.description, /acted but not confirmed/);
  assert.match(batch.description, /drag \{"from":"1","to":"5"\}/);
  // Agents must be told to queue whole flows; one-step batches are the main cause of slow QA.
  assert.match(batch.description, /Queue whole flows/);
  assert.match(init.result.instructions, /Queue whole flows/);
  assert.match(init.result.instructions, /act-only|ONLY batch\.actions\[\], and there it is act/);
  assert.deepEqual(batch.inputSchema.required, ["app", "actions"]);
  assert.ok(batch.inputSchema.properties.session_id);
  assert.equal(batch.inputSchema.properties.image.type, "boolean");
  assert.equal(batch.inputSchema.properties.continue_on_fail.type, "boolean");
  const step = batch.inputSchema.properties.actions.items.properties;
  assert.deepEqual(step.tool.enum, ["act", "open", "record"]);
  for (const field of ["instruction", "text", "max_steps", "wait_ms", "drag", "long_press", "controls", "reset", "relaunch", "frames", "save"]) {
    assert.ok(step[field], field);
  }
  assert.deepEqual(step.drag.required, ["from", "to"]);

  // app is required so the first snapshot cannot attach to SpringBoard and background the app under test.
  const acquire = tools.find((t) => t.name === "acquire");
  assert.deepEqual(acquire.inputSchema.required, ["app"]);
  assert.equal(acquire.inputSchema.properties.app.type, "string");
  assert.equal(batch.inputSchema.properties.app.type, "string");
  assert.equal(step.relaunch.type, "boolean");
  assert.match(acquire.description, /never hands you a different one silently/);

  const statusTool = tools.find((t) => t.name === "status");
  assert.deepEqual(statusTool.inputSchema.required, ["session_id"]);

  const noSid = (await rpc("tools/call", { name: "status", arguments: {} })).result;
  assert.equal(noSid.isError, true);
  assert.match(noSid.content[0].text, /requires session_id/);

  // Calling a retired tool directly names the act step to send instead.
  for (const name of ["tap", "look", "type", "swipe", "drag", "press", "wait"]) {
    const res = (await rpc("tools/call", { name, arguments: {} })).result;
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /sim-eyes is act-only/);
    assert.match(res.content[0].text, /"tool":"act"/);
  }
  const direct = (await rpc("tools/call", { name: "act", arguments: {} })).result;
  assert.match(direct.content[0].text, /batch step, not a tool/);

  const noApp = (await rpc("tools/call", { name: "batch", arguments: { actions: [{ tool: "look" }] } })).result;
  assert.equal(noApp.isError, true);
  assert.match(noApp.content[0].text, /requires app/);

  const noAppAcquire = (await rpc("tools/call", { name: "acquire", arguments: {} })).result;
  assert.equal(noAppAcquire.isError, true);
  assert.match(noAppAcquire.content[0].text, /requires app/);

  const bad = (await rpc("tools/call", { name: "batch", arguments: { app: "Settings", actions: [{ tool: "nope" }] } })).result;
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /batch cannot run "nope"/);

  // A retired step is refused before anything touches the simulator, and the error says what to send.
  for (const tool of ["tap", "look", "wait"]) {
    const res = (await rpc("tools/call", { name: "batch", arguments: { app: "Settings", actions: [{ tool }] } })).result;
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, new RegExp(`"${tool}" is not available: sim-eyes is act-only`));
  }

  console.log("test-tools: ok");
} finally {
  child.kill();
}
