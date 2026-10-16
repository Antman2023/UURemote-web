export const CHANNELS = ['CONTROL_DATA_CHANNEL', 'TEXT_DATA_CHANNEL', 'STREAMER_DATA_CHANNEL', 'FILE_DATA_CHANNEL', 'BINARY_DATA_CHANNEL'];

export function ackValue(args, event) {
  // Socket.IO's native library uses (error, value); room_info also supports a single object.
  if (args.length === 1 && args[0] && typeof args[0] === 'object') {
    if (args[0].code != null && args[0].code !== 0) throw new Error(`${event}：${args[0].msg || args[0].code}`);
    return args[0];
  }
  const [error, value] = args;
  if (error && error !== 'succ' && error !== 'success' && error.code !== 0) throw new Error(`${event}：${typeof error === 'string' ? error : error.msg || error.code || '请求被拒绝'}`);
  if (value == null) throw new Error(`${event}：服务端未返回数据`);
  if (value.code != null && value.code !== 0) throw new Error(`${event}：${value.msg || value.code}`);
  return value;
}

export function normalizeIceServers(servers = []) {
  return servers.map(server => {
    const urls = server.urls || server.url;
    if (!urls || (typeof urls !== 'string' && !Array.isArray(urls))) throw new Error('ICE 服务器地址无效');
    return { urls, ...(server.username ? { username: server.username } : {}), ...(server.credential || server.password ? { credential: server.credential || server.password } : {}) };
  });
}

export function soacMessage(clientId, type, payload, iceId, appControlId) {
  // Native SOAC nests the RTCIceCandidateInit object beneath data.candidate.
  const data = type === 'candidate' ? { candidate: payload } : payload;
  return { client_id: clientId, data: { type, ...data, ice_id: iceId, app_control_id: appControlId } };
}

export function remotePoint(event, rect, videoWidth, videoHeight) {
  if (!rect.width || !rect.height || !videoWidth || !videoHeight) return null;
  const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
  const width = videoWidth * scale, height = videoHeight * scale;
  const x = event.clientX - rect.left - (rect.width - width) / 2;
  const y = event.clientY - rect.top - (rect.height - height) / 2;
  if (x < 0 || y < 0 || x > width || y > height) return null;
  // libinputmanager MouseMoveCommonEvent::ApplyDisplayInfo emits fractions, not Win32 0..65535.
  const fraction = value => Math.min(1, Math.max(0, Math.round(value * 1e8) / 1e8));
  return { x: fraction(x / width), y: fraction(y / height) };
}

const keys = { Backspace: 8, Tab: 9, Enter: 13, ShiftLeft: 16, ShiftRight: 16, ControlLeft: 17, ControlRight: 17, AltLeft: 18, AltRight: 18, Pause: 19, CapsLock: 20, Escape: 27, Space: 32, PageUp: 33, PageDown: 34, End: 35, Home: 36, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, PrintScreen: 44, Insert: 45, Delete: 46, MetaLeft: 91, MetaRight: 92, ContextMenu: 93, NumLock: 144, ScrollLock: 145, Semicolon: 186, Equal: 187, Comma: 188, Minus: 189, Period: 190, Slash: 191, Backquote: 192, BracketLeft: 219, Backslash: 220, BracketRight: 221, Quote: 222, NumpadMultiply: 106, NumpadAdd: 107, NumpadSubtract: 109, NumpadDecimal: 110, NumpadDivide: 111, NumpadEnter: 13 };
export function virtualKey(code) {
  if (/^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  if (/^Digit[0-9]$/.test(code)) return code.charCodeAt(5);
  if (/^Numpad[0-9]$/.test(code)) return 96 + Number(code.slice(-1));
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return 111 + Number(code.slice(1));
  return keys[code] || 0;
}
