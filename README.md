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
    - **Strength:** `1` to `20` (1-3 for Pump)
    - **Duration:** Seconds (e.g., `5`)
    - *Example:* `/lovense Vibrate 15 5`
- `/lovense-stop`
    - Immediately stops all activity.

### AI Integration

If you are using a model that supports **Function Calling** (e.g., GPT-4, Claude 3.5), enable "Function Calling" in the AI Response Configuration. The AI can now autonomously call `control_lovense_toy` to provide physical feedback during the roleplay.

## Security Note

Developer tokens used in Server Mode are stored in plain text within the extension settings. For enhanced privacy and security, we recommend using **Local PC/Mac Connect** mode.