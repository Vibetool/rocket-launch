// 零件定义 —— 数值来自设计图
// 引擎: 推力 / 每秒耗油    燃料箱: 容量
// 所有零件两端等宽（w），高度 h 决定视觉比例

const PART_TYPES = { ENGINE: 'engine', FUEL: 'fuel', DECOUPLER: 'decoupler', CAPSULE: 'capsule' };

const PARTS = {
  engine_large:  { id:'engine_large',  type:'engine', name:'引擎 大', w:56, h:44, mass:6,
                   thrust:30, burn:3, sprite:'engine_large' },
  engine_medium: { id:'engine_medium', type:'engine', name:'引擎 中', w:48, h:36, mass:4,
                   thrust:20, burn:2, sprite:'engine_medium' },
  engine_small:  { id:'engine_small',  type:'engine', name:'引擎 小', w:40, h:28, mass:2.5,
                   thrust:15, burn:1, sprite:'engine_small' },

  fuel_large:  { id:'fuel_large',  type:'fuel', name:'燃料 大', w:56, h:120, mass:4, capacity:100, sprite:'fuel_large' },
  fuel_medium: { id:'fuel_medium', type:'fuel', name:'燃料 中', w:48, h:76,  mass:2.5, capacity:60, sprite:'fuel_medium' },
  fuel_small:  { id:'fuel_small',  type:'fuel', name:'燃料 小', w:40, h:32,  mass:1, capacity:20, sprite:'fuel_small' },

  // 分离器：从它所在位置把火箭断成两截，分离瞬间给一点推力
  decoupler: { id:'decoupler', type:'decoupler', name:'分离器', w:52, h:16, mass:1,
               separationImpulse:120, sprite:'decoupler' },

  // 返回舱：载人舱段，装在火箭顶端。本身没有动力，是要送上天再带回来的那部分
  capsule: { id:'capsule', type:'capsule', name:'返回舱', w:48, h:50, mass:3,
             sprite:'capsule' },
};

const PART_LIST = Object.values(PARTS);

// 干重（不含燃料）
function dryMass(part) { return part.mass; }

// 燃料质量换算：每单位燃料 0.08 质量
const FUEL_MASS_PER_UNIT = 0.08;
