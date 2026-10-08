import assert from "node:assert/strict";
import { isRunnerRestartFailure, needsDownscale, pngSize, isAnyUdid, isPhysicalUdid, pickDevice } from "../device-target.mjs";

const phone = { platform: "ios", kind: "device", id: "00008120-001429D11A42201E", name: "Quang’s iPhone", booted: true };
const pad = { platform: "ios", kind: "device", id: "00008103-000128C61108801E", name: "iPad", booted: true };
const sim = { platform: "ios", kind: "simulator", id: "6A9C6239-5AC1-44E7-8978-677BE2E1B53D", name: "iPhone 17", booted: true };

// A phone's UDID sent as --device (the old isUdid shape bug) selects nothing.
assert.equal(isPhysicalUdid(phone.id), true, "accepts a physical UDID shape");
assert.equal(isPhysicalUdid(sim.id), false);
assert.equal(isAnyUdid(phone.id) && isAnyUdid(sim.id), true, "--udid must be used for both shapes");
assert.equal(isAnyUdid("iPhone 17"), false);

assert.equal(pickDevice([sim, phone], {}), phone, "uses the only device when none is named");
assert.throws(() => pickDevice([phone, pad], {}), /Quang.*iPad/s, "refuses to guess between two devices and lists both");
assert.equal(
  pickDevice([phone, pad], { connectedIds: new Set([phone.id]) }),
  phone,
  "an offline paired iPad listed as booted must not block the connected phone"
);
assert.equal(pickDevice([phone, pad], { udid: pad.id }), pad);
assert.equal(pickDevice([phone, pad], { name: "iPad" }), pad);
assert.throws(() => pickDevice([phone], { udid: sim.id }), /not a physical device/, "rejects a simulator UDID when target is device");
assert.throws(() => pickDevice([phone], { name: "Nope" }), /No connected device matches Nope/);
assert.throws(() => pickDevice([sim], {}), /Connect it.*unlock.*Trust.*Developer Mode/s, "says what to do when no device is listed");

// Device screenshots are 3x the screen's points; OCR and tap points assume 1 px per point, so they must be shrunk.
const png = Buffer.alloc(24);
png.writeUInt32BE(0x89504e47, 0);
png.writeUInt32BE(1179, 16);
png.writeUInt32BE(2556, 20);
assert.deepEqual(pngSize(png), { width: 1179, height: 2556 });
assert.equal(needsDownscale(pngSize(png), { width: 393, height: 852 }), true, "a Retina device shot is shrunk");
assert.equal(needsDownscale({ width: 393, height: 852 }, { width: 393, height: 852 }), false, "a 1x shot is left alone");
assert.equal(needsDownscale({ width: 393, height: 852 }, undefined), false);
assert.throws(() => pngSize(Buffer.alloc(30)), /not a PNG/);

// Live phone: the first gesture/snapshot after a screen change fails once with this text; any other failure must not be retried.
assert.equal(isRunnerRestartFailure(new Error('iOS runner was already restarted during this request and "gesture" still failed')), true);
assert.equal(isRunnerRestartFailure(new Error("Device is locked")), false);

console.log("test-device-target: ok");
