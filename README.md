# sim-eyes

Cursor MCP for an iOS simulator. Each call returns the next screenshot.

| Tool | Arguments |
| --- | --- |
| `look` | none |
| `open` | `{ "name": "com.example.app" }` |
| `tap` | `{ "label": "Save" }` or `{ "x": 180, "y": 420 }` |
| `swipe` | `{ "direction": "up" }` |
| `drag` | `{ "x1": 40, "y1": 400, "x2": 300, "y2": 400 }` |
| `type` | `{ "text": "hello", "label": "Search" }` |
| `record` | `{ "action": "start" }` then a gesture then `{ "action": "stop" }` |

`tap` by label presses that accessibility label. If the press fails, and `TYPESAFE_API_KEY` is set, one TypeSafe choice picks a control from the on-screen list. Coordinates are points. Screenshots are 1x.

Requires [agent-device](https://www.npmjs.com/package/agent-device) (`npx` is used when it is not on `PATH`) and a booted iOS simulator. `record` stop also uses `ffmpeg`.

```json
{
  "mcpServers": {
    "sim-eyes": {
      "command": "node",
      "args": ["/absolute/path/to/sim-eyes/server.mjs"],
      "env": {
        "SIM_EYES_DEVICE": "iPhone 17",
        "TYPESAFE_API_KEY": "${TYPESAFE_API_KEY}"
      }
    }
  }
}
```

`SIM_EYES_BOOT_DEVICE` is the simulator name to boot when none is running. It defaults to `iPhone 17`.
