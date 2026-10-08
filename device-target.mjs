const SIMULATOR_UDID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{12}$/;
const PHYSICAL_UDID = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}$/;

export const isPhysicalUdid = (value) => PHYSICAL_UDID.test(value ?? "");
/** agent-device takes `--udid` for either shape and `--device` for display names. */
export const isAnyUdid = (value) => SIMULATOR_UDID.test(value ?? "") || isPhysicalUdid(value);

const describe = (d) => `${d.name} (${d.id})`;

/**
 * Which phone `acquire target:"device"` binds, from `agent-device devices --json` rows. Never guesses between
 * several phones: a QA run on the wrong phone is worse than none.
 */
export function pickDevice(rows, { udid, name, connectedIds } = {}) {
  // agent-device lists an offline paired iPad as `booted`, so devicectl's connected set narrows the choice.
  const devices = rows.filter(
    (d) => d.platform === "ios" && d.kind === "device" && (!connectedIds || connectedIds.has(d.id))
  );
  if (udid && !isPhysicalUdid(udid)) {
    throw new Error(`${udid} is not a physical device UDID. Use target:"simulator" for simulators.`);
  }
  if (udid || name) {
    const hit = devices.find((d) => (udid ? d.id === udid : d.id === name || d.name === name));
    if (hit) return hit;
    const known = devices.map(describe).join(", ") || "none";
    throw new Error(`No connected device matches ${udid ?? name}. Devices: ${known}.`);
  }
  if (devices.length === 0) {
    throw new Error(
      "No physical iPhone/iPad found. Connect it by cable, unlock it, tap Trust, and turn on Developer Mode (Settings > Privacy & Security)."
    );
  }
  if (devices.length > 1) {
    throw new Error(
      `Several devices are listed: ${devices.map(describe).join(", ")}. Pass prefer_udid to choose one.`
    );
  }
  return devices[0];
}

/** Pixel size of a PNG from its header, so a device screenshot can be compared with the screen's point size. */
export function pngSize(buf) {
  if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Whether a screenshot is larger than the screen's points (a Retina device), and so must be shrunk to 1 px per point. */
export const needsDownscale = (png, points) =>
  !!points && (Math.abs(png.width - points.width) > 1 || Math.abs(png.height - points.height) > 1);

/** agent-device gives up after one runner restart per request; the phone's runner is usually healthy on the next call. */
export const isRunnerRestartFailure = (err) => /runner was already restarted/i.test(err?.message ?? "");
