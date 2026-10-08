import assert from "node:assert/strict";
import { preferDiffersFromBinding, preferHonored, targetDiffersFromBinding } from "../binding-prefer.mjs";

const b = { udid: "aaaa", name: "iPhone 17" };
assert.equal(preferDiffersFromBinding(b, {}), false);
assert.equal(preferDiffersFromBinding(b, { preferUdid: "aaaa" }), false);
assert.equal(preferDiffersFromBinding(b, { preferUdid: "bbbb" }), true);
assert.equal(preferDiffersFromBinding(b, { preferDevice: "iPhone 17" }), false);
assert.equal(preferDiffersFromBinding(b, { preferDevice: "iPhone 18 Pro Max" }), true);

// sim-pool hands out any free simulator when the preferred one is taken; that must read as not honored.
assert.equal(preferHonored(b, {}), true, "no preference: any simulator is fine");
assert.equal(preferHonored(b, { udid: "aaaa" }), true);
assert.equal(preferHonored(b, { udid: "bbbb" }), false);
assert.equal(preferHonored(b, { name: "iPhone 17" }), true);
assert.equal(preferHonored(b, { name: "iPhone 18 Pro Max" }), false);
assert.equal(preferHonored(b, { udid: "aaaa", name: "iPhone 18 Pro Max" }), true, "the UDID wins over the name");

// Switching from a simulator to a real phone must never happen silently: it needs an explicit rebind.
assert.equal(targetDiffersFromBinding(b, "device"), true, "a simulator binding asked for a device");
assert.equal(targetDiffersFromBinding({ ...b, kind: "device" }, "simulator"), true, "a device binding asked for a simulator");
assert.equal(targetDiffersFromBinding(b), false, "no target means simulator");
assert.equal(targetDiffersFromBinding({ ...b, kind: "device" }, "device"), false);

console.log("test-binding-prefer: ok");
