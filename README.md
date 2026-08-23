# Songloft BlueZ Control

在 Songloft 内扫描、配对、信任、连接和断开宿主机 BlueZ 蓝牙音箱。

项目由两部分组成：

- `plugin/`：Songloft `.jsplugin.zip` 插件，提供网页界面与受限代理。
- `companion/`：由 1Panel 编排管理的轻量 Docker 服务，只通过宿主机 system D-Bus 调用现有 BlueZ。

它不会启动第二个 `bluetoothd`，不会接管 PulseAudio，也不会修改 MPD 或 Songloft 的音频输出设置。

## 安装

### 1. 用 1Panel 部署 companion

在 1Panel 的「容器 → 编排」中使用 [`companion/compose.yaml`](companion/compose.yaml)，并把
[`companion/.env.example`](companion/.env.example) 复制为 `.env`。必须修改 `PANEL_PASSWORD`。

Songloft 与 companion 位于同一台主机、且 Songloft 使用 host 网络时，保持：

```dotenv
WEB_BIND=127.0.0.1
WEB_PORT=8088
```

编排默认拉取：

```text
docker.io/dlaq/songloft-bluez-control:latest
```

### 2. 安装 Songloft 插件

从 [GitHub Releases](https://github.com/dlaq/songloft-bluez-control/releases) 下载
`bluez-control.jsplugin.zip`，在 Songloft「插件管理」中上传并启用。

首次打开插件时填写 companion 用户名和密码。插件保存前会实际请求 `/api/status` 验证配置；
密码只保存在 Songloft 插件存储中，不会由配置接口返回。

## 使用

1. 让音箱进入蓝牙配对模式。
2. 在插件中点击「开始扫描」。
3. 找到音箱后点击「配对并信任」。
4. 配对完成后点击「连接」。
5. 在 Songloft 中继续使用 PulseAudio 蓝牙/桌面音频输出。

## 架构与安全边界

```text
Songloft 插件页面
  -> Songloft QuickJS 插件代理
  -> http://127.0.0.1:8088
  -> companion Docker 容器
  -> /run/dbus/system_bus_socket
  -> 宿主机 BlueZ
```

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

推送 `v*` 标签会构建插件并创建 GitHub Release。Docker Hub 镜像发布使用受保护的
GitHub Actions 工作流，发布标签包括版本号和 `latest`。

