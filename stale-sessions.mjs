/** sim-eyes names every agent-device session `sim-eyes-<pid>-<hex>-…` after the MCP process that owns it. */
const OWNER = /^sim-eyes-(\d+)-/;

export function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists, owned by someone else
  }
}

/**
 * Sessions left behind by sim-eyes processes that are gone (killed MCP, crashed client). They keep
 * holding their simulator (agent-device answers DEVICE_IN_USE) until someone closes them.
 */
export function staleSimEyesSessions(sessions, { selfPid = process.pid, isAlive = isPidAlive } = {}) {
  return sessions
    .map((s) => s?.name ?? "")
    .filter((name) => {
      const pid = Number(OWNER.exec(name)?.[1]);
      return pid > 0 && pid !== selfPid && !isAlive(pid);
    });
}
