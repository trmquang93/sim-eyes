#!/usr/bin/env node
/**
 * Drives the MCP server the way an AI tool does: through the app's stable path, over stdio.
 *   node scripts/verify-app-mcp.mjs --app dist/SimEyesStudio.app [--clean-env] [--live] [--real-home] [--out DIR]
 * Uses a throwaway HOME (so the real ~/.local, Keychain-free log and Application Support are untouched) unless --real-home.
 * --clean-env runs the server under `env -i` (what a GUI-launched client gives it). --live also leases a free simulator,
 * looks at the screen and releases it. Writes the evidence files into --out (default .local/qa-evidence/mcp-in-app).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const app = resolve(arg("--app", "dist/SimEyesStudio.app"));
const outDir = resolve(arg("--out", ".local/qa-evidence/mcp-in-app"));
mkdirSync(outDir, { recursive: true });

const EXPECTED = ["acquire", "batch", "continue", "release", "status"];
const home = flag("--real-home") ? process.env.HOME : mkdtempSync(join(tmpdir(), "mcp-home-"));
const work = mkdtempSync(join(tmpdir(), "mcp-cwd-"));
const binary = join(app, "Contents", "MacOS", "SimEyesStudio");
const lines = [];
const note = (text) => { lines.push(text); console.log(text); };
const fail = (text) => { note(`FAIL ${text}`); writeFileSync(join(outDir, flag("--live") ? "live-flow.txt" : "tools-list.txt"), `${lines.join("\n")}\n`); process.exit(1); };

execFileSync(binary, ["--refresh-link"], { env: { ...process.env, HOME: home } });
const link = join(home, ".local", "sim-eyes", "bin", "sim-eyes-mcp");
if (!existsSync(link)) fail(`no link at ${link}`);
note(`link ${link} -> ${realpathSync(link)}`);
if (realpathSync(link) !== realpathSync(binary)) fail("the link does not point at the app binary");

const cleanEnv = flag("--clean-env");
const transport = new StdioClientTransport({
  command: cleanEnv ? "/usr/bin/env" : link,
  args: cleanEnv ? ["-i", "PATH=/usr/bin:/bin", `HOME=${home}`, link] : [],
  cwd: work,
  env: cleanEnv ? undefined : { HOME: home, PATH: process.env.PATH },
  stderr: "inherit",
});
const client = new Client({ name: "verify-app-mcp", version: "1" });
await client.connect(transport);
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
note(`tools ${tools.join(", ")}${cleanEnv ? " (env -i)" : ""}`);
if (JSON.stringify(tools) !== JSON.stringify(EXPECTED)) fail(`expected ${EXPECTED.join(", ")}`);

const log = join(home, "Library", "Logs", "SimEyesStudio.log");
const startLine = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter((l) => l.startsWith("mcp start")).pop() : null;
if (!startLine) fail(`no "mcp start" line in ${log}`);
note(startLine);
if (!startLine.includes(`${app}/Contents/Resources/node`) && !startLine.includes(`${realpathSync(app)}/Contents/Resources/node`)) fail("the log does not show the app's own Node");

const text = (r) => r.content?.find((c) => c.type === "text")?.text ?? "";
let name = cleanEnv ? "clean-env.txt" : "tools-list.txt";
if (flag("--live")) {
  name = "live-flow.txt";
  const first = await client.callTool({ name: "acquire", arguments: { app: "com.apple.Preferences" } }, undefined, { timeout: 300000 });
  const acquired = text(first);
  note(`acquire: ${acquired.slice(0, 1500)}`);
  const sid = /session_id=(\S+)/.exec(acquired)?.[1];
  if (!/Acquired simulator/.test(acquired) || !sid) { note("INCONCLUSIVE no free simulator"); writeFileSync(join(outDir, name), `${lines.join("\n")}\n`); await client.close(); process.exit(2); }
  try {
    const status = text(await client.callTool({ name: "status", arguments: { session_id: sid } }));
    note(`status: ${status.slice(0, 1500)}`);
    if (!status.includes(realpathSync(work)) && !status.includes(work)) note("NOTE status does not show the client's cwd as worktree");
    const batch = text(await client.callTool({ name: "batch", arguments: { session_id: sid, app: "com.apple.Preferences", actions: [{ tool: "look" }] } }, undefined, { timeout: 300000 }));
    note(`batch look: ${batch.slice(0, 600)}`);
    if (/^Error|\nError:/.test(batch) || /^Error|\nError:/.test(acquired)) { note("FAIL a live call returned an error"); process.exitCode = 1; }
  } finally {
    note(`release: ${text(await client.callTool({ name: "release", arguments: { session_id: sid } })).slice(0, 200)}`);
  }
}
await client.close();
note(process.exitCode ? "FAIL" : "PASS");
writeFileSync(join(outDir, name), `${lines.join("\n")}\n`);
