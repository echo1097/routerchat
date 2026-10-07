import asyncio
import unittest
from unittest.mock import patch

from backend.providers.modelStream import ModelStream


def chunk(content=None, reasoning=None, usage=None, finishReason=None, hasChoice=True, sources=None, id="gen-1"):
    return {
        "type": "chunk",
        "id": id,
        "usage": usage,
        "hasChoice": hasChoice,
        "finishReason": finishReason,
        "reasoning": reasoning,
        "content": content,
        "sources": sources or [],
    }


class FakeProvider:
    def __init__(self, finalUsage=None):
        self.finalUsage = finalUsage
        self.calls = []

    async def fetchFinalUsage(self, apiKey, generationId):
        self.calls.append((apiKey, generationId))
        return self.finalUsage


def runStream(events, thinkingEnabled=True, provider=None):
    provider = provider or FakeProvider()

    async def fakeStreamChat(_provider, _request):
        for event in events:
            yield event

    stream = ModelStream(provider, None, thinkingEnabled)
    seen = []

    async def collect():
        async for event in stream.events():
            seen.append(event)

    with patch("backend.providers.modelStream.streamChat", fakeStreamChat):
        asyncio.run(collect())
    return stream, seen


class ModelStreamTest(unittest.TestCase):
    def test_a_normal_stream_collects_text_and_finishes(self):
        stream, seen = runStream([
            {"type": "open", "generationId": "gen-open"},
            chunk(content="Hel"),
            chunk(content="lo", finishReason="stop"),
            {"type": "done"},
        ])

        self.assertEqual(stream.text, "Hello")
        self.assertEqual(stream.finishReason, "stop")
        self.assertTrue(stream.receivedDone)
        self.assertIsNone(stream.errorMessage)
        self.assertEqual(stream.generationId, "gen-open")
        self.assertEqual(
            [event["type"] for event in seen],
            ["contentStart", "content", "content"],
        )

    def test_the_generation_id_falls_back_to_the_chunk_id(self):
        stream, _ = runStream([
            {"type": "open", "generationId": None},
            chunk(content="hi", id="gen-chunk"),
        ])

        self.assertEqual(stream.generationId, "gen-chunk")

    def test_an_error_event_is_recorded_not_raised(self):
        stream, seen = runStream([
            {"type": "open", "generationId": "gen-open"},
            {"type": "error", "message": "provider said no", "generationId": "gen-open"},
        ])

        self.assertEqual(stream.errorMessage, "provider said no")
        self.assertFalse(stream.receivedDone)
        self.assertEqual(seen, [])
        self.assertEqual(stream.generationId, "gen-open")

    def test_reasoning_is_dropped_when_thinking_is_off(self):
        stream, seen = runStream(
            [chunk(reasoning="hmm"), chunk(content="answer")],
            thinkingEnabled=False,
        )

        self.assertEqual(stream.reasoningParts, [])
        self.assertEqual([event["type"] for event in seen], ["contentStart", "content"])

    def test_reasoning_is_reported_when_thinking_is_on(self):
        stream, seen = runStream([chunk(reasoning="hmm"), chunk(content="answer")])

        self.assertEqual(stream.reasoningParts, ["hmm"])
        self.assertEqual(seen[0], {"type": "reasoning", "value": "hmm"})

    def test_a_usage_chunk_without_a_choice_only_adds_usage(self):
        stream, seen = runStream([
            chunk(content="hi"),
            chunk(hasChoice=False, usage={"prompt_tokens": 5, "cost": 0.1}),
            {"type": "done"},
        ])

        self.assertEqual(stream.usage, {"prompt_tokens": 5, "cost": 0.1})
        self.assertEqual(stream.text, "hi")

    def test_a_chunk_that_carries_usage_and_content_keeps_the_content(self):
        stream, _ = runStream([
            chunk(content="tail", finishReason="stop", usage={"prompt_tokens": 7}),
            {"type": "done"},
        ])

        self.assertEqual(stream.text, "tail")
        self.assertEqual(stream.finishReason, "stop")
        self.assertEqual(stream.usage, {"prompt_tokens": 7})

    def test_sources_are_reported_before_the_content_of_the_same_chunk(self):
        sources = [{"url": "https://example.com", "title": "Example"}]
        _, seen = runStream([chunk(content="cited", sources=sources)])

        self.assertEqual([event["type"] for event in seen], ["sources", "contentStart", "content"])
        self.assertEqual(seen[0]["value"], sources)

    def test_final_usage_is_merged_over_streamed_usage(self):
        provider = FakeProvider({"cost": 0.5})
        stream, _ = runStream(
            [chunk(content="hi", usage={"prompt_tokens": 3, "cost": 0.1})],
            provider=provider,
        )

        asyncio.run(stream.fetchFinalUsage("key"))

        self.assertEqual(stream.usage, {"prompt_tokens": 3, "cost": 0.5})
        self.assertEqual(provider.calls, [("key", "gen-1")])

    def test_final_usage_is_skipped_without_a_generation_id(self):
        provider = FakeProvider({"cost": 0.5})
        stream = ModelStream(provider, None)

        asyncio.run(stream.fetchFinalUsage("key"))

        self.assertEqual(provider.calls, [])
        self.assertEqual(stream.usage, {})


if __name__ == "__main__":
    unittest.main()
