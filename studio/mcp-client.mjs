/** The real `call` for run-test.mjs: spawns the sim-eyes server and speaks MCP to it, as any agent's client does. */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");
/** A goal step can take minutes; the SDK's default is one. */
const CALL_TIMEOUT_MS = 15 * 60 * 1000;

const firstText = (result) => result.content?.find((c) => c.type === "text")?.text ?? "";

/** One server child. `call(name, args)` returns the tool result and adds the session_id the server handed out on the first reply. */
export async function openSimEyes({ env = {}, serverPath = SERVER } = {}) {
  // The SDK passes only a few variables unless asked, and the server needs TYPESAFE_API_KEY and PATH.
  const transport = new StdioClientTransport({ command: process.execPath, args: [serverPath], env: { ...process.env, ...env }, stderr: "inherit" });
  const client = new Client({ name: "sim-eyes-studio", version: "1" });
  await client.connect(transport);
  let sessionId = null;
  return {
    async call(name, args = {}) {
      const result = await client.callTool({ name, arguments: { ...args, ...(sessionId ? { session_id: sessionId } : {}) } }, undefined, { timeout: CALL_TIMEOUT_MS });
      sessionId ??= /^session_id=(\S+)/.exec(firstText(result))?.[1] ?? null;
      if (name === "release") sessionId = null;
      return result;
    },
    close: () => client.close(),
  };
}
