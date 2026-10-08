import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { isPidAlive } from "./stale-sessions.mjs";

/** sim-pool cannot lease hardware, so a phone is guarded by one lock file per UDID. */
export const DEVICE_LOCK_DIR = join(homedir(), ".local", "sim-eyes", "device-locks");

export class DeviceBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = "DeviceBusyError";
    this.code = "DEVICE_BUSY";
  }
}

export const lockPathFor = (udid, dir = DEVICE_LOCK_DIR) => join(dir, `${udid}.json`);

async function readLock(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null; // missing or unreadable: nobody can be relying on it
  }
}

/**
 * Take the lock for a phone. A live holder with another session means busy; a dead pid (crashed
 * MCP) or an unreadable file is reclaimed once, so a crash never locks the phone forever.
 */
export async function acquireDeviceLock({
  udid,
  session,
  dir = DEVICE_LOCK_DIR,
  pid = process.pid,
  isAlive = isPidAlive,
  now = () => new Date(),
}) {
  const path = lockPathFor(udid, dir);
  await mkdir(dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await writeFile(path, JSON.stringify({ pid, session, acquiredAt: now().toISOString() }), { flag: "wx" });
      return path;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    const held = await readLock(path);
    if (held && Number.isInteger(held.pid) && isAlive(held.pid)) {
      if (held.session === session) return path;
      throw new DeviceBusyError(
        `Device ${udid} is in use by session ${held.session} (pid ${held.pid}). Report QA inconclusive; do not take another agent's phone.`
      );
    }
    await rm(path, { force: true });
  }
  throw new DeviceBusyError(`Device ${udid} lock could not be taken; try again.`);
}

/** Whether the lock file still names this session (another process may have reclaimed it). */
export async function deviceLockHeldBy(path, session) {
  return (await readLock(path))?.session === session;
}

/** Remove the lock, but only one this session owns. */
export async function releaseDeviceLock(path, session) {
  if (!path || !(await deviceLockHeldBy(path, session))) return false;
  await rm(path, { force: true });
  return true;
}
