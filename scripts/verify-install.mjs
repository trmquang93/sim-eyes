// Clean-room check of the npm package: pack, install the tarball into a temp dir outside the repo, and talk MCP to the
// installed bin. Manual (needs network for dependencies; --live needs a free sim-pool simulator).
//   node scripts/verify-install.mjs                 initialize + tools/list + status from the installed package
//   node scripts/verify-install.mjs --live          also: batch (look) on a free simulator through the VENDORED sim-pool, release
//   node scripts/verify-install.mjs --goal         live, plus a model-driven goal step with TYPESAFE_API_KEY from this shell
//   node scripts/verify-install.mjs --goal --hub   same, but the server gets only an invite token + TYPESAFE_BASE_URL of a local hub
//   node scripts/verify-install.mjs --cold-start    time `npx -y -p <tarball> sim-eyes` with an empty npx cache until initialize replies
// Never touches ~/.claude/skills. A busy pool makes --live INCONCLUSIVE (exit 3), never a lease taken from another agent.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const goalMode = process.argv.includes("--goal");
const hubMode = process.argv.includes("--hub");
const live = process.argv.includes("--live") || goalMode;
const coldStart = process.argv.includes("--cold-start");
const work = realpathSync(mkdtempSync(join(tmpdir(), "sim-eyes-verify-")));
const say = (line) => console.log(line);

const packOut = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", work], { cwd: root, encoding: "utf8" }));
const tarball = join(work, packOut[0].filename);
say(`tarball: ${tarball} (${packOut[0].size} bytes, ${packOut[0].files.length} files)`);

/** Minimal MCP stdio client: `call(method, params)` resolves the reply's result. */
function mcp(command, args, env) {
  const child = spawn(command, args, { cwd: work, stdio: ["pipe", "pipe", "inherit"], env: { ...process.env, ...env } });
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
  let id = 0;
  const call = (method, params) =>
    new Promise((resolve) => {
      const n = ++id;
      pending.set(n, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
  const init = () => call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "verify-install", version: "1" } });
  return { call, init, close: () => child.kill() };
}

if (coldStart) {
  const cache = join(work, "empty-npx-cache");
  mkdirSync(cache);
  const started = Date.now();
  const client = mcp("npx", ["-y", "-p", tarball, "sim-eyes"], { npm_config_cache: cache });
  const reply = await client.init();
  say(`cold start: ${((Date.now() - started) / 1000).toFixed(1)} s from \`npx -y -p <tarball> sim-eyes\` (empty cache) to the initialize reply`);
  say(`server: ${reply.result.serverInfo.name} ${reply.result.serverInfo.version}`);
  client.close();
  process.exit(0);
}

writeFileSync(join(work, "package.json"), JSON.stringify({ name: "clean-room", private: true }));
execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], { cwd: work, stdio: "inherit" });
const installed = realpathSync(join(work, "node_modules", "sim-eyes"));
const bin = realpathSync(join(work, "node_modules", ".bin", "sim-eyes"));
say(`installed package: ${installed}`);
say(`bin (realpath): ${bin}`);
if (!bin.startsWith(work) || !installed.startsWith(work)) throw new Error("the bin does not run from the temp install");

const resolved = execFileSync(
  process.execPath,
  ["--input-type=module", "-e", `import { adCommandFromHost } from ${JSON.stringify(join(installed, "ad-command.mjs"))}; console.log(JSON.stringify(adCommandFromHost(() => ["fallback"])))`],
  { cwd: work, encoding: "utf8", env: { ...process.env, SIM_EYES_AD: "" } }
).trim();
say(`agent-device command: ${resolved}`);
if (!resolved.includes(join(work, "node_modules", "agent-device"))) throw new Error("agent-device does not resolve inside the temp install");

const vendoredPool = join(installed, "vendor", "sim-pool", "sim-pool");
const env = live ? { SIM_POOL_BIN: vendoredPool } : { SIM_EYES_USE_POOL: "0" };
let hub;
if (hubMode) {
  // The server gets an invite token and the hub's URL, never the real key: a goal that works went through the relay.
  const { startHub } = await import("../hub/hub.mjs");
  const { addToken } = await import("../hub/tokens.mjs");
  const dataDir = join(work, "hub-data");
  mkdirSync(dataDir);
  const token = await addToken(join(dataDir, "tokens.json"), "verify");
  hub = await startHub({ dataDir, upstreamKey: process.env.TYPESAFE_API_KEY, port: 0 });
  env.TYPESAFE_API_KEY = token;
  env.TYPESAFE_BASE_URL = `${hub.url}/typesafe`;
  say(`hub: local ${hub.url}; server env has an invite token and TYPESAFE_BASE_URL, not the real key`);
} else if (goalMode) {
  say(`key: TYPESAFE_API_KEY ${process.env.TYPESAFE_API_KEY ? "is set in this shell (value not printed)" : "is NOT set"}`);
}
const client = mcp(bin, [], env);
const init = await client.init();
say(`initialize: ${init.result.serverInfo.name} ${init.result.serverInfo.version}`);
const tools = (await client.call("tools/list", {})).result.tools.map((t) => t.name).sort();
say(`tools/list: ${tools.join(", ")}`);
const expected = ["acquire", "batch", "continue", "release", "status"];
if (tools.join() !== expected.join()) throw new Error(`expected ${expected.join(", ")}`);
const text = (reply) => reply.result.content.map((c) => c.text ?? "").join("\n");

if (live) {
  say(`pool: SIM_POOL_BIN=${vendoredPool}`);
  const batch = text(await client.call("tools/call", { name: "batch", arguments: { app: "com.apple.Preferences", image: false, actions: goalMode ? [{ tool: "open", name: "com.apple.Preferences", relaunch: true }, { tool: "goal", goal: "open the About screen under General", max_steps: 8 }] : [{ tool: "look" }] } }));
  say(goalMode ? "--- batch (open, goal) ---" : "--- batch (look) ---");
  say(batch.split("\n").slice(0, 24).join("\n"));
  if (/SIM_POOL_BUSY/.test(batch)) {
    say("INCONCLUSIVE: the pool is busy (no lease was taken from anyone)");
    client.close();
    process.exit(3);
  }
  const session = batch.match(/session_id=(\S+)/)?.[1];
  if (!session) throw new Error("batch gave no session_id");
  say("--- status (bound) ---");
  say(text(await client.call("tools/call", { name: "status", arguments: { session_id: session } })));
  say("--- release ---");
  say(text(await client.call("tools/call", { name: "release", arguments: { session_id: session } })));
  say("--- status (after release) ---");
  say(text(await client.call("tools/call", { name: "status", arguments: { session_id: session } })));
}
client.close();
await hub?.close();
say("PASS");
