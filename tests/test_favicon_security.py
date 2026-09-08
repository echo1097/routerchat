import os
import socket
import ssl
import unittest
from unittest.mock import patch

import httpcore
import httpx

from backend import websearch


class FaviconSecurityTest(unittest.IsolatedAsyncioTestCase):
    async def fetchIcon(self, responses, addresses=None):
        self.requests = []
        self.resolvedHosts = []
        addresses = addresses or {}

        def resolveHost(host, port, *args, **kwargs):
            self.resolvedHosts.append(host)
            return [
                (socket.AF_INET6 if ":" in address else socket.AF_INET,
                 socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (address, port))
                for address in addresses.get(host, ["93.184.216.34"])
            ]

        async def sendRequest(transport, request):
            self.requests.append(request)
            originalHost = request.extensions.get("sni_hostname", request.url.host)
            originalUrl = str(request.url.copy_with(host=originalHost))
            payload = responses.get(originalUrl, {"status_code": 404})
            if isinstance(payload, Exception):
                raise payload
            return httpx.Response(**payload)

        with patch("socket.getaddrinfo", side_effect=resolveHost), patch.object(
            httpx.AsyncHTTPTransport, "handle_async_request", sendRequest
        ):
            return await websearch.fetch_favicon("example.com")

    async def testPrivateRedirectNeverReachesTransport(self):
        result = await self.fetchIcon({
            "https://example.com/favicon.ico": {
                "status_code": 302,
                "headers": {"location": "http://127.0.0.1/private"},
            },
            "http://127.0.0.1/private": {
                "status_code": 200,
                "headers": {"content-type": "image/png"},
                "content": b"private image",
            },
        })

        self.assertIsNone(result)
        self.assertEqual([request.headers["host"] for request in self.requests],
                         ["example.com", "example.com"])

    async def testPublicIconStillLoads(self):
        result = await self.fetchIcon({
            "https://example.com/favicon.ico": {
                "status_code": 200,
                "headers": {"content-type": "image/png"},
                "content": b"public image",
            },
        })

        self.assertEqual(result, ("image/png", b"public image"))

    async def testPrivateDnsNeverReachesTransport(self):
        result = await self.fetchIcon({
            "https://example.com/favicon.ico": {
                "status_code": 200,
                "headers": {"content-type": "image/png"},
                "content": b"private image",
            },
        }, {"example.com": ["10.0.0.1"]})

        self.assertIsNone(result)
        self.assertEqual(self.requests, [])

    async def testUnsafeTargetsAreBlockedAtEveryHop(self):
        for target in [
            "http://public.example/icon", "https://127.0.0.1/icon",
            "https://169.254.169.254/icon", "https://[::1]/icon",
            "https://router.local/icon", "https://vault.internal/icon",
            "https://user:password@public.example/icon", "https://127.1/icon",
            "https://private.example/icon",
        ]:
            for hop in ["direct", "page", "html", "iconRedirect"]:
                with self.subTest(target=target, hop=hop):
                    responses = {
                        "https://example.com/": {
                            "status_code": 200,
                            "text": '<link rel="icon" href="/icon.png">',
                        },
                    }
                    redirect = {"status_code": 302, "headers": {"location": target}}
                    if hop == "direct":
                        responses["https://example.com/favicon.ico"] = redirect
                    elif hop == "page":
                        responses["https://example.com/"] = redirect
                    elif hop == "html":
                        responses["https://example.com/"]["text"] = (
                            f'<link rel="icon" href="{target}">'
                        )
                    else:
                        responses["https://example.com/icon.png"] = redirect

                    result = await self.fetchIcon(responses, {
                        "private.example": ["10.0.0.1"],
                        "127.1": ["127.0.0.1"],
                    })

                    self.assertIsNone(result)
                    self.assertTrue(all(request.headers["host"] == "example.com"
                                        for request in self.requests))

    async def testNonPublicAndMixedDnsAnswersAreBlocked(self):
        for address in [
            "127.0.0.1", "10.0.0.1", "172.16.0.1", "192.168.1.1",
            "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1",
            "::1", "fe80::1", "fc00::1", "ff02::1", "::ffff:127.0.0.1",
            "64:ff9b::7f00:1", "2002:7f00:1::", "192.0.2.1",
        ]:
            for answers in [[address], ["93.184.216.34", address]]:
                with self.subTest(answers=answers):
                    result = await self.fetchIcon({}, {"example.com": answers})
                    self.assertIsNone(result)
                    self.assertEqual(self.requests, [])

    async def testPublicRedirectsAndRelativeCdnIconStillLoad(self):
        result = await self.fetchIcon({
            "https://example.com/": {
                "status_code": 302,
                "headers": {"location": "https://cdn.example/folder/page"},
            },
            "https://cdn.example/folder/page": {
                "status_code": 200,
                "text": '<link rel="icon" href="icon.png">',
            },
            "https://cdn.example/folder/icon.png": {
                "status_code": 302,
                "headers": {"location": "/final.png"},
            },
            "https://cdn.example/final.png": {
                "status_code": 200,
                "headers": {"content-type": "image/png"},
                "content": b"public image",
            },
        }, {"cdn.example": ["2606:4700:4700::1111"]})

        self.assertEqual(result, ("image/png", b"public image"))
        self.assertEqual(self.requests[-1].url.host, "2606:4700:4700::1111")
        self.assertEqual(self.requests[-1].headers["host"], "cdn.example")
        self.assertEqual(self.requests[-1].extensions["sni_hostname"], "cdn.example")

    async def testRedirectLimitStillApplies(self):
        result = await self.fetchIcon({
            "https://example.com/favicon.ico": {
                "status_code": 302,
                "headers": {"location": "/favicon.ico"},
            },
        })

        self.assertIsNone(result)
        self.assertEqual(len(self.requests), 5)

    async def testDnsFailureRemainsAnEmptyResult(self):
        for error in [socket.gaierror("no DNS"), TimeoutError("DNS timed out")]:
            with self.subTest(error=error), patch("socket.getaddrinfo", side_effect=error):
                self.assertIsNone(await websearch.fetch_favicon("example.com"))

    async def testConnectionUsesPinnedAddressAndOriginalTlsHostname(self):
        connections = []
        streams = []

        class FakeStream(httpcore.AsyncNetworkStream):
            def __init__(self):
                self.written = b""
                self.closed = False

            async def read(self, maxBytes, timeout=None):
                return (
                    b"HTTP/1.1 200 OK\r\nContent-Type: image/png\r\n"
                    b"Content-Length: 4\r\n\r\nicon"
                )

            async def write(self, buffer, timeout=None):
                self.written += buffer

            async def start_tls(self, ssl_context, server_hostname=None, timeout=None):
                self.tlsHostname = server_hostname
                self.sslContext = ssl_context
                return self

            async def aclose(self):
                self.closed = True

            def get_extra_info(self, info):
                return None

        async def connectTcp(backend, host, port, **kwargs):
            connections.append((host, port))
            if len(connections) == 1:
                raise httpcore.ConnectError("first public address unavailable")
            stream = FakeStream()
            streams.append(stream)
            return stream

        firstAnswer = [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", (address, 443))
            for address in ["93.184.216.34", "1.1.1.1"]
        ]
        reboundAnswer = [(socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP,
                          "", ("127.0.0.1", 443))]

        with patch("socket.getaddrinfo", side_effect=[firstAnswer, reboundAnswer]) as resolver, \
             patch.object(httpcore.AnyIOBackend, "connect_tcp", connectTcp), \
             patch.dict(os.environ, {"HTTPS_PROXY": "http://127.0.0.1:9999"}):
            result = await websearch.fetch_favicon("example.com")

        self.assertEqual(result, ("image/png", b"icon"))
        self.assertEqual(resolver.call_count, 1)
        self.assertEqual(connections, [("93.184.216.34", 443), ("1.1.1.1", 443)])
        self.assertEqual(streams[0].tlsHostname, "example.com")
        self.assertTrue(streams[0].sslContext.check_hostname)
        self.assertEqual(streams[0].sslContext.verify_mode, ssl.CERT_REQUIRED)
        self.assertIn(b"Host: example.com\r\n", streams[0].written)
        self.assertTrue(streams[0].closed)


if __name__ == "__main__":
    unittest.main()
