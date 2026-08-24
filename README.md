# Songloft BlueZ Control

一个由同一容器同时提供独立网页和 Songloft 插件接口的 BlueZ 蓝牙音箱管理项目。

- **独立网页端**：浏览器直接完成扫描、配对并信任、连接、断开和移除。
- **Songloft 插件端**：在 Songloft 插件页面完成相同操作，访问同一 companion 的回环地址。

项目由两部分组成：

- `companion/`：Docker 镜像中的网页面板、API 与 BlueZ system D-Bus 适配层。
- `plugin/`：Songloft `.jsplugin.zip` 插件，提供 Songloft 内嵌界面与受限代理。

两个入口默认同时启用，使用同一套 companion，不会启动第二个 `bluetoothd`，不会接管 PulseAudio，也不会修改 MPD 或 Songloft 的音频输出设置。

## 用 1Panel 一次部署两个入口

1. 在 1Panel「容器 → 编排」中使用 [`companion/compose.yaml`](companion/compose.yaml)。
2. 把 [`companion/.env.example`](companion/.env.example) 复制为 `.env`。
3. 替换 `PANEL_PASSWORD`。密码不限制长度，但不能为空，也不能保留示例占位值。
4. 创建或重建编排。
5. 浏览器打开 `http://iStoreOS地址:8088`；Songloft 插件同时访问 `http://127.0.0.1:8088`。

双端部署使用：

```dotenv
WEB_BIND=0.0.0.0
WEB_PORT=8088
```

只应在可信 LAN 中使用，绝不要把 8088 暴露到 WAN。非可信局域网应通过 1Panel 配置 HTTPS 反向代理。若以后只需要插件、不需要网页，可改用 [`companion/.env.plugin.example`](companion/.env.plugin.example)，把监听收紧到 `127.0.0.1`。

插件包从 [GitHub Releases](https://github.com/dlaq/songloft-bluez-control/releases) 下载。在 Songloft「插件管理」中上传并启用后，首次打开插件时填写 `.env` 中的 companion 用户名和密码。插件保存设置前会实际请求 `/api/status` 验证凭据；密码只保存在 Songloft 插件存储中，不会由配置接口返回。

## Docker 镜像

1Panel 编排直接从 Docker Hub 拉取，不在生产环境中现场构建：

```text
docker.io/dlaq/songloft-bluez-control:latest
```

需要固定版本时，在 `.env` 中设置：

```dotenv
BLUEZ_IMAGE=dlaq/songloft-bluez-control:1.2.0
```

正式标签包括：

```text
dlaq/songloft-bluez-control:v1.2.0
dlaq/songloft-bluez-control:1.2.0
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

双端同时运行：

```text
浏览器
  -> http://iStoreOS:8088 ──────────────┐
Songloft 插件页面
  -> Songloft QuickJS 插件代理
  -> http://127.0.0.1:8088 ─────────────┤
                                        v
                                  companion API
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
- `PANEL_PASSWORD` 不设长度规则；只要求非空且不是示例占位值。公网或非可信局域网仍建议使用高强度密码并配置 HTTPS。

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
