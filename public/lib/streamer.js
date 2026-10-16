import { CHANNELS, ackValue, normalizeIceServers, soacMessage } from './protocol.js';
import { concat, connectOptions } from './protobuf.js';

// Browser implementation of the reference SDK's controller role. No screen capture or host agent.
export class UuStreamer extends EventTarget {
  constructor({ signalFactory, peerFactory = config => new RTCPeerConnection(config), request = defaultRequest } = {}) {
    super(); this.signalFactory = signalFactory; this.peerFactory = peerFactory; this.request = request;
    this.state = 'idle'; this.channels = new Map(); this.tracks = new Set(); this.pendingIce = []; this.generation = 0;
    this.stats = {}; this.sentBytes = 0; this.tasks = new Set();
  }
  emit(type, detail) { this.dispatchEvent(new CustomEvent(type, { detail })); }
  setState(state, detail = '') { this.state = state; this.emit('state', { state, detail }); }
  log(stage, detail) { this.emit('diagnostic', { time: new Date().toISOString(), stage, detail }); }
  waitAck(event, ...data) {
    const socket = this.socket;
    return new Promise((resolve, reject) => {
      const task = { reject }; this.tasks.add(task);
      const done = () => this.tasks.delete(task);
      socket.timeout(15000).emit(event, ...data, (timeout, ...args) => {
        if (!this.tasks.has(task)) return;
        done();
        if (timeout) return reject(new Error(`${event}：信令响应超时`));
        try { resolve(ackValue(args, event)); } catch (error) { reject(error); }
      });
    });
  }
  async connect(deviceId, options = {}) {
    await this.disconnect(false);
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    try {
      this.setState('joining', '正在加入远控房间');
      await this.request('/api/room', { method: 'POST', body: JSON.stringify({ deviceId, force: options.force === true }) });
      if (!current()) return;
      let factory = this.signalFactory;
      if (!factory) { const { io } = await import('/vendor/socket.io.esm.min.js'); factory = io; }
      if (!current()) return;
      this.socket = factory(globalThis.location?.origin || '', { path: '/signal/socket.io/', transports: ['websocket'], reconnection: false, timeout: 15000, autoConnect: false });
      this.socket.onAny?.((event, data) => { if (current() && event !== 'soac') this.log('event', `${event}；字段 ${data && typeof data === 'object' ? Object.keys(data).join(', ') : typeof data}`); });
      this.socket.on('soac', data => { if (current()) this.handleSoac(data).catch(error => { if (current()) this.fail(error); }); });
      this.socket.on('released', () => this.fail(new Error('远控权限已被另一台设备接管')));
      this.socket.on('left', data => { this.log('left', '远端退出房间'); this.fail(new Error('被控端已退出房间')); });
      this.socket.on('streamer_push', data => { this.emit('push', data); if (data?.code || data?.msg || data?.type) this.log('push', `type=${data.type || ''} code=${data.code ?? ''} ${data.msg || ''}`); });
      this.socket.on('disconnect', reason => { if (current() && !['idle', 'closed', 'error'].includes(this.state)) this.fail(new Error(`信令已断开：${reason}`)); });
      this.setState('signaling', '正在连接信令服务器');
      await new Promise((resolve, reject) => {
        const task = { reject }; this.tasks.add(task);
        const done = fn => value => { if (!this.tasks.delete(task)) return; fn(value); };
        this.socket.once('connect', done(resolve));
        this.socket.once('connect_error', done(error => reject(new Error(`信令连接失败：${error.message}`))));
        this.socket.connect();
      });
      if (!current()) return;
      const room = await this.waitAck('room_info');
      if (!current()) return;
      this.room = room;
      this.remoteId = room.publisher?.client_id || room.publisher?.id || room.publisher;
      if (!['string', 'number'].includes(typeof this.remoteId) || !this.remoteId) throw new Error('房间内没有可连接的电脑');
      this.log('room_info', '已获得房间信息');
      this.log('protocol', `房间字段：${Object.keys(room).join(', ')}；publisher=${typeof room.publisher}`);
      this.appControlId = crypto.randomUUID();
      this.setState('negotiating', '正在协商串流能力');
      // UU's native controller prefixes its Socket.IO binary attachment with 0x04
      // (0xce215c–0xce2198). The peer's native parser drops that byte (0xeaf468).
      // Engine.IO v4 in the browser sends binary attachments unchanged.
      const appData = concat(Uint8Array.of(4), connectOptions(options));
      this.log('protocol', `控制请求采用原版 0x04 二进制前缀；app_data=${appData.byteLength} bytes`);
      // The native controller initializes streamer_data as an empty string (0xcdd2cc–0xcdd2e0).
      const control = await this.waitAck('control', { app_data: appData, streamer_data: '', app_control_id: this.appControlId });
      if (!current()) return;
      this.log('control', `响应字段：${Object.keys(control).join(', ')}；目标与房间发布者${String(control.client_id) === String(this.remoteId) ? '相同' : '不同'}；app_data=${control.app_data?.byteLength || 0} bytes`);
      if (typeof control.streamer_data === 'string' && control.streamer_data.length) {
        try { this.log('capability', `协商字段：${Object.keys(JSON.parse(control.streamer_data)).join(', ')}`); }
        catch { this.log('capability', `协商数据不是 JSON，长度 ${control.streamer_data.length}`); }
      }
      this.remoteId = control.client_id || this.remoteId;
      this.iceId = control.ice_id;
      if (!['string', 'number'].includes(typeof this.iceId) || !this.iceId) throw new Error('控制权响应缺少 ice_id，无法建立串流');
      this.emit('control', control);
      const pc = this.peerFactory({ iceServers: normalizeIceServers(control.iceServers || room.iceServers), iceTransportPolicy: control.force_relay ? 'relay' : 'all', bundlePolicy: 'max-bundle' });
      this.peer = pc;
      pc.onicecandidate = event => {
        if (!current() || !event.candidate) return;
        this.sendSoac('candidate', event.candidate.toJSON());
      };
      pc.oniceconnectionstatechange = () => { if (current()) this.log('ice', `连接状态 ${pc.iceConnectionState}`); };
      pc.onicegatheringstatechange = () => { if (current()) this.log('ice', `收集状态 ${pc.iceGatheringState}`); };
      pc.onsignalingstatechange = () => { if (current()) this.log('sdp', `协商状态 ${pc.signalingState}`); };
      pc.onicecandidateerror = event => { if (current()) this.log('ice', `候选错误 ${event.errorCode}：${event.errorText || ''}`); };
      pc.ontrack = event => {
        if (!current()) return;
        this.tracks.add(event.track);
        const stream = event.streams?.[0] || new MediaStream([event.track]);
        this.emit('track', { track: event.track, stream });
      };
      pc.ondatachannel = event => this.bindChannel(event.channel);
      pc.onconnectionstatechange = () => {
        if (!current()) return;
        this.log('webrtc', pc.connectionState);
        if (pc.connectionState === 'connected') { clearTimeout(this.connectTimer); this.setState('connected', '串流已连接'); this.startStats(); }
        else if (pc.connectionState === 'failed') this.fail(new Error('无法建立 WebRTC 连接，请检查电脑在线状态与网络'));
        else if (pc.connectionState === 'disconnected') {
          this.setState('reconnecting', '网络已中断，正在等待恢复');
          clearTimeout(this.recoveryTimer);
          this.recoveryTimer = setTimeout(() => { if (pc.connectionState !== 'connected') this.fail(new Error('网络连接未恢复，请重新连接')); }, 12000);
        }
      };
      const transceiver = pc.addTransceiver('video', { direction: 'recvonly' });
      const codecs = globalThis.RTCRtpReceiver?.getCapabilities('video')?.codecs || [];
      const h264 = codecs.filter(c => c.mimeType.toLowerCase() === 'video/h264');
      if (h264.length && transceiver.setCodecPreferences) transceiver.setCodecPreferences(h264);
      pc.addTransceiver('audio', { direction: 'recvonly' });
      for (const label of CHANNELS) this.bindChannel(pc.createDataChannel(label, { ordered: true }));
      this.setState('connecting', '正在建立音视频通道');
      await pc.setLocalDescription(await pc.createOffer());
      if (!current()) return;
      this.sendSoac('offer', { sdp: pc.localDescription.sdp });
      for (const data of this.earlySoac || []) await this.handleSoac(data);
      this.earlySoac = [];
      if (this.state !== 'connected') this.connectTimer = setTimeout(() => { if (this.state !== 'connected') this.fail(new Error('音视频协商超时；当前原版协议适配尚需真实设备联调')); }, 30000);
    } catch (error) { if (current()) this.fail(error); }
  }
  sendSoac(type, payload) {
    if (!this.socket?.connected) return;
    this.socket.emit('soac', soacMessage(this.remoteId, type, payload, this.iceId, this.appControlId), (...args) => {
      this.log('soac-ack', `${type}：${args.map(value => value && typeof value === 'object' ? `字段 ${Object.keys(value).join(', ')}` : typeof value === 'string' ? (['succ', 'success', 'ok'].includes(value) ? value : `字符串 ${value.length} 字符`) : String(value)).join(' / ')}`);
    });
    this.log('soac', `发送 ${type}`);
  }
  async handleSoac(packet) {
    this.log('signal', `收到 soac：${packet?.data?.type || '未知类型'}；字段 ${Object.keys(packet || {}).join(', ')}`);
    if (!this.peer) { (this.earlySoac ||= []).push(packet); return; }
    const peer = this.peer, generation = this.generation;
    const current = () => peer === this.peer && generation === this.generation;
    const data = packet?.data;
    if (!data) return;
    if (data.ice_id && String(data.ice_id) !== String(this.iceId)) { this.log('signal', '已忽略其他 ICE 代次的消息'); return; }
    this.log('soac', `收到 ${data.type}`);
    if (data.type === 'answer') {
      await peer.setRemoteDescription({ type: 'answer', sdp: data.sdp });
      if (!current()) return;
      for (const ice of this.pendingIce) { if (!current()) return; await peer.addIceCandidate(ice); }
      this.pendingIce = [];
    } else if (data.type === 'offer' || data.type === 'restart_ice') {
      await peer.setRemoteDescription({ type: 'offer', sdp: data.sdp });
      if (!current()) return;
      await peer.setLocalDescription(await peer.createAnswer());
      if (current()) this.sendSoac('answer', { sdp: peer.localDescription.sdp });
    } else if (data.type === 'candidate') {
      const source = data.candidate && typeof data.candidate === 'object' ? data.candidate : data;
      const ice = { candidate: source.candidate, sdpMid: source.sdpMid, sdpMLineIndex: source.sdpMLineIndex };
      this.log('ice', `收到${source === data ? '平铺' : '嵌套'}候选；mid=${ice.sdpMid ?? '缺失'}；mline=${ice.sdpMLineIndex ?? '缺失'}`);
      if (peer.remoteDescription) await peer.addIceCandidate(ice);
      else this.pendingIce.push(ice);
    }
  }
  bindChannel(channel) {
    if (this.channels.has(channel.label)) return;
    this.channels.set(channel.label, channel); channel.binaryType = 'arraybuffer';
    channel.onopen = () => this.log('datachannel', `${channel.label} 已就绪`);
    channel.onmessage = event => this.emit('data', { label: channel.label, data: event.data });
    channel.onerror = () => this.log('datachannel', `${channel.label} 传输失败`);
  }
  sendInput(event) {
    const channel = this.channels.get('CONTROL_DATA_CHANNEL');
    if (this.state !== 'connected' || channel?.readyState !== 'open') return false;
    // Releasing a held input must not be dropped with pointer-motion traffic.
    const release = typeof event === 'object' && ['kbd_release', 'mouse_release'].includes(event.action);
    if (channel.bufferedAmount > 64 * 1024 && !release) return false;
    const data = typeof event === 'string' ? event : JSON.stringify(event);
    try { const encoded = new TextEncoder().encode(data); channel.send(encoded); this.sentBytes += encoded.byteLength; return true; }
    catch { this.log('datachannel', '控制通道暂时无法发送输入'); return false; }
  }
  sendControl(bytes) {
    const channel = this.channels.get('CONTROL_DATA_CHANNEL');
    if (channel?.readyState !== 'open' || channel.bufferedAmount > 256 * 1024) return false;
    try { channel.send(bytes); return true; }
    catch { this.log('datachannel', '控制通道暂时无法发送消息'); return false; }
  }
  startStats() {
    clearInterval(this.statsTimer); let previous;
    this.statsTimer = setInterval(async () => {
      const pc = this.peer;
      if (!pc || pc.connectionState !== 'connected') return;
      try {
        const report = await pc.getStats(); const stats = {};
        report.forEach(item => {
          if (item.type === 'inbound-rtp' && item.kind === 'video') {
            stats.width = item.frameWidth; stats.height = item.frameHeight; stats.fps = item.framesPerSecond;
            stats.packetsLost = item.packetsLost; stats.framesDropped = item.framesDropped;
            stats.decoder = item.decoderImplementation;
            if (previous && item.timestamp > previous.timestamp) stats.mbps = (item.bytesReceived - previous.bytesReceived) * 8 / (item.timestamp - previous.timestamp) / 1000;
            previous = item;
          }
          if (item.type === 'candidate-pair' && item.state === 'succeeded' && item.nominated) { if (Number.isFinite(item.currentRoundTripTime)) stats.rtt = item.currentRoundTripTime * 1000; stats.transport = item.localCandidateId; }
        });
        this.stats = stats; this.emit('stats', stats);
      } catch (error) { this.log('stats', error.message); }
    }, 1000);
  }
  fail(error) {
    if (this.state === 'error' || this.state === 'closed') return;
    this.generation++;
    this.log('error', error.message); this.setState('error', error.message);
    this.cleanup(); this.emit('error', error);
  }
  cleanup() {
    clearInterval(this.statsTimer); clearTimeout(this.connectTimer); clearTimeout(this.recoveryTimer);
    for (const task of this.tasks) task.reject(new Error('连接已取消'));
    this.tasks.clear();
    if (this.peer) { this.peer.onconnectionstatechange = null; this.peer.ontrack = null; this.peer.onicecandidate = null; this.peer.close(); this.peer = undefined; }
    for (const track of this.tracks) track.stop();
    this.tracks.clear();
    for (const channel of this.channels.values()) channel.close();
    this.channels.clear();
    this.socket?.removeAllListeners(); this.socket?.disconnect(); this.socket = undefined;
    this.pendingIce = []; this.earlySoac = [];
  }
  async disconnect(notifyServer = true) {
    this.generation++; this.setState('closed'); this.cleanup();
    if (notifyServer) await this.request('/api/room', { method: 'DELETE' }).catch(() => {});
    this.setState('idle');
  }
}
async function defaultRequest(url, options) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json' } });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || '请求失败'); return data;
}
