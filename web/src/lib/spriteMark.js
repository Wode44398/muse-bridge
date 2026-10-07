// 新版 claude.ai 聊天页的运行标记「sprite」——移植自桌面端 2.26454 的 c05970c42（TurnStatusLeftMark 的 U/V/B
// 与 TurnStatusBlockedMark）。三段：
//   pending 等首字 → spark：Claude 星形按 thinkingFast → toolCall1 → thinkingFast → toolCall2 → thinkingFast → toolCall3 轮播；
//   working 干活中 → nodes：nodes3 / nodes4 交替；从 spark 转来时按 spark 当前帧挑接入点，经 sparkToNodes 过渡；
//   blocked 等人  → 圆角方块，2s 后起每 6s 轻抖一下。
// 素材是官方原始 SVG 竖向雪碧图（public/logo-animations/sprite/<名>.svg，path 跟随 currentColor），33ms/帧。
// 尺寸按官方 20px 方框换算：spark 画 32、nodes 画 20、过渡画 32（都居中在 20 的框里），k = 实际框 / 20。

const BASE = import.meta.env.BASE_URL;
const META = {
  thinkingFast: { frameCount: 28, width: 360, height: 360 },
  toolCall1: { frameCount: 70, width: 360, height: 360 },
  toolCall2: { frameCount: 52, width: 360, height: 360 },
  toolCall3: { frameCount: 61, width: 360, height: 360 },
  sparkToNodes: { frameCount: 16, width: 360, height: 360 },
  nodes3: { frameCount: 158, width: 160, height: 160 },
  nodes4: { frameCount: 158, width: 160, height: 160 },
};
const SPEED = 33;

const svgs = new Map();
function load(name) {
  if (!svgs.has(name)) svgs.set(name, fetch(`${BASE}logo-animations/sprite/${name}.svg`).then((r) => (r.ok ? r.text() : '')).catch(() => ''));
  return svgs.get(name);
}
const SPARK = ['thinkingFast', 'toolCall1', 'toolCall2', 'toolCall3'];
const NODES = ['sparkToNodes', 'nodes3', 'nodes4'];
const cache = {};   // name → svg 文本（已到）
export function preloadSprite(mode) {
  return Promise.all((mode === 'spark' ? SPARK : NODES).map((n) => load(n).then((s) => { if (s) cache[n] = s; })));
}

const SPARK_SEQ = ['thinkingFast', 'toolCall1', 'thinkingFast', 'toolCall2', 'thinkingFast', 'toolCall3'];
const NODES_SEQ = ['nodes3', 'nodes4'];
const RUN = { kind: 'run' }, INTRO0 = { kind: 'intro', startFrame: 0 };
// spark → nodes 的接入点（官方常量原样）
const TF_MAP = [0, 0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 14, 12, 11, 10, 9, 9, 7, 7, 6, 6, 4, 3, 2];
const TC1 = { from: 48, to: 58 }, TC1_OUT = [8, 7, 6, 6, 5, 4, 4, 3, 2, 2, 0, 0];
const BLOCK_PATH = 'M27.1 134.7C21.6 128.9 22.8 119 29.6 115.4L33 113.5L33.2 105C33.4 92.9 33.0 72.2 32.4 60.5C31.9 51.2 31.7 50.3 29.2 48.1C23.0 42.6 21.4 36.9 24.5 31C27.8 24.6 38.1 22.8 42.8 27.8C44.3 29.3 46.0 31.4 46.5 32.3C47.4 34 50.2 34.1 79.3 34.5L111.2 34.9L113.2 31.4C118.9 21.7 132.9 23.3 136.1 34C137.6 39 136.1 42.9 130.8 47.4L127.0 50.7L127.1 80.2L127.3 109.6L130.1 111.3C134.0 113.5 137.0 118.7 137 123.3C137 126.2 136.2 127.9 133.4 131C130.1 134.7 129.3 135 124.7 135C120 135 119.3 134.7 115.2 130.3L110.7 125.7L92.6 126.6C82.7 127 71.6 127.4 68 127.3C64.4 127.2 58.5 127.5 54.8 128.1C48.7 129.1 47.9 129.5 45.9 132.6C43.2 137 41.2 138 35.3 138C31.1 138 29.9 137.6 27.1 134.7ZM105.7 120.1C111.6 120 111.9 119.9 113.8 116.6C115.0 114.7 117.1 112.5 118.7 111.7L121.5 110.2L121.5 80.5L121.5 50.8L117.7 47.8C115.6 46.1 113.3 43.5 112.5 42.1L111.2 39.4L79.7 39.2L48.3 38.9L45.6 43C44.1 45.2 41.9 47.5 40.6 48.1C38.3 49.2 38.3 49.5 37.7 68.8C37.4 79.7 37.3 93.9 37.6 100.5C38.0 111.5 38.3 112.6 40.3 114C41.5 114.8 43.9 116.9 45.5 118.7C49.3 122.7 50.5 122.8 78 121.3C89.8 120.7 102.3 120.1 105.7 120.1Z';
const SHAKE = [[0, 'none'], [80, -2], [160, 2], [240, -1], [320, 'none']];

export class SpritePlayer {
  // host：一个空 span（position:relative），box = 方框边长 px
  // still：系统「减少动态效果」时只停在首帧（官方同样不播）
  constructor(host, box, still = false) { this.host = host; this.k = box / 20; this.still = still; this.phase = null; this.M = null; this.alive = false; }

  set(phase) {
    if (phase === this.phase) return;
    const prev = this.phase;
    this.phase = phase;
    if (phase === 'blocked') { this.stop(); this.blocked(); return; }
    const mode = phase === 'pending' ? 'spark' : 'nodes';
    // 素材没到之前不动：先把这段要用的拉齐（离线 apk 本地读，网页首次约 1.5MB、之后走缓存）
    const need = mode === 'spark' ? SPARK : NODES;
    if (!need.every((n) => cache[n])) {
      const want = this.phase;
      preloadSprite(mode).then(() => { if (this.phase === want && this.host) { this.phase = null; this.set(want); } });
      if (!prev) this.placeholder();
      return;
    }
    // 计算接入点要在 stop 之前（M 记的是 spark 正在播的那张）
    const init = mode === 'nodes' && prev === 'pending' ? this.handoff() : { stage: RUN, index: 0 };
    this.stop();
    this.mode = mode;
    this.stage = init.stage; this.index = init.index;
    this.run();
  }

  destroy() { this.stop(); this.host = null; }
  stop() { this.alive = false; this.anim?.cancel(); this.anim = null; clearTimeout(this.timer); }

  placeholder() {   // 素材加载中：静止的小圆点，不至于空着
    const k = this.k, h = this.host;
    h.innerHTML = `<span style="position:absolute;inset:0;margin:auto;width:${7 * k}px;height:${7 * k}px;border-radius:50%;background:currentColor"></span>`;
  }

  frame(sheet, size) {
    const box = 20 * this.k, off = (box - size) / 2, m = META[sheet];
    const clip = document.createElement('span');
    clip.className = 'sm-clip';
    Object.assign(clip.style, { left: off + 'px', top: off + 'px', width: size + 'px', height: size * m.height / m.width + 'px' });
    const strip = document.createElement('span');
    strip.className = 'sm-strip';
    strip.innerHTML = cache[sheet];
    clip.appendChild(strip);
    this.host.replaceChildren(clip);
    return strip;
  }

  // 官方 V()+B()：spark 正在播哪张、到第几帧 → nodes 从 sparkToNodes 的哪一帧接（或先把 toolCall 续播完）
  handoff() {
    const e = this.M;
    if (!e) return { stage: INTRO0, index: 0 };
    const t = performance.now() - e.startedAt, n = Math.floor(t / SPEED);
    let r;
    if (t < 0 || n >= e.frameCount) r = INTRO0;
    else if (e.sheet === 'thinkingFast') r = { kind: 'intro', startFrame: TF_MAP[n] ?? 0 };
    else if (e.sheet === 'toolCall1') r = n >= TC1.to ? { kind: 'intro', startFrame: TC1_OUT[n - TC1.to] ?? 0 } : { kind: 'cont', sheet: e.sheet, from: Math.max(n, TC1.from), to: TC1.to, introFrame: 12 };
    else r = (e.frameCount - n) * SPEED <= 600 ? { kind: 'cont', sheet: e.sheet, from: n, to: e.frameCount, introFrame: 0 } : INTRO0;
    return { stage: { ...r, at: performance.now() }, index: 0 };
  }

  run() {
    if (!this.host) return;
    this.alive = true;
    const st = this.stage, nodes = this.mode === 'nodes', k = this.k;
    const V = nodes && st.kind !== 'run' ? st : null;
    const cont = V?.kind === 'cont' && cache[V.sheet] ? V : null;
    const sheet = cont ? cont.sheet : V ? 'sparkToNodes' : (nodes ? NODES_SEQ : SPARK_SEQ)[this.index % (nodes ? 2 : 6)];
    const K = V ? (cont ? 'cont' : 'intro') : 'run';
    const total = META[sheet].frameCount;
    const q = cont ? cont.from : V?.kind === 'intro' ? V.startFrame : (st.from ?? 0);
    const end = Math.min(cont ? cont.to : total, total);
    const size = (V ? 32 : nodes ? 20 : 32) * k;
    const strip = this.frame(sheet, size);
    const skip = st.at === undefined ? 0 : Math.max(0, Math.floor((performance.now() - st.at) / SPEED));
    const o = Math.min(Math.max(q + skip, 0), end - 1), s = end - o;
    if (!nodes) this.M = { sheet, startedAt: performance.now() - o * SPEED, frameCount: total };
    const next = () => {
      if (!this.alive) return;
      if (K === 'cont') this.stage = { kind: 'intro', startFrame: cont.introFrame };
      else if (K === 'intro') this.stage = RUN;
      else { this.stage = RUN; this.index++; }
      this.run();
    };
    if (this.still) { strip.style.transform = `translateY(-${(100 / total) * o}%)`; return; }
    if (s < 2) { strip.style.transform = `translateY(-${(100 / total) * o}%)`; this.timer = setTimeout(next, SPEED); return; }
    try {
      this.anim = strip.animate(Array.from({ length: s }, (_, i) => ({ transform: `translateY(-${(o + i) * (100 / total)}%)` })),
        { duration: SPEED * s, iterations: 1, easing: `steps(${s}, jump-none)`, fill: 'forwards' });
      this.anim.finished.then(next, () => {});
    } catch { strip.style.transform = `translateY(-${(100 / total) * o}%)`; }
  }

  blocked() {
    const k = this.k;
    const span = document.createElement('span');
    span.className = 'sm-clip';
    Object.assign(span.style, { inset: '0' });
    span.innerHTML = `<svg viewBox="0 0 160 160" style="display:block;width:100%;height:100%;fill:currentColor"><path fill-rule="nonzero" d="${BLOCK_PATH}"/></svg>`;
    this.host.replaceChildren(span);
    if (this.still) return;
    try {
      const q = 6000;
      this.anim = span.animate([...SHAKE.map(([t, x]) => ({ offset: t / q, transform: x === 'none' ? 'none' : `translateX(${x * k}px)`, easing: 'ease-out' })), { offset: 1, transform: 'none' }],
        { duration: q, delay: 2000, iterations: Infinity });
    } catch {}
  }
}
