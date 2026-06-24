import { LovenseClient } from './lovense-client.js';

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
            return `- ${toy.name || id} (ID: ${id}): Status: ${toy.status === "1" ? 'Connected' : 'Disconnected'}, Battery: ${toy.battery ?? '?'}%`;
        }).join('\n');

        const stateNote = {
            is_user: false,
            name: "System Note (Lovense State)",
            send_date: Date.now(),
            mes: `[SYSTEM INFO: The user has the following physical Lovense toy(s) active and connected:\n${toyDescriptions}\nEnsure that any touch, physical intimacy, or physical reactions in the narrative correspond realistically to these active devices.]`
        };
        chat.splice(chat.length - 1, 0, stateNote);
    }

    // 2. Inject Fallback Instructions (Only if native tool calling is unsupported)
    if (!isNativeSupported) {
        const fallbackInstruction = {
            is_user: false,
            name: "System Note (Lovense Instructions)",
            send_date: Date.now(),
            mes: `[LOVENSE SYSTEM INSTRUCTION: If the current narrative, action, or intimacy warrants physical haptic feedback, you must append the following exact code block to the very end of your response. Substitute your desired values:\`\`\`lovense\n{\n  "action": "Vibrate", // Options: Vibrate, Rotate, Pump, Stop\n  "strength": 10,       // Intensity (1-20 for Vibrate/Rotate, 1-3 for Pump)\n  "duration_sec": 5     // Duration in seconds (1-20)\n}\`\`\`\nDo not write any narrative text after this block. If no physical stimulation is happening in this turn, do not append the block.]`
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

/**
 * Fallback Path: Parser hook to catch, execute, and remove Markdown-JSON blocks.
 */
function registerParserHook(lovenseClient) {
    const { messageFormatter } = stContext;
    if (!messageFormatter) {
        console.error("[Lovense] messageFormatter not found in context.");
        return;
    }

    messageFormatter.addHook((mes, ctx) => {
        // Skip user-sent messages
        if (ctx.isUser) return mes;

        // Regex to search for the custom lovense code block
        const lovenseRegex = /```lovense\s*([\s\S]*?)\s*```/g;
        let match;
        
        // Extract and execute all commands found in the message
        while ((match = lovenseRegex.exec(mes)) !== null) {
            try {
                const commandData = JSON.parse(match[1]);
                console.log("[Lovense Fallback] Captured command payload:", commandData);
                
                lovenseClient.sendCommand({
                    action: commandData.action,
                    strength: commandData.strength,
                    duration: commandData.duration_sec
                }).catch(e => console.error("[Lovense Fallback] Command failed:", e));
            } catch (e) {
                console.error("[Lovense Fallback] Failed to parse JSON command block:", e);
            }
        }

        // Clean the code block out of the text so it never displays in the chat UI
        return mes.replace(lovenseRegex, '').trim();
    }, {
        stage: (messageFormatter.stage || { BEFORE_REGEX: 0 })?.BEFORE_REGEX || 0,
        order: (messageFormatter.order || { EARLY: 0 })?.EARLY || 0
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
    container.append(settingsHtml);

    window.$('#lovense_connectionMode').on('change', (e) => {
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
        const statusEl = window.$('#lovense_connection_status');
        statusEl.text('Testing...');
        try {
            const result = await client.getToys();
            if (result.error) throw new Error(result.error);
            statusEl.text('Status: Connected');
            window.toastr.success('Lovense connection successful!');
        } catch (e) {
            statusEl.text('Status: Disconnected');
            window.toastr.error(`Connection failed: ${e.message}`);
        }
    });

    toggleSettingsVisibility();
}

function toggleSettingsVisibility() {
    if (settings.connectionMode === 'local') {
        window.$('#lovense_local_settings').removeClass('hidden');
        window.$('#lovense_server_settings').addClass('hidden');
    } else {
        window.$('#lovense_local_settings').addClass('hidden');
        window.$('#lovense_server_settings').removeClass('hidden');
    }
}

function registerLovenseSlashCommands() {
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = window;
    
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

    registerFunctionTool({
        name: 'control_lovense_toy',
        displayName: 'Control Lovense Toy',
        description: 'Triggers physical haptic feedback on the user\'s connected Lovense toy.',
        parameters: {
            type: 'object',
            properties: {
                action: { 
                    type: 'string', 
                    enum: ['Vibrate', 'Rotate', 'Pump', 'Thrusting', 'Fingering', 'Suction', 'Depth', 'All', 'Stop'] 
                },
                strength: { type: 'integer' },
                duration: { type: 'integer' },
                toyId: { type: 'string' }
            },
            required: ['action', 'strength', 'duration']
        },
        action: async ({ action, strength, duration, toyId }) => {
            let sanitizedStrength = ['Pump', 'Depth'].includes(action) 
                ? Math.min(Math.max(strength, 0), 3) 
                : Math.min(Math.max(strength, 0), 20);
            
            let finalDuration = duration === 0 ? 60 : Math.min(Math.max(duration, 1), 60);

            try {
                const response = await client.sendCommand({ action, strength: sanitizedStrength, duration: finalDuration, toyId });
                return handleToolResponse(response, action, sanitizedStrength, finalDuration);
            } catch (error) {
                return JSON.stringify({ status: "error", message: error.message });
            }
        },
        formatMessage: ({ action, strength }) => `[Lovense] Sending ${action} (Lvl ${strength})...`,
        stealth: false
    });
}

export async function onActivate() {
    try {
        stContext = window.SillyTavern.getContext();
        if (!stContext) throw new Error("SillyTavern context not found.");

        settings = getSettings();
        client = new LovenseClient(settings);

        // Detect native tool support
        isNativeSupported = stContext.isToolCallingSupported();
        console.log(`[Lovense] Native Tool Calling supported: ${isNativeSupported}`);

        await updateUI();
        registerLovenseSlashCommands();

        if (isNativeSupported) {
            console.log("[Lovense] Registering native tool path...");
            registerLovenseTools();
        } else {
            console.log("[Lovense] Enabling fallback pipeline...");
            registerParserHook(client);
        }

        await updateToyCache();
        setInterval(updateToyCache, 30000);

        console.log('Lovense Toy Integration activated successfully');
    } catch (e) {
        console.error('Lovense Toy Integration failed to activate:', e);
    }
}
