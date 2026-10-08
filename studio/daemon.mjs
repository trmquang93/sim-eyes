/**
 * agent-device talks to one local daemon that its first command starts. A suite that starts N tests at once starts N
 * clients that all find no daemon and all try to start one: the losers fail with "Failed to start daemon" and the test
 * is lost. `warmUpDaemon` is one cheap command (`devices`) sent before the first parallel start, so the clients only find a daemon.
 * It also clears one state no client can: a daemon that is alive but whose `daemon.json` is gone. Its lock still blocks every
 * new daemon, and `daemon stop` cannot find it without that file, so `recoverStaleDaemon` stops it by the pid in the lock.
 */
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { adCommandFromHost } from "../ad-command.mjs";
import { daemonStartupFailure } from "../ad-daemon.mjs";
import { realExec } from "./builds.mjs";

export const WARM_UP_ARGS = ["devices", "--platform", "ios", "--json"];
export const WARM_UP_TIMEOUT_MS = 120_000;
export const DAEMON_IDLE_TIMEOUT_ENV = "AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS";
export const DAEMON_IDLE_TIMEOUT_MS = String(2 * 60 * 60 * 1000);
const NEW_DAEMON_GRACE_MS = 10_000;
const STOP_WAIT_MS = 5_000;
const KILL_WAIT_MS = 2_000;

const stateDir = (env = process.env) => env.AGENT_DEVICE_STATE_DIR || join(homedir(), ".agent-device");
const normalize = (text) => String(text).replace(/\s+/g, " ").trim();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The daemon exits on its own after 5 minutes without a request (agent-device's default), and a suite of long goal / wait steps
 * has none in flight. The daemon reads the setting from the environment of the client that starts it, so it is set here for
 * Studio and every client it spawns; a value the user already set is kept.
 */
export function keepDaemonAlive(env = process.env) {
  if (!env[DAEMON_IDLE_TIMEOUT_ENV]?.trim()) env[DAEMON_IDLE_TIMEOUT_ENV] = DAEMON_IDLE_TIMEOUT_MS;
  return env;
}

/** `{ startTime, command }` of a live process (`ps`), or null once it is gone. */
async function psInfo(pid, exec = realExec) {
  try {
    const { stdout } = await exec("ps", ["-o", "lstart=,command=", "-p", String(pid)], {});
    const m = /^\s*(\w{3} \w{3}\s+\d+ [\d:]+ \d{4})\s+(.*)$/.exec(stdout.trim());
    return m ? { startTime: m[1], command: m[2] } : null;
  } catch {
    return null;
  }
}

const killPid = (pid, signal) => {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
};

const realFs = {
  readFile: (path) => readFile(path, "utf8"),
  exists: (path) => readFile(path).then(() => true, () => false),
  remove: (path) => rm(path, { force: true }),
};

/**
 * Frees agent-device's state for the next client when a daemon is alive without `daemon.json`: stops the process named by
 * `daemon.lock` and removes both files. It never touches a daemon that has its `daemon.json` (a daemon another client just
 * started), and never a daemon younger than 10 s (it may still be writing its `daemon.json`), and never a pid whose start time or command is not the one the lock recorded (a recycled pid). Returns the pid it stopped, or null.
 */
export async function recoverStaleDaemon({ details = {}, fs = realFs, processInfo = psInfo, kill = killPid, sleep = wait, now = Date.now, env = process.env } = {}) {
  const infoPath = details.infoPath ?? join(stateDir(env), "daemon.json");
  const lockPath = details.lockPath ?? join(stateDir(env), "daemon.lock");
  if (await fs.exists(infoPath)) return null;
  let lock;
  try {
    lock = JSON.parse(await fs.readFile(lockPath));
  } catch {
    await fs.remove(lockPath);
    return null;
  }
  if (now() - lock?.startedAt < NEW_DAEMON_GRACE_MS) return null;
  let stopped = null;
  const info = Number.isInteger(lock?.pid) ? await processInfo(lock.pid) : null;
  const isIt = info && normalize(info.startTime) === normalize(lock.processStartTime) && /daemon\.js/.test(info.command);
  if (isIt) {
    kill(lock.pid, "SIGTERM");
    let gone = false;
    for (let waited = 0; !gone && waited < STOP_WAIT_MS; waited += 100) {
      await sleep(100);
      gone = !(await processInfo(lock.pid));
    }
    if (!gone) {
      kill(lock.pid, "SIGKILL");
      await sleep(KILL_WAIT_MS);
    }
    stopped = lock.pid;
  }
  await fs.remove(infoPath);
  await fs.remove(lockPath);
  return stopped;
}

/**
 * Throws when the daemon cannot be started (after one more try); the suite goes on and the first test shows the real error.
 * A startup failure triggers `recover` once before the next try: a second client that won the race needs only the retry, a
 * stale daemon needs the recovery.
 */
export async function warmUpDaemon({ exec = realExec, command = adCommandFromHost(() => ["npx", "-y", "agent-device"]), attempts = 2, recover = (details) => recoverStaleDaemon({ details }) } = {}) {
  const [file, ...head] = command;
  let last;
  let recovered = false;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await exec(file, [...head, ...WARM_UP_ARGS], { timeout: WARM_UP_TIMEOUT_MS, env: keepDaemonAlive({ ...process.env }) });
      return;
    } catch (err) {
      last = err;
      const failure = daemonStartupFailure(err);
      if (failure && !recovered && i < attempts - 1) {
        recovered = true;
        await recover(failure).catch(() => {});
      }
    }
  }
  throw last;
}
