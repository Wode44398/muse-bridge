// agy 输入框右端「仪表分身出发送键」用的小弹簧引擎与形状生成（Material 3 Expressive 动效语言）：
// - 弹簧参数取 M3 Expressive motion scheme 的量级：空间类（位移 / 尺寸 / 形状）允许回弹，效果类（透明度）临界阻尼不回弹。
// - 形状：超椭圆指数 p（2 = 圆，≈3.4 = M3 圆角方）× 波瓣调制（n 瓣、幅度 a，即 M3 的 cookie / soft-burst），整体旋转 rot。
//   用同一个参数化形状在「曲奇 → 圆 → 圆角方」之间连续变形，而不是缩放一张固定图形。
// 只在有弹簧没停下时跑 rAF，全部停稳即自停（被盖住的逐帧订阅者必须自停）。

export class Spring {
  constructor(x, stiffness, damping) {
    this.x = x; this.target = x; this.v = 0;
    this.tune(stiffness, damping);
  }
  tune(stiffness, damping) {
    this.k = stiffness;
    this.c = 2 * damping * Math.sqrt(stiffness);
    return this;
  }
  to(target) { this.target = target; return this; }
  jump(x) { this.x = x; this.target = x; this.v = 0; return this; }
  kick(v) { this.v += v; return this; }
  step(dt) {
    const a = -this.k * (this.x - this.target) - this.c * this.v;
    this.v += a * dt;
    this.x += this.v * dt;
  }
  settled(eps = 0.002) {
    return Math.abs(this.x - this.target) < eps && Math.abs(this.v) < eps * 20;
  }
}

// 半隐式欧拉，按 1/240s 细分保证高刚度稳定；dt 上限 1/30 防切后台回来一大步
export function stepAll(springs, dt) {
  const h = 1 / 240;
  let left = Math.min(dt, 1 / 30);
  while (left > 1e-6) {
    const d = Math.min(h, left);
    for (const s of springs) s.step(d);
    left -= d;
  }
}

const N = 144;
// 以 (0,0) 为心的闭合路径。R = 半宽；p = 超椭圆指数；a / n = 波瓣幅度与瓣数；rot = 旋转角（度）
export function blobPath(R, p, a, n, rot) {
  const pp = Math.max(1.7, p);
  const rr = (rot * Math.PI) / 180;
  const cr = Math.cos(rr), sr = Math.sin(rr);
  let d = '';
  for (let i = 0; i < N; i++) {
    const th = (i / N) * Math.PI * 2;
    const c = Math.cos(th), s = Math.sin(th);
    const se = Math.pow(Math.pow(Math.abs(c), pp) + Math.pow(Math.abs(s), pp), -1 / pp);
    const r = Math.max(0, R) * se * (1 + a * Math.cos(n * th));
    const x = r * c, y = r * s;
    d += (i ? 'L' : 'M') + (x * cr - y * sr).toFixed(2) + ' ' + (x * sr + y * cr).toFixed(2);
  }
  return d + 'Z';
}
