import assert from "node:assert/strict";
import { nativeCommands } from "../native.mjs";

const ios = { platform: "ios", udid: "U1" };
const and = { platform: "android", udid: "emulator-5554", scale: 2.5 };
const opt = { adb: "/adb", axe: "axe" };

// Why: agent-device spent 1.5–5.7 s per tap or fill; these commands are the fast path, and anything they do not know stays on agent-device.
assert.deepEqual(nativeCommands(ios, ["press", "195", "311", "--settle", "--settle-quiet", "250"], opt), [
  { cmd: "axe", args: ["tap", "-x", "195", "-y", "311", "--tap-style", "physical", "--udid", "U1"] },
]);
// Why: N taps on one screen cost N axe processes (~0.8 s each); one batch is one HID session.
const many = nativeCommands(ios, ["press_many", "10", "20", "30", "40", "50", "60"], opt);
assert.equal(many.length, 1, "press_many builds one axe process");
assert.deepEqual(many[0].args.slice(0, 4), ["batch", "--udid", "U1", "--tap-style"]);
assert.equal(many[0].args.filter((a) => a.startsWith("tap -x")).length, 3, "a tap per target");
assert.equal(many[0].args.filter((a) => a.startsWith("sleep")).length, 2, "a short gap between taps");
assert.equal(nativeCommands(ios, ["press_many", "10", "20"], opt), null, "one target is a plain press");
assert.equal(nativeCommands({ ...ios, kind: "device" }, ["press_many", "1", "2", "3", "4"], opt), null);
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

const am = nativeCommands(and, ["press_many", "206", "848", "100", "100"], opt);
assert.equal(am.length, 1, "Android press_many is one adb shell call");
assert.match(am[0].args.at(-1), /input tap 515 2120; sleep 0.15; input tap 250 250/);
// Why: the built-in simulator tool has these; each must reach axe / simctl / adb as one command and stay off agent-device.
assert.deepEqual(nativeCommands(ios, ["key", "left"], opt)[0].args, ["key", "80", "--udid", "U1"]);
assert.ok(nativeCommands(ios, ["key", "redo"], opt)[0].args.includes("key-combo --modifiers 227,225 --key 29"));
assert.ok(nativeCommands(ios, ["key", "select_all"], opt)[0].args.includes("key-combo --modifiers 227 --key 4"));
assert.deepEqual(nativeCommands(ios, ["button", "side_button"], opt)[0].args, ["button", "side-button", "--udid", "U1"]);
assert.equal(nativeCommands(ios, ["button", "nope"], opt), null);
assert.deepEqual(nativeCommands(ios, ["open_url", "myapp://home"], opt)[0], { cmd: "xcrun", args: ["simctl", "openurl", "U1", "myapp://home"] });
assert.equal(nativeCommands({ ...ios, kind: "device" }, ["button", "home"], opt), null);
assert.deepEqual(nativeCommands(and, ["key", "delete"], opt)[0].args.slice(-2), ["keyevent", "67"]);
assert.deepEqual(nativeCommands(and, ["button", "lock"], opt)[0].args.slice(-2), ["keyevent", "26"]);
assert.deepEqual(nativeCommands(and, ["open_url", "https://x.y"], opt)[0].args.slice(-4), ["-a", "android.intent.action.VIEW", "-d", "https://x.y"]);
// Android coordinates are points; adb taps in pixels.
assert.deepEqual(nativeCommands(and, ["press", "206", "848"], opt)[0].args, ["-s", "emulator-5554", "shell", "input", "tap", "515", "2120"]);
assert.deepEqual(nativeCommands(and, ["back"], opt)[0].args.slice(-2), ["keyevent", "4"]);
assert.deepEqual(nativeCommands(and, ["keyboard", "dismiss"], opt)[0].args.slice(-2), ["keyevent", "4"], "agent-device has no hide key on Android");
const af = nativeCommands(and, ["fill", "206", "319", "Tran Minh Quang"], opt)[0].args.at(-1);
assert.match(af, /input tap 515 798; input keyevent 123 67 .*; input text 'Tran%sMinh%sQuang'/);
assert.equal(nativeCommands(and, ["fill", "1", "2", "Nguyễn"], opt), null, "non-ASCII text stays on agent-device");
assert.equal(nativeCommands(and, ["fill", "1", "2", "a'; rm -rf /"], opt), null, "nothing that could break out of the shell line");
console.log("test-native: ok");
