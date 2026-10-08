// Why: `sim-eyes doctor` is how a stranger learns what their Mac lacks. A missing prerequisite reported as fine sends them
// into a confusing failure inside an agent session; an optional one (ffmpeg, the key) reported as FAIL scares them off;
// and a diagnostic must never trigger macOS's Command Line Tools installer dialog by running python3 on a bare Mac.
import assert from "node:assert/strict";
import { doctorExitCode, formatDoctor, runDoctor } from "../doctor.mjs";

const SIMCTL = JSON.stringify({
  devices: {
    "com.apple.CoreSimulator.SimRuntime.iOS-18-0": [
      { name: "iPad Pro", isAvailable: true },
      { name: "iPhone 16", isAvailable: true },
    ],
  },
});
const POOL_STATUS = "pool_home=/x\ndevices_whitelisted=2\nFREE\tA\tiPhone 16\tBooted\n";

/** A Mac where everything is fine. Each case below breaks one thing. */
function mac(over = {}) {
  const calls = [];
  const answers = {
    "xcode-select -p": { code: 0, stdout: "/Applications/Xcode.app/Contents/Developer\n", stderr: "" },
    "xcrun simctl list devices available -j": { code: 0, stdout: SIMCTL, stderr: "" },
    "python3 --version": { code: 0, stdout: "Python 3.9.6\n", stderr: "" },
    "python3 /pool/sim-pool status": { code: 0, stdout: POOL_STATUS, stderr: "" },
    "node /ad/agent-device.mjs --version": { code: 0, stdout: "0.21.19\n", stderr: "" },
    "ffmpeg -version": { code: 0, stdout: "ffmpeg version 7\n", stderr: "" },
    ...over.answers,
  };
  const deps = {
    platform: "darwin",
    nodeVersion: "22.12.0",
    env: { TYPESAFE_API_KEY: "sk-secret-value" },
    exec: async (cmd, args) => {
      const key = [cmd, ...args].join(" ");
      calls.push(key);
      return answers[key] ?? { code: 127, stdout: "", stderr: `${cmd}: not found` };
    },
    pool: { command: "python3", args: ["/pool/sim-pool"], source: "vendored", path: "/pool/sim-pool" },
    poolConfigExists: true,
    adCommand: ["node", "/ad/agent-device.mjs"],
    adPin: "0.21.19",
    ocr: { trusted: () => true, run: async () => ({ code: 0, stdout: "{}", stderr: "" }), compiled: () => false },
    ...over.deps,
  };
  return { deps, calls };
}

const status = (results, id) => results.find((r) => r.id === id);

{
  const { deps } = mac();
  const results = await runDoctor(deps);
  assert.deepEqual(results.map((r) => [r.id, r.status]), [
    ["macos", "pass"], ["node", "pass"], ["xcode-clt", "pass"], ["simulator", "pass"], ["real-device", "warn"], ["python3", "pass"],
    ["sim-pool", "pass"], ["agent-device", "pass"], ["ocr", "pass"], ["ffmpeg", "pass"], ["typesafe", "pass"],
  ]);
  assert.equal(doctorExitCode(results), 0);
  assert.ok(!formatDoctor(results).includes("sk-secret-value"), "the key is never printed");
}

assert.equal(status(await runDoctor(mac({ deps: { platform: "linux" } }).deps), "macos").status, "fail", "iOS simulators exist only on macOS");

for (const [version, expected] of [["22.12.0", "pass"], ["22.11.9", "fail"], ["20.18.0", "fail"], ["24.0.0", "pass"]]) {
  assert.equal(status(await runDoctor(mac({ deps: { nodeVersion: version } }).deps), "node").status, expected, `node ${version}`);
}

{
  const { deps, calls } = mac({ answers: { "xcode-select -p": { code: 2, stdout: "", stderr: "no developer tools" } } });
  const results = await runDoctor(deps);
  assert.equal(status(results, "xcode-clt").status, "fail");
  assert.match(status(results, "xcode-clt").fix, /xcode-select --install/);
  assert.ok(!calls.some((c) => c.startsWith("python3")), "python3 is never run without the Command Line Tools: on a bare Mac it opens an installer dialog");
  assert.equal(status(results, "python3").status, "fail");
  assert.match(status(results, "python3").detail, /not checked/);
  assert.equal(doctorExitCode(results), 1, "any FAIL exits 1");
}

for (const [label, stdout] of [["no simulators at all", JSON.stringify({ devices: {} })], ["only iPads", JSON.stringify({ devices: { r: [{ name: "iPad Air", isAvailable: true }] } })]]) {
  const r = status(await runDoctor(mac({ answers: { "xcrun simctl list devices available -j": { code: 0, stdout, stderr: "" } } }).deps), "simulator");
  assert.equal(r.status, "fail", label);
  assert.match(r.fix, /Xcode/);
}

assert.equal(status(await runDoctor(mac({ answers: { "python3 --version": { code: 1, stdout: "", stderr: "x" } } }).deps), "python3").status, "fail", "python3 that does not run");

{
  const r = status(await runDoctor(mac({ deps: { pool: null } }).deps), "sim-pool");
  assert.equal(r.status, "fail", "no sim-pool anywhere means no exclusive simulator per agent");
  assert.match(r.fix, /SIM_POOL_BIN|Reinstall/);
}
{
  const { deps, calls } = mac({ deps: { poolConfigExists: false } });
  const r = status(await runDoctor(deps), "sim-pool");
  assert.equal(r.status, "warn", "no whitelist yet is normal on a fresh Mac: the first acquire creates it");
  assert.match(r.detail, /first acquire/);
  assert.ok(!calls.includes("python3 /pool/sim-pool status"), "status is not run against a pool that does not exist yet (it would create it)");
}
assert.equal(status(await runDoctor(mac({ answers: { "python3 /pool/sim-pool status": { code: 1, stdout: "", stderr: "boom" } } }).deps), "sim-pool").status, "fail");
assert.match(status(await runDoctor(mac().deps), "sim-pool").detail, /2 simulator/, "reports the whitelist size");

{
  const r = status(await runDoctor(mac({ answers: { "node /ad/agent-device.mjs --version": { code: 0, stdout: "0.20.0\n", stderr: "" } } }).deps), "agent-device");
  assert.equal(r.status, "warn", "a different agent-device version than the pin works but is unverified");
  assert.match(r.detail, /0\.20\.0/);
}
assert.equal(status(await runDoctor(mac({ answers: { "node /ad/agent-device.mjs --version": { code: 1, stdout: "", stderr: "x" } } }).deps), "agent-device").status, "fail");

{
  const r = status(await runDoctor(mac({ deps: { ocr: { trusted: () => false, run: async () => assert.fail("not run"), compiled: () => false } } }).deps), "ocr");
  assert.equal(r.status, "warn", "no prebuilt helper is not broken: it compiles on first use");
  assert.match(r.detail, /compile/);
  assert.equal(status(await runDoctor(mac({ deps: { ocr: { trusted: () => false, run: async () => assert.fail("not run"), compiled: () => true } } }).deps), "ocr").status, "pass");
  assert.equal(status(await runDoctor(mac({ deps: { ocr: { trusted: () => true, run: async () => ({ code: 1, stdout: "", stderr: "Bad CPU type" }), compiled: () => false } } }).deps), "ocr").status, "fail", "a helper that does not run is a FAIL");
}

{
  const results = await runDoctor(mac({ answers: { "ffmpeg -version": { code: 127, stdout: "", stderr: "" } }, deps: { env: {} } }).deps);
  assert.equal(status(results, "ffmpeg").status, "warn", "only `record` stop needs ffmpeg");
  assert.equal(status(results, "typesafe").status, "warn", "only `goal` needs a key");
  assert.match(status(results, "typesafe").fix, /TYPESAFE_API_KEY/);
  assert.match(status(results, "typesafe").fix, /TYPESAFE_BASE_URL/, "invitees need the hub variables too");
  assert.equal(doctorExitCode(results), 0, "WARN alone exits 0");
}

{
  const text = formatDoctor(await runDoctor(mac({ deps: { platform: "linux" } }).deps));
  assert.match(text, /FAIL +macos/);
  assert.match(text, /fix:/, "a failing line says how to fix it");
}

// A simulator-only Mac is the normal install: no phone must not fail the run, or doctor would reject everyone without hardware.
{
  const { deps } = mac();
  const none = await runDoctor(deps);
  assert.equal(status(none, "real-device").status, "warn", "no connected phone is a warning, not a failure");
  assert.equal(doctorExitCode(none), 0);

  const phone = "iPhone  00008120-001429D11A42201E (UDID)  connected  iPhone 15  physical \n";
  const unsigned = mac({ answers: { "xcrun devicectl list devices": { code: 0, stdout: phone, stderr: "" } } });
  assert.match(status(await runDoctor(unsigned.deps), "real-device").fix, /AGENT_DEVICE_IOS_TEAM_ID/, "a phone without signing env says what to set");

  const signed = mac({
    answers: { "xcrun devicectl list devices": { code: 0, stdout: phone + "sim  X (UDID)  connected  iPhone 17  simulated\n", stderr: "" } },
    deps: { env: { AGENT_DEVICE_IOS_TEAM_ID: "T", AGENT_DEVICE_IOS_BUNDLE_ID: "b" } },
  });
  const ready = status(await runDoctor(signed.deps), "real-device");
  assert.equal(ready.status, "pass");
  assert.match(ready.detail, /^1 connected/, "simulators listed by devicectl are not phones");
}

console.log("test-doctor: ok");
