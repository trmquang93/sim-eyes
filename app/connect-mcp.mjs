// Registers the app's MCP command (a stable path to the app binary) in the AI tools on this Mac.
// Lives in the app's Resources, outside any downloadable bundle: code that edits other apps' files must not arrive through an update.
// Every function takes its file system, exec and home folder, so tests never touch the real ones.
//   node connect-mcp.mjs detect|plan|apply|remove [--client C] [--command PATH] [--replace]   (one JSON line on stdout)
import { execFile } from "node:child_process";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const SERVER_NAME = "sim-eyes";
export const CLIENTS = ["claude-code", "cursor", "claude-desktop"];
export const STABLE_PATH_PARTS = [".local", "sim-eyes", "bin", "sim-eyes-mcp"];
export const stablePath = (home) => join(home, ...STABLE_PATH_PARTS);

const CLAUDE_CANDIDATES = (home) => [join(home, ".local/bin/claude"), join(home, ".claude/local/claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];

const JSON_CLIENTS = {
  cursor: (home) => join(home, ".cursor", "mcp.json"),
  "claude-desktop": (home) => join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json"),
};
const claudeCodeConfig = (home) => join(home, ".claude.json");

export const realDeps = () => ({
  home: homedir(),
  fs: { readFile: (p) => readFile(p, "utf8"), writeFile, rename, mkdir, exists: (p) => access(p).then(() => true, () => false) },
  exec: (file, args) => new Promise((resolve) => execFile(file, args, { timeout: 30000 }, (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }))),
});

class InvalidConfig extends Error {}

/** Parses a client's JSON config; a missing file is an empty one, a broken one is an error and is never rewritten. */
async function readConfig(fs, path) {
  if (!(await fs.exists(path))) return { exists: false, data: {} };
  const text = await fs.readFile(path);
  if (!text.trim()) return { exists: true, data: {} };
  let data;
  try { data = JSON.parse(text); } catch (err) { throw new InvalidConfig(`${path} is not valid JSON (${err.message}). Fix it, then try again. Nothing was changed.`); }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new InvalidConfig(`${path} is not a JSON object. Nothing was changed.`);
  return { exists: true, data };
}

const entryOf = (data) => (data.mcpServers && typeof data.mcpServers === "object" ? data.mcpServers[SERVER_NAME] ?? null : null);

async function findClaude({ fs, home }) {
  for (const path of CLAUDE_CANDIDATES(home)) if (await fs.exists(path)) return path;
  return null;
}

function configPathOf(client, home) {
  if (client === "claude-code") return claudeCodeConfig(home);
  if (JSON_CLIENTS[client]) return JSON_CLIENTS[client](home);
  throw new Error(`Unknown client "${client}". Use one of: ${CLIENTS.join(", ")}.`);
}

export async function detect(deps) {
  const { fs, home } = deps;
  const out = [];
  for (const client of CLIENTS) {
    const configPath = configPathOf(client, home);
    let installed;
    if (client === "claude-code") installed = Boolean(await findClaude(deps)) || (await fs.exists(configPath));
    else if (client === "cursor") installed = await fs.exists(join(home, ".cursor"));
    else installed = await fs.exists(dirname(configPath));
    let current = null;
    if (installed) {
      try { current = entryOf((await readConfig(fs, configPath)).data); } catch { current = null; }
    }
    out.push({ client, installed, configPath, current });
  }
  return out;
}

const sameEntry = (entry, command) => Boolean(entry) && entry.command === command && (entry.args ?? []).length === 0;

export async function plan({ client, command, ...deps }) {
  const { fs, home } = deps;
  const configPath = configPathOf(client, home);
  let config;
  try { config = await readConfig(fs, configPath); } catch (err) {
    if (err instanceof InvalidConfig) return { client, action: "invalid-config", reason: err.message, configPath };
    throw err;
  }
  const before = entryOf(config.data);
  const after = { command };
  const action = !before ? "add" : sameEntry(before, command) ? "unchanged" : "replace";
  const claudePath = client === "claude-code" ? await findClaude(deps) : null;
  return { client, action, before, after, configPath, willBackup: client !== "claude-code" && config.exists && action !== "unchanged", manualCommand: client === "claude-code" ? `claude mcp add --scope user ${SERVER_NAME} -- ${command}` : undefined, claudeFound: client === "claude-code" ? Boolean(claudePath) : undefined };
}

/** Temp file, then rename: a failure in between leaves the original file as it was. */
async function writeAtomic(fs, path, text) {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.sim-eyes.tmp`;
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, path);
}

async function backupOnce(fs, path) {
  const bak = `${path}.sim-eyes.bak`;
  if (!(await fs.exists(path)) || (await fs.exists(bak))) return;
  await fs.writeFile(bak, await fs.readFile(path));
}

export async function apply({ client, command, replace = false, ...deps }) {
  const { fs, exec, home } = deps;
  const p = await plan({ client, command, ...deps });
  if (p.action === "invalid-config") return { status: "invalid-config", reason: p.reason, configPath: p.configPath };
  if (p.action === "unchanged") return { status: "ok", changed: false, configPath: p.configPath };
  if (p.action === "replace" && !replace) return { status: "needs-replace", before: p.before, configPath: p.configPath };

  if (client === "claude-code") {
    const claude = await findClaude(deps);
    if (!claude) return { status: "claude-not-found", manualCommand: p.manualCommand };
    if (p.action === "replace") {
      const removed = await exec(claude, ["mcp", "remove", "--scope", "user", SERVER_NAME]);
      if (removed.code !== 0) return { status: "failed", reason: (removed.stderr || removed.stdout || "claude mcp remove failed").trim(), manualCommand: p.manualCommand };
    }
    // A replaced entry's env (API key, real-device signing ids) is the user's: keep it.
    const envFlags = Object.entries(p.before?.env ?? {}).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const added = await exec(claude, ["mcp", "add", "--scope", "user", ...envFlags, SERVER_NAME, "--", command]);
    if (added.code !== 0) return { status: "failed", reason: (added.stderr || added.stdout || "claude mcp add failed").trim(), manualCommand: p.manualCommand };
    return { status: "ok", changed: true, configPath: p.configPath };
  }

  const config = await readConfig(fs, p.configPath);
  await backupOnce(fs, p.configPath);
  const keepEnv = p.before?.env ? { env: p.before.env } : {};
  const next = { ...config.data, mcpServers: { ...(config.data.mcpServers ?? {}), [SERVER_NAME]: { command, ...keepEnv } } };
  await writeAtomic(fs, p.configPath, `${JSON.stringify(next, null, 2)}\n`);
  return { status: "ok", changed: true, configPath: p.configPath, backup: config.exists ? `${p.configPath}.sim-eyes.bak` : null };
}

export async function remove({ client, ...deps }) {
  const { fs, exec, home } = deps;
  const configPath = configPathOf(client, home);
  if (client === "claude-code") {
    const claude = await findClaude(deps);
    if (!claude) return { status: "claude-not-found", manualCommand: `claude mcp remove --scope user ${SERVER_NAME}` };
    const config = await readConfig(fs, configPath).catch(() => ({ data: {} }));
    if (!entryOf(config.data)) return { status: "ok", changed: false };
    const removed = await exec(claude, ["mcp", "remove", "--scope", "user", SERVER_NAME]);
    return removed.code === 0 ? { status: "ok", changed: true } : { status: "failed", reason: (removed.stderr || removed.stdout).trim() };
  }
  let config;
  try { config = await readConfig(fs, configPath); } catch (err) {
    if (err instanceof InvalidConfig) return { status: "invalid-config", reason: err.message, configPath };
    throw err;
  }
  if (!entryOf(config.data)) return { status: "ok", changed: false };
  const { [SERVER_NAME]: _gone, ...others } = config.data.mcpServers;
  await writeAtomic(fs, configPath, `${JSON.stringify({ ...config.data, mcpServers: others }, null, 2)}\n`);
  return { status: "ok", changed: true, configPath };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(3);
  const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  const out = (value) => console.log(JSON.stringify(value));
  try {
    const deps = realDeps();
    const command = arg("--command") ?? stablePath(deps.home);
    const client = arg("--client");
    switch (process.argv[2]) {
      case "detect": out(await detect(deps)); break;
      case "plan": out(await plan({ client, command, ...deps })); break;
      case "apply": out(await apply({ client, command, replace: args.includes("--replace"), ...deps })); break;
      case "remove": out(await remove({ client, ...deps })); break;
      default: console.error("Usage: connect-mcp.mjs detect|plan|apply|remove [--client C] [--command PATH] [--replace]"); process.exit(2);
    }
  } catch (err) {
    out({ status: "error", reason: err.message });
    process.exit(1);
  }
}
