// @ts-nocheck
import { LovenseClient } from './lovense-client.js?v=18';
import {
    clampStrength, clampDuration, clampDelay,
    convertRedactedTags, DelayedCommandQueue, createUnlockSession,
} from './haptic-utils.js?v=18';
import {
    clampToastSeconds, toastOptions, toastrMethod, formatLogLine, toBase64Utf8, LogFileWriter, DEFAULT_TOAST_SECONDS,
} from './log-utils.js?v=18';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { SlashCommandArgument, ARGUMENT_TYPE } from '/scripts/slash-commands/SlashCommandArgument.js';
import { setExtensionPrompt, extension_prompt_types, extension_prompt_roles, getRequestHeaders } from '/script.js';

const MODULE_NAME = 'lovense_integration';
const EXTENSION_PROMPT_TAG = 'lovense_control';

// Toy capability mappings
const TOY_CAPABILITIES = {
    'ferri': ['vibrate']
};

const defaultSettings = Object.freeze({
    connectionMode: 'local',
    localPort: '30010',
    localDomain: '127-0-0-1.lovense.club',
    developerToken: '',
    userId: '',
    allowDelayedCommands: false, // opt-in: model may schedule commands for later
    enableHapticUnlock: false, // opt-in: <redacted> secrets unlocked by a haptic cycle
    toastTimeoutSec: DEFAULT_TOAST_SECONDS, // 0 = stay until dismissed
    saveLogToFile: false, // opt-in: write notifications + commands to a .log file in SillyTavern's user files
    customGuidelines: `You have access to the tool 'control_lovense_toy' to control the user's physical Lovense Ferri device.

SAFETY LIMIT (HARD CAP): NEVER exceed strength 3. 0 = stop, 1 = gentle tease, 2 = moderate, 3 = MAXIMUM. Even 4 is physically too much. If a scene calls for "intense", use strength 3 with a longer duration instead.

TAME AGENCY — how to behave:
1. You MAY trigger the device on your own during roleplay when it fits the scene — but keep it gentle by default: prefer strength 1, short durations (3-10s), and common patterns (Vibrate, Pulse, Wave).
2. Strength 2-3 is reserved for explicit escalation: the user asked for more, consented to intensity, or the scene clearly peaks. Never open with 3.
3. No surprise max blasts. No chaining long loops without the user's buy-in. One command plays once and stops — if you want it to repeat, pass loop=true explicitly.
4. Stop immediately when the user says stop (any wording: "stop", "too much", "pause", "scene change", safeword) — call action Stop and do not restart until asked.
5. Direct user commands (/lovense or in-chat requests) always win over your own pacing. Execute them as asked (still capped at 3).

Looping: each command fires ONCE by default. Only set loop=true if the user asked for continuous/repeating stimulation or the scene explicitly needs it (e.g. "keep it going", "don't stop"). Looping replays until Stop — use sparingly.

NARRATION RULE (no silent buzzing): ALWAYS write in-character prose in the SAME response as the tool call — describe what your character does/says while the sensation hits. NEVER emit a tool call with empty text. After the tool result returns, continue the scene (reaction, dialogue, escalation) instead of ending your turn.

Tool Invocation:
Call 'control_lovense_toy' with: action ('Vibrate', 'Pulse', 'Wave', 'Fireworks', 'Earthquake', or 'Stop'), strength (0-3, default 1), duration (1-60 seconds, default 5), loop (false by default, true only when continuous play was requested).
• Available Actions / Patterns:
  - 'Vibrate': Direct manual vibration strength.
  - 'Pulse': Rhythmic pulsing sensation.
  - 'Wave': Smooth rising and falling waves.
  - 'Fireworks': Explosive, erratic pattern bursts.
  - 'Earthquake': Heavy, intense rumbling.
  - 'Stop': Immediately halt all device activity.
    (Fallback: If tool calls are unsupported, include "lovense": {"action": "Vibrate", "strength": X, "duration": Y} in your JSON tracker, or call <call:control_lovense_toy action="Vibrate" strength="1" duration="5"/>).

`,
});

let settings;
let client;
let cachedToys = {};
let stContext = null;
let isNativeSupported = false;
let isShutDown = false; // set by the disable/delete hooks so late async work can't re-arm anything
let isDeviceOnline = null;
let toyCacheInterval = null;

// Command playback state.
// B+C behavior: every command fires ONCE by default. Only commands with
// loop=true are replayed after generation ends, until Stop.
let messageCommands = [];
let loopInterval = null;
let currentLoopIndex = 0;
let isLooping = false;

// Delayed commands + haptic unlocks + generation window
let delayedQueue = null;
const activeUnlocks = new Set(); // abort() functions of running unlock sessions
let generationInFlight = false;
let generationGraceUntil = 0; // ms timestamp; late render events right after a generation still count

// ---- Notifications + local log ---------------------------------------------------------------
const LOG_FILE_BASE = 'lovense-integration';
let logFileName = `${LOG_FILE_BASE}.log`;
let logWriter = null;
let loadedExistingLog = false;

function logEvent(level, message, title = 'Lovense') {
    try {
        logWriter?.append(formatLogLine(level, message, title));
    } catch (e) {
        console.warn('[Lovense] Failed to record log line:', e);
    }
}

/** Toast with the user's chosen duration; also recorded in the log unless { log: false }. */
function notify(level, message, title = 'Lovense', { log = true } = {}) {
    if (log) logEvent(level, message, title);
    const show = window.toastr?.[toastrMethod(level)];
    if (typeof show === 'function') {
        show.call(window.toastr, message, title, toastOptions(settings?.toastTimeoutSec));
    }
}

/** Write the whole log through SillyTavern's user-files API (overwrites; lands in <user>/user/files/). */
async function uploadLog(text) {
    const res = await fetch('/api/files/upload', {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify({ name: logFileName, data: toBase64Utf8(text) }),
    });
    if (!res.ok) {
        // Some SillyTavern builds forbid certain extensions; fall back to .txt once.
        if (res.status === 400 && logFileName.endsWith('.log')) {
            logFileName = `${LOG_FILE_BASE}.txt`;
            console.warn('[Lovense] Server refused the .log name; falling back to', logFileName);
            return uploadLog(text);
        }
        throw new Error(`log upload failed: HTTP ${res.status}`);
    }
}

/**
 * Existing-log load. The writer stays DISABLED until this finishes, so a session can never overwrite saved
 * history with only its own lines. Only "file not found" counts as a fresh start; any other failure to read
 * leaves saving off for this session ('unreadable') instead of risking the old history.
 */
let existingLogState = 'pending'; // 'pending' | 'ready' | 'unreadable'
let existingLogPromise = null;

function loadExistingLog() {
    existingLogPromise ??= (async () => {
        let state = 'ready';
        let found = false;
        for (const name of [`${LOG_FILE_BASE}.log`, `${LOG_FILE_BASE}.txt`]) {
            try {
                const res = await fetch(`/user/files/${name}`, { cache: 'no-store' });
                if (res.ok) {
                    const text = await res.text();
                    if (/^\s*<(!doctype|html)/i.test(text)) continue; // an HTML fallback page, not our log
                    logWriter?.prepend(text);
                    logFileName = name;
                    found = true;
                    break;
                }
                if (res.status !== 404) state = 'unreadable';
            } catch {
                state = 'unreadable';
            }
        }
        if (found) state = 'ready';
        existingLogState = state;
        if (state === 'unreadable') {
            console.warn('[Lovense] Could not read the existing log file; not saving this session so it is not overwritten.');
            notify('error', 'Could not read the existing log file, so the log will not be saved this session (to avoid overwriting it). Reload to retry.', 'Lovense');
        }
        logWriter?.schedule();
    })();
    return existingLogPromise;
}

function downloadLog() {
    const text = logWriter?.text || '';
    const blob = new Blob([text || '(log is empty)\n'], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${LOG_FILE_BASE}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function getSettings() {
    const { extensionSettings } = stContext;
    if (!extensionSettings[MODULE_NAME]) {
        extensionSettings[MODULE_NAME] = structuredClone(defaultSettings);
    }
    for (const key of Object.keys(defaultSettings)) {
        if (!Object.hasOwn(extensionSettings[MODULE_NAME], key)) {
            extensionSettings[MODULE_NAME][key] = defaultSettings[key];
        }
    }
    return extensionSettings[MODULE_NAME];
}

/**
 * Start looping ONLY commands explicitly flagged loop=true.
 * Fire-once (C): non-loop commands already played immediately at call time,
 * so this replays just the loopable subset, cycling until Stop.
 */
function startLoopingCommands() {
    if (loopInterval) {
        clearTimeout(loopInterval);
        loopInterval = null;
    }

    if (!messageCommands || messageCommands.length === 0) {
        return;
    }

    // Only explicit opt-in loops. Filter out stop commands and clone.
    const loopable = messageCommands
        .filter(cmd => cmd.loop === true && cmd.action?.toLowerCase() !== 'stop')
        .map(cmd => {
            const clone = { ...cmd };
            // Normalize zero-duration to 30s for sequential playback
            if (!clone.duration || clone.duration === 0) clone.duration = 30;
            return clone;
        });

    if (loopable.length === 0) {
        console.log('[Lovense] No loop=true commands — nothing to replay (fire-once done).');
        return;
    }

    console.log('[Lovense] Starting command loop with', loopable.length, 'commands');
    currentLoopIndex = 0;
    isLooping = true;

    const playNext = async () => {
        if (!isLooping || loopable.length === 0) return;

        const cmd = loopable[currentLoopIndex];
        console.log('[Lovense] Looping command', currentLoopIndex + 1, 'of', loopable.length, ':', cmd);

        try {
            await client.sendCommand(cmd);
        } catch (e) {
            console.warn('[Lovense] Loop command failed:', e);
        }

        // Re-check after async operation (loop may have been stopped)
        if (!isLooping) return;

        currentLoopIndex = (currentLoopIndex + 1) % loopable.length;
        const durationMs = (cmd.duration || 5) * 1000;
        loopInterval = setTimeout(playNext, durationMs);
    };

    playNext();
}

/**
 * Stop playback and send a stop signal to all devices.
 * Used by Stop / Stop All. (GENERATION_ENDED only clears loop state, see clearLoopState.)
 */
function clearLoopState() {
    isLooping = false;
    if (loopInterval) {
        clearTimeout(loopInterval);
        loopInterval = null;
    }
    currentLoopIndex = 0;
}

/** Cancel delayed commands and abort running haptic unlocks. Does not touch the device. */
function cancelPendingActivity() {
    const cancelled = delayedQueue ? delayedQueue.cancelAll() : 0;
    for (const abort of [...activeUnlocks]) {
        try { abort(); } catch (e) { console.warn('[Lovense] Unlock abort failed:', e); }
    }
    activeUnlocks.clear();
    if (cancelled > 0) {
        console.log(`[Lovense] Cancelled ${cancelled} pending delayed command(s)`);
        logEvent('info', `Cancelled ${cancelled} pending delayed command(s)`, 'Cancel');
    }
}

/** Full stop: pending delays, running unlocks, loops, and the device itself. */
function stopEverything() {
    cancelPendingActivity();
    messageCommands = [];
    stopLoopingCommands();
}

function stopLoopingCommands() {
    clearLoopState();

    if (client) {
        client.sendCommand({ action: 'Stop', strength: 0, duration: 0 })
            .catch(e => console.warn('[Lovense] Stop on loop-clear failed:', e));
    }
    console.log('[Lovense] Stopped command loop');
}

function startToyCachePolling() {
    stopToyCachePolling();
    // Only poll in local mode where GetToys LAN API is supported
    if (settings?.connectionMode === 'local') {
        toyCacheInterval = setInterval(updateToyCache, 30000);
    }
}

function stopToyCachePolling() {
    if (toyCacheInterval) {
        clearInterval(toyCacheInterval);
        toyCacheInterval = null;
    }
}

async function updateToyCache() {
    if (!client || isShutDown) return;
    try {
        const toys = await client.getToys();
        if (toys && !toys.error) {
            const toyCount = Object.keys(toys).length;
            if (isDeviceOnline !== true) {
                console.log(`[Lovense] Connected to toy service (${toyCount} toy${toyCount === 1 ? '' : 's'} cached).`);
                isDeviceOnline = true;
            }
            cachedToys = toys;
            updateLovensePrompt();
        } else {
            const errorMsg = toys?.error || 'Unknown error';
            if (isDeviceOnline !== false) {
                console.warn(`[Lovense] Unable to reach Lovense device daemon: ${errorMsg}. Using fallback guidelines.`);
                isDeviceOnline = false;
            }
            cachedToys = {};
            updateLovensePrompt();
        }
    } catch (e) {
        if (isDeviceOnline !== false) {
            console.warn('[Lovense] Could not update toy cache:', e.message || e);
            isDeviceOnline = false;
        }
        cachedToys = {};
        updateLovensePrompt();
    }
}

/**
 * Generates dynamic instructions based on connected toys and capabilities
 */
const DELAY_GUIDELINES = `DELAYED COMMANDS (the user enabled this): pass 'delay' (seconds, 1-300) to schedule a command that fires later, while the user keeps reading. Because the user opted in, the timing may be left unannounced in-story. Same limits as always: strength 0-3, never open with 3, at most 3 delayed commands pending, and any Stop cancels everything pending. Do not stack delayed commands to build up total intensity.`;

const UNLOCK_GUIDELINES = `HAPTIC UNLOCK (the user enabled this): you may hide a secret inside <redacted haptic_unlock="true" action="Pulse" strength="1" duration="20">secret text</redacted>. The text stays blurred until the USER chooses to start the cycle and the toy finishes it; the user can cancel at any time, which keeps it hidden. The extension fires the toy itself — do NOT also call control_lovense_toy for that cycle. strength 0-3, duration 1-60. Never hide information the story cannot proceed without.`;

function getOptionalGuidelines() {
    const parts = [];
    if (settings?.allowDelayedCommands) parts.push(DELAY_GUIDELINES);
    if (settings?.enableHapticUnlock) parts.push(UNLOCK_GUIDELINES);
    return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}

function generateDynamicPrompt() {
    const toyKeys = Object.keys(cachedToys);
    const guidelines = (settings?.customGuidelines || defaultSettings.customGuidelines) + getOptionalGuidelines();

    if (toyKeys.length === 0) {
        return `[LOVENSE SYSTEM INSTRUCTION: You can control the user's Lovense device during this conversation:
Connected devices: Active Lovense Device (Default)

Capabilities:
• Vibrate (0-3 MAX): ALL devices — never exceed 3
• Patterns: Pulse, Wave, Fireworks, Earthquake (strength 0-3 MAX)
• Stop: Halt device activity

${guidelines}]`;
    }

    const capabilities = new Set(['vibrate']); // All toys can vibrate
    const toyNames = [];
    const toyDetails = [];

    for (const id of toyKeys) {
        const toy = cachedToys[id];
        const toyName = (toy.name || '').toLowerCase();
        const displayName = toy.name || id;
        toyNames.push(displayName);

        // Match device name to capabilities
        const matchedKey = Object.keys(TOY_CAPABILITIES).find(k => toyName.includes(k));
        const toyCaps = matchedKey ? TOY_CAPABILITIES[matchedKey] : ['vibrate'];

        toyDetails.push({ name: displayName, capabilities: toyCaps, id });
        toyCaps.forEach(cap => capabilities.add(cap));
    }

    const capabilityDescriptions = {
        'vibrate': '• Vibrate (0-3 MAX): ALL devices — Ferri-calibrated, never exceed 3',
        'rotate': '• Rotate (0-3 MAX): Nora, Diamo, Ridge',
        'pump': '• Pump (0-3): Max, Max 2',
        'thrusting': '• Thrusting (0-3 MAX): Solace, Sex Machine, Gravity',
        'fingering': '• Fingering (0-3 MAX): Flexer',
        'suction': '• Suction (0-3 MAX): Tenera',
        'oscillate': '• Oscillate (0-3 MAX): Osci series',
    };

    const capabilitiesText = Array.from(capabilities)
        .map(cap => capabilityDescriptions[cap])
        .filter(Boolean)
        .join('\n');

    let deviceSection = '';
    if (toyDetails.length > 1) {
        deviceSection = `\n\nDevice Targeting:\nControl specific devices by adding "toyId": "id" parameter. Devices:\n`;
        for (const toy of toyDetails) {
            deviceSection += `• ${toy.name} (ID: ${toy.id}): ${toy.capabilities.join(', ')}\n`;
        }
    }

    return `[LOVENSE SYSTEM INSTRUCTION: You can control the user's Lovense device during this conversation:
Connected devices: ${toyNames.join(', ')}

Capabilities:
${capabilitiesText}${deviceSection}

${guidelines}]`;
}

/**
 * Update the prompt injection via setExtensionPrompt
 */
function updateLovensePrompt() {
    if (!stContext || !settings || isShutDown) return;

    const prompt = generateDynamicPrompt();
    setExtensionPrompt(
        EXTENSION_PROMPT_TAG,
        prompt,
        extension_prompt_types.IN_CHAT,
        0,
        false,
        extension_prompt_roles.SYSTEM
    );
}


function handleToolResponse(apiResponse) {
    if (apiResponse.scheduled) {
        return JSON.stringify({ status: 'scheduled', delay_seconds: apiResponse.delay });
    }
    if (apiResponse.code === 200 || apiResponse.result === true) {
        return JSON.stringify({ status: 'success' });
    }
    return JSON.stringify({ status: 'error', code: apiResponse.code });
}

function getDelayedQueue() {
    if (!delayedQueue) {
        delayedQueue = new DelayedCommandQueue({
            send: cmd => sendLogged(cmd, 'Delayed fire'),
            onError: e => console.error('[Lovense] Delayed command failed:', e),
            onChange: n => window.$('#lovense_pending_count').text(String(n)),
        });
    }
    return delayedQueue;
}

/**
 * Single choke point for device commands from the tool, parser and slash command.
 * - Stop cancels delayed commands, unlocks and loops, then stops the device.
 * - delay is honoured only when the user enabled "Allow delayed commands".
 * Callers must pass already-clamped strength/duration.
 */
async function sendLogged(cmd, label = 'Command') {
    const target = cmd.toyId ? ` toy=${cmd.toyId}` : '';
    try {
        const res = await client.sendCommand(cmd);
        const ok = res?.code === 200 || res?.result === true;
        logEvent(ok ? 'info' : 'warn', `${cmd.action} @ ${cmd.strength} for ${cmd.duration}s${target} -> ${ok ? 'ok' : `code ${res?.code}`}`, label);
        return res;
    } catch (e) {
        logEvent('error', `${cmd.action} @ ${cmd.strength} for ${cmd.duration}s${target} failed: ${e.message || e}`, label);
        throw e;
    }
}

async function dispatchCommand({ action, strength, duration, toyId = null, delay = 0 }) {
    if (String(action).toLowerCase() === 'stop') {
        cancelPendingActivity();
        clearLoopState();
        messageCommands = []; // a Stop mid-message must not be undone by a loop replay at generation end
        return sendLogged({ action: 'Stop', strength: 0, duration: 0, toyId }, 'Stop');
    }

    let wait = clampDelay(delay);
    if (wait > 0 && !settings.allowDelayedCommands) {
        console.warn('[Lovense] delay requested but delayed commands are disabled — firing immediately.');
        wait = 0;
    }

    if (wait > 0) {
        const res = getDelayedQueue().schedule({ action, strength, duration, toyId }, wait);
        if (!res.ok) {
            logEvent('warn', `Delayed ${action} refused: ${res.reason}`, 'Delayed');
            return { code: 429, result: false, message: res.reason };
        }
        console.log(`[Lovense] Scheduled ${action} @ ${strength} for ${duration}s in ${wait}s`);
        logEvent('info', `Scheduled ${action} @ ${strength} for ${duration}s in ${wait}s`, 'Delayed');
        if (settings.connectionMode === 'mock') {
            notify('info', `${action} @ Lvl ${strength} in ${wait}s`, 'Lovense Mock (Delayed)');
        }
        return { code: 200, result: true, scheduled: true, delay: wait };
    }

    return sendLogged({ action, strength, duration, toyId });
}

function parseAttributes(attrString) {
    const attrs = {};
    if (!attrString) return attrs;

    // Check if attributes look like JSON: {device_id: "...", ...}
    const trimmed = attrString.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
            // Quote unquoted keys, e.g. device_id: -> "device_id":
            const cleaned = trimmed
                .replace(/([{,]\s*)([a-zA-Z0-9_\-]+)\s*:/g, '$1"$2":')
                .replace(/'/g, '"');
            return JSON.parse(cleaned);
        } catch (e) {
            console.error("[Lovense Fallback] Failed to parse curly-brace attributes:", e);
        }
    }

    // Standard attribute pattern: key="value" or key='value' or key=value
    const regex = /([a-zA-Z0-9_\-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>,)]+))/g;
    let match;
    while ((match = regex.exec(attrString)) !== null) {
        const key = match[1];
        let val = match[2] ?? match[3] ?? match[4];
        if (typeof val === 'string') {
            val = val.replace(/[,;]+$/, '').trim();
        }
        attrs[key] = val;
    }
    return attrs;
}

/**
 * Fallback Path: Parser hook to catch, execute, and remove Markdown-JSON blocks or manual XML tags.
 */
function registerParserHook(lovenseClient) {
    const { eventSource, event_types } = stContext;
    if (!eventSource || !event_types) {
        console.error("[Lovense] eventSource or event_types not found in context.");
        return;
    }

    const isMock = settings.connectionMode === 'mock';

    function searchForHapticCommand(obj) {
        if (!obj || typeof obj !== 'object') return null;

        // If it has action, and either strength or duration, it's a command
        if (obj.action && (obj.strength !== undefined || obj.duration !== undefined || obj.duration_sec !== undefined)) {
            return obj;
        }

        // Check for 'lovense' key
        if (obj.lovense && typeof obj.lovense === 'object') {
            return obj.lovense;
        }
        // Check for 'haptic_command' key
        if (obj.haptic_command && typeof obj.haptic_command === 'object') {
            return obj.haptic_command;
        }

        // Recurse arrays
        if (Array.isArray(obj)) {
            for (const item of obj) {
                const found = searchForHapticCommand(item);
                if (found) return found;
            }
        } else {
            // Recurse object keys
            for (const key of Object.keys(obj)) {
                const found = searchForHapticCommand(obj[key]);
                if (found) return found;
            }
        }
        return null;
    }

    function executeFallbackCommand(commandData) {
        const prefix = isMock ? '[Lovense Mock Parser]' : '[Lovense Parser]';

        let action = commandData.action || 'Vibrate';
        if (String(action).toLowerCase() === 'random') {
            action = 'Vibrate';
        }

        // Ferri safety: HARD CAP 3 (also rescales legacy 1-20 / hallucinated 1-100 values).
        const strength = clampStrength(commandData.strength, 1);
        const rawDuration = commandData.duration_sec !== undefined ? commandData.duration_sec : commandData.duration;
        const duration = clampDuration(rawDuration, 5);
        const delay = clampDelay(commandData.delay);

        // Only target a specific toy when the model named one. (Never invent a mock ID for a real device.)
        const toyId = commandData.toyId || commandData.device_id || null;
        const loop = (commandData.loop === true || commandData.loop === 'true') && delay === 0;

        console.warn(`${prefix} Executing: action=${action}, strength=${strength}, duration=${duration}s, toyId=${toyId}, loop=${loop}, delay=${delay}s`);

        if (isMock) {
            notify('info', 
                `${action} @ Lvl ${strength} for ${duration}s${loop ? ' (loop)' : ''}${delay ? ` in ${delay}s` : ''}`,
                'Lovense Mock (Parser)',
            );
        }

        // Track for post-generation replay ONLY if loop=true. Fire-once otherwise.
        if (delay === 0) {
            messageCommands.push({ action, strength, duration, toyId, loop });
        }

        dispatchCommand({ action, strength, duration, toyId, delay })
            .catch(e => console.error(`${prefix} Command failed:`, e));
    }

    let lastProcessedText = "";

    function processMessage(chatIndex) {
        const { chat } = stContext;
        const message = chat[chatIndex];
        if (!message || message.is_user) return;

        // Only act on messages produced by a live generation. Re-rendering history (chat load, swipes
        // browsing) must never replay old haptic commands.
        if (!generationInFlight && Date.now() > generationGraceUntil) return;

        if (message.mes === lastProcessedText) {
            return;
        }
        lastProcessedText = message.mes;

        const mes = message.mes;
        if (!mes) return;

        console.log("[Lovense Parser] Processing text for commands:", mes);

        // 1. Parse JSON blocks (handles both ```json and ```lovense blocks)
        const jsonBlockRegex = /```(?:json|lovense)\s*([\s\S]*?)\s*```/g;
        let match;
        while ((match = jsonBlockRegex.exec(mes)) !== null) {
            try {
                const parsedData = JSON.parse(match[1]);
                const command = searchForHapticCommand(parsedData);
                if (command) {
                    console.warn("[Lovense Parser] Found haptic command inside JSON block:", command);
                    executeFallbackCommand(command);
                }
            } catch (e) {
                // Ignore parsing errors for general json blocks (like the RPG tracker before it has a lovense key)
            }
        }

        // 2. Parse XML tags: <call:control_lovense_toy attributes /> or <call:control_lovense_toy{attributes}>
        const tagRegex = /<call:control_lovense_toy\s*([\s\S]*?)\s*(?:\/>|>)/g;
        while ((match = tagRegex.exec(mes)) !== null) {
            try {
                const attrString = match[1];
                const parsedAttrs = parseAttributes(attrString);
                if (parsedAttrs && Object.keys(parsedAttrs).length > 0) {
                    executeFallbackCommand(parsedAttrs);
                }
            } catch (e) {
                console.error("[Lovense Fallback] Failed to parse XML-style tag attributes:", e);
            }
        }

        // 3. Parse inline pseudo-function calls: `control_lovense_toy(action="Pulse", strength=4, duration=60)`
        const inlineFuncRegex = /(?:`|\b)control_lovense_toy\s*\(([^)]+?)\)(?:`|\b)/g;
        while ((match = inlineFuncRegex.exec(mes)) !== null) {
            try {
                const argString = match[1];
                const parsedAttrs = parseAttributes(argString);
                if (parsedAttrs && (parsedAttrs.action || parsedAttrs.strength !== undefined)) {
                    console.warn("[Lovense Fallback] Found inline function call:", parsedAttrs);
                    executeFallbackCommand(parsedAttrs);
                }
            } catch (e) {
                console.error("[Lovense Fallback] Failed to parse inline function call:", e);
            }
        }
    }

    // Redacted-secret handling must run BEFORE processMessage so lastProcessedText sees the final text.
    function convertRedactedInChat(chatIndex) {
        if (!settings.enableHapticUnlock) return;
        const message = stContext.chat[chatIndex];
        if (!message || message.is_user || typeof message.mes !== 'string') return;
        const { text, count } = convertRedactedTags(message.mes);
        if (count > 0) {
            message.mes = text;
            console.log(`[Lovense] Converted ${count} <redacted> secret(s) in message ${chatIndex}`);
        }
    }

    eventSource.on(event_types.MESSAGE_RECEIVED, (chatIndex) => {
        convertRedactedInChat(chatIndex);
        processMessage(chatIndex);
    });

    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (chatIndex) => {
        processMessage(chatIndex);
        enhanceRedactedInMessage(chatIndex);
    });

    // Clear command queue when new generation starts
    eventSource.on(event_types.GENERATION_STARTED, () => {
        generationInFlight = true;
        messageCommands = [];
        console.log('[Lovense] Generation started - cleared command queue');
    });

    const onGenerationFinished = () => {
        generationInFlight = false;
        generationGraceUntil = Date.now() + 3000;
    };
    if (event_types.GENERATION_STOPPED) eventSource.on(event_types.GENERATION_STOPPED, onGenerationFinished);

    // Start looping when generation completes — only if loop=true commands exist.
    // NOTE: this must NOT send a device Stop for fire-once commands, or every command would be cut off
    // the moment the reply finishes. A Stop is only sent if a previous loop was running and is now replaced.
    eventSource.on(event_types.GENERATION_ENDED, () => {
        onGenerationFinished();
        const loopCount = messageCommands.filter(c => c.loop === true).length;
        console.log('[Lovense] Generation ended -', messageCommands.length, 'commands seen,', loopCount, 'loop=true');
        const wasLooping = isLooping;
        clearLoopState();
        if (loopCount > 0) {
            startLoopingCommands();
        } else if (wasLooping && client) {
            client.sendCommand({ action: 'Stop', strength: 0, duration: 0 })
                .catch(e => console.warn('[Lovense] Stop after loop failed:', e));
        }
    });

    // A delayed command must never leak into a different chat.
    eventSource.on(event_types.CHAT_CHANGED, () => {
        cancelPendingActivity();
    });
}

/**
 * Turn converted <span class="lovense-redacted"> placeholders into interactive locked secrets.
 * Clicking starts the haptic cycle; the text is revealed only when the full cycle completes.
 * The user can stop the cycle at any time, which re-locks the text.
 */
function enhanceRedactedInMessage(chatIndex) {
    if (!settings.enableHapticUnlock) return;
    const root = document.querySelector(`#chat .mes[mesid="${chatIndex}"] .mes_text`);
    if (!root) return;

    root.querySelectorAll('.lovense-redacted[data-lovense-unlock]:not([data-lovense-ready])').forEach(wrapper => {
        wrapper.setAttribute('data-lovense-ready', '1');
        const textEl = wrapper.querySelector('.lovense-redacted-text');
        if (!textEl) return;

        const action = wrapper.getAttribute('data-lovense-action') || 'Vibrate';
        const strength = clampStrength(wrapper.getAttribute('data-lovense-strength'), 1);
        const duration = clampDuration(wrapper.getAttribute('data-lovense-duration'), 30);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'lovense-unlock-btn menu_button';
        btn.textContent = '🔒 Begin Haptic Unlock Test';
        wrapper.appendChild(document.createTextNode(' '));
        wrapper.appendChild(btn);

        const resetButton = () => {
            btn.textContent = '🔒 Begin Haptic Unlock Test';
            btn.classList.remove('lovense-unlock-running');
        };

        let session = null;
        const newSession = () => createUnlockSession({
            duration,
            start: async () => {
                logEvent('info', `Haptic unlock started (${action} @ ${strength} for ${duration}s)`, 'Unlock');
                const res = await dispatchCommand({ action, strength, duration });
                if (!(res?.code === 200 || res?.result === true)) {
                    throw new Error(res?.message || `device returned code ${res?.code}`);
                }
            },
            stop: () => {
                client.sendCommand({ action: 'Stop', strength: 0, duration: 0 })
                    .catch(e => console.warn('[Lovense] Stop on unlock abort failed:', e));
            },
            onTick: n => {
                btn.textContent = `⏳ ${n}s — tap to stop`;
            },
            onDone: () => {
                logEvent('info', `Haptic unlock completed (${action} @ ${strength} for ${duration}s) - secret revealed`, 'Unlock');
                activeUnlocks.delete(abortFn);
                textEl.classList.remove('lovense-redacted-blur');
                textEl.classList.add('lovense-unlocked-text');
                btn.remove();
            },
            onAbort: () => {
                logEvent('info', 'Haptic unlock aborted by user - secret stays locked', 'Unlock');
                activeUnlocks.delete(abortFn);
                resetButton();
                session = null;
            },
            onError: e => {
                activeUnlocks.delete(abortFn);
                resetButton();
                session = null;
                notify('error', `Haptic unlock failed to start: ${e.message || e}`, 'Lovense');
            },
        });
        const abortFn = () => session?.abort();

        btn.addEventListener('click', () => {
            if (session && (session.state === 'running' || session.state === 'starting')) {
                session.abort(); // second tap = stop and re-lock
                return;
            }
            session = newSession();
            activeUnlocks.add(abortFn);
            btn.classList.add('lovense-unlock-running');
            btn.textContent = '⏳ Starting… tap to stop';
            session.begin();
        });
    });
}

async function updateUI() {
    const { renderExtensionTemplateAsync, saveSettingsDebounced } = stContext;
    let settingsHtml;
    try {
        settingsHtml = await renderExtensionTemplateAsync('third-party/STExtension', 'settings', settings);
    } catch (e) {
        settingsHtml = await renderExtensionTemplateAsync('third-party/lovense-integration', 'settings', settings);
    }

    const container = window.$('#extensions_settings2');
    if (container.length === 0) {
        console.error("[Lovense] settings container #extensions_settings2 not found.");
        return;
    }

    // Clean up any existing panel to prevent duplicate IDs and event listeners
    container.find('.lovense-integration-settings').remove();

    console.log('[Lovense UI] Appending settings panel to container');
    container.append(settingsHtml);

    window.$('#lovense_connectionMode').on('change', async (e) => {
        const newMode = e.target.value;
        console.warn('[Lovense UI] Connection Mode dropdown changed to:', newMode);
        settings.connectionMode = newMode;
        toggleSettingsVisibility();
        saveSettingsDebounced();

        isDeviceOnline = null;
        startToyCachePolling();
        await updateToyCache();
    });

    window.$('#lovense_localPort').on('change', async (e) => {
        settings.localPort = e.target.value;
        saveSettingsDebounced();
        isDeviceOnline = null;
        await updateToyCache();
    });

    window.$('#lovense_localDomain').on('change', async (e) => {
        settings.localDomain = e.target.value;
        saveSettingsDebounced();
        isDeviceOnline = null;
        await updateToyCache();
    });

    window.$('#lovense_developerToken').on('change', (e) => {
        settings.developerToken = e.target.value;
        saveSettingsDebounced();
    });

    window.$('#lovense_userId').on('change', (e) => {
        settings.userId = e.target.value;
        saveSettingsDebounced();
    });

    window.$('#lovense_allowDelayedCommands').on('change', (e) => {
        settings.allowDelayedCommands = e.target.checked;
        if (!settings.allowDelayedCommands) cancelPendingActivity();
        updateLovensePrompt();
        saveSettingsDebounced();
    });

    window.$('#lovense_enableHapticUnlock').on('change', (e) => {
        settings.enableHapticUnlock = e.target.checked;
        updateLovensePrompt();
        saveSettingsDebounced();
    });

    window.$('#lovense_toastTimeoutSec').on('change', (e) => {
        settings.toastTimeoutSec = clampToastSeconds(e.target.value);
        e.target.value = settings.toastTimeoutSec;
        saveSettingsDebounced();
    });

    window.$('#lovense_saveLogToFile').on('change', async (e) => {
        settings.saveLogToFile = e.target.checked;
        saveSettingsDebounced();
        if (settings.saveLogToFile) {
            await loadExistingLog();
            if (existingLogState !== 'ready') return; // error toast already shown
            logEvent('info', 'Log file saving enabled', 'Log');
            await logWriter?.flush();
            if (logWriter?.lastError) {
                notify('error', `Could not write the log file: ${logWriter.lastError.message}`, 'Lovense');
            }
        }
    });

    window.$('#lovense_download_log').on('click', downloadLog);

    window.$('#lovense_clear_log').on('click', async () => {
        logWriter?.clear();
        await logWriter?.flush();
        window.toastr?.success?.('Lovense log cleared.', 'Lovense', toastOptions(settings.toastTimeoutSec));
    });

    window.$('#lovense_customGuidelines').on('input', (e) => {
        settings.customGuidelines = e.target.value;
        updateLovensePrompt();
        saveSettingsDebounced();
    });

    window.$('#lovense_reset_guidelines').on('click', () => {
        settings.customGuidelines = defaultSettings.customGuidelines;
        window.$('#lovense_customGuidelines').val(settings.customGuidelines);
        updateLovensePrompt();
        saveSettingsDebounced();
    });

    window.$('#lovense_test_connection').on('click', async () => {
        console.warn('[Lovense UI] Test Connection clicked. Current mode:', settings.connectionMode);
        const statusEl = window.$('#lovense_connection_status');
        statusEl.text('Testing...');
        const result = await client.testConnection();
        console.warn('[Lovense UI] Test Connection result:', result);
        if (result.ok) {
            if (result.mode === 'mock') {
                statusEl.text(`Status: Mock (${result.count} simulated toys)`);
                notify('success', `Mock mode active! ${result.count} simulated toys loaded.`);
            } else if (result.mode === 'server') {
                statusEl.text('Status: Connected (Server API)');
                notify('success', 'Lovense Server API connection successful!');
            } else {
                statusEl.text(`Status: Connected (${result.count} toys)`);
                notify('success', `Lovense connected! Found ${result.count} toy(s).`);
            }
            await updateToyCache();
        } else {
            statusEl.text('Status: Disconnected');
            notify('error', `Connection failed: ${result.error}`);
        }
    });

    window.$('#lovense_stop_all').on('click', () => {
        stopEverything();
        notify('success', 'All toys stopped; loops, delayed commands and unlocks cleared.', 'Lovense');
    });

    toggleSettingsVisibility();
}

function toggleSettingsVisibility() {
    const mode = settings.connectionMode;
    window.$('#lovense_local_settings').toggleClass('hidden', mode !== 'local');
    window.$('#lovense_server_settings').toggleClass('hidden', mode !== 'server');
    window.$('#lovense_mock_settings').toggleClass('hidden', mode !== 'mock');
}

function registerLovenseSlashCommands() {

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lovense',
        helpString: 'Control Lovense toy (fire-once; add loop=true to repeat until stopped)',
        callback: async (namedArgs, unnamedArgs) => {
            // SillyTavern may hand us one string ("Vibrate 2 5") or an array depending on version.
            const parts = Array.isArray(unnamedArgs)
                ? unnamedArgs.map(String)
                : String(unnamedArgs ?? '').trim().split(/\s+/).filter(Boolean);
            const action = String(parts[0] || '');
            if (!action) return 'Usage: /lovense [action] [strength 0-3] [duration] [loop=true]';
            // Ferri safety: default 1 (tame), HARD CAP 3.
            const strength = clampStrength(parts[1], 1);
            const duration = clampDuration(parts[2], 5);
            const loop = String(parts[3] || '').toLowerCase() === 'true';
            try {
                await dispatchCommand({ action, strength, duration });
                if (loop && action.toLowerCase() !== 'stop') {
                    messageCommands.push({ action, strength, duration, toyId: null, loop: true });
                    startLoopingCommands();
                    return `Lovense: ${action} @ ${strength} looping until /lovense-stop.`;
                }
                return `Lovense: ${action} @ ${strength} triggered (once).`;
            } catch (e) {
                return `Lovense Error: ${e.message}`;
            }
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'Action', typeList: ARGUMENT_TYPE.STRING, isRequired: true }),
            SlashCommandArgument.fromProps({ description: 'Strength 0-3', typeList: ARGUMENT_TYPE.NUMBER }),
            SlashCommandArgument.fromProps({ description: 'Duration seconds', typeList: ARGUMENT_TYPE.NUMBER }),
            SlashCommandArgument.fromProps({ description: 'loop=true to repeat', typeList: ARGUMENT_TYPE.STRING }),
        ],
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lovense-stop',
        helpString: 'Stop all Lovense toys and clear command loop',
        callback: async () => {
            try {
                stopEverything();
                return 'Lovense: All toys stopped; loops, delayed commands and unlocks cleared.';
            } catch (e) {
                return `Lovense Error: ${e.message}`;
            }
        },
    }));
}

/**
 * Register the native tool. This is deliberately NOT gated on isToolCallingSupported(): that value depends on the
 * current API and the "Enable function calling" toggle, both of which can change after page load. SillyTavern only
 * sends registered tools when function calling is actually available for the request.
 */
function registerLovenseTools() {
    const { registerFunctionTool } = stContext;
    if (typeof registerFunctionTool !== 'function') {
        console.warn('[Lovense] registerFunctionTool is not available in this SillyTavern version.');
        return;
    }
    const isMock = () => settings.connectionMode === 'mock';

    registerFunctionTool({
        name: 'control_lovense_toy',
        displayName: 'Control Lovense Toy',
        description: 'Trigger, adjust, or stop gentle haptic feedback on the user\'s Ferri WHILE you narrate the scene in prose. Fires ONCE by default — only set loop=true if the user explicitly asked for continuous play. Always write in-character text alongside the call (never call with empty text), then continue the scene after the result. Keep strength 0-3 (default 1), stop immediately on any stop cue. Optional delay (seconds) schedules the command for later, but is only honoured if the user enabled delayed commands.',
        parameters: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['Vibrate', 'Pulse', 'Wave', 'Fireworks', 'Earthquake', 'Stop'],
                    description: 'The movement command or preset pattern to execute. Choose "Vibrate" for direct vibration control, built-in preset patterns ("Pulse", "Wave", "Fireworks", "Earthquake"), or "Stop" to halt all activity.'
                },
                strength: {
                    type: 'integer',
                    description: 'Ferri intensity 0-3 ONLY (0=stop, 1=gentle default, 2=moderate, 3=MAXIMUM — even 4 is too much). NEVER exceed 3.'
                },
                duration: {
                    type: 'integer',
                    description: 'Duration in seconds, 1-60 (0 = hold for 60s).'
                },
                loop: {
                    type: 'boolean',
                    description: 'Set true ONLY if the user asked for continuous/repeating stimulation (e.g. "keep it going"). Default false = fire once and stop.'
                },
                delay: {
                    type: 'integer',
                    description: 'Optional delay in seconds (0-300) before the command fires. Ignored unless the user enabled delayed commands. Any Stop cancels pending delayed commands.'
                },
                toyId: {
                    type: 'string',
                    description: 'Optional. ID of a specific connected toy (omit to target all toys).'
                }
            },
            required: ['action', 'strength', 'duration']
        },
        action: async ({ action, strength, duration, loop, delay, toyId }) => {
            // Ferri safety: HARD CAP 3 for ALL actions.
            const sanitizedStrength = clampStrength(strength, 1);
            const finalDuration = clampDuration(duration, 5);
            const finalDelay = clampDelay(delay);
            const wantLoop = loop === true && finalDelay === 0;

            // Track for post-generation replay ONLY if loop=true. Delayed commands never loop.
            if (finalDelay === 0) {
                messageCommands.push({ action, strength: sanitizedStrength, duration: finalDuration, toyId, loop: wantLoop });
            }

            if (isMock()) {
                console.log(`[Lovense Mock Tool] action=${action}, strength=${sanitizedStrength}, duration=${finalDuration}s, loop=${wantLoop}, delay=${finalDelay}s, toyId=${toyId || 'all'}`);
            }
            // Shown through notify() so it honours the notification-duration setting. (ST's own formatMessage
            // toast has a short fixed timeout, so formatMessage below returns '' to suppress it.) Not logged
            // here: dispatchCommand logs the actual command result.
            const isStop = String(action).toLowerCase() === 'stop';
            notify(
                'info',
                isStop
                    ? 'Stop'
                    : `${action} @ Lvl ${sanitizedStrength} for ${finalDuration}s${wantLoop ? ' (loop)' : ''}${finalDelay ? ` in ${finalDelay}s` : ''}`,
                isMock() ? 'Lovense Mock (Tool Call)' : 'Lovense',
                { log: false },
            );

            try {
                const response = await dispatchCommand({ action, strength: sanitizedStrength, duration: finalDuration, toyId, delay: finalDelay });
                return handleToolResponse(response);
            } catch (error) {
                return JSON.stringify({ status: "error", message: error.message });
            }
        },
        formatMessage: () => '', // suppress ST's short-lived toast; the action shows its own (see above)
        stealth: false
    });
}

/** Run async startup work after the app is ready, so the activate hook (5s timeout, blocking loader) stays fast. */
function runWhenAppReady(task) {
    const { eventSource, event_types } = stContext;
    let started = false;
    const run = () => {
        if (started) return;
        started = true;
        setTimeout(() => {
            task().catch(e => console.warn('[Lovense] Deferred startup task failed:', e));
        }, 0);
    };
    if (eventSource && event_types?.APP_READY) eventSource.on(event_types.APP_READY, run);
    else run();
}

export async function onActivate() {
    try {
        stContext = window.SillyTavern.getContext();
        if (!stContext) throw new Error("SillyTavern context not found.");

        settings = getSettings();
        client = new LovenseClient(settings);
        logWriter = new LogFileWriter({
            upload: uploadLog,
            isEnabled: () => settings.saveLogToFile && existingLogState === 'ready',
            onError: e => console.warn('[Lovense] Could not save log file:', e.message || e),
        });
        logEvent('info', `Extension activated (mode=${settings.connectionMode})`, 'Lovense');

        const isMock = settings.connectionMode === 'mock';
        if (isMock) {
            console.log('%c[Lovense] MOCK MODE ACTIVE - No real API calls will be made', 'color: #00e5ff; font-weight: bold; font-size: 14px;');
            notify('info', 'Mock mode active. Simulated toys loaded, no real API calls.', 'Lovense Integration');
        }

        // Informational only: this can change later (API switch / toggling function calling), so it never gates registration.
        isNativeSupported = stContext.isToolCallingSupported?.() ?? false;
        console.log(`[Lovense] Native Tool Calling currently supported: ${isNativeSupported}`);

        await updateUI();
        registerLovenseSlashCommands();
        registerLovenseTools();

        // Always register the parser hook to clean up and execute any manual XML/JSON blocks outputted in text
        console.log("[Lovense] Enabling parser hook pipeline...");
        registerParserHook(client);

        updateLovensePrompt(); // Initial prompt injection (fallback text until the toy list arrives)
        startToyCachePolling();

        // Network work (toy list: up to 4s if Lovense Connect is down; saved log) must not hold up the loader.
        runWhenAppReady(async () => {
            if (settings.saveLogToFile) await loadExistingLog();
            await updateToyCache();
        });

        console.log('Lovense Toy Integration activated successfully');
    } catch (e) {
        console.error('Lovense Toy Integration failed to activate:', e);
    }
}

/** Disable/delete: stop the toy, cancel anything pending, and stop telling the model it can control a device. */
function shutdown(reason) {
    if (!stContext || !settings) return;
    isShutDown = true;
    try {
        logEvent('info', `Extension ${reason}: stopping device and clearing pending activity`, 'Lovense');
        stopToyCachePolling();
        stopEverything();
        setExtensionPrompt(EXTENSION_PROMPT_TAG, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
        stContext.unregisterFunctionTool?.('control_lovense_toy');
        logWriter?.flush();
    } catch (e) {
        console.warn(`[Lovense] Cleanup on ${reason} failed:`, e);
    }
}

export function onDisable() {
    shutdown('disabled');
}

export function onDelete() {
    shutdown('deleted');
}

export function onEnable() {
    if (!stContext || !settings) return; // not loaded yet; onActivate does the setup on the next page load
    isShutDown = false;
    registerLovenseTools();
    updateLovensePrompt();
    startToyCachePolling();
}
