import base64
import unittest

from aiohttp.test_utils import AioHTTPTestCase

from app import create_app


class FakeBluez:
    def __init__(self):
        self.actions = []

    async def status(self):
        return {
            "adapter": {
                "name": "Test Adapter",
                "id": "hci0",
                "address": "00:11:22:33:44:55",
                "powered": True,
                "discovering": False,
                "pairable": True,
            },
            "devices": [],
            "scan_seconds": 20,
        }

    async def start_scan(self):
        return {"message": "正在扫描"}

    async def stop_scan(self):
        return {"message": "扫描已停止"}

    async def action(self, address, action):
        self.actions.append((address, action))
        return {"message": "完成"}


class PanelTests(AioHTTPTestCase):
    async def get_application(self):
        self.fake = FakeBluez()
        return create_app(
            bluez=self.fake,
            config={"username": "admin", "password": "correct-horse-battery", "adapter": "hci0", "scan_seconds": 20},
        )

    @property
    def auth(self):
        token = base64.b64encode(b"admin:correct-horse-battery").decode("ascii")
        return {"Authorization": f"Basic {token}"}

    async def test_health_is_public_and_minimal(self):
        response = await self.client.get("/healthz")
        self.assertEqual(200, response.status)
        self.assertEqual({"status": "ok"}, await response.json())

    async def test_api_requires_authentication(self):
        response = await self.client.get("/api/status")
        self.assertEqual(401, response.status)
        self.assertIn("Basic", response.headers["WWW-Authenticate"])

    async def test_status_with_authentication(self):
        response = await self.client.get("/api/status", headers=self.auth)
        self.assertEqual(200, response.status)
        body = await response.json()
        self.assertEqual("hci0", body["adapter"]["id"])

    async def test_mutation_requires_csrf_header(self):
        response = await self.client.post("/api/scan/start", headers=self.auth, json={})
        self.assertEqual(403, response.status)

    async def test_valid_device_action(self):
        headers = {**self.auth, "X-Bluez-Panel": "1"}
        response = await self.client.post(
            "/api/devices/AA:BB:CC:DD:EE:FF/action", headers=headers, json={"action": "connect"}
        )
        self.assertEqual(200, response.status)
        self.assertEqual([("AA:BB:CC:DD:EE:FF", "connect")], self.fake.actions)

    async def test_invalid_action_is_rejected(self):
        headers = {**self.auth, "X-Bluez-Panel": "1"}
        response = await self.client.post(
            "/api/devices/AA:BB:CC:DD:EE:FF/action", headers=headers, json={"action": "power-off"}
        )
        self.assertEqual(400, response.status)
        self.assertEqual([], self.fake.actions)


if __name__ == "__main__":
    unittest.main()
