#!/usr/bin/env node
import { spawn } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { resetTypesafeCallCount, getTypesafeCallCount, resolveLabel } from "./resolve-label.mjs";

const serverPath = join(dirname(fileURLToPath(import.meta.url)), "server.mjs");

async function directFuzzy() {
  resetTypesafeCallCount();
  const targets = [
    { n: 1, label: "Apple Account", x: 201, y: 216 },
    { n: 2, label: "General", x: 201, y: 326 },
    { n: 3, label: "Accessibility", x: 201, y: 380 },
  ];
  const result = await resolveLabel("the General settings row", targets);
  const count = getTypesafeCallCount();
  const ok =
    process.env.TYPESAFE_API_KEY
      ? result.target?.label === "General" && count === 1
      : result.target === null && count === 0;
  console.log(
    "DIRECT:",
    ok ? "PASS" : "FAIL",
    `target=${result.target?.label ?? "none"} typesafeCalls=${count}`
  );
  if (!ok) process.exitCode = 1;
}

function runMcpSession(env) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [serverPath], {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env, SIM_EYES_DEVICE: "iPhone 17", ...env },
    });
    let buf = "";
    let nextId = 1;
    const pending = new Map();

    function send(method, params) {
      const id = nextId++;
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"
      );
      return id;
    }

    child.stdout.on("data", (d) => {
      buf += d;
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      }
    });

    const ACTIONS = new Set(["look", "open", "tap", "swipe", "drag", "type", "press", "record"]);
    /** Action tools only exist inside batch; wrap a single one. */
    function toCall(name, args) {
      return ACTIONS.has(name)
        ? { name: "batch", arguments: { app: "Settings", actions: [{ tool: name, ...args }] } }
        : { name, arguments: args };
    }

    function callTool(name, args = {}) {
      return new Promise((res) => {
        pending.set(send("tools/call", toCall(name, args)), res);
      });
    }

    (async () => {
      await new Promise((r) =>
        pending.set(
          send("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "proof", version: "1" },
          }),
          r
        )
      );

      await callTool("open", { name: "Settings" });
      const exact = await callTool("tap", { label: "General" });
      const exactText = exact.result.content.find((c) => c.type === "text").text;
      const exactOk =
        !exact.result.isError &&
        !exactText.includes("(TypeSafe)") &&
        exactText.includes("About");

      await callTool("open", { name: "Settings" });
      const fuzzy = await callTool("tap", {
        label: "the General settings row",
      });
      const fuzzyText = fuzzy.result.content.find((c) => c.type === "text").text;
      const hasKey = !!env.TYPESAFE_API_KEY;
      const fuzzyOk = hasKey
        ? !fuzzy.result.isError &&
          fuzzyText.includes("(TypeSafe)") &&
          fuzzyText.includes("About")
        : fuzzy.result.isError === false &&
          fuzzyText.includes("Could not match") &&
          !fuzzyText.includes("About");

      child.kill();
      resolve({ exactOk, fuzzyOk, exactText: exactText.split("\n")[0], fuzzyText: fuzzyText.split("\n")[0] });
    })().catch(reject);
  });
}

async function main() {
  await directFuzzy();
  const withKey = await runMcpSession({ TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY ?? "" });
  console.log(
    "MCP EXACT:",
    withKey.exactOk ? "PASS" : "FAIL",
    withKey.exactText
  );
  console.log(
    "MCP FUZZY (key):",
    withKey.fuzzyOk ? "PASS" : "FAIL",
    withKey.fuzzyText
  );
  if (!withKey.exactOk || !withKey.fuzzyOk) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
