/**
 * What a batch step costs the agent that reads it. Defaults are text-only and one line per step: the screen's
 * structure comes only from a `look` step or `controls:true`, an image only from a `screenshot` step or the batch's
 * `image:true`. When sim-eyes cannot get further, the reply names the leased device so the agent can drive it with
 * agent-device directly.
 */

/** A step the agent asked to see the screen structure for. */
export const wantsStructure = (tool, args) => tool === "look" || args.controls === true;

/** A step whose reply carries an image: the `screenshot` step, or the last step of a batch sent with image:true. */
export const wantsImage = (tool, last, image) => tool === "screenshot" || (last && image === true);

/** A step that needs a screenshot file: an image reply, or a file the agent asked for with save / path. */
export const needsShot = (tool, args, last, image) => wantsImage(tool, last, image) || !!args.save;

/** `path` is the name agents reach for first; it means `save`. */
export const withSavePath = (action) => (action.path && !action.save ? { ...action, save: action.path } : action);

/** The verdict lines of a summary: those that are not indented (a goal's log of sub-actions and notes are). */
const verdict = (text) => {
  const lines = String(text).split("\n");
  const kept = lines.filter((l) => !/^\s/.test(l));
  return (kept.length ? kept : lines.slice(0, 1)).join("\n");
};

/** A step that went fine is its verdict; a step that failed or asked for structure keeps what it said. */
export const stepSummary = (summary, { failed, structure }) => (failed || structure ? summary : verdict(summary));

/** The agent-device line for the leased device, or "" when nothing is leased. */
export function takeoverHint(binding, adVersion) {
  if (!binding) return "";
  const target = binding.platform === "android" ? `--platform android --serial ${binding.udid}` : `--platform ios --udid ${binding.udid}`;
  return `takeover: sim-eyes is stuck here. Drive the same device yourself with agent-device (keep the session, do not release): npx -y agent-device@${adVersion} <snapshot -i | screenshot <file> | press <x> <y> | fill <@ref> <text> | back> --session ${binding.session} ${target}`;
}

/**
 * The commands a `launch` step runs: stop the app (unless terminate:false), then start it with the launch arguments
 * (iOS simctl) or `am start` extras (Android, which needs the activity). `adb` is the adb binary. Throws on a bad step.
 */
export function launchCommands(binding, args, adb = "adb") {
  const id = String(args.id ?? args.name ?? "").trim();
  if (!id) throw new Error('launch needs id, the bundle id (iOS) or package id (Android), e.g. {"tool":"launch","id":"com.example.app","args":["-UseFake","1"]}.');
  const list = Array.isArray(args.args) ? args.args.map(String) : [];
  const stop = args.terminate !== false;
  if (binding.kind === "device") throw new Error("launch needs a simulator or emulator; on a real device use open.");
  if (binding.platform === "android") {
    const activity = String(args.activity ?? "").trim();
    const component = activity ? (activity.includes("/") ? activity : `${id}/${activity}`) : null;
    if (list.length && !component) throw new Error('launch with args on Android needs activity too, e.g. {"tool":"launch","id":"com.x","activity":"vn.x.MainActivity","args":["--es","UseFake","1"]}.');
    const sh = ["-s", binding.udid, "shell"];
    return {
      id,
      list,
      commands: [
        ...(stop ? [{ cmd: adb, args: [...sh, "am", "force-stop", id], optional: true }] : []),
        component ? { cmd: adb, args: [...sh, "am", "start", "-n", component, ...list] } : { cmd: adb, args: [...sh, "monkey", "-p", id, "-c", "android.intent.category.LAUNCHER", "1"] },
      ],
    };
  }
  return {
    id,
    list,
    commands: [
      ...(stop ? [{ cmd: "xcrun", args: ["simctl", "terminate", binding.udid, id], optional: true }] : []),
      { cmd: "xcrun", args: ["simctl", "launch", binding.udid, id, ...list] },
    ],
  };
}
