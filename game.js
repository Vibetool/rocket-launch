const $ = id => document.getElementById(id);
let loadedShipName = null;

function toastShip(msg) {
  const el = document.createElement('div');
  el.className = 'ship-toast';
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 400); }, 2600);
}

// ---------- 状态 ----------
const state = {
  mode: 'build',        // build | fly | result
  stack: [],            // 自下而上的零件 [{partId, fuel}]
  stages: [],           // 飞行中的段
  active: 0,            // 当前受控段索引
  t: 0,
  maxAlt: 0,
  camY: 0,
  particles: [],
  sprites: {},
  spritesReady: false,
  result: null,
};

// ---------- 素材加载（有图用图，没图用矢量兜底） ----------
const SPRITE_NAMES = ['engine_small','engine_medium','engine_large',
                      'fuel_small','fuel_medium','fuel_large','decoupler','capsule','launchpad'];
function loadSprites() {
  let pending = SPRITE_NAMES.length;
  if (!pending) { state.spritesReady = true; return; }
  SPRITE_NAMES.forEach(n => {
    const img = new Image();
    img.onload = () => { state.sprites[n] = img; if (--pending === 0) state.spritesReady = true; };
    img.onerror = () => { if (--pending === 0) state.spritesReady = true; };
    img.src = `assets/${n}.png`;
  });
}

// ---------- 装配 ----------
function stackHeight() { return state.stack.reduce((s,p)=>s+PARTS[p.partId].h, 0); }
function stackMass() {
  return state.stack.reduce((s,p)=>s+PARTS[p.partId].mass + (p.fuel||0)*FUEL_MASS_PER_UNIT, 0);
}
function stackThrust() {
  return state.stack.filter(p=>PARTS[p.partId].type==='engine')
                    .reduce((s,p)=>s+PARTS[p.partId].thrust, 0);
}
function stackBurn() {
  return state.stack.filter(p=>PARTS[p.partId].type==='engine')
                    .reduce((s,p)=>s+PARTS[p.partId].burn, 0);
}
function stackFuel() { return state.stack.reduce((s,p)=>s+(p.fuel||0), 0); }

function addPart(partId) {
  const def = PARTS[partId];
  state.stack.push({ partId, fuel: def.type === 'fuel' ? def.capacity : 0 });
  renderBuild();
  afterAddPart();
}
function removeAt(i) { state.stack.splice(i,1); renderBuild(); afterAddPart(); }
function moveAt(i, dir) {
  const j = i + dir;
  if (j < 0 || j >= state.stack.length) return;
  [state.stack[i], state.stack[j]] = [state.stack[j], state.stack[i]];
  renderBuild();
}

function renderBuild() {
  // 零件面板
  const pal = $('palette');
  if (!pal.dataset.filled) {
    pal.innerHTML = '';
    ['capsule','engine','fuel','decoupler'].forEach(cat => {
      const items = PART_LIST.filter(p => p.type === cat);
      const g = document.createElement('div'); g.className = 'pal-group';
      g.innerHTML = `<div class="pal-title">${
          cat==='engine'?'引擎':cat==='fuel'?'燃料箱':cat==='capsule'?'返回舱':'分离器'}</div>`;
      items.forEach(p => {
        const b = document.createElement('button');
        b.className = 'pal-item';
        const spec = p.type==='engine' ? `推力 ${p.thrust} · 耗 ${p.burn}/s`
                   : p.type==='fuel'   ? `容量 ${p.capacity}`
                   : p.type==='capsule'? `载人舱 · 重 ${p.mass}`
                   : `分离推力 ${p.separationImpulse}`;
        b.innerHTML = `<span class="pi-thumb" data-s="${p.sprite}"></span>
                       <span class="pi-txt"><b>${p.name}</b><i>${spec}</i></span>`;
        b.onclick = () => addPart(p.id);
        g.appendChild(b);
      });
      pal.appendChild(g);
    });
    pal.dataset.filled = '1';
    paintThumbs();
  }

  // 已装配列表（显示时自上而下，数据是自下而上）
  const list = $('stackList');
  list.innerHTML = '';
  if (!state.stack.length) {
    list.innerHTML = '<div class="empty">从左侧选零件开始搭建<br><small>列表底部 = 火箭底部</small></div>';
  }
  [...state.stack].reverse().forEach((p, ri) => {
    const i = state.stack.length - 1 - ri;
    const def = PARTS[p.partId];
    const row = document.createElement('div');
    row.className = 'stack-row t-' + def.type;
    row.innerHTML = `
      <span class="sr-n">${i+1}</span>
      <span class="sr-name">${def.name}</span>
      <span class="sr-spec">${def.type==='engine' ? `${def.thrust}推 / ${def.burn}耗`
                            : def.type==='fuel' ? `${p.fuel} 燃料`
                            : def.type==='capsule' ? '载人' : '分离'}</span>
      <span class="sr-btns">
        <button title="上移">▲</button><button title="下移">▼</button><button title="删除">✕</button>
      </span>`;
    const [up, dn, del] = row.querySelectorAll('button');
    up.onclick = () => moveAt(i, +1);
    dn.onclick = () => moveAt(i, -1);
    del.onclick = () => removeAt(i);
    list.appendChild(row);
  });

  // 统计：起飞看的是「第一级推力 ÷ 全箭质量」，上面级此刻还是死重
  const m = stackMass();
  const groups = splitByDecouplers(state.stack);
  const s1 = groups[0] || [];
  const s1Thrust = s1.filter(p => PARTS[p.partId].type === 'engine')
                     .reduce((s, p) => s + PARTS[p.partId].thrust, 0);
  const s1Burn = s1.filter(p => PARTS[p.partId].type === 'engine')
                   .reduce((s, p) => s + PARTS[p.partId].burn, 0);
  const s1Fuel = s1.reduce((s, p) => s + (p.fuel || 0), 0);
  const twr = m > 0 ? (s1Thrust * THRUST_SCALE) / (m * 9.8) : 0;
  const burnTime = s1Burn > 0 ? s1Fuel / s1Burn : 0;
  $('statMass').textContent = m.toFixed(1);
  $('statThrust').textContent = s1Thrust + (groups.length > 1 ? ` (共${stackThrust()})` : '');
  $('statTWR').textContent = twr.toFixed(2);
  $('statBurn').textContent = burnTime.toFixed(1) + 's';
  const twrEl = $('statTWR');
  twrEl.className = twr >= 1.3 ? 'good' : twr >= 1.05 ? 'warn' : 'bad';
  $('twrHint').textContent =
      s1Thrust === 0 ? '第一级没有引擎 —— 火箭底部需要装引擎'
    : s1Fuel === 0   ? '第一级没有燃料'
    : twr < 1.05     ? '起飞推重比过低，火箭抬不起来（需要 > 1）'
    : twr < 1.3      ? '推重比偏低，上升会很慢、很费油'
    : `起飞推重比良好 · 第一级可烧 ${burnTime.toFixed(0)} 秒`;
  $('btnLaunch').disabled = !(s1Thrust > 0 && s1Fuel > 0 && twr >= 1.05);
  drawPreview();
  afterAddPart();
  // 联机：本地改动的设计要同步给对方（收到对方设计时不回传）
  if (coopOn() && !COOP.applyingRemote) netSendShip(state.stack);
  if (coopOn()) updateCoopGate();
}

function paintThumbs() {
  document.querySelectorAll('.pi-thumb').forEach(el => {
    const name = el.dataset.s;
    const img = state.sprites[name];
    if (img) { el.style.backgroundImage = `url(${img.src})`; }
    else { el.classList.add('fallback', 'fb-' + name.split('_')[0]); }
  });
}

// launchpad.png 实测几何（1536x1024，天空已洗成透明）
const PAD_W = 1536, PAD_H = 1024;
const PAD_DECK_Y = 783;        // 混凝土甲板上表面 —— 火箭底部对齐这里
const PAD_EDGE_GRASS_Y = 904;  // 图片左右边缘处的草地顶边
const PAD_GRASS_COLOR = '#6e863f';  // 取自贴图草地基色，接缝才看不出来

// ---------- 预览画布 ----------
const pv = $('preview'), pvx = pv.getContext('2d');
function drawPreview() {
  // 画布隐藏时宽高为 0，继续画会得到负数尺寸（canvas arc 会直接抛错）
  if (pv.clientWidth <= 0 || pv.clientHeight <= 40) return;
  const W = pv.width = pv.clientWidth * devicePixelRatio;
  const H = pv.height = pv.clientHeight * devicePixelRatio;
  pvx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
  const w = pv.clientWidth, h = pv.clientHeight;
  pvx.clearRect(0,0,w,h);
  if (!state.stack.length) return;
  const total = stackHeight();
  const scale = Math.min(1, (h - 40) / total);
  const cx = w/2;
  let y = h - 20;
  state.stack.forEach(p => {
    const def = PARTS[p.partId];
    const ph = def.h * scale, pw = def.w * scale;
    drawPart(pvx, def, cx - pw/2, y - ph, pw, ph);
    y -= ph;
  });
}

// 画单个零件（有贴图用贴图，否则矢量兜底）
function drawPart(ctx, def, x, y, w, h) {
  if (!(w > 0) || !(h > 0)) return;
  const img = state.sprites[def.sprite];
  if (img) { ctx.drawImage(img, x, y, w, h); return; }
  ctx.save();
  ctx.lineWidth = Math.max(1.5, w*0.05);
  ctx.strokeStyle = '#16233a';
  if (def.type === 'fuel') {
    ctx.fillStyle = '#f2f5fa';
    ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#2b3f5c';
    ctx.fillRect(x, y + h - h*0.12, w, h*0.12);
  } else if (def.type === 'engine') {
    ctx.fillStyle = '#9aa7bb';
    const bodyH = h * 0.55;
    ctx.fillRect(x, y, w, bodyH); ctx.strokeRect(x, y, w, bodyH);
    // 梯形喷口
    ctx.beginPath();
    ctx.moveTo(x + w*0.12, y + bodyH);
    ctx.lineTo(x + w*0.88, y + bodyH);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.closePath();
    ctx.fillStyle = '#5d6b80'; ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#ff8a3d';
    ctx.fillRect(x + w*0.1, y + bodyH*0.3, w*0.8, bodyH*0.18);
  } else if (def.type === 'capsule') {
    // 截头圆锥：上窄下宽
    ctx.beginPath();
    ctx.moveTo(x + w*0.28, y);
    ctx.lineTo(x + w*0.72, y);
    ctx.lineTo(x + w, y + h*0.86);
    ctx.lineTo(x, y + h*0.86);
    ctx.closePath();
    ctx.fillStyle = '#e8edf5'; ctx.fill(); ctx.stroke();
    ctx.fillStyle = '#2b3f5c';
    ctx.fillRect(x, y + h*0.86, w, h*0.14);          // 隔热底
    ctx.fillStyle = '#7c8aa0';
    ctx.beginPath(); ctx.arc(x + w*0.5, y + h*0.45, w*0.1, 0, 7); ctx.fill();
  } else {
    ctx.fillStyle = '#f5c542';
    ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#16233a';
    for (let i = 0; i < 6; i++) ctx.fillRect(x + w*(0.08+i*0.15), y + h*0.3, w*0.06, h*0.4);
  }
  ctx.restore();
}

// ---------- 发射 ----------
function launch() {
  const groups = splitByDecouplers(state.stack.map(p => ({...p})));
  // 全部段初始叠在一起，从下往上排（第一段在最下）
  state.stages = groups.map(g => new Stage(g, 0, 0));
  state.active = 0;
  state.t = 0; state.maxAlt = 0; state.particles = []; state.result = null;
  state.camY = 0;   // 相机必须归零，否则再次发射时天空还停在上一局的高度
  state.phase = 'ascent';   // ascent → transfer → moon_choice → moon_landing
  state.world = 'earth';
  setWorld('earth');
  state.lastImpact = 0;
  $('moonHud').hidden = true;
  $('earthHud').hidden = false;
  $('fuelWrap').hidden = false;
  $('btnSep').hidden = false;
  $('btnBurn').hidden = true;
  $('rAlt').nextElementSibling.textContent = '最高高度';
  state.boost = 1;          // 彩蛋推力倍率，单局有效
  state.stages.forEach(st => { st.thrustMul = 1; });
  // 只有最底段点火（其余作为上面级，随下段一起被"背着"）
  state.mode = 'fly';
  last = 0; acc = 0;
  $('boostBadge').hidden = true;
  $('buildScreen').hidden = true;
  $('flyScreen').hidden = false;
  requestAnimationFrame(loop);
}

// 一个零件高度单位对应多少米（保持物理与渲染比例一致：sc / PX）
const PART_UNIT_M = 0.55 / 0.35;
function stageHeightM(st) {
  return st.parts.reduce((s, p) => s + PARTS[p.partId].h, 0) * PART_UNIT_M;
}

function separate(auto) {
  if (state.active >= state.stages.length - 1) return;
  if (coopOn() && !auto && state.phase === 'ascent') return;   // 联机不允许手动分级
  const cur = state.stages[state.active];
  const nxt = state.stages[state.active + 1];
  // 上面级从下面级顶端脱离，继承速度并获得分离推力
  nxt.x = cur.x; nxt.y = cur.y + stageHeightM(cur);
  nxt.vx = cur.vx; nxt.vy = cur.vy + 6;   // 分离小推力
  cur.vy -= 2;                             // 反冲
  cur.separated = true;
  state.active++;
  for (let i=0;i<18;i++) state.particles.push({
    x: cur.x, y: cur.y, vx:(Math.random()-.5)*40, vy:(Math.random()-.5)*40,
    life: .6, sep: true });
}

// ---------- 飞行主循环 ----------
const cv = $('sky'), cx = cv.getContext('2d');
let last = 0, acc = 0;
const FIXED_DT = 1 / 60;
function loop(ts) {
  if (state.mode !== 'fly') return;
  // 切后台回来时 rAF 会攒出巨大间隔，钳一下避免物理炸开
  const raw = last ? (ts - last) / 1000 : FIXED_DT;
  last = ts;
  acc += Math.min(0.25, raw);
  let steps = 0;
  while (acc >= FIXED_DT && steps < 8) { update(FIXED_DT); acc -= FIXED_DT; steps++; }
  render();
  requestAnimationFrame(loop);
}

function update(dt) {
  state.t += dt;
  const act = state.stages[state.active];

  // 触地瞬间 stepStage 会把 vy 清零，先留一份用于月面着陆判定
  if (act && !act.landed) state.lastImpact = Math.abs(act.vy);

  // 活动段推着上面所有未分离的级：它们的质量计入加速度，位置随动
  if (act && !act.landed) {
    const upper = state.stages.slice(state.active + 1);
    const carried = upper.reduce((s, st) => s + st.mass, 0);
    stepStage(act, dt, carried);
    // 未分离的上面级坐在下面级顶端，逐级往上累加高度
    let off = stageHeightM(act);
    upper.forEach(st => {
      st.x = act.x; st.y = act.y + off; st.vx = act.vx; st.vy = act.vy;
      off += stageHeightM(st);
    });
  }

  // 已分离的下面级自由落体
  state.stages.forEach((st, i) => {
    if (i < state.active) stepStage(st, dt);
  });

  if (act) state.maxAlt = Math.max(state.maxAlt, act.y);

  // 尾焰粒子
  if (act && act.thrusting && !act.landed) {
    for (let i=0;i<3;i++) state.particles.push({
      x: act.x + (Math.random()-.5)*10, y: act.y - 4,
      vx: (Math.random()-.5)*12, vy: -20 - Math.random()*30, life: .5 });
  }
  coopAutoStage(dt);
  state.particles.forEach(p => { p.x += p.vx*dt; p.y += p.vy*dt; p.life -= dt; });
  state.particles = state.particles.filter(p => p.life > 0);

  // 相机跟随
  if (act) state.camY += (act.y - state.camY) * Math.min(1, dt*3);

  // 阶段判定
  if (act) {
    if (state.phase === 'moon_landing') {
      if (act.landed) {
        const impact = state.lastImpact || 0;
        moonResult(impact <= MOON_SAFE_SPEED, impact);
      }
    } else if (state.phase === 'transfer') {
      // 继续飞行段：再爬 2 km 抵达月球；燃尽掉回去则任务失败
      if (act.y >= MOON_TRIGGER_ALT) reachMoon();
      else if (act.landed && state.t > 1) finish(false);
    } else {
      if (act.y >= SPACE_LINE) finish(true);
      else if (act.landed && state.t > 1) finish(false);
    }
  }
  updateHUD();
}

function updateHUD() {
  const act = state.stages[state.active];
  if (!act) return;
  if (state.phase === 'moon_landing') {
    const v = act.vy;
    $('mAlt').textContent = act.y.toFixed(0) + ' m';
    $('mVel').textContent = Math.abs(v).toFixed(1) + ' m/s';
    $('mVel').className = Math.abs(v) <= MOON_SAFE_SPEED ? 'safe' : 'danger';
    $('mFuel').textContent = act.totalFuel.toFixed(0);
  }
  $('hAlt').textContent = (act.y/1000).toFixed(2) + ' km';
  $('hVel').textContent = act.vy.toFixed(0) + ' m/s';
  $('hFuel').textContent = act.totalFuel.toFixed(0);
  const maxF = act.parts.reduce((s,p)=>s + (PARTS[p.partId].capacity||0), 0);
  $('fuelBar').style.width = (maxF ? act.totalFuel/maxF*100 : 0) + '%';
  $('hStage').textContent = `第 ${state.active+1} 级 / 共 ${state.stages.length}`;
  const hasNext = state.active < state.stages.length - 1;
  $('btnSep').disabled = !hasNext;
  // 本级烧干且还有上面级 —— 必须分离，否则死重拖着一起掉下去
  const dry = act.totalFuel <= 0.01;
  $('btnSep').classList.toggle('urgent', dry && hasNext);
  $('sepHint').hidden = !(dry && hasNext);
}

function finish(win) {
  state.mode = 'result';
  state.result = { win, alt: state.maxAlt, t: state.t };
  // 抵达卡门线 → 登记进机库（雷达站列表读的就是这里）
  if (win && typeof fleetRecord === 'function') {
    try { fleetRecord(state.stack, state.maxAlt, state.t); } catch (e) {}
  }
  $('rTitle').textContent = win ? '🚀 成功进入太空！' : '💥 任务失败';
  $('rTitle').className = win ? 'win' : 'lose';
  $('rAlt').textContent = (state.maxAlt/1000).toFixed(2) + ' km';
  $('rTime').textContent = state.t.toFixed(1) + ' s';
  $('rNote').textContent = win ? '你的火箭越过了 100 km 卡门线，正式抵达太空。'
    : state.maxAlt < 1000 ? '几乎没飞起来 —— 试试加大引擎或减少死重。'
    : '燃料耗尽后掉回地面。试试用分离器抛掉空燃料箱减重。';
  // 只有在地球段成功入轨才给「继续飞行」——去月球的入口
  const canContinue = win && state.phase === 'ascent';
  $('btnContinue').hidden = !canContinue;
  if (canContinue) {
    $('rNote').textContent = '你的火箭越过了 100 km 卡门线。燃料还有剩，要继续往上飞吗？';
  }
  $('resultBox').hidden = false;
}

// ---------- 继续飞行：保住动能，接着往上 ----------
// 关键：不重置任何速度/位置，从暂停的那一刻原样继续
function continueFlight() {
  $('resultBox').hidden = true;
  $('btnContinue').hidden = true;
  state.phase = 'transfer';
  state.mode = 'fly';
  last = 0; acc = 0;              // 只重置计时基准，动能原样保留
  requestAnimationFrame(loop);
}

// ---------- 抵达月球 ----------
function reachMoon() {
  state.mode = 'result';
  state.phase = 'moon_choice';
  state.boost = 1;                       // 超频 buff 到月球即失效
  state.stages.forEach(x => { x.thrustMul = 1; });
  $('boostBadge').hidden = true;
  showAchievement('🌕 阿波罗计划', '飞越卡门线后再上升 5 公里，抵达月球');
  $('moonBox').hidden = false;
}

// 剩余飞船「满油量」的 30%——按各燃料箱自身容量的 30% 分配，
// 不是把当前余油砍到 30%
function setMoonFuel() {
  const st = state.stages[state.active];
  st.parts.forEach(p => {
    const def = PARTS[p.partId];
    if (def && def.type === 'fuel') p.fuel = def.capacity * 0.30;
  });
  return st.totalFuel;
}

function startMoonLanding() {
  $('moonBox').hidden = true;
  const st = state.stages[state.active];
  // 发射台超频只作用于地球段，登月后失效
  state.boost = 1;
  state.stages.forEach(x => { x.thrustMul = 1; });
  $('boostBadge').hidden = true;
  // 只保留仍在飞的那一段，其余抛掉
  state.stages = [st];
  state.active = 0;
  const fuel = setMoonFuel();

  setWorld('moon');
  state.phase = 'moon_landing';
  state.world = 'moon';
  st.y = MOON_START_ALT;          // 1 公里高度开始
  // 惯性保留但方向翻转：上升的动能变成朝月面下坠的力。
  // 原速约 1950 m/s，直接翻转需要 20+ km 刹车距离（只有 1km）必然撞毁，
  // 所以按本着陆器"1km 内能刹停的极限速度"的 55% 封顶，保证有解又有压力。
  const aNet = st.maxThrust * THRUST_SCALE / st.mass - gravityAt(0);
  const vLimit = Math.sqrt(2 * Math.max(1, aNet) * MOON_START_ALT) * 0.55;
  st.vy = -Math.min(Math.abs(st.vy), vLimit);
  st.vx = 0; st.x = 0;
  st.landed = false; st.crashed = false;
  st.throttle = 0;                // 月面降落改为手动控制油门
  state.camY = MOON_START_ALT;
  state.maxAlt = MOON_START_ALT;
  state.t = 0;
  state.particles = [];
  state.mode = 'fly';
  last = 0; acc = 0;

  $('moonHud').hidden = false;
  $('earthHud').hidden = true;      // 两套 HUD 不能同时显示，否则文字重叠
  $('fuelWrap').hidden = true;
  $('btnSep').hidden = true;
  $('btnBurn').hidden = false;
  toastShip(`月面进近 · 燃料 ${fuel.toFixed(0)}（满载的 30%）`);
  requestAnimationFrame(loop);
}

function moonResult(ok, impact) {
  state.mode = 'result';
  state.phase = 'moon_done';
  $('rTitle').textContent = ok ? '🌕 月面着陆成功！' : '💥 着陆失败';
  $('rTitle').className = ok ? 'win' : 'lose';
  $('rAlt').textContent = impact.toFixed(1) + ' m/s';
  $('rAlt').nextElementSibling.textContent = '触地速度';
  $('rTime').textContent = state.t.toFixed(1) + ' s';
  $('rNote').textContent = ok
    ? `以 ${impact.toFixed(1)} m/s 平稳接地，阿波罗计划圆满完成。`
    : `触地速度 ${impact.toFixed(1)} m/s，超过 ${MOON_SAFE_SPEED} m/s 安全上限，着陆器损毁。`;
  $('btnContinue').hidden = true;
  $('resultBox').hidden = false;
}

// 右上角成就弹出
function showAchievement(title, desc) {
  const el = document.createElement('div');
  el.className = 'achv';
  el.innerHTML = `<b>${title}</b><i>${desc}</i>`;
  document.body.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 500); }, 4200);
}

// ---------- 渲染 ----------
function render() {
  const w = cv.width = cv.clientWidth * devicePixelRatio;
  const h = cv.height = cv.clientHeight * devicePixelRatio;
  cx.setTransform(devicePixelRatio,0,0,devicePixelRatio,0,0);
  const W = cv.clientWidth, H = cv.clientHeight;

  if (state.phase === 'moon_landing') { renderMoon(W, H); return; }

  // 天空随高度变深
  const alt = state.camY;
  const f = Math.min(1, alt / ATMO_TOP);
  const g = cx.createLinearGradient(0,0,0,H);
  g.addColorStop(0, mix('#6fb7ef','#01030c', Math.min(1,f*1.3)));
  g.addColorStop(1, mix('#cfe8fb','#0a1224', Math.min(1,f*1.1)));
  cx.fillStyle = g; cx.fillRect(0,0,W,H);

  // 星星
  if (f > 0.35) {
    cx.fillStyle = `rgba(255,255,255,${(f-0.35)/0.65})`;
    for (let i=0;i<70;i++) {
      const sx = (i*7919 % 1000)/1000*W;
      const sy = ((i*104729 % 1000)/1000*H + (alt*0.02)%H) % H;
      cx.fillRect(sx, sy, 1.6, 1.6);
    }
  }

  const PX = 0.35;                 // 米 → 像素
  const groundY = H*0.78 + state.camY*PX;
  const cxs = W/2;

  // 发射场。PAD_* 是 launchpad.png 的实测几何（见文件顶部常量）：
  // 甲板面对齐 groundY（火箭站立高度），草坪按贴图边缘高度铺满整屏，两侧不留空。
  const pad = state.sprites.launchpad;
  state.padRect = null;
  if (groundY > -200) {
    if (pad) {
      const pw = Math.max(380, Math.min(W * 0.55, 560));
      const s = pw / PAD_W;
      const grassY = groundY + (PAD_EDGE_GRASS_Y - PAD_DECK_Y) * s;
      cx.fillStyle = PAD_GRASS_COLOR;
      if (grassY < H) cx.fillRect(0, grassY, W, H - grassY);
      cx.drawImage(pad, cxs - pw/2, groundY - PAD_DECK_Y * s, pw, PAD_H * s);
      // 记下本帧贴图位置，双击彩蛋据此把屏幕坐标换算回贴图坐标
      state.padRect = { x: cxs - pw / 2, y: groundY - PAD_DECK_Y * s, s };
    } else {
      cx.fillStyle = '#4a8f42';
      cx.beginPath(); cx.moveTo(0, groundY+60);
      cx.quadraticCurveTo(W*0.3, groundY-18, W*0.5, groundY);
      cx.quadraticCurveTo(W*0.72, groundY+16, W, groundY+50);
      cx.lineTo(W, H); cx.lineTo(0,H); cx.fill();
      cx.fillStyle = '#3a4657'; cx.fillRect(cxs-70, groundY-10, 140, 12);
      cx.fillStyle = '#8794a8';
      cx.fillRect(cxs-92, groundY-92, 9, 84); cx.fillRect(cxs-78, groundY-104, 7, 96);
    }
  }

  // 粒子
  state.particles.forEach(p => {
    const py = groundY - p.y*PX;
    cx.globalAlpha = Math.max(0, p.life*1.6);
    const pal = flamePalette();
    cx.fillStyle = p.sep ? pal.spark : (p.life > 0.3 ? pal.hot : pal.cool);
    cx.fillRect(cxs + p.x*PX - 2, py, 4, 4);
  });
  cx.globalAlpha = 1;

  // 各段火箭
  state.stages.forEach((st, i) => {
    if (i < state.active && st.landed) return;
    const baseY = groundY - st.y*PX;
    let y = baseY;
    const sc = 0.55;
    st.parts.forEach(p => {
      const def = PARTS[p.partId];
      const ph = def.h*sc, pw = def.w*sc;
      drawPart(cx, def, cxs + st.x*PX - pw/2, y - ph, pw, ph);
      y -= ph;
    });
  });

  // 高度标尺
  cx.fillStyle = 'rgba(255,255,255,.75)'; cx.font = '11px system-ui';
  for (let km=0; km<=100; km+=10) {
    const yy = groundY - km*1000*PX;
    if (yy < -20 || yy > H+20) continue;
    cx.fillRect(W-46, yy, 12, 1);
    cx.fillText(km+'km', W-34, yy+4);
  }
}

function mix(a,b,t){
  const p=c=>[parseInt(c.slice(1,3),16),parseInt(c.slice(3,5),16),parseInt(c.slice(5,7),16)];
  const [r1,g1,b1]=p(a),[r2,g2,b2]=p(b);
  return `rgb(${r1+(r2-r1)*t|0},${g1+(g2-g1)*t|0},${b1+(b2-b1)*t|0})`;
}

// ---------- 彩蛋：局内双击发射台，本局推力 +40% ----------
// 热区用 launchpad.png 的实测像素坐标划定：只有混凝土平台和两座塔架算数，
// 下方草地山体不算（用户明确要求）。
const PAD_HIT_ZONES = [
  { x0: 271, y0: 781, x1: 1223, y1: 858, name: '平台' },  // 甲板到草地线
  { x0: 322, y0: 190, x1: 376, y1: 790, name: '矮塔' },
  { x0: 421, y0: 140, x1: 475, y1: 790, name: '高塔' },
];
const BOOST_MUL = 1.4;

// 登月：越过卡门线后再爬升 2 km 即抵达月球
const MOON_TRIGGER_ALT = SPACE_LINE + 5000;   // 越过卡门线后还要再爬 5 km
const MOON_START_ALT = 1000;     // 从 1 km 高度开始降落
const MOON_SAFE_SPEED = 16;      // 触地速度上限（月面无大气，全靠反推）

// 火焰配色：常态黄→橙；推力加成生效时整条尾焰变蓝→紫
const FLAME = {
  normal: { hot: '#ffd166', cool: '#ff6b35', spark: '#ffd76e' },
  boost:  { hot: '#b8e4ff', cool: '#cbb0fb', spark: '#e2d6ff' },   // 淡蓝→淡紫
};
function flamePalette() { return state.boost > 1 ? FLAME.boost : FLAME.normal; }

// 屏幕坐标 → 贴图坐标，再看是否落在热区内
function hitLaunchPad(mx, my) {
  const r = state.padRect;
  if (!r) return false;
  const ix = (mx - r.x) / r.s;
  const iy = (my - r.y) / r.s;
  return PAD_HIT_ZONES.some(z => ix >= z.x0 && ix <= z.x1 && iy >= z.y0 && iy <= z.y1);
}

function tryBoost(mx, my) {
  if (state.mode !== 'fly') return;
  if (!hitLaunchPad(mx, my)) return;          // 点在山体或别处 —— 无效
  if (state.boost > 1) { toastShip('推力加成已在生效中'); return; }
  state.boost = BOOST_MUL;
  state.stages.forEach(st => { st.thrustMul = BOOST_MUL; });
  $('boostBadge').hidden = false;
  toastShip('🔥 发射台超频！本局推力 +40%');
  // 平台喷一圈火花
  const r = state.padRect;
  for (let i = 0; i < 26; i++) {
    state.particles.push({
      x: (Math.random() - 0.5) * 60, y: Math.random() * 6,
      vx: (Math.random() - 0.5) * 90, vy: 20 + Math.random() * 70,
      life: 0.9, sep: true,
    });
  }
}

function canvasPoint(e) {
  const b = cv.getBoundingClientRect();
  const t = e.changedTouches ? e.changedTouches[0] : e;
  return [t.clientX - b.left, t.clientY - b.top];
}

cv.addEventListener('dblclick', e => {
  const [x, y] = canvasPoint(e);
  tryBoost(x, y);
});

// 触屏没有 dblclick：自己判定 350ms 内两次靠近的轻点
let lastTap = 0, lastTapX = 0, lastTapY = 0;
cv.addEventListener('touchend', e => {
  const [x, y] = canvasPoint(e);
  const now = Date.now();
  if (now - lastTap < 350 && Math.hypot(x - lastTapX, y - lastTapY) < 32) {
    tryBoost(x, y);
    lastTap = 0;
  } else {
    lastTap = now; lastTapX = x; lastTapY = y;
  }
}, { passive: true });

// ---------- 月面渲染 ----------
function renderMoon(W, H) {
  // 月球没有大气，天空全黑
  cx.fillStyle = '#05060b';
  cx.fillRect(0, 0, W, H);
  cx.fillStyle = 'rgba(255,255,255,.85)';
  for (let i = 0; i < 90; i++) {
    const sx = (i * 7919 % 1000) / 1000 * W;
    const sy = (i * 104729 % 1000) / 1000 * H;
    cx.fillRect(sx, sy, i % 7 === 0 ? 2 : 1.4, i % 7 === 0 ? 2 : 1.4);
  }
  // 远处的地球
  const eb = Math.min(W, H) * 0.075;
  cx.beginPath(); cx.arc(W * 0.82, H * 0.16, eb, 0, 7);
  cx.fillStyle = '#3d7fc4'; cx.fill();
  cx.beginPath(); cx.arc(W * 0.82 - eb * 0.25, H * 0.16 - eb * 0.2, eb * 0.42, 0, 7);
  cx.fillStyle = '#4e9a4a'; cx.fill();

  const PXM = 0.45;                                  // 月面段米→像素
  const st = state.stages[state.active];
  const groundY = H * 0.80 + state.camY * PXM;

  // 月壤
  if (groundY < H + 60) {
    cx.fillStyle = '#8d8b86';
    cx.beginPath();
    cx.moveTo(0, groundY + 14);
    cx.quadraticCurveTo(W * 0.22, groundY - 8, W * 0.44, groundY + 2);
    cx.quadraticCurveTo(W * 0.68, groundY + 12, W, groundY - 4);
    cx.lineTo(W, H); cx.lineTo(0, H); cx.closePath(); cx.fill();
    // 环形坑
    cx.fillStyle = '#7b7974';
    [[0.15, 34], [0.63, 26], [0.86, 20]].forEach(([xr, r]) => {
      cx.beginPath(); cx.ellipse(W * xr, groundY + 20, r, r * 0.34, 0, 0, 7); cx.fill();
    });
    // 着陆区标记
    cx.strokeStyle = 'rgba(120,255,190,.55)'; cx.lineWidth = 2;
    cx.setLineDash([7, 6]);
    cx.beginPath(); cx.moveTo(W / 2 - 46, groundY + 3); cx.lineTo(W / 2 + 46, groundY + 3); cx.stroke();
    cx.setLineDash([]);
  }

  // 尾焰粒子
  state.particles.forEach(p => {
    cx.globalAlpha = Math.max(0, p.life * 1.6);
    const pal = flamePalette();
    cx.fillStyle = p.life > 0.3 ? pal.hot : pal.cool;
    cx.fillRect(W / 2 + p.x * PXM - 2, groundY - p.y * PXM, 4, 4);
  });
  cx.globalAlpha = 1;

  // 着陆器
  if (st) {
    let y = groundY - st.y * PXM;
    const sc = 0.55;
    st.parts.forEach(p => {
      const def = PARTS[p.partId];
      const ph = def.h * sc, pw = def.w * sc;
      drawPart(cx, def, W / 2 - pw / 2, y - ph, pw, ph);
      y -= ph;
    });
  }
}

// ================= 联机（双人共操一枚火箭） =================
// 规则：两人都进车间才能动工；两人都按发射才点火；联机模式自动分级。
const COOP = { autoSepTimer: null, applyingRemote: false };

function coopOn() { return typeof NET !== 'undefined' && NET.active && NET.connected; }

// 进入制造车间（单人直接进；联机要等两人都进）
function enterBuilding(withShip) {
  if (withShip) loadPendingShip();
  window.HOME.hide();
  $('buildScreen').hidden = false;
  $('flyScreen').hidden = true;
  state.mode = 'build';
  if (coopOn()) { netSetBuilding(true); netSendShip(state.stack); }
  renderBuild();
  syncPanes();
  updateCoopGate();
  syncCoopBtn();
}

function backToHome() {
  if (coopOn()) { netSetBuilding(false); netSetLaunchReady(false); }
  $('buildScreen').hidden = true;
  $('flyScreen').hidden = true;
  window.HOME.show();
  updateCoopGate();
  syncCoopBtn();
}

// 门禁：对方没进车间时，本方什么都不能操作
function updateCoopGate() {
  const gate = $('coopGate');
  if (!coopOn()) { if (gate) gate.hidden = true; $('buildScreen').classList.remove('locked'); return; }
  const waiting = NET.meInBuilding && !NET.peerInBuilding;
  $('buildScreen').classList.toggle('locked', waiting);
  if (gate) {
    gate.hidden = !waiting;
    gate.textContent = `⏳ 等待 ${NET.peerName || '对方'} 进入火箭制造大楼…`;
  }
  // 发射按钮：本方已就绪但对方没按 → 常态；对方按了本方没按 → 高亮
  const b = $('btnLaunch');
  b.classList.toggle('await-peer', NET.peerLaunchReady && !NET.meLaunchReady);
  b.textContent = NET.meLaunchReady
    ? (NET.peerLaunchReady ? '🚀 发射' : '✅ 已就绪 · 等待对方')
    : (NET.peerLaunchReady ? '🚀 对方已就绪 · 点击发射' : '🚀 发射');
}

// 联机下点发射 = 举手，两人都举手才真发射
function requestLaunch() {
  if (!coopOn()) { launch(); return; }
  if (NET.meInBuilding && !NET.peerInBuilding) return;   // 对方没进楼，禁止操作
  netSetLaunchReady(true);
  updateCoopGate();
  if (netBothLaunchReady()) { netSend({ t: 'launch' }); doCoopLaunch(); }
}

function doCoopLaunch() {
  NET.meLaunchReady = false; NET.peerLaunchReady = false;
  launch();
}

// 联机模式：燃料耗尽 1 秒后自动分离（不能手动）
function coopAutoStage(dt) {
  if (!coopOn() || state.phase !== 'ascent') return;
  const act = state.stages[state.active];
  if (!act || state.active >= state.stages.length - 1) return;
  if (act.totalFuel <= 0.01) {
    COOP.autoSepTimer = (COOP.autoSepTimer || 0) + dt;
    if (COOP.autoSepTimer >= 1.0) { separate(true); COOP.autoSepTimer = 0; }
  } else {
    COOP.autoSepTimer = 0;
  }
}

// 联机事件总线
function bindCoopEvents() {
  if (typeof NET === 'undefined') return;
  NET.onEvent = (type, data) => {
    switch (type) {
      case 'connected':
        $('coopBar').hidden = false;
        $('cbDot').classList.remove('off');
        $('cbText').textContent = `已连接 · ${NET.peerName || '对方'}`;
        $('coopModal').hidden = true;
        $('btnTalk').disabled = !netHasMic();
        toastShip(`已与 ${NET.peerName || '对方'} 连接`);
        break;
      case 'disconnected':
        $('cbDot').classList.add('off');
        $('cbText').textContent = '连接中断';
        break;
      case 'peerJoined':
        $('coopStatus').textContent = `${data || '对方'} 已加入，正在建立连接…`;
        NET.peerName = data || NET.peerName;
        break;
      case 'building':
        window.HOME.highlightVab(!!data);     // 对方进楼 → 本方主页高亮制造楼
        updateCoopGate();
        break;
      case 'launchReady':
        updateCoopGate();
        if (data) toastShip(`${NET.peerName || '对方'} 已按下发射，等你确认`);
        break;
      case 'launch':
        doCoopLaunch();
        break;
      case 'ship':
        if (Array.isArray(data) && state.mode === 'build') {
          COOP.applyingRemote = true;          // 防止回传形成回环
          state.stack = data.map(p => ({ partId: p.partId, fuel: p.fuel || 0 }));
          renderBuild();
          COOP.applyingRemote = false;
        }
        break;
      case 'peerLeft':
        toastShip('对方已离开联机');
        $('cbText').textContent = '对方已离开';
        window.HOME.highlightVab(false);
        updateCoopGate();
        break;
    }
  };
}

// ---------- 手机端：制造页三栏改标签页 ----------
// 桌面是三栏并排；窄屏一路滚到底才够得到发射按钮，改成切页
const MOBILE_Q = window.matchMedia('(max-width:900px)');

function setPane(name) {
  document.querySelectorAll('.build-body .col').forEach(c => {
    c.classList.toggle('pane-on', c.dataset.pane === name);
  });
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('on', b.dataset.tab === name);
  });
  if (name === 'preview') drawPreview();   // 切到预览页才有尺寸，需重画
}

function syncPanes() {
  if (MOBILE_Q.matches) {
    const cur = document.querySelector('.tab-btn.on')?.dataset.tab || 'parts';
    setPane(cur);
  } else {
    // 桌面：三栏全显示，清掉标签态
    document.querySelectorAll('.build-body .col').forEach(c => c.classList.remove('pane-on'));
    drawPreview();
  }
}

document.querySelectorAll('.tab-btn').forEach(b => {
  b.addEventListener('click', () => setPane(b.dataset.tab));
});
MOBILE_Q.addEventListener('change', syncPanes);

// 加零件后停留在零件库继续搭，只在标签上提示数量变化
function afterAddPart() {
  const tab = document.querySelector('.tab-btn[data-tab="stack"]');
  if (tab) tab.textContent = `📋 已装配 ${state.stack.length}`;
}

// 联机按钮是主页级操作，进入制造/飞行界面后收起，避免压住顶栏标题与 HUD
function syncCoopBtn() {
  const btn = $('btnCoop');
  if (!btn) return;
  const onHome = !$('homeScreen').hidden;
  btn.hidden = !(onHome && typeof netAvailable === 'function' && netAvailable());
}

// ---------- 事件 ----------
// 月面降落：按住点火（空格或按钮）
function setBurn(on) {
  if (state.phase !== 'moon_landing' || state.mode !== 'fly') return;
  const st = state.stages[state.active];
  if (st) st.throttle = on ? 1 : 0;
  $('btnBurn').classList.toggle('firing', !!on);
}
$('btnBurn').addEventListener('mousedown', () => setBurn(true));
$('btnBurn').addEventListener('touchstart', e => { e.preventDefault(); setBurn(true); }, { passive: false });
['mouseup','mouseleave','touchend','touchcancel'].forEach(ev =>
  $('btnBurn').addEventListener(ev, () => setBurn(false)));
document.addEventListener('keyup', e => { if (e.code === 'Space') setBurn(false); });

$('btnContinue').addEventListener('click', continueFlight);
$('btnMoonLand').addEventListener('click', startMoonLanding);
$('btnMoonHome').addEventListener('click', () => { location.href = 'index.html'; });

$('btnLaunch').onclick = requestLaunch;
$('btnSep').onclick = separate;
$('btnAbort').onclick = backToBuild;
$('btnHome').addEventListener('click', backToHome);
$('btnAgain').onclick = () => { $('resultBox').hidden = true; launch(); };
$('btnEdit').onclick = () => { $('resultBox').hidden = true; backToBuild(); };
$('btnClear').onclick = () => { state.stack = []; renderBuild(); };
$('btnPreset').onclick = () => {
  state.stack = [
    { partId:'engine_large', fuel:0 }, { partId:'fuel_large', fuel:100 },
    { partId:'decoupler', fuel:0 },
    { partId:'engine_medium', fuel:0 }, { partId:'fuel_medium', fuel:60 },
  ];
  renderBuild();
};
function backToBuild() {
  state.mode = 'build';
  $('flyScreen').hidden = true;
  $('buildScreen').hidden = false;
  renderBuild();
  updateCoopGate();
}
document.addEventListener('keydown', e => {
  if (state.mode !== 'fly') return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (state.phase === 'moon_landing') setBurn(true);
    else separate();
  }
});
window.addEventListener('resize', () => { if (state.mode==='build') drawPreview(); });

loadSprites();

// 从主页雷达站选来的飞船：直接载入车间
// 函数声明（不是 IIFE 里的具名函数表达式）—— enterBuilding 需要从外部调用它
function loadPendingShip() {
  if (typeof fleetTakePending !== 'function') return;
  const id = fleetTakePending();
  if (!id) return;
  const ship = fleetFind(id);
  if (!ship || !Array.isArray(ship.stack)) return;
  state.stack = ship.stack.map(p => ({ partId: p.partId, fuel: p.fuel || 0 }));
  // 燃料箱一律加满，方便直接发射
  state.stack.forEach(p => {
    const def = PARTS[p.partId];
    if (def && def.type === 'fuel') p.fuel = def.capacity;
  });
  loadedShipName = ship.name;
}

setTimeout(() => { paintThumbs(); drawPreview(); }, 800);
renderBuild();
if (loadedShipName) toastShip(`已载入「${loadedShipName}」`);

// 页面不可见时浏览器会暂停 requestAnimationFrame，这个钩子可手动步进物理，供自动化测试使用
window.GAME = { enterBuilding, backToHome, updateCoopGate, bindCoopEvents };

window.__rocket = {
  state,
  step(seconds = 1) {
    const n = Math.round(seconds / FIXED_DT);
    for (let i = 0; i < n && state.mode === 'fly'; i++) update(FIXED_DT);
    return { t: state.t, alt: state.stages[state.active]?.y ?? 0, mode: state.mode };
  },
  separate,
  render,           // 页面不可见时 rAF 不跑，测试需要手动触发绘制
  tryBoost,         // 彩蛋命中判定，便于自动化验证
  hitLaunchPad,
};

// 回到前台时重置计时基准，避免累积的时间差一次性灌进物理
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { last = 0; acc = 0; }
});

// ---------- 联机 UI 绑定 ----------
(function bindCoopUI() {
  if (typeof netAvailable !== 'function') return;
  const has = netAvailable();
  syncCoopBtn();
  if (!has) return;
  bindCoopEvents();

  const err = m => { $('coopErr').textContent = m || ''; };
  $('btnCoop').addEventListener('click', () => {
    $('coopName').value = (typeof playerName === 'function' && playerName()) || '';
    $('coopModal').hidden = false; err('');
  });
  $('coopClose').addEventListener('click', () => { $('coopModal').hidden = true; });

  $('btnCreateRoom').addEventListener('click', async () => {
    const n = $('coopName').value.trim();
    if (typeof setPlayerName === 'function') setPlayerName(n);
    err('创建中…');
    try {
      const code = await netCreateRoom(n);
      $('coopIdle').hidden = true; $('coopWaiting').hidden = false;
      $('roomCode').textContent = code;
      $('coopStatus').textContent = '等待对方加入…';
      err('');
    } catch (e) { err('创建失败：' + e.message); }
  });

  $('btnJoinRoom').addEventListener('click', async () => {
    const code = $('coopCode').value.trim().toUpperCase();
    if (code.length !== 6) return err('房号是 6 位');
    const n = $('coopName').value.trim();
    if (typeof setPlayerName === 'function') setPlayerName(n);
    // 受邀方先弹同意框
    $('inviteText').textContent = `加入房间 ${code}？加入后你将与房主共同操控一枚火箭。`;
    $('inviteModal').hidden = false;
    $('inviteModal').dataset.code = code;
    $('inviteModal').dataset.name = n;
  });

  $('btnInviteNo').addEventListener('click', () => { $('inviteModal').hidden = true; });
  $('btnInviteYes').addEventListener('click', async () => {
    const code = $('inviteModal').dataset.code, n = $('inviteModal').dataset.name;
    $('inviteModal').hidden = true;
    err('加入中…');
    try {
      const host = await netJoinRoom(code, n);
      $('coopIdle').hidden = true; $('coopWaiting').hidden = false;
      $('roomCode').textContent = code;
      $('coopStatus').textContent = `已加入 ${host} 的房间，正在建立连接…`;
      err('');
    } catch (e) {
      err('加入失败：' + ({ room_not_found: '房间不存在', room_full: '房间已满' }[e.message] || e.message));
    }
  });

  // 手机键盘上的「前往」键直接提交，省得去够屏幕上的按钮
  $('coopCode').addEventListener('keydown', e => { if (e.key === 'Enter') $('btnJoinRoom').click(); });
  $('coopName').addEventListener('keydown', e => { if (e.key === 'Enter') $('coopCode').focus(); });

  $('btnCopyCode').addEventListener('click', () => {
    const c = $('roomCode').textContent;
    navigator.clipboard?.writeText(c).then(() => toastShip('房号已复制：' + c)).catch(() => {});
  });

  const quit = () => {
    netLeave();
    $('coopBar').hidden = true;
    $('coopModal').hidden = true;
    $('coopIdle').hidden = false; $('coopWaiting').hidden = true;
    window.HOME.highlightVab(false);
    updateCoopGate();
  };
  $('btnLeaveRoom').addEventListener('click', quit);
  $('btnQuit').addEventListener('click', quit);

  // 按住说话
  const talk = on => { if (netSetTalking(on)) $('btnTalk').classList.toggle('on', on); };
  $('btnTalk').addEventListener('mousedown', () => talk(true));
  $('btnTalk').addEventListener('touchstart', e => { e.preventDefault(); talk(true); }, { passive: false });
  ['mouseup','mouseleave','touchend','touchcancel'].forEach(ev =>
    $('btnTalk').addEventListener(ev, () => talk(false)));
})();
