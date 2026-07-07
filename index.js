import { LovenseClient } from './lovense-client.js?v=11';
import { SlashCommandParser } from '../../../slash-commands/SlashCommandParser.js';
import { SlashCommand } from '../../../slash-commands/SlashCommand.js';
import { SlashCommandArgument, ARGUMENT_TYPE } from '../../../slash-commands/SlashCommandArgument.js';

const MODULE_NAME = 'lovense_integration';
const defaultSettings = Object.freeze({
    connectionMode: 'local',
    localPort: '30010',
    localDomain: '127-0-0-1.lovense.club',
    developerToken: '',
    userId: '',
});

let settings;
let client;
let cachedToys = {};
let stContext = null;
let isNativeSupported = false;

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

async function updateToyCache() {
    if (!client) return;
    try {
        const toys = await client.getToys();
        if (toys && !toys.error) {
            cachedToys = toys;
        }
    } catch (e) {
        console.warn("[Lovense] Could not update toy cache:", e);
    }
}

/**
 * Prompt Interceptor: Injects state awareness (toy list) and, 
 * if native tools are unsupported, provides formatting instructions for fallback.
 */
window.injectLovenseContext = async function(chat, contextSize, abort, type) {
    if (!Array.isArray(chat) || chat.length === 0) return;
    
    // 1. Inject Toy State Awareness (Always)
    const toyKeys = Object.keys(cachedToys);
    if (toyKeys.length > 0) {
        const toyDescriptions = toyKeys.map(id => {
            const toy = cachedToys[id];
            return `- ${toy.name || id} (ID: ${id}): Status: ${toy.status === "1" ? 'Connected' : 'Disconnected'}, Battery: ${toy.battery ?? '?'}% (Type: External Vibrator, placed on user's panties/clitoris)`;
        }).join('\n');

        const stateNote = {
            is_user: false,
            name: "System Note (Lovense State)",
            send_date: Date.now(),
            mes: `[SYSTEM INFO: The user has the following physical Lovense device active and connected:\n${toyDescriptions}\nEnsure that any physical caressing, touch, or reactions in the narrative correspond realistically to this device.]`
        };
        chat.splice(chat.length - 1, 0, stateNote);
    }

    // 2. Inject explicit instructions based on tool calling capability
    if (isNativeSupported) {
        const toolInstruction = {
            is_user: false,
            name: "System Note (Lovense Tool Instruction)",
            send_date: Date.now(),
            mes: `[LOVENSE SYSTEM INSTRUCTION: You have access to the tool 'control_lovense_toy' to control the user's active physical Lovense device (Ferri: external vibrator).
Whenever there is physical contact, touch, caressing, or intimacy in the narrative, you MUST call 'control_lovense_toy'.
Required parameters:
- 'action': 'Vibrate' (or 'Stop')
- 'strength': Integer from 1 to 20
- 'duration': Integer from 1 to 20 seconds
- 'toyId': 'mock-ferri-001'

Alternatively, you can trigger the device by adding a "lovense" key to the character object inside your JSON tracker block at the start of your response. Example format to add to your character tracker:
"lovense": {
  "action": "Vibrate",
  "strength": 8, // Intensity (1-20)
  "duration": 12 // Duration in seconds (1-20)
}
If no physical stimulation is occurring in this turn, omit the "lovense" key from your tracker.]`
        };
        chat.splice(chat.length - 1, 0, toolInstruction);
    } else {
        const fallbackInstruction = {
            is_user: false,
            name: "System Note (Lovense Instructions)",
            send_date: Date.now(),
            mes: `[LOVENSE SYSTEM INSTRUCTION: If the current narrative, action, or intimacy warrants physical haptic feedback, you MUST trigger physical stimulation by adding a "lovense" key to the character object inside your JSON tracker block at the start of your response. Example format:
"lovense": {
  "action": "Vibrate",
  "strength": 8, // Intensity (1-20)
  "duration": 12 // Duration in seconds (1-20)
}
If you do not use the JSON tracker block, you MUST append a standalone Markdown JSON code block to the very end of your response:
\`\`\`lovense
{
  "action": "Vibrate",
  "strength": 10,
  "duration_sec": 5,
  "toyId": "mock-ferri-001"
}
\`\`\`]`
        };
        chat.splice(chat.length - 1, 0, fallbackInstruction);
    }
};

function handleToolResponse(apiResponse, action, strength, duration) {
    if (apiResponse.code === 200 || apiResponse.result === true) {
        if (action.toLowerCase() === 'stop') {
            return JSON.stringify({
                status: "success",
                narrative_prompt: "The connected toy has successfully stopped. Describe the transition to stillness."
            });
        }
        return JSON.stringify({
            status: "success",
            narrative_prompt: `The haptic device executed ${action} at level ${strength} for ${duration}s. Describe the physical sensations.`
        });
    }
    return JSON.stringify({
        status: "failed",
        reason: `API Error ${apiResponse.code}`,
        narrative_prompt: "The physical command failed. Continue narrative without assuming stimulation."
    });
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
        description: 'Control Lovense toy',
        callback: async (namedArgs, unnamedArgs) => {
            const [action, strength, duration] = unnamedArgs;
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
        description: 'Stop all Lovense toys',
        callback: async () => {
            try {
                await client.sendCommand({ action: 'Stop', strength: 0, duration: 0 });
                return 'Lovense: All toys stopped.';
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
                    enum: ['Vibrate', 'Stop'],
                    description: 'The movement command to execute. Choose "Vibrate" to trigger vibrations. Choose "Stop" to halt all activity.'
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

            if (isMock) {
                console.log(`[Lovense Mock Tool] action=${action}, strength=${sanitizedStrength}, duration=${finalDuration}s, toyId=${toyId || 'all'}`);
                window.toastr.info(
                    `${action} @ Lvl ${sanitizedStrength} for ${finalDuration}s`,
                    'Lovense Mock (Tool Call)',
                );
            }

            try {
                const response = await client.sendCommand({ action, strength: sanitizedStrength, duration: finalDuration, toyId });
                return handleToolResponse(response, action, sanitizedStrength, finalDuration);
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
        if (!isMock) {
            setInterval(updateToyCache, 30000);
        }

        console.log('Lovense Toy Integration activated successfully');
    } catch (e) {
        console.error('Lovense Toy Integration failed to activate:', e);
    }
}
