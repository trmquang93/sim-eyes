/**
 * agent-device's client starts its daemon when it finds none. "Failed to start daemon" (`details.kind` `daemon_startup_failed`)
 * is raised before the command is sent, so the command never ran and a second try is safe for any command.
 */
const STARTUP_FAILED = "daemon_startup_failed";

function failureDetails(text) {
  try {
    return JSON.parse(text.trim())?.error?.details;
  } catch {
    return undefined;
  }
}

/** The error's `details` when it is a daemon startup failure (`{}` when only the text says so), otherwise null. Reads exec errors (stdout/stderr) and spawnAd errors (message). */
export function daemonStartupFailure(err) {
  for (const text of [err?.stdout, err?.stderr, err?.message]) {
    if (typeof text !== "string") continue;
    const details = failureDetails(text);
    if (details?.kind === STARTUP_FAILED) return details;
    if (/Failed to start daemon/.test(text)) return {};
  }
  return null;
}

/** Runs `run`, and once more after `delayMs` for each daemon startup failure up to `retries`; any other error is thrown at once because that command may already have run. */
export async function retryDaemonStartup(run, { retries = 1, delayMs = 500, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  for (let i = 0; ; i += 1) {
    try {
      return await run();
    } catch (err) {
      if (i >= retries || !daemonStartupFailure(err)) throw err;
      await sleep(delayMs);
    }
  }
}
