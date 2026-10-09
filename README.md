# Lovense Toy Integration for SillyTavern

This extension integrates Lovense adult toys with SillyTavern, allowing for physical haptic feedback driven by the narrative.

## Features

- **Dual Connection Modes:**
    - **Local PC/Mac Connect:** Direct communication via the Lovense Connect app (Recommended). No tokens required.
    - **Server Cloud API:** Remote connection via Lovense's cloud servers using a developer token.
- **Manual Control:** Use slash commands to trigger toy actions directly from the chat.
- **AI-Driven Haptics:** Integrates with SillyTavern's function calling, allowing compatible LLMs to trigger toy responses based on the story context.

## Installation

1. Ensure you have the Lovense Connect app running on your computer (for Local Mode).
2. Place the `lovense-integration` folder into your SillyTavern extensions directory:
   `public/scripts/extensions/third-party/`
3. Restart SillyTavern or reload the page.

## Configuration

1. Open the **Extensions** menu in SillyTavern.
2. Locate **Lovense Toy Integration**.
3. Select your **Connection Mode**:
    - **Local:** Ensure the port is set to `30010` (default).
    - **Server:** Enter your Lovense Developer Token and User ID.
4. Click **Test Connection** to verify the setup.

## Usage

### Slash Commands

- `/lovense [action] [strength] [duration]`
    - **Action:** `Vibrate`, `Rotate`, `Pump`, `Stop`
    - **Strength:** `0` to `3` ONLY, default `1` (Ferri max — even 4 is too much)
    - **Duration:** Seconds (e.g., `5`); each command fires **once** by default
    - **Loop:** add `true` as 4th arg to repeat until `/lovense-stop`
    - *Example:* `/lovense Vibrate 1 5` (once) / `/lovense Vibrate 1 5 true` (loop)
- `/lovense-stop`
    - Immediately stops all activity.

### AI Integration

If you are using a model that supports **Function Calling** (e.g., GPT-4, Claude 3.5), enable "Function Calling" in the AI Response Configuration. The AI can now autonomously call `control_lovense_toy` to provide physical feedback during the roleplay.

## RemoteMCP (standalone MCP server)

`RemoteMCP.py` is a **standalone** MCP server for external hosts
(Claude Desktop, etc.). It is **not** loaded by SillyTavern — the
in-browser extension (`index.js` + `lovense-client.js`) handles ST
function calling natively.

It now mirrors the extension exactly: `local` / `server` / `mock`
modes, all Function actions + Preset patterns, strength/duration
sanitising, `toyId` targeting, `GetToys`, and `delay` landmines.

### Tools

| Tool | Mirrors | Args |
|---|---|---|
| `control_lovense_toy` | ST native tool | `action, strength (0-3 Ferri max, default 1), duration (1-60s), toy_id, loop (default false), delay (0-300s)` |
| `SendStopFunction` | `/lovense-stop` | `toy_id` |
| `SendFunctions` | legacy back-compat | `python_expression ("Vibrate:2"), duration, toy_id` |
| `get_toys` | `client.getToys()` | — |
| `get_status` | settings panel | — |

Actions: `Vibrate, Rotate, Pump, Thrusting, Fingering, Suction,
Oscillate, Pulse, Wave, Fireworks, Earthquake, Stop`
(Ferri HARD CAP 0-3 for ALL actions; legacy 1-20 / 1-100 rescaled;
`duration 0` → 60s hold — same as `index.js`).

### Run

```bash
cd public/scripts/extensions/third-party/STExtension
uv venv --python 3.14
uv pip install --python ./.venv/bin/python -r requirements.txt

# local (Lovense Connect app)
/.venv/bin/python RemoteMCP.py CONNECTION_MODE=local \
  GAME_MODE_IP=192.168.1.100 GAME_MODE_PORT=30010

# or explicit domain (== ST localDomain/localPort settings)
/.venv/bin/python RemoteMCP.py CONNECTION_MODE=local \
  LOCAL_DOMAIN=127-0-0-1.lovense.club LOCAL_PORT=30010

# server cloud API
/.venv/bin/python RemoteMCP.py CONNECTION_MODE=server \
  DEVELOPER_TOKEN=... USER_ID=...

# mock (no toy, for testing)
/.venv/bin/python RemoteMCP.py CONNECTION_MODE=mock

# HTTP transports for hosts that need them
/.venv/bin/python RemoteMCP.py CONNECTION_MODE=mock \
  MCP_TRANSPORT=sse MCP_PORT=8899            # -> http://127.0.0.1:8899/sse
/.venv/bin/python RemoteMCP.py CONNECTION_MODE=mock \
  MCP_TRANSPORT=streamable-http MCP_PORT=8899 # -> http://127.0.0.1:8899/mcp
```

All options also work as env vars (`CONNECTION_MODE`,
`GAME_MODE_IP`, …). CLI `KEY=VALUE` wins. See `mcp.example.json`
for Claude Desktop configs.

Notes:

- Local HTTPS uses Lovense's self-signed cert → `verify=False` by
  default (same as the browser's first-use cert exception). Set
  `VERIFY_SSL=true` only if you installed the cert.
- `stdio` logs to **stderr** so stdout stays clean for the protocol.
- Server-mode token is never logged.

## Security Note

Developer tokens used in Server Mode are stored in plain text within the extension settings. For enhanced privacy and security, we recommend using **Local PC/Mac Connect** mode.
