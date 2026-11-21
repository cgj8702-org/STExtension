
# 🚀 Handoff Plan: Advanced Lovense Integration Features

This document provides a detailed technical implementation plan for the next agent to implement two high-concept, out-of-the-box features for the **Lovense Toy Integration** extension in SillyTavern.

---

## 🎯 Feature 1: Asynchronous "Haptic Landmines" (Delayed Reaction Traps)

### Overview

Allows the model (Dr. Hannibal Lecter) to schedule physical stimulation commands that trigger after an asynchronous delay (in seconds), rather than firing immediately. Hannibal can place a trap mid-sentence or mid-dialogue, allowing the physical sensation to hit unexpectedly while the user is reading subsequent messages.

### Technical Implementation

1. **Tool Schema Update ([index.js](file:///home/carly/SillyTavern/public/scripts/extensions/third-party/STExtension/index.js))**

   - Add an optional `delay` parameter to `control_lovense_toy` parameters:
     ```json
     "delay": {
         "type": "integer",
         "description": "Optional delay in seconds before the command executes (0 to 300 seconds). Allows for unexpected, delayed physical traps."
     }
     ```
2. **Action Handler & Parser Hook Logic ([index.js](file:///home/carly/SillyTavern/public/scripts/extensions/third-party/STExtension/index.js))**

   - In both native tool action handlers and `executeFallbackCommand`:
     ```javascript
     if (delay && delay > 0) {
         console.log(`[Lovense] Scheduling delayed landmine command in ${delay}s:`, { action, strength, duration });
         setTimeout(() => {
             client.sendCommand({ action, strength, duration, toyId });
         }, delay * 1000);
     } else {
         client.sendCommand({ action, strength, duration, toyId });
     }
     ```
3. **Prompt Guidelines Update**

   - Update default `customGuidelines` to inform the model about the `delay` parameter:
     > *"Surprise Traps: You may pass 'delay' (seconds) to schedule unexpected haptic landmines that detonate mid-conversation while the user reads."*
     >

---

## 🔐 Feature 2: "Haptic Unlocking" (Redacted Text Secrets)

### Overview

Hannibal redacts secret thoughts, instructions, or confessions inside a custom HTML tag or spoiler syntax (`<redacted haptic_unlock="true" duration="30" strength="15" action="Earthquake">Secret text...</redacted>`). The text remains blurred/hidden in the chat UI until the user endures a haptic stimulation cycle for the specified duration.

### Technical Implementation

1. **Custom Tag Parser & DOM Mutation ([index.js](file:///home/carly/SillyTavern/public/scripts/extensions/third-party/STExtension/index.js))**

   - In `processMessage()` inside `registerParserHook`:
     - Scan rendered bot messages for `<redacted ...>content</redacted>` tags.
     - Extract parameters: `duration`, `strength`, `action`.
     - Replace the HTML element in the chat DOM with a styled interactive element:
       - **State 1 (Locked):** Text is blurred (`filter: blur(6px)`) with a button: `[🔒 Begin Haptic Unlock Test]`.
2. **Unlock Flow & Timer State**

   - Clicking `[🔒 Begin Haptic Unlock Test]`:
     - Disables the button and starts a countdown timer (e.g. `30s`).
     - Triggers the Lovense command (`client.sendCommand({ action, strength, duration })`).
     - Once the countdown reaches 0:
       - Removes the blur filter and reveals the secret text with a celebratory smooth fade animation!
3. **CSS Styling ([style.css](file:///home/carly/SillyTavern/public/scripts/extensions/third-party/STExtension/style.css))**

   - Add styles for `.lovense-redacted-blur`, `.lovense-unlock-btn`, and `.lovense-unlocked-text`.

---

## 📋 Handoff Checklist for Next Agent

- [x] Add `delay` parameter to `control_lovense_toy` tool schema in `index.js`.
- [x] Update `executeFallbackCommand` & `action` handler in `index.js` to handle `setTimeout` when `delay > 0`.
- [x] Add `<redacted>` tag regex parser to `registerParserHook`.
- [x] Add DOM blur & unlock button rendering logic in `index.js`.
- [x] Add CSS classes in `style.css` for blurred secrets and unlock progress.
- [x] Update `defaultSettings.customGuidelines` to document both landmines and redacted secrets.
- [x] Commit all changes to `main` git branch!


---

## Implementation notes (v1.1.0)

- Logic lives in `haptic-utils.js` (pure, unit-tested); `index.js` wires it to SillyTavern.
- **Deliberate deviation from the plan:** both features are opt-in settings (off by default), strength stays under the global 0-3 cap, and Stop / Stop All / chat change cancel pending delays and running unlocks. Unlock always needs a user-triggered start and can be aborted by the user.
- The optional guideline text is appended dynamically only when the matching option is on, so users' edited guidelines are never overwritten.
- **`<redacted>` is rewritten before render**: SillyTavern's sanitizer strips unknown tags, so `MESSAGE_RECEIVED` converts them to `<span class="lovense-redacted" data-lovense-*>`; the button is attached to the rendered DOM afterwards. The converted span is what is saved in the chat log.
- Unlock progress is not persisted: reloading the chat re-locks the secret.
- Work was committed on `feature/remotemcp-full-parity` rather than `main`.
