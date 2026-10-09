# StopFunction.py
# Back-compat wrapper around lovense_client.LovenseClient.
from lovense_client import LovenseClient


def _client_for_domain(domain_url):
    try:
        rest = domain_url.split("://", 1)[1]
        hostport = rest.split("/", 1)[0]
        domain, port = hostport.rsplit(":", 1)
    except Exception:
        domain, port = "127-0-0-1.lovense.club", "30010"
    return LovenseClient(connection_mode="local",
                         local_domain=domain, local_port=port)


def SendStopFunction(domainUrl, toys):
    """Immediately stop all running actions on toys."""
    client = _client_for_domain(domainUrl)
    result = client.stop_all(toy_id=toys or None)
    print("SendStopFunction Response: %s" % (result,))
    return result