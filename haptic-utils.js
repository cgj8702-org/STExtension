// haptic-utils.js
// Pure helpers with NO SillyTavern / DOM imports, so they can be unit-tested in
// plain Node (`npm test`). index.js wires them to the SillyTavern runtime.

export const MAX_STRENGTH = 3; // Ferri-calibrated hard cap, applies to every action
export const MAX_DURATION = 60; // seconds
export const MAX_DELAY = 300; // seconds
export const MAX_PENDING = 3; // delayed commands allowed in flight at once

export const UNLOCK_ACTIONS = ['Vibrate', 'Pulse', 'Wave', 'Fireworks', 'Earthquake'];

/** Clamp strength to 0-3. Legacy 1-100 values are rescaled onto the 0-20 scale first. */
export function clampStrength(value, fallback = 1) {
    let s = Number(value);
    if (!Number.isFinite(s)) s = fallback;
    if (s > 20) s = Math.round((s * 20) / 100);
    return Math.min(Math.max(Math.round(s), 0), MAX_STRENGTH);
}

/** Clamp duration to 1-60s. 0 means "hold" and maps to the 60s maximum. */
export function clampDuration(value, fallback = 5) {
    if (value === 0 || value === '0') return MAX_DURATION;
    let d = Number(value);
    if (!Number.isFinite(d)) d = fallback;
    return Math.min(Math.max(Math.round(d), 1), MAX_DURATION);
}

/** Clamp delay to 0-300s. Anything unparsable means "no delay". */
export function clampDelay(value) {
    const d = Number(value);
    if (!Number.isFinite(d) || d <= 0) return 0;
    return Math.min(Math.round(d), MAX_DELAY);
}

/** Map a free-form action name onto the known unlock whitelist (default Vibrate). */
export function normalizeUnlockAction(action) {
    const wanted = String(action ?? '').trim().toLowerCase();
    return UNLOCK_ACTIONS.find(a => a.toLowerCase() === wanted) ?? 'Vibrate';
}

function parseTagAttributes(attrString) {
    const attrs = {};
    const re = /([a-zA-Z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
    let m;
    while ((m = re.exec(attrString || '')) !== null) {
        attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
    }
    return attrs;
}

const REDACTED_RE = /<redacted\b([^>]*)>([\s\S]*?)<\/redacted>/gi;

/**
 * Convert model-written `<redacted haptic_unlock="true" action=".." strength=".." duration="..">secret</redacted>`
 * into a sanitizer-safe <span> with data-* attributes. SillyTavern's HTML sanitizer strips unknown tags
 * like <redacted>, so we rewrite them BEFORE rendering. Only whitelisted, clamped values are emitted,
 * so nothing the model writes in an attribute can reach the output markup.
 *
 * `<redacted haptic_unlock="false">` is left untouched.
 * @returns {{ text: string, count: number }}
 */
export function convertRedactedTags(text) {
    if (typeof text !== 'string' || !/<redacted\b/i.test(text)) {
        return { text, count: 0 };
    }
    let count = 0;
    const out = text.replace(REDACTED_RE, (full, attrString, inner) => {
        const attrs = parseTagAttributes(attrString);
        if (String(attrs.haptic_unlock ?? 'true').toLowerCase() === 'false') return full;
        const action = normalizeUnlockAction(attrs.action);
        const strength = clampStrength(attrs.strength, 1);
        const duration = clampDuration(attrs.duration, 30);
        count++;
        return (
            `<span class="lovense-redacted" data-lovense-unlock="1" data-lovense-action="${action}" ` +
            `data-lovense-strength="${strength}" data-lovense-duration="${duration}">` +
            `<span class="lovense-redacted-text lovense-redacted-blur">${inner}</span></span>`
        );
    });
    return { text: out, count };
}

/**
 * Holds delayed ("landmine") commands. Every pending entry can be cancelled at once
 * (Stop, Stop All, chat change). Timers and the send function are injectable for tests.
 */
export class DelayedCommandQueue {
    constructor({
        send,
        maxPending = MAX_PENDING,
        onChange = () => {},
        onError = () => {},
        setTimer = (fn, ms) => setTimeout(fn, ms),
        clearTimer = id => clearTimeout(id),
    }) {
        this.send = send;
        this.maxPending = maxPending;
        this.onChange = onChange;
        this.onError = onError;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.pending = new Map();
        this.nextId = 1;
    }

    get size() {
        return this.pending.size;
    }

    /**
     * @returns {{ ok: boolean, immediate?: boolean, id?: number, delay?: number, reason?: string }}
     */
    schedule(command, delaySeconds) {
        const delay = clampDelay(delaySeconds);
        if (delay === 0) {
            Promise.resolve(this.send(command)).catch(this.onError);
            return { ok: true, immediate: true };
        }
        if (this.pending.size >= this.maxPending) {
            return { ok: false, reason: `Too many delayed commands pending (max ${this.maxPending}).` };
        }
        const id = this.nextId++;
        const timer = this.setTimer(() => {
            this.pending.delete(id);
            this.onChange(this.pending.size);
            Promise.resolve(this.send(command)).catch(this.onError);
        }, delay * 1000);
        this.pending.set(id, timer);
        this.onChange(this.pending.size);
        return { ok: true, id, delay };
    }

    /** Cancel everything still waiting. @returns {number} how many were cancelled */
    cancelAll() {
        const n = this.pending.size;
        for (const timer of this.pending.values()) this.clearTimer(timer);
        this.pending.clear();
        if (n > 0) this.onChange(0);
        return n;
    }
}

/**
 * State machine for one "haptic unlock": run the toy for `duration` seconds, count down,
 * reveal when finished. The user can abort at any point (toy is stopped, text stays locked).
 * States: idle -> starting -> running -> done | aborted   (or back to idle on a start error)
 */
export function createUnlockSession({
    duration,
    start,
    stop = () => {},
    onTick = () => {},
    onDone = () => {},
    onAbort = () => {},
    onError = () => {},
    setTimer = (fn, ms) => setInterval(fn, ms),
    clearTimer = id => clearInterval(id),
}) {
    let remaining = duration;
    let timer = null;
    let state = 'idle';

    const clear = () => {
        if (timer !== null) {
            clearTimer(timer);
            timer = null;
        }
    };

    return {
        get state() {
            return state;
        },
        async begin() {
            if (state !== 'idle') return;
            state = 'starting';
            try {
                await start();
            } catch (e) {
                if (state === 'starting') state = 'idle';
                onError(e);
                return;
            }
            if (state !== 'starting') return; // aborted while the command was in flight
            state = 'running';
            onTick(remaining);
            timer = setTimer(() => {
                remaining -= 1;
                onTick(Math.max(remaining, 0));
                if (remaining <= 0) {
                    clear();
                    state = 'done';
                    onDone();
                }
            }, 1000);
        },
        abort() {
            if (state !== 'running' && state !== 'starting') return false;
            clear();
            state = 'aborted';
            try {
                stop();
            } finally {
                onAbort();
            }
            return true;
        },
    };
}
