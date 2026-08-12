import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import backend.main as main
from backend.local_access import create_secret_file


class ApiSecurityTest(unittest.TestCase):
    def setUp(self):
        self.tempDir = tempfile.TemporaryDirectory()
        self.originalDataDir = main.DATA_DIR
        self.originalDbPath = main.DB_PATH
        main.DATA_DIR = Path(self.tempDir.name) / "data"
        main.DB_PATH = main.DATA_DIR / "routerchat-security-test.sqlite3"
        main.init_db()
        tos = main.load_tos()
        main.record_tos_acceptance(tos["hash"], tos["date"])

        self.secretPath = Path(self.tempDir.name) / "api-secret"
        self.secret = create_secret_file(self.secretPath)
        self.baseUrl = "http://127.0.0.1:8000"
        self.environment = patch.dict(
            os.environ,
            {
                "ROUTERCHAT_API_SECRET_FILE": str(self.secretPath),
                "ROUTERCHAT_BASE_URL": self.baseUrl,
                "ROUTERCHAT_TRUSTED_ORIGINS": self.baseUrl,
            },
        )
        self.environment.start()
        main.reset_local_access_config()

        self.client = TestClient(
            main.app,
            base_url=self.baseUrl,
            headers={"Origin": self.baseUrl, "Sec-Fetch-Site": "same-origin"},
        )

    def tearDown(self):
        self.client.close()
        main.reset_local_access_config()
        self.environment.stop()
        main.DATA_DIR = self.originalDataDir
        main.DB_PATH = self.originalDbPath
        self.tempDir.cleanup()

    def bootstrap(self, secret=None):
        return self.client.post(
            "/api/bootstrap",
            data={"secret": self.secret if secret is None else secret},
            headers={"Origin": "null", "Sec-Fetch-Site": "cross-site"},
            follow_redirects=False,
        )

    def test_health_is_the_only_api_data_available_without_authentication(self):
        health = self.client.get("/api/health")
        tos = self.client.get("/api/tos")
        chats = self.client.get("/api/chats")
        apiRoot = self.client.get("/api")

        self.assertEqual(health.status_code, 200)
        self.assertEqual(set(health.json()), {"ok", "version"})
        self.assertEqual(tos.status_code, 401)
        self.assertEqual(chats.status_code, 401)
        self.assertEqual(apiRoot.status_code, 401)
        self.assertEqual(chats.json()["detail"]["code"], "api_auth_required")

    def test_unauthenticated_sensitive_routes_stop_before_route_execution(self):
        unauthenticated = TestClient(
            main.app,
            base_url=self.baseUrl,
            headers={"Origin": self.baseUrl, "Sec-Fetch-Site": "same-origin"},
        )
        try:
            requests = (
                unauthenticated.patch("/api/settings", json={"privacy_mode": True}),
                unauthenticated.post("/api/stories", json={"title": "stolen"}),
                unauthenticated.post(
                    "/api/chats/missing/messages/stream",
                    json={"message": "spend money", "model": "test/model"},
                ),
            )
        finally:
            unauthenticated.close()

        self.assertTrue(all(response.status_code == 401 for response in requests))
        self.assertTrue(
            all(response.json()["detail"]["code"] == "api_auth_required" for response in requests)
        )

    def test_bootstrap_sets_a_scoped_http_only_cookie_without_leaking_the_secret(self):
        response = self.bootstrap()

        self.assertEqual(response.status_code, 303)
        self.assertEqual(response.headers["location"], "/")
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertNotIn(self.secret, response.text)
        self.assertNotIn(self.secret, response.headers["location"])

        cookie = response.headers["set-cookie"]
        self.assertIn("routerchat_session=", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=strict", cookie)
        self.assertIn("Path=/api", cookie)
        self.assertNotIn("Max-Age", cookie)
        self.assertNotIn("Secure", cookie)

        self.assertEqual(self.client.get("/api/tos").status_code, 200)

    def test_missing_and_incorrect_bootstrap_secrets_have_the_same_response(self):
        missing = self.client.post(
            "/api/bootstrap",
            content=b"",
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            follow_redirects=False,
        )
        incorrect = self.bootstrap("wrong-secret")

        self.assertEqual(missing.status_code, 401)
        self.assertEqual(incorrect.status_code, 401)
        self.assertEqual(missing.json(), incorrect.json())
        self.assertNotIn(self.secret, missing.text + incorrect.text)

    def test_rotating_the_process_secret_invalidates_the_old_cookie(self):
        self.bootstrap()
        self.assertEqual(self.client.get("/api/tos").status_code, 200)

        rotatedPath = Path(self.tempDir.name) / "rotated-secret"
        create_secret_file(rotatedPath)
        os.environ["ROUTERCHAT_API_SECRET_FILE"] = str(rotatedPath)
        main.reset_local_access_config()

        self.assertEqual(self.client.get("/api/tos").status_code, 401)

    def test_host_validation_rejects_rebinding_names_and_wrong_ports(self):
        for host in (
            "attacker.example:8000",
            "localhost:8000",
            "127.0.0.1:9000",
            "127.0.0.1",
        ):
            with self.subTest(host=host):
                response = self.client.get("/api/health", headers={"Host": host})
                self.assertEqual(response.status_code, 400)

        self.assertEqual(
            self.client.get("/", headers={"Host": "rebind.example:8000"}).status_code,
            400,
        )

    def test_mutations_require_a_trusted_origin_and_same_origin_fetch_metadata(self):
        self.bootstrap()
        tosHash = main.load_tos()["hash"]

        missingOrigin = self.client.post(
            "/api/tos/accept",
            json={"hash": tosHash},
            headers={"Origin": ""},
        )
        hostileOrigin = self.client.post(
            "/api/tos/accept",
            json={"hash": tosHash},
            headers={"Origin": "https://attacker.example"},
        )
        crossSite = self.client.post(
            "/api/tos/accept",
            json={"hash": tosHash},
            headers={"Sec-Fetch-Site": "cross-site"},
        )
        allowed = self.client.post("/api/tos/accept", json={"hash": tosHash})

        self.assertEqual(missingOrigin.status_code, 403)
        self.assertEqual(hostileOrigin.status_code, 403)
        self.assertEqual(crossSite.status_code, 403)
        self.assertEqual(allowed.status_code, 200)

    def test_explicit_development_origin_can_be_trusted_without_a_wildcard(self):
        os.environ["ROUTERCHAT_TRUSTED_ORIGINS"] = (
            "http://127.0.0.1:8000,http://127.0.0.1:5173"
        )
        main.reset_local_access_config()
        self.bootstrap()
        tosHash = main.load_tos()["hash"]

        response = self.client.post(
            "/api/tos/accept",
            json={"hash": tosHash},
            headers={"Origin": "http://127.0.0.1:5173"},
        )

        self.assertEqual(response.status_code, 200)

    def test_configuration_fails_closed_without_a_secret_file(self):
        with self.assertRaisesRegex(RuntimeError, "ROUTERCHAT_API_SECRET_FILE"):
            main.load_local_access_config({})

    def test_duplicate_host_headers_are_rejected(self):
        response = self.client.get(
            "/api/health",
            headers=[
                ("Host", "127.0.0.1:8000"),
                ("Host", "attacker.example:8000"),
            ],
        )

        self.assertEqual(response.status_code, 400)


if __name__ == "__main__":
    unittest.main()
