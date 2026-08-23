from aiohttp import web

from app import create_app


class DemoBluez:
    def __init__(self):
        self.discovering = False
        self.devices = [
            {
                "address": "24:18:C6:AA:BB:01",
                "name": "客厅蓝牙音箱",
                "icon": "audio-card",
                "rssi": -48,
                "paired": True,
                "bonded": True,
                "trusted": True,
                "connected": True,
                "services_resolved": True,
                "audio": True,
            },
            {
                "address": "38:7A:CC:AA:BB:02",
                "name": "SoundBar Mini",
                "icon": "audio-speakers",
                "rssi": -65,
                "paired": False,
                "bonded": False,
                "trusted": False,
                "connected": False,
                "services_resolved": False,
                "audio": True,
            },
            {
                "address": "10:20:30:40:50:60",
                "name": "Smart Sensor",
                "icon": "input-gaming",
                "rssi": -74,
                "paired": False,
                "bonded": False,
                "trusted": False,
                "connected": False,
                "services_resolved": False,
                "audio": False,
            },
        ]

    async def status(self):
        return {
            "adapter": {
                "name": "iStoreOS Bluetooth",
                "id": "hci0",
                "address": "0C:13:09:01:0E:8B",
                "powered": True,
                "discovering": self.discovering,
                "pairable": True,
            },
            "devices": self.devices,
            "scan_seconds": 20,
        }

    async def start_scan(self):
        self.discovering = True
        return {"message": "正在扫描，20 秒后自动停止"}

    async def stop_scan(self):
        self.discovering = False
        return {"message": "扫描已停止"}

    async def action(self, address, action):
        device = next(item for item in self.devices if item["address"] == address)
        if action == "pair":
            device.update(paired=True, bonded=True, trusted=True)
            message = "配对成功，设备已设为信任"
        elif action == "trust":
            device["trusted"] = True
            message = "设备已设为信任"
        elif action == "connect":
            device["connected"] = True
            message = "连接成功"
        elif action == "disconnect":
            device["connected"] = False
            message = "设备已断开"
        elif action == "remove":
            self.devices.remove(device)
            message = "配对记录已移除"
        return {"message": message}


if __name__ == "__main__":
    app = create_app(
        bluez=DemoBluez(),
        config={"username": "admin", "password": "browser-test-password", "adapter": "hci0", "scan_seconds": 20},
    )
    web.run_app(app, host="127.0.0.1", port=8787, print=None)
