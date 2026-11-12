from __future__ import annotations

import socket
from typing import Any
from urllib.parse import urlsplit

PHONE_HOST_NAME = "routerchat.local"
SERVICE_TYPE = "_http._tcp.local."
SERVICE_NAME = f"RouterChat.{SERVICE_TYPE}"


def phoneNameOrigin(port: int) -> str:
    return f"http://{PHONE_HOST_NAME}:{port}"


def validatePhoneNameOrigin(value: str, phoneOrigin: str) -> str:
    expected = phoneNameOrigin(urlsplit(phoneOrigin).port)
    if value != expected:
        raise RuntimeError("RouterChat phone name must match the phone address port.")

    return expected


def announceLocalName(address: str, port: int) -> Any | None:
    try:
        from zeroconf import Error, IPVersion, ServiceInfo, Zeroconf
    except ImportError:
        return None

    serviceInfo = ServiceInfo(
        SERVICE_TYPE,
        SERVICE_NAME,
        addresses=[socket.inet_aton(address)],
        port=port,
        server=f"{PHONE_HOST_NAME}.",
    )

    announcer = None
    try:
        announcer = Zeroconf(interfaces=[address], ip_version=IPVersion.V4Only)
        announcer.register_service(serviceInfo)
    except (OSError, Error):
        if announcer is not None:
            announcer.close()
        return None

    return announcer


def stopAnnouncing(announcer: Any | None) -> None:
    if announcer is None:
        return

    try:
        announcer.unregister_all_services()
    finally:
        announcer.close()
