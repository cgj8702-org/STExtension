import test from 'node:test';
import assert from 'node:assert/strict';
import { LovenseClient } from '../lovense-client.js';

// A fetch that never answers, but honours AbortSignal like the real one.
const hangingFetch = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
        const e = new Error('aborted');
        e.name = 'AbortError';
        reject(e);
    });
});

test('local command times out instead of hanging forever', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = hangingFetch;
    try {
        const client = new LovenseClient({ connectionMode: 'local' });
        client.localTimeoutMs = 40;
        await assert.rejects(
            client.sendCommand({ action: 'Vibrate', strength: 1, duration: 5 }),
            /timed out/,
        );
    } finally { globalThis.fetch = realFetch; }
});

test('server command times out instead of hanging forever', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = hangingFetch;
    try {
        const client = new LovenseClient({ connectionMode: 'server', developerToken: 't', userId: 'u' });
        client.serverTimeoutMs = 40;
        await assert.rejects(client.sendCommand({ action: 'Stop', strength: 0, duration: 0 }), /timed out/);
    } finally { globalThis.fetch = realFetch; }
});

test('a normal response is unaffected and non-abort errors pass through', async () => {
    const realFetch = globalThis.fetch;
    try {
        globalThis.fetch = async () => ({ json: async () => ({ code: 200 }) });
        const client = new LovenseClient({ connectionMode: 'local' });
        assert.deepEqual(await client.sendCommand({ action: 'Vibrate', strength: 1, duration: 5 }), { code: 200 });

        globalThis.fetch = async () => { throw new TypeError('network down'); };
        await assert.rejects(client.sendCommand({ action: 'Vibrate', strength: 1, duration: 5 }), /network down/);
    } finally { globalThis.fetch = realFetch; }
});
