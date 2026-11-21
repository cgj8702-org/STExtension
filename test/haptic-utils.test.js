import test from 'node:test';
import assert from 'node:assert/strict';
import {
    clampStrength, clampDuration, clampDelay, normalizeUnlockAction,
    convertRedactedTags, DelayedCommandQueue, createUnlockSession,
} from '../haptic-utils.js';

test('clampStrength enforces the 0-3 hard cap', () => {
    assert.equal(clampStrength(1), 1);
    assert.equal(clampStrength(3), 3);
    assert.equal(clampStrength(4), 3);
    assert.equal(clampStrength(20), 3);
    assert.equal(clampStrength(-5), 0);
    assert.equal(clampStrength('2'), 2);
    assert.equal(clampStrength(NaN), 1);
    assert.equal(clampStrength(undefined, 2), 2);
    assert.equal(clampStrength(100), 3); // legacy 1-100 rescale then cap
});

test('clampDuration: 1-60, zero means hold (60)', () => {
    assert.equal(clampDuration(0), 60);
    assert.equal(clampDuration(5), 5);
    assert.equal(clampDuration(999), 60);
    assert.equal(clampDuration(-3), 1);
    assert.equal(clampDuration('abc', 7), 7);
});

test('clampDelay: 0-300, garbage means none', () => {
    assert.equal(clampDelay(undefined), 0);
    assert.equal(clampDelay(-4), 0);
    assert.equal(clampDelay('x'), 0);
    assert.equal(clampDelay(45), 45);
    assert.equal(clampDelay(9999), 300);
});

test('normalizeUnlockAction whitelists, defaulting to Vibrate', () => {
    assert.equal(normalizeUnlockAction('earthquake'), 'Earthquake');
    assert.equal(normalizeUnlockAction('Stop'), 'Vibrate');
    assert.equal(normalizeUnlockAction('"><script>'), 'Vibrate');
});

test('convertRedactedTags rewrites tags into clamped data-attribute spans', () => {
    const src = 'Before <redacted haptic_unlock="true" duration="30" strength="15" action="Earthquake">the secret</redacted> after';
    const { text, count } = convertRedactedTags(src);
    assert.equal(count, 1);
    assert.match(text, /data-lovense-action="Earthquake"/);
    assert.match(text, /data-lovense-strength="3"/); // 15 capped to 3
    assert.match(text, /data-lovense-duration="30"/);
    assert.match(text, /lovense-redacted-blur">the secret</);
    assert.ok(!/<redacted/i.test(text));
});

test('convertRedactedTags: injection in attributes cannot reach output', () => {
    const src = '<redacted action=\'x" onclick="alert(1)\' strength="2" duration="5">s</redacted>';
    const { text } = convertRedactedTags(src);
    assert.ok(!text.includes('onclick'));
    assert.match(text, /data-lovense-action="Vibrate"/);
});

test('convertRedactedTags handles multiple tags, multiline bodies, and opt-out', () => {
    const src = '<redacted>one</redacted> <redacted haptic_unlock="false">keep</redacted> <REDACTED duration="10">t\nwo</REDACTED>';
    const { text, count } = convertRedactedTags(src);
    assert.equal(count, 2);
    assert.match(text, /<redacted haptic_unlock="false">keep<\/redacted>/);
    assert.match(text, /data-lovense-duration="30"/); // default
    assert.match(text, /data-lovense-duration="10"/);
});

test('convertRedactedTags is idempotent and passes non-strings through', () => {
    const once = convertRedactedTags('<redacted>a</redacted>').text;
    assert.equal(convertRedactedTags(once).count, 0);
    assert.equal(convertRedactedTags(undefined).count, 0);
});

function fakeTimers(repeat = false) {
    let now = 0, id = 0;
    const timers = new Map();
    return {
        setTimer: (fn, ms) => { timers.set(++id, { fn, at: now + ms, ms }); return id; },
        clearTimer: i => timers.delete(i),
        advance(ms) {
            const end = now + ms;
            for (;;) {
                const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!due) break;
                now = due[1].at;
                timers.delete(due[0]);
                if (repeat) timers.set(due[0], { ...due[1], at: now + due[1].ms });
                due[1].fn();
            }
            now = end;
        },
        get count() { return timers.size; },
    };
}

test('DelayedCommandQueue fires after the delay, not before', async () => {
    const t = fakeTimers();
    const sent = [];
    const q = new DelayedCommandQueue({ send: c => sent.push(c), ...t });
    const r = q.schedule({ action: 'Vibrate', strength: 1, duration: 5 }, 10);
    assert.equal(r.ok, true);
    assert.equal(q.size, 1);
    t.advance(9000);
    assert.equal(sent.length, 0);
    t.advance(1000);
    assert.equal(sent.length, 1);
    assert.equal(q.size, 0);
});

test('DelayedCommandQueue: zero delay sends immediately', () => {
    const sent = [];
    const q = new DelayedCommandQueue({ send: c => sent.push(c), ...fakeTimers() });
    assert.equal(q.schedule({ action: 'Vibrate' }, 0).immediate, true);
    assert.equal(sent.length, 1);
});

test('DelayedCommandQueue caps pending commands and cancelAll clears them', () => {
    const t = fakeTimers();
    const sent = [];
    const q = new DelayedCommandQueue({ send: c => sent.push(c), maxPending: 2, ...t });
    assert.ok(q.schedule({ action: 'A' }, 5).ok);
    assert.ok(q.schedule({ action: 'B' }, 5).ok);
    const third = q.schedule({ action: 'C' }, 5);
    assert.equal(third.ok, false);
    assert.equal(q.cancelAll(), 2);
    t.advance(60000);
    assert.equal(sent.length, 0);
    assert.equal(t.count, 0);
});

test('DelayedCommandQueue reports send failures via onError', async () => {
    const t = fakeTimers();
    const errors = [];
    const q = new DelayedCommandQueue({ send: async () => { throw new Error('boom'); }, onError: e => errors.push(e.message), ...t });
    q.schedule({ action: 'Vibrate' }, 1);
    t.advance(1000);
    await new Promise(r => setImmediate(r));
    assert.deepEqual(errors, ['boom']);
});

test('unlock session counts down, then reveals', async () => {
    const t = fakeTimers(true);
    const ticks = [];
    let done = 0, started = 0;
    const s = createUnlockSession({
        duration: 3, start: async () => { started++; },
        onTick: n => ticks.push(n), onDone: () => done++, ...t,
    });
    await s.begin();
    assert.equal(s.state, 'running');
    t.advance(3000);
    assert.deepEqual(ticks, [3, 2, 1, 0]);
    assert.equal(done, 1);
    assert.equal(started, 1);
    assert.equal(s.state, 'done');
});

test('unlock session abort stops the toy and never reveals', async () => {
    const t = fakeTimers(true);
    let done = 0, stopped = 0, aborted = 0;
    const s = createUnlockSession({
        duration: 10, start: async () => {}, stop: () => stopped++,
        onDone: () => done++, onAbort: () => aborted++, ...t,
    });
    await s.begin();
    t.advance(4000);
    assert.equal(s.abort(), true);
    t.advance(20000);
    assert.equal(done, 0);
    assert.equal(stopped, 1);
    assert.equal(aborted, 1);
    assert.equal(s.abort(), false);
    assert.equal(t.count, 0);
});

test('unlock session: failed start returns to idle (retryable), no reveal', async () => {
    const t = fakeTimers(true);
    let errors = 0, done = 0;
    const s = createUnlockSession({
        duration: 2, start: async () => { throw new Error('offline'); },
        onError: () => errors++, onDone: () => done++, ...t,
    });
    await s.begin();
    assert.equal(s.state, 'idle');
    assert.equal(errors, 1);
    t.advance(5000);
    assert.equal(done, 0);
});

test('unlock session: abort while the start command is in flight wins', async () => {
    const t = fakeTimers(true);
    let release;
    let done = 0;
    const s = createUnlockSession({
        duration: 2, start: () => new Promise(r => { release = r; }), onDone: () => done++, ...t,
    });
    const p = s.begin();
    assert.equal(s.abort(), true);
    release();
    await p;
    t.advance(5000);
    assert.equal(s.state, 'aborted');
    assert.equal(done, 0);
});
