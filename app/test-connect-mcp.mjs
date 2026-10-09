import assert from "node:assert/strict";
import { apply, detect, plan, remove, stablePath } from "./connect-mcp.mjs";

const HOME = "/home/u";
const CMD = stablePath(HOME);
const CURSOR = `${HOME}/.cursor/mcp.json`;
const CODE = `${HOME}/.claude.json`;

/** An in-memory file system and exec; `failRenameOnce` simulates a crash between the temp write and the rename. */
function world(files = {}, { claude = false, failRenameOnce = false } = {}) {
  const fsMap = new Map(Object.entries(files));
  const calls = [];
  let failRename = failRenameOnce;
  const dirs = new Set();
  const fs = {
    exists: async (p) => fsMap.has(p) || [...fsMap.keys()].some((k) => k.startsWith(`${p}/`)) || dirs.has(p),
    readFile: async (p) => { if (!fsMap.has(p)) throw new Error("ENOENT"); return fsMap.get(p); },
    writeFile: async (p, text) => { fsMap.set(p, text); },
    rename: async (from, to) => { if (failRename) { failRename = false; throw new Error("disk full"); } fsMap.set(to, fsMap.get(from)); fsMap.delete(from); },
    mkdir: async (p) => { dirs.add(p); },
  };
  if (claude) fsMap.set(`${HOME}/.local/bin/claude`, "#!");
  const exec = async (file, args) => {
    calls.push([file, ...args]);
    if (args[1] === "add") fsMap.set(CODE, JSON.stringify({ mcpServers: { "sim-eyes": { type: "stdio", command: args[args.length - 1], args: [] } } }));
    if (args[1] === "remove") fsMap.set(CODE, JSON.stringify({ mcpServers: {} }));
    return { code: 0, stdout: "", stderr: "" };
  };
  return { deps: { home: HOME, fs, exec }, files: fsMap, calls };
}

const parse = (w, p) => JSON.parse(w.files.get(p));
let n = 0;
const test = async (name, fn) => { await fn(); n += 1; console.log(`ok  ${name}`); };

await test("keeps other servers and keys when adding (a user's other MCP servers must survive)", async () => {
  const w = world({ [CURSOR]: JSON.stringify({ theme: "x", mcpServers: { other: { command: "o", args: ["1"] } } }) });
  const r = await apply({ client: "cursor", command: CMD, ...w.deps });
  assert.equal(r.status, "ok");
  assert.deepEqual(parse(w, CURSOR), { theme: "x", mcpServers: { other: { command: "o", args: ["1"] }, "sim-eyes": { command: CMD } } });
});

await test("writes a backup once and never overwrites the first backup", async () => {
  const original = JSON.stringify({ mcpServers: { a: { command: "a" } } });
  const w = world({ [CURSOR]: original });
  await apply({ client: "cursor", command: CMD, ...w.deps });
  assert.equal(w.files.get(`${CURSOR}.sim-eyes.bak`), original);
  await apply({ client: "cursor", command: `${CMD}2`, replace: true, ...w.deps });
  assert.equal(w.files.get(`${CURSOR}.sim-eyes.bak`), original, "second apply must keep the first backup");
});

await test("refuses invalid JSON and leaves the file byte-identical", async () => {
  const w = world({ [CURSOR]: "{ not json" });
  const r = await apply({ client: "cursor", command: CMD, ...w.deps });
  assert.equal(r.status, "invalid-config");
  assert.equal(w.files.get(CURSOR), "{ not json");
  assert.equal(w.files.has(`${CURSOR}.sim-eyes.bak`), false);
});

await test("creates the config file and folder when the client has none", async () => {
  const w = world();
  const r = await apply({ client: "cursor", command: CMD, ...w.deps });
  assert.equal(r.status, "ok");
  assert.deepEqual(parse(w, CURSOR), { mcpServers: { "sim-eyes": { command: CMD } } });
});

await test("existing sim-eyes entry needs --replace (no silent override of the user's own config)", async () => {
  const old = { command: "npx", args: ["-y", "sim-eyes"] };
  const w = world({ [CURSOR]: JSON.stringify({ mcpServers: { "sim-eyes": old } }) });
  const r = await apply({ client: "cursor", command: CMD, ...w.deps });
  assert.equal(r.status, "needs-replace");
  assert.deepEqual(r.before, old);
  assert.deepEqual(parse(w, CURSOR).mcpServers["sim-eyes"], old);
  const again = await apply({ client: "cursor", command: CMD, replace: true, ...w.deps });
  assert.equal(again.status, "ok");
  assert.deepEqual(parse(w, CURSOR).mcpServers["sim-eyes"], { command: CMD });
});

await test("replacing an entry keeps its env (the user's API key and signing ids are not ours to drop)", async () => {
  const env = { TYPESAFE_API_KEY: "k", AGENT_DEVICE_IOS_TEAM_ID: "T" };
  const w = world({ [CURSOR]: JSON.stringify({ mcpServers: { "sim-eyes": { command: "node", args: ["/x/server.mjs"], env } } }) });
  await apply({ client: "cursor", command: CMD, replace: true, ...w.deps });
  assert.deepEqual(parse(w, CURSOR).mcpServers["sim-eyes"], { command: CMD, env });
  const c = world({ [CODE]: JSON.stringify({ mcpServers: { "sim-eyes": { command: "node", args: ["s"], env } } }) }, { claude: true });
  await apply({ client: "claude-code", command: CMD, replace: true, ...c.deps });
  assert.deepEqual(c.calls[1].slice(2), ["add", "--scope", "user", "-e", "TYPESAFE_API_KEY=k", "-e", "AGENT_DEVICE_IOS_TEAM_ID=T", "sim-eyes", "--", CMD]);
});

await test("apply is idempotent (second run reports unchanged)", async () => {
  const w = world();
  await apply({ client: "cursor", command: CMD, ...w.deps });
  const before = w.files.get(CURSOR);
  const r = await apply({ client: "cursor", command: CMD, ...w.deps });
  assert.equal(r.changed, false);
  assert.equal(w.files.get(CURSOR), before);
  assert.equal((await plan({ client: "cursor", command: CMD, ...w.deps })).action, "unchanged");
});

await test("remove deletes only sim-eyes", async () => {
  const w = world({ [CURSOR]: JSON.stringify({ x: 1, mcpServers: { a: { command: "a" }, "sim-eyes": { command: CMD } } }) });
  const r = await remove({ client: "cursor", ...w.deps });
  assert.equal(r.changed, true);
  assert.deepEqual(parse(w, CURSOR), { x: 1, mcpServers: { a: { command: "a" } } });
  assert.equal((await remove({ client: "cursor", ...w.deps })).changed, false);
});

await test("claude not found returns the manual command, writes nothing", async () => {
  const w = world();
  const r = await apply({ client: "claude-code", command: CMD, ...w.deps });
  assert.equal(r.status, "claude-not-found");
  assert.equal(r.manualCommand, `claude mcp add --scope user sim-eyes -- ${CMD}`);
  assert.equal(w.calls.length, 0);
});

await test("claude mcp add is called with --scope user and the stable path", async () => {
  const w = world({}, { claude: true });
  const r = await apply({ client: "claude-code", command: CMD, ...w.deps });
  assert.equal(r.status, "ok");
  assert.deepEqual(w.calls, [[`${HOME}/.local/bin/claude`, "mcp", "add", "--scope", "user", "sim-eyes", "--", CMD]]);
});

await test("claude replace removes the old entry first, only after confirmation", async () => {
  const w = world({ [CODE]: JSON.stringify({ mcpServers: { "sim-eyes": { command: "npx", args: ["sim-eyes"] } } }) }, { claude: true });
  assert.equal((await apply({ client: "claude-code", command: CMD, ...w.deps })).status, "needs-replace");
  assert.equal(w.calls.length, 0);
  await apply({ client: "claude-code", command: CMD, replace: true, ...w.deps });
  assert.deepEqual(w.calls.map((c) => c[2]), ["remove", "add"]);
});

await test("writes atomically (a failure after the temp write leaves the original intact)", async () => {
  const original = JSON.stringify({ mcpServers: { a: { command: "a" } } });
  const w = world({ [CURSOR]: original }, { failRenameOnce: true });
  await assert.rejects(apply({ client: "cursor", command: CMD, ...w.deps }), /disk full/);
  assert.equal(w.files.get(CURSOR), original);
});

await test("detect reports not-installed clients as such", async () => {
  const w = world({ [CURSOR]: "{}" });
  const found = Object.fromEntries((await detect(w.deps)).map((c) => [c.client, c]));
  assert.equal(found.cursor.installed, true);
  assert.equal(found["claude-desktop"].installed, false);
  assert.equal(found["claude-code"].installed, false);
});

console.log(`${n} passed`);
