import json
import unittest

from backend.providers.openrouter.errors import openrouterErrorMessage


class OpenrouterErrorMessageTest(unittest.TestCase):
    def test_a_plain_message_is_kept(self):
        body = json.dumps({"error": {"message": "Bad request"}})

        self.assertEqual(openrouterErrorMessage(400, body), "OpenRouter error 400: Bad request")

    def test_the_provider_detail_is_added_when_openrouter_includes_it(self):
        body = json.dumps({
            "error": {
                "message": "Provider returned error",
                "metadata": {
                    "raw": "output_format.schema: oneOf is not supported",
                    "provider_name": "Anthropic",
                },
            }
        })

        self.assertEqual(
            openrouterErrorMessage(400, body),
            "OpenRouter error 400: Provider returned error (output_format.schema: oneOf is not supported)",
        )

    def test_a_structured_detail_is_serialized(self):
        body = json.dumps({
            "error": {
                "message": "Provider returned error",
                "metadata": {"raw": {"type": "invalid_request_error", "message": "temperature"}},
            }
        })

        self.assertIn('"invalid_request_error"', openrouterErrorMessage(400, body))

    def test_unparseable_bodies_fall_back_to_the_raw_text(self):
        self.assertEqual(openrouterErrorMessage(502, "<html>"), "OpenRouter error 502: <html>")


if __name__ == "__main__":
    unittest.main()
