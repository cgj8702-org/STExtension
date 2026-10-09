# lovense_client.py
# Shared Lovense API client - Python mirror of lovense-client.js
# Supports local / server / mock modes with identical payload semantics.
from __future__ import annotations

import json as _json
import logging
import re
import time

import requests
import urllib3

logger = logging.getLogger("lovense_client")

PRESET_ACTIONS = {"pulse", "wave", "fireworks", "earthquake"}
SERVER_COMMAND_URL = "https://api.lovense-api.com/api/lan/v2/command"
MOCK_TOY_ID = "mock-ferri-001"


def convert_ip_to_domain(game_mode_ip, https_port):
    """Convert '192.168.1.1' + port -> 'https://192-168-1-1.lovense.club:port'."""
    if not game_mode_ip:
        return None, "IP address cannot be empty"
    ip = game_mode_ip.strip()
    if not re.match(r"^(\d{1,3}\.){3}\d{1,3}$", ip):
        return None, "Invalid IP format %r (e.g. 192.168.1.1)" % ip
    for part in ip.split("."):
        try:
            if not 0 <= int(part) <= 255:
                raise ValueError
        except ValueError:
            return None, "Each IP segment must be 0-255: %r" % ip
    domain = "https://%s.lovense.club:%s" % (ip.replace(".", "-"), https_port)
    return domain, "Converted domain: %s" % domain


def normalize_action(action):
    """Mirror index.js fallback quirks: 'random' -> 'Vibrate'."""
    if not action:
        return "Vibrate"
    a = str(action).strip()
    if a.lower() == "random":
        return "Vibrate"
    return a


def sanitize_strength(action, strength):
    """Clamp strength. Handles models hallucinating a 1-100 scale."""
    try:
        s = int(round(float(strength)))
    except (TypeError, ValueError):
        s = 10
    if s > 20:
        s = round(s * 20 / 100)
    if str(action).lower() in ("pump", "depth"):
        return min(max(s, 0), 3)
    return min(max(s, 0), 20)


def sanitize_duration(duration):
    """Clamp 1-60. 0 means 'hold' -> 60s (matches native tool handler)."""
    try:
        d = int(duration)
    except (TypeError, ValueError):
        d = 5
    if d == 0:
        return 60
    return min(max(d, 1), 60)


class LovenseClient:
    """Mirror of JS LovenseClient (lovense-client.js)."""

    def __init__(self, connection_mode="local", local_domain="127-0-0-1.lovense.club", local_port="30010", developer_token="", user_id="", verify_ssl=False, mock_toy_id=MOCK_TOY_ID):
        self.connection_mode = (connection_mode or "local").lower()
        self.local_domain = local_domain or "127-0-0-1.lovense.club"
        self.local_port = str(local_port or "30010")
        self.developer_token = developer_token or ""
        self.user_id = user_id or ""
        self.verify_ssl = verify_ssl
        self.mock_toy_id = mock_toy_id or MOCK_TOY_ID
        if not self.verify_ssl:
            urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

    @property
    def is_local(self):
        return self.connection_mode == "local"

    @property
    def is_mock(self):
        return self.connection_mode == "mock"

    @property
    def local_base_url(self):
        return "https://%s:%s/command" % (self.local_domain, self.local_port)

    def send_command(self, action="Vibrate", strength=10, duration=5, toy_id=None):
        action = normalize_action(action)
        strength = sanitize_strength(action, strength)
        duration = sanitize_duration(duration)
        if self.is_mock:
            return self._send_mock(action, strength, duration, toy_id)
        if self.is_local:
            return self._send_local(action, strength, duration, toy_id)
        return self._send_server(action, strength, duration, toy_id)

    def stop_all(self, toy_id=None):
        if self.is_mock:
            return self._send_mock("Stop", 0, 0, toy_id)
        if self.is_local:
            payload = {"command": "Function", "action": "Stop", "timeSec": 0, "apiVer": 1}
            if toy_id:
                payload["toy"] = toy_id
            return self._post_local(payload)
        payload = {"command": "Function", "action": "Stop", "timeSec": 0, "apiVer": 1}
        if toy_id:
            payload["toy"] = toy_id
        return self._post_server(payload)

    def get_toys(self):
        if self.is_mock:
            return self.get_mock_toys()
        if not self.is_local:
            return {"error": "Toy query only fully supported in Local Mode"}
        try:
            resp = requests.post(self.local_base_url, json={"command": "GetToys"}, verify=self.verify_ssl, timeout=10)
            data = resp.json()
            raw = (data.get("data") or {}).get("toys") or "{}"
            try:
                return _json.loads(raw) if isinstance(raw, str) else raw
            except Exception:
                return {"raw": data}
        except Exception as e:
            logger.warning("get_toys failed: %s", e)
            raise

    def get_mock_toys(self):
        return {self.mock_toy_id: {"name": "Ferri", "id": self.mock_toy_id, "status": "1", "battery": 94, "type": "ferri", "version": "", "nickName": "My Ferri"}}

    def _build_local_payload(self, action, strength, duration, toy_id):
        lower = str(action).lower()
        if lower in PRESET_ACTIONS:
            payload = {"command": "Preset", "name": lower, "timeSec": duration, "apiVer": 1}
        elif lower == "stop":
            payload = {"command": "Function", "action": "Stop", "timeSec": 0, "apiVer": 1}
        else:
            payload = {"command": "Function", "action": "%s:%s" % (action, strength), "timeSec": duration, "apiVer": 1}
        if toy_id:
            payload["toy"] = toy_id
        return payload

    def _build_server_payload(self, action, strength, duration, toy_id):
        payload = {"token": self.developer_token, "uid": self.user_id, "apiVer": 1}
        lower = str(action).lower()
        if lower in PRESET_ACTIONS:
            payload.update({"command": "Preset", "name": lower, "timeSec": duration})
        elif lower == "stop":
            payload.update({"command": "Function", "action": "Stop", "timeSec": 0})
        else:
            payload.update({"command": "Function", "action": "%s:%s" % (action, strength), "timeSec": duration})
        if toy_id:
            payload["toy"] = toy_id
        return payload

    def _post_local(self, payload):
        logger.info("POST %s payload=%s", self.local_base_url, payload)
        resp = requests.post(self.local_base_url, json=payload, verify=self.verify_ssl, timeout=10)
        try:
            result = resp.json()
        except Exception:
            result = {"status_code": resp.status_code, "text": resp.text}
        print("SendCommand Response: %s" % (result,))
        return {"http_status": resp.status_code, "response": result}

    def _post_server(self, payload):
        safe = dict(payload)
        if "token" in safe:
            safe["token"] = "***"
        logger.info("POST %s payload=%s", SERVER_COMMAND_URL, safe)
        resp = requests.post(SERVER_COMMAND_URL, json=payload, timeout=15)
        try:
            result = resp.json()
        except Exception:
            result = {"status_code": resp.status_code, "text": resp.text}
        print("SendCommand Response: %s" % (result,))
        return {"http_status": resp.status_code, "response": result}

    def _send_local(self, action, strength, duration, toy_id):
        return self._post_local(self._build_local_payload(action, strength, duration, toy_id))

    def _send_server(self, action, strength, duration, toy_id):
        if not self.developer_token or not self.user_id:
            raise ValueError("Server mode needs DEVELOPER_TOKEN and USER_ID")
        return self._post_server(self._build_server_payload(action, strength, duration, toy_id))

    def _send_mock(self, action, strength, duration, toy_id):
        latency_ms = 150 + int(time.time() * 1000) % 250
        print("[Lovense Mock] %s @ Lvl %s for %ss toy=%s (simulated %sms)" % (action, strength, duration, toy_id or "all", latency_ms))
        return {"code": 200, "result": True, "type": "mock", "action": action, "strength": strength, "duration": duration, "toy": toy_id or "all"}
