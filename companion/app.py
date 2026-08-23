import asyncio
import base64
import hmac
import logging
import os
import re
import time
from pathlib import Path
from typing import Any

from aiohttp import web
from dbus_next import BusType, Variant
from dbus_next.aio import MessageBus
from dbus_next.errors import DBusError
from dbus_next.service import ServiceInterface, method


BLUEZ_SERVICE = "org.bluez"
ADAPTER_INTERFACE = "org.bluez.Adapter1"
DEVICE_INTERFACE = "org.bluez.Device1"
PROPERTIES_INTERFACE = "org.freedesktop.DBus.Properties"
OBJECT_MANAGER_INTERFACE = "org.freedesktop.DBus.ObjectManager"
AGENT_MANAGER_INTERFACE = "org.bluez.AgentManager1"
AGENT_PATH = "/com/songloft/BluezWebPanel/agent"
MAC_PATTERN = re.compile(r"^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$")
AUDIO_UUIDS = {
    "00001108-0000-1000-8000-00805f9b34fb",  # Headset
    "0000110a-0000-1000-8000-00805f9b34fb",  # Audio Source
    "0000110b-0000-1000-8000-00805f9b34fb",  # Audio Sink
    "0000110c-0000-1000-8000-00805f9b34fb",  # A/V Remote Target
    "0000110d-0000-1000-8000-00805f9b34fb",  # Advanced Audio
    "0000110e-0000-1000-8000-00805f9b34fb",  # A/V Remote
    "0000111e-0000-1000-8000-00805f9b34fb",  # Handsfree
}

LOG = logging.getLogger("bluez-web-panel")


def _unwrap(value: Any) -> Any:
    if isinstance(value, Variant):
        return _unwrap(value.value)
    if isinstance(value, dict):
        return {key: _unwrap(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_unwrap(item) for item in value]
    return value


def _dbus_error_message(exc: Exception) -> str:
    text = str(exc).strip()
    error_name = str(getattr(exc, "type", ""))
    mappings = {
        "org.bluez.Error.NotReady": "蓝牙适配器尚未就绪，请确认 bluetoothd 正常且控制器已开启",
        "org.bluez.Error.InProgress": "该操作正在进行中，请稍候",
        "org.bluez.Error.AlreadyConnected": "设备已经连接",
        "org.bluez.Error.NotConnected": "设备当前未连接",
        "org.bluez.Error.AlreadyExists": "设备已经配对",
        "org.bluez.Error.AuthenticationFailed": "配对认证失败，请让音箱重新进入配对模式",
        "org.bluez.Error.AuthenticationCanceled": "配对已取消",
        "org.bluez.Error.AuthenticationRejected": "设备拒绝了配对请求",
        "org.bluez.Error.AuthenticationTimeout": "配对超时，请重新进入配对模式后再试",
        "org.bluez.Error.ConnectionAttemptFailed": "无法连接设备，请确认它仍处于可连接状态",
        "org.freedesktop.DBus.Error.ServiceUnknown": "找不到宿主机 BlueZ 服务，请检查 D-Bus 挂载和 bluetoothd",
        "org.freedesktop.DBus.Error.NoReply": "BlueZ 操作超时，请检查音箱状态后重试",
    }
    for marker, friendly in mappings.items():
        if marker in text or marker == error_name:
            return friendly
    return text or exc.__class__.__name__


class PairingAgent(ServiceInterface):
    """A target-gated NoInputNoOutput agent for user-initiated speaker pairing."""

    def __init__(self) -> None:
        super().__init__("org.bluez.Agent1")
        self.allowed_path: str | None = None
        self.allowed_until = 0.0

    def allow(self, device_path: str, seconds: int = 70) -> None:
        self.allowed_path = device_path
        self.allowed_until = time.monotonic() + seconds

    def clear(self) -> None:
        self.allowed_path = None
        self.allowed_until = 0.0

    def _authorize(self, device_path: str) -> None:
        if device_path != self.allowed_path or time.monotonic() > self.allowed_until:
            raise DBusError("org.bluez.Error.Rejected", "No active user-initiated pairing request")

    @method()
    def Release(self) -> "":
        self.clear()

    @method()
    def RequestPinCode(self, device: "o") -> "s":
        self._authorize(device)
        raise DBusError("org.bluez.Error.Rejected", "PIN entry is not supported by this speaker panel")

    @method()
    def DisplayPinCode(self, device: "o", pincode: "s") -> "":
        self._authorize(device)

    @method()
    def RequestPasskey(self, device: "o") -> "u":
        self._authorize(device)
        raise DBusError("org.bluez.Error.Rejected", "Passkey entry is not supported by this speaker panel")

    @method()
    def DisplayPasskey(self, device: "o", passkey: "u", entered: "q") -> "":
        self._authorize(device)

    @method()
    def RequestConfirmation(self, device: "o", passkey: "u") -> "":
        self._authorize(device)

    @method()
    def RequestAuthorization(self, device: "o") -> "":
        self._authorize(device)

    @method()
    def AuthorizeService(self, device: "o", uuid: "s") -> "":
        self._authorize(device)

    @method()
    def Cancel(self) -> "":
        self.clear()


class BluezManager:
    def __init__(self, adapter_name: str, scan_seconds: int) -> None:
        self.adapter_name = adapter_name
        self.scan_seconds = scan_seconds
        self.bus: MessageBus | None = None
        self.agent = PairingAgent()
        self._agent_registered = False
        self._scan_owned = False
        self._scan_stop_task: asyncio.Task[None] | None = None
        self._operation_lock = asyncio.Lock()

    async def connect(self) -> None:
        if self.bus and self.bus.connected:
            return
        self.bus = await MessageBus(bus_type=BusType.SYSTEM).connect()
        self.bus.export(AGENT_PATH, self.agent)
        try:
            manager = await self._interface("/org/bluez", AGENT_MANAGER_INTERFACE)
            await manager.call_register_agent(AGENT_PATH, "NoInputNoOutput")
            self._agent_registered = True
        except DBusError as exc:
            if getattr(exc, "type", "") != "org.bluez.Error.AlreadyExists" and "AlreadyExists" not in str(exc):
                raise
            self._agent_registered = True
        LOG.info("Connected to host BlueZ through system D-Bus")

    async def close(self) -> None:
        if self._scan_stop_task:
            self._scan_stop_task.cancel()
        if self.bus and self.bus.connected:
            if self._agent_registered:
                try:
                    manager = await self._interface("/org/bluez", AGENT_MANAGER_INTERFACE)
                    await manager.call_unregister_agent(AGENT_PATH)
                except Exception:
                    pass
            self.bus.disconnect()

    async def _interface(self, path: str, interface_name: str):
        if not self.bus or not self.bus.connected:
            await self.connect()
        assert self.bus is not None
        introspection = await self.bus.introspect(BLUEZ_SERVICE, path)
        proxy = self.bus.get_proxy_object(BLUEZ_SERVICE, path, introspection)
        return proxy.get_interface(interface_name)

    async def _managed_objects(self) -> dict[str, Any]:
        manager = await self._interface("/", OBJECT_MANAGER_INTERFACE)
        return await manager.call_get_managed_objects()

    async def _adapter_path(self, objects: dict[str, Any] | None = None) -> str:
        objects = objects or await self._managed_objects()
        expected = f"/org/bluez/{self.adapter_name}"
        if ADAPTER_INTERFACE in objects.get(expected, {}):
            return expected
        adapters = sorted(path for path, interfaces in objects.items() if ADAPTER_INTERFACE in interfaces)
        if not adapters:
            raise RuntimeError("没有发现 BlueZ 蓝牙适配器")
        available = ", ".join(path.rsplit("/", 1)[-1] for path in adapters)
        raise RuntimeError(f"找不到配置的适配器 {self.adapter_name}；当前可用：{available}")

    async def status(self) -> dict[str, Any]:
        objects = await self._managed_objects()
        adapter_path = await self._adapter_path(objects)
        raw_adapter = _unwrap(objects[adapter_path][ADAPTER_INTERFACE])
        devices: list[dict[str, Any]] = []
        for path, interfaces in objects.items():
            if DEVICE_INTERFACE not in interfaces or not path.startswith(adapter_path + "/"):
                continue
            raw = _unwrap(interfaces[DEVICE_INTERFACE])
            uuids = [str(item).lower() for item in raw.get("UUIDs", [])]
            device_class = int(raw.get("Class", 0) or 0)
            is_audio = bool(AUDIO_UUIDS.intersection(uuids)) or ((device_class >> 8) & 0x1F) == 0x04
            devices.append(
                {
                    "address": raw.get("Address", ""),
                    "name": raw.get("Alias") or raw.get("Name") or raw.get("Address", "未知设备"),
                    "icon": raw.get("Icon", ""),
                    "rssi": raw.get("RSSI"),
                    "paired": bool(raw.get("Paired", False)),
                    "bonded": bool(raw.get("Bonded", False)),
                    "trusted": bool(raw.get("Trusted", False)),
                    "connected": bool(raw.get("Connected", False)),
                    "services_resolved": bool(raw.get("ServicesResolved", False)),
                    "audio": is_audio,
                }
            )
        devices.sort(
            key=lambda item: (
                not item["connected"],
                not item["paired"],
                not item["audio"],
                -(item["rssi"] if isinstance(item["rssi"], int) else -999),
                item["name"].casefold(),
            )
        )
        return {
            "adapter": {
                "name": raw_adapter.get("Alias") or raw_adapter.get("Name") or self.adapter_name,
                "id": self.adapter_name,
                "address": raw_adapter.get("Address", ""),
                "powered": bool(raw_adapter.get("Powered", False)),
                "discovering": bool(raw_adapter.get("Discovering", False)),
                "pairable": bool(raw_adapter.get("Pairable", False)),
            },
            "devices": devices,
            "scan_seconds": self.scan_seconds,
        }

    async def start_scan(self) -> dict[str, Any]:
        objects = await self._managed_objects()
        adapter_path = await self._adapter_path(objects)
        adapter_data = _unwrap(objects[adapter_path][ADAPTER_INTERFACE])
        if not adapter_data.get("Powered", False):
            raise RuntimeError("蓝牙控制器未开启，请先在宿主机执行 bluetoothctl power on")
        adapter = await self._interface(adapter_path, ADAPTER_INTERFACE)
        try:
            await adapter.call_set_discovery_filter(
                {"Transport": Variant("s", "auto"), "DuplicateData": Variant("b", False)}
            )
            await adapter.call_start_discovery()
            self._scan_owned = True
        except DBusError as exc:
            if getattr(exc, "type", "") != "org.bluez.Error.InProgress" and "org.bluez.Error.InProgress" not in str(exc):
                raise
        if self._scan_stop_task:
            self._scan_stop_task.cancel()
        self._scan_stop_task = asyncio.create_task(self._auto_stop_scan())
        return {"message": f"正在扫描，{self.scan_seconds} 秒后自动停止"}

    async def _auto_stop_scan(self) -> None:
        try:
            await asyncio.sleep(self.scan_seconds)
            await self.stop_scan()
        except asyncio.CancelledError:
            return
        except Exception as exc:
            LOG.warning("Could not stop discovery cleanly: %s", _dbus_error_message(exc))

    async def stop_scan(self) -> dict[str, Any]:
        task = self._scan_stop_task
        self._scan_stop_task = None
        if task and task is not asyncio.current_task():
            task.cancel()
        if self._scan_owned:
            objects = await self._managed_objects()
            adapter_path = await self._adapter_path(objects)
            adapter = await self._interface(adapter_path, ADAPTER_INTERFACE)
            try:
                await adapter.call_stop_discovery()
            except DBusError as exc:
                if getattr(exc, "type", "") != "org.bluez.Error.Failed" and "org.bluez.Error.Failed" not in str(exc):
                    raise
            finally:
                self._scan_owned = False
        return {"message": "扫描已停止"}

    async def _device(self, address: str) -> tuple[str, Any, Any]:
        address = address.upper()
        if not MAC_PATTERN.fullmatch(address):
            raise ValueError("无效的蓝牙 MAC 地址")
        objects = await self._managed_objects()
        adapter_path = await self._adapter_path(objects)
        for path, interfaces in objects.items():
            if DEVICE_INTERFACE not in interfaces or not path.startswith(adapter_path + "/"):
                continue
            props = _unwrap(interfaces[DEVICE_INTERFACE])
            if str(props.get("Address", "")).upper() == address:
                return path, await self._interface(path, DEVICE_INTERFACE), await self._interface(path, PROPERTIES_INTERFACE)
        raise LookupError("设备不在 BlueZ 缓存中，请先扫描并让音箱保持配对模式")

    async def action(self, address: str, action: str) -> dict[str, Any]:
        async with self._operation_lock:
            path, device, properties = await self._device(address)
            if action == "pair":
                self.agent.allow(path)
                try:
                    await asyncio.wait_for(device.call_pair(), timeout=70)
                    await properties.call_set(DEVICE_INTERFACE, "Trusted", Variant("b", True))
                finally:
                    self.agent.clear()
                return {"message": "配对成功，设备已设为信任"}
            if action == "trust":
                await properties.call_set(DEVICE_INTERFACE, "Trusted", Variant("b", True))
                return {"message": "设备已设为信任"}
            if action == "connect":
                await asyncio.wait_for(device.call_connect(), timeout=35)
                return {"message": "连接成功"}
            if action == "disconnect":
                await asyncio.wait_for(device.call_disconnect(), timeout=20)
                return {"message": "设备已断开"}
            if action == "remove":
                objects = await self._managed_objects()
                adapter_path = await self._adapter_path(objects)
                adapter = await self._interface(adapter_path, ADAPTER_INTERFACE)
                await adapter.call_remove_device(path)
                return {"message": "配对记录已移除"}
        raise ValueError("不支持的操作")


CONFIG_KEY = web.AppKey("config", dict)
BLUEZ_KEY = web.AppKey("bluez", BluezManager)


def _basic_credentials(request: web.Request) -> tuple[str, str] | None:
    header = request.headers.get("Authorization", "")
    if not header.startswith("Basic "):
        return None
    try:
        decoded = base64.b64decode(header[6:], validate=True).decode("utf-8")
        username, password = decoded.split(":", 1)
        return username, password
    except (ValueError, UnicodeDecodeError):
        return None


@web.middleware
async def security_middleware(request: web.Request, handler):
    if request.path != "/healthz":
        expected_user = request.app[CONFIG_KEY]["username"]
        expected_password = request.app[CONFIG_KEY]["password"]
        supplied = _basic_credentials(request)
        valid = supplied is not None and hmac.compare_digest(supplied[0], expected_user) and hmac.compare_digest(
            supplied[1], expected_password
        )
        if not valid:
            response = web.json_response({"error": "需要登录"}, status=401) if request.path.startswith("/api/") else web.Response(status=401, text="需要登录")
            response.headers["WWW-Authenticate"] = 'Basic realm="BlueZ Web Panel", charset="UTF-8"'
            return response
        if request.method in {"POST", "PUT", "PATCH", "DELETE"} and request.headers.get("X-Bluez-Panel") != "1":
            return web.json_response({"error": "请求来源校验失败"}, status=403)
    response = await handler(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Cache-Control"] = "no-store"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    )
    return response


async def healthz(request: web.Request) -> web.Response:
    return web.json_response({"status": "ok"})


async def api_status(request: web.Request) -> web.Response:
    manager = request.app[BLUEZ_KEY]
    try:
        return web.json_response(await manager.status())
    except Exception as exc:
        LOG.warning("Status failed: %s", _dbus_error_message(exc))
        return web.json_response({"error": _dbus_error_message(exc)}, status=503)


async def api_scan_start(request: web.Request) -> web.Response:
    try:
        return web.json_response(await request.app[BLUEZ_KEY].start_scan())
    except Exception as exc:
        LOG.warning("Start scan failed: %s", _dbus_error_message(exc))
        return web.json_response({"error": _dbus_error_message(exc)}, status=409)


async def api_scan_stop(request: web.Request) -> web.Response:
    try:
        return web.json_response(await request.app[BLUEZ_KEY].stop_scan())
    except Exception as exc:
        LOG.warning("Stop scan failed: %s", _dbus_error_message(exc))
        return web.json_response({"error": _dbus_error_message(exc)}, status=409)


async def api_device_action(request: web.Request) -> web.Response:
    try:
        body = await request.json()
        action = str(body.get("action", ""))
        if action not in {"pair", "trust", "connect", "disconnect", "remove"}:
            raise ValueError("不支持的操作")
        return web.json_response(await request.app[BLUEZ_KEY].action(request.match_info["address"], action))
    except (ValueError, LookupError) as exc:
        return web.json_response({"error": str(exc)}, status=400)
    except asyncio.TimeoutError:
        return web.json_response({"error": "操作超时，请确认音箱处于配对或可连接状态后重试"}, status=504)
    except Exception as exc:
        LOG.warning("Device action failed: %s", _dbus_error_message(exc))
        return web.json_response({"error": _dbus_error_message(exc)}, status=409)


async def on_startup(app: web.Application) -> None:
    await app[BLUEZ_KEY].connect()


async def on_cleanup(app: web.Application) -> None:
    await app[BLUEZ_KEY].close()


async def index(request: web.Request) -> web.FileResponse:
    return web.FileResponse(Path(__file__).with_name("static") / "index.html")


def create_app(bluez: BluezManager | None = None, config: dict[str, Any] | None = None) -> web.Application:
    config = config or load_config()
    app = web.Application(middlewares=[security_middleware], client_max_size=16 * 1024)
    app[CONFIG_KEY] = config
    app[BLUEZ_KEY] = bluez or BluezManager(config["adapter"], config["scan_seconds"])
    app.router.add_get("/healthz", healthz)
    app.router.add_get("/api/status", api_status)
    app.router.add_post("/api/scan/start", api_scan_start)
    app.router.add_post("/api/scan/stop", api_scan_stop)
    app.router.add_post("/api/devices/{address}/action", api_device_action)
    static_dir = Path(__file__).with_name("static")
    app.router.add_get("/", index)
    app.router.add_static("/static", static_dir, show_index=False)
    if bluez is None:
        app.on_startup.append(on_startup)
        app.on_cleanup.append(on_cleanup)
    return app


def load_config() -> dict[str, Any]:
    username = os.getenv("PANEL_USERNAME", "admin").strip()
    password = os.getenv("PANEL_PASSWORD", "")
    if not username:
        raise RuntimeError("PANEL_USERNAME 不能为空")
    if ":" in username:
        raise RuntimeError("PANEL_USERNAME 不能包含冒号")
    weak_values = {"", "changeme", "change-me", "password", "请替换为至少12位随机密码"}
    if len(password) < 12 or password.casefold() in weak_values:
        raise RuntimeError("PANEL_PASSWORD 必须设置为至少 12 位的非默认密码")
    try:
        scan_seconds = int(os.getenv("SCAN_SECONDS", "20"))
    except ValueError as exc:
        raise RuntimeError("SCAN_SECONDS 必须是整数") from exc
    if not 5 <= scan_seconds <= 120:
        raise RuntimeError("SCAN_SECONDS 必须在 5 到 120 秒之间")
    return {
        "username": username,
        "password": password,
        "adapter": os.getenv("BLUEZ_ADAPTER", "hci0").strip() or "hci0",
        "scan_seconds": scan_seconds,
        "host": os.getenv("HOST", "0.0.0.0"),
        "port": int(os.getenv("PORT", "8080")),
    }


def main() -> None:
    logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    config = load_config()
    web.run_app(create_app(config=config), host=config["host"], port=config["port"], print=None)


if __name__ == "__main__":
    main()
