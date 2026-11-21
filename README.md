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
2. Place this folder, named `STExtension`, into your SillyTavern extensions directory:
   `public/scripts/extensions/third-party/` (or install it from the repo URL in SillyTavern's *Install extension* dialog).
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

- `/lovense [action] [strength] [duration] [loop]`
    - **Action:** `Vibrate`, `Pulse`, `Wave`, `Fireworks`, `Earthquake`, `Stop` (other Lovense functions such as `Rotate`/`Pump` are passed through)
    - **Strength:** `0` to `3` ONLY, default `1` (Ferri max — even 4 is too much)
    - **Duration:** Seconds (e.g., `5`); each command fires **once** by default
    - **Loop:** add `true` as 4th arg to repeat until `/lovense-stop`
    - *Example:* `/lovense Vibrate 1 5` (once) / `/lovense Vibrate 1 5 true` (loop)
- `/lovense-stop`
    - Immediately stops the toy **and** cancels loops, pending delayed commands and running haptic unlocks.

### AI Integration

If you are using a model that supports **Function Calling** (e.g., GPT-4, Claude 3.5), enable "Function Calling" in the AI Response Configuration. The AI can now autonomously call `control_lovense_toy` to provide physical feedback during the roleplay.

### Optional features (both OFF by default)

Enable these in the settings panel. When off, the AI is not told about them and they do nothing.

- **Allow delayed commands.** The AI may pass `delay` (1-300 s) to `control_lovense_toy` to schedule a command that fires later, while you keep reading.
  Same 0-3 strength cap, at most 3 pending, and **Stop**, `/lovense-stop`, *Stop All*, turning the option off, or switching chats cancels everything pending.
  If the AI sends `delay` while the option is off, the delay is ignored and the command fires immediately like any normal one.
- **Enable haptic unlock secrets.** The AI may hide text as
  `<redacted haptic_unlock="true" action="Pulse" strength="1" duration="20">secret</redacted>`.
  The extension rewrites the tag into a blurred span with a **Begin Haptic Unlock Test** button. Nothing fires until *you* tap it; the toy runs the cycle with a visible countdown and the text is revealed when it completes.
  Tap again at any time (or use Stop All) to stop the toy and keep the text locked. Attribute values are whitelisted and clamped (action from a fixed list, strength 0-3, duration 1-60 s).
  The blur is cosmetic: the secret is still in the chat log and the page source.

### Behaviour notes

- Commands from the AI's *text* (fallback parser) only run for messages produced by a live generation. Re-rendering history (opening a chat, browsing swipes) never replays old commands.
- A fire-once command is **not** stopped when the AI's reply finishes; it runs for its `duration`. Only an explicit Stop, or replacing a running `loop=true` replay, sends a device Stop.

## RemoteMCP (standalone MCP server)

`RemoteMCP.py` is a **standalone** MCP server for external hosts
(Claude Desktop, etc.). It is **not** loaded by SillyTavern — the
in-browser extension (`index.js` + `lovense-client.js`) handles ST
function calling natively.

It now mirrors the extension exactly: `local` / `server` / `mock`
modes, all Function actions + Preset patterns, strength/duration
sanitising, `toyId` targeting, `GetToys`, and opt-in `delay` commands (off unless `ALLOW_DELAYED_COMMANDS=true`; `Stop` cancels them).

### Tools

| Tool | Mirrors | Args |
|---|---|---|
| `control_lovense_toy` | ST native tool | `action, strength (0-3 Ferri max, default 1), duration (1-60s), toy_id, loop (accepted, never loops here), delay (0-300s, needs ALLOW_DELAYED_COMMANDS=true)` |
| `SendStopFunction` | `/lovense-stop` | `toy_id` (also cancels pending delayed commands) |
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
./.venv/bin/python RemoteMCP.py CONNECTION_MODE=local \
  GAME_MODE_IP=192.168.1.100 GAME_MODE_PORT=30010

# or explicit domain (== ST localDomain/localPort settings)
./.venv/bin/python RemoteMCP.py CONNECTION_MODE=local \
  LOCAL_DOMAIN=127-0-0-1.lovense.club LOCAL_PORT=30010

# server cloud API
./.venv/bin/python RemoteMCP.py CONNECTION_MODE=server \
  DEVELOPER_TOKEN=... USER_ID=...

# mock (no toy, for testing)
./.venv/bin/python RemoteMCP.py CONNECTION_MODE=mock

# HTTP transports for hosts that need them
./.venv/bin/python RemoteMCP.py CONNECTION_MODE=mock \
  MCP_TRANSPORT=sse MCP_PORT=8899            # -> http://127.0.0.1:8899/sse
./.venv/bin/python RemoteMCP.py CONNECTION_MODE=mock \
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
- Nothing is written to stdout except MCP protocol frames (all logging goes to stderr).

## Development

```bash
npm install              # dev dependencies (jsdom, jquery, express)
npm test                 # unit tests + integration tests that load the real index.js against a fake SillyTavern
python3 -m pip install -r requirements.txt -r requirements-dev.txt
python3 -m pytest test   # RemoteMCP tests (mock mode, no network)
npm run callback-server  # optional: small Express server for Lovense callbacks
```

`manifest.json` and the `?v=` query strings (currently `16`) on the imports in `index.js` act as cache-busters. Bump them together when you ship a change, or browsers may keep serving old scripts.

## Security Note

Developer tokens used in Server Mode are stored in plain text within the extension settings. For enhanced privacy and security, we recommend using **Local PC/Mac Connect** mode.
