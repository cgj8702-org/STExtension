# RemoteMCP.py - Lovense MCP server, full parity with STExtension index.js
# Transports: stdio (default) or sse. Modes: local / server / mock.
# Config via CLI KEY=VALUE args and/or env vars (CLI wins):
#   CONNECTION_MODE=local|server|mock
#   GAME_MODE_IP=192.168.1.100 GAME_MODE_PORT=30010   (local)
#   LOCAL_DOMAIN=127-0-0-1.lovense.club LOCAL_PORT=30010
#   DEVELOPER_TOKEN=... USER_ID=...                   (server)
#   VERIFY_SSL=false                                   (local self-signed cert)
#   MCP_TRANSPORT=stdio|sse MCP_HOST=127.0.0.1 MCP_PORT=8000
import asyncio
import logging
import os
import sys

if sys.platform == "win32":
    try:
        sys.stderr.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

# stdio transport uses stdout for protocol -> log to stderr only.
logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
logger = logging.getLogger("RemoteMCP")

from mcp.server.fastmcp import FastMCP

from lovense_client import LovenseClient, convert_ip_to_domain

mcp = FastMCP("RemoteMCP")
client = None


def parse_args_from_argv():
    args = {}
    for arg in sys.argv[1:]:
        if "=" in arg:
            key, value = arg.split("=", 1)
            args[key.strip()] = value.strip()
    return args


def _get(cli, name, default=""):
    return cli.get(name) or cli.get(name.lower()) or os.getenv(name) or os.getenv(name.lower()) or default


def build_client():
    cli = parse_args_from_argv()
    mode = (_get(cli, "CONNECTION_MODE", "local") or "local").lower()
    if mode not in ("local", "server", "mock"):
        raise ValueError("CONNECTION_MODE must be local|server|mock, got %r" % mode)
    verify_raw = _get(cli, "VERIFY_SSL", "false").lower()
    verify_ssl = verify_raw in ("1", "true", "yes", "on")
    if mode == "mock":
        cfg = LovenseClient(connection_mode="mock")
        logger.info("Mode=mock (no real API calls)")
        return cfg
    if mode == "server":
        token = _get(cli, "DEVELOPER_TOKEN")
        uid = _get(cli, "USER_ID")
        if not token or not uid:
            raise ValueError("Server mode needs DEVELOPER_TOKEN and USER_ID")
        return LovenseClient(connection_mode="server", developer_token=token, user_id=uid, verify_ssl=verify_ssl)
    # local mode: explicit domain wins, else convert GAME_MODE_IP
    domain = _get(cli, "LOCAL_DOMAIN")
    port = _get(cli, "LOCAL_PORT") or _get(cli, "GAME_MODE_PORT") or _get(cli, "LOCAL_GAME_PORT") or "30010"
    ip = _get(cli, "GAME_MODE_IP") or _get(cli, "LOCAL_IP")
    if not domain:
        if not ip:
            raise ValueError("Local mode needs GAME_MODE_IP (or LOCAL_DOMAIN). Got neither.")
        full, msg = convert_ip_to_domain(ip, port)
        if not full:
            raise ValueError(msg)
        logger.info(msg)
        rest = full.split("://", 1)[1].split("/", 1)[0]
        domain, _, port = rest.rpartition(":")
    return LovenseClient(connection_mode="local", local_domain=domain, local_port=port, verify_ssl=verify_ssl)


def _require_client():
    if client is None:
        raise RuntimeError("Lovense client not initialised")
    return client


@mcp.tool()
def control_lovense_toy(action: str = "Vibrate", strength: int = 2, duration: int = 5, toy_id: str = "", delay: int = 0) -> dict:
    """Control the user's Lovense toy. Mirrors the SillyTavern 'control_lovense_toy' tool.

    Args:
        action: Vibrate, Rotate, Pump, Thrusting, Fingering, Suction, Oscillate,
            Pulse, Wave, Fireworks, Earthquake, or Stop. 'random' maps to Vibrate.
        strength: Ferri 0-3 ONLY (0=stop, 1=gentle, 2=moderate, 3=MAX — even 4 is too much). Clamped.
        duration: seconds 1-60. 0 means hold -> 60s.
        toy_id: optional toy ID (omit for all toys).
        delay: optional seconds 0-300 to wait before firing (haptic landmine).
    """
    try:
        c = _require_client()
        if delay and int(delay) > 0:
            d = min(max(int(delay), 0), 300)
            logger.info("Delaying command %ss: %s %s %ss", d, action, strength, duration)
            import time as _t
            _t.sleep(d)
        # run sync requests in a thread so we never block the MCP loop
        result = c.send_command(action, strength, duration, toy_id or None)
        resp = result.get("response", result) if isinstance(result, dict) else result
        code = resp.get("code") if isinstance(resp, dict) else None
        ok = code in (200, 0, None) or (isinstance(resp, dict) and resp.get("result") in (True, "true"))
        return {"success": bool(ok), "message": "Sent %s strength %s for %ss%s" % (action, strength, duration, (" to " + toy_id) if toy_id else ""), "detail": result}
    except Exception as e:
        logger.exception("control_lovense_toy failed")
        return {"success": False, "message": str(e)}


@mcp.tool()
def SendFunctions(python_expression: str = "Vibrate:2", duration: int = 2, toy_id: str = "") -> dict:
    """Legacy tool (kept for back-compat). Prefer control_lovense_toy."""
    try:
        action, _, s = str(python_expression or "Vibrate:2").partition(":")
        try:
            strength = int(s) if s else 2
        except ValueError:
            strength = 2
        result = _require_client().send_command(action or "Vibrate", strength, duration, toy_id or None)
        return {"success": True, "message": "Sent %s" % python_expression, "detail": result}
    except Exception as e:
        return {"success": False, "message": str(e)}


@mcp.tool()
def SendStopFunction(toy_id: str = "") -> dict:
    """Stop all actions currently running."""
    try:
        result = _require_client().stop_all(toy_id or None)
        return {"success": True, "message": "Stopped all toy functions", "detail": result}
    except Exception as e:
        return {"success": False, "message": str(e)}


@mcp.tool()
def get_toys() -> dict:
    """List connected toys (local GetToys / mock list)."""
    try:
        toys = _require_client().get_toys()
        return {"success": True, "toys": toys}
    except Exception as e:
        return {"success": False, "message": str(e)}


@mcp.tool()
def get_status() -> dict:
    """Show active connection mode + target without leaking tokens."""
    try:
        c = _require_client()
        info = {"mode": c.connection_mode, "verify_ssl": c.verify_ssl}
        if c.is_local:
            info["target"] = c.local_base_url
        elif c.connection_mode == "server":
            info["target"] = "https://api.lovense-api.com/api/lan/v2/command"
            info["user_id"] = c.user_id
        else:
            info["target"] = "mock"
            info["mock_toy"] = c.mock_toy_id
        return {"success": True, **info}
    except Exception as e:
        return {"success": False, "message": str(e)}


if __name__ == "__main__":
    cli = parse_args_from_argv()
    client = build_client()
    transport = (_get(cli, "MCP_TRANSPORT", "stdio") or "stdio").lower()
    logger.info("RemoteMCP starting transport=%s", transport)
    if transport in ("sse", "streamable-http", "http"):
        host = _get(cli, "MCP_HOST", "127.0.0.1") or "127.0.0.1"
        port = int(_get(cli, "MCP_PORT", "8000") or 8000)
        mcp.settings.host = host
        mcp.settings.port = port
        if transport == "sse":
            mcp.run(transport="sse")
        else:
            mcp.run(transport="streamable-http")
    else:
        mcp.run(transport="stdio")
