import assert from "node:assert/strict";
import { DAEMON_IDLE_TIMEOUT_ENV, DAEMON_IDLE_TIMEOUT_MS, WARM_UP_ARGS, keepDaemonAlive, recoverStaleDaemon, warmUpDaemon } from "./daemon.mjs";

// The warm-up is a plain `devices` listing through the same agent-device command the server uses, so it starts the same daemon.
{
  const calls = [];
  await warmUpDaemon({ exec: async (file, args, opts) => (calls.push([file, args, opts]), {}), command: ["/usr/bin/node", "/x/agent-device.mjs"] });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "/usr/bin/node");
  assert.deepEqual(calls[0][1], ["/x/agent-device.mjs", ...WARM_UP_ARGS]);
  assert.ok(calls[0][2].timeout > 0, "a hung daemon start cannot hold the suite for ever");
}

// Two clients can still collide the first time: one more try finds the daemon the other started. A real failure is thrown, not hidden.
{
  let n = 0;
  await warmUpDaemon({ exec: async () => { if (++n === 1) throw new Error("Failed to start daemon"); return {}; }, command: ["ad"] });
  assert.equal(n, 2);
  let m = 0;
  await assert.rejects(warmUpDaemon({ exec: async () => { m += 1; throw new Error("Failed to start daemon"); }, command: ["ad"] }), /Failed to start daemon/);
  assert.equal(m, 2, "it gives up after the second try");
}

// Why: a daemon that is alive without its daemon.json holds the lock, so every new daemon exits and every client fails; no retry
// can fix that. The first startup failure must trigger the recovery, once, before the next try.
{
  const startupFailure = Object.assign(new Error("Command failed"), { stdout: JSON.stringify({ success: false, error: { message: "Failed to start daemon", details: { kind: "daemon_startup_failed", lockPath: "/s/daemon.lock", infoPath: "/s/daemon.json" } } }) });
  const recovered = [];
  let runs = 0;
  await warmUpDaemon({ exec: async () => { if (++runs === 1) throw startupFailure; return {}; }, command: ["ad"], recover: async (details) => recovered.push(details.lockPath) });
  assert.deepEqual(recovered, ["/s/daemon.lock"]);
  assert.equal(runs, 2, "the warm-up retries after the recovery");

  recovered.length = 0;
  runs = 0;
  await assert.rejects(warmUpDaemon({ exec: async () => { runs += 1; throw startupFailure; }, command: ["ad"], recover: async (d) => recovered.push(d), attempts: 3 }), /Command failed/);
  assert.equal(recovered.length, 1, "it recovers once, not before every try");
  assert.equal(runs, 3);

  recovered.length = 0;
  await assert.rejects(warmUpDaemon({ exec: async () => { throw new Error("spawn ENOENT"); }, command: ["ad"], recover: async (d) => recovered.push(d) }), /ENOENT/);
  assert.equal(recovered.length, 0, "an unrelated failure does not stop a daemon");

  recovered.length = 0;
  await assert.rejects(warmUpDaemon({ exec: async () => { throw startupFailure; }, command: ["ad"], attempts: 1, recover: async (d) => recovered.push(d) }), /Command failed/);
  assert.equal(recovered.length, 0, "a recovery with no try after it is not run");

  runs = 0;
  await warmUpDaemon({ exec: async () => { if (++runs === 1) throw startupFailure; return {}; }, command: ["ad"], recover: async () => { throw new Error("kill failed"); } });
  assert.equal(runs, 2, "a failed recovery does not stop the second try");
}

// Why: killing the wrong process, or a daemon another client just started, would break a healthy suite worse than the failure it cures.
{
  const startTime = "Sun Oct  4 19:09:47 2026";
  const harness = ({ files, alive = true, ps = { startTime, command: "/usr/bin/node /x/agent-device/dist/src/internal/daemon.js" }, diesOnTerm = true }) => {
    const fs = { files: { ...files }, removed: [] };
    const signals = [];
    let up = alive;
    return {
      signals,
      removed: fs.removed,
      deps: {
        details: { infoPath: "/s/daemon.json", lockPath: "/s/daemon.lock" },
        fs: {
          exists: async (p) => p in fs.files,
          readFile: async (p) => { if (!(p in fs.files)) throw new Error("ENOENT"); return fs.files[p]; },
          remove: async (p) => { fs.removed.push(p); delete fs.files[p]; },
        },
        processInfo: async () => (up ? ps : null),
        kill: (pid, signal) => { signals.push([pid, signal]); if (signal === "SIGKILL" || diesOnTerm) up = false; },
        sleep: async () => {},
      },
    };
  };
  const lock = JSON.stringify({ pid: 4242, version: "0.21.19", processStartTime: startTime });

  let h = harness({ files: { "/s/daemon.lock": lock } });
  assert.equal(await recoverStaleDaemon(h.deps), 4242);
  assert.deepEqual(h.signals, [[4242, "SIGTERM"]]);
  assert.ok(h.removed.includes("/s/daemon.lock"), "the lock that blocks the next daemon is removed");

  h = harness({ files: { "/s/daemon.lock": lock }, diesOnTerm: false });
  assert.equal(await recoverStaleDaemon(h.deps), 4242);
  assert.deepEqual(h.signals, [[4242, "SIGTERM"], [4242, "SIGKILL"]], "a daemon that ignores SIGTERM is killed");

  h = harness({ files: { "/s/daemon.lock": lock, "/s/daemon.json": "{}" } });
  assert.equal(await recoverStaleDaemon(h.deps), null);
  assert.deepEqual(h.signals, [], "a daemon with its daemon.json is a live one: never stopped");
  assert.deepEqual(h.removed, []);

  h = harness({ files: { "/s/daemon.lock": lock }, ps: { startTime: "Sun Oct  4 20:00:00 2026", command: "/usr/bin/node /x/daemon.js" } });
  assert.equal(await recoverStaleDaemon(h.deps), null);
  assert.deepEqual(h.signals, [], "a recycled pid (another start time) is not killed");
  assert.ok(h.removed.includes("/s/daemon.lock"), "but its stale lock is cleared");

  h = harness({ files: { "/s/daemon.lock": lock }, ps: { startTime, command: "/usr/bin/vim notes.txt" } });
  assert.equal(await recoverStaleDaemon(h.deps), null);
  assert.deepEqual(h.signals, [], "a process that is not a daemon is not killed");

  h = harness({ files: { "/s/daemon.lock": lock }, alive: false });
  assert.equal(await recoverStaleDaemon(h.deps), null);
  assert.deepEqual(h.signals, []);
  assert.ok(h.removed.includes("/s/daemon.lock"), "a lock of a dead daemon is cleared");

  h = harness({ files: { "/s/daemon.lock": "not json" } });
  assert.equal(await recoverStaleDaemon(h.deps), null);
  assert.ok(h.removed.includes("/s/daemon.lock"), "an unreadable lock is cleared");
}

// Why: agent-device's daemon exits after 5 idle minutes by default, and a suite of long goal / wait steps has no request in flight, so
// the daemon went away mid-suite. It reads the limit from the environment of the client that starts it.
{
  assert.equal(keepDaemonAlive({})[DAEMON_IDLE_TIMEOUT_ENV], DAEMON_IDLE_TIMEOUT_MS);
  assert.ok(Number(DAEMON_IDLE_TIMEOUT_MS) >= 60 * 60 * 1000, "longer than any suite");
  assert.equal(keepDaemonAlive({ [DAEMON_IDLE_TIMEOUT_ENV]: " " })[DAEMON_IDLE_TIMEOUT_ENV], DAEMON_IDLE_TIMEOUT_MS);
  assert.equal(keepDaemonAlive({ [DAEMON_IDLE_TIMEOUT_ENV]: "0" })[DAEMON_IDLE_TIMEOUT_ENV], "0", "a value the user set is kept");
  const seen = [];
  const before = process.env[DAEMON_IDLE_TIMEOUT_ENV];
  delete process.env[DAEMON_IDLE_TIMEOUT_ENV];
  await warmUpDaemon({ exec: async (file, args, opts) => (seen.push(opts.env[DAEMON_IDLE_TIMEOUT_ENV]), {}), command: ["ad"] });
  assert.deepEqual(seen, [DAEMON_IDLE_TIMEOUT_MS], "the warm-up starts the daemon with the long limit");
  assert.equal(process.env[DAEMON_IDLE_TIMEOUT_ENV], undefined, "the warm-up does not change Studio's own env");
  if (before !== undefined) process.env[DAEMON_IDLE_TIMEOUT_ENV] = before;
}

// Why: a recovery in the middle of a suite must not stop a daemon another client is still starting (lock written, daemon.json not yet).
{
  const lock = JSON.stringify({ pid: 4242, startedAt: 1_000_000, processStartTime: "Sun Oct  4 19:09:47 2026" });
  const signals = [];
  const deps = (now) => ({
    details: { infoPath: "/s/daemon.json", lockPath: "/s/daemon.lock" },
    fs: { exists: async () => false, readFile: async () => lock, remove: async () => assert.fail("a starting daemon's files are kept") },
    processInfo: async () => ({ startTime: "Sun Oct  4 19:09:47 2026", command: "node daemon.js" }),
    kill: (pid, signal) => signals.push(signal),
    sleep: async () => {},
    now: () => now,
  });
  assert.equal(await recoverStaleDaemon(deps(1_003_000)), null);
  assert.deepEqual(signals, []);
}
console.log("test-daemon: ok");
