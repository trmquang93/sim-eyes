import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

export function findSimPoolBin() {
  if (process.env.SIM_POOL_BIN) return process.env.SIM_POOL_BIN;
  const candidates = [
    join(homedir(), ".claude", "skills", "sim-pool", "scripts", "sim-pool"),
    join(homedir(), ".agents", "skills", "sim-pool", "scripts", "sim-pool"),
    join(homedir(), ".cursor", "skills", "sim-pool", "scripts", "sim-pool"),
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

function run(bin, args, { timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
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
  const bin = findSimPoolBin();
  if (!bin) {
    throw new Error(
      "sim-pool not found. Install the sim-pool skill, or set SIM_POOL_BIN. " +
        "Without a pool, parallel agents fight over one simulator."
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
  const bin = findSimPoolBin();
  if (!bin || !leaseId) return;
  const { code, stderr, stdout } = await run(bin, ["renew", "--lease", leaseId], {
    timeoutMs: 30000,
  });
  if (code !== 0) {
    throw new Error((stderr || stdout).trim() || "sim-pool renew failed (LEASE_GONE?)");
  }
}

export async function releaseLease(leaseId) {
  const bin = findSimPoolBin();
  if (!bin || !leaseId) return;
  await run(bin, ["release", "--lease", leaseId], { timeoutMs: 30000 });
}

export async function poolStatusText() {
  const bin = findSimPoolBin();
  if (!bin) return "sim-pool: not installed";
  const { stdout, stderr, code } = await run(bin, ["status"], { timeoutMs: 30000 });
  return code === 0 ? stdout.trim() : (stderr || stdout).trim();
}
