import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, extname, join, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import { loadApkSigningKey } from './apk.mjs';
import { UuApi } from './uu-api.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sessions = new Map();
const sockets = new Set();
let api, apkError;
try { api = new UuApi(loadApkSigningKey(root)); }
catch (error) { apkError = error.message; }

const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
function sessionFor(req, res) {
  const id = /(?:^|;\s*)uu_session=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
  let session = sessions.get(id);
  if (!session) {
    session = { id: randomUUID(), clientId: randomUUID(), touched: Date.now(), bridges: new Set() };
    sessions.set(session.id, session);
    res?.setHeader('Set-Cookie', `uu_session=${session.id}; HttpOnly; SameSite=Strict; Path=/`);
  }
  session.touched = Date.now();
  return session;
}
async function bodyOf(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 65536) throw Object.assign(new Error('请求过大'), { status: 413 });
  }
  try { return data ? JSON.parse(data) : {}; } catch { throw Object.assign(new Error('无效的 JSON'), { status: 400 }); }
}
function sameOrigin(req) {
  return !req.headers.origin || req.headers.origin === `http://${req.headers.host}` || req.headers.origin === `https://${req.headers.host}`;
}
function closeBridges(session) {
  session.roomGeneration = (session.roomGeneration || 0) + 1;
  for (const ws of session.bridges) ws.close(1000);
  session.bridges.clear(); session.room = undefined;
}
function signalUrl(room) {
  const value = room.signaling_list?.[0] || room.signaling_server;
  const url = new URL(value?.includes('://') ? value : `wss://${value}`);
  if (url.protocol !== 'wss:' || !/(^|\.)163\.com$/i.test(url.hostname)) throw new Error('UU 返回了不受支持的信令地址');
  url.pathname = '/socket.io/'; url.search = '?EIO=4&transport=websocket';
  return url;
}

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname.startsWith('/api/')) {
      if (!sameOrigin(req)) return json(res, 403, { error: '跨站请求已拒绝' });
      const session = sessionFor(req, res);
      const path = url.pathname, method = req.method;
      if (path === '/api/status' && method === 'GET') return json(res, 200, { ready: !!api, error: apkError, authenticated: !!session.token, user: session.user, deviceId: session.deviceId });
      if (!api) throw new Error(`无法读取参考 APK：${apkError}`);
      if (path === '/api/auth/qr' && method === 'POST') {
        await api.initialize(session);
        session.qr?.controller?.abort();
        const data = await api.request(session, 'POST', '/api/v1/qrcode/gen/login');
        if (!data?.qrcode_jump_url || !data?.token) throw new Error('扫码登录响应缺少二维码信息');
        session.qr = { data, status: 1, controller: new AbortController() };
        const image = await QRCode.toDataURL(data.qrcode_jump_url, { width: 280, margin: 2, errorCorrectionLevel: 'M' });
        return json(res, 200, { image, expiresIn: 180 });
      }
      if (path === '/api/auth/poll' && method === 'POST') {
        if (!session.qr) throw new Error('请先生成登录二维码');
        const qr = session.qr;
        if (qr.polling) return json(res, 409, { error: '正在等待扫码结果' });
        qr.polling = true;
        try {
          const result = await api.request(session, 'POST', '/api/v1/qrcode/login/status', { login_status: qr.status, ...qr.data }, 65000, qr.controller.signal);
          if (session.qr !== qr) return json(res, 410, { error: '二维码已刷新，请重新扫码' });
          qr.status = result.login_status;
          if (result.login_status === 4) {
            const login = await api.request(session, 'POST', '/api/v1/login/by_qrcode', qr.data, 20000, qr.controller.signal);
            if (session.qr !== qr) return json(res, 410, { error: '登录已取消' });
            session.token = login.token; session.userId = login.user_id;
            session.user = { nickname: login.nickname, user_id: login.user_id };
            session.qr = undefined;
          }
          return json(res, 200, { status: result.login_status, authenticated: !!session.token, user: session.user });
        } finally { qr.polling = false; }
      }
      if (path === '/api/auth/token' && method === 'POST') {
        const body = await bodyOf(req);
        if (typeof body.token !== 'string' || body.token.length < 10 || body.token.length > 8192) return json(res, 400, { error: '请输入有效的登录令牌' });
        await api.initialize(session);
        const candidate = { ...session, token: body.token };
        const user = await api.request(candidate, 'GET', '/api/v1/user/info');
        session.qr?.controller?.abort(); session.qr = undefined;
        closeBridges(session);
        session.token = body.token; session.userId = user.user_id; session.user = user;
        return json(res, 200, { user });
      }
      if (path === '/api/auth/logout' && method === 'POST') {
        session.qr?.controller?.abort();
        closeBridges(session); session.token = undefined; session.user = undefined; session.userId = undefined; session.qr = undefined;
        return json(res, 200, { ok: true });
      }
      if (!session.token) return json(res, 401, { error: '请先登录网易 UU 远程账号' });
      if (path === '/api/devices' && method === 'GET') return json(res, 200, await api.request(session, 'GET', '/api/v1/device/list'));
      const apps = /^\/api\/devices\/([^/]+)\/apps$/.exec(path);
      if (apps && method === 'GET') return json(res, 200, await api.request(session, 'GET', `/api/v1/app/list/of/device/${encodeURIComponent(decodeURIComponent(apps[1]))}`));
      if (path === '/api/room' && method === 'POST') {
        const body = await bodyOf(req);
        if (typeof body.deviceId !== 'string' || !body.deviceId || body.deviceId.length > 256) return json(res, 400, { error: '设备 ID 无效' });
        closeBridges(session);
        const generation = session.roomGeneration;
        const room = await api.request(session, 'POST', `/api/v1/room/join/by_device/${encodeURIComponent(body.deviceId)}`, { force_join: body.force === true });
        if (generation !== session.roomGeneration) return json(res, 409, { error: '连接请求已取消' });
        if (typeof room?.token !== 'string' || !room.token) throw new Error('UU 房间响应缺少信令凭据');
        const upstream = signalUrl(room);
        session.room = { ...room, upstream: upstream.href };
        return json(res, 200, { timeout: room.ws_connect_timeout_ms || 15000, streamerVersion: 'V1.14.22' });
      }
      if (path === '/api/room' && method === 'DELETE') { closeBridges(session); return json(res, 200, { ok: true }); }
      return json(res, 404, { error: '接口不存在' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
    let base, relative;
    if (url.pathname === '/vendor/socket.io.esm.min.js') { base = join(root, 'node_modules/socket.io-client/dist'); relative = 'socket.io.esm.min.js'; }
    else { base = join(root, 'public'); relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname); }
    const filename = resolve(base, '.' + sep + relative.replace(/^[/\\]+/, ''));
    if (!filename.startsWith(resolve(base) + sep)) return json(res, 403, { error: 'Forbidden' });
    if (!(await stat(filename)).isFile()) return json(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': mime[extname(filename)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : await readFile(filename));
  } catch (error) {
    if (!res.headersSent) json(res, error.status || (error.code === 'ENOENT' ? 404 : 502), { error: error.message, code: typeof error.code === 'number' ? error.code : undefined });
    else res.end();
  }
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => {
  const sessionId = /(?:^|;\s*)uu_session=([\w-]+)/.exec(req.headers.cookie || '')?.[1];
  const session = sessions.get(sessionId);
  if (!req.url.startsWith('/signal/socket.io/') || !sameOrigin(req) || !session?.token || !session.room) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
  }
  wss.handleUpgrade(req, socket, head, browser => {
    // Header token is required by the native Socket.IO transport; browsers cannot set it.
    const upstream = new WebSocket(session.room.upstream, { headers: { 'X-NRD-AUTH': session.room.token, 'X-NRD-CONTROLLING': '0', streamer_version: 'V1.14.22' }, handshakeTimeout: 15000, maxPayload: 2 * 1024 * 1024 });
    session.bridges.add(browser); sockets.add(browser);
    const queue = []; let queuedBytes = 0;
    browser.on('message', (data, binary) => {
      if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
      else if (upstream.readyState === WebSocket.CONNECTING && (queuedBytes += data.length) < 65536) queue.push([data, binary]);
      else browser.close(1009, '信令队列已满');
    });
    upstream.on('open', () => { for (const [data, binary] of queue) upstream.send(data, { binary }); queue.length = 0; });
    upstream.on('message', (data, binary) => { if (browser.readyState === WebSocket.OPEN) browser.send(data, { binary }); });
    upstream.on('error', () => browser.close(1011, '无法连接 UU 信令服务器'));
    upstream.on('close', () => browser.close(1000, '信令连接结束'));
    browser.on('error', () => upstream.terminate());
    browser.on('close', () => { upstream.terminate(); session.bridges.delete(browser); sockets.delete(browser); });
  });
});

const cleanup = setInterval(() => {
  for (const [id, session] of sessions) if (Date.now() - session.touched > 12 * 60 * 60 * 1000) { session.qr?.controller?.abort(); closeBridges(session); sessions.delete(id); }
}, 60000).unref();
const port = Number(process.env.PORT || 5173), host = process.env.HOST || '127.0.0.1';
server.listen(port, host, () => console.log(`UU Remote Web: http://${host}:${port}\nReference APK: ${api ? 'ready' : apkError}`));
function stop() { clearInterval(cleanup); for (const session of sessions.values()) session.qr?.controller?.abort(); for (const ws of sockets) ws.terminate(); wss.close(); server.close(() => process.exit(0)); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
