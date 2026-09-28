# sim-eyes

Cursor MCP for an iOS simulator. Each call returns the next screenshot.

## Multi-agent (required on a shared Mac)

**Problem:** Every Cursor chat used to hardcode session `sim-eyes` + device `iPhone 17`, so agents stomped each other.

**Fix (v1.1):** Each MCP process gets a unique `agent-device` session (`sim-eyes-<pid>-<hex>`) and leases a simulator through [sim-pool](https://github.com/trmquang93) (`~/.claude/skills/sim-pool`).

| Tool | Purpose |
| --- | --- |
| `acquire` | Lease an exclusive UDID (optional `prefer_udid` / `prefer_device`) |
| `release` | Free the lease + close the session when QA ends |
| `status` | This process binding + host pool table |
| `look` / `open` / … | Auto-acquire on first use if you forgot `acquire` |

If the pool is busy → tool returns `SIM_POOL_BUSY` → mark QA **inconclusive**. Do not steal another lease.

Also install/use the **sim-pool** skill. Set `SIM_POOL_BIN` if it is not under `~/.claude/skills/sim-pool/scripts/sim-pool`.

| Tool | Arguments |
| --- | --- |
| `look` | optional `{ "save": "shot.png" }` |
| `open` | `{ "name": "com.example.app", "save": "shot.png" }` |
| `tap` | `{ "index": 2 }` from the last look, `{ "label": "Save" }`, or `{ "x": 180, "y": 420 }` |
| `swipe` | `{ "direction": "up" }` |
| `drag` | `{ "x1": 40, "y1": 400, "x2": 300, "y2": 400 }` |
| `type` | `{ "text": "hello", "index": 1, "replace": true }` or `{ "text": "hello", "label": "Search" }` |
| `press` | `{ "key": "search" }` — also `return`, `delete`, `dismiss` |
| `record` | `{ "action": "start" }` then a gesture then `{ "action": "stop" }` |
| `batch` | `{ "actions": [{ "tool": "tap", "label": "Files" }, { "tool": "wait", "ms": 300 }, { "tool": "tap", "index": 3, "save": "shot.png" }] }` — runs in order, an index refers to the previous step's look, stops at the first error or skipped tap/type, returns one line per step plus the final screenshot |

`look` numbers every control and, for a text field, prints `placeholder` and `value` when they differ from the label. `tap` and `type` accept that `index`, so the control you saw is the one that is pressed. A label shared by two controls is not pressed; the reply lists the indexes. `type` with `replace: true` sets the whole field. `press` sends a keyboard key (`search` and `return` submit, `dismiss` hides the keyboard, `delete` is the keyboard delete key) and does not match a row with the same name. `save` on any of these tools copies the screenshot to that path. Coordinates are points. Screenshots are 1x.

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
