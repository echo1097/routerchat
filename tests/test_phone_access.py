import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import backend.core.paths as paths
import backend.devices.pairingCodes as pairingCodes
import backend.main as main
import backend.tos.loadTos as loadTos
import backend.tos.tosAcceptance as tosAcceptance
from backend.core.database import getDb
from backend.devices.lanAddress import isHomeNetworkAddress, validatePhoneOrigin
from backend.devices.phoneAccess import phoneListenAddress, setPhoneAccess
from backend.local_access import createSecretFile, serveLocalApp
from backend.security.localAccessConfig import loadLocalAccessConfig


class PhoneAccessTest(unittest.TestCase):
    def setUp(self):
        self.tempDir = tempfile.TemporaryDirectory()
        self.originalDataDir = paths.DATA_DIR
        self.originalDbPath = paths.DB_PATH
        paths.DATA_DIR = Path(self.tempDir.name) / "data"
        paths.DB_PATH = paths.DATA_DIR / "routerchat-phone-test.sqlite3"
        main.initDb()
        tos = loadTos.loadTos()
        tosAcceptance.recordTosAcceptance(tos["hash"], tos["date"])

        self.secretPath = Path(self.tempDir.name) / "api-secret"
        self.secret = createSecretFile(self.secretPath)
        self.baseUrl = "http://127.0.0.1:8000"
        self.phoneUrl = "http://192.168.1.20:8000"
        self.environment = patch.dict(
            os.environ,
            {
                "ROUTERCHAT_API_SECRET_FILE": str(self.secretPath),
                "ROUTERCHAT_BASE_URL": self.baseUrl,
                "ROUTERCHAT_TRUSTED_ORIGINS": self.baseUrl,
                "ROUTERCHAT_PHONE_ORIGIN": self.phoneUrl,
            },
        )
        self.environment.start()
        main.resetLocalAccessConfig()
        pairingCodes.clearPairingCode()
        setPhoneAccess(True)

        self.computer = self.makeClient(self.baseUrl)
        self.phone = self.makeClient(self.phoneUrl)
        self.computer.post(
            "/api/bootstrap",
            data={"secret": self.secret},
            headers={"Origin": "null", "Sec-Fetch-Site": "cross-site"},
            follow_redirects=False,
        )

    def tearDown(self):
        self.computer.close()
        self.phone.close()
        pairingCodes.clearPairingCode()
        main.resetLocalAccessConfig()
        self.environment.stop()
        paths.DATA_DIR = self.originalDataDir
        paths.DB_PATH = self.originalDbPath
        self.tempDir.cleanup()

    def makeClient(self, origin):
        return TestClient(
            main.app,
            base_url=origin,
            headers={"Origin": origin, "Sec-Fetch-Site": "same-origin"},
        )

    def newCode(self):
        response = self.computer.post("/api/devices/pairing-code")
        self.assertEqual(response.status_code, 200)
        return response.json()

    def pair(self, code, name="My iPhone", client=None):
        return (client or self.phone).post(
            "/api/devices/pair",
            json={"code": code, "name": name},
        )

    def pairPhone(self):
        response = self.pair(self.newCode()["code"])
        self.assertEqual(response.status_code, 200)
        return response

    def setLastSeen(self, lastSeen):
        with getDb() as conn:
            conn.execute("UPDATE paired_devices SET last_seen_at = ?", (lastSeen.isoformat(),))

    def test_phone_host_is_rejected_while_phone_access_is_not_running(self):
        del os.environ["ROUTERCHAT_PHONE_ORIGIN"]
        main.resetLocalAccessConfig()

        self.assertEqual(self.phone.get("/api/health").status_code, 400)
        self.assertEqual(self.phone.get("/").status_code, 400)
        self.assertEqual(self.computer.post("/api/devices/pairing-code").status_code, 409)

    def test_only_the_exact_phone_host_is_added_to_the_allowed_hosts(self):
        self.assertEqual(self.phone.get("/api/health").status_code, 200)

        for host in (
            "192.168.1.21:8000",
            "192.168.1.20:9000",
            "192.168.1.20",
            "rebind.example:8000",
        ):
            with self.subTest(host=host):
                response = self.phone.get("/api/health", headers={"Host": host})
                self.assertEqual(response.status_code, 400)

    def test_phone_address_must_be_a_home_network_address(self):
        for address in ("192.168.0.4", "10.1.2.3", "172.16.0.9", "172.31.255.1"):
            self.assertTrue(isHomeNetworkAddress(address), address)

        for address in (
            "127.0.0.1",
            "0.0.0.0",
            "8.8.8.8",
            "172.32.0.1",
            "169.254.1.1",
            "100.64.0.1",
            "::1",
            "example.com",
            "",
        ):
            self.assertFalse(isHomeNetworkAddress(address), address)

        for origin in (
            "http://8.8.8.8:8000",
            "https://192.168.1.20:8000",
            "http://192.168.1.20",
            "http://192.168.1.20:8000/path",
            "http://user@192.168.1.20:8000",
            "http://phone.example:8000",
        ):
            with self.subTest(origin=origin):
                with self.assertRaises(RuntimeError):
                    validatePhoneOrigin(origin)

        with self.assertRaises(RuntimeError):
            loadLocalAccessConfig({**os.environ, "ROUTERCHAT_PHONE_ORIGIN": "http://8.8.8.8:8000"})

    def test_unpaired_phone_gets_nothing_but_health(self):
        self.assertEqual(self.phone.get("/api/health").status_code, 200)
        self.assertEqual(self.phone.get("/api/chats").status_code, 401)
        self.assertEqual(self.phone.get("/api/tos").status_code, 401)
        self.assertEqual(self.phone.get("/api/devices").status_code, 401)
        self.assertEqual(self.phone.get("/api/devices/session").status_code, 401)
        self.assertEqual(self.phone.post("/api/devices/pairing-code").status_code, 401)

    def test_pairing_gives_the_phone_its_own_scoped_cookie(self):
        pairing = self.newCode()
        self.assertEqual(pairing["link"], f"{self.phoneUrl}/#pair={pairing['code']}")
        self.assertEqual(len(pairing["code"]), 8)

        response = self.pair(pairing["code"])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True, "name": "My iPhone"})

        cookie = response.headers["set-cookie"]
        self.assertIn("routerchat_device=", cookie)
        self.assertIn("HttpOnly", cookie)
        self.assertIn("SameSite=strict", cookie)
        self.assertIn("Path=/api", cookie)
        self.assertNotIn(self.secret, cookie)
        self.assertNotIn(self.secret, response.text)

        self.assertEqual(self.phone.get("/api/chats").status_code, 200)
        self.assertEqual(self.phone.get("/api/devices/session").json(), {"kind": "device"})
        self.assertEqual(self.computer.get("/api/devices/session").json(), {"kind": "computer"})

        devices = self.computer.get("/api/devices").json()
        self.assertTrue(devices["enabled"])
        self.assertTrue(devices["running"])
        self.assertFalse(devices["restartNeeded"])
        self.assertFalse(devices["pairingActive"])
        self.assertEqual(devices["address"], self.phoneUrl)
        self.assertEqual([device["name"] for device in devices["devices"]], ["My iPhone"])
        self.assertNotIn("token", str(devices).lower())

    def test_device_token_is_stored_only_as_a_hash(self):
        response = self.pairPhone()
        token = response.cookies.get("routerchat_device") or self.phone.cookies.get("routerchat_device")

        with getDb() as conn:
            row = conn.execute("SELECT * FROM paired_devices").fetchone()

        self.assertTrue(token)
        self.assertNotIn(token, [row[key] for key in row.keys()])
        self.assertEqual(len(row["token_hash"]), 64)

    def test_pairing_code_works_once(self):
        code = self.newCode()["code"]
        self.assertEqual(self.pair(code).status_code, 200)

        secondPhone = self.makeClient(self.phoneUrl)
        try:
            self.assertEqual(self.pair(code, client=secondPhone).status_code, 401)
            self.assertEqual(secondPhone.get("/api/chats").status_code, 401)
        finally:
            secondPhone.close()

    def test_typed_codes_ignore_case_spaces_and_dashes(self):
        code = self.newCode()["code"]
        typed = f" {code[:4].lower()}-{code[4:].lower()} "

        self.assertEqual(self.pair(typed).status_code, 200)

    def test_wrong_codes_fail_and_five_misses_burn_the_code(self):
        code = self.newCode()["code"]

        for _ in range(5):
            response = self.pair("WRONGCODE")
            self.assertEqual(response.status_code, 401)
            self.assertEqual(response.json()["detail"]["code"], "pairing_failed")

        self.assertEqual(self.pair(code).status_code, 401)
        self.assertEqual(self.phone.get("/api/chats").status_code, 401)

    def test_pairing_code_expires_after_two_minutes(self):
        code = self.newCode()["code"]
        expiredTime = pairingCodes.time.monotonic() + 121

        with patch.object(pairingCodes.time, "monotonic", return_value=expiredTime):
            self.assertEqual(self.pair(code).status_code, 401)

        self.assertEqual(self.pair(code).status_code, 401)

    def test_pairing_without_a_code_request_fails(self):
        self.assertEqual(self.pair("ABCDEFGH").status_code, 401)
        self.assertEqual(self.pair("").status_code, 422)

    def test_pairing_requires_a_trusted_same_origin_request(self):
        code = self.newCode()["code"]

        hostile = self.phone.post(
            "/api/devices/pair",
            json={"code": code, "name": "x"},
            headers={"Origin": "https://attacker.example"},
        )
        crossSite = self.phone.post(
            "/api/devices/pair",
            json={"code": code, "name": "x"},
            headers={"Sec-Fetch-Site": "cross-site"},
        )

        self.assertEqual(hostile.status_code, 403)
        self.assertEqual(crossSite.status_code, 403)
        self.assertEqual(self.pair(code).status_code, 200)

    def test_paired_phone_cannot_use_computer_only_routes(self):
        self.pairPhone()

        blocked = (
            self.phone.get("/api/devices"),
            self.phone.post("/api/devices/pairing-code"),
            self.phone.delete("/api/devices/pairing-code"),
            self.phone.put("/api/devices/access", json={"enabled": True}),
            self.phone.delete("/api/devices/anything"),
            self.phone.post("/api/providers/openrouter/key", json={"api_key": "stolen"}),
        )

        for response in blocked:
            self.assertEqual(response.status_code, 403)
            self.assertEqual(response.json()["detail"]["code"], "computer_only")

        self.assertEqual(len(self.computer.get("/api/devices").json()["devices"]), 1)

    def test_paired_phone_still_needs_a_trusted_origin_for_changes(self):
        self.pairPhone()

        response = self.phone.patch(
            "/api/settings",
            json={"smooth_streaming": True},
            headers={"Origin": "https://attacker.example"},
        )

        self.assertEqual(response.status_code, 403)
        self.assertEqual(
            self.phone.patch("/api/settings", json={"smooth_streaming": True}).status_code,
            200,
        )

    def test_removing_a_device_locks_it_out_right_away(self):
        self.pairPhone()
        deviceId = self.computer.get("/api/devices").json()["devices"][0]["id"]

        removed = self.computer.delete(f"/api/devices/{deviceId}")

        self.assertEqual(removed.status_code, 200)
        self.assertEqual(removed.json()["devices"], [])
        self.assertEqual(self.phone.get("/api/chats").status_code, 401)
        self.assertEqual(self.computer.delete(f"/api/devices/{deviceId}").status_code, 404)

    def test_turning_phone_access_off_locks_out_every_phone(self):
        self.pairPhone()
        code = self.newCode()["code"]

        response = self.computer.put("/api/devices/access", json={"enabled": False})

        self.assertFalse(response.json()["enabled"])
        self.assertTrue(response.json()["restartNeeded"])
        self.assertEqual(self.phone.get("/api/chats").status_code, 401)
        self.assertEqual(self.pair(code).status_code, 403)
        self.assertEqual(self.computer.post("/api/devices/pairing-code").status_code, 409)

    def test_phone_is_signed_out_after_thirty_days_without_use(self):
        self.pairPhone()
        now = datetime.now(timezone.utc)

        self.setLastSeen(now - timedelta(days=29))
        self.assertEqual(self.phone.get("/api/chats").status_code, 200)

        self.setLastSeen(now - timedelta(days=31))
        self.assertEqual(self.phone.get("/api/chats").status_code, 401)
        self.assertEqual(self.computer.get("/api/devices").json()["devices"], [])

    def test_using_the_phone_resets_the_thirty_day_clock(self):
        self.pairPhone()
        staleTime = datetime.now(timezone.utc) - timedelta(days=20)
        self.setLastSeen(staleTime)

        self.assertEqual(self.phone.get("/api/chats").status_code, 200)

        lastSeen = self.computer.get("/api/devices").json()["devices"][0]["lastSeenAt"]
        self.assertGreater(datetime.fromisoformat(lastSeen), staleTime + timedelta(days=19))

    def test_device_cookie_does_not_work_as_the_computer_session(self):
        self.pairPhone()
        token = self.phone.cookies.get("routerchat_device")

        impostor = self.makeClient(self.baseUrl)
        try:
            impostor.cookies.set("routerchat_session", token)
            self.assertEqual(impostor.get("/api/devices").status_code, 401)
        finally:
            impostor.close()

    def test_launcher_only_listens_for_phones_when_the_setting_is_on(self):
        with patch("backend.devices.phoneAccess.detectLanAddress", return_value="192.168.1.20"):
            self.assertEqual(phoneListenAddress(), "192.168.1.20")
            setPhoneAccess(False)
            self.assertIsNone(phoneListenAddress())

    def test_launcher_serves_both_addresses_and_sets_the_phone_origin(self):
        secretPath = Path(self.tempDir.name) / "run" / "api-secret"
        observed = {}

        class FakeSocket:
            def __init__(self, host):
                self.host = host
                self.closed = False

            def close(self):
                self.closed = True

        opened = []

        def openSocket(host, port):
            opened.append(FakeSocket(host))
            return opened[-1]

        def serve(listenSockets, port):
            observed["hosts"] = [listenSocket.host for listenSocket in listenSockets]
            observed["port"] = port
            observed["phoneOrigin"] = os.environ.get("ROUTERCHAT_PHONE_ORIGIN")
            observed["phoneNameOrigin"] = os.environ.get("ROUTERCHAT_PHONE_NAME_ORIGIN")

        with patch("backend.devices.phoneServer.openListenSocket", openSocket), patch(
            "backend.devices.phoneServer.serveOnSockets", serve
        ), patch("backend.devices.localName.announceLocalName", return_value=None):
            serveLocalApp(secretPath, self.baseUrl, [self.baseUrl], "192.168.1.20")

        self.assertEqual(observed["hosts"], ["127.0.0.1", "192.168.1.20"])
        self.assertEqual(observed["port"], 8000)
        self.assertEqual(observed["phoneOrigin"], "http://192.168.1.20:8000")
        self.assertIsNone(observed["phoneNameOrigin"])
        self.assertTrue(all(listenSocket.closed for listenSocket in opened))
        self.assertFalse(secretPath.exists())

    def test_launcher_announces_the_fixed_name_and_stops_when_it_exits(self):
        secretPath = Path(self.tempDir.name) / "run" / "api-secret"
        observed = {}

        class FakeSocket:
            def close(self):
                pass

        class FakeAnnouncer:
            def unregister_all_services(self):
                observed["unregistered"] = True

            def close(self):
                observed["closed"] = True

        def announce(address, port):
            observed["announced"] = (address, port)
            return FakeAnnouncer()

        def serve(listenSockets, port):
            observed["phoneNameOrigin"] = os.environ.get("ROUTERCHAT_PHONE_NAME_ORIGIN")

        with patch(
            "backend.devices.phoneServer.openListenSocket", lambda host, port: FakeSocket()
        ), patch("backend.devices.phoneServer.serveOnSockets", serve), patch(
            "backend.devices.localName.announceLocalName", announce
        ):
            serveLocalApp(secretPath, self.baseUrl, [self.baseUrl], "192.168.1.20")

        self.assertEqual(observed["announced"], ("192.168.1.20", 8000))
        self.assertEqual(observed["phoneNameOrigin"], "http://routerchat.local:8000")
        self.assertTrue(observed["unregistered"])
        self.assertTrue(observed["closed"])

    def test_fixed_name_becomes_the_phone_address_and_keeps_the_number_as_backup(self):
        nameUrl = "http://routerchat.local:8000"
        os.environ["ROUTERCHAT_PHONE_NAME_ORIGIN"] = nameUrl
        main.resetLocalAccessConfig()

        status = self.computer.get("/api/devices").json()
        self.assertEqual(status["address"], nameUrl)
        self.assertEqual(status["backupAddress"], self.phoneUrl)

        pairing = self.newCode()
        self.assertEqual(pairing["link"], f"{nameUrl}/#pair={pairing['code']}")

        namedPhone = self.makeClient(nameUrl)
        try:
            self.assertEqual(self.pair(pairing["code"], client=namedPhone).status_code, 200)
            self.assertEqual(namedPhone.get("/api/chats").status_code, 200)
        finally:
            namedPhone.close()

        self.assertEqual(self.phone.get("/api/health").status_code, 200)

    def test_only_the_exact_fixed_name_is_allowed(self):
        self.assertIsNone(self.computer.get("/api/devices").json()["backupAddress"])
        self.assertEqual(
            self.phone.get("/api/health", headers={"Host": "routerchat.local:8000"}).status_code,
            400,
        )

        for origin in (
            "http://routerchat.local:9000",
            "http://routerchat.local",
            "http://evil.local:8000",
            "https://routerchat.local:8000",
            "http://routerchat.local:8000/path",
        ):
            with self.subTest(origin=origin):
                with self.assertRaises(RuntimeError):
                    loadLocalAccessConfig({**os.environ, "ROUTERCHAT_PHONE_NAME_ORIGIN": origin})

        nameOnly = {**os.environ, "ROUTERCHAT_PHONE_NAME_ORIGIN": "http://routerchat.local:8000"}
        del nameOnly["ROUTERCHAT_PHONE_ORIGIN"]
        config = loadLocalAccessConfig(nameOnly)
        self.assertIsNone(config.phoneNameOrigin)
        self.assertNotIn("routerchat.local:8000", config.allowedHosts)

    def test_launcher_falls_back_to_local_only_when_the_phone_address_is_unavailable(self):
        secretPath = Path(self.tempDir.name) / "run" / "api-secret"
        observed = {}

        class FakeSocket:
            def close(self):
                observed["localClosed"] = True

        def openSocket(host, port):
            return FakeSocket() if host == "127.0.0.1" else None

        def runServer(appPath, host, port):
            observed["host"] = host
            observed["phoneOrigin"] = os.environ.get("ROUTERCHAT_PHONE_ORIGIN")

        with patch("backend.devices.phoneServer.openListenSocket", openSocket), patch(
            "uvicorn.run", runServer
        ):
            serveLocalApp(secretPath, self.baseUrl, [self.baseUrl], "192.168.1.20")

        self.assertEqual(observed["host"], "127.0.0.1")
        self.assertIsNone(observed["phoneOrigin"])
        self.assertTrue(observed["localClosed"])


if __name__ == "__main__":
    unittest.main()
