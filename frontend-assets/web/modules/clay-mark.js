// 「clay」运行标记的播放器——维护者私有 overlay 的运行时模块（claude-bridge 前端经 ovModule('clayMark') 加载，
// 由 web/src/components/ClaudeWorkingMark.svelte 挂上）。素材在 ../logo-animations/clay/<身体>.<段>.png，帧表在 overlay
// 清单 data.marks.clay（ClaudeWorkingMark 传进来）。公开版没有素材也没有本模块，ClaudeWorkingMark 走自绘 StarMark。
//
// 来源：Claude Code Desktop 官方前端 shared-frame 的 clay 标记（状态机 xA/_A、seam 衔接、截末 20 帧当 tail、
// 300ms 交叉淡化、跨实例 500ms 续播）移植而来，原在 claude-bridge 的 ClaudeWorkingMarkClay.svelte，2026-10-22 搬进
// overlay 并改写成不依赖框架的类（行为不变）。永不进公开仓。
//
// 机制：每个「身体」(default/think/search/read/code/write/compose/blocked，sphere=default 的别名)
// 有 in → loop → out 三段；起步从一颗小圆点 grow 长出来。活动切换时：
//   · think / code 的 loop 有 seams（衔接帧），等到下一个 seam 再出场，不硬切；
//   · default / sphere / blocked 或要切到 blocked：剩余 >1.5s 就截取 loop 末 20 帧当 tail 收尾，
//     并把当前帧做成快照层、新层 300ms 渐显（交叉淡化），否则播完这圈再出场；
//   · 其余身体播完整圈再出场。
// 播放：Web Animations API 逐帧 translateY + steps(n, jump-none)。
//
// 用法：const p = new ClayMark(host, { pack, size, box, standalone, activity, state, paused });
//       p.set({ activity, state, paused }); p.destroy();
//   activity: default|think|search|read|code|write|compose；state: working|blocked|tile

const BASE = new URL('../logo-animations/clay/', import.meta.url).href;
const VQ = new URL(import.meta.url).search;   // 本模块地址带的 ?v=（overlay 版本戳）：素材跟着长缓存

// —— 帧表（第一次挂载时从清单数据取一次）——
let PACK = null;   // { S, SHEETS }
function setPack(c) {
  if (PACK) return PACK;
  c = c || {};
  const sheets = { ...(c.sheets || {}) };
  for (const k of ['in', 'loop', 'out']) if (sheets[`default.${k}`]) sheets[`sphere.${k}`] = sheets[`default.${k}`];
  PACK = { S: Number(c.frameMs) || 33.3333, SHEETS: sheets };
  return PACK;
}
const fileOf = (k) => (k.startsWith('sphere.') ? 'default.' + k.slice(7) : k);
const urlOf = (k) => BASE + encodeURIComponent(fileOf(k)) + '.png' + VQ;

// —— 雪碧图解码（模块级共享）：先解码 grow + 常驻四身体，齐了即可开播；其余身体后台按组补 ——
const PRIMARY = ['sphere', 'default', 'think', 'blocked'];
const trio = (b) => [`${b}.in`, `${b}.loop`, `${b}.out`];
const decoded = new Set();
const listeners = new Set();
let resident = false, loading = null;
const notify = () => { for (const f of [...listeners]) f(); };
function decode(k) {
  if (typeof Image === 'undefined') return Promise.resolve();
  const img = new Image();
  img.src = urlOf(k);
  return img.decode().then(() => { decoded.add(k); });
}
function loadSheets() {
  if (resident) return Promise.resolve();
  return (loading ||= Promise.all(['grow', ...PRIMARY.flatMap(trio)].map(decode)).then(() => {
    resident = true;
    notify();
    for (const b of ['search', 'read', 'code', 'write', 'compose']) Promise.all(trio(b).map(decode)).then(notify, () => {});
  }).catch(() => { loading = null; }));
}
const ready = (b) => trio(b).every((k) => decoded.has(k));

// —— 跨实例接续：上一颗标记卸载 ≤500ms 内新挂的一颗从它的进度续播（不再从圆点长出来）——
const live = new Set();
let lastLeft = null;
function resumePoint(now) {
  let r = null;
  for (const x of live) r = x;
  if (!r && lastLeft && now - (lastLeft.leftAt ?? now) <= 500) r = lastLeft;
  if (!r) return undefined;
  return r.stage ? { kind: r.stage.kind, body: r.stage.body, ms: now - r.stage.since } : 'dot';
}

const keyOf = (st) => (st.kind === 'grow' ? 'grow' : `${st.body}.${st.kind === 'tail' ? 'loop' : st.kind}`);
const TAIL = 20;
const tailRange = (frames) => [Math.max(0, frames - TAIL), frames];
function advance(st, want) {
  switch (st.kind) {
    case 'grow': return { kind: 'in', body: want };
    case 'tail': return st.body === want ? { kind: 'loop', body: st.body } : { kind: 'out', body: st.body };
    case 'in': return st.body === 'sphere' && want !== 'sphere' ? { kind: 'out', body: 'sphere' } : { kind: 'loop', body: st.body };
    case 'loop': return st.body === want ? st : { kind: 'out', body: st.body };
    case 'out': return { kind: 'in', body: want };
  }
}
const entryOf = (b) => (b === 'sphere' ? { kind: 'loop', body: 'sphere' } : { kind: 'in', body: b });
const raf2 = (f) => { let id = requestAnimationFrame(() => { id = requestAnimationFrame(f); }); return () => cancelAnimationFrame(id); };

let styled = false;
function ensureStyle() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const s = document.createElement('style');
  s.dataset.ovClay = '';
  s.textContent = '.ovclay{position:relative;display:inline-block;flex:none;user-select:none;line-height:0}'
    + '.ovclay-dot{position:absolute;inset:0;margin:auto;border-radius:50%;background:#d97757}'
    + '.ovclay-stage{position:absolute;display:block}'
    + '.ovclay-layer{position:absolute;inset:0;overflow:clip;display:block}'
    + '.ovclay-strip{display:block;background-size:100% 100%;background-repeat:no-repeat}'
    + '.ovclay-strip.hot{will-change:transform;box-shadow:inset 0 0 0 1px transparent}';
  document.head.appendChild(s);
}

const sameSig = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
const setStyle = (el, s) => { if (el.getAttribute('style') !== s) el.setAttribute('style', s); };

export class ClayMark {
  constructor(host, { pack, size = 20, box = size, standalone = false, activity = 'default', state = 'working', paused = false } = {}) {
    setPack(pack);
    ensureStyle();
    this.size = size; this.box = box; this.standalone = standalone;
    this.p = { activity, state, paused };
    this.reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.ver = 0;                     // 雪碧图解码进度变化 → 重算可用身体
    this.sheetsOk = resident;
    this.resume = resumePoint(performance.now());
    this.fromDot = this.resume === undefined || this.resume === 'dot';
    this.playing = false; this.dotGone = false; this.stage = null; this.iter = 0;
    this.snap = null;                 // 交叉淡化的快照层 { key, frame }
    this.failed = false; this.keys = [];
    this.anim = null; this.stageAt = 0; this.firstFrame = 0;
    this.rec = { stage: null, leftAt: null };
    this.fx = Object.create(null);    // 效果名 → { sig, cleanup }
    this.alive = true; this.flushing = false; this.dirty = false;
    this.el = document.createElement('span');
    this.el.className = 'ovclay';
    this.el.setAttribute('aria-hidden', 'true');
    this.el.style.width = box + 'px'; this.el.style.height = box + 'px';
    host.appendChild(this.el);
    this.dotEl = null; this.stageEl = null; this.snapEl = null; this.layers = new Map();
    this.onSheets = () => { this.sheetsOk = resident; this.ver++; this.invalidate(); };
    listeners.add(this.onSheets);
    if (!resident) loadSheets();
    if (!standalone) { this.rec.leftAt = null; live.add(this.rec); }
    this.invalidate();
  }

  set(p) {
    const n = { ...this.p, ...p };
    if (n.activity === this.p.activity && n.state === this.p.state && n.paused === this.p.paused) return;
    this.p = n;
    this.invalidate();
  }

  destroy() {
    if (!this.alive) return;
    this.alive = false;
    for (const k of Object.keys(this.fx)) { try { this.fx[k].cleanup?.(); } catch {} }
    this.fx = Object.create(null);
    listeners.delete(this.onSheets);
    if (!this.standalone) { this.rec.leftAt = performance.now(); live.delete(this.rec); lastLeft = this.rec; }
    this.el.remove();
  }

  // —— 派生值 ——
  want() {
    const { activity, state } = this.p;
    const a = activity === 'compose' && !ready('compose') ? 'write' : activity;
    const r = state === 'blocked' ? 'blocked' : state === 'tile' ? 'sphere' : a;
    return ready(r) ? r : ready('default') ? 'default' : 'sphere';
  }
  still() { return this.reduce || this.failed; }
  curKey() { return this.stage ? (this.still() ? `${this.want()}.loop` : keyOf(this.stage)) : null; }
  curFrame() {
    if (!this.stage) return 0;
    const { SHEETS } = PACK;
    const k = this.curKey();
    const L = SHEETS[k].frames;
    if (this.still()) return SHEETS[k].rest ?? Math.floor(L / 3);
    return this.stage.kind === 'tail' ? tailRange(L)[0] : 0;
  }

  // —— 刷新：要挂的图层 → 画 DOM → 按依赖跑各个效果（依赖变了先清上一次）；效果里改了状态就再来一轮 ——
  invalidate() {
    if (!this.alive) return;
    if (this.flushing) { this.dirty = true; return; }
    this.flushing = true;
    let n = 0;
    try {
      do { this.dirty = false; this.needLayers(); this.render(); this.effects(); } while (this.dirty && this.alive && ++n < 40);
    } finally { this.flushing = false; }
  }

  fxRun(name, sig, body) {
    const cur = this.fx[name];
    if (cur && sameSig(cur.sig, sig)) return;
    try { cur?.cleanup?.(); } catch {}
    const c = body();
    this.fx[name] = { sig, cleanup: typeof c === 'function' ? c : null };
  }

  // 要挂着的层：当前、下一段、want 的入场、sphere 出入、want 的 loop、快照——只增不减，
  // 图层常驻（不可见层 opacity .001）免得切段时现解码闪一下。
  needLayers() {
    if (!this.stage) return;
    const still = this.still(), want = this.want();
    const cur = still ? `${want}.loop` : keyOf(this.stage);
    const need = [cur, keyOf(advance(still ? { kind: 'loop', body: want } : this.stage, want)), keyOf(entryOf(want)), 'sphere.in', 'sphere.out'];
    if (want !== 'sphere') need.push(`${want}.loop`);
    if (this.snap) need.push(this.snap.key);
    const miss = [...new Set(need)].filter((k) => !this.keys.includes(k));
    if (miss.length) this.keys = [...this.keys, ...miss];
  }

  render() {
    const { size } = this;
    const { SHEETS } = PACK;
    const still = this.still();
    const showDot = !this.playing || (this.fromDot && !this.dotGone && !this.reduce);
    if (showDot && !this.dotEl) {
      this.dotEl = document.createElement('span');
      this.dotEl.className = 'ovclay-dot';
      this.el.insertBefore(this.dotEl, this.el.firstChild);
    } else if (!showDot && this.dotEl) { this.dotEl.remove(); this.dotEl = null; }
    if (this.dotEl) setStyle(this.dotEl, `width:${size * 0.35}px;height:${size * 0.35}px`);
    if (!this.playing) {
      if (this.stageEl) { this.stageEl.remove(); this.stageEl = null; this.snapEl = null; this.layers.clear(); }
      return;
    }
    if (!this.stageEl) {
      this.stageEl = document.createElement('span');
      this.stageEl.className = 'ovclay-stage';
      this.el.appendChild(this.stageEl);
    }
    const off = (this.box - size) / 2;
    setStyle(this.stageEl, `left:${off}px;top:${off}px;width:${size}px;height:${size}px`);
    const strip = (k, frame) => `width:${size}px;height:${SHEETS[k].frames * size}px;background-image:url("${urlOf(k)}");transform:translateY(${-frame * size}px)`;
    // 快照层（交叉淡化时垫在底下）
    if (this.snap && !still) {
      if (!this.snapEl) {
        this.snapEl = document.createElement('span');
        this.snapEl.className = 'ovclay-layer';
        this.snapEl.appendChild(Object.assign(document.createElement('span'), { className: 'ovclay-strip' }));
        this.stageEl.insertBefore(this.snapEl, this.stageEl.firstChild);
      }
      setStyle(this.snapEl.firstChild, strip(this.snap.key, this.snap.frame));
    } else if (this.snapEl) { this.snapEl.remove(); this.snapEl = null; }
    const curKey = this.curKey(), curFrame = this.curFrame();
    const keys = curKey && !this.keys.includes(curKey) ? [...this.keys, curKey] : this.keys;
    for (const k of keys) {
      let layer = this.layers.get(k);
      if (!layer) {
        layer = document.createElement('span');
        layer.className = 'ovclay-layer';
        layer.dataset.k = k;
        layer.appendChild(Object.assign(document.createElement('span'), { className: 'ovclay-strip' }));
        this.stageEl.appendChild(layer);
        this.layers.set(k, layer);
      }
      const on = k === curKey;
      setStyle(layer, `opacity:${on ? '' : 0.001};z-index:${on ? 1 : 'auto'}`);
      const s = layer.firstChild;
      s.classList.toggle('hot', on && !still);
      setStyle(s, strip(k, on ? curFrame : 0));
    }
  }

  effects() {
    const { S, SHEETS } = PACK;
    const size = this.size;
    const still = this.still();

    // 解码齐 → 开播。从圆点起步时隔两帧再开（先让圆点落地一帧）。
    this.fxRun('go', [this.sheetsOk, this.playing], () => {
      if (!this.sheetsOk || this.playing) return;
      const go = () => {
        if (!this.alive) return;
        let st = null;
        const resume = this.resume;
        if (resume && resume !== 'dot') {
          const ms = Math.max(0, resume.ms);
          if (resume.kind === 'grow') st = { kind: 'grow' };
          else if (resume.body && ready(resume.body)) st = resume.kind === 'tail' ? { kind: 'out', body: resume.body } : { kind: resume.kind, body: resume.body };
          if (st && resume.kind !== 'tail') {
            const info = SHEETS[keyOf(st)];
            const n = Math.floor(ms / S);
            this.firstFrame = st.kind === 'loop' ? n % info.frames : Math.min(info.frames - 1, n);
          }
        }
        this.stage = st ?? (this.fromDot ? { kind: 'grow' } : entryOf(this.want()));
        this.playing = true;
        this.invalidate();
      };
      if (this.fromDot && !this.reduce) return raf2(go);
      go();
    });

    this.fxRun('dot', [this.playing, this.dotGone], () => {
      if (this.playing && !this.dotGone) return raf2(() => { this.dotGone = true; this.invalidate(); });
    });

    // 播当前段：一段一个 one-shot 动画，播完按状态机推进（同段 loop 继续 = iter+1 重播）。
    this.fxRun('play', [this.stage, this.iter, still, this.stageEl], () => {
      const st = this.stage;
      if (!st || still || !this.stageEl) return;
      const key = keyOf(st);
      const el = this.layers.get(key)?.firstChild;
      if (!el || typeof el.animate !== 'function') return;
      const L = SHEETS[key].frames;
      const [a, b] = st.kind === 'tail' ? tailRange(L) : [0, L];
      const n = b - a;
      let an;
      try {
        an = el.animate(Array.from({ length: n }, (_, i) => ({ transform: `translateY(${-(a + i) * size}px)` })),
          { duration: S * n, iterations: 1, easing: n > 1 ? `steps(${n}, jump-none)` : 'linear', fill: 'forwards' });
      } catch { this.failed = true; this.invalidate(); return; }
      this.anim = an;
      if (this.stageAt === 0 || (st.kind !== 'loop' && st.kind !== 'out')) this.stageAt = performance.now();
      const skip = this.firstFrame * S;
      this.firstFrame = 0;
      if (skip > 0) an.currentTime = skip;
      this.rec.stage = { kind: st.kind, body: st.kind === 'grow' ? null : st.body, since: performance.now() - skip };
      if (this.p.paused) an.pause();
      let alive = true;
      an.finished.then(() => {
        if (!alive || !this.alive) return;
        const nx = advance(st, this.want());
        if (nx === st) this.iter++; else this.stage = nx;
        this.invalidate();
      }).catch(() => {});
      return () => { alive = false; if (this.anim === an) this.anim = null; an.cancel(); };
    });

    // 活动变了而当前在 loop：按身体选出场时机（见顶部注释）。
    this.fxRun('exit', [this.stage, this.want(), still], () => {
      const st = this.stage, w = this.want();
      if (!st || st.kind !== 'loop' || st.body === w || still) return;
      const info = SHEETS[keyOf(st)];
      const quick = w === 'blocked' || st.body === 'blocked' || st.body === 'default' || st.body === 'sphere';
      const an = this.anim;
      if (!an || an.currentTime == null) return;
      const t = Number(an.currentTime);
      if (!quick) {
        const at = (info.seams || []).map((s) => s * S).find((x) => x > t + 50);
        if (at === undefined) return;
        const id = setTimeout(() => {
          if (!this.alive || this.want() === st.body) return;
          this.stage = { kind: 'out', body: st.body };
          this.invalidate();
        }, at - t);
        return () => clearTimeout(id);
      }
      if (S * info.frames - t <= 1500) return;
      this.snap = { key: keyOf(st), frame: Math.min(info.frames - 1, Math.floor(t / S)) };
      this.stage = st.body === 'sphere' ? { kind: 'out', body: 'sphere' } : { kind: 'tail', body: st.body };
      this.invalidate();
    });

    const curKey = this.curKey();
    this.fxRun('snap', [this.snap, curKey, still, this.stageEl], () => {
      if (!this.snap) return;
      const id = setTimeout(() => { this.snap = null; this.invalidate(); }, 360);
      const layer = this.layers.get(curKey);
      const f = still || !layer?.animate ? null : layer.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, easing: 'ease-in-out' });
      return () => { clearTimeout(id); f?.cancel(); };
    });

    this.fxRun('paused', [this.p.paused], () => {
      const an = this.anim;
      if (!an) return;
      if (this.p.paused) an.pause(); else if (an.playState === 'paused') an.play();
    });
  }
}
