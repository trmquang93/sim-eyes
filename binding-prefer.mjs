/** Whether acquire asked for a different simulator than the current binding. */
export function preferDiffersFromBinding(binding, { preferUdid, preferDevice } = {}) {
  if (!binding) return false;
  const udid = preferUdid?.trim();
  const device = preferDevice?.trim();
  if (udid) return binding.udid !== udid;
  if (device) return binding.name !== device && binding.udid !== device;
  return false;
}

export const SESSION_ID_RULE =
  "Each chat keeps its own session_id (returned on first acquire/batch). Pass that session_id on every tool call so this MCP process can keep separate simulator leases per chat. Do not configure UDIDs in mcp.json — sim-pool assigns a free device per new session_id.";
