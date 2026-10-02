import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

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

const BREW_PATHS = ["/opt/homebrew/bin/agent-device", "/usr/local/bin/agent-device"];

/**
 * The agent-device command: `SIM_EYES_AD`, then the pinned dependency this package installed (run with this Node), then
 * a Homebrew install, then `fallback()` (PATH or npx). The first one that exists wins; dependencies are injected so
 * each branch can be made to fail.
 */
export function resolveAdCommand({ env, exists, resolveDep, readJson, nodePath = process.execPath, fallback }) {
  if (env.SIM_EYES_AD) return parseAdCommand(env.SIM_EYES_AD);
  try {
    const pkgPath = resolveDep("agent-device");
    const { bin } = readJson(pkgPath);
    const file = typeof bin === "string" ? bin : bin?.["agent-device"];
    if (file) return [nodePath, join(dirname(pkgPath), file)];
  } catch {
    /* not installed as a dependency (a checkout without it): use the user's own install */
  }
  const brew = BREW_PATHS.find((p) => exists(p));
  return brew ? [brew] : fallback();
}

/**
 * Path of an installed package's package.json, searched like Node searches modules. `require.resolve("<pkg>/package.json")`
 * is no use: agent-device's `exports` does not list it.
 */
export function findPackageJson(name, { paths = createRequire(import.meta.url).resolve.paths(name) ?? [], exists = existsSync } = {}) {
  const found = paths.map((dir) => join(dir, name, "package.json")).find((p) => exists(p));
  if (!found) throw new Error(`${name} is not installed`);
  return found;
}

/** `resolveAdCommand` against the real machine. */
export const adCommandFromHost = (fallback) =>
  resolveAdCommand({ env: process.env, exists: existsSync, resolveDep: findPackageJson, readJson: (p) => JSON.parse(readFileSync(p, "utf8")), fallback });
