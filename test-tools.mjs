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
  assert.deepEqual(tools.map((t) => t.name).sort(), ["acquire", "batch", "continue", "release", "status"]);
  const batch = tools.find((t) => t.name === "batch");
  assert.match(batch.description, /\| step \| Use when \|/);
  // Every screen step is a row of the table, and agents are told what a "not confirmed" result means.
  for (const name of ["tap", "tap_at", "back", "scroll", "swipe", "pinch", "type", "key", "drag", "long_press", "wait", "look", "goal", "open", "record"]) {
    assert.match(batch.description, new RegExp(`\\| ${name} \\|`), name);
  }
  assert.match(batch.description, /acted but not confirmed/);
  assert.match(batch.description, /there are no separate tap, swipe, type, look or wait tools/);
  // Agents must be told to queue whole flows, with exact steps where the label is known and a goal where it is not.
  assert.match(batch.description, /Queue whole flows/);
  assert.match(init.result.instructions, /Queue whole flows/);
  assert.match(batch.description, /HOW TO DRIVE \(read before the first call\)/);
  assert.match(batch.description, /Do NOT add look steps between steps/);
  assert.match(batch.description, /ONE goal step for the whole stretch, with the end state and room/);
  assert.match(init.result.instructions, /"tool": "goal"/);
  assert.doesNotMatch(batch.description, /"tool":"act"|\| act \|/);
  assert.deepEqual(batch.inputSchema.required, ["app", "actions"]);
  assert.ok(batch.inputSchema.properties.session_id);
  assert.equal(batch.inputSchema.properties.image.type, "boolean");
  assert.equal(batch.inputSchema.properties.continue_on_fail.type, "boolean");
  const step = batch.inputSchema.properties.actions.items.properties;
  assert.deepEqual(step.tool.enum, ["tap", "tap_at", "back", "scroll", "swipe", "pinch", "type", "key", "drag", "long_press", "wait", "look", "goal", "open", "record"]);
  for (const field of ["label", "nth", "x", "y", "direction", "times", "from", "to", "hold_ms", "text", "into", "submit", "key", "ms", "goal", "max_steps", "wait_ms", "quick", "controls", "reset", "relaunch", "frames", "save"]) {
    assert.ok(step[field], field);
  }
  assert.ok(!step.instruction && !step.drag && !step.long_press, "the act fields are gone");

  // app is required so the first snapshot cannot attach to SpringBoard and background the app under test.
  const acquire = tools.find((t) => t.name === "acquire");
  assert.deepEqual(acquire.inputSchema.required, ["app"]);
  assert.equal(acquire.inputSchema.properties.app.type, "string");
  assert.equal(batch.inputSchema.properties.app.type, "string");
  assert.equal(step.relaunch.type, "boolean");
  assert.match(acquire.description, /never hands you a different one silently/);

  const statusTool = tools.find((t) => t.name === "status");
  assert.deepEqual(statusTool.inputSchema.required, ["session_id"]);

  // continue is not an action: it only resumes a batch that paused when a tap and its goal fallback both failed.
  const cont = tools.find((t) => t.name === "continue");
  assert.deepEqual(cont.inputSchema.required, ["session_id"]);
  assert.match(cont.description, /Resume a batch that paused for help/);
  assert.equal(cont.inputSchema.properties.discard.type, "boolean");
  assert.match(batch.description, /falls? back|retried as a goal/);
  assert.match(batch.description, /PAUSES and asks you for help/);
  assert.match(init.result.instructions, /continue/);
  const noPause = (await rpc("tools/call", { name: "continue", arguments: {} })).result;
  assert.equal(noPause.isError, true);
  assert.match(noPause.content[0].text, /requires session_id/);
  const unknownPause = (await rpc("tools/call", { name: "continue", arguments: { session_id: "se-nope" } })).result;
  assert.equal(unknownPause.isError, true);
  assert.match(unknownPause.content[0].text, /Unknown session_id/);

  const noSid = (await rpc("tools/call", { name: "status", arguments: {} })).result;
  assert.equal(noSid.isError, true);
  assert.match(noSid.content[0].text, /requires session_id/);

  // Calling a retired tool directly names the step to send instead.
  for (const name of ["act", "press"]) {
    const res = (await rpc("tools/call", { name, arguments: {} })).result;
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /is not available/);
    assert.match(res.content[0].text, /"tool":"(tap|key)"/);
  }
  // A step name called as a tool says to use batch.
  for (const name of ["tap", "look", "goal"]) {
    const res = (await rpc("tools/call", { name, arguments: {} })).result;
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /is a batch step, not a tool/);
  }
  // tap_at needs a point; a missing one is refused before the simulator is touched.
  const noPoint = (await rpc("tools/call", { name: "batch", arguments: { app: "Settings", actions: [{ tool: "tap_at" }] } })).result;
  assert.equal(noPoint.isError, true);
  assert.doesNotMatch(noPoint.content[0].text, /is not available/);

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
  for (const tool of ["act", "press"]) {
    const res = (await rpc("tools/call", { name: "batch", arguments: { app: "Settings", actions: [{ tool }] } })).result;
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, new RegExp(`"${tool}" is not available\\. Send`));
  }

  console.log("test-tools: ok");
} finally {
  child.kill();
}
