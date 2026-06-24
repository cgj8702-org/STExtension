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

/**
 * Structured Output Schema for high-reliability haptic responses.
 */

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
 * Prompt Interceptor: Tells the LLM which toys are connected.
 * Exported to window to be accessible by SillyTavern.
 */
window.injectLovenseContext = async function(chat, contextSize, abort, type) {
    if (!Array.isArray(chat) || chat.length === 0) return;
    
    const toyKeys = Object.keys(cachedToys);
    if (toyKeys.length === 0) return;

    const toyDescriptions = toyKeys.map(id => {
        const toy = cachedToys[id];
        return `- ${toy.name || id} (ID: ${id}): Status: ${toy.status === "1" ? 'Connected' : 'Disconnected'}, Battery: ${toy.battery ?? '?'}%`;
    }).join('\n');

    const systemNote = {
        is_user: false,
        name: "System Note (Lovense)",
        send_date: Date.now(),
        mes: `[SYSTEM INFO: The user has the following physical Lovense toy(s) active and connected:\n${toyDescriptions}\nEnsure that any touch, physical intimacy, or physical reactions in the narrative correspond realistically to these active devices.]`
    };

    chat.splice(chat.length - 1, 0, systemNote);
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
        // Use window.SillyTavern to avoid linting errors and ensure global access
        stContext = window.SillyTavern.getContext();
        if (!stContext) throw new Error("SillyTavern context not found.");

        settings = getSettings();
        client = new LovenseClient(settings);

        await updateUI();
        registerLovenseSlashCommands();
        registerLovenseTools();

        await updateToyCache();
        setInterval(updateToyCache, 30000);

        console.log('Lovense Toy Integration activated successfully');
    } catch (e) {
        console.error('Lovense Toy Integration failed to activate:', e);
    }
}
