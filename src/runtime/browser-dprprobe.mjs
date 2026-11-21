// canvas 的设备像素比探针（移植自 harness/server/cdp/session-page.ts 的 canvasDprProbe 与 cdp/shared.ts 的 judgeCanvasProbe）。
// 无头浏览器缺省 DPR 1——恰好是 canvas 尺寸 bug（反复乘 devicePixelRatio、读回自己写的 width 属性）不显形的那个比值，
// 真显示器是 1.25–3。探针：按指定 DPR 重新载入（入场脚本在新 DPR 下重跑），用真滚轮把页面滚到底（程序 scrollTo 喂不动
// 平滑滚动库，懒加载的图表不会初始化），停手后隔 1.2 秒采两次 canvas 几何，最后恢复原来的仿真并再载入一次。
// 现在只有 dimensio 的 Browser(dprprobe) 经内部接口用它（结果当完成证据）。

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const SAMPLE_JS = `(() => {
  const cs = [...document.querySelectorAll("canvas")].map((cv, i) => {
    const r = cv.getBoundingClientRect();
    return { id: cv.id || ("canvas#" + i), attrW: cv.width, attrH: cv.height, rectW: Math.round(r.width), rectH: Math.round(r.height) };
  });
  return { docH: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), canvases: cs };
})()`;

/** 两次采样（中间没有任何输入）比出问题；返回 { passed, problems }。 */
export function judgeCanvasProbe(s0, s1, dpr) {
  const problems = [];
  const MAX_DIM = 32767;        // Chromium 的上限附近，正常 canvas 不会到这里
  const SANE_DOC = 2_000_000;   // 没有真页面有这么高
  for (const c1 of s1.canvases) {
    const c0 = s0.canvases.find((c) => c.id === c1.id);
    if (c0 && (Math.abs(c1.attrW - c0.attrW) > 1 || Math.abs(c1.attrH - c0.attrH) > 1)) {
      problems.push(`canvas ${c1.id}: backing store grew with NO input (${c0.attrW}×${c0.attrH} → ${c1.attrW}×${c1.attrH}) — a resize/DPR feedback loop`);
      continue;
    }
    if (c1.attrW > MAX_DIM || c1.attrH > MAX_DIM) {
      problems.push(`canvas ${c1.id}: backing store ${c1.attrW}×${c1.attrH} exceeds Chromium's limit — it renders as a broken white block`);
      continue;
    }
    // 缓冲远超 布局 × dpr = 比值乘了不止一次；留 3 倍余量，刻意 2 倍超采样仍算合法
    if (c1.rectW > 0 && c1.rectH > 0) {
      const wCap = Math.max(4096, c1.rectW * dpr * 3 + 64);
      const hCap = Math.max(4096, c1.rectH * dpr * 3 + 64);
      if (c1.attrW > wCap || c1.attrH > hCap) {
        problems.push(`canvas ${c1.id}: backing ${c1.attrW}×${c1.attrH} vs layout ${c1.rectW}×${c1.rectH} at dpr ${dpr} — the ratio was applied more than once`);
      }
    }
  }
  if (s1.docH > SANE_DOC) problems.push(`page height ${s1.docH}px is runaway — layout blown up by an exploding element`);
  else if (s0.docH > 0 && s1.docH - s0.docH > Math.max(2000, s0.docH * 0.05)) problems.push(`page height still growing with no input (${s0.docH}px → ${s1.docH}px)`);
  return { passed: problems.length === 0, problems };
}

/**
 * 在 CdpSession b 上跑一次探针。返回 { dpr, canvasCount, passed, problems, note? }。
 * 仿真走 b.applyEmulation（无头 = 设备指标覆盖、桌面壳 = 只覆盖 DSF），跑完把 emu / dprExplicit 原样放回再落一次，
 * 视口、触屏、配色都保持探针前的样子。
 */
export async function canvasDprProbe(b, dpr = 2) {
  const prev = { emu: { ...b.emu }, dprExplicit: b.dprExplicit };
  const vw = () => Math.floor((b.measured?.w || b.viewport.width) / 2);
  const vh = () => Math.floor((b.measured?.h || b.viewport.height) / 2);
  try {
    b.emu = { ...b.emu, dpr };
    b.dprExplicit = true;
    await b.applyEmulation();
    await b.reload();
    await delay(700);   // 入场脚本跑一会儿
    // 步数封顶：尺寸爆掉的页面永远滚不到底
    for (let i = 0; i < 60; i++) {
      await b.wheel(vw(), vh(), 700);
      await delay(80);
      const done = await b.eval('window.scrollY + innerHeight >= document.documentElement.scrollHeight - 4').catch(() => true);
      if (done) break;
    }
    await delay(600);
    const s0 = await b.eval(SAMPLE_JS);
    await delay(1200);   // 这段时间里没有任何输入——还在长就是反馈循环
    const s1 = await b.eval(SAMPLE_JS);
    const verdict = judgeCanvasProbe(s0, s1, dpr);
    return { dpr, canvasCount: s1.canvases.length, ...verdict, ...(s1.canvases.length ? {} : { note: 'page has no <canvas> — nothing DPR-sensitive to probe' }) };
  } finally {
    b.emu = prev.emu;
    b.dprExplicit = prev.dprExplicit;
    await b.applyEmulation().catch(() => {});
    await b.reload().catch(() => {});
    b.notifyViewport?.();
  }
}
