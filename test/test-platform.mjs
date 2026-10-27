import assert from "node:assert/strict";
import { adTargetArgs, findAndroidTools, listAvds, androidResetArgs, isAndroidSerial, normalizePlatform, parseWmDensity, scaleAdArgs, screenshotArgs } from "../platform.mjs";

const SIM = "6A9C6239-5AC1-44E7-8978-677BE2E1B53D";

// Why: iOS must keep sending exactly what it sent before this module existed (--platform ios plus --udid / --device).
assert.deepEqual(adTargetArgs("ios", SIM), ["--platform", "ios", "--udid", SIM]);
assert.deepEqual(adTargetArgs("ios", "00008120-001429D11A42201E"), ["--platform", "ios", "--udid", "00008120-001429D11A42201E"], "a phone's UDID is still --udid");
assert.deepEqual(adTargetArgs("ios", "iPhone 17"), ["--platform", "ios", "--device", "iPhone 17"]);
assert.deepEqual(adTargetArgs(undefined, SIM), adTargetArgs("ios", SIM), "a binding without a platform is iOS (old bindings)");

// Why: agent-device rejects --udid and --device for Android once the session is bound (measured, Phase 0): only --serial works.
assert.deepEqual(adTargetArgs("android", "emulator-5554"), ["--platform", "android", "--serial", "emulator-5554"]);
assert.throws(() => adTargetArgs("android", SIM), /emulator serial/, "an iOS UDID is never sent as an Android serial");
assert.throws(() => adTargetArgs("android", "R5CT123ABC"), /emulator serial/, "a physical Android phone is out of scope: refuse it, do not drive it");
assert.throws(() => adTargetArgs("android", ""), /emulator serial/);

assert.equal(isAndroidSerial("emulator-5554"), true);
assert.equal(isAndroidSerial("emulator-5554 "), false);
assert.equal(isAndroidSerial("emulator-"), false);
assert.equal(isAndroidSerial(SIM), false);

assert.equal(normalizePlatform(undefined), "ios", "callers that pass no platform stay on iOS");
assert.equal(normalizePlatform(""), "ios");
assert.equal(normalizePlatform("android"), "android");
assert.throws(() => normalizePlatform("windows"), /platform must be/, "an unknown platform is an error, not iOS");

// Why: `open reset:true` on Android clears the app's data with pm clear; the package name reaches a shell, so it is validated.
assert.deepEqual(androidResetArgs("emulator-5554", "com.example.my_app"), ["-s", "emulator-5554", "shell", "pm", "clear", "com.example.my_app"]);
assert.throws(() => androidResetArgs("emulator-5554", "com.example; rm -rf /"), /package name/);
assert.throws(() => androidResetArgs("emulator-5554", "noDots"), /package name/);
assert.throws(() => androidResetArgs(SIM, "com.example.app"), /emulator serial/);

// Why: `look` died on Android with "--pixel-density is currently supported only on iOS-family simulators". iOS shots are Retina
// and are shrunk to 1 px per point with that flag; an Android screenshot is already in the pixels agent-device taps in.
assert.deepEqual(screenshotArgs("ios", "/tmp/a.png"), ["screenshot", "/tmp/a.png", "--pixel-density", "1"], "iOS keeps its 1x shrink");
assert.deepEqual(screenshotArgs(undefined, "/tmp/a.png"), screenshotArgs("ios", "/tmp/a.png"));
assert.deepEqual(screenshotArgs("android", "/tmp/a.png"), ["screenshot", "/tmp/a.png"]);

// Why: sim-eyes thinks in points (a screenshot at 1 point per pixel, constants like the 20-point OCR tolerance, the model
// reading coordinates off the image: 1080x2400 px made the goal fallback fail with "400 Invalid image dimensions").
// Android reports pixels, so the density (dpi / 160) is the point size, and only the agent-device boundary converts back.
assert.equal(parseWmDensity("Physical density: 420\n"), 420);
assert.equal(parseWmDensity("Physical density: 420\nOverride density: 480\n"), 480, "an override wins: it is what the screen uses");
assert.throws(() => parseWmDensity("error: closed"), /density/);

const S = 2.625;
assert.deepEqual(scaleAdArgs(["press", "206", "244"], S), ["press", "541", "641"]);
assert.deepEqual(scaleAdArgs(["press", "206", "244", "--double-tap", "--settle"], S), ["press", "541", "641", "--double-tap", "--settle"], "flags are kept");
assert.deepEqual(scaleAdArgs(["swipe", "100", "200", "100", "600"], S), ["swipe", "263", "525", "263", "1575"]);
assert.deepEqual(scaleAdArgs(["gesture", "pinch", "2", "200", "300"], S), ["gesture", "pinch", "2", "525", "788"], "the centre is scaled, the zoom factor is not");
assert.deepEqual(scaleAdArgs(["gesture", "pinch", "0.5"], S), ["gesture", "pinch", "0.5"]);
const steps = [{ command: "press", input: { target: { kind: "point", x: 100, y: 200 } } }];
const batch = scaleAdArgs(["batch", "--steps", JSON.stringify(steps), "--on-error", "stop"], S);
assert.deepEqual(JSON.parse(batch[2]), [{ command: "press", input: { target: { kind: "point", x: 263, y: 525 } } }]);
assert.equal(batch[3], "--on-error");
const other = ["snapshot", "-i"];
assert.equal(scaleAdArgs(other, S), other, "commands without coordinates are untouched");
assert.equal(scaleAdArgs(["press", "206", "244"], 1)[1], "206", "scale 1 (iOS) changes nothing");
assert.deepEqual(scaleAdArgs(["gesture", "drag", "@e1", "@e2", "800", "900", "300"], S), ["gesture", "drag", "@e1", "@e2", "800", "900", "300"], "refs are not coordinates");

// Doctor and sim-pool must look in the same places for adb and the emulator.
const sets = (...paths) => (p) => paths.includes(p);
assert.deepEqual(
  findAndroidTools({ env: { ANDROID_HOME: "/sdk" }, home: "/h", exists: sets("/sdk/platform-tools/adb", "/sdk/emulator/emulator") }),
  { adb: "/sdk/platform-tools/adb", emulator: "/sdk/emulator/emulator" });
assert.deepEqual(
  findAndroidTools({ env: { PATH: "/usr/bin:/opt/bin" }, home: "/h", exists: sets("/opt/bin/adb") }),
  { adb: "/opt/bin/adb", emulator: null }, "PATH is searched, and a missing emulator is null");
assert.deepEqual(
  findAndroidTools({ env: {}, home: "/h", exists: sets("/h/Library/Android/sdk/platform-tools/adb", "/h/Library/Android/sdk/emulator/emulator") }),
  { adb: "/h/Library/Android/sdk/platform-tools/adb", emulator: "/h/Library/Android/sdk/emulator/emulator" }, "Android Studio's default SDK folder");
// A stale ANDROID_SDK_ROOT (command-line tools only, no emulator) must not hide the SDK that has it.
assert.equal(
  findAndroidTools({ env: { ANDROID_SDK_ROOT: "/stale" }, home: "/h", exists: sets("/h/Library/Android/sdk/emulator/emulator") }).emulator,
  "/h/Library/Android/sdk/emulator/emulator");
assert.equal(findAndroidTools({ env: { SIM_POOL_EMULATOR: "/mine/emulator" }, home: "/h", exists: sets("/mine/emulator", "/h/Library/Android/sdk/emulator/emulator") }).emulator, "/mine/emulator", "SIM_POOL_EMULATOR wins, like in sim-pool");

const dir = (map) => (d) => map[d] ?? null;
assert.deepEqual(listAvds({ env: {}, home: "/h", readdir: dir({ "/h/.android/avd": ["Pixel_8.ini", "Pixel_8.avd", "s4_qa.ini", "simpool-s4_qa-5556.ini", "simpool-s4_qa-5556.avd"] }) }), ["Pixel_8", "s4_qa"], "AVD names are the .ini names; pool clones are not AVDs");
assert.deepEqual(listAvds({ env: { ANDROID_AVD_HOME: "/custom" }, home: "/h", readdir: dir({ "/custom": ["x.ini"], "/h/.android/avd": ["y.ini"] }) }), ["x"], "ANDROID_AVD_HOME wins");
assert.deepEqual(listAvds({ env: {}, home: "/h", readdir: dir({}) }), [], "no folder, no AVDs");

console.log("test-platform: ok");
