// 主页模块（IIFE 隔离作用域：与 game.js 共存于同一页面，避免 $ / cv / PAD_* 等重名）
(function () {
// 主页：复用发射场贴图作地面，在同一片山丘上摆放制造大楼与雷达站
const $ = id => document.getElementById(id);

// launchpad.png 实测几何（与 game.js 保持一致）
const PAD_W = 1536, PAD_H = 1024;
const PAD_DECK_Y = 783;        // 甲板上表面
const PAD_EDGE_GRASS_Y = 904;  // 图片左右边缘的草地顶边
const PAD_GRASS_COLOR = '#6e863f';

const sprites = {};
const SPRITE_NAMES = ['launchpad', 'vab', 'radar'];
let ready = false;

function load() {
  let pending = SPRITE_NAMES.length;
  SPRITE_NAMES.forEach(n => {
    const img = new Image();
    img.onload = () => { sprites[n] = img; if (--pending === 0) { ready = true; draw(); } };
    img.onerror = () => { if (--pending === 0) { ready = true; draw(); } };
    img.src = `assets/${n}.png`;
  });
}

const cv = $('scene'), cx = cv.getContext('2d');

// 建筑布局：x 为画面宽度比例，scale 相对发射场贴图的缩放
const BUILDINGS = [
  { key: 'vab',   sprite: 'vab',   xr: 0.24, hs: 'hsVab',   wr: 0.155, minW: 96,  maxW: 210 },
  { key: 'radar', sprite: 'radar', xr: 0.79, hs: 'hsRadar', wr: 0.145, minW: 90,  maxW: 190 },
];

function draw() {
  const W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * devicePixelRatio; cv.height = H * devicePixelRatio;
  cx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);

  // 天空：白天的发射场蓝
  const sky = cx.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, '#1c4f86');
  sky.addColorStop(0.45, '#4f9fd8');
  sky.addColorStop(1, '#9fd4f0');
  cx.fillStyle = sky; cx.fillRect(0, 0, W, H);

  // 云
  cx.fillStyle = 'rgba(255,255,255,.18)';
  cloud(W * 0.16, H * 0.24, Math.min(W, H) * 0.10);
  cloud(W * 0.62, H * 0.17, Math.min(W, H) * 0.075);
  cloud(W * 0.88, H * 0.30, Math.min(W, H) * 0.06);

  const groundY = H * 0.80;   // 地平线（甲板高度）
  const pad = sprites.launchpad;

  if (pad) {
    const pw = Math.max(400, Math.min(W * 0.52, 620));
    const s = pw / PAD_W;
    const grassY = groundY + (PAD_EDGE_GRASS_Y - PAD_DECK_Y) * s;
    cx.fillStyle = PAD_GRASS_COLOR;
    if (grassY < H) cx.fillRect(0, grassY, W, H - grassY);
    cx.drawImage(pad, W / 2 - pw / 2, groundY - PAD_DECK_Y * s, pw, PAD_H * s);
  } else {
    // 贴图没加载出来时的兜底地面
    cx.fillStyle = PAD_GRASS_COLOR;
    cx.fillRect(0, groundY + 26, W, H - groundY);
    cx.fillStyle = '#3f4a5c';
    cx.fillRect(W / 2 - 90, groundY, 180, 14);
  }

  // 建筑底边必须落在真实草地线上。草地线由贴图缩放决定，会随窗口宽度变化，
  // 之前用固定 46px 偏移，宽屏就悬浮、窄屏就埋进土里。
  const padScale = (pad ? Math.max(400, Math.min(W * 0.52, 620)) : 620) / PAD_W;
  const baseY = pad
    ? groundY + (PAD_EDGE_GRASS_Y - PAD_DECK_Y) * padScale
    : groundY + 26;   // 兜底地面用的偏移
  BUILDINGS.forEach(b => {
    const img = sprites[b.sprite];
    const bw = Math.max(b.minW, Math.min(W * b.wr, b.maxW));
    const bh = img ? bw * img.height / img.width : bw * 1.4;
    const x = W * b.xr, y = baseY;
    if (img) {
      cx.drawImage(img, x - bw / 2, y - bh, bw, bh);
    } else {
      cx.fillStyle = '#93a3b8';
      cx.fillRect(x - bw / 2, y - bh, bw, bh);
    }
    // 同步热区标签到建筑顶部
    const el = $(b.hs);
    if (el) { el.style.left = x + 'px'; el.style.top = (y - bh - 10) + 'px'; }
  });
}

function cloud(x, y, r) {
  cx.beginPath();
  cx.arc(x, y, r * 0.6, 0, 7);
  cx.arc(x + r * 0.55, y + r * 0.12, r * 0.45, 0, 7);
  cx.arc(x - r * 0.55, y + r * 0.14, r * 0.4, 0, 7);
  cx.arc(x + r * 0.1, y - r * 0.28, r * 0.42, 0, 7);
  cx.fill();
}

// ---------- 交互 ----------
$('hsVab').addEventListener('click', () => { window.GAME.enterBuilding(); });

const modal = $('fleetModal');
$('hsRadar').addEventListener('click', openFleet);
$('fleetClose').addEventListener('click', closeFleet);
modal.addEventListener('click', e => { if (e.target === modal) closeFleet(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape' && !modal.hidden) closeFleet(); });

function openFleet() { modal.hidden = false; $('fleetClose').focus(); renderFleet(); }
function closeFleet() { modal.hidden = true; }

async function renderFleet() {
  const list = $('shipList');
  list.innerHTML = '<div class="empty">正在连接雷达…</div>';

  const { ships, online } = await fleetAllAsync();
  list.innerHTML = '';

  // 在线状态条
  const bar = document.createElement('div');
  bar.className = 'net-bar ' + (online ? 'on' : 'off');
  bar.innerHTML = online
    ? `<span class="dot"></span>已连接联机机库 · 显示全体玩家的入轨飞船
       <button class="rename" id="btnRename">${playerName() ? '我是「' + playerName() + '」' : '设置昵称'}</button>`
    : `<span class="dot"></span>离线模式 · 只显示本机记录`;
  list.appendChild(bar);
  if (online) $('btnRename').addEventListener('click', e => { e.stopPropagation(); askName(); });

  const others = ships.filter(s => !s.preset);
  if (!others.length) {
    const tip = document.createElement('div');
    tip.className = 'empty';
    tip.innerHTML = '还没有入轨记录<br><small>把火箭送过 100 km，它就会登记到这里</small>';
    list.appendChild(tip);
  }

  ships.forEach(s => {
    const b = document.createElement('button');
    b.className = 'ship' + (s.preset ? ' is-preset' : '') + (s.remote ? ' is-remote' : '');
    b.appendChild(miniRocket(s.stack));

    const mid = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'ship-name';
    name.textContent = s.name;
    if (s.preset) {
      const t = document.createElement('span'); t.className = 'tagp'; t.textContent = '系统预置';
      name.appendChild(t);
    } else if (s.remote) {
      const t = document.createElement('span'); t.className = 'tagu'; t.textContent = '@' + (s.player || '匿名');
      name.appendChild(t);
    }
    const meta = document.createElement('div');
    meta.className = 'ship-meta';
    meta.textContent = s.preset ? s.desc
      : `${s.stages || stageCount(s.stack)} 级 · ${s.parts || s.stack.length} 个零件 · ${new Date(s.ts).toLocaleDateString('zh-CN')}`;
    mid.appendChild(name); mid.appendChild(meta);
    b.appendChild(mid);

    const apo = document.createElement('div');
    apo.className = 'ship-apo';
    apo.innerHTML = s.preset ? '<small>点击载入</small>'
                             : `${(s.apogee / 1000).toFixed(1)}<small>km 最高</small>`;
    b.appendChild(apo);

    b.addEventListener('click', () => {
      if (s.remote) cacheRemoteShip(s);
      fleetSetPending(s.id);
      closeFleet();
      window.GAME.enterBuilding(true);   // 带飞船进车间
    });
    list.appendChild(b);
  });

  $('fleetFoot').textContent = online
    ? `共 ${others.length} 艘入轨飞船 · 来自所有玩家`
    : `共 ${others.length} 艘 · 记录保存在本机浏览器`;
}

// 云端飞船暂存，供 game.html 载入
function cacheRemoteShip(s) {
  try { sessionStorage.setItem('rocket_remote_ship', JSON.stringify(s)); } catch (e) {}
}

function askName() {
  const cur = playerName();
  const n = prompt('设置你的昵称（会显示在联机机库里，最多 16 字）', cur);
  if (n === null) return;
  setPlayerName(n.trim());
  renderFleet();
}

function stageCount(stack) {
  return stack.filter(p => p.partId === 'decoupler').length + 1;
}

// 列表左侧的火箭缩略图（按零件类型堆出配色条）
function miniRocket(stack) {
  const wrap = document.createElement('div');
  wrap.className = 'ship-mini';
  const COLORS = { engine: '#ff8a3d', fuel: '#e2e9f4', decoupler: '#f5c542', capsule: '#7dd3fc' };
  stack.forEach(p => {
    const def = PARTS[p.partId];
    if (!def) return;
    const i = document.createElement('i');
    i.style.background = COLORS[def.type] || '#889';
    i.style.width = Math.round(def.w / 56 * 20) + 'px';
    i.style.height = Math.max(2, Math.round(def.h / 120 * 16)) + 'px';
    wrap.appendChild(i);
  });
  return wrap;
}

window.addEventListener('resize', draw);
load();
draw();


// 对外接口
window.HOME = {
  show() {
    document.getElementById('homeScreen').hidden = false;
    document.getElementById('buildScreen').hidden = true;
    document.getElementById('flyScreen').hidden = true;
    draw();
  },
  hide() { document.getElementById('homeScreen').hidden = true; },
  redraw: draw,
  refreshFleet: renderFleet,
  highlightVab(on) {
    const el = document.getElementById('hsVab');
    el.classList.toggle('peer-here', !!on);
  },
};
})();
