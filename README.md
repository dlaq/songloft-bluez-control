# Songloft BlueZ Control

一个既能作为独立网页使用、也能作为 Songloft 插件使用的 BlueZ 蓝牙音箱管理项目。

- **独立网页模式**：浏览器直接完成扫描、配对并信任、连接、断开和移除。
- **Songloft 插件模式**：在 Songloft 插件页面完成相同操作，companion 仅绑定本机回环地址。

项目由两部分组成：

- `companion/`：Docker 镜像中的网页面板、API 与 BlueZ system D-Bus 适配层。
- `plugin/`：Songloft `.jsplugin.zip` 插件，提供 Songloft 内嵌界面与受限代理。

两种模式使用同一套 companion，不会启动第二个 `bluetoothd`，不会接管 PulseAudio，也不会修改 MPD 或 Songloft 的音频输出设置。

## 模式一：独立网页

适合不使用 Songloft、或希望直接从浏览器管理蓝牙音箱的场景。

1. 在 1Panel「容器 → 编排」中使用 [`companion/compose.yaml`](companion/compose.yaml)。
2. 把 [`companion/.env.web.example`](companion/.env.web.example) 复制为 `.env`。
3. 必须替换 `PANEL_PASSWORD`，然后创建或重建编排。
4. 浏览器打开 `http://iStoreOS地址:8088`，输入 `.env` 中的用户名和密码。

网页模式使用：

```dotenv
WEB_BIND=0.0.0.0
WEB_PORT=8088
```

只应在可信 LAN 中使用，绝不要把 8088 暴露到 WAN。非可信局域网应通过 1Panel 配置 HTTPS 反向代理。

## 模式二：Songloft 插件

1. 在 1Panel 中使用同一个 [`companion/compose.yaml`](companion/compose.yaml)。
2. 把 [`companion/.env.plugin.example`](companion/.env.plugin.example) 复制为 `.env`。
3. 从 [GitHub Releases](https://github.com/dlaq/songloft-bluez-control/releases) 下载 `bluez-control.jsplugin.zip`。
4. 在 Songloft「插件管理」中上传并启用。
5. 首次打开插件时填写 `.env` 中的 companion 用户名和密码。

插件模式使用：

```dotenv
WEB_BIND=127.0.0.1
WEB_PORT=8088
```

这样 8088 不对局域网开放，只有同机、host 网络模式下的 Songloft 可以访问。插件保存设置前会实际请求 `/api/status` 验证凭据；密码只保存在 Songloft 插件存储中，不会由配置接口返回。

## Docker 镜像

1Panel 编排直接从 Docker Hub 拉取，不在生产环境中现场构建：

```text
docker.io/dlaq/songloft-bluez-control:latest
```

需要固定版本时，在 `.env` 中设置：

```dotenv
BLUEZ_IMAGE=dlaq/songloft-bluez-control:1.1.0
```

正式标签包括：

```text
dlaq/songloft-bluez-control:v1.1.0
dlaq/songloft-bluez-control:1.1.0
dlaq/songloft-bluez-control:latest
```

## 使用流程

无论使用独立网页还是 Songloft 插件，操作流程都相同：

1. 让音箱进入蓝牙配对模式。
2. 点击「开始扫描」。
3. 找到音箱后点击「配对并信任」。
4. 配对完成后点击「连接」。
5. 如需声音输出，在 PulseAudio/Songloft 中选择对应蓝牙 sink。

## 架构

独立网页模式：

```text
浏览器
  -> http://iStoreOS:8088
  -> companion 网页与 API
  -> /run/dbus/system_bus_socket
  -> 宿主机 BlueZ
```

Songloft 插件模式：

```text
Songloft 插件页面
  -> Songloft QuickJS 插件代理
  -> http://127.0.0.1:8088
  -> companion API
  -> /run/dbus/system_bus_socket
  -> 宿主机 BlueZ
```

## 安全边界

- 网页和 API 除 `/healthz` 外均要求 HTTP Basic Auth。
- 所有修改请求还必须带 `X-Bluez-Panel` 请求头。
- 插件仅申请 `storage` 和 `net` 权限。
- companion 地址在插件代码中固定为 `127.0.0.1:8088`，不接受任意 URL。
- 插件不申请 `command`、`fs`、歌曲或歌单权限。
- companion 不使用 `privileged`，不挂载 `/dev` 或 `/var/lib/bluetooth`。
- companion 根文件系统只读、删除全部 capabilities，并启用 `no-new-privileges`。
- 配对 Agent 只在用户主动配对指定 MAC 后短时授权该设备。

## 开发与验证

插件：

```text
cd plugin
npm ci
npx tsc --noEmit
npm run build
npm run validate
```

companion：

```text
python -m pip install -r companion/requirements.txt
python -m unittest discover -s companion/tests -v
docker build --tag songloft-bluez-control:test companion
```

推送 `v*` 标签会同时执行：

- 构建并校验 Songloft 插件，创建 GitHub Release。
- 使用本项目 Actions Secret `DLAQ` 登录 Docker Hub。
- 构建并推送 `v版本`、纯版本和 `latest` 三个 Docker 标签。
- 从远端重新检查已发布镜像 manifest。
