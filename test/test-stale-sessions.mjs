import assert from "node:assert/strict";
import { isPidAlive, staleSimEyesSessions } from "../stale-sessions.mjs";

const sessions = [
  { name: "sim-eyes-111-aa-se-1" }, // dead owner: stale
  { name: "sim-eyes-222-bb-se-2" }, // live owner (another agent): keep
  { name: "sim-eyes-333-cc-se-3" }, // this process: keep
  { name: "my-manual-session" }, // not sim-eyes: never touch
  {},
];
const alive = new Set([222]);
assert.deepEqual(
  staleSimEyesSessions(sessions, { selfPid: 333, isAlive: (pid) => alive.has(pid) }),
  ["sim-eyes-111-aa-se-1"]
);
assert.equal(isPidAlive(process.pid), true);
assert.equal(isPidAlive(2 ** 22 + 12345), false);
console.log("test-stale-sessions: ok");
