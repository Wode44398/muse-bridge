// 渲染成功的通用判定（不绑现有组件的类名：改版后照样能用）。每个函数都往 ctx 记断言 / 指标，返回关键值。
// 统一口径：openMs = 调 openPreview 到「判定为渲染成功」的毫秒（Node 侧计时，含网络与解码）。

/** 打开并计时：items、index → 返回 t0（Date.now） */
export async function openTimed(ctx, items, index = 0) {
  const t0 = Date.now();
  await ctx.open(items, index);
  return t0;
}

export async function image(ctx, { timeout = 25000, level = 'must', t0 = Date.now() } = {}) {
  let st = null;
  try { st = await ctx.waitFor(`(() => { const s = __pvqa.imgState(); return s && s.complete && s.nw > 0 && __pvqa.effOpacity(__pvqa.mainImg()) > 0.98 ? s : null; })()`, timeout, '主图解码完成且不透明'); } catch {}
  ctx.metric('openMs', st ? Date.now() - t0 : null);
  ctx.assert('主图 naturalWidth>0', !!st, st ? `${st.nw}×${st.nh}` : null, { level });
  if (st) { ctx.metric('natural', `${st.nw}×${st.nh}`); ctx.metric('rect', `${st.rect.w}×${st.rect.h}`); ctx.metric('src', st.src.replace(/^https?:\/\/[^/]+/, '').slice(0, 90)); }
  return st;
}

export async function video(ctx, { timeout = 25000, level = 'must', t0 = Date.now(), play = true } = {}) {
  let st = null;
  try { st = await ctx.waitFor(`(() => { const v = __pvqa.root()?.querySelector('video'); return v && v.readyState >= 2 ? { rs: v.readyState, w: v.videoWidth, h: v.videoHeight, dur: v.duration, src: (v.currentSrc || '').replace(location.origin, '').slice(0, 90), err: v.error && v.error.code } : null; })()`, timeout, 'video readyState>=2'); } catch {}
  const info = st || await ctx.eval(`(() => { const v = __pvqa.root()?.querySelector('video'); return v ? { rs: v.readyState, w: v.videoWidth, h: v.videoHeight, err: v.error && v.error.code, src: (v.currentSrc || '').replace(location.origin, '').slice(0, 90), net: v.networkState } : null; })()`).catch(() => null);
  ctx.metric('openMs', st ? Date.now() - t0 : null);
  ctx.metric('video', info);
  ctx.assert('video readyState>=2', !!st, info?.rs ?? null, { level });
  if (st && play) {
    // 无头 Edge 带 --mute-audio；静音后 play() 不需要手势
    const r = await ctx.eval(`(async () => { const v = __pvqa.root().querySelector('video'); v.muted = true; const c0 = v.currentTime; try { await v.play(); } catch (e) { return { err: String(e.message || e) }; }
      const t = performance.now(); let frames = 0; if (v.requestVideoFrameCallback) { const cb = () => { frames++; if (performance.now() - t < 1500) v.requestVideoFrameCallback(cb); }; v.requestVideoFrameCallback(cb); }
      await new Promise((r) => setTimeout(r, 1600)); const c1 = v.currentTime; v.pause(); return { advanced: +(c1 - c0).toFixed(2), frames, paused: v.paused }; })()`, { timeout: 10000 }).catch((e) => ({ err: String(e.message || e) }));
    ctx.metric('play', r);
    ctx.assert('播放后 currentTime 前进', r && r.advanced > 0.3, r, { level });
  }
  return st;
}

export async function audio(ctx, { timeout = 20000, level = 'must', t0 = Date.now() } = {}) {
  let st = null;
  try { st = await ctx.waitFor(`(() => { const v = __pvqa.root()?.querySelector('audio'); return v && v.readyState >= 1 && v.duration > 0 ? { rs: v.readyState, dur: Math.round(v.duration), src: (v.currentSrc || '').replace(location.origin, '').slice(0, 90) } : null; })()`, timeout, 'audio 元数据'); } catch {}
  ctx.metric('openMs', st ? Date.now() - t0 : null);
  ctx.metric('audio', st);
  ctx.assert('audio 读到时长', !!st, st?.dur ?? null, { level });
  return st;
}

/** PDF / 转 PDF 的 Office：查看器根里有画出东西的 canvas */
export async function canvas(ctx, { timeout = 30000, level = 'must', t0 = Date.now(), what = 'PDF 画布' } = {}) {
  let st = null;
  try { st = await ctx.waitFor(`(() => { const cs = [...(__pvqa.root()?.querySelectorAll('canvas') || [])].filter((c) => c.width > 0 && c.getBoundingClientRect().height > 0); const drawn = cs.filter((c) => __pvqa.canvasDrawn(c)); return drawn.length ? { canvases: cs.length, drawn: drawn.length, w: drawn[0].width, h: drawn[0].height, cssW: Math.round(drawn[0].getBoundingClientRect().width) } : null; })()`, timeout, what); } catch {}
  ctx.metric('openMs', st ? Date.now() - t0 : null);
  ctx.metric('canvas', st);
  ctx.assert(what + '已绘制', !!st, st, { level });
  return st;
}

/** 文档 / 表格 / 文本：查看器根（含 textarea、同源 iframe）里出现某段文字 */
export async function text(ctx, needle, { timeout = 25000, level = 'must', t0 = Date.now(), name } = {}) {
  let ok = false;
  try { ok = await ctx.waitFor(`(() => { const r = __pvqa.root(); if (!r) return false; const n = ${JSON.stringify(needle)};
    if ((r.innerText || '').includes(n)) return true;
    for (const t of r.querySelectorAll('textarea')) if ((t.value || '').includes(n)) return true;
    for (const f of r.querySelectorAll('iframe')) { try { if ((f.contentDocument?.body?.innerText || '').includes(n)) return true; } catch {} }
    for (const c of r.querySelectorAll('.cm-content')) if ((c.textContent || '').includes(n)) return true;
    return false; })()`, timeout, '文字「' + needle + '」'); } catch {}
  ctx.metric('openMs', ok ? Date.now() - t0 : null);
  ctx.assert(name || `出现「${needle}」`, ok, ok, { level });
  return ok;
}

/** 查看器根里加载成功的图片数（md 相对路径图） */
export async function imagesLoaded(ctx, { min = 1, timeout = 10000, level = 'must', name = '文中图片加载成功' } = {}) {
  let n = 0;
  try { n = await ctx.waitFor(`(() => { const ims = [...(__pvqa.root()?.querySelectorAll('img') || [])].filter((i) => i.complete && i.naturalWidth > 0); return ims.length >= ${min} ? ims.length : 0; })()`, timeout, name); } catch {}
  const all = await ctx.eval(`[...(__pvqa.root()?.querySelectorAll('img') || [])].map((i) => ({ src: (i.getAttribute('src') || '').slice(0, 80), ok: i.complete && i.naturalWidth > 0 }))`).catch(() => []);
  ctx.metric('images', all);
  ctx.assert(name, n >= min, `${n}/${all.length}`, { level });
  return n;
}
