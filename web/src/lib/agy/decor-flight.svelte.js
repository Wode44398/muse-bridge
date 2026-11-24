// 共用文件夹「设为 / 取消」的编排（agy 侧栏）：插件外观一出现、一消失时的进场与退场，以及对话框确认后头像组飞到文件夹标题右端。
//
//   设为（从对话框确认）：两圆在对话框里靠拢叠成组 → 被提起、沿弧线飞到标题右端（投影随高度起落、尺寸一路缩到 20px）
//                       → 飞到一半底板从标题那一行往下展开 → 落定轻顿（欠阻尼弹簧）→ 记忆行（footer）展开。
//   设为（别处来的：撤销、另一台设备、插件自己改的）：底板就地往下展开 + 头像组弹出 → footer 展开。
//   取消：倒着走——footer、状态行收起，Claude 的圆缩回 agy 后面，两圆淡出，底板收回标题那一行。
//
// 侧栏只按 decorFx.entering / leaving 挂类名、渲染「还在退场中」的那份外观；逐帧的东西（飞行、clip-path、弹簧）都在这里直接改 DOM，
// 找元素靠 data-decor-key（Sidebar 的分组）与 data-crumb-decor（顶栏面包屑）。减少动态效果时一律直接切，不演。
import { untrack, tick } from 'svelte';
import { Spring, stepAll } from './springs.js';
import { reducedMotion, emphasized, standard, emphAccel, emphDecel, lerp, clamp01 } from './motion.js';
import { decorKey } from './decor-view.js';

export const decorFx = $state({
  entering: {},     // key → true：外观刚出现、正在进场（底板先只露标题那一行、头像组藏着、footer 收着）
  leaving: {},      // key → 那份外观：已经没了、还在退场
  flying: {},       // key → true：头像组正从对话框飞过来，落点那组先藏着
});

/**
 * 最近一次编排：{ kind: 'enter' | 'leave', key, at }。flown = 从对话框飞过来的那次还没被提示条用过：
 * 紧跟着它的那条撤销提示条带一组小头像（「已经和 Claude 共用」），之后的不带。
 */
export const fxLog = { kind: '', key: '', at: 0, flown: false };

const LEAVE_MS = 420;
let seen = null;                 // 上一份外观里有的文件夹键；null = 还没拉到过（首屏不演）
const lastItem = new Map();      // key → 上一份外观条目（退场时还要画它）
const tokens = new Map();        // key → 当前这次编排的令牌（被打断时旧的那次自己停）
let flight = null;               // 进行中的飞行 { key, tok, done: Promise }

const nextTok = (key) => { const t = (tokens.get(key) || 0) + 1; tokens.set(key, t); return t; };
const alive = (key, t) => tokens.get(key) === t;
const raf = () => new Promise((r) => requestAnimationFrame(r));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tween(ms, frame, stillAlive) {
  return new Promise((res) => {
    let t0 = 0;
    const f = (ts) => {
      if (stillAlive && !stillAlive()) { res(false); return; }
      if (!t0) t0 = ts;
      const p = Math.min(1, (ts - t0) / ms);
      frame(p);
      if (p < 1) requestAnimationFrame(f); else res(true);
    };
    requestAnimationFrame(f);
  });
}

function springTo(from, to, [k, z], frame, stillAlive) {
  return new Promise((res) => {
    const s = new Spring(from, k, z).to(to);
    let last = 0;
    const f = (ts) => {
      if (stillAlive && !stillAlive()) { res(false); return; }
      const dt = last ? (ts - last) / 1000 : 1 / 60;
      last = ts;
      stepAll([s], dt);
      if (s.settled(0.001)) { frame(to); res(true); return; }
      frame(s.x);
      requestAnimationFrame(f);
    };
    requestAnimationFrame(f);
  });
}

const groupEl = (key) => {
  try { return document.querySelector(`.agy-root [data-decor-key="${CSS.escape(key)}"]`); } catch { return null; }
};
const crumbDuo = (key) => {
  try { return document.querySelector(`.agy-root [data-crumb-decor="${CSS.escape(key)}"] .agy-duo`); } catch { return null; }
};
const partsOf = (g) => (g ? {
  g,
  box: g.querySelector(':scope > .sb-box'),
  bar: g.querySelector(':scope > .sb-group-bar'),
  duo: g.querySelector(':scope > .sb-group-bar .agy-duo'),
} : null);

// 底板只露出标题那一行时，底边要裁掉多少（v=0 全裁、v=1 不裁）
function clipBox(p, v) {
  if (!p?.box || !p.bar) return;
  const H = p.g.offsetHeight;
  const hh = p.bar.offsetTop + p.bar.offsetHeight + 3;
  const cut = Math.max(0, (1 - clamp01(v)) * (H - hh));
  p.box.style.clipPath = `inset(0 0 ${cut.toFixed(1)}px 0 round 14px)`;
}
function clearInline(...els) {
  for (const el of els) if (el) { el.style.clipPath = ''; el.style.opacity = ''; el.style.transform = ''; el.style.visibility = ''; el.style.zIndex = ''; }
}

/**
 * Sidebar 的 $effect 调：每次 agy 侧外观换了一份就对一遍，哪些文件夹新出现、哪些没了。
 * items = 这一页全部外观条目（decorOf('agy') 展开后的 items）；loaded = 拉到过一次。
 */
export function trackDecor(items, loaded) {
  untrack(() => {
    const cur = new Map();
    for (const it of items || []) { const k = decorKey(it?.path); if (k && !cur.has(k)) cur.set(k, it); }
    if (!loaded) return;
    const first = seen === null;
    const prev = seen || new Set();
    seen = new Set(cur.keys());
    for (const [k, it] of cur) lastItem.set(k, it);
    if (first || reducedMotion()) {
      for (const k of prev) if (!cur.has(k)) lastItem.delete(k);
      return;
    }
    for (const k of prev) if (!cur.has(k)) runLeave(k);
    for (const k of cur.keys()) {
      if (prev.has(k)) {
        if (decorFx.leaving[k]) { nextTok(k); delete decorFx.leaving[k]; }   // 退场途中又回来了：直接停在「在」
        continue;
      }
      if (flight?.key === k) continue;   // 对话框那边的飞行接管
      runEnterInPlace(k);
    }
  });
}

async function runLeave(key) {
  const tok = nextTok(key);
  if (flight?.key === key) flight.cancel?.();
  delete decorFx.entering[key];
  delete decorFx.flying[key];
  const item = lastItem.get(key);
  lastItem.delete(key);
  if (!item) return;
  // 先把退场前那份外观挂回去（侧栏这一拍可能已经画成普通文件夹了），等 DOM 换好、还没上屏时再开演
  decorFx.leaving[key] = item;
  fxLog.kind = 'leave'; fxLog.key = key; fxLog.at = Date.now();
  await tick();
  const p = partsOf(groupEl(key));
  if (!p?.duo) { if (alive(key, tok)) delete decorFx.leaving[key]; return; }
  const stay = () => alive(key, tok);
  const s = p.duo.getBoundingClientRect().height || 20;
  const avc = p.duo.querySelector('.av-cl');
  const ava = p.duo.querySelector('.av-agy');
  if (avc) avc.style.zIndex = '0';
  // Claude 的圆先缩回 agy 后面，再一起淡出；底板晚一拍收回标题那一行
  tween(170, (e0) => {
    const e = emphAccel(e0);
    if (avc) { avc.style.transform = `translateX(${(-0.65 * s * e).toFixed(2)}px) scale(${(1 - 0.25 * e).toFixed(3)})`; avc.style.opacity = String(1 - e); }
  }, stay).then((ok) => ok && tween(120, (e0) => {
    const e = emphAccel(e0);
    if (ava) { ava.style.transform = `scale(${(1 - 0.4 * e).toFixed(3)})`; ava.style.opacity = String(1 - e); }
  }, stay));
  await sleep(120);
  if (!stay()) { clearInline(avc, ava, p.box); return; }
  const H = p.g.offsetHeight;
  const hh = p.bar ? p.bar.offsetTop + p.bar.offsetHeight + 3 : 30;
  await tween(220, (e0) => {
    const e = emphAccel(e0);
    if (p.box) { p.box.style.clipPath = `inset(0 0 ${(e * Math.max(0, H - hh)).toFixed(1)}px 0 round 14px)`; p.box.style.opacity = String(1 - e); }
  }, stay);
  await sleep(Math.max(0, LEAVE_MS - 340));
  if (!stay()) return;
  delete decorFx.leaving[key];
}

async function runEnterInPlace(key) {
  const tok = nextTok(key);
  const stay = () => alive(key, tok);
  fxLog.kind = 'enter'; fxLog.key = key; fxLog.at = Date.now();
  decorFx.entering[key] = true;
  await tick();   // DOM 已换成共用的样子、还没上屏：这时把底板裁到标题那一行，不会闪一帧全开的
  const p = partsOf(groupEl(key));
  if (!p?.box || !stay()) { if (stay()) delete decorFx.entering[key]; return; }
  clipBox(p, 0);
  p.box.style.opacity = '0';
  if (p.duo) { p.duo.style.opacity = '0'; p.duo.style.transform = 'scale(.6)'; }
  const t0 = performance.now();
  springTo(0, 1, [230, 0.92], (v) => {
    clipBox(p, v);
    p.box.style.opacity = String(clamp01((performance.now() - t0) / 170));
  }, stay).then(() => clearInline(p.box));
  await sleep(90);
  if (p.duo && stay()) {
    const t1 = performance.now();
    springTo(0.6, 1, [520, 0.48], (v) => {
      p.duo.style.transform = `scale(${v.toFixed(4)})`;
      p.duo.style.opacity = String(emphDecel(clamp01((performance.now() - t1) / 160)));
    }, stay).then(() => clearInline(p.duo));
  }
  await sleep(260);
  if (stay()) delete decorFx.entering[key];
}

/**
 * 对话框一按确定就调（动作请求和两圆靠拢同时开始）：先占住这个文件夹，外观要是先回来了也别就地演进场，等飞行来接。
 */
export function reserveFlight(path) {
  const key = decorKey(path);
  if (!key || reducedMotion()) return;
  const tok = nextTok(key);
  decorFx.entering[key] = true;
  decorFx.flying[key] = true;
  delete decorFx.leaving[key];
  fxLog.kind = 'enter'; fxLog.key = key; fxLog.at = Date.now(); fxLog.flown = true;
  // 等的人（撤销提示条）拿到的是「整段飞完」：起飞后接上真飞行的 done，没起飞就在放掉时了结
  let settle;
  const done = new Promise((r) => { settle = r; });
  flight = { key, tok, done, settle, cancel() {} };
  // 迟迟没起飞（对话框被打断）就放掉
  setTimeout(() => { if (flight?.key === key && flight.tok === tok && !flight.started) { flight = null; settle(); if (alive(key, tok)) { delete decorFx.entering[key]; delete decorFx.flying[key]; } } }, 3000);
}

/**
 * 对话框确认「设为」时调：heroEl = 对话框 hero 里那组头像（.agy-duo，已叠成一组）。
 * 做一份克隆提到最上层原处，等这个文件夹在侧栏里变成共用（外观重拉回来）再飞过去；4 秒没等到（动作失败、侧栏没开）就原地淡掉。
 */
export function launchFlight({ path, heroEl }) {
  const key = decorKey(path);
  const reserved = key && flight?.key === key && !flight.started ? flight : null;
  const r0 = heroEl?.getBoundingClientRect();
  if (!key || !heroEl || !r0?.width || reducedMotion()) {
    // 飞不了：放掉占位，外观回来时照常就地进场
    if (reserved) { flight = null; reserved.settle(); delete decorFx.entering[key]; delete decorFx.flying[key]; }
    return;
  }
  const host = heroEl.closest('.agy-root') || document.querySelector('.agy-root') || document.body;
  const tok = reserved ? reserved.tok : nextTok(key);
  const stay = () => alive(key, tok);
  fxLog.kind = 'enter'; fxLog.key = key; fxLog.at = Date.now();
  decorFx.entering[key] = true;
  decorFx.flying[key] = true;
  delete decorFx.leaving[key];

  const wrap = document.createElement('div');
  wrap.className = 'agy-decor-flyer';
  Object.assign(wrap.style, {
    position: 'fixed', left: r0.left + 'px', top: r0.top + 'px', width: r0.width + 'px', height: r0.height + 'px',
    zIndex: '120', pointerEvents: 'none', transformOrigin: '50% 50%', willChange: 'transform, filter',
    display: 'flex', alignItems: 'center',
  });
  const fly = heroEl.cloneNode(true);
  fly.style.setProperty('--agy-cut', 'var(--ag-box)');   // 缝的颜色从对话框底慢慢换成底板色（--agy-cut 注册过，会过渡）
  wrap.appendChild(fly);
  host.appendChild(wrap);
  heroEl.style.visibility = 'hidden';

  let cancelled = false;
  const live = () => !cancelled && stay();
  const finish = () => { wrap.remove(); delete decorFx.flying[key]; if (flight?.tok === tok) flight = null; };
  const cancel = () => { cancelled = true; finish(); };
  const c0 = { x: r0.left + r0.width / 2, y: r0.top + r0.height / 2 };

  const done = (async () => {
    // 等落点：侧栏里这一组的头像组（或者面包屑那组）出现
    const t0 = performance.now();
    let target = null;
    while (live() && performance.now() - t0 < 4000) {
      const p = partsOf(groupEl(key));
      if (p?.duo && p.duo.getClientRects().length) { target = p; break; }
      const cd = crumbDuo(key);
      if (cd && cd.getClientRects().length && performance.now() - t0 > 900) { target = { duo: cd }; break; }
      // 等的时候轻轻提着：上浮一点、投影出来
      const e = emphDecel(clamp01((performance.now() - t0) / 260));
      wrap.style.transform = `translateY(${(-4 * e).toFixed(2)}px)`;
      wrap.style.filter = `drop-shadow(0 ${(5 * e).toFixed(1)}px ${(10 * e).toFixed(1)}px rgba(0,0,0,${(0.22 * e).toFixed(3)}))`;
      await raf();
    }
    if (!target) {
      if (live()) {
        await tween(150, (e) => { wrap.style.opacity = String(1 - emphAccel(e)); });
        delete decorFx.entering[key];
      }
      finish();
      return;
    }
    const p = target.g ? target : null;
    try { p?.g.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); } catch {}
    if (p?.box) { clipBox(p, 0); p.box.style.opacity = '0'; }

    const sc1 = (target.duo.getBoundingClientRect().height || 20) / (r0.height || 46);
    let grew = false;
    const growBox = () => {
      if (!p?.box) return;
      const tb = performance.now();
      springTo(0, 1, [230, 0.92], (v) => {
        clipBox(p, v);
        p.box.style.opacity = String(clamp01((performance.now() - tb) / 170));
      }, live).then(() => clearInline(p.box));
    };
    const lifted = wrap.style.transform.match(/translateY\(([-\d.]+)px\)/);
    const lift0 = lifted ? parseFloat(lifted[1]) : 0;
    const ok = await tween(620, (t) => {
      const pp = emphasized(t);
      const sc = lerp(1, sc1, standard(Math.min(1, t * 1.08)));
      const tr = target.duo.getBoundingClientRect();
      const tg = { x: tr.left + tr.width / 2, y: tr.top + tr.height / 2 };
      const qx = (c0.x + tg.x) / 2 + 40;
      const qy = Math.min(c0.y, tg.y) - 70;
      const x = (1 - pp) ** 2 * c0.x + 2 * (1 - pp) * pp * qx + pp * pp * tg.x;
      const y = (1 - pp) ** 2 * (c0.y + lift0) + 2 * (1 - pp) * pp * qy + pp * pp * tg.y;
      wrap.style.transform = `translate(${(x - c0.x).toFixed(2)}px,${(y - c0.y).toFixed(2)}px) scale(${sc.toFixed(4)})`;
      const h = Math.sin(Math.PI * Math.min(1, t * 1.05));   // 投影跟着离地高度：中段最高、落地收回
      wrap.style.filter = `drop-shadow(0 ${(9 * h).toFixed(1)}px ${(16 * h).toFixed(1)}px rgba(0,0,0,${(0.32 * h).toFixed(3)}))`;
      if (!grew && t > 0.48) { grew = true; growBox(); }
    }, live);
    finish();
    if (!ok) { clearInline(p?.box); return; }
    // 落定轻顿：落点那组从 1.12 弹回 1
    springTo(1.12, 1, [520, 0.48], (v) => { target.duo.style.transform = `scale(${v.toFixed(4)})`; }, stay)
      .then(() => { target.duo.style.transform = ''; });
    await sleep(170);
    if (stay()) delete decorFx.entering[key];
    await sleep(300);
  })();

  if (reserved) done.then(reserved.settle);
  flight = { key, tok, done: reserved ? reserved.done : done, cancel, started: true };
}

/** 有飞行在跑就等它落定（撤销提示条等它落完再出来）。 */
export function flightSettled() {
  return flight?.done || Promise.resolve();
}

/** 顶栏 / 侧栏要画的那份外观：在的取在的，退场中的取退场前那份。 */
export function shownDecor(live, path) {
  if (live) return live;
  const k = decorKey(path);
  return (k && decorFx.leaving[k]) || null;
}
