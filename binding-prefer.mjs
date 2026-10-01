/** Whether acquire asked for a different simulator than the current binding. */
export function preferDiffersFromBinding(binding, { preferUdid, preferDevice } = {}) {
  if (!binding) return false;
  const udid = preferUdid?.trim();
  const device = preferDevice?.trim();
  if (udid) return binding.udid !== udid;
  if (device) return binding.name !== device && binding.udid !== device;
  return false;
}

/** Whether sim-pool gave the simulator that was asked for: by UDID when there is one, else by display name. */
export function preferHonored(granted, { udid, name } = {}) {
  if (udid) return granted.udid === udid;
  if (name) return granted.name === name;
  return true;
}

export const SESSION_ID_RULE =
  "Each chat keeps its own session_id (returned on first acquire/batch). Pass that session_id on every tool call so this MCP process can keep separate simulator leases per chat. Do not configure UDIDs in mcp.json — sim-pool assigns a free device per new session_id.";
