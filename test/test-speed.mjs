import assert from "node:assert/strict";
import { shouldRenew, needsSecondRead, pastePlan, RENEW_MAX_INTERVAL_MS, SETTLE_WINDOW_MS } from "../speed.mjs";

// Why: a sim-pool renew is a process spawn (~50 ms); running it before every snapshot and press cost ~150 ms per step.
assert.equal(shouldRenew(1000, null), true, "the first call renews");
assert.equal(shouldRenew(1000 + 5000, 1000), false, "a renew inside the interval is skipped");
assert.equal(shouldRenew(1000 + RENEW_MAX_INTERVAL_MS, 1000), true, "a renew after the interval runs");
assert.equal(shouldRenew(1000 + 20000, 1000, 30000), true, "a short TTL renews at a third of it, so the lease cannot lapse between calls");
assert.equal(shouldRenew(1000 + 9000, 1000, 30000), false);
assert.equal(shouldRenew(1000 + RENEW_MAX_INTERVAL_MS - 1, 1000, 24 * 3600 * 1000), false, "a long TTL still renews at least once a minute");

// Why: a tree read right after an input can catch a moving layout (the keyboard hiding); one long after cannot.
assert.equal(needsSecondRead({ sinceInputMs: 100 }), true, "a read right after an input is repeated until two agree");
assert.equal(needsSecondRead({ sinceInputMs: SETTLE_WINDOW_MS - 1 }), true);
assert.equal(needsSecondRead({ sinceInputMs: SETTLE_WINDOW_MS }), false, "a read long after an input is taken once");
assert.equal(needsSecondRead({ sinceInputMs: Infinity }), false, "no input yet");

// Why: axe types plain short text fast; long text takes a keystroke each, and quotes or non-ASCII cannot be put on a step line.
assert.equal(pastePlan("Tran Minh Quang"), "type");
assert.equal(pastePlan("x".repeat(200)), "paste");
assert.equal(pastePlan("it's"), "paste");
assert.equal(pastePlan('say "hi"'), "paste");
assert.equal(pastePlan("Nguyễn Văn A"), "paste");
console.log("test-speed: ok");
