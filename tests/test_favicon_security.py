import socket
import unittest
from unittest.mock import patch

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
            originalUrl = str(request.url.copy_with(host=request.headers["host"]))
            payload = responses.get(originalUrl, {"status_code": 404})
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


if __name__ == "__main__":
    unittest.main()
