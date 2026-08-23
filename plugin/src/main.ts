/// <reference types="@songloft/plugin-sdk" />

import { createRouter, jsonResponse, type HTTPRequest, type HTTPResponse } from '@songloft/plugin-sdk';

declare const Buffer: {
  from(input: string, encoding?: string): { toString(encoding: string): string };
};

const router = createRouter();
const COMPANION_BASE = 'http://127.0.0.1:8088';
const STORAGE_USERNAME = 'companion_username';
const STORAGE_PASSWORD = 'companion_password';
const DEFAULT_USERNAME = 'bluezadmin';

interface CompanionConfig {
  username: string;
  password: string;
}

interface ConfigPayload {
  username?: unknown;
  password?: unknown;
}

function parseJSONBody(req: HTTPRequest): Record<string, unknown> {
  if (!req.body) return {};
  try {
    const value = JSON.parse(String(req.body));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('请求内容必须是 JSON 对象');
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && error.message === '请求内容必须是 JSON 对象') throw error;
    throw new Error('请求内容不是有效的 JSON');
  }
}

async function loadConfig(): Promise<CompanionConfig> {
  const [storedUsername, storedPassword] = await Promise.all([
    songloft.storage.get(STORAGE_USERNAME),
    songloft.storage.get(STORAGE_PASSWORD),
  ]);
  return {
    username: String(storedUsername || DEFAULT_USERNAME).trim(),
    password: String(storedPassword || ''),
  };
}

function authorization(config: CompanionConfig): string {
  return `Basic ${Buffer.from(`${config.username}:${config.password}`, 'utf8').toString('base64')}`;
}

function upstreamError(error: unknown): HTTPResponse {
  const message = error instanceof Error ? error.message : String(error);
  songloft.log.error(`[bluez-control] companion request failed: ${message}`);
  return jsonResponse(
    {
      error: '无法连接本机 BlueZ companion，请确认 bluez-web-panel 编排正在运行',
      detail: message,
    },
    502,
  );
}

async function companionRequest(
  path: string,
  init: RequestInit = {},
  overrideConfig?: CompanionConfig,
): Promise<HTTPResponse> {
  const config = overrideConfig || (await loadConfig());
  if (!config.password) {
    return jsonResponse({ error: '插件尚未配置 companion 凭据', needsConfig: true }, 409);
  }

  const method = String(init.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {
    Authorization: authorization(config),
    Accept: 'application/json',
  };
  if (method !== 'GET' && method !== 'HEAD') headers['X-Bluez-Panel'] = '1';
  if (init.body != null) headers['Content-Type'] = 'application/json';

  try {
    const response = await fetch(`${COMPANION_BASE}${path}`, {
      method,
      headers,
      body: init.body,
    });
    const body = await response.text();
    return {
      statusCode: response.status,
      headers: {
        'Content-Type': response.headers.get('content-type') || 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
      },
      body,
    };
  } catch (error) {
    return upstreamError(error);
  }
}

router.get('/api/config', async () => {
  const config = await loadConfig();
  return jsonResponse({
    endpoint: COMPANION_BASE,
    username: config.username,
    configured: Boolean(config.password),
  });
});

router.put('/api/config', async (req) => {
  try {
    const body = parseJSONBody(req) as ConfigPayload;
    const current = await loadConfig();
    const username = typeof body.username === 'string' ? body.username.trim() : current.username;
    const password = typeof body.password === 'string' && body.password ? body.password : current.password;
    if (!username || username.length > 64) return jsonResponse({ error: '用户名长度必须为 1-64 个字符' }, 400);
    if (!password || password.length < 8 || password.length > 256) {
      return jsonResponse({ error: '密码长度必须为 8-256 个字符' }, 400);
    }

    const candidate = { username, password };
    const probe = await companionRequest('/api/status', {}, candidate);
    if (probe.statusCode !== 200) {
      return jsonResponse({ error: 'companion 地址不可用或凭据不正确', upstreamStatus: probe.statusCode }, 400);
    }

    await Promise.all([
      songloft.storage.set(STORAGE_USERNAME, username),
      songloft.storage.set(STORAGE_PASSWORD, password),
    ]);
    songloft.log.info('[bluez-control] companion credentials updated');
    return jsonResponse({ endpoint: COMPANION_BASE, username, configured: true });
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
});

router.get('/api/health', async () => {
  try {
    const response = await fetch(`${COMPANION_BASE}/healthz`);
    const body = await response.text();
    return {
      statusCode: response.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      body,
    };
  } catch (error) {
    return upstreamError(error);
  }
});

router.get('/api/status', async () => companionRequest('/api/status'));
router.post('/api/scan/start', async () => companionRequest('/api/scan/start', { method: 'POST' }));
router.post('/api/scan/stop', async () => companionRequest('/api/scan/stop', { method: 'POST' }));

router.post('/api/devices/:address/action', async (req, params) => {
  const address = decodeURIComponent(params.address || '').toUpperCase();
  if (!/^[0-9A-F]{2}(?::[0-9A-F]{2}){5}$/.test(address)) {
    return jsonResponse({ error: '无效的蓝牙 MAC 地址' }, 400);
  }
  let body: Record<string, unknown>;
  try {
    body = parseJSONBody(req);
  } catch (error) {
    return jsonResponse({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
  const action = typeof body.action === 'string' ? body.action : '';
  if (!['pair', 'trust', 'connect', 'disconnect', 'remove'].includes(action)) {
    return jsonResponse({ error: '不支持的设备操作' }, 400);
  }
  return companionRequest(`/api/devices/${encodeURIComponent(address)}/action`, {
    method: 'POST',
    body: JSON.stringify({ action }),
  });
});

async function onInit(): Promise<void> {
  songloft.log.info('[bluez-control] plugin initialized; companion=127.0.0.1:8088');
}

async function onDeinit(): Promise<void> {
  songloft.log.info('[bluez-control] plugin stopped');
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  try {
    return await router.handle(req);
  } catch (error) {
    songloft.log.error(`[bluez-control] unhandled request error: ${String(error)}`);
    return jsonResponse({ error: '插件请求处理失败' }, 500);
  }
}

globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;
