import { createHmac } from 'node:crypto';

export const API_ORIGIN = 'https://api.nrd.nie.163.com';

export function signRequest(key, method, path, headers, body = '') {
  const canonical = Object.entries(headers)
    .map(([name, value]) => [name.toLowerCase(), String(value)])
    .filter(([name]) => name.startsWith('x-param-') && name !== 'x-param-sign')
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, value]) => `${name}=${value}`).join('&');
  return createHmac('sha256', key).update(method + path + canonical + body).digest('hex');
}

export function requestHeaders(session, key, method, path, body, now = Date.now()) {
  const headers = {
    'X-Param-CHN': 'gwqd', 'X-Param-OPR': '', 'X-Param-PKGN': 'com.netease.uuremote',
    'X-Param-PLAT': '5', 'X-Param-REL': 'prod', 'X-Param-TS': String(now),
    'X-Param-VC': '30500', 'X-Param-VN': '3.5.0', 'X-Param-ABI': 'arm64-v8a',
    'X-Param-client-id': session.clientId, 'X-Param-device-id': session.deviceId || '',
    'X-Param-user-id': session.userId || '', 'X-Param-OAID': '',
    'X-Param-CNT': 'CN', 'X-Param-LANG': 'zh-CN',
  };
  headers['X-Param-SIGN'] = signRequest(key, method, path, headers, body);
  headers['Content-Type'] = 'application/json; charset=utf-8';
  if (session.token) headers.Authorization = `Bearer ${session.token}`;
  return headers;
}

export class UuApi {
  constructor(key, fetchImpl = fetch) { this.key = key; this.fetch = fetchImpl; }
  async request(session, method, path, data, timeout = 20000, signal) {
    const body = data === undefined ? '' : JSON.stringify(data);
    const response = await this.fetch(API_ORIGIN + path, {
      method, headers: requestHeaders(session, this.key, method, path, body),
      body: method === 'GET' ? undefined : body,
      signal: signal ? AbortSignal.any([AbortSignal.timeout(timeout), signal]) : AbortSignal.timeout(timeout), redirect: 'error',
    });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { throw new Error(`UU API 返回非 JSON 响应（HTTP ${response.status}）`); }
    if (!response.ok || result.code !== 0) {
      const error = new Error(result.msg || `UU API 请求失败（HTTP ${response.status}，code ${result.code}）`);
      error.status = response.status === 401 ? 401 : 502;
      error.code = result.code;
      throw error;
    }
    return result.data;
  }
  async initialize(session) {
    if (session.deviceId) return;
    if (session.initializing) return session.initializing;
    session.initializing = this.initializeDevice(session).finally(() => { session.initializing = undefined; });
    return session.initializing;
  }
  async initializeDevice(session) {
    const data = await this.request(session, 'POST', '/api/v1/device/android_tv/init', {
      name: 'UU远程 Web 主控端', client_id: session.clientId, system_id: session.clientId,
      system_version: 'web', gaid: '', install_id: session.clientId,
      build_fingerprint: 'uuremote-web', brand: 'Web', manufacturer: 'Web', model: 'Browser',
      product: 'uuremote-web', rom: '', abi: 'arm64-v8a', resolution: '1920x1080', screen_size: '', dpi: 96,
    });
    session.deviceId = data?.device_id || data?.current_device?.device_id;
    if (!session.deviceId) throw new Error('设备初始化响应缺少 device_id');
  }
}
