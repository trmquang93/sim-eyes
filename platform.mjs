import { join } from "node:path";
import { isAnyUdid } from "./device-target.mjs";

/** Android emulators only: a physical Android phone is not supported, so its serial is refused, never driven. */
const ANDROID_SERIAL = /^emulator-\d+$/;
/** An Android application id: dotted segments, letters/digits/underscore. It reaches `adb shell`, so nothing else passes. */
const ANDROID_PACKAGE = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;

export const isAndroidSerial = (value) => ANDROID_SERIAL.test(value ?? "");

/** Callers that name no platform stay on iOS. */
export function normalizePlatform(value) {
  if (value === undefined || value === null || value === "") return "ios";
  if (value === "ios" || value === "android") return value;
  throw new Error(`platform must be "ios" or "android", got ${JSON.stringify(value)}.`);
}

/**
 * agent-device's platform and device selector for a binding. iOS takes `--udid` for either UDID shape and `--device` for
 * a display name; Android takes only `--serial` (agent-device rejects `--udid`/`--device` for it once a session is bound).
 */
export function adTargetArgs(platform, idOrName) {
  if (normalizePlatform(platform) === "android") {
    if (!isAndroidSerial(idOrName)) {
      throw new Error(`Android needs an emulator serial like emulator-5554, got ${JSON.stringify(idOrName ?? "")}.`);
    }
    return ["--platform", "android", "--serial", idOrName];
  }
  return ["--platform", "ios", ...(isAnyUdid(idOrName) ? ["--udid", idOrName] : ["--device", idOrName])];
}

/** adb arguments that empty an app's data (the Android counterpart of reinstalling the app on a simulator). */
export function androidResetArgs(serial, packageName) {
  if (!isAndroidSerial(serial)) throw new Error(`Android needs an emulator serial like emulator-5554, got ${JSON.stringify(serial ?? "")}.`);
  if (!ANDROID_PACKAGE.test(packageName ?? "")) {
    throw new Error("open reset:true needs the app's package name (for example com.example.app).");
  }
  return ["-s", serial, "shell", "pm", "clear", packageName];
}

/** agent-device's screenshot arguments. iOS shots are Retina and shrunk to 1 px per point; an Android shot is already in tap pixels, and agent-device refuses --pixel-density there. */
export function screenshotArgs(platform, path) {
  return normalizePlatform(platform) === "android" ? ["screenshot", path] : ["screenshot", path, "--pixel-density", "1"];
}

/** The density adb reports (`wm density`); an override is what the screen really uses, so it wins over the physical one. */
export function parseWmDensity(output) {
  const found = [...String(output).matchAll(/(Physical|Override) density:\s*(\d+)/g)];
  const pick = found.find((m) => m[1] === "Override") ?? found[0];
  if (!pick) throw new Error(`Could not read the screen density from adb: ${JSON.stringify(String(output).trim())}`);
  return Number(pick[2]);
}

const px = (v, scale) => String(Math.round(Number(v) * scale));

/**
 * sim-eyes works in points (one point = one dp on Android, pixels / (dpi / 160)); agent-device taps in pixels. This
 * converts the coordinates in an agent-device command from points to pixels. Refs, flags and zoom factors are kept.
 */
export function scaleAdArgs(args, scale) {
  if (!scale || scale === 1) return args;
  const [cmd, sub] = args;
  if (cmd === "press" && args.length >= 3) return [cmd, px(args[1], scale), px(args[2], scale), ...args.slice(3)];
  if (cmd === "swipe" && args.length >= 5) return [cmd, ...args.slice(1, 5).map((v) => px(v, scale)), ...args.slice(5)];
  if (cmd === "gesture" && sub === "pinch" && args.length >= 5) return [cmd, sub, args[2], px(args[3], scale), px(args[4], scale), ...args.slice(5)];
  if (cmd === "batch") {
    const at = args.indexOf("--steps");
    if (at < 0) return args;
    const steps = JSON.parse(args[at + 1]).map((step) => {
      const t = step.input?.target;
      return t?.kind === "point" ? { ...step, input: { ...step.input, target: { ...t, x: Math.round(t.x * scale), y: Math.round(t.y * scale) } } } : step;
    });
    return [...args.slice(0, at + 1), JSON.stringify(steps), ...args.slice(at + 2)];
  }
  return args;
}

/** Where sim-pool looks for adb and the emulator, so doctor and the pool agree. A stale SDK root does not hide a later one. */
export function findAndroidTools({ env, home, exists }) {
  const roots = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, join(home, "Library/Android/sdk"), "/opt/homebrew/share/android-commandlinetools"].filter(Boolean);
  const onPath = (name) => (env.PATH ?? "").split(":").filter(Boolean).map((d) => join(d, name));
  const find = (override, name, sub) => [override, ...onPath(name), ...roots.map((r) => join(r, sub, name))].filter(Boolean).find((p) => exists(p)) ?? null;
  return { adb: find(env.SIM_POOL_ADB, "adb", "platform-tools"), emulator: find(env.SIM_POOL_EMULATOR, "emulator", "emulator") };
}

/** AVD names: the `.ini` file names in the AVD folder (the `.avd` folder can be named differently). The pool's own clones are not AVDs. */
export function listAvds({ env, home, readdir }) {
  const dirs = [env.ANDROID_AVD_HOME, env.ANDROID_USER_HOME && join(env.ANDROID_USER_HOME, "avd"), join(home, ".android", "avd")].filter(Boolean);
  for (const dir of dirs) {
    const names = readdir(dir);
    if (names) return names.filter((n) => n.endsWith(".ini") && !n.startsWith("simpool-")).map((n) => n.slice(0, -4)).sort();
  }
  return [];
}
