#!/usr/bin/env node
// The `sim-eyes` bin. No args: the MCP server (stdout is the protocol, so every message here goes to stderr).
import { readFileSync } from "node:fs";

const MIN_NODE = [22, 12];
const HELP = `sim-eyes: an MCP server that looks at and drives one iOS simulator.

  sim-eyes            start the MCP server on stdio (what an MCP client runs)
  sim-eyes doctor     check this Mac for what sim-eyes needs (--json for machines)
  sim-eyes --version
`;

const [command, ...rest] = process.argv.slice(2);
const [major, minor] = (process.env.SIM_EYES_NODE_VERSION ?? process.versions.node).split(".").map(Number);

if (major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1])) {
  console.error(`sim-eyes needs Node ${MIN_NODE.join(".")} or newer (this is ${process.versions.node}). Update Node, then retry.`);
  process.exit(1);
}

if (command === "--version" || command === "-v") {
  console.log(JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")).version);
} else if (command === "--help" || command === "-h") {
  console.log(HELP);
} else if (command === "doctor") {
  const { doctorMain } = await import("./doctor.mjs");
  process.exitCode = await doctorMain(rest);
} else if (command === undefined) {
  await import("./server.mjs");
} else {
  console.error(`sim-eyes: unknown argument "${command}"\n\n${HELP}`);
  process.exit(1);
}
