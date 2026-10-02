// `sim-eyes doctor`: read-only check of what sim-eyes needs on this Mac, one line per prerequisite with a fix.
// It changes nothing, and it never runs python3 before the Command Line Tools are known to be there (on a bare Mac
// /usr/bin/python3 opens an installer dialog).
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { adCommandFromHost } from "./ad-command.mjs";
import { ocrForDoctor } from "./ocr.mjs";
import { resolveSimPool } from "./pool.mjs";

const MIN_NODE = [22, 12];
const result = (id, status, detail, fix = "") => ({ id, status, detail, fix });
const ok = (id, detail) => result(id, "pass", detail);
const warn = (id, detail, fix) => result(id, "warn", detail, fix);
const fail = (id, detail, fix) => result(id, "fail", detail, fix);

/**
 * Every check, in order. `exec(cmd, args)` resolves `{ code, stdout, stderr }` and never rejects; the rest is what the
 * checks look at, passed in so each branch can be made to fail.
 */
export async function runDoctor({ platform, nodeVersion, env, exec, pool, poolConfigExists, adCommand, adPin, ocr }) {
  const results = [];

  results.push(
    platform === "darwin"
      ? ok("macos", "macOS")
      : fail("macos", `${platform}: iOS simulators exist only on macOS`, "Run sim-eyes on a Mac with Xcode.")
  );

  const [major, minor] = nodeVersion.split(".").map(Number);
  results.push(
    major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1])
      ? ok("node", `Node ${nodeVersion}`)
      : fail("node", `Node ${nodeVersion} is older than ${MIN_NODE.join(".")}`, "Install Node 22.12 or newer (https://nodejs.org).")
  );

  const clt = await exec("xcode-select", ["-p"]);
  const cltOk = clt.code === 0;
  results.push(
    cltOk
      ? ok("xcode-clt", clt.stdout.trim())
      : fail("xcode-clt", "Xcode command line tools not found", "Install Xcode from the App Store and open it once, or run: xcode-select --install")
  );

  const sims = await exec("xcrun", ["simctl", "list", "devices", "available", "-j"]);
  let iphones = 0;
  try {
    iphones = Object.values(JSON.parse(sims.stdout).devices ?? {}).flat().filter((d) => d.name?.startsWith("iPhone") && d.isAvailable !== false).length;
  } catch {
    /* simctl failed: counted as none */
  }
  results.push(
    iphones > 0
      ? ok("simulator", `${iphones} iPhone simulator${iphones === 1 ? "" : "s"} available`)
      : fail("simulator", "no iPhone simulator available", "In Xcode, open Window > Devices and Simulators and add an iPhone simulator.")
  );

  if (!cltOk) {
    results.push(fail("python3", "not checked: needs the Xcode command line tools first", "Install the command line tools (see xcode-clt)."));
  } else {
    const py = await exec("python3", ["--version"]);
    results.push(
      py.code === 0
        ? ok("python3", (py.stdout || py.stderr).trim())
        : fail("python3", "python3 does not run", "Run: xcode-select --install (sim-pool is a Python script).")
    );
  }

  if (!pool) {
    results.push(fail("sim-pool", "not found", "Reinstall sim-eyes (it carries a copy in vendor/sim-pool), or install the sim-pool skill, or set SIM_POOL_BIN."));
  } else if (!cltOk) {
    results.push(fail("sim-pool", "not checked: it is a Python script and needs the command line tools first", "Install the command line tools (see xcode-clt)."));
  } else if (!poolConfigExists) {
    results.push(warn("sim-pool", `${pool.source} copy; the simulator whitelist is created on the first acquire`, ""));
  } else {
    const status = await exec(pool.command, [...pool.args, "status"]);
    const devices = status.stdout.match(/devices_whitelisted=(\d+)/)?.[1];
    results.push(
      status.code === 0 && devices !== undefined
        ? ok("sim-pool", `${pool.source} copy; ${devices} simulator${devices === "1" ? "" : "s"} whitelisted`)
        : fail("sim-pool", `${pool.path}: status failed: ${(status.stderr || status.stdout).trim().split("\n")[0]}`, "Run the pool's status command by hand to see the error.")
    );
  }

  const ad = await exec(adCommand[0], [...adCommand.slice(1), "--version"]);
  const adVersion = ad.stdout.trim();
  if (ad.code !== 0) {
    results.push(fail("agent-device", `${adCommand.join(" ")} does not run`, "Reinstall sim-eyes, or set SIM_EYES_AD to a working agent-device."));
  } else {
    results.push(
      adVersion === adPin
        ? ok("agent-device", `${adVersion} (pinned)`)
        : warn("agent-device", `${adVersion}, sim-eyes is tested with ${adPin}`, "Remove SIM_EYES_AD or a global agent-device to use the pinned copy.")
    );
  }

  if (ocr.trusted()) {
    const run = await ocr.run();
    results.push(run.code === 0 ? ok("ocr", "prebuilt helper runs") : fail("ocr", `prebuilt helper does not run: ${run.stderr.trim()}`, "Reinstall sim-eyes; if it persists run: xattr -dr com.apple.quarantine on the package."));
  } else if (ocr.compiled()) {
    results.push(ok("ocr", "compiled helper found"));
  } else {
    results.push(warn("ocr", "no prebuilt helper: it is compiled on first use (about 30 s, needs the command line tools)", ""));
  }

  const ffmpeg = await exec("ffmpeg", ["-version"]);
  results.push(
    ffmpeg.code === 0
      ? ok("ffmpeg", "found")
      : warn("ffmpeg", "not found: only `record` stop needs it", "Install it with: brew install ffmpeg")
  );

  results.push(
    env.TYPESAFE_API_KEY
      ? ok("typesafe", `TYPESAFE_API_KEY is set${env.TYPESAFE_BASE_URL ? " (through a hub)" : ""}`)
      : warn(
          "typesafe",
          "not set: the `goal` step is disabled, every other step works",
          "Set TYPESAFE_API_KEY in the MCP server's env (your key), or an invite token there plus TYPESAFE_BASE_URL."
        )
  );
  return results;
}

export const doctorExitCode = (results) => (results.some((r) => r.status === "fail") ? 1 : 0);

export function formatDoctor(results) {
  const lines = results.map((r) => {
    const head = `${r.status.toUpperCase().padEnd(4)}  ${r.id.padEnd(12)} ${r.detail}`;
    return r.status !== "pass" && r.fix ? `${head}\n      fix: ${r.fix}` : head;
  });
  const fails = results.filter((r) => r.status === "fail").length;
  const warns = results.filter((r) => r.status === "warn").length;
  lines.push("", fails ? `${fails} problem${fails === 1 ? "" : "s"} to fix before sim-eyes can run.` : warns ? "Ready. The warnings above only limit optional features." : "Ready.");
  return lines.join("\n");
}

function exec(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 127) : 0, stdout: stdout ?? "", stderr: stderr || (err?.code === "ENOENT" ? `${cmd}: not found` : "") });
    });
  });
}

/** The `doctor` command: prints the report (`--json` for machines) and returns the exit code. */
export async function doctorMain(argv = []) {
  const pkg = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  const poolHome = process.env.AGENT_SIM_POOL_HOME ?? join(homedir(), ".agent-sim-pool");
  const results = await runDoctor({
    platform: process.platform,
    nodeVersion: process.versions.node,
    env: process.env,
    exec,
    pool: resolveSimPool(),
    poolConfigExists: existsSync(join(poolHome, "config.json")),
    adCommand: adCommandFromHost(() => ["npx", "-y", "agent-device"]),
    adPin: pkg.simEyes.agentDevice,
    ocr: ocrForDoctor(),
  });
  console.log(argv.includes("--json") ? JSON.stringify(results, null, 2) : formatDoctor(results));
  return doctorExitCode(results);
}
