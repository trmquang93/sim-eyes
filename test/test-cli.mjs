// Why: the `sim-eyes` bin is what every MCP client runs, and its stdout IS the protocol. Anything the CLI prints there
// besides MCP messages (a Node-version complaint, a usage error) breaks the client's parse instead of showing the
// reason, so those go to stderr; and the plain `sim-eyes` must still be the MCP server.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "cli.mjs");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const run = (args, env = {}) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, ...env } });

{
  const r = run(["--version"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), version);
}
{
  const r = run(["--help"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /sim-eyes doctor/);
}
{
  const r = run([], { SIM_EYES_NODE_VERSION: "20.18.0" });
  assert.equal(r.status, 1, "old Node exits 1");
  assert.equal(r.stdout, "", "and leaves stdout empty");
  assert.match(r.stderr, /needs Node 22\.12/);
  assert.equal(run(["--version"], { SIM_EYES_NODE_VERSION: "22.11.0" }).status, 1, "the guard runs before any command");
  assert.equal(run(["--version"], { SIM_EYES_NODE_VERSION: "22.12.0" }).status, 0, "22.12.0 is the floor");
}
{
  const r = run(["bogus"]);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, "", "a usage error never goes to stdout");
  assert.match(r.stderr, /unknown argument "bogus"/);
}
{
  const child = spawn(process.execPath, [cli], { stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, SIM_EYES_USE_POOL: "0" } });
  let out = "";
  const reply = new Promise((resolve) =>
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("\n")) resolve(JSON.parse(out.split("\n")[0]));
    })
  );
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test-cli", version: "1" } } }) + "\n");
  const init = await reply;
  child.kill();
  assert.equal(init.result.serverInfo.name, "sim-eyes", "plain `sim-eyes` is the MCP server");
  assert.equal(init.result.serverInfo.version, version, "and it reports the package version, not a stale constant");
}
console.log("test-cli: ok");
