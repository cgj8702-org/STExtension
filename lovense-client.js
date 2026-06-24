export class LovenseClient {
    constructor(settings) {
        this.settings = settings;
    }

    get isLocal() {
        return this.settings.connectionMode === 'local';
    }

    async sendCommand({ action, strength, duration, toyId = null }) {
        if (this.isLocal) {
            return this.sendLocalCommand(action, strength, duration, toyId);
        } else {
            return this.sendServerCommand(action, strength, duration, toyId);
        }
    }

    async sendLocalCommand(action, strength, duration, toyId) {
        const url = `https://${this.settings.localDomain || '127-0-0-1.lovense.club'}:${this.settings.localPort || '30010'}/command`;
        
        let payload = {
            command: "Function",
            action: `${action}:${strength}`,
            timeSec: duration,
            apiVer: 1
        };

        if (action.toLowerCase() === 'stop') {
            payload.action = "Stop";
            payload.timeSec = 0;
        }

        if (toyId) payload.toy = toyId;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return response.json();
    }

    async sendServerCommand(action, strength, duration, toyId) {
        const url = 'https://api.lovense-api.com/api/lan/v2/command';
        
        let payload = {
            token: this.settings.developerToken,
            uid: this.settings.userId,
            command: "Function",
            action: `${action}:${strength}`,
            timeSec: duration,
            apiVer: 1
        };

        if (action.toLowerCase() === 'stop') {
            payload.action = "Stop";
            payload.timeSec = 0;
        }

        if (toyId) payload.toy = toyId;

        const response = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        return response.json();
    }

    async getToys() {
        if (!this.isLocal) {
            return { error: "Toy query only fully supported in Local Mode" };
        }
        
        const url = `https://${this.settings.localDomain || '127-0-0-1.lovense.club'}:${this.settings.localPort || '30010'}/command`;
        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: "GetToys" })
            });
            const result = await response.json();
            return JSON.parse(result.data?.toys || '{}');
        } catch (e) {
            console.error("Failed to query local Lovense toys:", e);
            throw e;
        }
    }
}