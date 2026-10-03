/** The TypeSafe relay: what may pass, how often, and what is sent upstream. Pure functions plus one `forward` that takes `fetch`. */

/** The only call sim-eyes makes (act.mjs and studio/map-line.mjs use `client.systemOne`). Found with the SDK against a fake server. */
export const ALLOWED = new Set(["POST /v1/systemone"]);

/** Response headers worth passing back; the SDK reads the request id and honours Retry-After. */
const PASS_BACK = ["content-type", "x-typesafe-request-id", "retry-after"];

export const isAllowed = (method, path) => ALLOWED.has(`${method} ${path}`);

/** The judge relay: one call (OpenRouter's decisions endpoint), always to one model. Same as studio/judge-client.mjs. */
export const JUDGE_ALLOWED = new Set(["POST /decisions"]);
export const JUDGE_MODEL = "perplexity/pplx-decider-v1-27b";
export const isJudgeAllowed = (method, path) => JUDGE_ALLOWED.has(`${method} ${path}`);

/** `body` with its model set to the judge model, so an invite token cannot spend the hub's credit on a dearer model. Null when it is not a JSON object. */
export function pinJudgeModel(body) {
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return Buffer.from(JSON.stringify({ ...parsed, model: JUDGE_MODEL }));
  } catch {
    return null;
  }
}

/** `take(name)` -> { ok: true } or { ok: false, retryAfter } in seconds. Per name: `perMinute` in a sliding minute and `perDay` per UTC day. */
export function createRateLimiter({ perMinute = 60, perDay = 3000, now = Date.now } = {}) {
  const recent = new Map();
  const daily = new Map();
  return {
    take(name) {
      const t = now();
      const day = new Date(t).toISOString().slice(0, 10);
      const stamps = (recent.get(name) ?? []).filter((s) => t - s < 60_000);
      const used = daily.get(name);
      const today = used?.day === day ? used.count : 0;
      if (stamps.length >= perMinute) return { ok: false, retryAfter: Math.max(1, Math.ceil((60_000 - (t - stamps[0])) / 1000)) };
      if (today >= perDay) return { ok: false, retryAfter: Math.max(1, Math.ceil((Date.parse(`${day}T00:00:00Z`) + 86_400_000 - t) / 1000)) };
      stamps.push(t);
      recent.set(name, stamps);
      daily.set(name, { day, count: today + 1 });
      return { ok: true };
    },
  };
}

/** Sends `body` to the upstream with the real key. Nothing from the client's headers is copied; the tester's token never leaves the hub. */
export async function forward({ path, body, upstream, key, fetch, timeoutMs = 30_000, service = "TypeSafe" }) {
  let response;
  try {
    response = await fetch(`${upstream.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json", accept: "application/json" },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { status: 502, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: `${service} is unreachable: ${err.name === "TimeoutError" ? "timed out" : "connection failed"}` })) };
  }
  const headers = {};
  for (const name of PASS_BACK) if (response.headers.get(name)) headers[name] = response.headers.get(name);
  return { status: response.status, headers, body: Buffer.from(await response.arrayBuffer()) };
}
