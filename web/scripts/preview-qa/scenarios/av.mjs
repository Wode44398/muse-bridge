// 音视频播放器（VideoPlayer / AudioPlayer）：控件自动隐藏与唤出、单击 / 双击、每个快捷键的效果值、
// 触屏双击跳转 / 长按 2× / 横向拖动 seek、设置菜单、续播与偏好记忆、播完（重播 / 下一个倒计时）、
// 音频流式（首帧前下载的字节必须远小于文件）。标签 av（不进 baseline：基线上没有这些能力）。
// 取数只看 <video>/<audio> 元素本身（currentTime / volume / playbackRate / paused）、document.fullscreenElement、
// 进度滑块（role=slider）的实际不透明度、aria-label 与可见文字；不绑播放器内部类名（只有 info 级的佐证除外）。
import { statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const V1080 = '视频/1080p-h264-带声.mp4';   // 30 秒，同名 .vtt 字幕（每 3 秒一句「第 n 句字幕」）
const VPORT = '视频/竖拍-1080x1920.mp4';     // 15 秒
const VSHORT = '视频/无声-短.mp4';           // 5 秒、无音轨
const VLONG = '视频/长片-6分钟.mp4';          // 360 秒
const ALONG = '音频/长音频-40分钟.mp3';       // 约 14MB
const AUDIO_DIR = '音频';

const near = (a, b, tol = 0.6) => Number.isFinite(a) && Math.abs(a - b) <= tol;

// 页面侧的状态快照：只读媒体元素与通用信号
const ST = `(() => {
  const r = __pvqa.root(); const v = r && r.querySelector('video, audio'); if (!v) return null;
  const sl = r.querySelector('[role=slider][aria-label="进度"]') || r.querySelector('[role=slider]');
  const txt = r.innerText || '';
  return { t: +v.currentTime.toFixed(3), dur: Number.isFinite(v.duration) ? +v.duration.toFixed(2) : null, paused: v.paused, ended: v.ended,
    vol: +v.volume.toFixed(3), muted: v.muted, rate: v.playbackRate, rs: v.readyState,
    fs: !!document.fullscreenElement || !!r.querySelector('[aria-label^="退出全屏"]'), nativeFs: !!document.fullscreenElement,
    chrome: sl ? +__pvqa.effOpacity(sl).toFixed(2) : null, cursor: getComputedStyle(v).cursor,
    index: __pvqa.pv.preview.index, subs: /第 \\d+ 句字幕/.test(txt), next: txt.includes('接下来'), resume: /从 [0-9:]+ 继续/.test(txt) };
})()`;
const st = (ctx) => ctx.eval(ST);

// 带用户激活执行（等同用户点了一下：放开自动播放、全屏等需要手势的 API）
async function gesture(ctx, expr) {
  const r = await ctx.pg.send('Runtime.evaluate', { expression: expr, userGesture: true, awaitPromise: true, returnByValue: true }, 15000);
  return r?.result?.value;
}
const prime = (ctx) => gesture(ctx, '1').catch(() => {});
const gesturePlay = (ctx) => gesture(ctx, `(async () => { const v = __pvqa.root()?.querySelector('video, audio'); if (!v) return 'no-el'; try { await v.play(); return 'ok'; } catch (e) { return String(e.message || e); } })()`).catch((e) => String(e.message || e));

async function clearAv(ctx) {
  await ctx.eval(`(() => { try { localStorage.removeItem('pv.av'); localStorage.removeItem('pv.resume'); } catch {} return true; })()`).catch(() => {});
}

/** 打开并等到可播（readyState≥2、时长已知）；want='playing' 时再等到在播（自动播放被拦就补一次带手势的 play） */
async function openMedia(ctx, items, index = 0, { want = 'ready', tag = 'video', timeout = 25000 } = {}) {
  await prime(ctx);
  const t0 = Date.now();
  await ctx.open(items, index);
  const rs = tag === 'audio' ? 1 : 2;
  const ok = await ctx.waitFor(`(() => { const v = __pvqa.root()?.querySelector(${JSON.stringify(tag)}); return v && v.readyState >= ${rs} && v.duration > 0 ? true : null; })()`, timeout, tag + ' 可播').catch(() => false);
  ctx.metric('openMs', ok ? Date.now() - t0 : null);
  ctx.assert(tag + ' 可播', !!ok, ok);
  if (!ok) return false;
  if (want === 'playing') {
    let p = await ctx.waitFor(`(() => { const v = __pvqa.root()?.querySelector(${JSON.stringify(tag)}); return v && !v.paused && v.currentTime > 0.05 ? true : null; })()`, 4000, '自动播放').catch(() => false);
    ctx.metric('autoplay', !!p);
    if (!p) {
      ctx.metric('gesturePlay', await gesturePlay(ctx));
      p = await ctx.waitFor(`(() => { const v = __pvqa.root()?.querySelector(${JSON.stringify(tag)}); return v && !v.paused && v.currentTime > 0.05 ? true : null; })()`, 8000, '开始播放').catch(() => false);
    }
    ctx.assert('开始播放', !!p, p);
    return !!p;
  }
  return true;
}

// 暂停 + 定位（直接操作元素，等 seeked）
async function pauseAt(ctx, t) {
  await ctx.eval(`(async () => { const v = __pvqa.root().querySelector('video, audio'); v.pause(); if (${t} >= 0 && Math.abs(v.currentTime - ${t}) > 0.05) { await new Promise((r) => { v.addEventListener('seeked', r, { once: true }); v.currentTime = ${t}; setTimeout(r, 3000); }); } return true; })()`);
  await ctx.sleep(250);
}

// 悬停态截图：ctx.shot 会先把指针挪出视口（悬停气泡随之收起），这里直接抓一帧、只落盘不做通用检测
async function hoverShot(ctx, name) {
  try {
    const r = await ctx.pg.send('Page.captureScreenshot', { format: 'jpeg', quality: 80 }, 15000);
    writeFileSync(path.join(ctx.outDir, `${ctx.sc.id}-${name}.jpg`), Buffer.from(r.data, 'base64'));
  } catch {}
}

// 视频画面上叠了 backdrop-filter 的元素（规范：视频上方不许毛玻璃——唯一的例外是触屏中央三钮的液态玻璃底，
// 它只在按钮露着时挂，见 GLASS_LIVE）
const BD_OVER_VIDEO = `(() => { const r = __pvqa.root(); const v = r && r.querySelector('video'); if (!v) return [];
  const vr = v.getBoundingClientRect(); const out = [];
  for (const el of r.querySelectorAll('*')) { if (el.classList.contains('lq-glass') || el.classList.contains('vp-cbtn')) continue;
    const s = getComputedStyle(el); const bf = s.backdropFilter || s.webkitBackdropFilter; if (!bf || bf === 'none') continue;
    const b = el.getBoundingClientRect(); if (b.width < 1 || b.height < 1 || __pvqa.effOpacity(el) < 0.05) continue;
    if (b.right > vr.left && b.left < vr.right && b.bottom > vr.top && b.top < vr.bottom) out.push((el.className && typeof el.className === 'string' ? el.className.split(/\\s+/).filter((c) => !/^svelte-/.test(c)).slice(0, 2).join('.') : el.tagName) + ' ' + bf); }
  return out.slice(0, 6); })()`;

// 中央三钮的玻璃底：还在参与合成的（display 不是 none、带 backdrop-filter）有几块、按钮下面各有没有垫着一块
const GLASS_LIVE = `(() => { const r = __pvqa.root(); if (!r) return null;
  const live = [...r.querySelectorAll('.lq-glass, .vp-cbtn')].filter((el) => { const s = getComputedStyle(el); const bf = s.backdropFilter || s.webkitBackdropFilter; return s.display !== 'none' && bf && bf !== 'none'; });
  const btns = [...r.querySelectorAll('.vp-cbtn')].map((b) => b.getBoundingClientRect());
  const under = btns.filter((b) => live.some((g) => { const q = g.getBoundingClientRect(); return Math.abs(q.left - b.left) < 2 && Math.abs(q.top - b.top) < 2 && Math.abs(q.width - b.width) < 2; })).length;
  return { live: live.length, btns: btns.length, under, svg: live.some((el) => (getComputedStyle(el).backdropFilter || '').includes('url(')) }; })()`;

// 原始触摸（场景里要在手势中途取值：长按中读倍速、拖动中看气泡）
const tp = (x, y) => [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }];
const touchStart = (ctx, x, y) => ctx.pg.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: tp(x, y) });
const touchMove = (ctx, x, y) => ctx.pg.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: tp(x, y) });
const touchEnd = (ctx) => ctx.pg.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });

// CDP 网络记账：url 命中 match 的请求各收了多少字节（dataReceived 累加）
async function netWatch(ctx, match) {
  const { pg } = ctx; const sid = pg.sessionId;
  const w = { on: true, reqs: new Map(), bytes: 0 };
  await pg.send('Network.enable');
  pg.conn.on('Network.requestWillBeSent', (p, s) => {
    if (!w.on || s !== sid || !match(p.request.url)) return;
    const h = p.request.headers || {};
    w.reqs.set(p.requestId, { url: p.request.url.replace(/^https?:\/\/[^/]+/, '').slice(0, 120), type: p.type, range: h.Range || h.range || '', bytes: 0 });
  });
  pg.conn.on('Network.dataReceived', (p, s) => {
    if (!w.on || s !== sid) return;
    const r = w.reqs.get(p.requestId); if (!r) return;
    const n = p.encodedDataLength || p.dataLength || 0;
    r.bytes += n; w.bytes += n;
  });
  return w;
}

export default [
  // —— 电脑：控件自动隐藏 / 唤出、光标隐藏、单击播放暂停、双击全屏、进度轨悬停 ——
  {
    id: 'av-video-desktop',
    title: '视频（电脑）：自动隐藏与唤出、单击 / 双击、进度轨悬停',
    tags: ['av'], only: (cfg) => !cfg.touch, timeout: 90000,
    async run(ctx) {
      await clearAv(ctx);
      if (!(await openMedia(ctx, [ctx.item(V1080, { kind: 'video' })], 0, { want: 'playing' }))) return;
      const { w, h } = ctx.cfg;
      const cx = w / 2, cy = h * 0.45;
      await ctx.g.hover(cx, cy, { steps: 4, ms: 120 });
      await ctx.sleep(400);
      const s1 = await st(ctx);
      ctx.assert('鼠标一动控件出现', s1.chrome > 0.9, s1.chrome);
      await ctx.sleep(3300);   // 静止 2.5s 后收起（再加过渡）
      const s2 = await st(ctx);
      ctx.metric('hidden', { chrome: s2.chrome, cursor: s2.cursor });
      ctx.assert('静止约 2.5 秒后控件收起', s2.chrome < 0.05, s2.chrome);
      ctx.assert('控件收起时光标也藏起来', s2.cursor === 'none', s2.cursor);
      await ctx.g.hover(cx + 30, cy + 10, { steps: 3, ms: 90 });
      await ctx.sleep(400);
      const s3 = await st(ctx);
      ctx.assert('再动一下控件回来', s3.chrome > 0.9 && s3.cursor !== 'none', { chrome: s3.chrome, cursor: s3.cursor });

      // 单击：播放 ↔ 暂停（中央闪一下）
      await ctx.g.tap(cx, cy);
      await ctx.sleep(120);
      const flash = await ctx.eval(`!!__pvqa.root().querySelector('.vp-flash')`).catch(() => null);
      await ctx.sleep(400);
      const s4 = await st(ctx);
      ctx.assert('单击暂停', s4.paused === true, s4.paused);
      ctx.assert('单击时中央闪播放 / 暂停图标', flash, flash, { level: 'info' });
      ctx.assert('暂停时控件常驻', s4.chrome > 0.9, s4.chrome);
      await ctx.g.tap(cx, cy);
      await ctx.sleep(500);
      const s5 = await st(ctx);
      ctx.assert('再单击继续播放', s5.paused === false, s5.paused);

      // 双击：进全屏，播放状态不变（两下单击互相抵消）
      await ctx.g.doubleTap(cx, cy, { gap: 90 });
      await ctx.sleep(900);
      const s6 = await st(ctx);
      ctx.metric('fsAfterDbl', { fs: s6.fs, native: s6.nativeFs, paused: s6.paused });
      ctx.assert('双击进全屏', s6.fs, s6);
      ctx.assert('双击后仍在播放', s6.paused === false, s6.paused);
      await ctx.g.doubleTap(cx, cy, { gap: 90 });
      await ctx.sleep(900);
      const s7 = await st(ctx);
      ctx.assert('再双击退出全屏', !s7.fs, s7.fs);

      // 进度轨悬停：出时间气泡（有 storyboard 时带缩略帧）
      await pauseAt(ctx, 8);
      const rail = await ctx.g.center('[role=slider][aria-label="进度"]', { within: ctx.ROOT_SEL }).catch(() => null);
      ctx.assert('找到进度轨', !!rail, rail);
      if (rail) {
        await ctx.g.hover(rail.x - rail.w * 0.2, rail.y, { steps: 5, ms: 150 });
        await ctx.sleep(1500);   // storyboard 懒拉（服务端首次生成要几秒）
        await ctx.g.hover(rail.x - rail.w * 0.18, rail.y, { steps: 2, ms: 60 });
        await ctx.sleep(500);
        const tip = await ctx.eval(`(() => { const r = __pvqa.root(); const t = [...r.querySelectorAll('*')].find((e) => e.children.length === 0 && /^\\d+:\\d\\d$/.test((e.textContent || '').trim()) && __pvqa.effOpacity(e) > 0.5 && e.getBoundingClientRect().bottom < ${rail.y});
          const sb = [...r.querySelectorAll('*')].some((e) => /storyboard/.test(getComputedStyle(e).backgroundImage || '') && __pvqa.effOpacity(e) > 0.5);
          return { text: t ? t.textContent.trim() : null, storyboard: sb }; })()`);
        ctx.metric('railTip', tip);
        ctx.assert('进度轨悬停出时间气泡', !!tip.text, tip.text);
        // 按住拖动：不松手画面就跟到拖到的位置（30 秒的片，轨道 80% 处 = 24 秒），松手停在那儿（拖之前是暂停的，松手仍暂停）
        const mouse = (type, x, y, buttons) => ctx.pg.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 });
        const rx = (q) => rail.x - rail.w / 2 + rail.w * q;
        await mouse('mousePressed', rx(0.5), rail.y, 1);
        for (let i = 1; i <= 6; i++) { await mouse('mouseMoved', rx(0.5 + 0.05 * i), rail.y, 1); await ctx.sleep(40); }
        await ctx.sleep(500);
        const mid = await st(ctx);
        await hoverShot(ctx, 'rail-drag');
        await mouse('mouseReleased', rx(0.8), rail.y, 0);
        await ctx.sleep(500);
        const end = await st(ctx);
        ctx.metric('railDrag', { midT: mid.t, endT: end.t, endPaused: end.paused });
        ctx.assert('拖进度轨没松手画面已到 80% 处（实时出帧）', near(mid.t, (mid.dur || 30) * 0.8, 1.5), mid.t);
        ctx.assert('松手停在拖到的位置、仍是暂停', near(end.t, (end.dur || 30) * 0.8, 1.5) && end.paused, { t: end.t, paused: end.paused });
        ctx.assert('悬停气泡带 storyboard 缩略帧', tip.storyboard, tip.storyboard, { level: 'goal' });
        await hoverShot(ctx, 'rail-hover');
      }
      // 音量：悬停喇叭展开横向滑条
      const mute = await ctx.g.center('button[aria-label^="静音"], button[aria-label^="取消静音"]', { within: ctx.ROOT_SEL }).catch(() => null);
      if (mute) {
        await ctx.g.hover(mute.x, mute.y, { steps: 4, ms: 120 });
        await ctx.sleep(450);
        const vw = await ctx.eval(`(() => { const s = __pvqa.root().querySelector('[role=slider][aria-label="音量"]'); return s ? Math.round(s.getBoundingClientRect().width * __pvqa.effOpacity(s)) : 0; })()`);
        ctx.metric('volSliderW', vw);
        await hoverShot(ctx, 'vol-hover');
        ctx.assert('悬停喇叭展开音量滑条', vw >= 40, vw);
      }
      const bd = await ctx.eval(BD_OVER_VIDEO);
      ctx.assert('视频上方没有 backdrop-filter', !bd.length, bd);
    },
  },

  // —— 电脑：每个快捷键的效果值 ——
  {
    id: 'av-video-keys',
    title: '视频（电脑）：快捷键逐个核对 currentTime / volume / playbackRate / 全屏 / 字幕 / 翻页',
    tags: ['av'], only: (cfg) => !cfg.touch, timeout: 120000,
    async run(ctx) {
      await clearAv(ctx);
      const items = [ctx.item(V1080, { kind: 'video' }), ctx.item(VPORT, { kind: 'video' })];
      if (!(await openMedia(ctx, items, 0, { want: 'playing' }))) return;
      await ctx.g.hover(ctx.cfg.w / 2, ctx.cfg.h / 2, { steps: 2, ms: 60 });
      await ctx.g.pointerOut();
      // 空格 / K：播放 ↔ 暂停
      await ctx.g.key('space'); await ctx.sleep(300);
      let s = await st(ctx);
      ctx.assert('空格暂停', s.paused, s.paused);
      await ctx.g.key('k'); await ctx.sleep(400);
      s = await st(ctx);
      ctx.assert('K 播放', !s.paused, s.paused);
      await ctx.g.key('k'); await ctx.sleep(300);
      s = await st(ctx);
      ctx.assert('K 暂停', s.paused, s.paused);

      const dur = s.dur || 30;
      const rows = [];
      const check = async (spec, name, pred, wait = 350) => {
        await ctx.g.key(spec); await ctx.sleep(wait);
        const x = await st(ctx);
        const ok = pred(x);
        rows.push({ key: spec, t: x.t, vol: x.vol, muted: x.muted, rate: x.rate, fs: x.fs, subs: x.subs, index: x.index, ok });
        ctx.assert(name, ok, { t: x.t, vol: x.vol, muted: x.muted, rate: x.rate, fs: x.fs, subs: x.subs, index: x.index });
        return x;
      };
      await check('home', 'Home → 0', (x) => near(x.t, 0));
      await check('l', 'L → +10s', (x) => near(x.t, 10));
      await check('j', 'J → −10s', (x) => near(x.t, 0));
      await check('arrowright', '→ → +10s', (x) => near(x.t, 10));
      await check('arrowright', '→ 再 +10s', (x) => near(x.t, 20));
      await check('arrowleft', '← → −10s', (x) => near(x.t, 10));
      await check('5', '5 → 50%', (x) => near(x.t, dur * 0.5));
      await check('0', '0 → 开头', (x) => near(x.t, 0));
      await check('9', '9 → 90%', (x) => near(x.t, dur * 0.9));
      const f0 = await check('5', '5 → 50%（为逐帧复位）', (x) => near(x.t, dur * 0.5));
      const f1 = await check('.', '. → 暂停时前进一帧', (x) => x.t > f0.t + 0.005 && x.t < f0.t + 0.2);
      await check(',', ', → 暂停时后退一帧', (x) => x.t < f1.t - 0.005 && x.t > f1.t - 0.2);
      await check('arrowdown', '↓ → 音量 −5%', (x) => near(x.vol, 0.95, 0.011));
      await check('arrowdown', '↓ → 音量再 −5%', (x) => near(x.vol, 0.9, 0.011));
      await check('arrowup', '↑ → 音量 +5%', (x) => near(x.vol, 0.95, 0.011));
      await check('m', 'M → 静音', (x) => x.muted === true);
      await check('m', 'M → 取消静音', (x) => x.muted === false && near(x.vol, 0.95, 0.011));
      await check('shift+.', 'Shift+. (>) → 1.25×', (x) => x.rate === 1.25);
      await check('shift+.', 'Shift+. (>) → 1.5×', (x) => x.rate === 1.5);
      await check('<', '< → 1.25×', (x) => x.rate === 1.25);
      await check('shift+,', 'Shift+, (<) → 1×', (x) => x.rate === 1);
      await pauseAt(ctx, 16);   // 落在一句字幕中间（每 3 秒一句、各 2.5 秒），别卡在句子交界
      const s0 = await st(ctx);
      ctx.metric('subsAtStart', s0.subs);
      ctx.assert('同名 .vtt 字幕默认开启', s0.subs, s0.subs);
      await check('c', 'C → 字幕切换', (x) => x.subs === !s0.subs);
      await check('c', 'C → 字幕切回', (x) => x.subs === s0.subs);
      await check('f', 'F → 进全屏', (x) => x.fs, 900);
      await ctx.shot('fullscreen');
      await check('f', 'F → 退出全屏', (x) => !x.fs, 900);
      const pip = await ctx.eval(`!!document.pictureInPictureEnabled`).catch(() => false);
      ctx.metric('pipEnabled', pip);
      if (pip) {
        await ctx.g.key('i'); await ctx.sleep(900);
        const inPip = await ctx.eval(`!!document.pictureInPictureElement`);
        ctx.assert('I → 画中画', inPip, inPip, { level: 'goal' });
        if (inPip) await ctx.eval(`document.exitPictureInPicture().then(() => 1, () => 0)`).catch(() => {});
        await ctx.sleep(400);
      }
      // 状态气泡（倍速 / 音量变化后的顶部提示）：info 佐证
      await ctx.g.key('shift+.'); await ctx.sleep(150);
      const osd = await ctx.eval(`(() => { const r = __pvqa.root(); return [...r.querySelectorAll('b')].map((b) => b.textContent.trim()).find((x) => /×$/.test(x)) || null; })()`).catch(() => null);
      ctx.assert('按键后出状态气泡（倍速）', osd === '1.25×', osd, { level: 'info' });
      await ctx.g.key('shift+,'); await ctx.sleep(250);
      // 翻页：PageDown / PageUp，Shift+N 下一个视频；方向键始终是 seek 不翻页
      await check('pagedown', 'PageDown → 下一个', (x) => x.index === 1, 1200);
      await check('pageup', 'PageUp → 上一个', (x) => x.index === 0, 1200);
      await ctx.waitFor(`(() => { const v = __pvqa.root()?.querySelector('video'); return v && v.readyState >= 1; })()`, 10000, '回到第一个').catch(() => {});
      await check('shift+n', 'Shift+N → 下一个视频', (x) => x.index === 1, 1200);
      ctx.metric('_keys', rows);
    },
    async cleanup(ctx) { await clearAv(ctx); },
  },

  // —— 触屏：轻点显隐、双击两侧跳转（累计）、长按 2×、横向拖动 seek ——
  {
    id: 'av-video-touch',
    title: '视频（触屏）：轻点显隐 / 自动隐藏、双击左右跳 10 秒、长按 2×、横向拖动 seek',
    tags: ['av'], only: (cfg) => cfg.touch, timeout: 120000,
    async run(ctx) {
      await clearAv(ctx);
      if (!(await openMedia(ctx, [ctx.item(V1080, { kind: 'video' })], 0, { want: 'playing' }))) return;
      const { w, h } = ctx.cfg;
      await ctx.sleep(3700);   // 播放中 3 秒自动收起
      let s = await st(ctx);
      ctx.assert('播放中约 3 秒后控件收起', s.chrome < 0.05, s.chrome);
      await ctx.g.tap(w * 0.5, h * 0.3);
      await ctx.sleep(450);
      s = await st(ctx);
      ctx.assert('轻点唤出控件', s.chrome > 0.9, s.chrome);
      await ctx.shot('controls');
      await ctx.sleep(400);   // 和上一下拉开，别被认成双击
      await ctx.g.tap(w * 0.5, h * 0.3);
      await ctx.sleep(450);
      s = await st(ctx);
      ctx.assert('再轻点收起控件', s.chrome < 0.05, s.chrome);

      // 双击右侧三分之一：+10；跳转指示存活期内同侧再点一下：再 +10；双击左侧：−10
      await pauseAt(ctx, 5);
      const xr = w * 0.88, xl = w * 0.12, y = h * 0.4;
      await ctx.g.doubleTap(xr, y, { gap: 110 });
      await ctx.sleep(120);
      const ripple = await ctx.eval(`(() => { const r = __pvqa.root(); return [...r.querySelectorAll('span')].map((e) => e.textContent.trim()).find((x) => /^\\d+ 秒$/.test(x)) || null; })()`).catch(() => null);
      await ctx.sleep(200);
      s = await st(ctx);
      ctx.assert('双击右侧 → +10s', near(s.t, 15), s.t);
      ctx.assert('双击出跳转指示（累计秒数）', ripple === '10 秒', ripple, { level: 'info' });
      await ctx.g.tap(xr, y, { hold: 40 });
      await ctx.sleep(300);
      s = await st(ctx);
      ctx.assert('同侧连点累计 → 再 +10s', near(s.t, 25), s.t);
      await ctx.sleep(900);   // 等指示消失
      await ctx.g.doubleTap(xl, y, { gap: 110 });
      await ctx.sleep(350);
      s = await st(ctx);
      ctx.assert('双击左侧 → −10s', near(s.t, 15), s.t);
      await ctx.sleep(900);

      // 长按：2× 快进，松手复原
      await pauseAt(ctx, 2);
      await gesturePlay(ctx);
      await ctx.waitFor(`!__pvqa.root().querySelector('video').paused`, 5000, '继续播放').catch(() => {});
      await ctx.sleep(300);
      await touchStart(ctx, w * 0.5, h * 0.3);
      await ctx.sleep(800);
      const lp = await st(ctx);
      await ctx.shot('longpress-2x');
      await touchEnd(ctx);
      await ctx.sleep(300);
      const lpEnd = await st(ctx);
      ctx.metric('longPress', { during: lp.rate, after: lpEnd.rate });
      ctx.assert('长按 → 2×', lp.rate === 2, lp.rate);
      ctx.assert('松手 → 复原 1×', lpEnd.rate === 1, lpEnd.rate);
      ctx.assert('长按松手不算轻点（仍在播放）', lpEnd.paused === false, lpEnd.paused);

      // 横向拖动 seek：40% 屏宽 ≈ 0.4 × min(时长, 90s) = +12s，中途出时间胶囊；不等松手，画面已经跟到拖到的位置
      await pauseAt(ctx, 5);
      await ctx.sleep(400);
      const x0 = w * 0.3, x1 = w * 0.7, ys = h * 0.3;
      await touchStart(ctx, x0, ys);
      for (let i = 1; i <= 12; i++) { await touchMove(ctx, x0 + ((x1 - x0) * i) / 12, ys); await ctx.sleep(25); }
      await ctx.sleep(450);
      const bubble = await ctx.eval(`(() => { const txt = __pvqa.root().innerText || ''; const m = /\\+(\\d+:\\d\\d)/.exec(txt); return m ? m[1] : null; })()`);
      const live = await st(ctx);
      await ctx.shot('seek-bubble');
      await touchEnd(ctx);
      await ctx.sleep(500);
      s = await st(ctx);
      ctx.metric('dragSeek', { bubble, liveT: live.t, t: s.t });
      ctx.assert('拖动中出 seek 气泡（+偏移）', !!bubble, bubble);
      ctx.assert('没松手画面已经跟到拖到的位置（实时出帧）', near(live.t, 17, 1.5), live.t);
      ctx.assert('横向拖动 40% 宽 → 约 +12s', near(s.t, 17, 1.5), s.t);

      // 进度轨拖动：按住不放，画面同样实时跟随；拖之前在播的，松手后接着播
      await ctx.g.tap(w / 2, h * 0.3); await ctx.sleep(300);   // 唤出控件
      await gesturePlay(ctx); await ctx.sleep(500);
      const rail = await ctx.eval(`(() => { const sl = __pvqa.root().querySelector('[role=slider][aria-label="进度"]'); if (!sl) return null; const b = sl.getBoundingClientRect(); return { x: b.left, y: b.top + b.height / 2, w: b.width }; })()`);
      if (rail) {
        await ctx.g.tap(w / 2, h * 0.3); await ctx.sleep(250);
        const shown = (await st(ctx)).chrome > 0.9;
        if (!shown) { await ctx.g.tap(w / 2, h * 0.3); await ctx.sleep(250); }
        await touchStart(ctx, rail.x + rail.w * 0.2, rail.y);
        for (let i = 1; i <= 10; i++) { await touchMove(ctx, rail.x + rail.w * (0.2 + 0.05 * i), rail.y); await ctx.sleep(30); }
        await ctx.sleep(450);
        const mid = await st(ctx);
        await ctx.shot('rail-drag');
        await touchEnd(ctx);
        await ctx.sleep(700);
        const end = await st(ctx);
        ctx.metric('railDrag', { midT: mid.t, midPaused: mid.paused, endT: end.t, endPaused: end.paused });
        ctx.assert('拖进度轨没松手画面已到 70% 处', near(mid.t, (mid.dur || 30) * 0.7, 2), mid.t);
        ctx.assert('松手后接着播（拖之前在播）', end.paused === false, end.paused);
      } else ctx.assert('找到进度轨', false, rail);

      // 液态玻璃三钮：露着时每个按钮下面垫着一块玻璃；播放中控件收起后一块滤镜都不留（display:none，不占合成）
      await ctx.eval(`(() => { __pvqa.root().querySelector('video').pause(); return true; })()`);
      await ctx.sleep(600);
      const g1 = await ctx.eval(GLASS_LIVE);
      await ctx.shot('glass-cluster');
      ctx.metric('glass', g1);
      ctx.assert('暂停时三钮露着、各垫一块玻璃', g1 && g1.btns === 3 && g1.under === 3, g1);
      ctx.assert('玻璃是折射材质（SVG backdrop）', !!g1?.svg, g1, { level: 'goal' });
      await gesturePlay(ctx);
      await ctx.sleep(3900);
      const g2 = await ctx.eval(GLASS_LIVE);
      ctx.assert('播放中控件收起后不留玻璃滤镜', g2 && g2.live === 0, g2);
      const bd = await ctx.eval(BD_OVER_VIDEO);
      ctx.assert('视频上方没有别的 backdrop-filter', !bd.length, bd);
    },
    async cleanup(ctx) { await clearAv(ctx); },
  },

  // —— 设置菜单：倍速 / 循环（电脑平铺菜单、触屏 ios27 菜单）——
  {
    id: 'av-video-menu',
    title: '视频：齿轮菜单改倍速、开循环（偏好记住倍速）',
    tags: ['av'], timeout: 90000,
    async run(ctx) {
      await clearAv(ctx);
      if (!(await openMedia(ctx, [ctx.item(V1080, { kind: 'video' })], 0))) return;
      await pauseAt(ctx, 3);
      if (!ctx.touch) await ctx.g.hover(ctx.cfg.w / 2, ctx.cfg.h / 2, { steps: 3, ms: 90 });
      else if ((await st(ctx)).chrome < 0.5) { await ctx.g.tap(ctx.cfg.w / 2, ctx.cfg.h * 0.3); await ctx.sleep(400); }
      const MI = '[role=menu] [role^="menuitem"]';
      // 触屏 MorphMenu 收起后不卸载（只是 visibility:hidden），按「看得见」判断开没开
      const MENU_VIS = `[...document.querySelectorAll('[role=menu]')].some((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && getComputedStyle(e).visibility !== 'hidden' && __pvqa.effOpacity(e) > 0.05; })`;
      await ctx.g.tapSel('button[aria-label="设置"]', { within: ctx.ROOT_SEL });
      await ctx.sleep(500);
      const items = await ctx.eval(`[...document.querySelectorAll('${MI}')].filter((e) => e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== 'hidden').map((e) => (e.textContent || '').replace(/\\s+/g, ' ').trim())`).catch(() => []);
      ctx.metric('gearItems', items);
      ctx.assert('齿轮菜单含播放速度 / 循环播放', items.some((x) => x.includes('播放速度')) && items.some((x) => x.includes('循环播放')), items);
      ctx.assert('云端视频菜单含画质（原画 / 流畅）', items.some((x) => x.includes('画质')), items, { level: 'goal' });
      await ctx.shot('gear');
      await ctx.g.tapSel(MI, { text: '播放速度' });
      await ctx.sleep(500);
      await ctx.g.tapSel(MI, { text: '1.5×' });
      await ctx.sleep(600);
      const s = await st(ctx);
      const pref = await ctx.eval(`(() => { try { return JSON.parse(localStorage.getItem('pv.av') || 'null'); } catch { return null; } })()`);
      ctx.metric('rateAfterMenu', { rate: s.rate, pref });
      ctx.assert('菜单选 1.5× → playbackRate 1.5', s.rate === 1.5, s.rate);
      ctx.assert('倍速写进全局偏好', pref?.rate === 1.5, pref);
      // 循环：等上一个菜单（连同收起动画）彻底退场，再开齿轮点「循环播放」；播到结尾应回到开头接着播。
      // 注意别在菜单收起途中按 Esc：那时菜单已不算开着，Esc 会落到查看器上把整个预览关掉
      const menuGone = () => ctx.waitFor(`(${MENU_VIS}) ? null : true`, 3000, '菜单退场').catch(() => false);
      if (!(await menuGone())) { await ctx.g.key('escape'); await menuGone(); }
      const afterPick = await st(ctx);
      ctx.metric('afterPick', { chrome: afterPick.chrome, paused: afterPick.paused });
      ctx.assert('菜单里选完不连带切换控件 / 播放状态', afterPick.chrome > 0.9 && afterPick.paused, { chrome: afterPick.chrome, paused: afterPick.paused });
      if (!ctx.touch) await ctx.g.hover(ctx.cfg.w / 2, ctx.cfg.h / 2 + 20, { steps: 2, ms: 60 });
      else if (afterPick.chrome < 0.5) { await ctx.g.tap(ctx.cfg.w / 2, ctx.cfg.h * 0.3); await ctx.sleep(450); }
      await ctx.g.tapSel('button[aria-label="设置"]', { within: ctx.ROOT_SEL });
      await ctx.waitFor(`[...document.querySelectorAll('${MI}')].some((e) => (e.textContent || '').includes('循环播放') && e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== 'hidden') || null`, 3000, '循环播放项').catch(() => {});
      await ctx.sleep(300);
      await ctx.g.tapSel(MI, { text: '循环播放' });
      await ctx.sleep(500);
      // 电脑上循环项点了不收（keepOpen），触屏选完就收
      if (!ctx.touch && (await ctx.eval(MENU_VIS))) await ctx.g.key('escape');
      await menuGone();
      const loopOn = await ctx.eval(`!!__pvqa.root()`);
      ctx.assert('关菜单没有误关查看器', loopOn, loopOn);
      if (!loopOn) return;
      await ctx.eval(`(() => { const v = __pvqa.root().querySelector('video'); v.currentTime = Math.max(0, v.duration - 0.6); return true; })()`);
      await gesturePlay(ctx);
      await ctx.sleep(2500);
      const s2 = await st(ctx);
      ctx.metric('loop', { t: s2.t, ended: s2.ended, paused: s2.paused });
      ctx.assert('开循环后播完回到开头接着播', !s2.paused && s2.t < 3 && !s2.ended, s2);
    },
    async cleanup(ctx) { await clearAv(ctx); },
  },

  // —— 续播与偏好：播到 ≥30s 关掉再开，出「从 x:xx 继续」，点了才跳；音量 / 倍速全局记住 ——
  {
    id: 'av-video-resume',
    title: '视频：续播提示（≥30 秒）与音量 / 倍速记忆',
    tags: ['av'], timeout: 90000,
    async run(ctx) {
      await clearAv(ctx);
      const it = ctx.item(VLONG, { kind: 'video' });
      if (!(await openMedia(ctx, [it], 0, { want: 'playing' }))) return;
      await ctx.eval(`(async () => { const v = __pvqa.root().querySelector('video'); await new Promise((r) => { v.addEventListener('seeked', r, { once: true }); v.currentTime = 65; setTimeout(r, 4000); }); return true; })()`);
      await ctx.sleep(800);
      if (!ctx.touch) {
        for (let i = 0; i < 4; i++) { await ctx.g.key('arrowdown'); await ctx.sleep(80); }
        await ctx.g.key('shift+.'); await ctx.sleep(200);
      }
      await ctx.close();
      await ctx.waitFor(`!__pvqa.root()`, 5000, '查看器关掉').catch(() => {});
      await ctx.sleep(500);
      const saved = await ctx.eval(`(() => { try { return { resume: JSON.parse(localStorage.getItem('pv.resume') || 'null'), av: JSON.parse(localStorage.getItem('pv.av') || 'null') }; } catch { return null; } })()`);
      ctx.metric('saved', saved);
      if (!(await openMedia(ctx, [it], 0))) return;
      const pill = await ctx.waitFor(`(() => { const r = __pvqa.root(); const b = [...r.querySelectorAll('button')].find((e) => /从 [0-9:]+ 继续/.test(e.textContent || '')); return b ? b.textContent.trim() : null; })()`, 8000, '续播提示').catch(() => null);
      ctx.metric('resumePill', pill);
      ctx.assert('重开出「从 x:xx 继续」', !!pill && /1:0[4-7]/.test(pill), pill);
      const s0 = await st(ctx);
      ctx.assert('不点不跳（仍从头）', s0.t < 10, s0.t);
      if (!ctx.touch) {
        ctx.assert('音量记住（0.8）', near(s0.vol, 0.8, 0.011), s0.vol);
        ctx.assert('倍速记住（1.25×）', s0.rate === 1.25, s0.rate);
      }
      await ctx.shot('resume-pill');
      if (pill) {
        await ctx.g.tapSel('button', { text: '继续', within: ctx.ROOT_SEL });
        await ctx.sleep(1500);
        const s1 = await st(ctx);
        ctx.metric('afterResume', { t: s1.t, paused: s1.paused });
        ctx.assert('点续播 → 跳到记下的位置并播放', s1.t > 63 && s1.t < 72 && !s1.paused, s1);
      }
    },
    async cleanup(ctx) { await clearAv(ctx); },
  },

  // —— 播完：有下一个视频 → 5 秒倒计时自动接着放；单个视频 → 重播 ——
  {
    id: 'av-video-end',
    title: '视频：播完的下一个倒计时与重播',
    tags: ['av'], timeout: 90000,
    async run(ctx) {
      await clearAv(ctx);
      const items = [ctx.item(VSHORT, { kind: 'video' }), ctx.item('图片/透明.png', { kind: 'image' }), ctx.item(VPORT, { kind: 'video' })];
      if (!(await openMedia(ctx, items, 0, { want: 'playing' }))) return;
      await ctx.eval(`(() => { const v = __pvqa.root().querySelector('video'); v.currentTime = Math.max(0, v.duration - 0.4); return true; })()`);
      const cd = await ctx.waitFor(`(() => { const t = __pvqa.root()?.innerText || ''; return t.includes('接下来') && /\\d 秒后播放/.test(t) ? true : null; })()`, 8000, '下一个倒计时').catch(() => false);
      ctx.assert('播完出「接下来」倒计时', !!cd, cd);
      if (cd) await ctx.shot('next-countdown');
      const t0 = Date.now();
      const jumped = await ctx.waitFor(`__pvqa.pv.preview.index === 2 ? true : null`, 9000, '倒计时到点换下一个').catch(() => false);
      ctx.metric('countdownMs', jumped ? Date.now() - t0 : null);
      ctx.assert('倒计时结束跳到下一个视频（跳过夹着的图片）', !!jumped, await ctx.eval(`__pvqa.pv.preview.index`));

      await ctx.close();
      await ctx.waitFor(`!__pvqa.root()`, 5000, '查看器关掉').catch(() => {});
      await ctx.sleep(400);
      if (!(await openMedia(ctx, [ctx.item(VSHORT, { kind: 'video' })], 0, { want: 'playing' }))) return;
      await ctx.eval(`(() => { const v = __pvqa.root().querySelector('video'); v.currentTime = Math.max(0, v.duration - 0.4); return true; })()`);
      const ended = await ctx.waitFor(`__pvqa.root()?.querySelector('video')?.ended ? true : null`, 6000, '播完').catch(() => false);
      ctx.assert('单个视频播完停在结尾', !!ended, ended);
      const rb = await ctx.waitFor(`(() => { const b = [...__pvqa.root().querySelectorAll('button')].find((e) => (e.getAttribute('aria-label') || '') === '重播' && e.getBoundingClientRect().width > 40); return b ? true : null; })()`, 3000, '重播钮').catch(() => false);
      ctx.assert('结尾出大号重播钮', !!rb, rb);
      await ctx.shot('ended');
      if (rb) {
        const c = await ctx.g.center('button[aria-label="重播"]', { within: ctx.ROOT_SEL });
        await ctx.g.tap(c.x, c.y);
        await ctx.sleep(900);
        const s = await st(ctx);
        ctx.assert('点重播 → 从头播放', s.t < 2 && !s.paused, s);
      }
    },
    async cleanup(ctx) { await clearAv(ctx); },
  },

  // —— 音频：流式播放（不整段下载）——
  {
    id: 'av-audio-stream',
    title: '音频：40 分钟 mp3 流式起播，首帧前下载字节远小于文件',
    tags: ['av'], timeout: 90000,
    async run(ctx) {
      await clearAv(ctx);
      const abs = path.join(ctx.samplesDir, ALONG);
      const size = statSync(abs).size;
      const name = encodeURIComponent(ALONG.split('/').pop());
      const w = await netWatch(ctx, (u) => /\/api\/file\?/.test(u) && u.includes(name));
      // 限到 4G（20Mbps）：本机回环几百毫秒就能灌满浏览器的媒体缓冲，量不出「边下边播」；整段下载要 ~6 秒才起播
      await ctx.throttle({ network: '4g' });
      try {
        const t0 = Date.now();
        if (!(await openMedia(ctx, [ctx.item(ALONG, { kind: 'audio' })], 0, { want: 'playing', tag: 'audio', timeout: 30000 }))) return;
        const first = w.bytes;
        ctx.metric('firstPlayMs', Date.now() - t0);
        ctx.metric('bytesAtFirstPlay', first);
        ctx.metric('fileSize', size);
        ctx.assert('首帧前下载 < 文件的 25%', first > 0 && first < size * 0.25, `${(first / 1048576).toFixed(2)}MB / ${(size / 1048576).toFixed(2)}MB`);
        ctx.assert('首帧前下载 < 2MB', first < 2 * 1048576, first, { level: 'goal' });
        await ctx.sleep(5000);
        ctx.metric('bytesAfter5s', w.bytes);
        ctx.metric('_requests', [...w.reqs.values()]);
        ctx.assert('播 5 秒后仍没有整段下载（< 60%）', w.bytes < size * 0.6, `${(w.bytes / 1048576).toFixed(2)}MB`);
        const meta = await ctx.eval(`(() => { const r = __pvqa.root(); const h = r.querySelector('h1, h2'); const img = [...r.querySelectorAll('img')].find((i) => i.complete && i.naturalWidth > 0 && !__pvqa.isBlur(i));
          return { title: h ? h.textContent.trim() : null, cover: !!img, slider: !!r.querySelector('[role=slider][aria-label="进度"]') }; })()`);
        ctx.metric('meta', meta);
        ctx.assert('显示标题', !!meta.title, meta.title);
        ctx.assert('有进度轨', meta.slider, meta.slider);
        await ctx.shot();
      } finally { w.on = false; }
    },
  },

  // —— 音频：快捷键与上一首 / 下一首 ——
  {
    id: 'av-audio-keys',
    title: '音频（电脑）：J/L ±15、←/→ ±5、数字键、倍速、音量、Shift+P/N 换曲',
    tags: ['av'], only: (cfg) => !cfg.touch, timeout: 90000,
    async run(ctx) {
      await clearAv(ctx);
      const items = ctx.gallery(AUDIO_DIR, { kind: 'audio', filter: /\.(mp3|wav)$/i });
      const idx = items.findIndex((x) => x.name === ALONG.split('/').pop());
      ctx.assert('音频目录里有长音频', idx >= 0, items.map((x) => x.name));
      if (idx < 0) return;
      if (!(await openMedia(ctx, items, idx, { want: 'playing', tag: 'audio', timeout: 30000 }))) return;
      await ctx.g.pointerOut();
      await ctx.g.key('k'); await ctx.sleep(300);
      let s = await st(ctx);
      ctx.assert('K 暂停', s.paused, s.paused);
      const dur = s.dur;
      const check = async (spec, name, pred, wait = 400) => { await ctx.g.key(spec); await ctx.sleep(wait); const x = await st(ctx); ctx.assert(name, pred(x), { t: x.t, vol: x.vol, rate: x.rate, muted: x.muted, index: x.index }); return x; };
      await check('home', 'Home → 0', (x) => near(x.t, 0));
      await check('l', 'L → +15s', (x) => near(x.t, 15));
      await check('arrowright', '→ → +5s', (x) => near(x.t, 20));
      await check('j', 'J → −15s', (x) => near(x.t, 5));
      await check('arrowleft', '← → −5s', (x) => near(x.t, 0));
      await check('5', '5 → 50%', (x) => near(x.t, dur * 0.5, 1));
      await check('shift+.', 'Shift+. → 1.25×', (x) => x.rate === 1.25);
      await check('<', '< → 1×', (x) => x.rate === 1);
      await check('arrowdown', '↓ → 音量 −5%', (x) => near(x.vol, 0.95, 0.011));
      await check('m', 'M → 静音', (x) => x.muted);
      await check('m', 'M → 取消静音', (x) => !x.muted);
      await check('home', 'Home → 0（换曲前）', (x) => near(x.t, 0));
      await check('shift+p', 'Shift+P（开头 3 秒内）→ 上一首', (x) => x.index === idx - 1, 1200);
      await check('shift+n', 'Shift+N → 下一首', (x) => x.index === idx, 1200);
      await ctx.shot();
    },
    async cleanup(ctx) { await clearAv(ctx); },
  },

  // —— 手机本地音频：/__localfile Range 流式（同样不整段读）——
  // 本地桩是本机回环、浏览器会一口气把 Range 响应读满，字节数说明不了「边读边播」；这里核对结构：
  // <audio> 直接挂 /__localfile（不是 blob:），桩上没有不带 Range 的整读请求，起播前读过的只有 Range 请求
  {
    id: 'local-av-audio-stream',
    title: '本地 · 音频：40 分钟 mp3 直接挂 /__localfile、只走 Range 请求起播',
    tags: ['av', 'local'], mode: 'apk', only: (cfg) => cfg.touch, timeout: 90000,
    async run(ctx) {
      await clearAv(ctx);
      const size = statSync(path.join(ctx.samplesDir, ALONG)).size;
      const st0 = ctx.local.server.stats;
      const full0 = st0.byKind.full || 0, b0 = st0.bytes;
      if (!(await openMedia(ctx, [ctx.item(ALONG, { kind: 'audio' })], 0, { want: 'playing', tag: 'audio', timeout: 30000 }))) return;
      const src = await ctx.eval(`__pvqa.root().querySelector('audio').currentSrc`);
      const stats = ctx.local.server.stats;
      const full = (stats.byKind.full || 0) - full0;
      ctx.metric('src', String(src).replace(/^https?:\/\/[^/]+/, '').slice(0, 120));
      ctx.metric('fileSize', size);
      ctx.metric('bytesRead', stats.bytes - b0);
      ctx.metric('_log', stats.log.slice(-8));
      ctx.assert('<audio> 直接挂 /__localfile（不先整段读成 blob）', /__localfile/.test(src) && !/^blob:/.test(src), src);
      ctx.assert('没有不带 Range 的整读请求', full === 0, { full, byKind: stats.byKind });
      ctx.assert('ID3 只读文件头（小 Range）', stats.log.filter((x) => x.kind === 'range' && x.bytes < 1 << 20).length >= 1, stats.log.slice(-8), { level: 'info' });
      await ctx.shot();
    },
    async cleanup(ctx) { await clearAv(ctx); },
  },
];
