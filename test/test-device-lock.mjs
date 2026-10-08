import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireDeviceLock, DeviceBusyError, releaseDeviceLock } from "../device-lock.mjs";

const dir = await mkdtemp(join(tmpdir(), "device-locks-"));
const udid = "00008120-001429D11A42201E";
const alive = new Set([100, 200]);
const isAlive = (pid) => alive.has(pid);

const path = await acquireDeviceLock({ udid, session: "A", dir, pid: 100, isAlive });
assert.equal(JSON.parse(await readFile(path, "utf8")).session, "A");

// Two agents on one phone is the whole thing the lock prevents.
await assert.rejects(
  acquireDeviceLock({ udid, session: "B", dir, pid: 200, isAlive }),
  (err) => err instanceof DeviceBusyError && err.code === "DEVICE_BUSY" && /session A/.test(err.message),
  "second acquire of a held UDID is DEVICE_BUSY"
);
assert.equal(await acquireDeviceLock({ udid, session: "A", dir, pid: 100, isAlive }), path, "same session reuses its lock");

// A session must not free a phone another session holds.
assert.equal(await releaseDeviceLock(path, "B"), false, "release leaves a lock owned by another session");
assert.equal(await releaseDeviceLock(path, "A"), true);

// A crashed MCP must not lock the phone forever.
await acquireDeviceLock({ udid, session: "dead", dir, pid: 999, isAlive: () => true });
alive.delete(999);
const again = await acquireDeviceLock({ udid, session: "C", dir, pid: 200, isAlive: (p) => p !== 999 });
assert.equal(JSON.parse(await readFile(again, "utf8")).session, "C", "reclaims a lock whose pid is dead");

await rm(dir, { recursive: true, force: true });
console.log("test-device-lock: ok");
