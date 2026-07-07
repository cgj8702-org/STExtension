/**
 * Helper to retry a fetch request.
 * @param {string} url 
 * @param {object} options 
 * @param {number} retries 
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options, retries = 3) {
    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url, options);
            if (!response.ok) {
                // If it's a 4xx error, don't retry (client error)
                if (response.status >= 400 && response.status < 500) {
                    return response;
                }
                // Otherwise, throw to trigger retry for 5xx or network errors
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response;
        } catch (err) {
            if (i === retries - 1) throw err;
            console.warn(`[Lovense] Fetch failed, retrying (${i + 1}/${retries})...`, err);
            await new Promise(res => setTimeout(res, 1000 * (i + 1))); // Exponential backoff-ish
        }
    }
}

/**
 * Map Lovense error codes to human-readable messages.
 */
const LOVENSE_ERROR_MAP = {
    500: "HTTP server not started or disabled",
    400: "Invalid Command",
    401: "Toy Not Found",
    402: "Toy Not Connected",
    403: "Toy Doesn't Support This Command",
    404: "Invalid Parameter",
    506: "Server Error. Restart Lovense Connect.",
    501: "Invalid token",
    502: "You do not have permission to use this API",
    503: "Invalid User ID",
    507: "Lovense APP is offline"
};

function getErrorMessage(code) {
    return LOVENSE_ERROR_MAP[code] || `Unknown Error (Code: ${code})`;
}

/**
 * Helper to send a raw Lovense command payload respecting the selected mode.
 * Supports both local (proxied) and server API calls.
 */
async function sendLovenseCommand(payload, settings) {
    if (!settings.enabled) return;

    if (settings.mode === 'mock') {
        console.log(`[Lovense React Mock] Payload received:`, payload);
        const latency = 150 + Math.floor(Math.random() * 250);
        await new Promise(resolve => setTimeout(resolve, latency));
        return { code: 200, result: true };
    }

    let url;
    let fetchOptions;

    if (settings.mode === 'local') {
        // Default for PC/Mac if localUrl is empty
        let targetUrl = settings.localUrl;
        if (!targetUrl) {
            targetUrl = "127-0-0-1.lovense.club:30010";
        }
        
        url = `/api/plugins/lovense/command`;
        fetchOptions = {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                url: targetUrl,
                ...payload
            })
        };
    } else if (settings.mode === 'server') {
        if (!settings.developerToken || !settings.uid) {
            throw new Error("[Lovense] Server mode missing developerToken or uid.");
        }
        url = "https://api.lovense-api.com/api/lan/v2/command";
        
        // Append authentication fields required for server API.
        // Note: settings.uid can be a comma-separated list of UIDs for multi-user support.
        const serverPayload = { 
            token: settings.developerToken, 
            uid: settings.uid, 
            ...payload 
        };

        fetchOptions = {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(serverPayload)
        };
    }

    try {
        const response = await fetchWithRetry(url, fetchOptions);
        const data = await response.json();

        // Handle successful responses. Lovense uses 0 or 200.
        const isSuccess = (data.code === 200 || data.code === 0) && data.result !== false;

        if (!isSuccess) {
            throw new Error(getErrorMessage(data.code) || data.message || "API Error");
        }
        return data;
    } catch (err) {
        console.error("[Lovense] Error sending command:", err);
        throw err;
    }
}

/**
 * Trigger a basic Function command (Vibrate, Rotate, etc.).
 * `action` should be a string like "Vibrate:12" or "Vibrate:12,Rotate:5".
 * `options` can contain optional fields: timeSec, loopRunningSec, loopPauseSec,
 * toy (toy ID), stopPrevious (0 or 1), apiVer (default 1).
 */
export async function triggerFunction(action, options = {}, settings) {
    const payload = {
        command: "Function",
        action,
        timeSec: options.timeSec ?? 3,
        apiVer: options.apiVer ?? 1
    };
    if (options.loopRunningSec) payload.loopRunningSec = options.loopRunningSec;
    if (options.loopPauseSec) payload.loopPauseSec = options.loopPauseSec;
    if (options.toy) payload.toy = options.toy;
    if (options.stopPrevious !== undefined) payload.stopPrevious = options.stopPrevious;
    await sendLovenseCommand(payload, settings);
}

/**
 * Send a command to stop all toys.
 */
export async function stopAllToys(options = {}, settings) {
    await triggerFunction("Stop", { timeSec: 0, ...options }, settings);
}

/**
 * Retrieve the list of toys for the current session.
 * Returns a promise that resolves to the parsed toy object.
 */
export async function getToys(settings) {
    if (settings.mode === 'mock') {
        console.log("[Lovense React Mock] Returning simulated toy list");
        return {
            'mock-ferri-001': {
                name: 'Ferri',
                id: 'mock-ferri-001',
                status: '1',
                battery: 94,
                type: 'ferri',
                version: '',
                nickName: 'My Ferri',
            },
        };
    }

    const payload = { command: "GetToys" };
    const data = await sendLovenseCommand(payload, settings);
    
    if (data && data.data && data.data.toys) {
        try {
            // The API sometimes returns a JSON string for toys.
            return typeof data.data.toys === 'string' ? JSON.parse(data.data.toys) : data.data.toys;
        } catch (_) {
            return data.data.toys;
        }
    }
    return null;
}

/**
 * Retrieve only the toy names.
 */
export async function getToyNames(settings) {
    if (settings.mode === 'mock') {
        return ['Ferri'];
    }

    const payload = { command: "GetToyName" };
    const data = await sendLovenseCommand(payload, settings);
    if (data && Array.isArray(data.data)) {
        return data.data;
    }
    return null;
}

/**
 * Send a Pattern command.
 * `rule` – the rule string (e.g. "V:1;F:v,r,p;S:1000#").
 * `strength` – semicolon‑separated strength list.
 * `options` may include timeSec, toy, apiVer (default 2).
 */
export async function sendPattern(rule, strength, options = {}, settings) {
    const payload = {
        command: "Pattern",
        rule,
        strength,
        timeSec: options.timeSec ?? 9,
        apiVer: options.apiVer ?? 2
    };
    if (options.toy) payload.toy = options.toy;
    await sendLovenseCommand(payload, settings);
}

/**
 * Send a Preset command.
 * `name` – one of "pulse", "wave", "fireworks", "earthquake".
 * `options` may include timeSec, toy, apiVer (default 1).
 */
export async function sendPreset(name, options = {}, settings) {
    const payload = {
        command: "Preset",
        name,
        timeSec: options.timeSec ?? 9,
        apiVer: options.apiVer ?? 1
    };
    if (options.toy) payload.toy = options.toy;
    await sendLovenseCommand(payload, settings);
}

/**
 * Backwards‑compatible wrapper used by existing code.
 * It maps the old `pattern`/`intensity` signature to a simple Vibrate Function.
 */
export async function triggerDeviceHaptic(pattern, intensity, settings) {
    const baseStrength = intensity === "high" ? 20 : intensity === "medium" ? 12 : 5;
    const scaledStrength = Math.max(1, Math.floor(baseStrength * (settings.strengthScale / 100)));

    let action = `Vibrate:${scaledStrength}`;
    let timeSec = 3;
    if (pattern === 'thinking') {
        timeSec = 2;
    } else if (pattern === 'success') {
        timeSec = 5;
    } else if (pattern === 'mistake') {
        timeSec = 1;
    } else if (pattern === 'blunder') {
        timeSec = 4;
        action = `Vibrate:${scaledStrength},All:${Math.max(1, scaledStrength - 5)}`;
    } else if (pattern === 'empathy') {
        timeSec = 3;
    }

    await triggerFunction(action, { timeSec }, settings);
}
