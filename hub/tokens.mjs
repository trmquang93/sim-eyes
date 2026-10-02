/**
 * Invite tokens for the hub. Only the SHA-256 of a token is stored, so a leaked tokens.json cannot sign anyone in.
 * CLI: node hub/tokens.mjs add <name> | revoke <name> | list  [--file data/tokens.json]
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const hashToken = (token) => createHash("sha256").update(String(token)).digest("hex");

async function load(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return { tokens: [] };
    throw err;
  }
}

async function save(file, data) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}

const validName = (name) => typeof name === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/.test(name);

/** Creates a token for `name` and returns it. This is the only time the raw token exists. */
export async function addToken(file, name, { now = () => new Date() } = {}) {
  if (!validName(name)) throw new Error("A name is 1-40 letters, numbers, dots, dashes or underscores.");
  const data = await load(file);
  if (data.tokens.some((t) => t.name === name && !t.revokedAt)) throw new Error(`"${name}" already has a token. Revoke it first.`);
  const token = `simeyes_${randomBytes(24).toString("base64url")}`;
  data.tokens.push({ name, sha256: hashToken(token), createdAt: now().toISOString(), revokedAt: null });
  await save(file, data);
  return token;
}

export async function revokeToken(file, name, { now = () => new Date() } = {}) {
  const data = await load(file);
  const live = data.tokens.filter((t) => t.name === name && !t.revokedAt);
  if (!live.length) throw new Error(`No active token for "${name}".`);
  for (const t of live) t.revokedAt = now().toISOString();
  await save(file, data);
}

export async function listTokens(file) {
  return (await load(file)).tokens.map(({ name, createdAt, revokedAt }) => ({ name, createdAt, revokedAt }));
}

/** The name behind a raw token, or null for an unknown or revoked one. */
export async function findToken(file, raw) {
  if (typeof raw !== "string" || !raw) return null;
  const want = Buffer.from(hashToken(raw), "hex");
  let found = null;
  for (const t of (await load(file)).tokens) {
    const same = timingSafeEqual(want, Buffer.from(t.sha256, "hex"));
    if (same && !t.revokedAt) found = t.name;
  }
  return found;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const at = args.indexOf("--file");
  const file = at >= 0 ? args.splice(at, 2)[1] : "data/tokens.json";
  const [command, name] = args;
  try {
    if (command === "add") {
      console.log(`Token for ${name} (shown once, send it to them privately):\n${await addToken(file, name)}`);
    } else if (command === "revoke") {
      await revokeToken(file, name);
      console.log(`Revoked ${name}.`);
    } else if (command === "list") {
      for (const t of await listTokens(file)) console.log(`${t.name}\tcreated ${t.createdAt}${t.revokedAt ? `\trevoked ${t.revokedAt}` : ""}`);
    } else {
      console.error("Usage: node hub/tokens.mjs add <name> | revoke <name> | list [--file path]");
      process.exit(2);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
