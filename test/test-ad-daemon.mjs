// Why: "Failed to start daemon" is raised before agent-device sends the command, so it is the one error that can be retried for
// any command (tap, type, record start). Any other error may mean the command ran, so retrying it could tap or type twice.
import assert from "node:assert/strict";
import { daemonStartupFailure, retryDaemonStartup } from "../ad-daemon.mjs";

const jsonFailure = JSON.stringify({ success: false, error: { code: "COMMAND_FAILED", message: "Failed to start daemon", details: { kind: "daemon_startup_failed", lockPath: "/x/daemon.lock" } } }, null, 2);
const textFailure = "Error (COMMAND_FAILED): Failed to start daemon\nHint: agent-device attempted to clean stale daemon metadata";

// spawnAd rejects with the output text; execFile rejects with an Error that carries stdout and stderr.
assert.equal(daemonStartupFailure(new Error(jsonFailure)).lockPath, "/x/daemon.lock");
assert.equal(daemonStartupFailure(Object.assign(new Error("Command failed: ad devices"), { stdout: jsonFailure, stderr: "" })).lockPath, "/x/daemon.lock");
assert.deepEqual(daemonStartupFailure(new Error(textFailure)), {});
assert.equal(daemonStartupFailure(new Error("SESSION_NOT_FOUND: no session")), null);
assert.equal(daemonStartupFailure(new Error(JSON.stringify({ success: false, error: { code: "COMMAND_FAILED", message: "Tap failed", details: { kind: "other" } } }))), null);
assert.equal(daemonStartupFailure(undefined), null);

const noSleep = async () => {};

// A client that lost the startup race finds the daemon the winner started on its second try.
{
  let runs = 0;
  const out = await retryDaemonStartup(async () => { if (++runs === 1) throw new Error(jsonFailure); return "tapped"; }, { sleep: noSleep });
  assert.equal(out, "tapped");
  assert.equal(runs, 2);
}

// The retry is bounded: a daemon that cannot start is reported, not retried for ever.
{
  let runs = 0;
  await assert.rejects(retryDaemonStartup(async () => { runs += 1; throw new Error(textFailure); }, { retries: 2, sleep: noSleep }), /Failed to start daemon/);
  assert.equal(runs, 3);
}

// Any other failure is thrown at once: that command may already have run.
{
  let runs = 0;
  await assert.rejects(retryDaemonStartup(async () => { runs += 1; throw new Error("SESSION_NOT_FOUND"); }, { sleep: noSleep }), /SESSION_NOT_FOUND/);
  assert.equal(runs, 1);
  runs = 0;
  await assert.rejects(retryDaemonStartup(async () => { runs += 1; throw new Error("agent-device timed out after 30000ms"); }, { sleep: noSleep }), /timed out/);
  assert.equal(runs, 1);
}

// It waits between tries so the winner's daemon is up.
{
  const waits = [];
  let runs = 0;
  await retryDaemonStartup(async () => { if (++runs === 1) throw new Error(textFailure); }, { delayMs: 321, sleep: async (ms) => waits.push(ms) });
  assert.deepEqual(waits, [321]);
}
console.log("test-ad-daemon: ok");
