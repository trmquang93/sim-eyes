/**
 * Small decisions behind the per-step cost of exact steps, kept pure (clocks are arguments) so tests can pin them.
 */

/** A lease is renewed at most this often, whatever its TTL. */
export const RENEW_MAX_INTERVAL_MS = 60000;
/** A tree read within this long of an input is read again until two reads agree. */
export const SETTLE_WINDOW_MS = 700;

/** Renew a sim-pool lease only when the last renew is older than a third of the TTL (never over a minute). `ttlMs` is the lease TTL; unknown means the pool default of 15 minutes. */
export function shouldRenew(now, lastRenewAt, ttlMs = 15 * 60000) {
  if (lastRenewAt == null) return true;
  return now - lastRenewAt >= Math.min(ttlMs / 3, RENEW_MAX_INTERVAL_MS);
}

/** True when the tree was read so soon after an input that the screen may still be moving. */
export function needsSecondRead({ sinceInputMs }) {
  return sinceInputMs < SETTLE_WINDOW_MS;
}

/** Text this long, or with quotes or non-ASCII, goes through the pasteboard; short plain text is typed. */
export const PASTE_MIN_LENGTH = 40;
export function pastePlan(text) {
  const s = String(text);
  return s.length >= PASTE_MIN_LENGTH || /['"\\\n\r]/.test(s) || /[^\x20-\x7e]/.test(s) ? "paste" : "type";
}
