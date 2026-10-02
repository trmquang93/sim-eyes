// Why: the packaged Mac app lives at a path a tester chooses ("~/My Apps/…"); splitting that path on spaces would
// run the wrong program, so a JSON array must pass through untouched while the old space form keeps working.
import assert from "node:assert/strict";
import { parseAdCommand } from "./ad-command.mjs";

assert.deepEqual(parseAdCommand("npx -y agent-device"), ["npx", "-y", "agent-device"]);
assert.deepEqual(parseAdCommand("/opt/homebrew/bin/agent-device"), ["/opt/homebrew/bin/agent-device"]);
assert.deepEqual(parseAdCommand('["/My Apps/Sim Eyes.app/node","/My Apps/ad.mjs"]'), ["/My Apps/Sim Eyes.app/node", "/My Apps/ad.mjs"]);
assert.throws(() => parseAdCommand("[]"), /non-empty array/);
assert.throws(() => parseAdCommand('[1,"x"]'), /non-empty array/);
console.log("test-ad-command: ok");
