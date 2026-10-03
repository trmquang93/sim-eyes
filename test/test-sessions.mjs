import assert from "node:assert/strict";
import { SessionRegistry } from "../client-sessions.mjs";

const reg = new SessionRegistry();
const a = reg.resolve(undefined, { allowCreate: true, toolName: "batch" });
assert.ok(a.created);
assert.match(a.ctx.id, /^se-[0-9a-f]+$/);

assert.throws(
  () => reg.resolve(undefined, { allowCreate: false, toolName: "status" }),
  /requires session_id/
);

const b = reg.resolve(a.ctx.id, { allowCreate: false, toolName: "batch" });
assert.equal(b.created, false);
assert.equal(b.ctx.id, a.ctx.id);

assert.throws(
  () => reg.resolve("se-deadbeef000000000000", { allowCreate: false, toolName: "batch" }),
  /Unknown session_id/
);

console.log("test-sessions: ok");
