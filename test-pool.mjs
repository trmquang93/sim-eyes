import assert from "node:assert/strict";
import { parseAcquireOutput, defaultInstanceId, resolveSimPool, findSimPoolBin, ensurePoolConfigured } from "./pool.mjs";

const parsed = parseAcquireOutput(`
LEASE_ID=abc-123
UDID=8F395E81-CF05-425A-B3C8-CA63CFDE8FD6
SIMULATOR_NAME=iPhone 17
EXPIRES_AT=2026-09-27T15:43:40+00:00
`);
assert.equal(parsed.LEASE_ID, "abc-123");
assert.equal(parsed.UDID, "8F395E81-CF05-425A-B3C8-CA63CFDE8FD6");
assert.equal(parsed.EXPIRES_AT, "2026-09-27T15:43:40+00:00");

const id = defaultInstanceId();
assert.match(id, /^\d+-[0-9a-f]+$/);


// Why: the user's own sim-pool skill must win over the vendored copy (both write ~/.agent-sim-pool, and versions can
// differ), and the vendored copy must run through python3 because npm does not keep the exec bit.
const HOME = "/home/u";
const VENDORED = "/pkg/vendor/sim-pool/sim-pool";
const SKILL = `${HOME}/.claude/skills/sim-pool/scripts/sim-pool`;
const has = (...paths) => (p) => paths.includes(p);

assert.deepEqual(
  resolveSimPool({ env: { SIM_POOL_BIN: "/mine/sim-pool" }, home: HOME, exists: has(SKILL, VENDORED), vendored: VENDORED }),
  { path: "/mine/sim-pool", source: "env", command: "/mine/sim-pool", args: [] },
  "SIM_POOL_BIN beats the skill and the vendored copy"
);
assert.deepEqual(
  resolveSimPool({ env: {}, home: HOME, exists: has(SKILL, VENDORED), vendored: VENDORED }),
  { path: SKILL, source: "skill", command: SKILL, args: [] },
  "the skill beats the vendored copy"
);
assert.deepEqual(
  resolveSimPool({ env: {}, home: HOME, exists: has(`${HOME}/.cursor/skills/sim-pool/scripts/sim-pool`, VENDORED), vendored: VENDORED }).source,
  "skill",
  "the .cursor skill dir is still searched"
);
assert.deepEqual(
  resolveSimPool({ env: {}, home: HOME, exists: has(VENDORED), vendored: VENDORED }),
  { path: VENDORED, source: "vendored", command: "python3", args: [VENDORED] },
  "the vendored copy runs through python3, never by exec bit"
);
assert.equal(resolveSimPool({ env: {}, home: HOME, exists: has(), vendored: VENDORED }), null, "nothing found is null");
assert.equal(findSimPoolBin({ env: {}, home: HOME, exists: has(VENDORED), vendored: VENDORED }), VENDORED, "the string wrapper still gives the path");
assert.equal(findSimPoolBin({ env: {}, home: HOME, exists: has(), vendored: VENDORED }), null);

// Why: a fresh Mac has no ~/.agent-sim-pool, so the first acquire would say "no simulators whitelisted" without init.
const POOL = { run: async () => assert.fail("run was not expected") };
const configAt = (home) => `${home}/config.json`;
const calls = [];
const fakeRun = (stdout, code = 0) => async (args) => {
  calls.push(args);
  return { code, stdout, stderr: "" };
};
const read = (files) => (path) => files[path] ?? null;

assert.deepEqual(await ensurePoolConfigured({ ...POOL, home: HOME, env: {}, readConfig: read({ [configAt(`${HOME}/.agent-sim-pool`)]: { devices: ["A"] } }) }), { initialized: false }, "a whitelist that exists is left alone");
assert.deepEqual(
  await ensurePoolConfigured({ run: fakeRun("INIT pool_home=/x devices=2\n  A\n  B\n"), home: HOME, env: { AGENT_SIM_POOL_HOME: "/tmp/p" }, readConfig: read({}) }),
  { initialized: true, devices: 2 },
  "a missing config runs init, under AGENT_SIM_POOL_HOME when set"
);
assert.deepEqual(calls.pop(), ["init"], "first init is not forced");
await ensurePoolConfigured({ run: fakeRun("INIT pool_home=/x devices=1\n"), home: HOME, env: {}, readConfig: read({ [configAt(`${HOME}/.agent-sim-pool`)]: { devices: [] } }) });
assert.deepEqual(calls.pop(), ["init", "--force"], "an empty whitelist is re-initialised, since plain init keeps an existing config");
await assert.rejects(
  ensurePoolConfigured({ run: fakeRun("INIT pool_home=/x devices=0\n"), home: HOME, env: {}, readConfig: read({}) }),
  /No iPhone simulator.*Xcode/s,
  "init that finds no iPhone simulator is a clear error, not a pool-busy look-alike"
);
await assert.rejects(
  ensurePoolConfigured({ run: fakeRun("", 1), home: HOME, env: {}, readConfig: read({}) }),
  /Command Line Tools/,
  "a failing python3 or init points at the Xcode Command Line Tools"
);

console.log("test-pool: ok");
