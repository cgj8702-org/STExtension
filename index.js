import { LovenseClient } from './lovense-client.js';

const { 
    extensionSettings, 
    saveSettingsDebounced, 
    renderExtensionTemplateAsync, 
    eventSource, 
    event_types,
    registerFunctionTool,
    isToolCallingSupported
} = SillyTavern.getContext();

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

function getSettings() {
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
 * Periodically update the toy cache for the prompt interceptor.
 */
async function updateToyCache() {
    if (!client) return;
    try {
        const toys = await client.getToys();
        if (!toys.error) {
            cachedToys = toys;
        }
    } catch (e) {
        console.warn("Lovense: Could not update toy cache.", e);
    }
}

/**
 * Prompt Interceptor: Tells the LLM which toys are connected and their capabilities.
 */
globalThis.injectLovenseContext = async function(chat, contextSize, abort, type) {
    const toyKeys = Object.keys(cachedToys);
    if (toyKeys.length === 0) return;

    const toyDescriptions = toyKeys.map(id => {
        const toy = cachedToys[id];
        return `- ${toy.name || id} (ID: ${id}): Status: ${toy.status == 1 ? 'Connected' : 'Disconnected'}, Battery: ${toy.battery ?? '?'}%`;
    }).join('\n');

    const systemNote = {
        is_user: false,
        name: "System Note (Lovense)",
        send_date: Date.now(),
        mes: `[SYSTEM INFO: The user has the following physical Lovense toy(s) active and connected:\n${toyDescriptions}\nEnsure that any touch, physical intimacy, or physical reactions in the narrative correspond realistically to these active devices. You can trigger physical haptic feedback by calling the 'control_lovense_toy' tool when the story or user actions dictate it.]`
    };

    // Insert the system note just before the user's latest message to keep it high-priority
    chat.splice(chat.length - 1, 0, systemNote);
};

/**
 * Formats API responses into narrative-friendly prompts for the LLM.
 */
function handleToolResponse(apiResponse, action, strength, duration) {
    if (apiResponse.code === 200 || apiResponse.result === true) {
        if (action.toLowerCase() === 'stop') {
            return JSON.stringify({
                status: "success",
                narrative_prompt: "The connected toy has successfully stopped. In your next response, describe the sudden transition to stillness and how the character or user relaxes."
            });
        }
        
        return JSON.stringify({
            status: "success",
            action_triggered: action,
            intensity: strength,
            duration: `${duration} seconds`,
            narrative_prompt: `The haptic device successfully executed the ${action} action at level ${strength} of intensity for ${duration} seconds. In your next turn, describe the physical sensations, warmth, vibrations, or mechanical movements the character or user experiences as a direct result of this physical stimulation.`
        });
    }

    const errorMessages = {
        401: "Toy not found. The specified device might be turned off or out of range.",
        402: "Toy not connected. Ensure the device is paired in the Lovense Connect app.",
        403: "Toy does not support this command. The user's active toy cannot perform this specific action.",
        404: "Invalid Parameter. Please check the intensity or duration range and try again."
    };
    const friendlyError = errorMessages[apiResponse.code] || `Server returned error code ${apiResponse.code}.`;

    return JSON.stringify({
        status: "failed",
        reason: friendlyError,
        narrative_prompt: `The physical command could not be delivered to the device (${friendlyError}). You may either gently mention the connection issue in character (e.g., a device losing connection or acting up) or continue the narrative normally without assuming the user felt the physical stimulation.`
    });
}

async function updateUI() {
    const settingsHtml = await renderExtensionTemplateAsync(
        'third-party/STExtension', 
        'settings', 
        settings
    );
    $('#extensions_settings2').append(settingsHtml);

    $('#lovense_connectionMode').on('change', (e) => {
        settings.connectionMode = e.target.value;
        toggleSettingsVisibility();
        saveSettingsDebounced();
    });

    $('#lovense_localPort').on('change', (e) => {
        settings.localPort = e.target.value;
        saveSettingsDebounced();
    });

    $('#lovense_localDomain').on('change', (e) => {
        settings.localDomain = e.target.value;
        saveSettingsDebounced();
    });

    $('#lovense_developerToken').on('change', (e) => {
        settings.developerToken = e.target.value;
        saveSettingsDebounced();
    });

    $('#lovense_userId').on('change', (e) => {
        settings.userId = e.target.value;
        saveSettingsDebounced();
    });

    $('#lovense_test_connection').on('click', async () => {
        const statusEl = $('#lovense_connection_status');
        statusEl.text('Testing...');
        try {
            const result = await client.getToys();
            if (result.error) {
                throw new Error(result.error);
            }
            statusEl.text('Status: Connected');
            toastr.success('Lovense connection successful!');
        } catch (e) {
            statusEl.text('Status: Disconnected');
            toastr.error(`Connection failed: ${e.message}`);
        }
    });

    toggleSettingsVisibility();
}

function toggleSettingsVisibility() {
    if (settings.connectionMode === 'local') {
        $('#lovense_local_settings').removeClass('hidden');
        $('#lovense_server_settings').addClass('hidden');
    } else {
        $('#lovense_local_settings').addClass('hidden');
        $('#lovense_server_settings').removeClass('hidden');
    }
}

function registerLovenseSlashCommands() {
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'lovense',
        description: 'Control Lovense toy',
        callback: async (namedArgs, unnamedArgs) => {
            const [action, strength, duration] = unnamedArgs;
            if (!action) return 'Usage: /lovense [action] [strength] [duration]';
            
            try {
                const response = await client.sendCommand({ 
                    action, 
                    strength: strength || 10, 
                    duration: duration || 5 
                });
                return `Lovense: ${action} at strength ${strength || 10} for ${duration || 5}s.`;
            } catch (e) {
                return `Lovense Error: ${e.message}`;
            }
        },
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'Action (Vibrate, Rotate, Pump, Stop)', typeList: ARGUMENT_TYPE.STRING, isRequired: true }),
            SlashCommandArgument.fromProps({ description: 'Strength (1-20)', typeList: ARGUMENT_TYPE.NUMBER }),
            SlashCommandArgument.fromProps({ description: 'Duration (seconds)', typeList: ARGUMENT_TYPE.NUMBER }),
        ],
        helpString: '<div>Control your Lovense toy manually.</div><div><strong>Example:</strong> /lovense Vibrate 15 5</div>',
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
    if (!isToolCallingSupported()) {
        console.log("Lovense: Tool calling not supported by current API source.");
        return;
    }

    registerFunctionTool({
        name: 'control_lovense_toy',
        displayName: 'Control Lovense Toy',
        description: 'Triggers physical haptic feedback on the user\'s connected Lovense toy based on the narrative or intimate actions in the chat.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['Vibrate', 'Rotate', 'Pump', 'Thrusting', 'Fingering', 'Suction', 'Depth', 'All', 'Stop'],
                    description: 'The physical action type. Use Vibrate for standard vibrations. Use Rotate/Thrusting/Fingering/Suction/Depth only if the connected toy supports it. Use Stop to halt all motion.'
                },
                strength: {
                    type: 'integer',
                    description: 'The intensity level. CRITICAL: For Vibrate, Rotate, Thrusting, Fingering, Suction, and All, the range is 1 to 20. For Pump and Depth, the range is strictly 1 to 3. Use 0 to stop.'
                },
                duration: {
                    type: 'integer',
                    description: 'The duration of the action in seconds (1 to 20). Use 0 for continuous/indefinite running.'
                },
                toyId: {
                    type: 'string',
                    description: 'Optional. The specific Toy ID to control. If omitted, the command applies to all connected toys.'
                }
            },
            required: ['action', 'strength', 'duration']
        },
        action: async ({ action, strength, duration, toyId }) => {
            let sanitizedStrength = strength;
            if (['Pump', 'Depth'].includes(action)) {
                sanitizedStrength = Math.min(Math.max(strength, 0), 3);
            } else {
                sanitizedStrength = Math.min(Math.max(strength, 0), 20);
            }

            let finalDuration = duration;
            if (duration === 0) {
                finalDuration = 60; 
            } else {
                finalDuration = Math.min(Math.max(duration, 1), 60);
            }

            try {
                const response = await client.sendCommand({ 
                    action, 
                    strength: sanitizedStrength, 
                    duration: finalDuration, 
                    toyId 
                });
                return handleToolResponse(response, action, sanitizedStrength, finalDuration);
            } catch (error) {
                return JSON.stringify({
                    status: "error",
                    message: `Failed to connect to Lovense local server: ${error.message}. Please remind the user to check their connection.`
                });
            }
        },
        formatMessage: ({ action, strength }) => `[Lovense] Sending ${action} command (Level ${strength})...`,
        stealth: false
    });
}

export async function onActivate() {
    settings = getSettings();
    client = new LovenseClient(settings);

    await updateUI();
    registerLovenseSlashCommands();
    registerLovenseTools();

    await updateToyCache();
    setInterval(updateToyCache, 30000);

    console.log('Lovense Toy Integration activated');
}
