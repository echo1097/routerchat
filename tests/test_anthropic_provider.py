import asyncio
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import backend.main as main
import backend.core.paths as paths
import backend.providers.streaming as streaming
from backend.providers.anthropic import modelRules, models, requestBuilder
from backend.providers.anthropic.adapter import anthropicProvider
from backend.providers.anthropic.pricing import costFor
from backend.providers.anthropic.schemaCleaner import cleanSchema
from backend.providers.anthropic.streamParser import completionText
from backend.providers.base import ChatOptions, ChatRequest
from backend.providers.registry import getActiveProvider, setActiveProvider

FIXTURE_DIR = Path(__file__).parent / "fixtures" / "anthropic"


def fakeStreamClient(lines, statusCode=200, headers=None):
    class FakeStreamResponse:
        status_code = statusCode

        def __init__(self):
            self.headers = headers or {"request-id": "req_fixture"}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_):
            return False

        async def aiter_lines(self):
            for line in lines:
                yield line

        async def aread(self):
            return "\n".join(lines).encode("utf-8")

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


def runStream(lines, statusCode=200):
    request = ChatRequest(url="https://example.invalid", headers={}, body={})

    async def collect():
        events = []
        async for event in streaming.streamChat(anthropicProvider, request):
            events.append(event)
        return events

    with patch.object(streaming.httpx, "AsyncClient", fakeStreamClient(lines, statusCode)):
        return asyncio.run(collect())


def runFixture(name):
    return runStream((FIXTURE_DIR / name).read_text(encoding="utf-8").splitlines())


def chunksOf(events):
    return [event for event in events if event["type"] == "chunk"]


def options(**overrides):
    values = {"apiKey": "test-key", "temperature": 0.7, "maxTokens": 4000}
    values.update(overrides)
    return ChatOptions(**values)


def bodyFor(modelId, messages=None, modelLimit=None, **overrides):
    return requestBuilder.buildBody(
        messages or [{"role": "user", "content": "Hi"}],
        modelId,
        options(**overrides),
        modelRules.rulesFor(modelId),
        modelLimit,
    )


class StreamParserTest(unittest.TestCase):
    def test_text_stream_ends_on_message_stop_with_one_usage(self):
        events = runFixture("textOnly.sse")
        chunks = chunksOf(events)

        self.assertEqual(events[0], {"type": "open", "generationId": "req_fixture"})
        self.assertEqual(events[-1], {"type": "done"})
        self.assertEqual("".join(chunk["content"] or "" for chunk in chunks), "Hello there")

        usageChunks = [chunk for chunk in chunks if chunk["usage"]]
        self.assertEqual(len(usageChunks), 1)
        usage = usageChunks[0]["usage"]
        self.assertEqual(usage["prompt_tokens"], 25)
        self.assertEqual(usage["completion_tokens"], 12)
        self.assertEqual(usage["total_tokens"], 37)
        self.assertIsNone(usage["reasoning_tokens"])
        self.assertAlmostEqual(usage["cost"], (25 * 2 + 12 * 10) / 1_000_000)

        finishChunks = [chunk for chunk in chunks if chunk["finishReason"]]
        self.assertEqual(len(finishChunks), 1)
        self.assertEqual(finishChunks[0]["finishReason"], "stop")
        self.assertTrue(finishChunks[0]["hasChoice"])
        self.assertEqual(finishChunks[0]["id"], "msg_text01")

    def test_thinking_becomes_reasoning_and_max_tokens_becomes_length(self):
        chunks = chunksOf(runFixture("thinkingOn.sse"))

        reasoning = "".join(chunk["reasoning"] or "" for chunk in chunks)
        content = "".join(chunk["content"] or "" for chunk in chunks)
        finishReasons = [chunk["finishReason"] for chunk in chunks if chunk["finishReason"]]

        self.assertEqual(reasoning, "The user wants a greeting.")
        self.assertEqual(content, "Hi!")
        self.assertEqual(finishReasons, ["length"])

    def test_refusal_is_reported_as_an_error(self):
        events = runFixture("refusal.sse")

        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("declined", events[-1]["message"])
        self.assertIn("safety filter", events[-1]["message"])
        self.assertFalse(any(event["type"] == "done" for event in events))

    def test_mid_stream_error_is_reported_as_an_error(self):
        events = runFixture("midStreamError.sse")

        self.assertEqual(events[-1]["type"], "error")
        self.assertIn("overloaded", events[-1]["message"])
        self.assertEqual(
            "".join(chunk["content"] or "" for chunk in chunksOf(events)), "Once upon"
        )

    def test_cache_hit_counts_cached_tokens_in_the_prompt_and_the_cost(self):
        chunks = chunksOf(runFixture("cacheHit.sse"))
        usage = next(chunk["usage"] for chunk in chunks if chunk["usage"])

        self.assertEqual(usage["prompt_tokens"], 100 + 3000 + 20000)
        self.assertEqual(usage["cached_tokens"], 20000)
        self.assertEqual(usage["completion_tokens"], 500)

        expectedCost = (
            100 * 2.0 + 20000 * 0.20 + 1000 * 2.5 + 2000 * 4.0 + 500 * 10.0
        ) / 1_000_000
        self.assertAlmostEqual(usage["cost"], expectedCost)

    def test_http_errors_get_readable_messages(self):
        overloaded = runStream(
            ['{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}'], 529
        )
        rateLimited = runStream(
            ['{"type":"error","error":{"type":"rate_limit_error","message":"Slow down"}}'], 429
        )

        self.assertIn("overloaded", overloaded[0]["message"])
        self.assertIn("rate limit", rateLimited[0]["message"])

    def test_unknown_models_have_no_cost(self):
        self.assertIsNone(costFor("claude-next-9", {"input_tokens": 10, "output_tokens": 10}))

    def test_completion_text_skips_thinking_blocks(self):
        payload = {
            "stop_reason": "end_turn",
            "content": [
                {"type": "thinking", "thinking": "hidden"},
                {"type": "text", "text": "Trip "},
                {"type": "text", "text": "Planning"},
            ],
        }

        self.assertEqual(completionText(payload), "Trip Planning")
        self.assertIsNone(completionText({"stop_reason": "refusal", "content": []}))


class RequestBuilderTest(unittest.TestCase):
    def test_leading_system_messages_are_joined_into_the_system_field(self):
        body = bodyFor(
            "claude-sonnet-5-5",
            [
                {"role": "system", "content": "First rule."},
                {"role": "system", "content": "Second rule."},
                {"role": "user", "content": "Hi"},
            ],
        )

        self.assertEqual(body["system"], "First rule.\n\nSecond rule.")
        self.assertEqual(body["messages"], [{"role": "user", "content": "Hi"}])

    def test_attachments_become_image_and_document_blocks(self):
        body = bodyFor(
            "claude-sonnet-5-5",
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}},
                        {
                            "type": "file",
                            "file": {
                                "filename": "notes.pdf",
                                "file_data": "data:application/pdf;base64,QUJD\nREVG",
                            },
                        },
                        {"type": "text", "text": "Read these"},
                    ],
                }
            ],
        )

        blocks = body["messages"][0]["content"]
        self.assertEqual(
            blocks[0],
            {
                "type": "document",
                "source": {"type": "base64", "media_type": "application/pdf", "data": "QUJDREVG"},
            },
        )
        self.assertEqual(
            blocks[1],
            {
                "type": "image",
                "source": {"type": "base64", "media_type": "image/png", "data": "AAAA"},
            },
        )
        self.assertEqual(blocks[2], {"type": "text", "text": "Read these"})

    def test_story_cache_marks_and_top_level_cache_control_pass_through(self):
        cacheControl = {"type": "ephemeral", "ttl": "1h"}
        body = bodyFor(
            "claude-sonnet-5-5",
            [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": "Story title: X", "cache_control": cacheControl}
                    ],
                }
            ],
            cacheControl=cacheControl,
        )

        self.assertEqual(body["cache_control"], cacheControl)
        self.assertEqual(body["messages"][0]["content"][0]["cache_control"], cacheControl)

    def test_first_message_is_always_from_the_user(self):
        body = bodyFor("claude-sonnet-5-5", [{"role": "assistant", "content": "Earlier reply"}])

        self.assertEqual(body["messages"][0]["role"], "user")
        self.assertEqual(body["messages"][1], {"role": "assistant", "content": "Earlier reply"})

    def test_openrouter_only_options_are_ignored(self):
        body = bodyFor(
            "claude-sonnet-5-5",
            nitro=True,
            sessionId="chat-1",
            plugins=[{"id": "file-parser"}],
        )

        self.assertEqual(body["model"], "claude-sonnet-5-5")
        for key in ("plugins", "session_id", "provider", "reasoning"):
            self.assertNotIn(key, body)

    def test_temperature_is_only_sent_to_models_that_accept_it(self):
        for modelId in ("claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-5-5", "claude-opus-4-7", "claude-fable-5-1"):
            with self.subTest(modelId=modelId):
                self.assertNotIn("temperature", bodyFor(modelId))

        self.assertEqual(bodyFor("claude-haiku-4-5")["temperature"], 0.7)
        self.assertEqual(bodyFor("claude-sonnet-4-6", temperature=1.4)["temperature"], 1.0)
        self.assertNotIn("temperature", bodyFor("claude-haiku-4-5", thinkingEnabled=True))

    def test_adaptive_thinking_asks_for_summaries_and_maps_effort(self):
        body = bodyFor("claude-sonnet-5-5", thinkingEnabled=True, reasoningEffort="xhigh")

        self.assertEqual(body["thinking"], {"type": "adaptive", "display": "summarized"})
        self.assertEqual(body["output_config"]["effort"], "max")

    def test_sonnet_55_turns_thinking_off_with_between_tools(self):
        body = bodyFor("claude-sonnet-5-5", thinkingEnabled=False, reasoningEffort="max")

        self.assertEqual(body["thinking"], {"type": "between_tools"})
        self.assertEqual(body["output_config"]["effort"], "high")

    def test_older_adaptive_models_turn_thinking_off_with_disabled(self):
        for modelId in ("claude-sonnet-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-6"):
            with self.subTest(modelId=modelId):
                body = bodyFor(modelId, thinkingEnabled=False, reasoningEffort="max")
                self.assertEqual(body["thinking"], {"type": "disabled"})
                self.assertEqual(body["output_config"]["effort"], "high")

    def test_always_thinking_models_use_low_effort_and_room_for_titles(self):
        for modelId in ("claude-opus-5-5", "claude-fable-5-1"):
            with self.subTest(modelId=modelId):
                body = bodyFor(modelId, thinkingEnabled=False, maxTokens=32, stream=False)
                self.assertEqual(body["thinking"]["type"], "adaptive")
                self.assertEqual(body["output_config"]["effort"], "low")
                self.assertEqual(body["max_tokens"], requestBuilder.ALWAYS_THINKING_MIN_TOKENS)

        self.assertEqual(bodyFor("claude-sonnet-5-5", maxTokens=32)["max_tokens"], 32)

    def test_budget_models_get_a_budget_below_max_tokens(self):
        body = bodyFor("claude-haiku-4-5", thinkingEnabled=True, reasoningEffort="high")

        self.assertEqual(body["thinking"]["type"], "enabled")
        self.assertGreaterEqual(body["thinking"]["budget_tokens"], 1024)
        self.assertLess(body["thinking"]["budget_tokens"], body["max_tokens"])
        self.assertNotIn("output_config", body)

        offBody = bodyFor("claude-haiku-4-5", thinkingEnabled=False)
        self.assertNotIn("thinking", offBody)

        tinyBody = bodyFor("claude-haiku-4-5", thinkingEnabled=True, maxTokens=500)
        self.assertNotIn("thinking", tinyBody)

    def test_budget_tokens_never_reach_current_models(self):
        for modelId in ("claude-sonnet-5-5", "claude-sonnet-5", "claude-opus-5-5", "claude-opus-4-7"):
            with self.subTest(modelId=modelId):
                body = bodyFor(modelId, thinkingEnabled=True)
                self.assertNotIn("budget_tokens", body["thinking"])

    def test_max_tokens_is_capped_at_the_model_limit(self):
        self.assertEqual(bodyFor("claude-haiku-4-5", maxTokens=90000, modelLimit=64000)["max_tokens"], 64000)

    def test_response_format_becomes_a_cleaned_output_format(self):
        responseFormat = {
            "type": "json_schema",
            "json_schema": {
                "name": "ideas",
                "strict": True,
                "schema": {
                    "type": "object",
                    "properties": {
                        "ideas": {
                            "type": "array",
                            "minItems": 5,
                            "maxItems": 5,
                            "items": {"type": "string", "minLength": 1, "maxLength": 80},
                        }
                    },
                    "required": ["ideas"],
                },
            },
        }

        body = bodyFor("claude-sonnet-5-5", responseFormat=responseFormat)

        self.assertEqual(
            body["output_config"]["format"],
            {
                "type": "json_schema",
                "schema": {
                    "type": "object",
                    "properties": {"ideas": {"type": "array", "items": {"type": "string"}}},
                    "required": ["ideas"],
                    "additionalProperties": False,
                },
            },
        )
        self.assertNotIn("response_format", body)


class SchemaCleanerTest(unittest.TestCase):
    def test_keeps_properties_that_share_a_keyword_name(self):
        schema = {
            "type": "object",
            "properties": {
                "minimum": {"type": "integer", "minimum": 1, "maximum": 9, "multipleOf": 2},
                "tags": {"type": "array", "minItems": 1, "items": {"type": "string"}},
            },
        }

        cleaned = cleanSchema(schema)

        self.assertEqual(cleaned["properties"]["minimum"], {"type": "integer"})
        self.assertEqual(cleaned["properties"]["tags"]["minItems"], 1)

    def test_cleans_nested_definitions_and_unions(self):
        schema = {
            "$defs": {"name": {"type": "string", "maxLength": 5}},
            "anyOf": [{"type": "number", "minimum": 0}, {"type": "null"}],
        }

        cleaned = cleanSchema(schema)

        self.assertEqual(cleaned["$defs"]["name"], {"type": "string"})
        self.assertEqual(cleaned["anyOf"][0], {"type": "number"})

    def test_every_app_schema_is_clean(self):
        from backend.brainstorm.generateBrainstorm import brainstorm_response_format
        from backend.lorebook.generateEntry import lorebook_generate_response_format
        from backend.lorebook.repairLorebook import lorebook_repair_response_format
        from backend.lorebook.runUpdate import lorebook_update_response_format
        from backend.lorebook.timelineRepair import timeline_repair_response_format
        from backend.writing.storyGeneration import chapter_edit_response_format

        formats = {
            "brainstorm": brainstorm_response_format(5),
            "lorebookGenerate": lorebook_generate_response_format(),
            "lorebookUpdate": lorebook_update_response_format(),
            "lorebookRepair": lorebook_repair_response_format([{"id": 1}, {"id": 2}]),
            "timelineRepair": timeline_repair_response_format(),
            "chapterEdits": chapter_edit_response_format(),
        }
        banned = {"minLength", "maxLength", "minimum", "maximum", "multipleOf", "maxItems"}

        def check(node, name):
            if isinstance(node, list):
                for child in node:
                    check(child, name)
                return
            if not isinstance(node, dict):
                return
            properties = node.get("properties")
            for key, value in node.items():
                if key == "properties":
                    continue
                self.assertNotIn(key, banned, name)
                if key == "minItems":
                    self.assertIn(value, {0, 1}, name)
                check(value, name)
            if isinstance(properties, dict):
                self.assertIs(node.get("additionalProperties"), False, name)
                for child in properties.values():
                    check(child, name)

        for name, responseFormat in formats.items():
            with self.subTest(name=name):
                formatConfig = requestBuilder.outputFormat(responseFormat)
                self.assertIsNotNone(formatConfig)
                check(formatConfig["schema"], name)


class ModelNormalizeTest(unittest.TestCase):
    def test_model_shape_carries_limits_thinking_and_temperature(self):
        model = models.normalizeModel(
            {
                "id": "claude-opus-5-5",
                "display_name": "Claude Opus 5.5",
                "max_input_tokens": 1000000,
                "max_tokens": 128000,
                "capabilities": {
                    "image_input": {"supported": True},
                    "structured_outputs": {"supported": True},
                    "thinking": {
                        "supported": True,
                        "types": {
                            "enabled": {"supported": False},
                            "adaptive": {"supported": True},
                        },
                    },
                    "effort": {
                        "supported": True,
                        "low": {"supported": True},
                        "medium": {"supported": True},
                        "high": {"supported": True},
                        "xhigh": {"supported": True},
                        "max": {"supported": True},
                    },
                },
            }
        )

        self.assertEqual(model["context_length"], 1000000)
        self.assertEqual(model["top_provider"]["max_completion_tokens"], 128000)
        self.assertIn("image", model["architecture"]["input_modalities"])
        self.assertIn("structured_outputs", model["supported_parameters"])
        self.assertTrue(model["reasoning"]["mandatory"])
        self.assertEqual(model["reasoning"]["supported_efforts"], ["low", "medium", "high", "xhigh", "max"])
        self.assertFalse(model["temperature"])
        self.assertEqual(float(model["pricing"]["prompt"]) * 1_000_000, 4.0)

    def test_unknown_adaptive_models_use_the_safest_rules(self):
        rules = modelRules.rulesFor(
            "claude-opus-9",
            {"thinking": {"supported": True, "types": {"adaptive": {"supported": True}}}},
        )

        self.assertEqual(rules, modelRules.ALWAYS_THINKING)

    def test_dated_ids_match_their_family(self):
        self.assertEqual(modelRules.rulesFor("claude-haiku-4-5-20251001"), modelRules.BUDGET_THINKING)
        self.assertEqual(modelRules.rulesFor("claude-opus-4-5-20251101"), modelRules.BUDGET_THINKING)


class ProviderSwitchTest(unittest.TestCase):
    def setUp(self):
        self.tempDir = tempfile.TemporaryDirectory()
        self.originalDataDir = paths.DATA_DIR
        self.originalDbPath = paths.DB_PATH
        self.originalEnvPath = paths.ENV_PATH
        paths.DATA_DIR = Path(self.tempDir.name)
        paths.DB_PATH = paths.DATA_DIR / "test.sqlite3"
        paths.ENV_PATH = paths.DATA_DIR / ".env"

        self.environPatch = patch.dict(os.environ, {}, clear=False)
        self.environPatch.start()
        os.environ.pop("ANTHROPIC_API_KEY", None)
        os.environ.pop("OPENROUTER_API_KEY", None)

        main.init_db()

    def tearDown(self):
        self.environPatch.stop()
        paths.DATA_DIR = self.originalDataDir
        paths.DB_PATH = self.originalDbPath
        paths.ENV_PATH = self.originalEnvPath
        self.tempDir.cleanup()

    def test_active_provider_defaults_to_openrouter_and_is_saved(self):
        self.assertEqual(getActiveProvider().id, "openrouter")

        setActiveProvider("anthropic")

        self.assertEqual(getActiveProvider().id, "anthropic")

    def test_anthropic_key_is_stored_next_to_the_openrouter_key(self):
        paths.ENV_PATH.write_text("OPENROUTER_API_KEY=or-key\n", encoding="utf-8")

        anthropicProvider.writeKey("sk-ant-test")

        lines = paths.ENV_PATH.read_text(encoding="utf-8").splitlines()
        self.assertEqual(lines, ["OPENROUTER_API_KEY=or-key", "ANTHROPIC_API_KEY=sk-ant-test"])
        self.assertEqual(anthropicProvider.readKey(), "sk-ant-test")

    def test_default_model_comes_from_the_model_list(self):
        anthropicProvider.cacheModels(
            [{"id": "claude-fable-5-1"}, {"id": "claude-sonnet-5-5"}, {"id": "claude-haiku-4-5"}]
        )

        self.assertEqual(anthropicProvider.defaultModelId(), "claude-sonnet-5-5")

    def test_always_thinking_models_report_thinking_as_on(self):
        self.assertTrue(anthropicProvider.effectiveThinkingEnabled("claude-opus-5-5", False))
        self.assertFalse(anthropicProvider.effectiveThinkingEnabled("claude-sonnet-5-5", False))


if __name__ == "__main__":
    unittest.main()
