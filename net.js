// 联机：信令走后端，接通后游戏事件与语音全部 P2P（WebRTC）
// 两人共享一次任务：都进制造楼才能操作，都点发射才起飞，分级自动化。

const NET = {
  active: false,
  role: null,        // 'host' | 'guest'
  code: null,
  myName: '',
  peerName: '',
  connected: false,
  // 共享状态
  peerInBuilding: false,
  meInBuilding: false,
  peerLaunchReady: false,
  meLaunchReady: false,
  // 内部
  pc: null, dc: null, pollTimer: null, since: 0,
  localStream: null, remoteAudio: null,
  onEvent: null,     // 由页面注入的回调 (type, data)
};

const SIGNAL_URL = () => (window.ROCKET_ROOM_API || '');
const ICE = { iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }] };

function netAvailable() { return !!SIGNAL_URL(); }

async function api(action, params = {}, body = null) {
  const url = new URL(SIGNAL_URL(), location.href);
  url.searchParams.set('action', action);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const opt = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
                   : { method: action === 'status' || action === 'poll' ? 'GET' : 'POST' };
  const r = await fetch(url.toString(), opt);
  const d = await r.json().catch(() => null);
  if (!d || !d.ok) throw new Error((d && d.error) || 'net_error');
  return d;
}

function emit(type, data) { if (NET.onEvent) NET.onEvent(type, data); }

// ---------- 建立 P2P ----------
function setupPeer(isHost) {
  const pc = new RTCPeerConnection(ICE);
  NET.pc = pc;

  pc.onicecandidate = e => {
    if (e.candidate) send({ t: 'ice', c: e.candidate }).catch(() => {});
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') { NET.connected = true; emit('connected'); }
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      NET.connected = false; emit('disconnected');
    }
  };
  // 对方语音
  pc.ontrack = e => {
    if (!NET.remoteAudio) {
      NET.remoteAudio = new Audio();
      NET.remoteAudio.autoplay = true;
    }
    NET.remoteAudio.srcObject = e.streams[0];
    NET.remoteAudio.play().catch(() => {});
  };

  if (isHost) {
    const dc = pc.createDataChannel('game', { ordered: true });
    bindChannel(dc);
  } else {
    pc.ondatachannel = e => bindChannel(e.channel);
  }
  return pc;
}

function bindChannel(dc) {
  NET.dc = dc;
  dc.onopen = () => { NET.connected = true; emit('connected'); };
  dc.onclose = () => { NET.connected = false; emit('disconnected'); };
  dc.onmessage = e => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    handlePeerMessage(m);
  };
}

// 收到对方的游戏事件
function handlePeerMessage(m) {
  switch (m.t) {
    case 'building':   NET.peerInBuilding = !!m.v; emit('building', m.v); break;
    case 'launchReady':NET.peerLaunchReady = !!m.v; emit('launchReady', m.v); break;
    case 'launch':     emit('launch'); break;
    case 'ship':       emit('ship', m.stack); break;
    case 'talk':       emit('talk', m.v); break;
    case 'bye':        emit('peerLeft'); break;
  }
}

function netSend(obj) {
  if (NET.dc && NET.dc.readyState === 'open') {
    try { NET.dc.send(JSON.stringify(obj)); } catch (e) {}
  }
}

// ---------- 信令收发 ----------
async function send(payload) {
  const to = NET.role === 'host' ? 'guest' : 'host';
  return api('signal', { code: NET.code, to }, { payload });
}

function startPolling() {
  stopPolling();
  NET.pollTimer = setInterval(async () => {
    try {
      const d = await api('poll', { code: NET.code, me: NET.role, since: NET.since });
      NET.since = d.last;
      for (const m of d.msgs) await onSignal(m);
      // P2P 通了就不用再轮询信令
      if (NET.connected) stopPolling();
    } catch (e) {}
  }, 1200);
}
function stopPolling() { if (NET.pollTimer) { clearInterval(NET.pollTimer); NET.pollTimer = null; } }

async function flushIce() {
  const pc = NET.pc, buf = NET.pendingIce || [];
  NET.pendingIce = [];
  for (const c of buf) { try { await pc.addIceCandidate(c); } catch (e) {} }
}

async function onSignal(m) {
  const pc = NET.pc;
  if (!pc) return;
  if (m.t === 'offer') {
    await pc.setRemoteDescription(m.sdp);
    await flushIce();
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    await send({ t: 'answer', sdp: ans });
  } else if (m.t === 'answer') {
    if (!pc.currentRemoteDescription) { await pc.setRemoteDescription(m.sdp); await flushIce(); }
  } else if (m.t === 'ice') {
    // 远端描述还没设好时直接 add 会抛错，先缓冲
    if (pc.remoteDescription && pc.remoteDescription.type) {
      try { await pc.addIceCandidate(m.c); } catch (e) {}
    } else {
      (NET.pendingIce = NET.pendingIce || []).push(m.c);
    }
  } else if (m.t === 'joined') {
    if (!NET.peerName) NET.peerName = m.name || '对方';
    emit('peerJoined', NET.peerName);
    await hostOffer();
  }
}

// ---------- 对外接口 ----------
async function netCreateRoom(name) {
  NET.myName = name || '匿名工程师';
  const d = await api('create', {}, { name: NET.myName });
  NET.code = d.code; NET.role = 'host'; NET.active = true; NET.since = 0;
  NET.offerSent = false; NET.pendingIce = [];
  setupPeer(true);
  await addMic();          // 提前拿麦克风，SDP 里才带音频轨
  startPolling();
  // 主机同时轮询房间状态，等人进来
  const waitGuest = setInterval(async () => {
    try {
      const s = await api('status', { code: NET.code });
      if (s.state === 'joined') {
        if (!NET.peerName) { NET.peerName = s.guest_name || '对方'; emit('peerJoined', NET.peerName); }
        clearInterval(waitGuest);
        await hostOffer();
      }
    } catch (e) { emit('error', 'status:' + e.message); }
  }, 1500);
  return d.code;
}

// 只允许发起一次，避免 waitGuest 轮询与 'joined' 信令双触发导致竞态
async function hostOffer() {
  const pc = NET.pc;
  if (!pc || NET.offerSent) return;
  if (pc.signalingState !== 'stable') return;
  NET.offerSent = true;
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await send({ t: 'offer', sdp: offer });
  } catch (e) {
    NET.offerSent = false;               // 失败要允许重试
    emit('error', 'offer:' + e.message);
  }
}

async function netJoinRoom(code, name) {
  NET.myName = name || '匿名工程师';
  NET.code = String(code).toUpperCase().trim();
  const d = await api('join', { code: NET.code }, { name: NET.myName });
  NET.role = 'guest'; NET.active = true; NET.since = 0; NET.peerName = d.host || '房主';
  NET.offerSent = false; NET.pendingIce = [];
  setupPeer(false);
  await addMic();
  startPolling();
  await send({ t: 'joined', name: NET.myName });
  return d.host;
}

// 语音：先拿到麦克风轨道并静音，按住说话时才 enable
async function addMic() {
  try {
    // 加超时：某些环境下权限对话框不出现会一直悬着，不能卡住建连
    NET.localStream = await Promise.race([
      navigator.mediaDevices.getUserMedia({ audio: true }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('mic_timeout')), 6000)),
    ]);
    NET.localStream.getAudioTracks().forEach(t => {
      t.enabled = false;                       // 默认静音，按住才开
      NET.pc.addTrack(t, NET.localStream);
    });
    return true;
  } catch (e) { return false; }   // 用户拒绝麦克风也不影响游戏
}

function netSetTalking(on) {
  if (!NET.localStream) return false;
  NET.localStream.getAudioTracks().forEach(t => { t.enabled = !!on; });
  netSend({ t: 'talk', v: !!on });
  return true;
}
function netHasMic() { return !!NET.localStream; }

function netSetBuilding(v) { NET.meInBuilding = !!v; netSend({ t: 'building', v: !!v }); }
function netSetLaunchReady(v) { NET.meLaunchReady = !!v; netSend({ t: 'launchReady', v: !!v }); }
function netSendShip(stack) { netSend({ t: 'ship', stack }); }
function netBothInBuilding() { return NET.meInBuilding && NET.peerInBuilding; }
function netBothLaunchReady() { return NET.meLaunchReady && NET.peerLaunchReady; }

function netLeave() {
  netSend({ t: 'bye' });
  stopPolling();
  try { NET.pc && NET.pc.close(); } catch (e) {}
  try { NET.localStream && NET.localStream.getTracks().forEach(t => t.stop()); } catch (e) {}
  if (NET.code) api('close', { code: NET.code }).catch(() => {});
  Object.assign(NET, { active:false, role:null, code:null, connected:false, pc:null, dc:null,
    peerInBuilding:false, meInBuilding:false, peerLaunchReady:false, meLaunchReady:false,
    localStream:null, peerName:'' });
}

// 会话内保持联机状态（主页↔制造页跳转不掉线做不到，改为把状态存下来提示用户）
function netSaveHint() {
  try { sessionStorage.setItem('rocket_net_hint', JSON.stringify({ code: NET.code, role: NET.role, name: NET.myName })); } catch (e) {}
}
function netReadHint() {
  try { const r = sessionStorage.getItem('rocket_net_hint'); return r ? JSON.parse(r) : null; } catch (e) { return null; }
}
