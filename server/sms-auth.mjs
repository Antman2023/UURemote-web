const COOLDOWN_SECONDS = 60;
const invalid = message => Object.assign(new Error(message), { status: 400 });

// Request bodies recovered from hb.b / hb.e in the reference APK.
export function smsCredentials(body, requireCode = false) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('短信登录参数无效');
  const country_code = body.countryCode === undefined ? '86' : typeof body.countryCode === 'string' ? body.countryCode.trim().replace(/^\+/, '') : '';
  const mobile = typeof body.mobile === 'string' ? body.mobile.replace(/[\s-]/g, '') : '';
  if (!/^[1-9]\d{0,3}$/.test(country_code)) throw invalid('请输入有效的国家或地区区号');
  if (!/^\d{4,15}$/.test(mobile) || (country_code === '86' && !/^1[3-9]\d{9}$/.test(mobile))) throw invalid('请输入有效的手机号码');
  if (!requireCode) return { country_code, mobile };
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  if (!/^\d{6}$/.test(code)) throw invalid('请输入 6 位短信验证码');
  return { country_code, mobile, code };
}

export async function sendSmsCode(api, session, body, now = Date.now) {
  const credentials = smsCredentials(body);
  const retryAfter = Math.ceil(((session.smsRetryAt || 0) - now()) / 1000);
  if (session.smsSending || retryAfter > 0) {
    throw Object.assign(new Error('验证码请求过于频繁，请稍后重试'), { status: 429, retryAfter: Math.max(1, retryAfter) });
  }
  session.smsSending = true;
  try {
    await api.initialize(session);
    await api.request(session, 'POST', '/api/v1/security/mobile/code', { ...credentials, type: 'login' });
    session.smsRetryAt = now() + COOLDOWN_SECONDS * 1000;
    return { retryAfter: COOLDOWN_SECONDS };
  } finally { session.smsSending = false; }
}

export async function loginBySms(api, session, body, closeBridges) {
  const credentials = smsCredentials(body, true);
  const attempt = {};
  session.smsAttempt = attempt;
  session.qr?.controller?.abort(); session.qr = undefined;
  try {
    await api.initialize(session);
    const login = await api.request(session, 'POST', '/api/v1/login/by_mobile', credentials);
    if (session.smsAttempt !== attempt) throw Object.assign(new Error('登录请求已取消'), { status: 409 });
    if (typeof login?.token !== 'string' || !login.token || typeof login.user_id !== 'string' || !login.user_id) throw new Error('短信登录响应缺少账号信息');
    closeBridges(session);
    session.token = login.token; session.userId = login.user_id;
    session.user = { nickname: login.nickname, user_id: login.user_id };
    return { user: session.user };
  } finally { if (session.smsAttempt === attempt) session.smsAttempt = undefined; }
}
