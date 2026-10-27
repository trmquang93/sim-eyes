import assert from "node:assert/strict";
import { parseAcquireOutput, defaultInstanceId, resolveSimPool, findSimPoolBin, ensurePoolConfigured, buildAcquireArgs, leaseFromOutput, describeAndroidPoolError } from "../pool.mjs";

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

// Why: iOS acquire must send exactly the arguments it sent before Android existed (no --platform, so an older sim-pool still works).
const base = { instanceId: "1-ab", project: "sim-eyes", timeout: 5 };
assert.deepEqual(buildAcquireArgs({ ...base, holderPid: 42 }), [
  "acquire", "--holder-pid", "42", "--owner", "sim-eyes-1-ab", "--project", "sim-eyes", "--session", "sim-eyes-1-ab", "--timeout", "5",
]);
assert.ok(!buildAcquireArgs({ ...base, holderPid: 42, platform: "ios" }).includes("--platform"));
assert.deepEqual(buildAcquireArgs({ ...base, holderPid: 42, preferUdid: "U", ttl: 60, worktree: "/w" }).slice(-6), ["--worktree", "/w", "--ttl", "60", "--prefer-udid", "U"]);

// Android: --platform android, and a preferred AVD goes as --avd (a UDID means nothing there).
const android = buildAcquireArgs({ ...base, holderPid: 42, platform: "android", preferDevice: "pixel" });
assert.ok(android.join(" ").includes("--platform android --avd pixel"));
assert.ok(!android.includes("--prefer-udid"));
assert.throws(() => buildAcquireArgs({ ...base, holderPid: 42, platform: "android", preferUdid: "emulator-5554" }), /prefer_device/, "an Android emulator is asked for by AVD name");
assert.ok(!buildAcquireArgs({ ...base, holderPid: 42, platform: "android" }).includes("--avd"), "no preference: the pool picks the AVD");

// PLATFORM=, CLONE_OF= and the AVD name come back from the pool; a lease from an iOS pool has no PLATFORM and stays iOS.
const ios = leaseFromOutput("LEASE_ID=l1\nUDID=8F395E81-CF05-425A-B3C8-CA63CFDE8FD6\nSIMULATOR_NAME=iPhone 17\nEXPIRES_AT=2026-10-27T01:00:00+00:00\n", "sess");
assert.deepEqual(ios, { leaseId: "l1", udid: "8F395E81-CF05-425A-B3C8-CA63CFDE8FD6", name: "iPhone 17", expiresAt: "2026-10-27T01:00:00+00:00", session: "sess", platform: "ios", cloneOf: "" });
const emu = leaseFromOutput("LEASE_ID=l2\nUDID=emulator-5556\nSIMULATOR_NAME=simpool-pixel-5556\nEXPIRES_AT=x\nPLATFORM=android\nCLONE_OF=pixel\n", "sess");
assert.equal(emu.platform, "android");
assert.equal(emu.cloneOf, "pixel");
assert.equal(emu.name, "simpool-pixel-5556");
assert.throws(() => leaseFromOutput("EXPIRES_AT=x\n", "sess"), /no LEASE_ID\/UDID/);

// Why: the iOS whitelist check does not apply to Android (the pool finds AVDs on disk), and a missing Android SDK must say so.
assert.equal(describeAndroidPoolError("Android SDK tools not found: need `emulator` and `adb`"), "Android SDK tools not found: need `emulator` and `adb`. Install Android Studio (or the command-line tools), create an AVD, then retry.");
assert.equal(describeAndroidPoolError("No Android AVDs: create one in Android Studio, then run: sim-pool init --android"), "No Android AVDs: create one in Android Studio, then run: sim-pool init --android");
assert.match(describeAndroidPoolError("ANDROID_BOOT_FAILED emulator-5554 not booted after 180s"), /ANDROID_BOOT_FAILED/);

// Why: the user's sim-pool skill wins over the vendored copy, and one from before Android rejects --platform; say so.
assert.match(describeAndroidPoolError("sim-pool: error: unrecognized arguments: --platform android"), /predates Android|too old/i);
assert.match(describeAndroidPoolError("sim-pool: error: unrecognized arguments: --platform android"), /update the sim-pool skill/i);
assert.doesNotMatch(describeAndroidPoolError("SIM_POOL_BUSY"), /too old/i);

console.log("test-pool android: ok");
