/**
 * Simple Express server to receive Lovense Connect callback POSTs.
 *
 * The Lovense dashboard should be configured with the URL of this server
 * (e.g., http://your-host:3001/lovense/callback). When a user scans the QR
 * code, Lovense Connect will POST a JSON payload containing domain, ports,
 * toy information, etc. This server stores the latest payload in memory and
 * provides a tiny GET endpoint for debugging.
 */

const express = require('express');

const app = express();
app.use(express.json());

let latestCallback = null;

app.post('/lovense/callback', (req, res) => {
    latestCallback = req.body;
    console.log('✅ Received Lovense callback:', latestCallback);
    // Respond with a simple JSON indicating success – Lovense expects a 200.
    res.json({ result: true, message: 'Callback received' });
});

// Optional helper endpoint to view the last callback (useful during dev).
app.get('/lovense/callback/latest', (req, res) => {
    res.json(latestCallback || {});
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`🚀 Lovense callback server listening on http://localhost:${PORT}`);
});
