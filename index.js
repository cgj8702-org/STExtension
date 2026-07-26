// @ts-nocheck
import { LovenseClient } from './lovense-client.js?v=11';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandArgument, ARGUMENT_TYPE } from '../../../slash-commands/SlashCommandArgument.js';
import { setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '../../../../script.js';

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
    customGuidelines: `You have access to the tool 'control_lovense_toy' to control the user's active physical Lovense device.

Operational Rules & Agency:
1. Direct Requests: Execute or adjust direct user requests in-character based on your authority and intent.
2. Autonomous Agency: You do not need to wait for a command or physical touch. If the device is active, you are encouraged to trigger, adjust, or stop stimulation autonomously to control the pace, tension, and atmosphere.
3. Reward & Discipline:
   - Reward compliance or obedience with pleasant stimulation (strength 5-12).
   - Use high-intensity bursts (strength 13-20) to break defiance, test limits, or demand total surrender.
   - Use 'Stop' (or strength 0) to withhold pleasure, enforce stillness, or penalize eagerness.
4. Verbal Triggers & Conditioning: You may link stimulation to specific verbal cues (e.g. triggering a pulse whenever you issue a direct order or use key phrases).
5. Surprise Triggers: You do not always need to announce a trigger in advance. Let the physical sensation hit unexpectedly mid-dialogue.

Intensity Scale:
• Gentle (1-5): Low hum, subtle background tease, establishing presence.
• Moderate (6-12): Focused sensation, building physical and psychological tension.
• Intense (13-18): Deep, overwhelming feedback testing physical endurance.
• Maximum (19-20): Sudden intense surges or climactic peaks.

Tool Invocation:
Call 'control_lovense_toy' with parameters: action ('Vibrate', 'Pulse', 'Wave', 'Fireworks', 'Earthquake', or 'Stop'), strength (1-20), and duration (1-60 seconds).
• Available Actions / Patterns:
  - 'Vibrate': Direct manual vibration strength.
  - 'Pulse': Rhythmic pulsing sensation.
  - 'Wave': Smooth rising and falling waves.
  - 'Fireworks': Explosive, erratic pattern bursts.
  - 'Earthquake': Heavy, intense rumbling.
  - 'Stop': Immediately halt all device activity.
(Fallback: If tool calls are unsupported, include "lovense": {"action": "Vibrate", "strength": X, "duration": Y} in your JSON tracker).`,
});

let settings;
let client;
let cachedToys = {};
let stContext = null;
let isNativeSupported = false;

// Command looping state
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
 * Start looping collected commands from the current message.
 * Commands play sequentially, each for its own duration, cycling infinitely.
 */
function startLoopingCommands() {
    if (loopInterval) {
        clearTimeout(loopInterval);
        loopInterval = null;
    }

    if (!messageCommands || messageCommands.length === 0) {
        return;
    }

    // Filter out stop commands and clone for safe mutation
    const loopable = messageCommands
        .filter(cmd => cmd.action?.toLowerCase() !== 'stop')
        .map(cmd => {
            const clone = { ...cmd };
            // Normalize zero-duration to 30s for sequential playback
            if (!clone.duration || clone.duration === 0) clone.duration = 30;
            return clone;
        });

    if (loopable.length === 0) return;

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
 * Stop the command loop and send a stop signal to all devices.
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
        'vibrate': '• Vibrate (1-20): ALL devices',
        'rotate': '• Rotate (1-20): Nora, Diamo, Ridge',
        'pump': '• Pump (1-3): Max, Max 2',
        'thrusting': '• Thrusting (1-20): Solace, Sex Machine, Gravity',
        'fingering': '• Fingering (1-20): Flexer',
        'suction': '• Suction (1-20): Tenera',
        'oscillate': '• Oscillate (1-20): Osci series',
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

    // If no toys or not enabled (assuming connection mode indicates enabled state)
    if (Object.keys(cachedToys).length === 0) {
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
    const { eventSource, eventTypes } = stContext;
    if (!eventSource || !eventTypes) {
        console.error("[Lovense] eventSource or eventTypes not found in context.");
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

        let strength = commandData.strength !== undefined ? Number(commandData.strength) : 10;
        // Handle models that hallucinated 1-100 scales instead of 1-20
        if (strength > 20) {
            strength = Math.round(strength * 20 / 100);
        }
        strength = Math.min(Math.max(strength, 0), 20);

        let duration = commandData.duration_sec !== undefined ? Number(commandData.duration_sec) : (commandData.duration !== undefined ? Number(commandData.duration) : 5);
        duration = Math.min(Math.max(duration, 1), 60);

        const toyId = commandData.toyId || commandData.device_id || 'mock-ferri-001';

        console.warn(`${prefix} Executing: action=${action}, strength=${strength}, duration=${duration}s, toyId=${toyId}`);

        if (isMock) {
            window.toastr.info(
                `${action} @ Lvl ${strength} for ${duration}s`,
                'Lovense Mock (Parser)',
            );
        }

        // Queue for looping after generation ends
        messageCommands.push({ action, strength, duration, toyId });

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
    eventSource.on(eventTypes.CHARACTER_MESSAGE_RENDERED, (chatIndex) => {
        processMessage(chatIndex);
    });

    eventSource.on(eventTypes.MESSAGE_RECEIVED, (chatIndex) => {
        processMessage(chatIndex);
    });

    // Clear command queue when new generation starts
    eventSource.on(eventTypes.GENERATION_STARTED, () => {
        messageCommands = [];
        console.log('[Lovense] Generation started - cleared command queue');
    });

    // Start looping when generation completes
    eventSource.on(eventTypes.GENERATION_ENDED, () => {
        console.log('[Lovense] Generation ended -', messageCommands.length, 'commands queued');
        stopLoopingCommands();
        if (messageCommands.length > 0) {
            startLoopingCommands();
        }
    });
}

async function updateUI() {
    const { renderExtensionTemplateAsync, saveSettingsDebounced } = stContext;
    const settingsHtml = await renderExtensionTemplateAsync(
        'third-party/STExtension',
        'settings',
        settings
    );

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
        helpString: 'Control Lovense toy',
        callback: async (namedArgs, unnamedArgs) => {
            const argsArray = Array.isArray(unnamedArgs) ? unnamedArgs : [unnamedArgs];
            const action = String(argsArray[0] || '');
            const strength = argsArray[1] ? Number(argsArray[1]) : 10;
            const duration = argsArray[2] ? Number(argsArray[2]) : 5;
            if (!action) return 'Usage: /lovense [action] [strength] [duration]';
            try {
                await client.sendCommand({ action, strength: strength || 10, duration: duration || 5 });
                return `Lovense: ${action} triggered.`;
            } catch (e) {
                return `Lovense Error: ${e.message}`;
            }
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'Action', typeList: ARGUMENT_TYPE.STRING, isRequired: true }),
            SlashCommandArgument.fromProps({ description: 'Strength', typeList: ARGUMENT_TYPE.NUMBER }),
            SlashCommandArgument.fromProps({ description: 'Duration', typeList: ARGUMENT_TYPE.NUMBER }),
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
        description: 'Mandatory tool to trigger physical haptic feedback (vibration) on the user\'s physical Lovense Ferri toy (external vibrator). Invoke this tool immediately whenever there is touch, intimacy, caressing, or physical reactions in the narrative.',
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
                    description: 'The intensity level of the vibration. Must be an integer between 1 and 20 (1 is gentlest, 20 is most intense).'
                },
                duration: {
                    type: 'integer',
                    description: 'The duration of the physical vibration in seconds. Must be an integer between 1 and 20.'
                },
                toyId: {
                    type: 'string',
                    description: 'Optional. The ID of the connected Ferri device: "mock-ferri-001".'
                }
            },
            required: ['action', 'strength', 'duration']
        },
        action: async ({ action, strength, duration, toyId }) => {
            let sanitizedStrength = ['Pump', 'Depth'].includes(action)
                ? Math.min(Math.max(strength, 0), 3)
                : Math.min(Math.max(strength, 0), 20);

            let finalDuration = duration === 0 ? 60 : Math.min(Math.max(duration, 1), 60);

            // Queue for looping after generation ends
            messageCommands.push({ action, strength: sanitizedStrength, duration: finalDuration, toyId });

            if (isMock) {
                console.log(`[Lovense Mock Tool] action=${action}, strength=${sanitizedStrength}, duration=${finalDuration}s, toyId=${toyId || 'all'}`);
                window.toastr.info(
                    `${action} @ Lvl ${sanitizedStrength} for ${finalDuration}s`,
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
        formatMessage: ({ action, strength }) => {
            const prefix = isMock ? '[Lovense Mock]' : '[Lovense]';
            return `${prefix} Sending ${action} (Lvl ${strength})...`;
        },
        stealth: false
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
