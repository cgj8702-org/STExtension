// log-utils.js
// Pure helpers (no SillyTavern / DOM imports) for toast options and the local log file.
// index.js wires them to SillyTavern; everything here is unit-tested in plain Node.

export const DEFAULT_TOAST_SECONDS = 10;
export const MAX_TOAST_SECONDS = 120;
export const MAX_LOG_CHARS = 256 * 1024; // oldest lines are dropped beyond this

/** Seconds -> clamped integer. 0 means "stay until dismissed". Garbage -> default. */
export function clampToastSeconds(value) {
    const n = Number(value);
    if (value === '' || value === null || value === undefined || !Number.isFinite(n)) return DEFAULT_TOAST_SECONDS;
    return Math.min(Math.max(Math.round(n), 0), MAX_TOAST_SECONDS);
}

/** toastr per-call options. 0 seconds = sticky (timeOut 0 and extendedTimeOut 0 in toastr terms). */
export function toastOptions(seconds) {
    const sec = clampToastSeconds(seconds);
    const ms = sec * 1000;
    return {
        timeOut: ms,
        extendedTimeOut: sec === 0 ? 0 : Math.max(3000, Math.round(ms / 2)), // time left after the mouse leaves
        closeButton: true,
        progressBar: sec > 0,
        tapToDismiss: false, // a stray tap/click shouldn't throw the message away; use the X
    };
}

/** Map our level names onto real toastr method names ('warn' is not one; 'warning' is). */
export function toastrMethod(level) {
    const l = String(level ?? '').toLowerCase();
    if (l === 'warn' || l === 'warning') return 'warning';
    return ['info', 'success', 'error'].includes(l) ? l : 'info';
}

/** One log line: `2026-11-21T22:15:03.123Z [INFO] Title: message` (newlines flattened). */
export function formatLogLine(level, message, title = '', date = new Date()) {
    const flat = String(message ?? '').replace(/\s*\r?\n\s*/g, ' | ');
    const head = title ? `${title}: ` : '';
    return `${date.toISOString()} [${String(level || 'info').toUpperCase()}] ${head}${flat}`;
}

/** Drop the oldest whole lines until the text fits. */
export function trimLog(text, maxChars = MAX_LOG_CHARS) {
    if (text.length <= maxChars) return text;
    const cut = text.length - maxChars;
    const nl = text.indexOf('\n', cut);
    return nl === -1 ? '' : text.slice(nl + 1);
}

/** UTF-8 safe base64 (SillyTavern's /api/files/upload wants base64). */
export function toBase64Utf8(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
}

/**
 * Keeps the log in memory and writes the whole thing out through `upload(text)`, debounced.
 * - Lines are always buffered (so "Download log" works even if file saving is off).
 * - Files are only written while isEnabled() is true.
 * - A failed upload keeps the data dirty; the next append retries. It never throws to callers.
 */
export class LogFileWriter {
    constructor({
        upload,
        isEnabled = () => true,
        debounceMs = 2000,
        maxChars = MAX_LOG_CHARS,
        onError = () => {},
        setTimer = (fn, ms) => setTimeout(fn, ms),
        clearTimer = id => clearTimeout(id),
    }) {
        Object.assign(this, { upload, isEnabled, debounceMs, maxChars, onError, setTimer, clearTimer });
        this.text = '';
        this.dirty = false;
        this.timer = null;
        this.flushing = false;
        this.lastError = null;
    }

    append(line) {
        this.text = trimLog(this.text + line + '\n', this.maxChars);
        this.dirty = true;
        this.schedule();
    }

    /** Put previously saved history in front of what this session has logged so far. */
    prepend(existing) {
        if (!existing) return;
        const head = existing.endsWith('\n') ? existing : existing + '\n';
        this.text = trimLog(head + this.text, this.maxChars);
        this.dirty = true;
        this.schedule();
    }

    clear() {
        this.text = '';
        this.dirty = true;
        this.schedule();
    }

    schedule() {
        if (!this.dirty || this.timer !== null || !this.isEnabled()) return;
        this.timer = this.setTimer(() => {
            this.timer = null;
            this.flush();
        }, this.debounceMs);
    }

    /** Write now. Resolves true if a write succeeded. */
    async flush() {
        if (!this.dirty || !this.isEnabled() || this.flushing) return false;
        if (this.timer !== null) {
            this.clearTimer(this.timer);
            this.timer = null;
        }
        this.flushing = true;
        this.dirty = false;
        let ok = false;
        try {
            await this.upload(this.text);
            this.lastError = null;
            ok = true;
        } catch (e) {
            this.dirty = true; // keep it; the next append will retry
            this.lastError = e;
            this.onError(e);
        } finally {
            this.flushing = false;
        }
        if (ok && this.dirty) this.schedule(); // something was appended mid-upload
        return ok;
    }
}
