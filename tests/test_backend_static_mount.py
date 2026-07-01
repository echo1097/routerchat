from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from fastapi import FastAPI
from fastapi.testclient import TestClient

from backend.main import configure_static_files


class BackendStaticMountTest(unittest.TestCase):
    def test_missing_static_dir_keeps_api_routes_available(self) -> None:
        test_app = FastAPI()

        @test_app.get("/api/health")
        def health() -> dict[str, bool]:
            return {"ok": True}

        configure_static_files(test_app, Path("/tmp/routerchat-no-dist-here"))

        client = TestClient(test_app)

        health_response = client.get("/api/health")
        root_response = client.get("/")

        self.assertEqual(health_response.status_code, 200)
        self.assertEqual(health_response.json(), {"ok": True})
        self.assertEqual(root_response.status_code, 503)
        self.assertEqual(
            root_response.text,
            "frontend build missing, run npm run build",
        )

    def test_existing_static_dir_serves_index(self) -> None:
        with TemporaryDirectory() as temp_dir:
            static_dir = Path(temp_dir)
            (static_dir / "index.html").write_text(
                "<!doctype html><title>RouterChat</title>",
                encoding="utf-8",
            )

            test_app = FastAPI()
            configure_static_files(test_app, static_dir)

            client = TestClient(test_app)
            response = client.get("/")

        route_names = {route.name for route in test_app.routes}

        self.assertIn("static", route_names)
        self.assertEqual(response.status_code, 200)
        self.assertIn("RouterChat", response.text)


if __name__ == "__main__":
    unittest.main()
