import asyncio
import unittest
from unittest.mock import patch

import httpx

import backend.providers.streaming as streaming
from backend.providers.anthropic.adapter import anthropicProvider
from backend.providers.base import ChatRequest


def failingClient(lines, failure, failAfterLines=None):
    class FakeStreamResponse:
        status_code = 200
        headers = {"request-id": "req_fixture"}

        async def __aenter__(self):
            if failAfterLines is None:
                raise failure
            return self

        async def __aexit__(self, *_):
            return False

        async def aiter_lines(self):
            for index, line in enumerate(lines):
                if index == failAfterLines:
                    raise failure
                yield line
            raise failure

    class FakeClient:
        def __init__(self, *_args, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        def stream(self, *_args, **_kwargs):
            return FakeStreamResponse()

    return FakeClient


def runFailingStream(failure, lines=(), failAfterLines=None):
    request = ChatRequest(url="https://example.invalid", headers={}, body={})

    async def collect():
        return [event async for event in streaming.streamChat(anthropicProvider, request)]

    client = failingClient(list(lines), failure, failAfterLines)
    with patch.object(streaming.httpx, "AsyncClient", client):
        return asyncio.run(collect())


TEXT_LINES = [
    'data: {"type":"message_start","message":{"id":"msg_1","model":"claude-sonnet-5-5","usage":{"input_tokens":5}}}',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Once upon"}}',
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":" a time"}}',
]


class StreamFailureTest(unittest.TestCase):
    def test_a_timeout_becomes_a_timeout_error(self):
        events = runFailingStream(httpx.ReadTimeout("timed out"))

        self.assertEqual(events[-1]["type"], "error")
        self.assertEqual(events[-1]["error"].kind, "timeout")
        self.assertEqual(events[-1]["error"].title, "Anthropic took too long")

    def test_no_connection_says_the_provider_was_unreachable(self):
        events = runFailingStream(httpx.ConnectError("All connection attempts failed"))

        self.assertEqual(events[-1]["error"].kind, "unreachable")
        self.assertNotIn("All connection attempts failed", events[-1]["error"].message)

    def test_a_dropped_connection_keeps_the_text_received_so_far(self):
        events = runFailingStream(
            httpx.RemoteProtocolError("peer closed connection"), TEXT_LINES, failAfterLines=2
        )
        content = "".join(event.get("content") or "" for event in events if event["type"] == "chunk")

        self.assertEqual(content, "Once upon")
        self.assertEqual(events[-1]["type"], "error")
        self.assertEqual(events[-1]["error"].kind, "network")

    def test_a_timeout_mid_reply_is_reported(self):
        events = runFailingStream(httpx.ReadTimeout("timed out"), TEXT_LINES, failAfterLines=3)

        self.assertEqual(events[-1]["error"].kind, "timeout")

    def test_malformed_chunks_are_skipped(self):
        events = runFailingStream(
            httpx.ReadError("reset"), ["data: {not json", *TEXT_LINES], failAfterLines=4
        )
        content = "".join(event.get("content") or "" for event in events if event["type"] == "chunk")

        self.assertEqual(content, "Once upon a time")
        self.assertEqual(events[-1]["error"].kind, "network")


if __name__ == "__main__":
    unittest.main()
