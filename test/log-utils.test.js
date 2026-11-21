import test from 'node:test';
import assert from 'node:assert/strict';
import {
    clampToastSeconds, toastOptions, formatLogLine, trimLog, toBase64Utf8, LogFileWriter,
} from '../log-utils.js';

test('clampToastSeconds: 0 is allowed (sticky), garbage -> default, capped at 120', () => {
    assert.equal(clampToastSeconds(0), 0);
    assert.equal(clampToastSeconds('15'), 15);
    assert.equal(clampToastSeconds(9999), 120);
    assert.equal(clampToastSeconds(-4), 0);
    assert.equal(clampToastSeconds(''), 10);
    assert.equal(clampToastSeconds('abc'), 10);
    assert.equal(clampToastSeconds(undefined), 10);
});

test('toastOptions: timeout in ms, close button, sticky when 0', () => {
    const o = toastOptions(20);
    assert.equal(o.timeOut, 20000);
    assert.equal(o.closeButton, true);
    assert.equal(o.tapToDismiss, false);
    assert.ok(o.extendedTimeOut >= 3000);
    const sticky = toastOptions(0);
    assert.equal(sticky.timeOut, 0);
    assert.equal(sticky.extendedTimeOut, 0);
    assert.equal(sticky.progressBar, false);
});

test('formatLogLine: ISO timestamp, level, title, newlines flattened', () => {
    const line = formatLogLine('warn', 'a\nb\r\nc', 'Title', new Date('2026-11-21T22:15:03.123Z'));
    assert.equal(line, '2026-11-21T22:15:03.123Z [WARN] Title: a | b | c');
    assert.ok(!formatLogLine('info', 'x').includes('\n'));
});

test('trimLog drops the oldest whole lines', () => {
    const text = 'aaaa\nbbbb\ncccc\n';
    assert.equal(trimLog(text, 100), text);
    assert.equal(trimLog(text, 10), 'cccc\n');
    assert.equal(trimLog('no newline here at all', 5), '');
});

test('toBase64Utf8 round-trips unicode', () => {
    const s = 'unlock 🔒 → 解锁 ✓\n';
    assert.equal(Buffer.from(toBase64Utf8(s), 'base64').toString('utf8'), s);
    const big = 'x'.repeat(300000);
    assert.equal(Buffer.from(toBase64Utf8(big), 'base64').toString('utf8').length, 300000);
});

function fakeTimers() {
    let id = 0;
    const t = new Map();
    return {
        setTimer: fn => { t.set(++id, fn); return id; },
        clearTimer: i => t.delete(i),
        fire() { const fns = [...t.values()]; t.clear(); fns.forEach(f => f()); },
        get count() { return t.size; },
    };
}

test('LogFileWriter debounces many appends into one write', async () => {
    const tm = fakeTimers();
    const writes = [];
    const w = new LogFileWriter({ upload: async txt => writes.push(txt), ...tm });
    w.append('one'); w.append('two'); w.append('three');
    assert.equal(tm.count, 1);
    assert.equal(writes.length, 0);
    tm.fire();
    await new Promise(r => setImmediate(r));
    assert.deepEqual(writes, ['one\ntwo\nthree\n']);
});

test('LogFileWriter buffers but never writes while disabled', async () => {
    const tm = fakeTimers();
    const writes = [];
    let on = false;
    const w = new LogFileWriter({ upload: async t => writes.push(t), isEnabled: () => on, ...tm });
    w.append('hidden');
    assert.equal(tm.count, 0);
    assert.equal(w.text, 'hidden\n'); // still available for "Download log"
    on = true;
    assert.equal(await w.flush(), true);
    assert.deepEqual(writes, ['hidden\n']);
});

test('LogFileWriter: failure keeps data dirty and the next append retries; never throws', async () => {
    const tm = fakeTimers();
    let fail = true;
    const writes = [];
    const errors = [];
    const w = new LogFileWriter({
        upload: async t => { if (fail) throw new Error('down'); writes.push(t); },
        onError: e => errors.push(e.message), ...tm,
    });
    w.append('a');
    assert.equal(await w.flush(), false);
    assert.deepEqual(errors, ['down']);
    assert.equal(w.dirty, true);
    fail = false;
    w.append('b');
    tm.fire();
    await new Promise(r => setImmediate(r));
    assert.deepEqual(writes, ['a\nb\n']);
});

test('LogFileWriter.prepend puts saved history before this session', () => {
    const w = new LogFileWriter({ upload: async () => {}, isEnabled: () => false });
    w.append('new');
    w.prepend('old line');
    assert.equal(w.text, 'old line\nnew\n');
});

test('LogFileWriter enforces the size cap and supports clear', () => {
    const w = new LogFileWriter({ upload: async () => {}, isEnabled: () => false, maxChars: 30 });
    for (let i = 0; i < 20; i++) w.append(`line-${i}`);
    assert.ok(w.text.length <= 30);
    assert.ok(w.text.endsWith('line-19\n'));
    w.clear();
    assert.equal(w.text, '');
});

test('LogFileWriter: an append during an upload is written afterwards', async () => {
    const tm = fakeTimers();
    const writes = [];
    let release;
    const w = new LogFileWriter({
        upload: t => new Promise(r => { release = () => { writes.push(t); r(); }; }), ...tm,
    });
    w.append('first');
    const p = w.flush();
    w.append('second'); // arrives mid-upload
    release();
    await p;
    assert.equal(tm.count, 1, 'a follow-up write is scheduled');
    tm.fire();
    await new Promise(r => setImmediate(r));
    release();
    await new Promise(r => setImmediate(r));
    assert.deepEqual(writes, ['first\n', 'first\nsecond\n']);
});
