import assert from "node:assert/strict";
import { preferDiffersFromBinding } from "./binding-prefer.mjs";

const b = { udid: "aaaa", name: "iPhone 17" };
assert.equal(preferDiffersFromBinding(b, {}), false);
assert.equal(preferDiffersFromBinding(b, { preferUdid: "aaaa" }), false);
assert.equal(preferDiffersFromBinding(b, { preferUdid: "bbbb" }), true);
assert.equal(preferDiffersFromBinding(b, { preferDevice: "iPhone 17" }), false);
assert.equal(preferDiffersFromBinding(b, { preferDevice: "iPhone 18 Pro Max" }), true);

console.log("test-binding-prefer: ok");
