// Why: the packaged Mac app lives at a path a tester chooses ("~/My Apps/…"); splitting that path on spaces would
// run the wrong program, so a JSON array must pass through untouched while the old space form keeps working.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { adCommandFromHost, findPackageJson, parseAdCommand, resolveAdCommand } from "../ad-command.mjs";

assert.deepEqual(parseAdCommand("npx -y agent-device"), ["npx", "-y", "agent-device"]);
assert.deepEqual(parseAdCommand("/opt/homebrew/bin/agent-device"), ["/opt/homebrew/bin/agent-device"]);
assert.deepEqual(parseAdCommand('["/My Apps/Sim Eyes.app/node","/My Apps/ad.mjs"]'), ["/My Apps/Sim Eyes.app/node", "/My Apps/ad.mjs"]);
assert.throws(() => parseAdCommand("[]"), /non-empty array/);
assert.throws(() => parseAdCommand('[1,"x"]'), /non-empty array/);

// Why: precedence is env, then the pinned dependency, then the user's own install, then slow npx. The Mac app sets
// SIM_EYES_AD (a path with spaces) and must keep its bundled agent-device; strangers must get the pinned one, not
// whatever Homebrew or npx happens to hold.
const DEP = "/pkg/node_modules/agent-device/package.json";
const dep = { resolveDep: () => DEP, readJson: () => ({ bin: { "agent-device": "bin/ad.mjs" } }), nodePath: "/usr/bin/node" };
const none = () => {
  throw new Error("not found");
};
const brew = (...paths) => (p) => paths.includes(p);
const npxFallback = () => ["npx", "-y", "agent-device"];

assert.deepEqual(
  resolveAdCommand({ env: { SIM_EYES_AD: '["/My Apps/node","/My Apps/ad.mjs"]' }, exists: brew(), ...dep, fallback: npxFallback }),
  ["/My Apps/node", "/My Apps/ad.mjs"],
  "SIM_EYES_AD beats the dependency"
);
assert.deepEqual(
  resolveAdCommand({ env: {}, exists: brew("/opt/homebrew/bin/agent-device"), ...dep, fallback: npxFallback }),
  ["/usr/bin/node", "/pkg/node_modules/agent-device/bin/ad.mjs"],
  "the pinned dependency beats brew and npx"
);
assert.deepEqual(
  resolveAdCommand({ env: {}, exists: brew(), ...dep, readJson: () => ({ bin: "cli.js" }), fallback: npxFallback }),
  ["/usr/bin/node", "/pkg/node_modules/agent-device/cli.js"],
  "a string bin works too"
);
assert.deepEqual(
  resolveAdCommand({ env: {}, exists: brew("/opt/homebrew/bin/agent-device", "/usr/local/bin/agent-device"), resolveDep: none, fallback: npxFallback }),
  ["/opt/homebrew/bin/agent-device"],
  "without the dependency, Homebrew (arm64) comes next"
);
assert.deepEqual(
  resolveAdCommand({ env: {}, exists: brew("/usr/local/bin/agent-device"), resolveDep: none, fallback: npxFallback }),
  ["/usr/local/bin/agent-device"],
  "then Homebrew (Intel)"
);
assert.deepEqual(
  resolveAdCommand({ env: {}, exists: brew(), resolveDep: none, fallback: npxFallback }),
  ["npx", "-y", "agent-device"],
  "then the caller's PATH/npx fallback"
);
assert.deepEqual(
  resolveAdCommand({ env: {}, exists: brew(), ...dep, readJson: () => ({}), fallback: npxFallback }),
  ["npx", "-y", "agent-device"],
  "a dependency with no bin is skipped, not run"
);

// Why: agent-device does not export its package.json, so a lookup through require.resolve fails and every stranger
// would silently get the slow npx path. The pinned copy must be found by the real search, not only by a fake.
assert.equal(findPackageJson("zod", { paths: ["/a", "/b"], exists: (p) => p === "/b/zod/package.json" }), "/b/zod/package.json");
assert.throws(() => findPackageJson("zod", { paths: ["/a"], exists: () => false }), /not installed/);
const real = findPackageJson("agent-device");
assert.ok(existsSync(real) && real.endsWith("node_modules/agent-device/package.json"), real);
const host = adCommandFromHost(() => ["fallback"]);
if (!process.env.SIM_EYES_AD) assert.ok(host[1]?.includes("node_modules/agent-device/bin/agent-device.mjs"), `host resolves the dependency, got ${host}`);
console.log("test-ad-command: ok");
