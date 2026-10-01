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
| `acquire` | Lease an exclusive UDID. **`app` is required** (display name or bundle id): the session attaches to that app without relaunching it. Optional `prefer_udid` / `prefer_device`: sim-pool treats them as hints, so when it hands out a different simulator the call **fails** (and releases that lease) with the pool row that explains why. Also closes agent-device sessions left by dead sim-eyes processes. |
| `release` | Free the lease + close the session when QA ends |
| `status` | This process binding + host pool table |
| `batch` | Runs `act` / `open` / `record` steps; auto-acquires on first use if you forgot `acquire` |

If the pool is busy → tool returns `SIM_POOL_BUSY` → mark QA **inconclusive**. Do not steal another lease.

Also install/use the **sim-pool** skill. Set `SIM_POOL_BIN` if it is not under `~/.claude/skills/sim-pool/scripts/sim-pool`.

sim-eyes is **act-only**: an agent drives the simulator with `act`, plus `open` (launch, restart, reset the app) and `record` (video). There are no tap, swipe, type, look or wait tools. All of it goes through one tool, `batch`, which takes an array of steps. **Queue whole flows:** put 5–20 steps in one call instead of one or two per call. Each extra call costs a round-trip and an agent turn; queued steps cost only their gesture. Split only where the next step depends on reading the screen. Calling `tap`, `look` or another retired name, directly or as a step, returns an error that says which `act` step to send.

```json
{ "app": "com.example.app", "actions": [{ "tool": "act", "instruction": "tap Files" }, { "tool": "act", "drag": { "from": "1", "to": "5" } }, { "tool": "act", "instruction": "tap Save", "save": "/abs/path/saved.png" }] }
```

Batch arguments: `app` (required), `actions`, `image` (return the final screenshot; default `true`) and `continue_on_fail` (keep going after a step stops; default `false`).

| Step `tool` | Arguments |
| --- | --- |
| `act` | `instruction` (plain language, one goal); optional `text`, `max_steps` (default 5, max 10), `wait_ms` (pause first, max 10000), `drag` `{from, to, hold_ms}`, `long_press`, `controls`, `save` |
| `open` | `name` (default: the batch app); `relaunch: true` restarts it; `reset: true` reinstalls it from its own bundle so its data, preferences and first-launch state are fresh (needs the bundle id) |
| `record` | `action`: `start` or `stop`; stop returns a contact sheet, plus `frames` (0–6, default 0) |

Steps run in order and stop at the first step that fails or does nothing. Every step reports the screen it left behind **in text**: the navigation title, the pager position ("Page 2 of 3"), an open alert, a few visible texts and the control labels. An agent reads that instead of asking for a screenshot, so intermediate pages are visible. Only the last step returns a screenshot, and any step that fails returns one with the controls listed with positions. `save` writes a step's screenshot to the path you give; a relative path goes to the session work dir (`~/.local/sim-eyes/work/<session>/saves/`), so pass an absolute path to keep it somewhere, and the reply gives the full path.

### `act`

`act` carries out one goal. Four routes, cheapest first:

1. **No instruction** only reports the screen (a look), with no model call. `wait_ms` waits first.
2. **`tap <label>`** (also press, click, select, choose, open, go to) where exactly one control has that exact label is carried out by code with no model call. It counts as done when the screen visibly changed.
3. **`drag` and `long_press`** are structured and carried out by code. `drag: {"from": "1", "to": "5"}` holds the source (600 ms by default), drags it onto the target and checks that the screen changed. `from`, `to` and `long_press` take a visible label (a page number or a row title counts, even when it is not a tappable control) or a point `{"x": …, "y": …}`; a label that two elements share is an error that lists them. What is behind a sheet cannot be addressed.
4. **Anything else** asks TypeSafe (`TYPESAFE_API_KEY`) two questions in one request per round: is the goal already met, and which single action comes next (tap a control, fill a field, swipe, return, dismiss keyboard, or none). Code runs that action and repeats. It never invents text: it can only fill a field with the `text` you pass.

When no control on screen has an accessibility label (custom-drawn or web views), `act` also runs Apple Vision OCR on the screenshot (`ocr.swift`, compiled to `~/.local/sim-eyes/bin/ocr` on first use, which takes about 30 s) and offers each recognized text as a tap target. If any control has a label, OCR is not run. If OCR fails, the `act` result says so.

After every tap, `act` compares screenshots from before and after (`ocr --diff`, ignoring the status bar) and reports whether the screen changed and whether it changed in the tapped control's rows, so a checkmark or switch that no control or text shows still confirms "select / toggle X".

Results: `done` (goal confirmed); `acted but not confirmed` (steps ran but the goal could not be read from the screen; the batch continues when the last step visibly changed the screen, otherwise it stops); `stopped` or `stuck` (nothing useful happened; the batch stops). The result lists every model-driven step with its confidence.

The control list leaves out controls agent-device marks as covered by another view, the screen under a presented sheet (iOS keeps it in the accessibility tree behind the sheet's), and a consent web dialog left in the tree after it closed. A sheet whose Toolbar makes agent-device mark every control covered is not hidden. An empty control list is read again after a short wait, since a sheet that has just been presented can come back empty.

A view in another process (the Photos picker, a permission sheet) draws over the app but is not in its accessibility tree, so the tree still lists the controls underneath. Each step reads the screenshot (OCR) and, when almost none of the tree's control labels can be read on screen, reports `screen: covered by a view outside the app's accessibility tree` with the text that is on screen; `act` then offers only that text as tap targets, and `tap <label>` is not carried out by code at the tree's positions. The icon-only buttons of such a view have no text and cannot be tapped.

`go back` is carried out by code when exactly one control is the Back button (the navigation bar's, or any control labelled "Back")

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
