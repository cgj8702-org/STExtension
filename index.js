// @ts-nocheck
import { LovenseClient } from './lovense-client.js?v=11';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { SlashCommandArgument, ARGUMENT_TYPE } from '/scripts/slash-commands/SlashCommandArgument.js';
import { setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '/script.js';

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
    customGuidelines: `You have access to the tool 'control_lovense_toy' to control the user's physical Lovense Ferri device.

SAFETY LIMIT (HARD CAP): NEVER exceed strength 3. 0 = stop, 1 = gentle tease, 2 = moderate, 3 = MAXIMUM. Even 4 is physically too much. If a scene calls for "intense", use strength 3 with a longer duration instead.

TAME AGENCY — how to behave:
1. You MAY trigger the device on your own during roleplay when it fits the scene — but keep it gentle by default: prefer strength 1, short durations (3-10s), and common patterns (Vibrate, Pulse, Wave).
2. Strength 2-3 is reserved for explicit escalation: the user asked for more, consented to intensity, or the scene clearly peaks. Never open with 3.
3. No surprise max blasts. No chaining long loops without the user's buy-in. One command plays once and stops — if you want it to repeat, pass loop=true explicitly.
4. Stop immediately when the user says stop (any wording: "stop", "too much", "pause", "scene change", safeword) — call action Stop and do not restart until asked.
5. Direct user commands (/lovense or in-chat requests) always win over your own pacing. Execute them as asked (still capped at 3).

Looping: each command fires ONCE by default. Only set loop=true if the user asked for continuous/repeating stimulation or the scene explicitly needs it (e.g. "keep it going", "don't stop"). Looping replays until Stop — use sparingly.

Tool Invocation:
Call 'control_lovense_toy' with: action ('Vibrate', 'Pulse', 'Wave', 'Fireworks', 'Earthquake', or 'Stop'), strength (0-3, default 1), duration (1-60 seconds, default 5), loop (false by default, true only when continuous play was requested).
• Available Actions / Patterns:
  - 'Vibrate': Direct manual vibration strength.
  - 'Pulse': Rhythmic pulsing sensation.
  - 'Wave': Smooth rising and falling waves.
  - 'Fireworks': Explosive, erratic pattern bursts.
  - 'Earthquake': Heavy, intense rumbling.
  - 'Stop': Immediately halt all device activity.
    (Fallback: If tool calls are unsupported, include "lovense": {"action": "Vibrate", "strength": X, "duration": Y} in your JSON tracker).

`,
});

let settings;
let client;
let cachedToys = {};
let stContext = null;
let isNativeSupported = false;

// Command playback state.
// B+C behavior: every command fires ONCE by default. Only commands with
// loop=true are replayed after generation ends, until Stop.
let messageCommands = [];
let loopInterval = null;
let currentLoopIndex = 0;
let isLooping = false;

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
 * Also called defensively on GENERATION_ENDED before any loop=true replay.
 */
function stopLoopingCommands() {
    isLooping = false;
    if (loopInterval) {
        clearTimeout(loopInterval);
        loopInterval = null;
    }
    currentLoopIndex = 0;

    if (client) {
        client.sendCommand({ action: 'Stop', strength: 0, duration: 0 })
            .catch(e => console.warn('[Lovense] Stop on loop-clear failed:', e));
    }
    console.log('[Lovense] Stopped command loop');
}

async function updateToyCache() {
    if (!client) return;
    try {
        const toys = await client.getToys();
        if (toys && !toys.error) {
            cachedToys = toys;
            updateLovensePrompt();
        }
    } catch (e) {
        console.warn("[Lovense] Could not update toy cache:", e);
    }
}

/**
 * Generates dynamic instructions based on connected toys and capabilities
 */
function generateDynamicPrompt() {
    const toyKeys = Object.keys(cachedToys);
    if (toyKeys.length === 0) return '';

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

    const guidelines = settings.customGuidelines || defaultSettings.customGuidelines;

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
    if (!stContext || !settings) return;

    const isLocalMode = settings.connectionMode === 'local';

    // In local mode, skip if no toys are connected. In server/mock mode, proceed anyway.
    if (isLocalMode && Object.keys(cachedToys).length === 0) {
        setExtensionPrompt(EXTENSION_PROMPT_TAG, '', extension_prompt_types.IN_CHAT, 0, false, extension_prompt_roles.SYSTEM);
        return;
    }

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
    if (apiResponse.code === 200 || apiResponse.result === true) {
        return JSON.stringify({ status: 'success' });
    }
    return JSON.stringify({ status: 'error', code: apiResponse.code });
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
    const regex = /([a-zA-Z0-9_\-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
    let match;
    while ((match = regex.exec(attrString)) !== null) {
        const key = match[1];
        const val = match[2] ?? match[3] ?? match[4];
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
        if (action.toLowerCase() === 'pulse' || action.toLowerCase() === 'random') {
            action = 'Vibrate';
        }

        let strength = commandData.strength !== undefined ? Number(commandData.strength) : 2;
        // Ferri safety: HARD CAP 3. Rescale legacy 1-20 / hallucinated 1-100.
        if (strength > 20) {
            strength = Math.round(strength * 20 / 100);
        }
        if (strength > 3) {
            console.warn(`${prefix} Strength ${strength} exceeds Ferri max 3 — clamping.`);
            strength = 3;
        }
        strength = Math.min(Math.max(strength, 0), 3);

        let duration = commandData.duration_sec !== undefined ? Number(commandData.duration_sec) : (commandData.duration !== undefined ? Number(commandData.duration) : 5);
        duration = Math.min(Math.max(duration, 1), 60);

        const toyId = commandData.toyId || commandData.device_id || 'mock-ferri-001';
        const loop = commandData.loop === true || commandData.loop === 'true';

        console.warn(`${prefix} Executing: action=${action}, strength=${strength}, duration=${duration}s, toyId=${toyId}, loop=${loop}`);

        if (isMock) {
            window.toastr.info(
                `${action} @ Lvl ${strength} for ${duration}s${loop ? ' (loop)' : ''}`,
                'Lovense Mock (Parser)',
            );
        }

        // Track for post-generation replay ONLY if loop=true (B). Fire-once (C)
        // already executes immediately below — no replay needed otherwise.
        messageCommands.push({ action, strength, duration, toyId, loop });

        lovenseClient.sendCommand({
            action,
            strength,
            duration,
            toyId
        }).catch(e => console.error(`${prefix} Command failed:`, e));
    }

    let lastProcessedText = "";

    function processMessage(chatIndex) {
        const { chat } = stContext;
        const message = chat[chatIndex];
        if (!message || message.is_user) return;

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
    }

    // Register listeners for rendered and received bot messages
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, (chatIndex) => {
        processMessage(chatIndex);
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, (chatIndex) => {
        processMessage(chatIndex);
    });

    // Clear command queue when new generation starts
    eventSource.on(event_types.GENERATION_STARTED, () => {
        messageCommands = [];
        console.log('[Lovense] Generation started - cleared command queue');
    });

    // Start looping when generation completes — only if loop=true commands exist
    eventSource.on(event_types.GENERATION_ENDED, () => {
        const loopCount = messageCommands.filter(c => c.loop === true).length;
        console.log('[Lovense] Generation ended -', messageCommands.length, 'commands seen,', loopCount, 'loop=true');
        stopLoopingCommands();
        if (loopCount > 0) {
            startLoopingCommands();
        }
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

    window.$('#lovense_connectionMode').on('change', (e) => {
        console.warn('[Lovense UI] Connection Mode dropdown changed to:', e.target.value);
        settings.connectionMode = e.target.value;
        toggleSettingsVisibility();
        saveSettingsDebounced();
    });

    window.$('#lovense_localPort').on('change', (e) => {
        settings.localPort = e.target.value;
        saveSettingsDebounced();
    });

    window.$('#lovense_localDomain').on('change', (e) => {
        settings.localDomain = e.target.value;
        saveSettingsDebounced();
    });

    window.$('#lovense_developerToken').on('change', (e) => {
        settings.developerToken = e.target.value;
        saveSettingsDebounced();
    });

    window.$('#lovense_userId').on('change', (e) => {
        settings.userId = e.target.value;
        saveSettingsDebounced();
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
        try {
            const result = await client.getToys();
            console.warn('[Lovense UI] Test Connection result:', result);
            if (result.error) throw new Error(result.error);
            const isMock = settings.connectionMode === 'mock';
            const toyCount = Object.keys(result).length;
            statusEl.text(isMock ? `Status: Mock (${toyCount} simulated toys)` : 'Status: Connected');
            window.toastr.success(isMock ? `Mock mode active! ${toyCount} simulated toys loaded.` : 'Lovense connection successful!');
        } catch (e) {
            console.error('[Lovense UI] Test Connection failed:', e);
            statusEl.text('Status: Disconnected');
            window.toastr.error(`Connection failed: ${e.message}`);
        }
    });

    window.$('#lovense_stop_all').on('click', () => {
        stopLoopingCommands();
        messageCommands = [];
        window.toastr.success('All toys stopped and loop cleared.', 'Lovense');
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
            const argsArray = Array.isArray(unnamedArgs) ? unnamedArgs : [unnamedArgs];
            const action = String(argsArray[0] || '');
            // Ferri safety: default 1 (tame), HARD CAP 3.
            const strength = Math.min(Math.max(argsArray[1] ? Number(argsArray[1]) : 1, 0), 3);
            const duration = argsArray[2] ? Number(argsArray[2]) : 5;
            const loop = String(argsArray[3] || '').toLowerCase() === 'true';
            if (!action) return 'Usage: /lovense [action] [strength 0-3] [duration] [loop=true]';
            try {
                await client.sendCommand({ action, strength, duration: duration || 5 });
                if (loop && action.toLowerCase() !== 'stop') {
                    messageCommands.push({ action, strength, duration: duration || 5, toyId: null, loop: true });
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
                stopLoopingCommands();
                messageCommands = [];
                return 'Lovense: All toys stopped and loop cleared.';
            } catch (e) {
                return `Lovense Error: ${e.message}`;
            }
        },
    }));
}

function registerLovenseTools() {
    const { registerFunctionTool, isToolCallingSupported } = stContext;
    if (!isToolCallingSupported()) return;

    const isMock = settings.connectionMode === 'mock';

    registerFunctionTool({
        name: 'control_lovense_toy',
        displayName: 'Control Lovense Toy',
        description: 'Trigger, adjust, or stop gentle haptic feedback on the user\'s Ferri. Fires ONCE by default — only set loop=true if the user explicitly asked for continuous/repeating play. Keep strength 0-3 (default 1), stop immediately on any stop cue.',
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
                toyId: {
                    type: 'string',
                    description: 'Optional. The ID of the connected Ferri device: "mock-ferri-001".'
                }
            },
            required: ['action', 'strength', 'duration']
        },
        action: async ({ action, strength, duration, loop, toyId }) => {
            // Ferri safety: HARD CAP 3 for ALL actions (was 20, Pump-only 3).
            let sanitizedStrength = Math.min(Math.max(strength ?? 1, 0), 3);

            let finalDuration = duration === 0 ? 60 : Math.min(Math.max(duration ?? 5, 1), 60);
            const wantLoop = loop === true;

            // Track for post-generation replay ONLY if loop=true (B).
            messageCommands.push({ action, strength: sanitizedStrength, duration: finalDuration, toyId, loop: wantLoop });

            if (isMock) {
                console.log(`[Lovense Mock Tool] action=${action}, strength=${sanitizedStrength}, duration=${finalDuration}s, loop=${wantLoop}, toyId=${toyId || 'all'}`);
                window.toastr.info(
                    `${action} @ Lvl ${sanitizedStrength} for ${finalDuration}s${wantLoop ? ' (loop)' : ''}`,
                    'Lovense Mock (Tool Call)',
                );
            }

            try {
                const response = await client.sendCommand({ action, strength: sanitizedStrength, duration: finalDuration, toyId });
                return handleToolResponse(response);
            } catch (error) {
                return JSON.stringify({ status: "error", message: error.message });
            }
        },
        formatMessage: ({ action, strength, loop }) => {
            const prefix = isMock ? '[Lovense Mock]' : '[Lovense]';
            return `${prefix} Sending ${action} (Lvl ${strength})${loop ? ' looping' : ''}...`;
        },
        stealth: true
    });
}

export async function onActivate() {
    try {
        stContext = window.SillyTavern.getContext();
        if (!stContext) throw new Error("SillyTavern context not found.");

        settings = getSettings();
        client = new LovenseClient(settings);

        const isMock = settings.connectionMode === 'mock';
        if (isMock) {
            console.log('%c[Lovense] MOCK MODE ACTIVE - No real API calls will be made', 'color: #00e5ff; font-weight: bold; font-size: 14px;');
            window.toastr.info('Mock mode active. Simulated toys loaded, no real API calls.', 'Lovense Integration');
        }

        // Detect native tool support
        isNativeSupported = stContext.isToolCallingSupported();
        console.log(`[Lovense] Native Tool Calling supported: ${isNativeSupported}`);

        await updateUI();
        registerLovenseSlashCommands();

        if (isNativeSupported) {
            console.log("[Lovense] Registering native tool path...");
            registerLovenseTools();
        }

        // Always register the parser hook to clean up and execute any manual XML/JSON blocks outputted in text
        console.log("[Lovense] Enabling parser hook pipeline...");
        registerParserHook(client);

        await updateToyCache();
        updateLovensePrompt(); // Initial prompt injection
        if (!isMock) {
            setInterval(updateToyCache, 30000);
        }

        console.log('Lovense Toy Integration activated successfully');
    } catch (e) {
        console.error('Lovense Toy Integration failed to activate:', e);
    }
}
