import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The server must expose actions only through batch, so agents are steered to queue steps.
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
  assert.deepEqual(batch.inputSchema.required, ["actions"]);
  assert.ok(batch.inputSchema.properties.session_id);
  assert.ok(batch.inputSchema.properties.actions.items.properties.tool.enum.includes("act"));
  assert.match(batch.inputSchema.properties.actions.description, /look, open, tap/);

  // The session's app is chosen by the caller; the server never forces one (or a relaunch) on its own.
  assert.equal(tools.find((t) => t.name === "acquire").inputSchema.properties.app.type, "string");
  assert.equal(batch.inputSchema.properties.app.type, "string");
  assert.equal(batch.inputSchema.properties.actions.items.properties.relaunch.type, "boolean");

  const statusTool = tools.find((t) => t.name === "status");
  assert.deepEqual(statusTool.inputSchema.required, ["session_id"]);

  const noSid = (await rpc("tools/call", { name: "status", arguments: {} })).result;
  assert.equal(noSid.isError, true);
  assert.match(noSid.content[0].text, /requires session_id/);

  for (const name of ["tap", "look", "type"]) {
    const res = (await rpc("tools/call", { name, arguments: {} })).result;
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /Call batch with actions/);
  }

  const bad = (await rpc("tools/call", { name: "batch", arguments: { actions: [{ tool: "nope" }] } })).result;
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /batch cannot run "nope"/);

  console.log("test-tools: ok");
} finally {
  child.kill();
}
