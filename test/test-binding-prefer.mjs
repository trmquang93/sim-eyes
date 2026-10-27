import assert from "node:assert/strict";
import { platformDiffersFromBinding, preferDiffersFromBinding, preferHonored, targetDiffersFromBinding } from "../binding-prefer.mjs";

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

// Why: an Android emulator and an iOS simulator are different bindings; switching must be an explicit rebind, and an old
// binding (no platform) is iOS.
assert.equal(platformDiffersFromBinding(b), false, "no platform means iOS, same as an old binding");
assert.equal(platformDiffersFromBinding(b, "ios"), false);
assert.equal(platformDiffersFromBinding(b, "android"), true);
assert.equal(platformDiffersFromBinding({ ...b, platform: "android" }, "ios"), true);
assert.equal(platformDiffersFromBinding({ ...b, platform: "android" }, "android"), false);

// Why: a clone of the AVD you asked for is the AVD you asked for; it must not read as a different one.
const clone = { udid: "emulator-5556", name: "simpool-pixel-5556", cloneOf: "pixel", platform: "android" };
assert.equal(preferHonored(clone, { name: "pixel" }), true, "a clone of the requested AVD is honored");
assert.equal(preferHonored(clone, { name: "other" }), false);
assert.equal(preferDiffersFromBinding(clone, { preferDevice: "pixel" }), false);
assert.equal(preferDiffersFromBinding(clone, { preferDevice: "other" }), true);

console.log("test-binding-prefer: ok");
