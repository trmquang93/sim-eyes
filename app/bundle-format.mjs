/** What the release script and the app's updater both need to agree on: the signed bytes, the dependency hash, and which paths a bundle may write. */
import { createHash } from "node:crypto";

export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** The manifest fields the signature covers, in a fixed order. Anything that decides what runs must be in here. */
export const SIGNED_FIELDS = ["bundleSha256", "depsHash", "minAppVersion", "publishedAt", "version"];

export const canonicalManifest = (manifest) => JSON.stringify(Object.fromEntries(SIGNED_FIELDS.map((k) => [k, manifest[k]])));

/** The pieces that live in the app and not in a bundle (node_modules, agent-device). A bundle built for other ones is refused. */
export const depsHash = (dependencies, agentDevice) => sha256(JSON.stringify({ dependencies: Object.fromEntries(Object.entries(dependencies ?? {}).sort()), agentDevice }));

export const SEMVER = /^\d+\.\d+\.\d+$/;

/** -1, 0 or 1. Both arguments must be x.y.z. */
export function compareVersions(a, b) {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

/**
 * A bundle holds the code folder only: top-level `.mjs`, `ocr.swift`, `package.json`, `VERSION`, and `studio/**`.
 * No `..`, no absolute paths, no empty segments, so nothing can land outside the bundle's own folder.
 */
export function isSafeBundlePath(path) {
  if (typeof path !== "string" || path.length > 200) return false;
  const parts = path.split("/");
  if (parts.length > 3 || !parts.every((p) => SEGMENT.test(p) && p !== "." && p !== "..")) return false;
  if (parts.length === 1) return /\.mjs$/.test(path) || ["ocr.swift", "package.json", "VERSION"].includes(path);
  return parts[0] === "studio";
}

export const MODES = new Set(["0644", "0755"]);
