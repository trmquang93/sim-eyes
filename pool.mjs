import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

/** Exit 2 from sim-pool = no free simulator. */
export class PoolBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = "PoolBusyError";
    this.code = "SIM_POOL_BUSY";
  }
}

export function defaultInstanceId() {
  return `${process.pid}-${randomBytes(3).toString("hex")}`;
}

const VENDORED = join(dirname(fileURLToPath(import.meta.url)), "vendor", "sim-pool", "sim-pool");

/**
 * Which sim-pool to run: `SIM_POOL_BIN`, then the user's own skill, then the copy this package carries. The skill wins over
 * the vendored copy because both keep lease state in the same folder and may not be the same version. The vendored one
 * runs through python3: npm does not keep the exec bit.
 */
export function resolveSimPool({ env = process.env, home = homedir(), exists = existsSync, vendored = VENDORED } = {}) {
  const direct = (path, source) => ({ path, source, command: path, args: [] });
  if (env.SIM_POOL_BIN) return direct(env.SIM_POOL_BIN, "env");
  const skill = [".claude", ".agents", ".cursor"]
    .map((dir) => join(home, dir, "skills", "sim-pool", "scripts", "sim-pool"))
    .find((p) => exists(p));
  if (skill) return direct(skill, "skill");
  if (exists(vendored)) return { path: vendored, source: "vendored", command: "python3", args: [vendored] };
  return null;
}

export function findSimPoolBin(options) {
  return resolveSimPool(options)?.path ?? null;
}

const CLT_HINT = "sim-pool needs python3 from the Xcode Command Line Tools: run `xcode-select --install`, then retry.";

/**
 * Make sure the pool has a whitelist: the first time on a Mac, `sim-pool init` lists its iPhone simulators (it never
 * creates one). `init` keeps an existing config, so an empty whitelist is redone with --force (nothing to lose).
 */
export async function ensurePoolConfigured({ run, home = homedir(), env = process.env, readConfig = readJsonOrNull }) {
  const config = readConfig(join(env.AGENT_SIM_POOL_HOME ?? join(home, ".agent-sim-pool"), "config.json"));
  if (config?.devices?.length) return { initialized: false };
  const { code, stdout, stderr } = await run(config ? ["init", "--force"] : ["init"]);
  if (code !== 0) throw new Error(`sim-pool init failed: ${(stderr || stdout).trim() || `exit ${code}`}\n${CLT_HINT}`);
  const devices = Number(stdout.match(/devices=(\d+)/)?.[1] ?? 0);
  if (devices === 0) {
    throw new Error(
      "No iPhone simulator found for sim-pool to lease. Create one in Xcode (Window > Devices and Simulators), then retry."
    );
  }
  return { initialized: true, devices };
}

function readJsonOrNull(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

let poolReady = false;

function run(pool, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(pool.command, [...pool.args, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`sim-pool timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: `${pool.command}: ${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Parse KEY=value lines; never eval (EXPIRES_AT contains +HH:MM). */
export function parseAcquireOutput(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

/**
 * Lease a whitelist simulator. Returns { leaseId, udid, name, expiresAt, session }.
 * session is the agent-device session name for this MCP process.
 */
export async function acquireLease({
  instanceId,
  preferUdid,
  preferDevice,
  project = "sim-eyes",
  worktree,
  owner,
  ttl,
  timeout = 5,
} = {}) {
  const bin = resolveSimPool();
  if (!bin) {
    throw new Error(
      "sim-pool not found: this install is missing its vendored copy (vendor/sim-pool). Reinstall sim-eyes, " +
        "or install the sim-pool skill, or set SIM_POOL_BIN. Without a pool, parallel agents fight over one simulator."
    );
  }
  const session = `sim-eyes-${instanceId}`;
  const args = [
    "acquire",
    "--holder-pid",
    String(process.pid),
    "--owner",
    owner ?? `sim-eyes-${instanceId}`,
    "--project",
    project,
    "--session",
    session,
    "--timeout",
    String(timeout),
  ];
  if (worktree) args.push("--worktree", worktree);
  if (ttl) args.push("--ttl", String(ttl));
  if (preferUdid) args.push("--prefer-udid", preferUdid);

  if (!poolReady) {
    await ensurePoolConfigured({ run: (initArgs) => run(bin, initArgs, { timeoutMs: 60000 }) });
    poolReady = true;
  }
  const { code, stdout, stderr } = await run(bin, args);
  if (code === 2) {
    throw new PoolBusyError(
      (stderr || stdout).trim() ||
        "SIM_POOL_BUSY: every whitelisted simulator is leased. Wait, or report QA inconclusive."
    );
  }
  if (code !== 0) {
    throw new Error((stderr || stdout).trim() || `sim-pool acquire exit ${code}`);
  }
  const parsed = parseAcquireOutput(stdout);
  if (!parsed.LEASE_ID || !parsed.UDID) {
    throw new Error(`sim-pool acquire returned no LEASE_ID/UDID:\n${stdout}`);
  }
  // preferDevice is advisory only when prefer-udid wasn't used; pool picks any free.
  void preferDevice;
  return {
    leaseId: parsed.LEASE_ID,
    udid: parsed.UDID,
    name: parsed.SIMULATOR_NAME ?? preferDevice ?? parsed.UDID,
    expiresAt: parsed.EXPIRES_AT ?? "",
    session,
  };
}

export async function renewLease(leaseId) {
  const bin = resolveSimPool();
  if (!bin || !leaseId) return;
  const { code, stderr, stdout } = await run(bin, ["renew", "--lease", leaseId], {
    timeoutMs: 30000,
  });
  if (code !== 0) {
    throw new Error((stderr || stdout).trim() || "sim-pool renew failed (LEASE_GONE?)");
  }
}

export async function releaseLease(leaseId) {
  const bin = resolveSimPool();
  if (!bin || !leaseId) return;
  await run(bin, ["release", "--lease", leaseId], { timeoutMs: 30000 });
}

export async function poolStatusText() {
  const bin = resolveSimPool();
  if (!bin) return "sim-pool: not installed";
  const { stdout, stderr, code } = await run(bin, ["status"], { timeoutMs: 30000 });
  return code === 0 ? stdout.trim() : (stderr || stdout).trim();
}
