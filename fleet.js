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
