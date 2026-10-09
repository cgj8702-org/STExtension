# Functions.py
# Back-compat wrapper around lovense_client.LovenseClient.
# Old signature SendFunctions(domainUrl, toys, commands, time_sec) still works,
# but new code should use control_toy() / LovenseClient directly.
from lovense_client import LovenseClient, sanitize_duration, sanitize_strength


def _client_for_domain(domain_url):
    # domain_url like "https://192-168-1-100.lovense.club:30010"
    try:
        rest = domain_url.split("://", 1)[1]
        hostport = rest.split("/", 1)[0]
        domain, port = hostport.rsplit(":", 1)
    except Exception:
        domain, port = "127-0-0-1.lovense.club", "30010"
    return LovenseClient(connection_mode="local",
                         local_domain=domain, local_port=port)


def SendFunctions(domainUrl, toys, commands, time_sec):
    """Legacy: commands like 'Vibrate:10'. Splits action/strength."""
    action, strength = "Vibrate", 10
    if commands:
        if ":" in str(commands):
            a, _, s = str(commands).partition(":")
            action = a or action
            try:
                strength = int(s)
            except ValueError:
                strength = 10
        else:
            action = str(commands)
    client = _client_for_domain(domainUrl)
    return client.send_command(action, strength, time_sec,
                               toy_id=toys or None)


def control_toy(client, action="Vibrate", strength=10,
                duration=5, toy_id=None, delay=0):
    """Full-parity helper: sanitise + optional delayed 'landmine' execution."""
    import time as _time
    from lovense_client import normalize_action
    action = normalize_action(action)
    strength = sanitize_strength(action, strength)
    duration = sanitize_duration(duration)
    if delay and int(delay) > 0:
        _time.sleep(int(delay))
    return client.send_command(action, strength, duration,
                               toy_id=toy_id or None)

