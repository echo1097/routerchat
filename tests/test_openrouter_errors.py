import json
import unittest

from backend.providers.openrouter.adapter import openRouterProvider
from backend.providers.openrouter.errors import openrouterError, streamError


def errorBody(message, raw=None):
    error = {"message": message}
    if raw is not None:
        error["metadata"] = {"raw": raw, "provider_name": "Anthropic"}
    return json.dumps({"error": error})


ERROR_CASES = [
    (401, errorBody("No auth credentials found"), "badKey"),
    (402, errorBody("Insufficient credits"), "noCredit"),
    (429, errorBody("Rate limit exceeded"), "rateLimited"),
    (404, errorBody("No endpoints found for some/model"), "modelUnavailable"),
    (503, errorBody("No available provider"), "modelUnavailable"),
    (400, errorBody("This endpoint's maximum context length is 8192 tokens"), "contextTooLong"),
    (400, errorBody("Provider returned error", "prompt is too long: 210000 tokens"), "contextTooLong"),
    (403, errorBody("Input was flagged"), "contentRefused"),
    (400, errorBody("Bad request"), "badRequest"),
    (408, errorBody("Request timed out"), "timeout"),
    (500, errorBody("Internal error"), "serverError"),
    (502, "<html>", "serverError"),
]


class OpenrouterErrorTest(unittest.TestCase):
    def test_each_status_maps_to_a_kind(self):
        for statusCode, body, kind in ERROR_CASES:
            with self.subTest(statusCode=statusCode, kind=kind):
                self.assertEqual(openrouterError(statusCode, body).kind, kind)

    def test_every_kind_has_a_title_and_message(self):
        for statusCode, body, _ in ERROR_CASES:
            error = openrouterError(statusCode, body)
            self.assertTrue(error.title)
            self.assertTrue(error.message)

    def test_no_credit_says_what_to_do(self):
        error = openrouterError(402, errorBody("Insufficient credits"))

        self.assertEqual(error.title, "Out of OpenRouter credit")
        self.assertIn("Add credit", error.message)

    def test_bad_requests_include_the_provider_reason(self):
        error = openrouterError(
            400, errorBody("Provider returned error", "output_format.schema: oneOf is not supported")
        )

        self.assertEqual(
            error.message,
            "OpenRouter couldn't accept this request: "
            "Provider returned error (output_format.schema: oneOf is not supported).",
        )

    def test_long_reasons_are_cut_short(self):
        error = openrouterError(400, errorBody("x" * 1000))

        self.assertLess(len(error.message), 300)

    def test_mid_stream_errors_become_error_events(self):
        parsed = openRouterProvider.parseStreamChunk(
            {"id": "gen-1", "error": {"code": "server_error", "message": "Upstream died"}}
        )

        self.assertEqual(parsed["event"], "error")
        self.assertEqual(parsed["error"].kind, "serverError")

    def test_numeric_stream_error_codes_are_used(self):
        self.assertEqual(streamError({"code": 429, "message": "slow down"}).kind, "rateLimited")

    def test_errors_serialize_for_the_frontend(self):
        error = openrouterError(401, errorBody("No auth credentials found"))

        self.assertEqual(
            json.loads(error.toJson()),
            {"kind": "badKey", "title": error.title, "message": error.message, "provider": "OpenRouter"},
        )


if __name__ == "__main__":
    unittest.main()
