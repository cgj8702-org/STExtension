import React, { useState, useEffect } from "react";
import Toast from "./Toast";
import { getToys, triggerFunction, sendPattern, sendPreset, getToyNames } from "./haptics";

/**
 * Settings panel for Lovense integration.
 * Stores values in localStorage so they persist across page reloads.
 */
export default function Settings() {
    const defaultSettings = {
        enabled: true,
        developerToken: "",
        uid: "",
        mode: "local", // "local" or "server"
        localUrl: "",
        strengthScale: 100,
        callbackUrl: "",
        heartbeat: 30,
        pcAutoDetect: false,
        selectedToy: "",
        targetToyId: ""
    };

    const [settings, setSettings] = useState(defaultSettings);
    const [qrUrl, setQrUrl] = useState("");
    const [toys, setToys] = useState({});
    const [selectedToy, setSelectedToy] = useState("");
    const [toast, setToast] = useState(null);
    const [lastHeartbeat, setLastHeartbeat] = useState(null);
    const [logs, setLogs] = useState([]);

    // Handle PC/Mac auto-detect logic
    useEffect(() => {
        if (settings.pcAutoDetect && settings.mode === 'local') {
            setSettings(prev => ({
                ...prev,
                localUrl: "127-0-0-1.lovense.club:30010"
            }));
        }
    }, [settings.pcAutoDetect, settings.mode]);

    // Load from localStorage on mount
    useEffect(() => {
        const stored = localStorage.getItem("lovenseSettings");
        if (stored) {
            const parsed = JSON.parse(stored);
            setSettings(parsed);
            setSelectedToy(parsed.selectedToy || "");
        }
    }, []);

    const handleChange = (e) => {
        const { name, value, type, checked } = e.target;
        const val = type === "checkbox" ? checked : value;
        setSettings((prev) => ({ ...prev, [name]: val }));
    };

    const saveSettings = () => {
        localStorage.setItem("lovenseSettings", JSON.stringify(settings));
        setToast({ message: "Lovense settings saved.", type: "success" });
    };

    // ---------------------------------------------------------------------
    // QR‑code generation (Step 2 of Lovense flow)
    // ---------------------------------------------------------------------
    const generateQr = async () => {
        if (!settings.developerToken || !settings.uid) {
            setToast({ message: "Developer token and UID are required.", type: "error" });
            return;
        }
        try {
            const resp = await fetch("https://api.lovense-api.com/api/lan/getQrCode", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ token: settings.developerToken, uid: settings.uid, v: 2 })
            });
            const data = await resp.json();
            if (data.code === 0 && data.data && data.data.qr) {
                setQrUrl(data.data.qr);
                setToast({ message: "QR code generated. Scan with Lovense Connect.", type: "success" });
            } else {
                setToast({ message: `QR generation failed: ${data.message || "unknown"}`, type: "error" });
            }
        } catch (e) {
            setToast({ message: `QR generation error: ${e.message}`, type: "error" });
        }
    };

    // ---------------------------------------------------------------------
    // Toy discovery (GetToys)
    // ---------------------------------------------------------------------
    const refreshToys = async () => {
        const list = await getToys(settings);
        if (list) {
            setToys(list);
            setToast({ message: "Toy list refreshed.", type: "success" });
        } else {
            setToast({ message: "Could not retrieve toy list.", type: "error" });
        }
    };

    // ---------------------------------------------------------------------
    // Heartbeat – periodically refresh toy status
    // ---------------------------------------------------------------------
    useEffect(() => {
        if (!settings.enabled || !settings.heartbeat) return;
        const interval = setInterval(() => {
            refreshToys();
            setLastHeartbeat(new Date().toLocaleTimeString());
        }, settings.heartbeat * 1000);
        return () => clearInterval(interval);
    }, [settings.enabled, settings.heartbeat]);

    // Helper to send a command with selected toy
    const sendCommand = async (actionFn, ...args) => {
        const timestamp = new Date().toLocaleTimeString();
        try {
            // Use selectedToy if available, otherwise fall back to targetToyId from settings
            const toyId = selectedToy || settings.targetToyId || undefined;
            await actionFn(...args, { toy: toyId }, settings);
            setToast({ message: "Command sent successfully.", type: "success" });
            setLogs(prev => [`[${timestamp}] SUCCESS: Command sent to ${toyId || 'All Toys'}`, ...prev].slice(0, 50));
        } catch (err) {
            setToast({ message: `Error sending command: ${err.message}`, type: "error" });
            setLogs(prev => [`[${timestamp}] ERROR: ${err.message}`, ...prev].slice(0, 50));
        }
    };

    // Build toy options for dropdown
    const toyOptions = Object.entries(toys).map(([id, toy]) => (
        <option key={id} value={id}>{toy.name || id}</option>
    ));
    // New: Get Toy Names button handler
    const handleGetToyNames = async () => {
        const names = await getToyNames(settings);
        if (names && names.length > 0) {
            setToast({ message: `Toy names: ${names.join(", ")}`, type: "info" });
        } else {
            setToast({ message: "No toy names retrieved.", type: "error" });
        }
    };

    return (
        <div className="lovense-settings" style={{ padding: "1rem", background: "#f9f9f9", borderRadius: "4px", marginBottom: "1rem" }}>
            <h3>Lovense Settings</h3>

            {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

            <label>
                <input type="checkbox" name="enabled" checked={settings.enabled} onChange={handleChange} /> Enable Lovense
            </label>
            <br /><br />

            <label>Developer Token:
                <input type="text" name="developerToken" value={settings.developerToken} onChange={handleChange} style={{ width: "100%" }} />
            </label>
            <br /><br />

            <label>User ID (uid) [can be comma-separated for multi-user]:
                <input type="text" name="uid" value={settings.uid} onChange={handleChange} style={{ width: "100%" }} />
            </label>
            <br /><br />

            <label>Mode:
                <select name="mode" value={settings.mode} onChange={handleChange}>
                    <option value="local">Local (LAN)</option>
                    <option value="server">Server (cloud)</option>
                </select>
            </label>
            <br /><br />

            <label>Local URL (domain:port):
                <input type="text" name="localUrl" value={settings.localUrl} onChange={handleChange} placeholder="e.g., 127-0-0-1.lovense.club:30010" style={{ width: "100%" }} />
            </label>
            <br /><br />

            <label>PC/Mac Auto-Detect:
                <input type="checkbox" name="pcAutoDetect" checked={settings.pcAutoDetect} onChange={handleChange} />
            </label>
            <br /><br />

            <label>Target Toy ID (optional):
                <input type="text" name="targetToyId" value={settings.targetToyId || ""} onChange={handleChange} style={{ width: "100%" }} />
            </label>
            <br /><br />

            <label>Strength Scale (%):
                <input type="number" name="strengthScale" value={settings.strengthScale} onChange={handleChange} min="1" max="200" />
            </label>
            <br /><br />

            <label>Callback URL (for QR flow):
                <input type="text" name="callbackUrl" value={settings.callbackUrl} onChange={handleChange} style={{ width: "100%" }} />
            </label>
            <br /><br />

            <label>Heartbeat (seconds):
                <input type="number" name="heartbeat" value={settings.heartbeat} onChange={handleChange} min="5" />
            </label>
            <br /><br />

            <button onClick={saveSettings}>Save Settings</button>
            <button onClick={generateQr} style={{ marginLeft: "0.5rem" }}>Generate QR</button>
            <button onClick={refreshToys} style={{ marginLeft: "0.5rem" }}>Refresh Toys</button>
            <button onClick={handleGetToyNames} style={{ marginLeft: "0.5rem" }}>Get Toy Names</button>
            <button onClick={() => sendCommand(triggerFunction, "Stop", { timeSec: 0 })} style={{ marginLeft: "0.5rem" }}>Stop All Toys</button>

            {qrUrl && (
                <div style={{ marginTop: "1rem" }}>
                    <h4>Scan this QR with Lovense Connect:</h4>
                    <img src={qrUrl} alt="Lovense QR" style={{ width: "200px", height: "200px" }} />
                </div>
            )}

            {Object.keys(toys).length > 0 && (
                <div style={{ marginTop: "1rem" }}>
                    <label>Select Toy:
                        <select value={selectedToy} onChange={(e) => setSelectedToy(e.target.value)}>
                            <option value="">All Toys</option>
                            {toyOptions}
                        </select>
                    </label>

                    <div style={{ marginTop: "1rem", fontSize: "0.9rem", borderTop: "1px solid #ddd", paddingTop: "0.5rem" }}>
                        <strong>Toy Details:</strong>
                        {Object.entries(toys).map(([id, toy]) => (
                            <div key={id} style={{ marginBottom: "0.5rem", padding: "0.3rem", background: selectedToy === id ? "#eef" : "transparent" }}>
                                <div><strong>Name:</strong> {toy.name || id}</div>
                                <div><strong>Status:</strong> {toy.status === "1" ? "Connected" : "Disconnected"}</div>
                                <div><strong>Battery:</strong> {toy.battery !== undefined ? `${toy.battery}%` : "N/A"}</div>
                                {toy.nickName && <div><strong>Nickname:</strong> {toy.nickName}</div>}
                            </div>
                        ))}
                    </div>
                </div>
            )}

            <div style={{ marginTop: "1rem" }}>
                <button onClick={() => sendCommand(triggerFunction, "Vibrate:10", { timeSec: 3 })}>
                    Test Vibrate
                </button>
                <button onClick={() => sendCommand(sendPattern, "V:1;F:v;S:1000#", "20;10;5", { timeSec: 9 })}>
                    Test Pattern
                </button>
                <button onClick={() => sendCommand(sendPreset, "pulse", { timeSec: 9 })}>
                    Test Preset (pulse)
                </button>
            </div>

            {lastHeartbeat && (
                <p style={{ fontSize: "0.8rem", color: "#666", marginTop: "0.5rem" }}>
                    Last heartbeat: {lastHeartbeat}
                </p>
            )}

            <div style={{ marginTop: "1.5rem", padding: "0.5rem", background: "#eee", borderRadius: "4px", fontSize: "0.75rem", fontFamily: "monospace", maxHeight: "150px", overflowY: "auto" }}>
                <strong>Command Logs:</strong>
                <div style={{ marginTop: "0.5rem" }}>
                    {logs.length === 0 ? "No logs yet..." : logs.map((log, i) => <div key={i}>{log}</div>)}
                </div>
            </div>
        </div>
    );
}
