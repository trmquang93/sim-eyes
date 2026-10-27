import assert from "node:assert/strict";
import { nativeCommands } from "../native.mjs";

const ios = { platform: "ios", udid: "U1" };
const and = { platform: "android", udid: "emulator-5554", scale: 2.5 };
const opt = { adb: "/adb", axe: "axe" };

// Why: agent-device spent 1.5–5.7 s per tap or fill; these commands are the fast path, and anything they do not know stays on agent-device.
assert.deepEqual(nativeCommands(ios, ["press", "195", "311", "--settle", "--settle-quiet", "250"], opt), [
  { cmd: "axe", args: ["tap", "-x", "195", "-y", "311", "--tap-style", "physical", "--udid", "U1"] },
]);
// The default "simulator" tap does nothing on iOS 27 simulators: never leave it out.
assert.ok(nativeCommands(ios, ["press", "1", "2"], opt)[0].args.includes("physical"));
assert.equal(nativeCommands(ios, ["press", "1", "2", "--double-tap"], opt), null, "a double tap needs agent-device's single device call");
const fill = nativeCommands(ios, ["fill", "195", "342", "Tran Minh Quang", "--settle"], opt)[0].args;
assert.deepEqual(fill.slice(0, 3), ["batch", "--udid", "U1"]);
assert.ok(fill.includes("key-combo --modifiers 227 --key 4"), "a fill replaces what the field holds (select all, then type)");
assert.ok(fill.includes("type 'Tran Minh Quang'"));
assert.equal(nativeCommands(ios, ["fill", "1", "2", "it's"], opt), null, "text with quotes is not put on a step line");
assert.deepEqual(nativeCommands(ios, ["keyboard", "enter"], opt)[0].args, ["key", "40", "--udid", "U1"]);
assert.equal(nativeCommands(ios, ["keyboard", "dismiss"], opt), null);
assert.equal(nativeCommands({ ...ios, kind: "device" }, ["press", "1", "2"], opt), null, "a real phone stays on agent-device");
assert.equal(nativeCommands(ios, ["snapshot", "-i"], opt), null);

// Android coordinates are points; adb taps in pixels.
assert.deepEqual(nativeCommands(and, ["press", "206", "848"], opt)[0].args, ["-s", "emulator-5554", "shell", "input", "tap", "515", "2120"]);
assert.deepEqual(nativeCommands(and, ["back"], opt)[0].args.slice(-2), ["keyevent", "4"]);
assert.deepEqual(nativeCommands(and, ["keyboard", "dismiss"], opt)[0].args.slice(-2), ["keyevent", "4"], "agent-device has no hide key on Android");
const af = nativeCommands(and, ["fill", "206", "319", "Tran Minh Quang"], opt)[0].args.at(-1);
assert.match(af, /input tap 515 798; input keyevent 123 67 .*; input text 'Tran%sMinh%sQuang'/);
assert.equal(nativeCommands(and, ["fill", "1", "2", "Nguyễn"], opt), null, "non-ASCII text stays on agent-device");
assert.equal(nativeCommands(and, ["fill", "1", "2", "a'; rm -rf /"], opt), null, "nothing that could break out of the shell line");
console.log("test-native: ok");
