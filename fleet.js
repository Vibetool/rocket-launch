// 机库：记录所有抵达卡门线的飞船，供主页雷达站列表与制造页加载
// 存储在浏览器 localStorage —— 换设备/换浏览器不互通（真·联机需要后端）

const FLEET_KEY = 'rocket_fleet_v1';

// 系统预置：标准三级火箭（大→中→小，级间各一个分离器）
const PRESET_SHIPS = [
  {
    id: 'preset_三级标准型',
    name: '三级标准型',
    desc: '系统预置 · 大中小三级递减，级间分离器',
    preset: true,
    stack: [
      { partId: 'engine_large',  fuel: 0   },
      { partId: 'fuel_large',    fuel: 100 },
      { partId: 'decoupler',     fuel: 0   },
      { partId: 'engine_medium', fuel: 0   },
      { partId: 'fuel_medium',   fuel: 60  },
      { partId: 'decoupler',     fuel: 0   },
      { partId: 'engine_small',  fuel: 0   },
      { partId: 'fuel_small',    fuel: 20  },
    ],
  },
];

function fleetRead() {
  try {
    const raw = localStorage.getItem(FLEET_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (e) { return []; }
}

function fleetWrite(list) {
  try { localStorage.setItem(FLEET_KEY, JSON.stringify(list)); return true; }
  catch (e) { return false; }
}

// 全部飞船：系统预置在前，玩家记录按高度降序
function fleetAll() {
  const mine = fleetRead().slice().sort((a, b) => (b.apogee || 0) - (a.apogee || 0));
  return PRESET_SHIPS.concat(mine);
}

function fleetFind(id) {
  // 云端飞船不在本地表里，主页点击时已暂存到 sessionStorage
  try {
    const raw = sessionStorage.getItem('rocket_remote_ship');
    if (raw) {
      const s = JSON.parse(raw);
      if (s && s.id === id) { sessionStorage.removeItem('rocket_remote_ship'); return s; }
    }
  } catch (e) {}
  return fleetAll().find(s => s.id === id) || null;
}

// 抵达卡门线后登记。同一套设计只保留成绩最好的一条。
function fleetRecord(stack, apogee, time) {
  const design = stack.map(p => ({ partId: p.partId, fuel: p.fuel || 0 }));
  const sig = design.map(p => p.partId).join('|');
  const list = fleetRead();
  const hit = list.find(s => s.sig === sig);
  if (hit) {
    if (apogee > (hit.apogee || 0)) { hit.apogee = apogee; hit.time = time; hit.ts = Date.now(); }
  } else {
    list.push({
      id: 'ship_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      name: fleetAutoName(design),
      sig, stack: design, apogee, time, ts: Date.now(),
    });
  }
  fleetWrite(list);
  // 同步上报联机机库（失败不影响本地记录）
  const saved = list.find(s => s.sig === sig);
  if (saved && API()) { fleetPushRemote(saved).catch(() => {}); }
  return true;
}

// 按级数与首级引擎自动起名
function fleetAutoName(design) {
  const stages = design.filter(p => p.partId === 'decoupler').length + 1;
  const first = design.find(p => p.partId.startsWith('engine_'));
  const size = first ? ({ engine_large: '重型', engine_medium: '中型', engine_small: '轻型' })[first.partId] : '无动力';
  const cn = ['单', '两', '三', '四', '五', '六', '七', '八'][stages - 1] || stages;
  return `${size}${cn}级`;
}

function fleetDelete(id) {
  fleetWrite(fleetRead().filter(s => s.id !== id));
}

// 跨页传递：主页选中飞船 → 制造页加载
const PENDING_KEY = 'rocket_pending_ship';
function fleetSetPending(id) {
  try { sessionStorage.setItem(PENDING_KEY, id); } catch (e) {}
}
function fleetTakePending() {
  try {
    const id = sessionStorage.getItem(PENDING_KEY);
    if (id) sessionStorage.removeItem(PENDING_KEY);
    return id;
  } catch (e) { return null; }
}

// ================= 联机机库 =================
// 有 config.js 配了 ROCKET_API 就走云端；没配或请求失败则退回本机 localStorage。
const API = () => (typeof window !== 'undefined' && window.ROCKET_API) || '';
const NAME_KEY = 'rocket_player_name';

function playerName() {
  try { return localStorage.getItem(NAME_KEY) || ''; } catch (e) { return ''; }
}
function setPlayerName(n) {
  try { localStorage.setItem(NAME_KEY, (n || '').slice(0, 16)); } catch (e) {}
}

// 拉取云端机库。失败返回 null（调用方据此退回本地）
async function fleetFetchRemote(limit = 60) {
  const url = API();
  if (!url) return null;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(`${url}?limit=${limit}`, { signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || !d.ok || !Array.isArray(d.ships)) return null;
    return d.ships.map(s => ({ ...s, remote: true }));
  } catch (e) { return null; }
}

// 上报一艘入轨飞船。返回是否成功送达云端
async function fleetPushRemote(ship) {
  const url = API();
  if (!url) return false;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player: playerName(), name: ship.name,
        stack: ship.stack, apogee: ship.apogee, time: ship.time,
      }),
      signal: ctl.signal, keepalive: true,
    });
    clearTimeout(timer);
    const d = await r.json().catch(() => null);
    return !!(d && d.ok);
  } catch (e) { return false; }
}

// 机库总表：系统预置 + 云端（可用时）+ 本机记录
// 云端与本机同款设计会去重，优先显示云端那条（带作者名）
async function fleetAllAsync() {
  const remote = await fleetFetchRemote();
  const local = fleetRead().slice().sort((a, b) => (b.apogee || 0) - (a.apogee || 0));
  if (!remote) return { ships: PRESET_SHIPS.concat(local), online: false };
  const seen = new Set(remote.map(s => (s.stack || []).map(p => p.partId).join('|')));
  const localOnly = local.filter(s => !seen.has((s.stack || []).map(p => p.partId).join('|')));
  return { ships: PRESET_SHIPS.concat(remote, localOnly), online: true };
}
