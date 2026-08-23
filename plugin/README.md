# Songloft 蓝牙音箱管理插件

这是 `songloft-bluez-control` companion 的 Songloft 插件前端与安全代理层。插件安装后从 Songloft 的插件页面完成 BlueZ 设备扫描、配对、信任、连接、断开和移除。

## 架构

Songloft JS 插件运行在 QuickJS 沙箱，不能直接访问宿主机 system D-Bus。因此本插件不复制 `bluetoothd`，也不修改 Songloft 镜像，而是通过 `net` 权限访问同机 companion：

```text
Songloft 插件页面
  -> /api/v1/jsplugin/bluez-control/api/*
  -> QuickJS 插件代理（凭据只保存在插件 storage）
  -> http://127.0.0.1:8088
  -> bluez-web-panel companion
  -> /run/dbus/system_bus_socket
  -> 宿主机 BlueZ
```

目标 Songloft 必须使用 host 网络，companion 建议仅绑定 `127.0.0.1:8088`。

## 权限

- `storage`：保存 companion 用户名和密码；读取配置时永不把密码返回前端。
- `net`：只访问代码中固定的 `http://127.0.0.1:8088`，不接受任意 URL，避免成为 SSRF 代理。

插件不申请 `command`、`fs`、歌曲或歌单读写权限。

## 构建

```text
npm install
npm run build
npm run validate
```

`validate` 校验 `dist/_build` 内已由官方构建器写入哈希的生产清单，因此必须在 `build` 之后运行。

成品位于 `dist/bluez-control.jsplugin.zip`。ZIP 内必须直接包含 `plugin.json`、`main.js`/`main.jsc` 和 `static/`，不能多包一层目录。

## 安装

在 Songloft 的“插件管理”页面上传 `bluez-control.jsplugin.zip` 并启用。首次打开时输入 companion 的用户名和密码；保存前插件会实际请求 `/api/status` 验证凭据。

安装到本次 iStoreOS 后，应把 companion 的 `WEB_BIND` 改为 `127.0.0.1`，使 8088 不再直接暴露给局域网，所有操作统一从 Songloft 插件入口进入。
