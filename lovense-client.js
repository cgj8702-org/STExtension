export class LovenseClient {
    constructor(settings) {
        this.settings = settings;
    }

    get isLocal() {
        return this.settings.connectionMode === 'local';
    }

    get isMock() {
        return this.settings.connectionMode === 'mock';
    }

    async sendCommand({ action, strength, duration, toyId = null }) {
        if (this.isMock) {
            return this.sendMockCommand(action, strength, duration, toyId);
        } else if (this.isLocal) {
            return this.sendLocalCommand(action, strength, duration, toyId);
        } else {
            return this.sendServerCommand(action, strength, duration, toyId);
        }
    }

    async sendMockCommand(action, strength, duration, toyId) {
        const payload = { action, strength, duration, toyId };
        console.log(
            `[Lovense Mock] Command received:`,
            `action=${action}, strength=${strength}, duration=${duration}s, toyId=${toyId || 'all'}`,
        );
        console.table(payload);

        // Simulate realistic API latency (150-400ms)
        const latency = 150 + Math.floor(Math.random() * 250);
        await new Promise(resolve => setTimeout(resolve, latency));

        console.log(`[Lovense Mock] Command executed successfully (simulated ${latency}ms latency)`);
        return { code: 200, result: true, type: 'mock' };
    }

    getLocalUrl(endpoint = '/command') {
        let domain = (this.settings.localDomain || '127-0-0-1.lovense.club').trim();
        const port = (this.settings.localPort || '30010').toString().trim();

        let protocol = 'https:';
        if (domain.startsWith('http://')) {
            protocol = 'http:';
            domain = domain.slice(7);
        } else if (domain.startsWith('https://')) {
            protocol = 'https:';
            domain = domain.slice(8);
        }

        domain = domain.replace(/\/+$/, '');

        if (domain.includes(':')) {
            return `${protocol}//${domain}${endpoint}`;
        }
        return `${protocol}//${domain}:${port}${endpoint}`;
    }

    async sendLocalCommand(action, strength, duration, toyId) {
        const url = this.getLocalUrl('/command');
        const lowerAction = action.toLowerCase();
        const presets = ['pulse', 'wave', 'fireworks', 'earthquake'];
        
        let payload;
        if (presets.includes(lowerAction)) {
            payload = {
                command: "Preset",
                name: lowerAction,
                timeSec: duration,
                apiVer: 1
            };
        } else if (lowerAction === 'stop') {
            payload = {
                command: "Function",
                action: "Stop",
                timeSec: 0,
                apiVer: 1
            };
        } else {
            payload = {
                command: "Function",
                action: `${action}:${strength}`,
                timeSec: duration,
                apiVer: 1
            };
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
        const lowerAction = action.toLowerCase();
        const presets = ['pulse', 'wave', 'fireworks', 'earthquake'];
        
        let payload = {
            token: this.settings.developerToken,
            uid: this.settings.userId,
            apiVer: 1
        };

        if (presets.includes(lowerAction)) {
            payload.command = "Preset";
            payload.name = lowerAction;
            payload.timeSec = duration;
        } else if (lowerAction === 'stop') {
            payload.command = "Function";
            payload.action = "Stop";
            payload.timeSec = 0;
        } else {
            payload.command = "Function";
            payload.action = `${action}:${strength}`;
            payload.timeSec = duration;
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
        if (this.isMock) {
            return this.getMockToys();
        }

        if (!this.isLocal) {
            return { error: "Toy query only fully supported in Local Mode" };
        }
        
        const url = this.getLocalUrl('/command');
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 4000);

            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ command: "GetToys" }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);

            if (!response.ok) {
                return { error: `HTTP ${response.status}: ${response.statusText}` };
            }

            const result = await response.json();
            let toys = result.data?.toys;
            if (typeof toys === 'string') {
                try {
                    toys = JSON.parse(toys);
                } catch {
                    toys = {};
                }
            } else if (!toys || typeof toys !== 'object') {
                toys = {};
            }
            return toys;
        } catch (e) {
            return { error: e.name === 'AbortError' ? 'Connection timed out' : (e.message || String(e)) };
        }
    }

    async testConnection() {
        if (this.isMock) {
            const toys = this.getMockToys();
            return { ok: true, mode: 'mock', toys, count: Object.keys(toys).length };
        }

        if (this.isLocal) {
            const result = await this.getToys();
            if (result && !result.error) {
                const count = Object.keys(result).length;
                return { ok: true, mode: 'local', toys: result, count };
            }
            return { ok: false, mode: 'local', error: result?.error || 'Could not connect to Lovense daemon' };
        }

        // Server mode
        if (!this.settings.developerToken || !this.settings.userId) {
            return { ok: false, mode: 'server', error: 'Developer Token and User ID are required for Server Mode.' };
        }

        try {
            const res = await this.sendCommand({ action: 'Stop', strength: 0, duration: 0 });
            if (res.code === 200 || res.result === true) {
                return { ok: true, mode: 'server', message: 'Server API reachable' };
            }
            return { ok: false, mode: 'server', error: res.message || `Server returned code ${res.code}` };
        } catch (e) {
            return { ok: false, mode: 'server', error: e.message || String(e) };
        }
    }

    getMockToys() {
        console.log("[Lovense Mock] Returning simulated toy list");
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
}