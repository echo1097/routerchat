from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlsplit

HOME_NETWORKS = (
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
)


def isHomeNetworkAddress(value: str) -> bool:
    try:
        address = ipaddress.IPv4Address(value)
    except ValueError:
        return False

    return any(address in network for network in HOME_NETWORKS)


def detectLanAddress() -> str | None:
    probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        probe.connect(("192.0.2.1", 9))
        address = probe.getsockname()[0]
    except OSError:
        return None
    finally:
        probe.close()

    return address if isHomeNetworkAddress(address) else None


def validatePhoneOrigin(value: str) -> str:
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise RuntimeError("RouterChat phone address is invalid.") from exc

    if (
        parsed.scheme != "http"
        or not isHomeNetworkAddress(parsed.hostname or "")
        or port is None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in ("", "/")
        or parsed.query
        or parsed.fragment
    ):
        raise RuntimeError("RouterChat phone address must be a home network HTTP origin.")

    return f"http://{parsed.hostname}:{port}"
