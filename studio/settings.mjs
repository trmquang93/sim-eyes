/**
 * Studio's own settings, saved next to the tests (`<root>/.settings.json`, readable by the owner only). Today that is the
 * judge: which backend checks screenshots, chosen on the Settings page instead of by environment variables.
 *
 *   source "env"        what the environment says (judge-client.mjs): the default, so nothing changes until a tester picks
 *   source "openrouter" the key typed on the page
 *   source "hub"        the hub from the environment (TYPESAFE_BASE_URL + invite token in TYPESAFE_API_KEY)
 *   source "off"        no judge: every checkpoint is "unsure"
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const JUDGE_SOURCES = ["env", "openrouter", "hub", "off"];
export const settingsPath = (root) => join(root, ".settings.json");

export async function readSettings(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return { judge: normalizeJudge(parsed?.judge) };
  } catch {
    return { judge: normalizeJudge(null) };
  }
}

export async function writeSettings(path, settings) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, path);
}

function normalizeJudge(j) {
  const source = JUDGE_SOURCES.includes(j?.source) ? j.source : "env";
  const key = typeof j?.openrouterKey === "string" ? j.openrouterKey.trim() : "";
  return { source, ...(key ? { openrouterKey: key } : {}) };
}

/** True when the environment carries a hub address and an invite token, so "hub" can work. */
export const hubAvailable = (env) => Boolean(env.TYPESAFE_BASE_URL && env.TYPESAFE_API_KEY);

/** The environment `judgeClient` should read for these settings. */
export function judgeEnv(env, judge) {
  const out = { ...env };
  if (judge.source === "env") return out;
  delete out.OPENROUTER_API_KEY;
  delete out.SIM_EYES_JUDGE;
  if (judge.source === "openrouter") out.OPENROUTER_API_KEY = judge.openrouterKey ?? "";
  if (judge.source === "hub") out.SIM_EYES_JUDGE = "hub";
  return out;
}

/** What the Settings page shows. The key itself never leaves the server: only whether one is saved and its last four characters. */
export function describeJudge(env, judge) {
  const key = judge.openrouterKey ?? "";
  return { source: judge.source, keySaved: Boolean(key), keyHint: key ? key.slice(-4) : "", envKey: Boolean(env.OPENROUTER_API_KEY), hubAvailable: hubAvailable(env) };
}

/** The settings after a tester's change, or an Error (message for the tester) when it cannot work. */
export function applyJudgeChange(current, input, env) {
  const source = input?.source;
  if (!JUDGE_SOURCES.includes(source)) throw new Error(`The judge must be one of: ${JUDGE_SOURCES.join(", ")}.`);
  const typed = typeof input.openrouterKey === "string" ? input.openrouterKey.trim() : "";
  const key = input.clearKey ? "" : typed || current.openrouterKey || "";
  if (source === "openrouter" && !key) throw new Error("Paste an OpenRouter API key to use OpenRouter.");
  if (source === "hub" && !hubAvailable(env)) throw new Error("No hub is set up on this Mac: Studio has no invite token or hub address. Add your invite key first, or use an OpenRouter key.");
  return normalizeJudge({ source, openrouterKey: key });
}
