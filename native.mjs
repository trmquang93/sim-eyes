/**
 * Native input for exact steps. agent-device costs 1.5–5.7 s a tap or fill (its runner, then a settle wait); `axe`
 * (iOS simulator HID) and `adb input` (Android) cost 0.1–1.4 s. These build the commands for the agent-device
 * arguments sim-eyes already uses; anything not listed (double taps, text with quotes, real devices) returns null and
 * stays on agent-device.
 */

/** The default "simulator" tap (FBSimulator tapAt) does nothing on iOS 27 simulators; a physical touch down / up works everywhere. */
const TAP_STYLE = "physical";
const AXE_SELECT_ALL = "key-combo --modifiers 227 --key 4";
const AXE_RETURN_KEY = 40;
/** HID usage codes for `axe key`. */
const AXE_KEYS = { left: 80, right: 79, up: 82, down: 81, home: 74, end: 77, page_up: 75, page_down: 78, delete: 42, forward_delete: 76 };
const AXE_COMBOS = { select_all: "key-combo --modifiers 227 --key 4", undo: "key-combo --modifiers 227 --key 29", redo: "key-combo --modifiers 227,225 --key 29" };
const ADB_KEYS = { left: 21, right: 22, up: 19, down: 20, home: 122, end: 123, page_up: 92, page_down: 93, delete: 67, forward_delete: 112 };
/** Key names a `key` step accepts besides return and dismiss. */
export const EXTRA_KEYS = [...new Set([...Object.keys(AXE_KEYS), ...Object.keys(AXE_COMBOS)])];
/** Hardware buttons of a `button` step. */
export const BUTTONS = ["home", "lock", "siri", "side_button", "apple_pay"];
const ADB_BUTTONS = { home: 3, lock: 26 };
/** Text axe can be given on one step line without escaping surprises. */
const PLAIN_TEXT = /^[^'"\\\n\r]+$/;
const ADB_TEXT = /^[A-Za-z0-9 .,@_\-]+$/;
/** Seconds between the taps of one press_many. */
const TAP_GAP_S = 0.15;
const num = (v) => String(Math.round(Number(v)));
const flagFree = (args) => args.filter((a, i) => !(a === "--settle" || a === "--settle-quiet" || args[i - 1] === "--settle-quiet"));

/** The commands for an agent-device command (`args`, in points), or null when it stays on agent-device. `scale` is Android's points → pixels. */
export function nativeCommands(binding, args, { adb = "adb", axe = "axe" } = {}) {
  if (!binding || binding.kind === "device") return null;
  const [cmd, ...rest] = flagFree(args);
  if (binding.platform === "android") {
    const sh = [adb, ["-s", binding.udid, "shell", "input"]];
    const px = (v) => num(Number(v) * (binding.scale || 1));
    if (cmd === "press" && rest.length === 2) return [{ cmd: sh[0], args: [...sh[1], "tap", px(rest[0]), px(rest[1])] }];
    if (cmd === "press_many" && rest.length >= 4 && rest.length % 2 === 0) {
      const taps = [];
      for (let i = 0; i < rest.length; i += 2) taps.push(`input tap ${px(rest[i])} ${px(rest[i + 1])}`);
      return [{ cmd: adb, args: ["-s", binding.udid, "shell", taps.join("; sleep 0.15; ")] }];
    }
    if (cmd === "swipe" && rest.length === 4) return [{ cmd: sh[0], args: [...sh[1], "swipe", ...rest.map(px), "300"] }];
    if (cmd === "key" && ADB_KEYS[rest[0]]) return [{ cmd: sh[0], args: [...sh[1], "keyevent", String(ADB_KEYS[rest[0]])] }];
    if (cmd === "button" && ADB_BUTTONS[rest[0]]) return [{ cmd: sh[0], args: [...sh[1], "keyevent", String(ADB_BUTTONS[rest[0]])] }];
    if (cmd === "open_url" && rest[0]) return [{ cmd: adb, args: ["-s", binding.udid, "shell", "am", "start", "-a", "android.intent.action.VIEW", "-d", rest[0]] }];
    if (cmd === "back" && rest.length === 0) return [{ cmd: sh[0], args: [...sh[1], "keyevent", "4"] }];
    if (cmd === "keyboard" && rest[0] === "enter") return [{ cmd: sh[0], args: [...sh[1], "keyevent", "66"] }];
    // BACK closes an open keyboard (the caller asks for dismiss only while one is up); agent-device has no hide key on Android.
    if (cmd === "keyboard" && rest[0] === "dismiss") return [{ cmd: sh[0], args: [...sh[1], "keyevent", "4"] }];
    if (cmd === "fill" && rest.length === 3 && ADB_TEXT.test(rest[2])) {
      // Focus, clear what the field holds (move to the end, then delete), type: one adb shell call. ASCII only; other text stays on agent-device.
      const script = `input tap ${px(rest[0])} ${px(rest[1])}; input keyevent 123 ${"67 ".repeat(40).trim()}; input text '${rest[2].replace(/ /g, "%s")}'`;
      return [{ cmd: adb, args: ["-s", binding.udid, "shell", script] }];
    }
    return null;
  }
  if (binding.platform && binding.platform !== "ios") return null;
  const u = ["--udid", binding.udid];
  if (cmd === "press" && rest.length === 2) return [{ cmd: axe, args: ["tap", "-x", num(rest[0]), "-y", num(rest[1]), "--tap-style", TAP_STYLE, ...u] }];
  if (cmd === "press_many" && rest.length >= 4 && rest.length % 2 === 0) {
    // One HID session for the whole sequence, a short sleep between taps so the app takes each one.
    const steps = [];
    for (let i = 0; i < rest.length; i += 2) {
      if (i) steps.push("--step", `sleep ${TAP_GAP_S}`);
      steps.push("--step", `tap -x ${num(rest[i])} -y ${num(rest[i + 1])}`);
    }
    return [{ cmd: axe, args: ["batch", ...u, "--tap-style", TAP_STYLE, ...steps] }];
  }
  if (cmd === "swipe" && rest.length === 4) {
    const [a, b, c, d] = rest.map(num);
    return [{ cmd: axe, args: ["swipe", "--start-x", a, "--start-y", b, "--end-x", c, "--end-y", d, "--duration", "0.3", ...u] }];
  }
  if (cmd === "key" && AXE_KEYS[rest[0]]) return [{ cmd: axe, args: ["key", String(AXE_KEYS[rest[0]]), ...u] }];
  if (cmd === "key" && AXE_COMBOS[rest[0]]) return [{ cmd: axe, args: ["batch", ...u, "--step", AXE_COMBOS[rest[0]]] }];
  if (cmd === "button" && BUTTONS.includes(rest[0])) return [{ cmd: axe, args: ["button", rest[0].replace("_", "-"), ...u] }];
  if (cmd === "open_url" && rest[0]) return [{ cmd: "xcrun", args: ["simctl", "openurl", binding.udid, rest[0]] }];
  if (cmd === "keyboard" && rest[0] === "enter") return [{ cmd: axe, args: ["key", String(AXE_RETURN_KEY), ...u] }];
  if (cmd === "fill" && rest.length === 3 && PLAIN_TEXT.test(rest[2])) {
    // One HID session: focus the field, select what it holds, type over it.
    return [{ cmd: axe, args: ["batch", ...u, "--tap-style", TAP_STYLE, "--step", `tap -x ${num(rest[0])} -y ${num(rest[1])}`, "--step", AXE_SELECT_ALL, "--step", `type '${rest[2]}'`] }];
  }
  return null;
}

export const ANDROID_ASCII_TEXT = ADB_TEXT;
