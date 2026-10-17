import { hydrateIcons, icon } from './lib/icons.js';
import { UuStreamer } from './lib/streamer.js';
import { remotePoint, virtualKey } from './lib/protocol.js';
import { envelope, concat, string } from './lib/protobuf.js';

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const safeImage = value => { if (typeof value !== 'string' || !value.trim()) return ''; try { const u = new URL(value, location.origin); return ['https:', 'http:'].includes(u.protocol) ? escape(u.href) : ''; } catch { return ''; } };
let preferences;
try { preferences = JSON.parse(localStorage.getItem('uu-preferences')); } catch {}
const state = { authenticated: false, ready: false, user: null, devices: [], selected: null, apps: [], fetching: false, loginGeneration: 0, modalCleanup: null, diagnostics: [], seq: 1, pendingApp: null, audioBlocked: false, preferences: { width: 1920, height: 1080, fps: 60, quality: 3, muted: false, ...preferences } };
const streamer = new UuStreamer();
const modal = $('#modal');
let restoreFocus;

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 401) { state.authenticated = false; state.devices = []; state.selected = null; state.apps = []; render(); }
    throw Object.assign(new Error(data.error || `请求失败（${response.status}）`), { retryAfter: data.retryAfter });
  }
  return data;
}
function notify(message) {
  const toast = $('#toast'); clearTimeout(notify.timer); toast.textContent = message; toast.classList.add('visible');
  notify.timer = setTimeout(() => toast.classList.remove('visible'), 3500);
}
function openModal(title, content, { wide = false, cleanup } = {}) {
  const wasOpen = modal.open;
  state.modalCleanup?.(); state.loginGeneration++;
  state.modalCleanup = cleanup || null;
  if (!wasOpen) restoreFocus = document.activeElement;
  modal.classList.toggle('wide', wide);
  $('#modal-content').innerHTML = `<div class="modal-head"><h2>${escape(title)}</h2><button class="icon-button" data-action="close-modal" aria-label="关闭">${icon('close')}</button></div><div class="modal-body">${content}</div>`;
  hydrateIcons(modal);
  if (!wasOpen) modal.showModal();
}
function closeModal() { if (modal.open) modal.close(); }
modal.addEventListener('close', () => { state.modalCleanup?.(); state.modalCleanup = null; state.loginGeneration++; restoreFocus?.focus?.({ preventScroll: true }); });
modal.addEventListener('click', event => { const r = modal.getBoundingClientRect(); if (event.target === modal && (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom)) closeModal(); });

function appTile(app, index) {
  const name = escape(app.name || '未命名应用');
  const cover = safeImage(app.cover_url), image = safeImage(app.icon_url);
  return `<button class="app-tile" data-action="launch-app" data-index="${index}" aria-label="启动 ${name}"><span class="app-cover">${cover ? `<img class="app-cover-image" src="${cover}" alt="" loading="lazy">` : ''}${image ? `<img class="app-icon-overlay" src="${image}" alt="" loading="lazy">` : `<i data-icon="grid"></i>`}</span><span class="app-title">${name}</span></button>`;
}
function render() {
  const d = state.selected;
  const online = d && d.status !== 'offline';
  $('#account-label').textContent = state.authenticated ? (state.user?.nickname || '我的账号') : '登录账号';
  $('.account-button').setAttribute('aria-label', state.authenticated ? '我的账号' : '登录账号');
  $('#device-name').textContent = d?.alias || (state.authenticated ? '选择一台电脑' : '我的电脑');
  $('#device-status').classList.toggle('online', !!online);
  $('#device-status').innerHTML = `<span class="status-dot"></span>${d ? online ? '在线' : '离线' : '未连接'}`;
  $('#device-os').textContent = d?.platform === 4 ? 'macOS' : 'Windows';
  $('#device-detail').textContent = d ? `${d.alias || '电脑'}${d.version_name ? ` · 客户端 ${d.version_name}` : ''}` : state.authenticated ? '在电脑端登录同一账号，即可在这里看到设备' : '登录账号，连接你的远程电脑';
  $('#desktop-wallpaper').src = safeImage(d?.wallpaper_url) || '/assets/wallpaper_default.webp';
  $('#preview-status').textContent = d ? online ? '电脑已就绪' : '设备已离线' : '等待连接';
  $('#desktop-entry-label').textContent = d ? online ? '进入桌面' : '查看设备状态' : state.authenticated ? '选择设备' : '登录并连接电脑';
  $('#preview-prompt').innerHTML = d ? `<span class="monitor-circle"><i data-icon="monitor"></i></span><strong>${escape(online ? d.alias : '电脑暂时离线')}</strong><span>${online ? '点击进入远程桌面' : '请确保电脑已开机并登录 UU远程'}</span>` : `<span class="monitor-circle"><i data-icon="monitor"></i></span><strong>${state.authenticated ? '等待电脑端登录' : '电脑桌面，随时连接'}</strong><span>${state.authenticated ? '登录同一账号后刷新设备列表' : '使用同一账号，连接已登录的电脑'}</span>`;
  if (state.apps.length) $('#app-grid').innerHTML = state.apps.slice(0, 4).map(appTile).join('');
  else $('#app-grid').innerHTML = [['gamepad', '游戏应用'], ['folder', '常用软件'], ['grid', '桌面应用'], ['clock', '最近使用']].map(([type, name]) => `<button class="app-tile" data-action="all-apps"><span class="app-cover"><i data-icon="${type}"></i></span><span>${name}</span></button>`).join('');
  $('#quick-note').innerHTML = `<i data-icon="link"></i>${state.apps.length ? `已同步 ${state.apps.length} 个应用 · 点击即可远程启动` : d ? '此设备暂未同步应用，可直接进入电脑桌面' : '连接电脑后，同步已安装的应用'}`;
  $('#quality-label').textContent = `${state.preferences.height}P ${state.preferences.quality >= 4 ? '蓝光' : state.preferences.quality <= 2 ? '流畅' : '高清'}`;
  $('#fps-label').textContent = `${state.preferences.fps} FPS`;
  hydrateIcons();
}

async function refreshDevices({ silent = false } = {}) {
  if (!state.authenticated) return openLogin();
  if (state.fetching) return;
  state.fetching = true;
  const refresh = $('[data-action="refresh"]'); refresh.disabled = true; refresh.querySelector('i').style.animation = 'spin 1s linear infinite';
  try {
    const data = await request('/api/devices');
    state.devices = [...(data.my_binded_devices || []), ...(data.others_shared_devices || [])].filter(d => d?.device_id && d.device_id !== data.current_device?.device_id);
    const selectedId = state.selected?.device_id || sessionStorage.getItem('uu-device');
    state.selected = state.devices.find(d => d.device_id === selectedId) || state.devices.find(d => d.status !== 'offline') || state.devices[0] || null;
    await loadApps(); render();
    if (!silent) notify(state.devices.length ? `设备已刷新，共 ${state.devices.length} 台` : '暂未发现电脑，请在电脑端登录同一账号');
  } catch (error) { notify(error.message); }
  finally { state.fetching = false; refresh.disabled = false; refresh.querySelector('i').style.animation = ''; }
}
async function loadApps() {
  const id = state.selected?.device_id; state.apps = [];
  if (!id) return;
  try { const data = await request(`/api/devices/${encodeURIComponent(id)}/apps`); if (state.selected?.device_id === id) state.apps = Array.isArray(data) ? data : data?.apps || data?.list || []; }
  catch (error) { state.diagnostics.push({ time: new Date().toISOString(), stage: 'apps', detail: error.message }); }
}

function openLogin() {
  openModal('登录 UU远程', `<div class="login-body"><p class="login-subtitle">使用手机 UU远程 App 扫码<br>登录后即可连接账号下的电脑</p><div class="qr-container" id="qr-container"><div class="qr-placeholder"><i data-icon="qr"></i><button class="primary-button" data-action="generate-qr">生成登录二维码</button></div></div><p class="qr-description">手机与电脑，请使用同一账号</p><div class="login-status" id="login-status">在你的手机上确认登录</div><div class="login-alternate"><button class="text-button" data-action="sms-login">短信验证码登录</button><button class="text-button subtle" data-action="token-login">使用已有登录令牌</button><a class="text-button subtle" href="https://uuyc.163.com/" target="_blank" rel="noreferrer">下载官方客户端<i data-icon="external"></i></a></div></div>`);
}
function openSmsLogin() {
  const controller = new AbortController(); let timer;
  openModal('短信验证码登录', `<p class="modal-description">使用与电脑端相同的手机号登录 UU远程。</p><form id="sms-form"><div class="sms-phone-row"><label class="field"><span>区号</span><input name="countryCode" type="tel" inputmode="tel" autocomplete="tel-country-code" value="+86" pattern="[+]?[1-9][0-9]{0,3}" maxlength="5" required></label><label class="field"><span>手机号码</span><input name="mobile" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="请输入手机号码" maxlength="20" required></label></div><label class="field"><span>短信验证码</span><span class="sms-code-row"><input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="6 位验证码" pattern="[0-9]{6}" minlength="6" maxlength="6" required><button id="sms-send" type="button" class="secondary-button">获取验证码</button></span></label><p id="sms-status" class="field-hint" role="status" aria-live="polite"></p><p id="sms-error" class="error-text" role="alert"></p><div class="form-actions"><button type="button" class="secondary-button" data-action="account">返回扫码登录</button><button id="sms-submit" class="primary-button" type="submit">登录</button></div></form>`, { cleanup: () => { controller.abort(); clearInterval(timer); } });
  const generation = state.loginGeneration;
  const form = $('#sms-form'), send = $('#sms-send'), submit = $('#sms-submit');
  const status = $('#sms-status'), errorText = $('#sms-error');
  let sending = false, loggingIn = false;
  const current = () => generation === state.loginGeneration && !controller.signal.aborted;
  const credentials = () => Object.fromEntries(new FormData(form));
  const update = () => {
    const remaining = Math.max(0, Math.ceil(((state.smsRetryAt || 0) - Date.now()) / 1000));
    send.disabled = sending || loggingIn || remaining > 0;
    send.textContent = sending ? '正在发送…' : remaining ? `${remaining} 秒后重发` : '获取验证码';
    submit.disabled = sending || loggingIn;
    submit.textContent = loggingIn ? '正在登录…' : '登录';
    for (const input of form.querySelectorAll('input')) input.readOnly = loggingIn || sending;
  };
  send.addEventListener('click', async () => {
    if (send.disabled || !form.elements.countryCode.reportValidity() || !form.elements.mobile.reportValidity()) return;
    sending = true; errorText.textContent = ''; status.textContent = ''; update();
    try {
      const { countryCode, mobile } = credentials();
      const result = await request('/api/auth/sms/code', { method: 'POST', body: JSON.stringify({ countryCode, mobile }), signal: controller.signal });
      state.smsRetryAt = Date.now() + (result.retryAfter || 60) * 1000;
      if (!current()) return;
      status.textContent = '验证码已发送，请查看手机短信。';
      form.elements.code.focus();
    } catch (error) {
      if (!current()) return;
      if (error.retryAfter) state.smsRetryAt = Date.now() + error.retryAfter * 1000;
      errorText.textContent = error.message;
    } finally { sending = false; if (current()) update(); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (sending || loggingIn) return;
    loggingIn = true; errorText.textContent = ''; update();
    try {
      const result = await request('/api/auth/sms/login', { method: 'POST', body: JSON.stringify(credentials()), signal: controller.signal });
      if (!current()) return;
      form.reset(); state.authenticated = true; state.user = result.user; closeModal(); render();
      await refreshDevices({ silent: true }); notify('登录成功，设备已同步');
    } catch (error) { if (current()) errorText.textContent = error.message; }
    finally { loggingIn = false; if (current()) update(); }
  });
  timer = setInterval(update, 250); update();
}
async function generateQr() {
  const generation = ++state.loginGeneration;
  const controller = new AbortController(); state.modalCleanup = () => controller.abort();
  $('#qr-container').innerHTML = '<div class="qr-placeholder"><span class="spinner"></span><span>正在获取二维码</span></div>';
  $('#login-status').classList.remove('error-text');
  $('#login-status').textContent = '正在连接 UU 账号服务…';
  try {
    const qr = await request('/api/auth/qr', { method: 'POST', signal: controller.signal });
    if (generation !== state.loginGeneration) return;
    $('#qr-container').innerHTML = `<img src="${qr.image}" alt="UU远程官方扫码登录二维码">`;
    $('#login-status').textContent = '等待扫码 · 请在手机上确认登录';
    const expires = Date.now() + qr.expiresIn * 1000;
    while (generation === state.loginGeneration && Date.now() < expires) {
      const result = await request('/api/auth/poll', { method: 'POST', signal: controller.signal });
      if (generation !== state.loginGeneration) return;
      if (result.authenticated) {
        state.authenticated = true; state.user = result.user; closeModal(); render();
        await refreshDevices({ silent: true }); notify('登录成功，设备已同步'); return;
      }
      if (result.status === 3) throw new Error('已取消登录，请刷新二维码重试');
      $('#login-status').textContent = result.status === 2 ? '扫码成功，请在手机上确认登录' : '等待扫码 · 请在手机上确认登录';
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    if (generation === state.loginGeneration) throw new Error('二维码已过期，请重新生成');
  } catch (error) {
    if (generation !== state.loginGeneration || error.name === 'AbortError') return;
    $('#qr-container').innerHTML = '<div class="qr-placeholder"><i data-icon="qr"></i><button class="secondary-button" data-action="generate-qr">重新获取二维码</button></div>';
    $('#login-status').textContent = error.message; $('#login-status').classList.add('error-text'); hydrateIcons(modal);
  }
}
function openTokenLogin() {
  openModal('使用已有登录令牌', `<p class="modal-description">输入你自己的 UU远程账号登录令牌。令牌仅保存在本地服务的当前会话内，退出账号或重启服务后清除。</p><form id="token-form"><label class="field"><span>账号令牌</span><input name="token" type="password" autocomplete="off" placeholder="输入 Bearer Token" required minlength="10"><small class="field-hint">用于已有账号调试；支持直接粘贴带 Bearer 前缀的令牌。</small></label><p id="token-error" class="error-text"></p><div class="form-actions"><button type="button" class="secondary-button" data-action="account">返回扫码登录</button><button class="primary-button" type="submit">验证并登录</button></div></form>`);
  $('#token-form').addEventListener('submit', async event => {
    event.preventDefault(); const button = event.currentTarget.querySelector('[type=submit]'); button.disabled = true;
    try { const token = new FormData(event.currentTarget).get('token').trim().replace(/^Bearer\s+/i, ''); const result = await request('/api/auth/token', { method: 'POST', body: JSON.stringify({ token }) }); state.authenticated = true; state.user = result.user; closeModal(); render(); await refreshDevices({ silent: true }); notify('账号已登录'); }
    catch (error) { $('#token-error').textContent = error.message; button.disabled = false; }
  });
}
function openAccount() {
  if (!state.authenticated) return openLogin();
  openModal('我的账号', `<div class="profile-summary"><span class="avatar"><i data-icon="user"></i></span><div><h3>${escape(state.user?.nickname || 'UU远程用户')}</h3><p>已登录网易 UU远程</p></div></div><div class="profile-menu"><button data-action="devices"><i data-icon="monitor"></i>我的设备<i data-icon="chevron"></i></button><button data-action="settings"><i data-icon="sliders"></i>连接设置<i data-icon="chevron"></i></button><button data-action="about"><i data-icon="info"></i>关于<i data-icon="chevron"></i></button><button class="danger" data-action="logout"><i data-icon="exit"></i>退出账号<i data-icon="chevron"></i></button></div>`);
}
function openDevices() {
  if (!state.authenticated) return openLogin();
  if (!state.devices.length) return openModal('我的设备', `<div class="empty-state"><i data-icon="monitor"></i><h3>等待电脑端登录</h3><p>在电脑上安装官方 UU远程客户端，<br>使用当前账号登录后，设备会出现在这里。</p><button class="primary-button" data-action="refresh-modal">刷新设备列表</button></div><div class="guide-note">电脑端下载：<a href="https://uuyc.163.com/" target="_blank" rel="noreferrer">uuyc.163.com ↗</a></div>`);
  const group = (devices, title) => devices.length ? `<h3 class="device-section-title">${title} · ${devices.length}</h3><div class="device-list">${devices.map(d => `<button class="device-card ${d.device_id === state.selected?.device_id ? 'selected' : ''}" data-action="select-device" data-id="${escape(d.device_id)}"><img src="${safeImage(d.wallpaper_url) || '/assets/wallpaper_default.webp'}" alt="${escape(d.alias)}桌面预览"><span class="status-tag ${d.status !== 'offline' ? 'online' : ''}"><span class="status-dot"></span>${d.status !== 'offline' ? '在线' : '离线'}</span><span class="device-card-info"><strong>${escape(d.alias || '未命名电脑')}</strong><small>${d.platform === 4 ? 'macOS' : 'Windows'}${d.device_id === state.selected?.device_id ? ' · 当前设备' : ''}</small></span></button>`).join('')}</div>` : '';
  openModal('切换设备', group(state.devices.filter(d => d.status !== 'offline'), '在线设备') + group(state.devices.filter(d => d.status === 'offline'), '离线设备'), { wide: true });
}
function openSettings() {
  const p = state.preferences;
  openModal('帧率与画面', `<p class="modal-description">根据网络情况选择串流画质，画面与帧率在下次连接时生效。</p><form id="settings-form"><div class="settings-row"><div><strong>显示分辨率</strong><p>电脑画面匹配所选分辨率</p></div><select name="resolution" aria-label="显示分辨率">${[[1280,720],[1920,1080],[2560,1440],[3840,2160]].map(([w,h]) => `<option value="${w}x${h}" ${p.height === h ? 'selected' : ''}>${h}P${h === 1080 ? ' · 推荐' : ''}</option>`).join('')}</select></div><div class="settings-row"><div><strong>视频帧率</strong><p>帧率越高，操作越流畅</p></div><select name="fps" aria-label="视频帧率"><option value="30" ${p.fps === 30 ? 'selected' : ''}>30 FPS</option><option value="60" ${p.fps === 60 ? 'selected' : ''}>60 FPS · 推荐</option></select></div><div class="settings-row"><div><strong>画面质量</strong><p>高画质需要更多网络带宽</p></div><select name="quality" aria-label="画面质量">${[[1,'流畅'],[2,'均衡'],[3,'高清'],[4,'蓝光']].map(([v,l]) => `<option value="${v}" ${p.quality === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div><div class="settings-row"><div><strong>电脑声音</strong><p>接收远程电脑的音频</p></div><button type="button" class="switch" role="switch" aria-label="电脑声音" aria-checked="${!p.muted}" data-action="toggle-settings-audio"></button></div><div class="form-actions"><button type="button" class="secondary-button" data-action="close-modal">取消</button><button class="primary-button" type="submit">保存设置</button></div></form>`);
  $('#settings-form').addEventListener('submit', event => {
    event.preventDefault(); const data = new FormData(event.currentTarget); const [width, height] = data.get('resolution').split('x').map(Number);
    state.preferences = { width, height, fps: Number(data.get('fps')), quality: Number(data.get('quality')), muted: $('[data-action="toggle-settings-audio"]').getAttribute('aria-checked') !== 'true' };
    localStorage.setItem('uu-preferences', JSON.stringify(state.preferences)); applyAudio(); render(); closeModal(); notify('连接设置已保存');
  });
}
function openGuide(tab = 'connect') {
  const content = {
    connect: `<img class="guide-image" src="/assets/ic_tv_home_guide1.webp" alt="连接电脑与电视的操作引导"><div class="guide-steps"><div class="guide-step"><span>1</span>在电脑安装官方 UU远程客户端</div><div class="guide-step"><span>2</span>在两端登录同一账号</div><div class="guide-step"><span>3</span>选择在线电脑，进入桌面</div></div><div class="guide-note">电脑请保持开机、联网，UU远程客户端需在后台运行。</div>`,
    keyboard: `<div class="empty-state" style="padding-top:10px"><i data-icon="keyboard"></i><h3>像在电脑前一样操作</h3><p>点击远程画面后，使用鼠标与键盘控制电脑。<br>滚轮、左右键与常用快捷键均通过数据通道传输。<br>按 Esc 可释放输入焦点，再次按 Esc 返回。</p></div><div class="guide-note">浏览器会保留部分系统快捷键。建议进入全屏后操作；切换窗口或断开连接时会自动释放按下的按键。</div>`,
    gamepad: `<img class="guide-image" src="/assets/ic_tv_guide3.png" alt="手柄 Start 按键位置"><div class="guide-steps"><div class="guide-step"><span>1</span>通过有线或蓝牙连接手柄</div><div class="guide-step"><span>2</span>按任意按键激活浏览器检测</div><div class="guide-step"><span>3</span>进入手柄检测确认连接状态</div></div><div class="guide-note">当前提供浏览器手柄检测。原版手柄输入协议尚未完成兼容，不会向电脑发送未经验证的手柄数据。</div>`,
  };
  openModal('操作指南', `<div class="guide-tabs">${[['connect','连接电脑'],['keyboard','键鼠操作'],['gamepad','游戏手柄']].map(([v,t]) => `<button class="${tab === v ? 'active' : ''}" data-action="guide-tab" data-tab="${v}">${t}</button>`).join('')}</div>${content[tab] || content.connect}`, { wide: true });
}
function openAbout() {
  openModal('关于', `<img class="about-brand" src="/assets/ic_tv_about_logo.png" alt="UU远程图标"><h3 class="about-name">网易UU远程 <span style="font-weight:300;font-size:18px">Web</span></h3><div class="about-version">WEB 0.1.0 · TV REFERENCE 3.5.0</div><p class="about-note">本项目参考提供的 TV 版 APK，实现浏览器主控界面与 WebRTC 串流接收。登录、设备列表和房间请求连接网易 UU 远程服务。</p><p class="about-note">原版协议适配仍需使用真实账号与电脑进行端到端验证。本项目并非网易官方 Web 客户端；品牌图标与引导资源来自参考 APK。</p><a class="text-button" href="https://uuyc.163.com/" target="_blank" rel="noreferrer">访问 UU远程官网<i data-icon="external"></i></a>`);
}
function openFeedback() {
  openModal('问题反馈', `<p class="modal-description">可导出问题描述和当前连接诊断，方便排查。诊断不包含账号令牌或信令原文。</p><form id="feedback-form"><label class="field"><span>遇到了什么问题？</span><textarea name="description" placeholder="请描述操作步骤、预期表现和实际情况…" required maxlength="2000"></textarea></label><div class="form-actions"><button class="secondary-button" type="button" data-action="close-modal">取消</button><button class="primary-button" type="submit"><i data-icon="download"></i>导出反馈</button></div></form>`);
  $('#feedback-form').addEventListener('submit', event => { event.preventDefault(); downloadJson('uu-feedback.json', { description: new FormData(event.currentTarget).get('description'), time: new Date().toISOString(), userAgent: navigator.userAgent, preferences: state.preferences, diagnostics: state.diagnostics }); closeModal(); notify('反馈文件已导出'); });
}
function downloadJson(name, value) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' })); const a = document.createElement('a'); a.href = url; a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
function openAllApps() {
  if (!state.authenticated) return openLogin();
  if (!state.selected) return openDevices();
  openModal('电脑应用', state.apps.length ? `<div class="app-list">${state.apps.map(appTile).join('')}</div>` : `<div class="empty-state"><i data-icon="grid"></i><h3>暂无已同步应用</h3><p>可直接进入电脑桌面，<br>或在官方客户端添加常用应用后刷新。</p><button class="primary-button" data-action="connect">进入桌面</button></div>`, { wide: !!state.apps.length });
}

async function connect() {
  if (!state.authenticated) return openLogin();
  if (!state.selected) return openDevices();
  if (state.selected.status === 'offline') return notify('设备已离线，请先在电脑端登录');
  closeModal();
  $('#remote-session').hidden = false; $('#remote-loading').hidden = false;
  $('#remote-device-name').textContent = state.selected.alias || '远程桌面';
  $('#remote-video').srcObject = null; state.audioBlocked = false;
  $('#retry-connection').hidden = true; $('#remote-loading .spinner').hidden = false;
  $('#connection-explanation').textContent = '正在协商安全的远程连接';
  document.body.style.overflow = 'hidden';
  await streamer.connect(state.selected.device_id, state.preferences);
}
function applyAudio() {
  const muted = state.preferences.muted || state.audioBlocked;
  $('#remote-video').muted = muted;
  $('#remote-mute').innerHTML = `<i data-icon="${muted ? 'muted' : 'volume'}"></i>`;
  $('#remote-mute').setAttribute('aria-label', muted ? '开启声音' : '静音'); hydrateIcons($('#remote-mute'));
}
streamer.addEventListener('state', ({ detail }) => {
  const names = { idle:'未连接', joining:'正在加入远控房间', signaling:'正在连接信令服务器', negotiating:'正在协商串流能力', connecting:'正在建立音视频通道', connected:'已连接', reconnecting:'等待网络恢复', error:'连接失败', closed:'已断开' };
  $('#remote-connection').textContent = names[detail.state] || detail.state;
  $('#connection-stage').textContent = detail.detail || names[detail.state];
  if (detail.state === 'connected') { $('#connection-explanation').textContent = '连接已建立，等待电脑传送第一帧画面'; if ($('#remote-video').videoWidth) $('#remote-loading').hidden = true; $('#remote-surface').focus(); }
  if (detail.state === 'reconnecting') { $('#remote-loading').hidden = false; $('#remote-loading .spinner').hidden = false; $('#connection-explanation').textContent = '正在等待网络恢复'; }
});
streamer.addEventListener('track', ({ detail }) => {
  const video = $('#remote-video');
  const media = video.srcObject || new MediaStream();
  for (const track of media.getTracks()) if (track.kind === detail.track.kind && track !== detail.track) media.removeTrack(track);
  if (!media.getTracks().includes(detail.track)) media.addTrack(detail.track);
  if (video.srcObject !== media) video.srcObject = media;
  applyAudio();
  // A shared media element keeps audio/video timestamps synchronized.
  video.play().catch(async () => {
    if (!video.muted) { state.audioBlocked = true; applyAudio(); await video.play().catch(() => {}); notify('点击远程画面以开启电脑声音'); }
  });
});
const showReceivedVideo = () => { if ($('#remote-video').videoWidth && streamer.state === 'connected') $('#remote-loading').hidden = true; };
$('#remote-video').addEventListener('playing', showReceivedVideo);
$('#remote-video').addEventListener('resize', showReceivedVideo);
streamer.addEventListener('stats', ({ detail: s }) => {
  $('#remote-stats').textContent = [`${s.width || '—'} × ${s.height || '—'}`, `${Math.round(s.fps || 0)} FPS`, `${s.mbps?.toFixed(1) || '—'} Mbps`, `${s.rtt == null ? '—' : Math.round(s.rtt)} ms`].join('  ·  ');
});
const diagnosticText = () => state.diagnostics.map(d => `${d.time.slice(11,19)}  [${d.stage}] ${d.detail}`).join('\n') || '暂无连接记录';
streamer.addEventListener('diagnostic', ({ detail }) => {
  state.diagnostics.push(detail); if (state.diagnostics.length > 200) state.diagnostics.shift();
  const log = $('#diagnostic-log'); if (log) { log.textContent = diagnosticText(); log.scrollTop = log.scrollHeight; }
});
streamer.addEventListener('error', ({ detail }) => {
  $('#remote-loading').hidden = false; $('#remote-loading .spinner').hidden = true;
  $('#connection-stage').textContent = '暂时无法连接电脑'; $('#connection-explanation').textContent = detail.message;
  $('#retry-connection').hidden = false;
});
streamer.addEventListener('data', ({ detail }) => { if (detail.label === 'CONTROL_DATA_CHANNEL' && state.pendingApp) sendPendingApp(); });
function sendPendingApp() {
  const app = state.pendingApp;
  if (!app) return;
  const payload = concat(string(1, app.dapp_id || ''), string(2, app.name || ''), string(3, app.target_path || ''));
  if (streamer.sendControl(envelope(state.seq++, 4, payload))) { state.pendingApp = null; notify(`已发送启动「${app.name}」的请求`); }
}
streamer.addEventListener('diagnostic', ({ detail }) => { if (detail.stage === 'datachannel' && detail.detail.startsWith('CONTROL_DATA_CHANNEL') && state.pendingApp) sendPendingApp(); });

const heldKeys = new Set(), heldButtons = new Set();
const surface = $('#remote-surface');
function releaseInput() {
  for (const key of heldKeys) streamer.sendInput({ action: 'kbd_release', key });
  for (const button of heldButtons) streamer.sendInput({ action: 'mouse_release', button });
  heldKeys.clear(); heldButtons.clear();
}
surface.addEventListener('keydown', event => {
  if (event.key === 'Escape') { event.preventDefault(); releaseInput(); surface.blur(); notify('已释放键鼠，按 Esc 返回首页'); return; }
  const key = virtualKey(event.code); if (!key) return;
  event.preventDefault(); if (!event.repeat && streamer.sendInput({ action: 'kbd_press', key })) heldKeys.add(key);
});
surface.addEventListener('keyup', event => { const key = virtualKey(event.code); if (key) { event.preventDefault(); streamer.sendInput({ action: 'kbd_release', key }); heldKeys.delete(key); } });
surface.addEventListener('blur', releaseInput); window.addEventListener('blur', releaseInput);
document.addEventListener('visibilitychange', () => { if (document.hidden) releaseInput(); });
let pendingPoint, frameScheduled = false;
surface.addEventListener('pointermove', event => {
  if (streamer.state !== 'connected' || !$('#remote-loading').hidden) return;
  pendingPoint = remotePoint(event, surface.getBoundingClientRect(), $('#remote-video').videoWidth, $('#remote-video').videoHeight);
  if (!frameScheduled) { frameScheduled = true; requestAnimationFrame(() => { frameScheduled = false; if (pendingPoint) streamer.sendInput({ action:'mouse_move_absolute', abs_x:pendingPoint.x, abs_y:pendingPoint.y }); }); }
});
const buttonCode = button => [1, 4, 2, 8, 16][button];
surface.addEventListener('pointerdown', event => {
  if (streamer.state !== 'connected' || !$('#remote-loading').hidden) return;
  const point = remotePoint(event, surface.getBoundingClientRect(), $('#remote-video').videoWidth, $('#remote-video').videoHeight);
  if (!point) return; event.preventDefault(); surface.focus(); surface.setPointerCapture(event.pointerId);
  if (state.audioBlocked) { state.audioBlocked = false; applyAudio(); $('#remote-video').play().catch(() => { state.audioBlocked = true; applyAudio(); }); }
  streamer.sendInput({ action: 'mouse_move_absolute', abs_x: point.x, abs_y: point.y });
  const button = buttonCode(event.button); if (button && streamer.sendInput({ action: 'mouse_press', button })) heldButtons.add(button);
});
surface.addEventListener('pointerup', event => { const button = buttonCode(event.button); if (button) { streamer.sendInput({ action:'mouse_release', button }); heldButtons.delete(button); } });
surface.addEventListener('pointercancel', releaseInput); surface.addEventListener('lostpointercapture', releaseInput);
surface.addEventListener('contextmenu', event => event.preventDefault());
surface.addEventListener('wheel', event => { if (streamer.state === 'connected') { event.preventDefault(); const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? surface.clientHeight : 1; streamer.sendInput({ action: 'mouse_scroll', delta_x: Math.round(event.deltaX * scale), delta_y: Math.round(-event.deltaY * scale) }); } }, { passive:false });

function openGamepad() {
  let animation;
  openModal('手柄检测', '<p class="modal-description">通过 USB 或蓝牙连接手柄，再按任意按键开始检测。当前版本仅检测手柄，尚不转发手柄输入。</p><img class="guide-image" src="/assets/ic_tv_gamepad.png" alt="游戏手柄"><div class="gamepad-status" id="gamepad-status">正在检测手柄…</div><div class="gamepad-test" id="gamepad-test"></div>', { cleanup: () => cancelAnimationFrame(animation) });
  const update = () => {
    if (!$('#gamepad-status')) return;
    const pads = [...(navigator.getGamepads?.() || [])].filter(Boolean);
    $('#gamepad-status').textContent = pads.length ? pads.map(p => `${p.id} · ${p.mapping || '自定义映射'}`).join('\n') : '尚未检测到手柄 · 连接后请按一下按键';
    $('#gamepad-test').innerHTML = pads[0] ? pads[0].buttons.map((b,i) => `<span class="gamepad-key ${b.pressed ? 'pressed' : ''}">${i}</span>`).join('') : '';
    animation = requestAnimationFrame(update);
  }; update();
}
function toggleKeyboard() {
  const keyboard = $('#virtual-keyboard'); keyboard.hidden = !keyboard.hidden;
  if (keyboard.innerHTML) return;
  const keys = [['Esc','Escape'],['Tab','Tab'],['Ctrl','ControlLeft'],['Alt','AltLeft'],['Win','MetaLeft'],...Array.from({length:12},(_,i) => [`F${i+1}`,`F${i+1}`]),['↑','ArrowUp'],['↓','ArrowDown'],['←','ArrowLeft'],['→','ArrowRight'],['Enter','Enter']];
  keyboard.innerHTML = keys.map(([label,code]) => `<button data-key="${code}">${label}</button>`).join('');
  keyboard.addEventListener('pointerdown', event => { const code = event.target.closest('[data-key]')?.dataset.key; if (!code) return; event.preventDefault(); const key = virtualKey(code); if (streamer.sendInput({ action:'kbd_press', key })) heldKeys.add(key); event.target.setPointerCapture(event.pointerId); });
  keyboard.addEventListener('pointerup', releaseInput); keyboard.addEventListener('pointercancel', releaseInput); keyboard.addEventListener('lostpointercapture', releaseInput);
}

const actions = {
  account: openAccount, devices: openDevices, refresh: () => refreshDevices(), feedback: openFeedback,
  settings: openSettings, 'remote-settings': openSettings, guide: () => openGuide(), about: openAbout,
  'all-apps': openAllApps, 'close-modal': closeModal, 'generate-qr': generateQr, 'token-login': openTokenLogin, 'sms-login': openSmsLogin,
  'guide-tab': button => openGuide(button.dataset.tab), 'refresh-modal': async () => { await refreshDevices(); if (state.authenticated) openDevices(); },
  'select-device': async button => { state.selected = state.devices.find(d => d.device_id === button.dataset.id); sessionStorage.setItem('uu-device', state.selected.device_id); closeModal(); render(); await loadApps(); render(); },
  'toggle-settings-audio': button => button.setAttribute('aria-checked', String(button.getAttribute('aria-checked') !== 'true')),
  logout: () => openModal('退出账号', '<p class="modal-description">退出后将断开当前远控连接，并清除本地服务中的登录令牌。</p><div class="form-actions"><button class="secondary-button" data-action="close-modal">取消</button><button class="primary-button" data-action="confirm-logout">退出登录</button></div>'),
  'confirm-logout': async () => { releaseInput(); await streamer.disconnect(); await request('/api/auth/logout', {method:'POST'}); state.authenticated = false; state.user = null; state.devices = []; state.selected = null; state.apps = []; state.pendingApp = null; $('#remote-session').hidden = true; document.body.style.overflow = ''; closeModal(); render(); notify('已退出账号'); },
  connect, retry: connect,
  disconnect: async () => { releaseInput(); state.pendingApp = null; await streamer.disconnect(); $('#remote-video').srcObject = null; $('#remote-session').hidden = true; document.body.style.overflow = ''; if (document.fullscreenElement) await document.exitFullscreen(); $('#desktop-preview').focus(); },
  'launch-app': async button => { const app = state.apps[Number(button.dataset.index)]; if (!app) return; state.pendingApp = app; await connect(); },
  fullscreen: async () => { if (document.fullscreenElement) await document.exitFullscreen(); else await $('#remote-session').requestFullscreen(); },
  mute: () => { if (state.audioBlocked) { state.audioBlocked = false; state.preferences.muted = false; } else state.preferences.muted = !state.preferences.muted; applyAudio(); $('#remote-video').play().catch(() => { state.audioBlocked = true; applyAudio(); }); localStorage.setItem('uu-preferences', JSON.stringify(state.preferences)); },
  keyboard: toggleKeyboard, gamepad: openGamepad,
  diagnostics: () => openModal('连接详情', `<p class="modal-description">记录连接阶段与 WebRTC 实测统计，不包含账号令牌。日志会自动更新。</p><pre class="diagnostic-log" id="diagnostic-log">${escape(diagnosticText())}</pre><div class="form-actions"><button class="secondary-button" data-action="copy-diagnostics">复制日志</button><button class="secondary-button" data-action="export-diagnostics"><i data-icon="download"></i>导出诊断</button></div>`, {wide:true}),
  'copy-diagnostics': async () => { await navigator.clipboard.writeText(diagnosticText()); notify('连接日志已复制'); },
  'export-diagnostics': () => downloadJson('uu-connection.json', { diagnostics:state.diagnostics, stats:streamer.stats }),
};
document.addEventListener('click', async event => {
  const button = event.target.closest('[data-action]'); if (!button || button.disabled) return;
  try { await actions[button.dataset.action]?.(button); } catch (error) { notify(error.message || '操作失败'); }
});

document.addEventListener('keydown', event => {
  if (modal.open || ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName) || document.activeElement === surface) return;
  if (event.key === 'Escape' && !$('#remote-session').hidden) { actions.disconnect(); return; }
  if (!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) return;
  if (!$('#remote-session').hidden) return;
  const elements = [...document.querySelectorAll('.app-shell button:not(:disabled),.app-shell a')].filter(el => el.getClientRects().length);
  const active = document.activeElement;
  if (!elements.includes(active)) { $('#desktop-preview').focus(); event.preventDefault(); return; }
  const r = active.getBoundingClientRect(), cx = r.x+r.width/2, cy=r.y+r.height/2;
  const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight', positive = event.key === 'ArrowRight' || event.key === 'ArrowDown';
  const candidates = elements.filter(el => el !== active).map(el => { const b=el.getBoundingClientRect(),dx=b.x+b.width/2-cx,dy=b.y+b.height/2-cy; return {el,primary:horizontal?dx:dy,secondary:horizontal?dy:dx}; }).filter(c => positive ? c.primary > 5 : c.primary < -5).sort((a,b) => (Math.abs(a.primary)+Math.abs(a.secondary)*3)-(Math.abs(b.primary)+Math.abs(b.secondary)*3));
  if (candidates[0]) { event.preventDefault(); candidates[0].el.focus(); }
});

render(); applyAudio();
try { const status = await request('/api/status'); state.ready = status.ready; state.authenticated = status.authenticated; state.user = status.user; render(); if (state.authenticated) await refreshDevices({silent:true}); if (!status.ready) notify('参考 APK 未就绪，请查看服务日志'); }
catch { notify('本地连接服务不可用，请使用 npm run dev 启动项目'); }
