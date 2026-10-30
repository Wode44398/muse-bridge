// 切换服务器的整段演出（档案的存取在 lib/serverProfiles.js）。
//
// 切走（这一页）：
//   ① 收：整个画面收进屏幕中央的方块（pageMorph.serverCollapse，开机揭幕倒着放），主页标题飞回方块中央；
//   ② 换：封面里旧品牌逐行化开、名字胶囊从旧服务器滚到新服务器，方块后亮起新服务器颜色的光晕、表面扫过一道光；
//      同时探一下新服务器在不在（只为提示一句「暂时连不上」，不拦切换——连不上照样进，有本地缓存可看）；
//   ③ 档案落地（commitSwitch）→ 交接条写进 sessionStorage → 整页重载。
// 落地（重载后）：index.html 里的脚本第一帧就把同一张封面原样重建（光晕相位按交接条续上），
//   主页模式交给预载方块张开成新服务器的主页（Preload 等 arrivalHold 再揭幕，揭幕那一拍 dropSwitchCover），
//   新品牌在方块中央逐行显影（BrandTitle 的 arrive）；单页模式 / 没有预载时由 App 调 finishArrival 收场。
// 不支持 View Transitions / 减弱动效：封面直接淡入、跳过化开，其余照旧。

import { tick } from 'svelte';
import { ui } from './state.svelte.js';
import { canMorph, serverCollapse } from './pageMorph.js';
import { EASE, reduced } from './motion.js';
import { DISTRO } from './distro.js';
import { listProfiles, commitSwitch, brandWordsOf } from './serverProfiles.js';
import { t } from './i18n.js';

const HANDOFF = 'bridge-switch';
const cover = () => (typeof window !== 'undefined' ? window.__bridgeSwitchCover : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 这次启动是不是切换服务器重载来的（index.html 读走的交接条）：{ at, t0, glass, name, color } | null */
export const arrival = (typeof window !== 'undefined' && window.__bridgeSwitchArrive) || null;

// 探一下目标服务器（/healthz，零负载、不要鉴权）。局域网候选和公网地址谁先通算谁。
function probe(p, ms = 2500) {
  const one = (b) => new Promise((resolve) => {
    if (!b) return resolve(false);
    const ctl = new AbortController();
    const timer = setTimeout(() => { ctl.abort(); resolve(false); }, ms);
    fetch(b + '/healthz', { cache: 'no-store', signal: ctl.signal, credentials: 'omit' })
      .then((r) => resolve(r.ok), () => resolve(false)).finally(() => clearTimeout(timer));
  });
  return new Promise((resolve) => {
    let left = 0;
    const done = (ok) => { if (ok) resolve(true); else if (--left <= 0) resolve(false); };
    const bases = [p.base, p.lan].filter(Boolean);
    left = bases.length;
    if (!left) return resolve(false);
    bases.forEach((b) => one(b).then(done));
  });
}

let busy = false;
export const switchBusy = () => busy;

/**
 * 切到档案 id；id 为 null = 添加一台新服务器（建空档案，重载后落到「连接你的 bridge 服务器」）。
 */
export async function switchServer(id = null) {
  if (busy) return;
  const C = cover();
  const list = listProfiles();
  const cur = list.find((p) => p.active);
  const tgt = id ? list.find((p) => p.id === id) : null;
  if (id && (!tgt || tgt.active)) return;
  busy = true;
  const glass = ui.glassMode === 'A' ? 'A' : 'B';
  const toName = tgt ? tgt.name : t('新的服务器');
  const toColor = tgt ? tgt.color : '#8e8e93';
  const alive = tgt ? probe(tgt) : Promise.resolve(true);
  const t0 = Date.now();
  const fancy = !!C && !reduced();

  const mount = async () => {
    C?.build({ out: true, glass, name: cur?.name || DISTRO.brand, color: cur?.color || '#8e8e93', brand: brandWordsOf(DISTRO.brand), t0 });
    ui.serverSwitching = true;
    ui.serverSwitcherOpen = false;
    await tick();
  };

  // ① 收
  if (fancy && canMorph()) await serverCollapse({ apply: mount });
  else {
    await mount();
    C?.get()?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: EASE.fade });
    await sleep(200);
  }

  // ② 换
  const el = C?.get();
  if (el) {
    el.style.setProperty('--sw-c', toColor);
    el.style.setProperty('--sw-t', '0ms');
    el.classList.add('glow');
    if (fancy) {
      const lines = [...el.querySelectorAll('.sw-brand span')];
      lines.forEach((ln, i) => ln.animate([
        { opacity: 1, transform: 'translateY(0)', filter: 'blur(0px)' },
        { opacity: 0, transform: 'translateY(-.5em)', filter: 'blur(7px)' },
      ], { duration: 380, delay: 40 + i * 80, easing: EASE.accel, fill: 'forwards' }));
      rollName(el, toName, toColor);
    } else {
      el.querySelector('.sw-brand')?.remove();
      const pill = el.querySelector('.sw-pill');
      if (pill) pill.replaceChildren(C.nameEl(toName, toColor));
    }
  }
  // 至少让新光晕亮一会儿；探活最多再等到 1.5s（不通也照样进，只是提示一句）
  const ok = await Promise.race([Promise.all([alive, sleep(fancy ? 640 : 260)]).then(([a]) => a), sleep(1500).then(() => null)]);
  if (ok === false && el) {
    const note = el.querySelector('.sw-note');
    if (note) {
      note.textContent = t('暂时连不上，进去后会自动重连');
      note.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, easing: EASE.fade });
      await sleep(700);
    }
  }

  // ③ 落地
  if (!commitSwitch(id)) { C?.drop(); ui.serverSwitching = false; busy = false; return; }
  try {
    sessionStorage.setItem(HANDOFF, JSON.stringify({ at: Date.now(), t0, glass, name: toName, color: toColor }));
  } catch {}
  location.reload();
}

// 名字胶囊：旧名字往上滚出、新名字从下面滚进来（胶囊宽度跟着新名字收放）
function rollName(el, name, color) {
  const C = cover();
  const pill = el.querySelector('.sw-pill');
  const old = pill?.querySelector('.sw-name');
  if (!pill || !old || !C) return;
  const w0 = pill.offsetWidth;
  const nu = C.nameEl(name, color);
  pill.appendChild(nu);
  const w1 = nu.offsetWidth + 28;
  nu.style.position = 'absolute';
  pill.style.width = w0 + 'px';
  pill.animate([{ width: w0 + 'px' }, { width: Math.max(60, w1) + 'px' }], { duration: 460, delay: 120, easing: EASE.std, fill: 'forwards' });
  old.animate([{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(-26px)', opacity: 0 }],
    { duration: 340, delay: 120, easing: EASE.accel, fill: 'forwards' });
  nu.animate([{ transform: 'translateY(26px)', opacity: 0 }, { transform: 'translateY(0)', opacity: 1 }],
    { duration: 520, delay: 220, easing: EASE.settle, fill: 'backwards' });
}

/** 预载在揭幕前等一等：交接后封面至少停留这么久，新品牌显影完再张开 */
export function arrivalHold() {
  if (!arrival) return Promise.resolve();
  const left = 720 - (Date.now() - arrival.at);
  return left > 0 ? sleep(left) : Promise.resolve();
}

/** 预载揭幕那一拍撤掉封面（它在预载方块之上，留着会挡住张开的窗） */
export function dropSwitchCover() { cover()?.drop(); }

/** 没有预载接手时（单页模式、减弱动效）由 App 收场：方块放大化开、底色淡去 */
export async function finishArrival() {
  const el = cover()?.get();
  if (!el) return;
  await arrivalHold();
  if (reduced()) { cover()?.drop(); return; }
  const blk = el.querySelector('.sw-block');
  const d = 460;
  blk?.animate([{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(5)', opacity: 0 }], { duration: d, easing: EASE.accel, fill: 'forwards' });
  for (const s of el.querySelectorAll('.sw-halo, .sw-cap')) s.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 220, easing: EASE.fade, fill: 'forwards' });
  el.querySelector('.sw-bg')?.animate([{ opacity: 1 }, { opacity: 0 }], { duration: d, delay: 120, easing: EASE.fade, fill: 'forwards' });
  await sleep(d + 140);
  cover()?.drop();
}
