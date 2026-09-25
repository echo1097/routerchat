from __future__ import annotations

import asyncio
import ipaddress
import re
import socket

import httpx

FAVICON_TIMEOUT = httpx.Timeout(connect=4.0, read=6.0, write=4.0, pool=4.0)
BLOCKED_FAVICON_HOSTS = {"localhost", "localhost.localdomain", "broadcasthost"}
BLOCKED_FAVICON_SUFFIXES = (".local", ".internal", ".localhost", ".test", ".invalid", ".onion")


def safe_favicon_domain(raw: str) -> str | None:
    domain = (raw or "").strip().lower().rstrip(".")

    if not domain or len(domain) > 253:
        return None
    if not re.fullmatch(r"[a-z0-9.-]+", domain):
        return None
    if ".." in domain or domain.startswith("-") or domain.startswith("."):
        return None

    labels = domain.split(".")
    if len(labels) < 2 or any(not label for label in labels):
        return None
    if domain in BLOCKED_FAVICON_HOSTS or domain.endswith(BLOCKED_FAVICON_SUFFIXES):
        return None

    try:
        ipaddress.ip_address(domain)
        return None
    except ValueError:
        return domain


class FaviconTransport(httpx.AsyncBaseTransport):
    def __init__(self):
        self.transports = {}

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        host = request.url.raw_host.decode("ascii")
        if (
            request.url.scheme != "https"
            or not safe_favicon_domain(host)
            or request.url.userinfo
        ):
            raise httpx.ConnectError("Unsafe favicon URL", request=request)

        port = request.url.port or 443
        try:
            addressInfo = await asyncio.wait_for(
                asyncio.get_running_loop().getaddrinfo(host, port, type=socket.SOCK_STREAM),
                timeout=FAVICON_TIMEOUT.connect,
            )
            addresses = list(dict.fromkeys(item[4][0] for item in addressInfo))
            if not addresses:
                raise ValueError("No favicon addresses")

            for addressText in addresses:
                address = ipaddress.ip_address(addressText)
                if not address.is_global or address.is_multicast:
                    raise ValueError("Non-public favicon address")
                if isinstance(address, ipaddress.IPv6Address) and (
                    address.ipv4_mapped
                    or address.sixtofour
                    or address.teredo
                    or address in ipaddress.ip_network("::/96")
                    or address in ipaddress.ip_network("64:ff9b::/96")
                ):
                    raise ValueError("Translated favicon address")
        except (OSError, ValueError, TimeoutError) as error:
            raise httpx.ConnectError("Unsafe or unresolved favicon host", request=request) from error

        for addressIndex, addressText in enumerate(addresses):
            transportKey = (host, addressText, port)
            if transportKey not in self.transports:
                self.transports[transportKey] = httpx.AsyncHTTPTransport(trust_env=False)

            pinnedRequest = httpx.Request(
                request.method,
                request.url.copy_with(host=addressText),
                headers=request.headers,
                stream=request.stream,
                extensions={**request.extensions, "sni_hostname": host},
            )
            try:
                return await self.transports[transportKey].handle_async_request(pinnedRequest)
            except (httpx.ConnectError, httpx.ConnectTimeout):
                if addressIndex == len(addresses) - 1:
                    raise

        raise httpx.ConnectError("Unable to reach favicon host", request=request)

    async def aclose(self):
        for transport in self.transports.values():
            await transport.aclose()
