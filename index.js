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

async function updateUI() {
    const settingsHtml = await renderExtensionTemplateAsync(
        'third-party/STExtension', 
        'settings', 
        settings
    );
    $('#extensions_settings2').append(settingsHtml);

    // Bind inputs
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
        description: 'Sends a physical command (vibration, rotation, air pump contraction, etc.) to the user\'s connected Lovense adult toy. Use this to provide real-time haptic feedback or physical responses based on intimate, romantic, or exciting narrative events in the chat.',
        parameters: {
            $schema: 'http://json-schema.org/draft-04/schema#',
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['Vibrate', 'Rotate', 'Pump', 'Stop', 'All'],
                    description: 'The physical action type. Select Vibrate for vibrations, Rotate for internal rotation, Pump for air contractions, All to trigger everything, or Stop to cease all motion.'
                },
                strength: {
                    type: 'integer',
                    description: 'The intensity level. For Vibrate, Rotate, and All, the range is 1 (weakest) to 20 (strongest). For Pump, the range is 1 to 3. Use 0 to stop.'
                },
                duration: {
                    type: 'integer',
                    description: 'The duration of the action in seconds. Choose a value between 1 and 20 seconds. Use 0 for an indefinite run.'
                }
            },
            required: ['action', 'strength', 'duration']
        },
        action: async ({ action, strength, duration }) => {
            try {
                const response = await client.sendCommand({ action, strength, duration });
                if (response.code === 200 || response.result === true) {
                    return `Successfully triggered toy: ${action} at strength ${strength} for ${duration}s.`;
                } else {
                    return `Toy command failed: ${response.message || 'Unknown error'}`;
                }
            } catch (error) {
                return `Error connecting to Lovense: ${error.message}`;
            }
        },
        formatMessage: ({ action, strength }) => `[Lovense] Sending ${action} (Level ${strength})...`,
        stealth: false
    });
}

export async function onActivate() {
    settings = getSettings();
    client = new LovenseClient(settings);

    await updateUI();
    registerLovenseSlashCommands();
    registerLovenseTools();

    console.log('Lovense Toy Integration activated');
}