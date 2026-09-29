# sim-eyes

Cursor MCP for an iOS simulator. Each call returns the next screenshot.

## Multi-agent (required on a shared Mac)

**Problem:** Every Cursor chat used to hardcode session `sim-eyes` + device `iPhone 17`, so agents stomped each other.

**Fix (v1.1):** Each MCP process gets a unique `agent-device` session (`sim-eyes-<pid>-<hex>`) and leases a simulator through [sim-pool](https://github.com/trmquang93) (`~/.claude/skills/sim-pool`).

**Session IDs (v1.3):** One `sim-eyes` MCP process can serve many chats. Each chat starts with `acquire` or `batch` **without** `session_id`; the response begins with `session_id=se-…`. Pass that on **every** later `batch`, `acquire`, `status`, and `release`. Each `session_id` gets its own sim-pool lease and agent-device session — no UDID in `mcp.json`. sim-pool picks a free whitelisted device per new session.

| Goal | What to do |
| --- | --- |
| Two chats, two sims | Each chat omits `session_id` once, keeps its own `session_id` on all calls. |
| Switch sim in one chat | Same `session_id`, `acquire` with `rebind:true` (optional `prefer_udid`). |
| End QA | `release` with that chat's `session_id`. |

Unit tests use `scripts/run-unit-tests.sh` (separate lease), not the UI chat's `session_id`.

| Tool | Purpose |
| --- | --- |
| `acquire` | Lease an exclusive UDID (optional `prefer_udid` / `prefer_device`, and `app`: the app the session attaches to without relaunching it; default is the home screen). Also closes agent-device sessions left by dead sim-eyes processes. |
| `release` | Free the lease + close the session when QA ends |
| `status` | This process binding + host pool table |
| `batch` | Runs actions; auto-acquires on first use if you forgot `acquire` |

If the pool is busy → tool returns `SIM_POOL_BUSY` → mark QA **inconclusive**. Do not steal another lease.

Also install/use the **sim-pool** skill. Set `SIM_POOL_BIN` if it is not under `~/.claude/skills/sim-pool/scripts/sim-pool`.

Only steps someone reads take a snapshot and screenshot: the last step, `look`, steps with `save`, and steps followed by an `index` action. A tap, type or press followed by `wait` skips agent-device's `--settle`, so write flows as step → `wait` → step.

Every action goes through one tool, `batch`, which takes an array of actions. **Queue long batches:** put a whole flow (often 10–20 steps, with `look` + `save` wherever you need evidence) in one call instead of one or two steps per call. Each extra call costs a round-trip and an agent turn; queued steps cost only their gesture. Split only where the next step depends on reading the screen. Calling `tap`, `look` and the other action names directly returns an error that points to `batch`.

```json
{ "actions": [{ "tool": "tap", "label": "Files" }, { "tool": "wait", "ms": 300 }, { "tool": "tap", "index": 3, "save": "shot.png" }] }
```

| Action `tool` | Arguments |
| --- | --- |
| `look` | optional `save` |
| `open` | `name` (app name or bundle id); keeps a running app unless `relaunch: true` |
| `tap` | `index` from the last look, `label`, or `x` and `y` |
| `swipe` | `direction`: `up`, `down`, `left`, `right` |
| `drag` | `x1`, `y1`, `x2`, `y2` |
| `type` | `text` plus `index` or `label`, optional `replace` |
| `press` | `key`: `search`, `return`, `delete`, `dismiss` |
| `record` | `action`: `start` or `stop` |
| `wait` | `ms` (max 10000) |
| `act` | `instruction` (plain language), optional `text`, `max_steps` (default 5, max 10) |

Actions run in order. An `index` refers to the look taken after the previous step. The queue stops at the first error or skipped tap/type, and the result is one line per step plus the final screenshot. Any action accepts `save` to keep its screenshot.

### `act`: when you cannot predict the screen

`act` takes a goal such as `"allow notifications if asked"` or `"open Privacy & Security settings"`. Each round it reads the controls on screen and asks TypeSafe (`TYPESAFE_API_KEY`) two questions in one request: is the goal already met, and which single action comes next (tap a control, fill a field, swipe, return, dismiss keyboard, or none). Code runs that action and repeats. It never invents text: it can only fill a field with the `text` you pass.

TypeSafe also sees the navigation title, where Back leads, any open alert, and the steps already taken. It stops as done when the goal is met with probability 0.7 or more (a conditional goal whose condition does not hold is met with 0 steps). It stops the queue as skipped when TypeSafe picks none, its confidence is below 0.7, the same action repeats on an unchanged screen, or `max_steps` runs out. The result lists every step it took with its confidence.

```json
{ "actions": [{ "tool": "open", "name": "Settings" }, { "tool": "act", "instruction": "open Privacy & Security settings" }] }
```

`look` numbers every control and, for a text field, prints `placeholder` and `value` when they differ from the label. `tap` and `type` accept that `index`, so the control you saw is the one that is pressed. A label shared by two controls is not pressed; the reply lists the indexes. `type` with `replace: true` sets the whole field. `press` sends a keyboard key (`search` and `return` submit, `dismiss` hides the keyboard, `delete` is the keyboard delete key) and does not match a row with the same name. Coordinates are points. Screenshots are 1x.

Requires [agent-device](https://www.npmjs.com/package/agent-device) (`npx` is used when it is not on `PATH`) and a booted iOS simulator. `record` stop also uses `ffmpeg`.

```json
{
  "mcpServers": {
    "sim-eyes": {
      "command": "node",
      "args": ["/absolute/path/to/sim-eyes/server.mjs"],
      "env": {
        "TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}"
      }
    }
  }
}
```

### Env

| Variable | Meaning |
| --- | --- |
| `SIM_EYES_PREFER_UDID` / `DEVICE_ID` | Prefer this UDID when acquiring (still exclusive via pool) |
| `SIM_EYES_PREFER_DEVICE` | Prefer this simulator **name** (resolved to UDID) |
| `SIM_EYES_DEVICE` | Deprecated alias of `SIM_EYES_PREFER_DEVICE` — do **not** pin every agent to the same name |
| `SIM_EYES_USE_POOL=0` | Disable pool (unique session only; still unsafe for parallel agents) |
| `SIM_POOL_BIN` | Path to `sim-pool` CLI |
| `SIM_EYES_BOOT_DEVICE` | Name to boot when none running and pool is off (default `iPhone 17`) |
| `SIM_EYES_PROJECT` / `SIM_EYES_WORKTREE` | Metadata recorded on the lease |

Leases renew on every tool call; TTL + dead MCP pid recover orphans via sim-pool GC.
