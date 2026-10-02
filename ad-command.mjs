/**
 * `SIM_EYES_AD` names the agent-device command: words split on spaces ("npx -y agent-device"), or a JSON array
 * (`["/path with spaces/node","/path/agent-device.mjs"]`) when a path holds a space, as in an app bundle.
 */
export function parseAdCommand(value) {
  const text = value.trim();
  if (text.startsWith("[")) {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((p) => typeof p === "string" && p)) {
      throw new Error("SIM_EYES_AD as JSON must be a non-empty array of strings.");
    }
    return parsed;
  }
  return text.split(" ").filter(Boolean);
}
