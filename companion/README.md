# BlueZ Web Panel and Songloft Companion

一个面向无头 Linux / iStoreOS 的轻量蓝牙音箱管理面板。一个容器可同时提供独立网页和 Songloft 插件 companion。它只通过宿主机 system D-Bus 调用现有 BlueZ，提供：

- 扫描附近蓝牙设备（默认 20 秒后自动停止）
- 配对并信任音箱
- 连接、断开设备
- 移除已有配对记录
- 显示适配器、信号、配对、信任和连接状态

它**不会**启动第二个 `bluetoothd`，不会接管音频，不会修改 PulseAudio、MPD 或 Songloft。

## 前置检查

先在 iStoreOS 终端确认宿主机 BlueZ 正常：

```text
bluetoothctl show
```

需要看到控制器（例如 `Controller 0C:13:09:01:0E:8B`）且 `Powered: yes`。同时确认 D-Bus socket 存在：

```text
ls -l /run/dbus/system_bus_socket
```

## 用 1Panel 编排部署

### 1. 上传项目

在 1Panel 的「文件」中创建目录：

```text
/opt/1panel/docker/compose/songloft-bluez-control
```

下载本目录的 `compose.yaml`，使用双端环境模板：

- 默认双端：把 `.env.example` 复制为 `.env`，网页监听可信 LAN，同机插件访问回环地址。
- `.env.web.example` 与默认双端配置相同。
- 只有明确不需要网页入口时，才使用 `.env.plugin.example` 收紧为仅监听 `127.0.0.1`。

双端部署示例：

```dotenv
PANEL_USERNAME=bluezadmin
PANEL_PASSWORD=这里换成管理密码
WEB_BIND=0.0.0.0
WEB_PORT=8088
BLUEZ_IMAGE=dlaq/songloft-bluez-control:latest
BLUEZ_ADAPTER=hci0
SCAN_SECONDS=20
```

密码不限制长度，但不能为空或保留示例占位值，也不要把真实 `.env` 上传到代码仓库。

### 2. 在 1Panel 创建编排

进入「容器」→「编排」→「创建编排」：

1. 名称填写 `songloft-bluez-control`。
2. 创建方式选择「路径选择」。
3. 选择 `/opt/1panel/docker/compose/songloft-bluez-control/compose.yaml`。
4. 确认创建并等待正式镜像拉取完成。

之后该服务的启动、停止、重启、重建和日志都在这个 1Panel 编排中完成，不要另行使用 `docker run` 创建第二份容器。

### 3. 同时使用两个入口

保持 `WEB_BIND=0.0.0.0`，网页打开：

```text
http://iStoreOS地址:8088
```

例如：`http://192.168.25.104:8088`。浏览器会弹出登录框，使用 `.env` 中的用户名和密码。与此同时，同机 host 网络模式的 Songloft 插件通过 `http://127.0.0.1:8088` 使用同一套 API 和凭据，无需再启动第二个容器。

HTTP Basic Auth 只编码、不加密密码。若使用独立网页且局域网并非完全可信，应在 1Panel 中建立 HTTPS 反向代理。若直接使用端口，只对 LAN 区域放行 TCP 8088，绝不要暴露到 WAN。

## 使用流程

1. 让音箱进入配对模式，并避免它自动连回手机或电脑。
2. 点击「开始扫描」。
3. 找到音箱，点击「配对并信任」。
4. 配对完成后点击「连接」。
5. 若需要音频播放，再在 PulseAudio/Songloft 中选择对应蓝牙输出。

现代音箱通常使用 Just Works 配对。本面板刻意不自动猜测传统 PIN；需要输入 `0000`、`1234` 或键盘确认码的老设备，应继续用 `bluetoothctl` 完成首次配对。

## 安全和权限说明

- 容器只挂载 `/run/dbus/system_bus_socket`，没有 `privileged: true`，没有挂载 `/dev` 或 `/var/lib/bluetooth`。
- iStoreOS / OpenWrt 的 system D-Bus 策略会拒绝非 root 的 BlueZ 管理连接，因此容器进程使用 UID/GID `0:0`；同时仍删除全部 capabilities，并保留只读根文件系统和 `no-new-privileges`。
- 容器文件系统只读、删除全部 Linux capabilities，并启用 `no-new-privileges`。
- 所有网页/API（健康检查除外）都使用 HTTP Basic Auth。
- 修改操作还要求同源 JavaScript 添加专用请求头，降低跨站请求风险。
- 配对 Agent 只在网页主动配对指定 MAC 后短时授权该 BlueZ 对象；不会常驻自动接受其他设备。

注意：system D-Bus 本身是高权限控制面。即使容器没有特权模式，也应只使用可信镜像和源码，并把网页端口限制在可信 LAN。

## 故障排查

在 1Panel 的编排详情查看容器日志。常见情况：

- `PANEL_PASSWORD 不能为空或使用示例占位值`：`.env` 未创建、密码为空或仍是示例值。
- `找不到宿主机 BlueZ 服务`：确认 `/run/dbus/system_bus_socket` 存在且 compose 挂载未被删除。
- `蓝牙控制器未开启`：宿主机执行 `bluetoothctl power on`，然后刷新页面。
- 扫描不到音箱：让音箱重新进入快速闪灯的配对模式，暂时关闭手机/电脑蓝牙后再扫。
- 配对超时：先在页面停止扫描再重试；部分适配器在持续扫描时配对表现较差。
- 连接成功但没有声音：本面板的职责到 BlueZ 连接为止；再用 `pactl list short sinks` 检查 PulseAudio 是否生成蓝牙 sink，并检查 Songloft/MPD 输出。

## 本地验证

```text
python -m compileall app.py tests
python -m unittest discover -s tests -v
docker compose --env-file .env config
docker build --tag songloft-bluez-control:test .
```
