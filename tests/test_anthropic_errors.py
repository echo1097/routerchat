import json
import unittest

from backend.providers.anthropic.errors import anthropicError, refusalError, streamError


def errorBody(errorType, message):
    return json.dumps({"type": "error", "error": {"type": errorType, "message": message}})


ERROR_CASES = [
    (401, errorBody("authentication_error", "invalid x-api-key"), "badKey"),
    (403, errorBody("permission_error", "Your key can't use this"), "badKey"),
    (
        400,
        errorBody("invalid_request_error", "Your credit balance is too low to access the Anthropic API."),
        "noCredit",
    ),
    (429, errorBody("rate_limit_error", "Slow down"), "rateLimited"),
    (404, errorBody("not_found_error", "model: claude-nope"), "modelUnavailable"),
    (400, errorBody("invalid_request_error", "prompt is too long: 250000 tokens > 200000 maximum"), "contextTooLong"),
    (400, errorBody("invalid_request_error", "max_tokens: must be positive"), "badRequest"),
    (500, errorBody("api_error", "Internal server error"), "serverError"),
    (529, errorBody("overloaded_error", "Overloaded"), "serverError"),
    (503, "<html>", "serverError"),
]


class AnthropicErrorTest(unittest.TestCase):
    def test_each_status_maps_to_a_kind(self):
        for statusCode, body, kind in ERROR_CASES:
            with self.subTest(statusCode=statusCode, kind=kind):
                self.assertEqual(anthropicError(statusCode, body).kind, kind)

    def test_bad_key_points_to_settings(self):
        error = anthropicError(401, errorBody("authentication_error", "invalid x-api-key"))

        self.assertEqual(error.title, "API key isn't working")
        self.assertIn("Settings", error.message)

    def test_bad_requests_include_the_reason(self):
        error = anthropicError(400, errorBody("invalid_request_error", "max_tokens: must be positive"))

        self.assertEqual(error.message, "Anthropic couldn't accept this request: max_tokens: must be positive.")

    def test_mid_stream_errors_use_the_error_type(self):
        error = streamError({"type": "error", "error": {"type": "overloaded_error", "message": "Overloaded"}})

        self.assertEqual(error.kind, "serverError")

    def test_refusals_explain_the_category(self):
        error = refusalError({"category": "cyber"})

        self.assertEqual(error.kind, "contentRefused")
        self.assertIn("cybersecurity filter", error.message)


if __name__ == "__main__":
    unittest.main()
