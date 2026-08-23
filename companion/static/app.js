const state = {
  data: null,
  busy: false,
  timer: null,
  toastTimer: null,
};

const elements = {
  serviceState: document.querySelector("#serviceState"),
  adapterName: document.querySelector("#adapterName"),
  adapterMeta: document.querySelector("#adapterMeta"),
  scanButton: document.querySelector("#scanButton"),
  scanButtonText: document.querySelector("#scanButtonText"),
  scanProgress: document.querySelector("#scanProgress"),
  refreshButton: document.querySelector("#refreshButton"),
  deviceSummary: document.querySelector("#deviceSummary"),
  audioOnly: document.querySelector("#audioOnly"),
  emptyState: document.querySelector("#emptyState"),
  deviceList: document.querySelector("#deviceList"),
  toast: document.querySelector("#toast"),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    cache: "no-store",
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Bluez-Panel": "1",
      ...(options.headers || {}),
    },
  });
  let body = {};
  try { body = await response.json(); } catch (_) { /* no response body */ }
  if (!response.ok) throw new Error(body.error || `请求失败（HTTP ${response.status}）`);
  return body;
}

function toast(message, error = false) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast show${error ? " error" : ""}`;
  state.toastTimer = setTimeout(() => { elements.toast.className = "toast"; }, 4200);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(label, className, handler, disabled = false) {
  const node = el("button", `button small ${className || "ghost"}`, label);
  node.type = "button";
  node.disabled = disabled || state.busy;
  node.addEventListener("click", handler);
  return node;
}

function signalText(rssi) {
  if (typeof rssi !== "number") return "信号未知";
  if (rssi >= -55) return `信号强 ${rssi} dBm`;
  if (rssi >= -70) return `信号中等 ${rssi} dBm`;
  return `信号较弱 ${rssi} dBm`;
}

function renderDevice(device) {
  const card = el("article", `device-card panel${device.connected ? " connected" : ""}`);
  const head = el("div", "device-head");
  const title = el("div", "device-title");
  title.append(el("div", "device-icon", device.audio ? "♫" : "⌁"));
  const names = el("div");
  names.append(el("h3", "", device.name));
  names.append(el("p", "muted", device.address));
  title.append(names);
  const status = device.connected ? ["已连接", "connected"] : device.paired ? ["已配对", "paired"] : ["未配对", ""];
  head.append(title, el("span", `state-pill ${status[1]}`, status[0]));
  card.append(head);

  const meta = el("div", "device-meta");
  if (device.audio) meta.append(el("span", "meta-tag", "音频设备"));
  if (device.trusted) meta.append(el("span", "meta-tag", "已信任"));
  if (device.services_resolved) meta.append(el("span", "meta-tag", "服务已解析"));
  meta.append(el("span", "meta-tag signal", signalText(device.rssi)));
  card.append(meta);

  const actions = el("div", "device-actions");
  if (!device.paired) {
    actions.append(button("配对并信任", "primary", () => deviceAction(device, "pair")));
  } else {
    if (!device.trusted) actions.append(button("设为信任", "ghost", () => deviceAction(device, "trust")));
    if (device.connected) {
      actions.append(button("断开", "ghost", () => deviceAction(device, "disconnect")));
    } else {
      actions.append(button("连接", "primary", () => deviceAction(device, "connect")));
    }
    actions.append(el("span", "spacer"));
    actions.append(button("移除", "danger", () => deviceAction(device, "remove")));
  }
  card.append(actions);
  return card;
}

function render() {
  const data = state.data;
  if (!data) return;
  const adapter = data.adapter;
  elements.adapterName.textContent = `${adapter.name} · ${adapter.id}`;
  elements.adapterMeta.textContent = `${adapter.address || "无地址"} · ${adapter.powered ? "控制器已开启" : "控制器未开启"}`;
  elements.serviceState.className = `service-state ${adapter.powered ? "ready" : "error"}`;
  elements.serviceState.innerHTML = "<span></span>";
  elements.serviceState.append(document.createTextNode(adapter.powered ? "BlueZ 已就绪" : "控制器未开启"));
  elements.scanButton.disabled = state.busy || !adapter.powered;
  elements.scanButton.classList.toggle("scanning", adapter.discovering);
  elements.scanButtonText.textContent = adapter.discovering ? "停止扫描" : "开始扫描";
  elements.scanProgress.hidden = !adapter.discovering;
  elements.scanProgress.firstElementChild.style.animationDuration = `${data.scan_seconds || 20}s`;

  const all = data.devices || [];
  const audioCount = all.filter((item) => item.audio).length;
  const connectedCount = all.filter((item) => item.connected).length;
  elements.deviceSummary.textContent = `发现 ${all.length} 台 · 音频 ${audioCount} 台 · 已连接 ${connectedCount} 台`;
  let shown = elements.audioOnly.checked ? all.filter((item) => item.audio || item.paired) : all;
  elements.deviceList.replaceChildren(...shown.map(renderDevice));
  elements.emptyState.hidden = shown.length > 0;
  if (shown.length === 0 && all.length > 0) {
    elements.emptyState.querySelector("h3").textContent = "没有识别到音频设备";
    elements.emptyState.querySelector("p").textContent = "可关闭“优先显示音频设备”查看全部扫描结果；部分音箱要配对后才会上报音频服务。";
  } else {
    elements.emptyState.querySelector("h3").textContent = "还没有发现设备";
    elements.emptyState.querySelector("p").textContent = "让音箱进入配对模式，然后点击“开始扫描”。扫描期间请让手机和电脑暂时断开该音箱。";
  }
}

async function refresh(silent = false) {
  try {
    const nextData = await api("/api/status");
    const changed = JSON.stringify(nextData) !== JSON.stringify(state.data);
    state.data = nextData;
    if (changed || !silent) render();
  } catch (error) {
    elements.serviceState.className = "service-state error";
    elements.serviceState.innerHTML = "<span></span>";
    elements.serviceState.append(document.createTextNode("BlueZ 不可用"));
    elements.adapterName.textContent = "无法连接宿主机 BlueZ";
    elements.adapterMeta.textContent = error.message;
    elements.scanButton.disabled = true;
    if (!silent) toast(error.message, true);
  } finally {
    scheduleRefresh();
  }
}

function scheduleRefresh() {
  clearTimeout(state.timer);
  const delay = state.data?.adapter?.discovering ? 1800 : 5000;
  state.timer = setTimeout(() => refresh(true), delay);
}

async function scanToggle() {
  if (!state.data) return;
  state.busy = true;
  render();
  try {
    const stopping = state.data.adapter.discovering;
    const result = await api(stopping ? "/api/scan/stop" : "/api/scan/start", { method: "POST", body: "{}" });
    toast(result.message);
    await refresh(true);
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.busy = false;
    render();
  }
}

async function deviceAction(device, action) {
  if (action === "remove" && !window.confirm(`确定移除“${device.name}”的配对记录吗？`)) return;
  state.busy = true;
  render();
  const actionNames = { pair: "正在配对", trust: "正在设为信任", connect: "正在连接", disconnect: "正在断开", remove: "正在移除" };
  toast(`${actionNames[action]} ${device.name}…`);
  try {
    const result = await api(`/api/devices/${encodeURIComponent(device.address)}/action`, {
      method: "POST",
      body: JSON.stringify({ action }),
    });
    toast(result.message);
    await refresh(true);
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.busy = false;
    render();
  }
}

elements.scanButton.addEventListener("click", scanToggle);
elements.refreshButton.addEventListener("click", () => refresh());
elements.audioOnly.addEventListener("change", render);
refresh();
