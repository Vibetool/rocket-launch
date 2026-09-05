// 火箭物理与分级逻辑
const G = 9.8;           // 地面重力 m/s²
const R_EARTH = 6371000; // 用于高空重力衰减
const ATMO_TOP = 70000;  // 大气层顶（米）——超过即算入轨高度层
const SPACE_LINE = 100000; // 卡门线，抵达算胜利

// 一个"段"= 一串相连的零件（分离后各自独立飞行）
class Stage {
  constructor(parts, x, y) {
    this.parts = parts;      // [{partId, fuel}]，自下而上
    this.x = x; this.y = y;  // y 向上为正（米）
    this.vx = 0; this.vy = 0;
    this.alive = true;
    this.landed = false;
    this.throttle = 1;
  }

  get dryMass() {
    return this.parts.reduce((s, p) => s + PARTS[p.partId].mass, 0);
  }
  get fuelMass() {
    return this.parts.reduce((s, p) => s + (p.fuel || 0) * FUEL_MASS_PER_UNIT, 0);
  }
  get mass() { return this.dryMass + this.fuelMass; }

  get engines() {
    return this.parts.filter(p => PARTS[p.partId].type === 'engine');
  }
  get totalFuel() {
    return this.parts.reduce((s, p) => s + (p.fuel || 0), 0);
  }
  get maxThrust() {
    return this.engines.reduce((s, p) => s + PARTS[p.partId].thrust, 0);
  }
  get burnRate() {
    return this.engines.reduce((s, p) => s + PARTS[p.partId].burn, 0);
  }

  // 消耗燃料：从下往上抽（先烧底部箱）
  drawFuel(amount) {
    let need = amount;
    for (const p of this.parts) {
      if (PARTS[p.partId].type !== 'fuel') continue;
      const take = Math.min(p.fuel, need);
      p.fuel -= take; need -= take;
      if (need <= 1e-9) break;
    }
    return amount - need; // 实际抽到的量
  }

  // 推力是否有效：有引擎 + 有油 + 油门开
  get thrusting() {
    return this.throttle > 0 && this.maxThrust > 0 && this.totalFuel > 0;
  }
}

// 当前所在天体。月球重力为地球的 2/3，且没有大气
const MOON_G_RATIO = 2 / 3;
let WORLD = 'earth';
function setWorld(w) { WORLD = w; }
function getWorld() { return WORLD; }

// 重力随高度衰减（月球段高度尺度只有几公里，不做衰减）
function gravityAt(altitude) {
  if (WORLD === 'moon') return G * MOON_G_RATIO;
  const r = R_EARTH + Math.max(0, altitude);
  return G * (R_EARTH / r) ** 2;
}

// 大气密度（简化指数模型），用于阻力。月球真空，无阻力
function airDensity(altitude) {
  if (WORLD === 'moon') return 0;
  if (altitude < 0) return 1.225;
  return 1.225 * Math.exp(-altitude / 8500);
}

// 推力→加速度系数。按引擎推力 30/20/15 重新标定：
// 迷你 13km（失败）、单级大引擎+大箱 47km（失败）、
// 两级示例 138km（成功，提前 4 秒分离仍有 111km 余量）、三级 254km
const THRUST_SCALE = 25;

// 推进一帧。carriedMass = 该段还背着的上面级质量（未分离时）
function stepStage(st, dt, carriedMass = 0) {
  if (!st.alive || st.landed) return;

  const alt = st.y;
  const totalMass = Math.max(0.1, st.mass + carriedMass);
  let ax = 0, ay = -gravityAt(alt);

  // 推力（向上；单位换算成加速度 = 推力*常数/质量）
  if (st.thrusting) {
    const want = st.burnRate * st.throttle * dt;
    const got = st.drawFuel(want);
    if (got > 0) {
      const ratio = want > 0 ? got / want : 0;
      // thrustMul：彩蛋加成等外部倍率，默认 1
      ay += (st.maxThrust * (st.thrustMul || 1) * THRUST_SCALE * st.throttle * ratio) / totalMass;
    }
  }

  // 空气阻力
  const rho = airDensity(alt);
  const v = Math.hypot(st.vx, st.vy);
  if (v > 0.01) {
    const DRAG = 0.0016;
    const d = DRAG * rho * v * v / totalMass;
    ax -= d * (st.vx / v);
    ay -= d * (st.vy / v);
  }

  st.vx += ax * dt;
  st.vy += ay * dt;
  st.x += st.vx * dt;
  st.y += st.vy * dt;

  // 落地
  if (st.y <= 0) {
    st.y = 0;
    const impact = Math.abs(st.vy);
    st.landed = true;
    st.crashed = impact > 12;   // 撞太快就炸
    st.vy = 0; st.vx = 0;
  }
}

// 按分离器把零件序列切成若干段（自下而上）
function splitByDecouplers(partStack) {
  const groups = [[]];
  for (const p of partStack) {
    if (PARTS[p.partId].type === 'decoupler') {
      groups[groups.length - 1].push(p); // 分离器留在下段顶部
      groups.push([]);
    } else {
      groups[groups.length - 1].push(p);
    }
  }
  return groups.filter(g => g.length);
}
