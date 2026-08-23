(() => {
  'use strict';

  const elements = {
    serviceState: document.querySelector('#serviceState'),
    adapterTitle: document.querySelector('#adapterTitle'),
    adapterMeta: document.querySelector('#adapterMeta'),
    scanButton: document.querySelector('#scanButton'),
    refreshButton: document.querySelector('#refreshButton'),
    settingsButton: document.querySelector('#settingsButton'),
    audioOnly: document.querySelector('#audioOnly'),
    deviceSummary: document.querySelector('#deviceSummary'),
    deviceList: document.querySelector('#deviceList'),
    settingsDialog: document.querySelector('#settingsDialog'),
    settingsForm: document.querySelector('#settingsForm'),
    closeSettings: document.querySelector('#closeSettings'),
    cancelSettings: document.querySelector('#cancelSettings'),
    saveSettings: document.querySelector('#saveSettings'),
    companionUsername: document.querySelector('#companionUsername'),
    companionPassword: document.querySelector('#companionPassword'),
    settingsError: document.querySelector('#settingsError'),
    toast: document.querySelector('#toast'),
  };

  const state = {
    configured: false,
    scanning: false,
    busy: false,
    devices: [],
    pollTimer: null,
  };

  function endpoint(path) {
    return `api/${String(path).replace(/^\/+/, '')}`;
  }

  async function request(path, options = {}) {
    const response = await fetch(endpoint(path), {
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = { error: text || `HTTP ${response.status}` }; }
    if (!response.ok) {
      const error = new Error(data.error || `请求失败（HTTP ${response.status}）`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  }

  function toast(message, type = 'info') {
    elements.toast.textContent = message;
    elements.toast.dataset.type = type;
    elements.toast.classList.add('show');
    window.clearTimeout(toast.timer);
    toast.timer = window.setTimeout(() => elements.toast.classList.remove('show'), 3200);
  }

  function setServiceState(kind, text) {
    elements.serviceState.dataset.state = kind;
    elements.serviceState.lastChild.textContent = text;
  }

  function button(label, kind, handler) {
    const node = document.createElement('button');
    node.type = 'button';
    node.className = `btn ${kind}`;
    node.textContent = label;
    node.addEventListener('click', handler);
    return node;
  }

  function badge(label, kind = '') {
    const node = document.createElement('span');
    node.className = `badge ${kind}`;
    node.textContent = label;
    return node;
  }

  function renderEmpty(filtered) {
    const message = state.devices.length && !filtered.length
      ? '关闭“优先显示音频设备”即可查看全部扫描结果；部分音箱需要配对后才上报音频服务。'
      : '让音箱进入配对模式，然后点击“开始扫描”。扫描期间请让手机和电脑暂时断开该音箱。';
    elements.deviceList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">⌁</div>
        <h3>${state.scanning ? '正在扫描附近设备' : '还没有发现设备'}</h3>
        <p>${message}</p>
      </div>`;
  }

  function renderDevices() {
    const all = state.devices || [];
    const audioCount = all.filter((device) => device.audio).length;
    const connectedCount = all.filter((device) => device.connected).length;
    elements.deviceSummary.textContent = `发现 ${all.length} 台 · 音频 ${audioCount} 台 · 已连接 ${connectedCount} 台`;

    const filtered = elements.audioOnly.checked ? all.filter((device) => device.audio || device.paired || device.connected) : all;
    if (!filtered.length) return renderEmpty(filtered);

    elements.deviceList.replaceChildren();
    filtered.forEach((device) => {
      const card = document.createElement('article');
      card.className = 'device-card';

      const signal = typeof device.rssi === 'number' ? `${device.rssi} dBm` : '信号未知';
      const info = document.createElement('div');
      info.className = 'device-info';
      const title = document.createElement('h3');
      title.textContent = device.name || device.address;
      const meta = document.createElement('p');
      meta.textContent = `${device.address} · ${signal}`;
      const badges = document.createElement('div');
      badges.className = 'badges';
      badges.append(badge(device.audio ? '音频设备' : '蓝牙设备', device.audio ? 'audio' : ''));
      if (device.connected) badges.append(badge('已连接', 'connected'));
      else if (device.paired) badges.append(badge('已配对', 'paired'));
      else badges.append(badge('未配对'));
      if (device.trusted) badges.append(badge('已信任', 'trusted'));
      info.append(title, meta, badges);

      const actions = document.createElement('div');
      actions.className = 'device-actions';
      if (!device.paired) {
        actions.append(button('配对并信任', 'btn-primary', () => deviceAction(device, 'pair')));
      } else {
        if (!device.trusted) actions.append(button('设为信任', 'btn-quiet', () => deviceAction(device, 'trust')));
        actions.append(device.connected
          ? button('断开', 'btn-quiet', () => deviceAction(device, 'disconnect'))
          : button('连接', 'btn-primary', () => deviceAction(device, 'connect')));
        actions.append(button('移除', 'btn-danger', () => deviceAction(device, 'remove')));
      }
      card.append(info, actions);
      elements.deviceList.append(card);
    });
  }

  function renderAdapter(adapter) {
    elements.adapterTitle.textContent = `${adapter.name || 'BlueZ'} · ${adapter.id}`;
    elements.adapterMeta.textContent = `${adapter.address || '地址未知'} · ${adapter.powered ? '控制器已开启' : '控制器未开启'} · ${adapter.pairable ? '可配对' : '不可配对'}`;
    state.scanning = Boolean(adapter.discovering);
    elements.scanButton.textContent = state.scanning ? '停止扫描' : '开始扫描';
    elements.scanButton.disabled = state.busy || !adapter.powered;
    setServiceState('ready', state.scanning ? 'BlueZ 扫描中' : 'BlueZ 已就绪');
  }

  async function loadConfig(openWhenMissing = false) {
    const config = await request('config');
    state.configured = Boolean(config.configured);
    elements.companionUsername.value = config.username || 'bluezadmin';
    elements.companionPassword.value = '';
    if (!state.configured && openWhenMissing) openSettings();
    return config;
  }

  async function refresh({ quiet = false } = {}) {
    if (!state.configured) return;
    try {
      const data = await request('status');
      state.devices = Array.isArray(data.devices) ? data.devices : [];
      renderAdapter(data.adapter || {});
      renderDevices();
    } catch (error) {
      if (error.status === 409 && error.data && error.data.needsConfig) {
        state.configured = false;
        openSettings();
      }
      setServiceState('error', 'BlueZ 不可用');
      elements.adapterTitle.textContent = '无法连接宿主机 BlueZ';
      elements.adapterMeta.textContent = error.message;
      elements.scanButton.disabled = true;
      if (!quiet) toast(error.message, 'error');
    } finally {
      schedulePoll();
    }
  }

  function schedulePoll() {
    window.clearTimeout(state.pollTimer);
    if (!state.configured) return;
    state.pollTimer = window.setTimeout(() => refresh({ quiet: true }), state.scanning ? 2500 : 7000);
  }

  async function toggleScan() {
    if (state.busy) return;
    state.busy = true;
    elements.scanButton.disabled = true;
    try {
      const data = await request(state.scanning ? 'scan/stop' : 'scan/start', { method: 'POST' });
      toast(data.message || (state.scanning ? '扫描已停止' : '扫描已开始'), 'success');
      await refresh({ quiet: true });
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      state.busy = false;
      elements.scanButton.disabled = false;
    }
  }

  async function deviceAction(device, action) {
    if (action === 'remove' && !window.confirm(`确定移除“${device.name}”的配对记录吗？`)) return;
    const names = { pair: '正在配对', trust: '正在设为信任', connect: '正在连接', disconnect: '正在断开', remove: '正在移除' };
    toast(`${names[action] || '正在操作'}：${device.name}`);
    try {
      const data = await request(`devices/${encodeURIComponent(device.address)}/action`, {
        method: 'POST',
        body: JSON.stringify({ action }),
      });
      toast(data.message || '操作成功', 'success');
      await refresh({ quiet: true });
    } catch (error) {
      toast(error.message, 'error');
    }
  }

  function openSettings() {
    elements.settingsError.textContent = '';
    if (!elements.settingsDialog.open) elements.settingsDialog.showModal();
  }

  function closeSettings() {
    if (elements.settingsDialog.open) elements.settingsDialog.close();
  }

  async function saveSettings(event) {
    event.preventDefault();
    elements.settingsError.textContent = '';
    elements.saveSettings.disabled = true;
    elements.saveSettings.textContent = '正在验证…';
    try {
      await request('config', {
        method: 'PUT',
        body: JSON.stringify({
          username: elements.companionUsername.value.trim(),
          password: elements.companionPassword.value,
        }),
      });
      state.configured = true;
      elements.companionPassword.value = '';
      closeSettings();
      toast('Companion 设置已保存', 'success');
      await refresh({ quiet: true });
    } catch (error) {
      elements.settingsError.textContent = error.message;
    } finally {
      elements.saveSettings.disabled = false;
      elements.saveSettings.textContent = '验证并保存';
    }
  }

  elements.scanButton.addEventListener('click', toggleScan);
  elements.refreshButton.addEventListener('click', () => refresh());
  elements.settingsButton.addEventListener('click', openSettings);
  elements.closeSettings.addEventListener('click', closeSettings);
  elements.cancelSettings.addEventListener('click', closeSettings);
  elements.settingsForm.addEventListener('submit', saveSettings);
  elements.audioOnly.addEventListener('change', renderDevices);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) window.clearTimeout(state.pollTimer);
    else refresh({ quiet: true });
  });

  (async () => {
    try {
      await loadConfig(true);
      if (state.configured) await refresh({ quiet: true });
      else setServiceState('error', '等待配置');
    } catch (error) {
      setServiceState('error', '插件初始化失败');
      toast(error.message, 'error');
    }
  })();
})();
