/**
 * The model behind Studio's judge: the only call in sim-eyes that sends a screenshot. It is Perplexity's pplx-decider on
 * OpenRouter's decisions endpoint (`POST /api/alpha/decisions`), chosen by `studio/eval-judge.mjs` on the 44 labelled
 * cases. `goal` and Studio's line mapping never come here: they stay on TypeSafe (act.mjs).
 *
 * The request is the TypeSafe one (`state`, `questions`) plus `images` as raw base64. OpenRouter ignores a top-level
 * `images` field without an error, so the pictures go inside `state` as content parts instead.
 *
 * Where it is called from, by env (the model is fixed; no setting changes it):
 *   OPENROUTER_API_KEY  direct to OpenRouter with your own key
 *   SIM_EYES_JUDGE=hub  through the hub's /judge route, with TYPESAFE_BASE_URL (`https://<hub>/typesafe`) and the invite
 *                       token in TYPESAFE_API_KEY; the OpenRouter key stays on the hub
 * With neither there is no judge and every checkpoint is "unsure".
 */
export const JUDGE_MODEL = "perplexity/pplx-decider-v1-27b";
export const OPENROUTER_URL = "https://openrouter.ai/api/alpha";
/** A call takes about a second; this only ends one that hangs. */
export const JUDGE_TIMEOUT_MS = 60_000;
const MAX_QUESTIONS = 64;

export class JudgeError extends Error {
  constructor(message, { status } = {}) {
    super(message);
    this.name = "JudgeError";
    this.status = status;
  }
}

/** Where the judge is and how to reach it, or null when this Mac is not set up for one. */
export function judgeConfig(env = process.env) {
  if (env.OPENROUTER_API_KEY) return { baseURL: OPENROUTER_URL, apiKey: env.OPENROUTER_API_KEY, via: "OpenRouter" };
  if (String(env.SIM_EYES_JUDGE ?? "").trim().toLowerCase() === "hub" && env.TYPESAFE_BASE_URL && env.TYPESAFE_API_KEY) {
    const hub = String(env.TYPESAFE_BASE_URL).replace(/\/+$/, "").replace(/\/typesafe$/, "");
    return { baseURL: `${hub}/judge`, apiKey: env.TYPESAFE_API_KEY, via: "the hub" };
  }
  return null;
}

/** The media type of a base64 picture from its first bytes (the judge sends JPEG; PNG and WebP are accepted too). */
const mimeOf = (base64) => (base64.startsWith("iVBOR") ? "image/png" : base64.startsWith("UklGR") ? "image/webp" : "image/jpeg");

/** The request body: `state` becomes text plus one `image_url` part per picture. */
export function decisionsBody(request) {
  const images = request.images ?? [];
  const text = typeof request.state === "string" ? request.state : JSON.stringify(request.state);
  const state = images.length ? [{ type: "text", text }, ...images.map((b64) => ({ type: "image_url", image_url: { url: `data:${mimeOf(b64)};base64,${b64}` } }))] : request.state;
  return { model: JUDGE_MODEL, state, questions: request.questions };
}

/** A client with `systemOne(request)` that answers like the TypeSafe SDK. `fetch` is injectable for tests. */
export function judgeClient({ env = process.env, fetch = globalThis.fetch, timeoutMs = JUDGE_TIMEOUT_MS } = {}) {
  const config = judgeConfig(env);
  if (!config) return null;
  return {
    backend: "openrouter",
    model: JUDGE_MODEL,
    async systemOne(request) {
      const names = Object.keys(request?.questions ?? {});
      if (!names.length || names.length > MAX_QUESTIONS) throw new JudgeError(`A request needs 1 to ${MAX_QUESTIONS} questions, not ${names.length}.`);
      let response;
      try {
        response = await fetch(`${config.baseURL}/decisions`, {
          method: "POST",
          headers: { authorization: `Bearer ${config.apiKey}`, "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify(decisionsBody(request)),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        const why = err.name === "TimeoutError" ? `no answer in ${Math.round(timeoutMs / 1000)} s` : "connection failed";
        throw new JudgeError(`The judge is unreachable through ${config.via} (${why}).`);
      }
      const text = await response.text();
      let body;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }
      if (!response.ok) throw new JudgeError(`The judge answered ${response.status}: ${String(body?.error?.message ?? body?.error ?? text).slice(0, 200)}`, { status: response.status });
      if (!body?.answers) throw new JudgeError("The judge answered without answers.", { status: response.status });
      return body;
    },
  };
}
