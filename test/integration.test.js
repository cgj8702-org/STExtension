// Loads the REAL index.js against a fake SillyTavern + jsdom and records the HTTP payloads
// that would be sent to the Lovense daemon. Run with `npm test`.
import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import { createRequire } from 'node:module';
const jqueryFactory = createRequire(import.meta.url)('jquery'); // CJS build exports a factory(window)

// The extension polls for toys on a real 30s setInterval; don't let it keep the test process alive.
const realSetInterval = globalThis.setInterval;
globalThis.setInterval = (...args) => {
    const t = realSetInterval(...args);
    t?.unref?.();
    return t;
};

const root = new URL('../', import.meta.url);
const tmpPath = new URL('./test/.tmp-index.mjs', root);

const stubs = {
    parser: `export const SlashCommandParser = { commands: {}, addCommandObject(c) { this.commands[c.name] = c; } };`,
    cmd: `export const SlashCommand = { fromProps: p => p };`,
    arg: `export const SlashCommandArgument = { fromProps: p => p }; export const ARGUMENT_TYPE = { STRING: 's', NUMBER: 'n' };`,
    script: `export const prompts = []; export const setExtensionPrompt = (...a) => prompts.push(a);
             export const extension_prompt_types = { IN_CHAT: 1 }; export const extension_prompt_roles = { SYSTEM: 0 };`,
};
const stubUrl = code => 'data:text/javascript;base64,' + Buffer.from(code).toString('base64');

function buildModuleSource() {
    let src = readFileSync(new URL('./index.js', root), 'utf8');
    const swap = (from, to) => {
        assert.ok(src.includes(from), `import not found: ${from}`);
        src = src.replace(from, to);
    };
    swap("'/scripts/slash-commands/SlashCommandParser.js'", `'${stubUrl(stubs.parser)}'`);
    swap("'/scripts/slash-commands/SlashCommand.js'", `'${stubUrl(stubs.cmd)}'`);
    swap("'/scripts/slash-commands/SlashCommandArgument.js'", `'${stubUrl(stubs.arg)}'`);
    swap("'/script.js'", `'${stubUrl(stubs.script)}'`);
    swap("'./lovense-client.js?v=15'", `'${pathToFileURL(new URL('./lovense-client.js', root).pathname)}'`);
    swap("'./haptic-utils.js?v=15'", `'${pathToFileURL(new URL('./haptic-utils.js', root).pathname)}'`);
    return src;
}

let counter = 0;
async function boot({ settings = {}, nativeTools = true } = {}) {
    const dom = new JSDOM('<!doctype html><body><div id="extensions_settings2"></div><div id="chat"></div></body>');
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    dom.window.$ = jqueryFactory(dom.window);
    dom.window.toastr = { info() {}, success() {}, error() {} };

    const sent = [];
    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        if (body.command !== 'GetToys') sent.push(body);
        return { ok: true, json: async () => ({ code: 200, data: { toys: '{}' } }) };
    };

    const handlers = {};
    const tools = {};
    const ctx = {
        extensionSettings: { lovense_integration: { connectionMode: 'local', ...settings } },
        chat: [],
        eventSource: { on: (e, fn) => ((handlers[e] ??= []).push(fn)) },
        event_types: {
            MESSAGE_RECEIVED: 'msg_recv', CHARACTER_MESSAGE_RENDERED: 'char_render',
            GENERATION_STARTED: 'gen_start', GENERATION_ENDED: 'gen_end',
            GENERATION_STOPPED: 'gen_stop', CHAT_CHANGED: 'chat_changed',
        },
        isToolCallingSupported: () => nativeTools,
        registerFunctionTool: t => { tools[t.name] = t; },
        saveSettingsDebounced() {},
        renderExtensionTemplateAsync: async () => `
            <div class="lovense-integration-settings">
              <select id="lovense_connectionMode"></select>
              <input id="lovense_localPort"><input id="lovense_localDomain">
              <input id="lovense_developerToken"><input id="lovense_userId">
              <input type="checkbox" id="lovense_allowDelayedCommands">
              <input type="checkbox" id="lovense_enableHapticUnlock">
              <span id="lovense_pending_count">0</span>
              <textarea id="lovense_customGuidelines"></textarea>
              <button id="lovense_reset_guidelines"></button><button id="lovense_test_connection"></button>
              <button id="lovense_stop_all"></button><div id="lovense_connection_status"></div>
              <div id="lovense_local_settings"></div><div id="lovense_server_settings"></div><div id="lovense_mock_settings"></div>
            </div>`,
    };
    dom.window.SillyTavern = { getContext: () => ctx };

    writeFileSync(tmpPath, buildModuleSource());
    const mod = await import(`${tmpPath.href}?n=${++counter}`);
    await mod.onActivate();

    const emit = async (name, ...args) => {
        for (const fn of handlers[name] ?? []) await fn(...args);
        await new Promise(r => setImmediate(r));
    };
    const flush = () => new Promise(r => setImmediate(r));
    return { ctx, sent, tools, emit, flush, dom };
}

test.after(() => rmSync(tmpPath, { force: true }));

test('tool call: strength and duration are hard-clamped in the HTTP payload', async () => {
    const { tools, sent } = await boot();
    const res = await tools.control_lovense_toy.action({ action: 'Vibrate', strength: 9, duration: 999 });
    assert.equal(JSON.parse(res).status, 'success');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].action, 'Vibrate:3');
    assert.equal(sent[0].timeSec, 60);
});

test('tool schema exposes delay and no longer hardcodes a mock toy id', async () => {
    const { tools } = await boot();
    const props = tools.control_lovense_toy.parameters.properties;
    assert.ok(props.delay);
    assert.ok(!JSON.stringify(props.toyId).includes('mock-ferri'));
});

test('delay is ignored (fires now) while delayed commands are disabled', async () => {
    const { tools, sent } = await boot();
    await tools.control_lovense_toy.action({ action: 'Vibrate', strength: 1, duration: 5, delay: 30 });
    assert.equal(sent.length, 1);
});

test('delay enabled: nothing fires early, fires once on time, strength still capped', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    try {
        const { tools, sent, flush } = await boot({ settings: { allowDelayedCommands: true } });
        const res = JSON.parse(await tools.control_lovense_toy.action({ action: 'Vibrate', strength: 7, duration: 5, delay: 30 }));
        assert.equal(res.status, 'scheduled');
        assert.equal(sent.length, 0);
        mock.timers.tick(29000); await flush();
        assert.equal(sent.length, 0);
        mock.timers.tick(1000); await flush();
        assert.equal(sent.length, 1);
        assert.equal(sent[0].action, 'Vibrate:3');
    } finally { mock.timers.reset(); }
});

test('Stop cancels pending delayed commands', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    try {
        const { tools, sent, flush } = await boot({ settings: { allowDelayedCommands: true } });
        await tools.control_lovense_toy.action({ action: 'Vibrate', strength: 2, duration: 5, delay: 20 });
        await tools.control_lovense_toy.action({ action: 'Stop', strength: 0, duration: 1 });
        mock.timers.tick(60000); await flush();
        assert.deepEqual(sent.map(p => p.action), ['Stop']);
    } finally { mock.timers.reset(); }
});

test('changing chats cancels pending delayed commands', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    try {
        const { tools, sent, flush, emit } = await boot({ settings: { allowDelayedCommands: true } });
        await tools.control_lovense_toy.action({ action: 'Vibrate', strength: 1, duration: 5, delay: 10 });
        await emit('chat_changed');
        mock.timers.tick(60000); await flush();
        assert.equal(sent.length, 0);
    } finally { mock.timers.reset(); }
});

test('GENERATION_ENDED does not send a Stop that cuts off fire-once commands', async () => {
    const { tools, sent, emit } = await boot();
    await emit('gen_start');
    await tools.control_lovense_toy.action({ action: 'Vibrate', strength: 1, duration: 10 });
    await emit('gen_end');
    assert.deepEqual(sent.map(p => p.action), ['Vibrate:1']);
});

test('parser: clamps legacy strength and never invents a toy id', async () => {
    const { ctx, sent, emit } = await boot();
    await emit('gen_start');
    ctx.chat[0] = { is_user: false, mes: 'ok <call:control_lovense_toy action="Vibrate" strength="10" duration="5"/>' };
    await emit('msg_recv', 0);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].action, 'Vibrate:3');
    assert.ok(!('toy' in sent[0]));
});

test('parser: Pulse is no longer silently downgraded to Vibrate', async () => {
    const { ctx, sent, emit } = await boot();
    await emit('gen_start');
    ctx.chat[0] = { is_user: false, mes: '<call:control_lovense_toy action="Pulse" strength="1" duration="5"/>' };
    await emit('msg_recv', 0);
    assert.equal(sent[0].command, 'Preset');
    assert.equal(sent[0].name, 'pulse');
});

test('parser: rendering old history (no live generation) never replays commands', async () => {
    const { ctx, sent, emit } = await boot();
    ctx.chat[0] = { is_user: false, mes: '<call:control_lovense_toy action="Vibrate" strength="3" duration="30"/>' };
    await emit('char_render', 0);
    assert.equal(sent.length, 0);
});

test('parser: the same message seen by RECEIVED and RENDERED fires once', async () => {
    const { ctx, sent, emit } = await boot();
    await emit('gen_start');
    ctx.chat[0] = { is_user: false, mes: '<call:control_lovense_toy action="Vibrate" strength="1" duration="5"/>' };
    await emit('msg_recv', 0);
    await emit('gen_end');
    await emit('char_render', 0); // within the grace window
    assert.equal(sent.length, 1);
});

const latestPrompt = async () => (await import(stubUrl(stubs.script))).prompts.at(-1)[1];
const slashCommand = async name => (await import(stubUrl(stubs.parser))).SlashCommandParser.commands[name];

test('prompt: never advertises the old 1-20 scale; optional sections only when enabled', async () => {
    await boot();
    const off = await latestPrompt();
    assert.ok(!/\(1-20\)/.test(off), 'prompt must not advertise (1-20)');
    assert.ok(!off.includes('strength="10"'));
    assert.ok(!off.includes('DELAYED COMMANDS'));
    assert.ok(!off.includes('HAPTIC UNLOCK'));

    await boot({ settings: { allowDelayedCommands: true, enableHapticUnlock: true } });
    const on = await latestPrompt();
    assert.ok(on.includes('DELAYED COMMANDS'));
    assert.ok(on.includes('HAPTIC UNLOCK'));
    assert.ok(on.includes('<redacted haptic_unlock="true"'));
});

test('/lovense accepts a single string or an array and clamps', async () => {
    const { sent } = await boot();
    const cmd = await slashCommand('lovense');
    await cmd.callback({}, 'Vibrate 15 5');
    await cmd.callback({}, ['Vibrate', '2', '7']);
    assert.equal(sent[0].action, 'Vibrate:3');
    assert.equal(sent[0].timeSec, 5);
    assert.equal(sent[1].action, 'Vibrate:2');
    assert.equal(sent[1].timeSec, 7);
    assert.match(await cmd.callback({}, ''), /Usage/);
});

test('/lovense-stop sends Stop and cancels delayed commands', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    try {
        const { tools, sent, flush } = await boot({ settings: { allowDelayedCommands: true } });
        await tools.control_lovense_toy.action({ action: 'Vibrate', strength: 1, duration: 5, delay: 15 });
        await (await slashCommand('lovense-stop')).callback({});
        mock.timers.tick(60000); await flush();
        assert.deepEqual(sent.map(p => p.action), ['Stop']);
    } finally { mock.timers.reset(); }
});

function renderSecret(ctx, dom, mes) {
    dom.window.document.querySelector('#chat').innerHTML =
        `<div class="mes" mesid="0"><div class="mes_text">${mes}</div></div>`;
}

test('haptic unlock: tag is converted, locked, fires the toy on click, reveals after the cycle', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    try {
        const { ctx, sent, emit, flush, dom } = await boot({ settings: { enableHapticUnlock: true } });
        await emit('gen_start');
        ctx.chat[0] = { is_user: false, mes: 'Hear this: <redacted haptic_unlock="true" duration="30" strength="15" action="Earthquake">the secret</redacted>' };
        await emit('msg_recv', 0);
        assert.ok(!ctx.chat[0].mes.includes('<redacted'));
        assert.equal(sent.length, 0, 'conversion alone must not fire the toy');

        renderSecret(ctx, dom, ctx.chat[0].mes);
        await emit('char_render', 0);
        const doc = dom.window.document;
        const btn = doc.querySelector('.lovense-unlock-btn');
        const text = doc.querySelector('.lovense-redacted-text');
        assert.ok(btn && text.classList.contains('lovense-redacted-blur'));
        assert.equal(sent.length, 0, 'rendering alone must not fire the toy');

        btn.click(); await flush();
        assert.equal(sent.length, 1);
        assert.equal(sent[0].command, 'Preset');
        assert.equal(sent[0].name, 'earthquake');
        assert.equal(sent[0].timeSec, 30);

        mock.timers.tick(29000); await flush();
        assert.ok(text.classList.contains('lovense-redacted-blur'), 'still locked before the cycle ends');
        mock.timers.tick(1000); await flush();
        assert.ok(!text.classList.contains('lovense-redacted-blur'));
        assert.ok(text.classList.contains('lovense-unlocked-text'));
        assert.equal(doc.querySelector('.lovense-unlock-btn'), null);
    } finally { mock.timers.reset(); }
});

test('haptic unlock: tapping again stops the toy and keeps the text locked', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    try {
        const { ctx, sent, emit, flush, dom } = await boot({ settings: { enableHapticUnlock: true } });
        await emit('gen_start');
        ctx.chat[0] = { is_user: false, mes: '<redacted duration="20" strength="2" action="Wave">hidden</redacted>' };
        await emit('msg_recv', 0);
        renderSecret(ctx, dom, ctx.chat[0].mes);
        await emit('char_render', 0);
        const doc = dom.window.document;
        const btn = doc.querySelector('.lovense-unlock-btn');
        btn.click(); await flush();
        mock.timers.tick(5000); await flush();
        btn.click(); await flush();
        assert.equal(sent.at(-1).action, 'Stop');
        mock.timers.tick(60000); await flush();
        assert.ok(doc.querySelector('.lovense-redacted-text').classList.contains('lovense-redacted-blur'));
        assert.ok(doc.querySelector('.lovense-unlock-btn'), 'button is available again to retry');
    } finally { mock.timers.reset(); }
});

test('haptic unlock: Stop All aborts a running unlock and keeps it locked', async () => {
    mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
    try {
        const { ctx, sent, emit, flush, dom } = await boot({ settings: { enableHapticUnlock: true } });
        await emit('gen_start');
        ctx.chat[0] = { is_user: false, mes: '<redacted duration="20" action="Pulse">hidden</redacted>' };
        await emit('msg_recv', 0);
        renderSecret(ctx, dom, ctx.chat[0].mes);
        await emit('char_render', 0);
        const doc = dom.window.document;
        doc.querySelector('.lovense-unlock-btn').click(); await flush();
        await (await slashCommand('lovense-stop')).callback({}); await flush();
        mock.timers.tick(60000); await flush();
        assert.ok(sent.some(p => p.action === 'Stop'));
        assert.ok(doc.querySelector('.lovense-redacted-text').classList.contains('lovense-redacted-blur'));
    } finally { mock.timers.reset(); }
});

test('haptic unlock disabled: <redacted> tags are left alone', async () => {
    const { ctx, emit } = await boot();
    await emit('gen_start');
    const mes = '<redacted duration="20">hidden</redacted>';
    ctx.chat[0] = { is_user: false, mes };
    await emit('msg_recv', 0);
    assert.equal(ctx.chat[0].mes, mes);
});
