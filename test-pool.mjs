import assert from "node:assert/strict";
import { parseAcquireOutput, defaultInstanceId } from "./pool.mjs";

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

console.log("test-pool: ok");
