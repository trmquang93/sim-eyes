#!/usr/bin/env node
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const tool = process.argv[2];
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};

const ACTIONS = new Set(["act", "open", "record"]);
/** Action tools only exist inside batch; wrap a single one. */
function toCall(name, args) {
  return ACTIONS.has(name)
    ? { name: "batch", arguments: { app: args.app ?? "Settings", actions: [{ tool: name, ...args }] } }
    : { name, arguments: args };
}

const serverPath = join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs");

const init = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test", version: "1.0.0" },
  },
};

const call = {
  jsonrpc: "2.0",
  id: 2,
  method: "tools/call",
  params: toCall(tool, args),
};

const child = spawn("node", [serverPath], { stdio: ["pipe", "pipe", "inherit"] });
let buf = "";
child.stdout.on("data", (d) => {
  buf += d;
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.id === 1) {
      child.stdin.write(JSON.stringify(call) + "\n");
    }
    if (msg.id === 2) {
      const text = msg.result?.content?.find((c) => c.type === "text")?.text;
      const images = msg.result?.content?.filter((c) => c.type === "image") ?? [];
      console.log("TEXT:", text);
      console.log("IMAGES:", images.length);
      if (msg.result?.isError) process.exit(1);
      child.kill();
      process.exit(0);
    }
  }
});
child.stdin.write(JSON.stringify(init) + "\n");
