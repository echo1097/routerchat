import unittest
from unittest.mock import patch

from backend.providers.base import ChatOptions
from backend.providers.openrouter.adapter import openRouterProvider


LOREBOOK_STYLE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "lorebook_update",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "updates": {
                    "type": "array",
                    "minItems": 1,
                    "items": {
                        "oneOf": [
                            {
                                "type": "object",
                                "properties": {
                                    "name": {"type": "string", "minLength": 1},
                                    "index": {"type": "integer", "minimum": 0},
                                },
                                "required": ["name", "index"],
                                "additionalProperties": False,
                            },
                        ],
                    },
                },
            },
            "required": ["updates"],
            "additionalProperties": False,
        },
    },
}


def buildBody(model, **overrides):
    options = ChatOptions(
        apiKey="sk-or-test",
        temperature=0.1,
        maxTokens=800,
        responseFormat=LOREBOOK_STYLE_FORMAT,
        **overrides,
    )
    with patch("backend.providers.openrouter.adapter.requestOptions.openrouterProviderOptions", return_value=None):
        return openRouterProvider.buildRequest([], model, options).body


class OpenrouterAnthropicRequestTest(unittest.TestCase):
    def test_anthropic_models_get_a_cleaned_schema(self):
        body = buildBody("anthropic/claude-haiku-5.5")

        schema = body["response_format"]["json_schema"]["schema"]
        itemSchema = schema["properties"]["updates"]["items"]
        self.assertNotIn("oneOf", itemSchema)
        self.assertIn("anyOf", itemSchema)
        nameSchema = itemSchema["anyOf"][0]["properties"]["name"]
        self.assertNotIn("minLength", nameSchema)
        self.assertNotIn("minimum", itemSchema["anyOf"][0]["properties"]["index"])
        self.assertEqual(body["response_format"]["json_schema"]["name"], "lorebook_update")

    def test_other_models_keep_the_schema_as_written(self):
        body = buildBody("openai/gpt-5")

        self.assertIs(body["response_format"], LOREBOOK_STYLE_FORMAT)

    def test_anthropic_models_drop_temperature_when_reasoning_is_on(self):
        with patch(
            "backend.providers.openrouter.adapter.requestOptions.enabledReasoningConfig",
            return_value={"enabled": True, "exclude": False, "effort": "medium"},
        ):
            body = buildBody("anthropic/claude-haiku-5.5", thinkingEnabled=True)

        self.assertNotIn("temperature", body)
        self.assertEqual(body["reasoning"]["effort"], "medium")

    def test_anthropic_models_keep_temperature_without_reasoning(self):
        with patch(
            "backend.providers.openrouter.adapter.requestOptions.enabledReasoningConfig",
            return_value=None,
        ):
            body = buildBody("anthropic/claude-haiku-5.5")

        self.assertEqual(body["temperature"], 0.1)

    def test_other_models_keep_temperature_with_reasoning(self):
        with patch(
            "backend.providers.openrouter.adapter.requestOptions.enabledReasoningConfig",
            return_value={"enabled": True, "exclude": False, "effort": "high"},
        ):
            body = buildBody("openai/gpt-5", thinkingEnabled=True)

        self.assertEqual(body["temperature"], 0.1)


if __name__ == "__main__":
    unittest.main()
