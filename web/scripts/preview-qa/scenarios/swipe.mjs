// 基线：图片画廊侧滑到下一张的「松手到出图毫秒」与空白帧（痛点②）。云端与本地桩各一遍，CPU 4 倍降速。
// 量法（lib/page.mjs armSwipe）：页面侧挂 touchend / pointerup 取抬手时刻，逐帧采样到「目标条目的图在视口中心完整画出（解码完成、
// 不透明度 ≥0.99）」再加一帧；期间视口中心什么都没画出来的帧记 blankFrames，只有模糊底的帧记 blurOnlyFrames。
// 每张之间等 2 秒（惯性停下、预载器跑完），更贴近「看一张、滑一张」。Edge 每档都是新 profile：缓存是冷的。
const N = 8;   // 滑几张

function stats(arr) {
  const v = arr.filter((x) => x != null).sort((p, q) => p - q);
  if (!v.length) return null;
  const q = (k) => v[Math.min(v.length - 1, Math.floor(k * (v.length - 1) + 0.5))];
  return { n: v.length, median: q(0.5), p90: q(0.9), max: v[v.length - 1], min: v[0] };
}

function swipeScenario({ id, title, mode, network, origin, gap = 2000, start = 0 }) {
  return {
    id, title, mode, tags: ['baseline', 'swipe', ...(mode.startsWith('apk') ? ['local'] : [])],
    only: (cfg) => cfg.touch,
    timeout: 180000,
    async run(ctx) {
      const items = ctx.gallery('序列', { origin });
      ctx.assert('序列样张至少 ' + (start + N + 1) + ' 张', items.length > start + N, items.length);
      await ctx.throttle({ cpu: 4, network });
      const t0 = Date.now();
      await ctx.open(items, start);
      const first = await ctx.waitFor(`__pvqa.itemPainted(${start})`, 30000, '首张出图').then(() => Date.now() - t0, () => null);
      ctx.metric('firstOpenMs', first);
      await ctx.sleep(2000);
      // 主线程安静下来再开始量（降速 4 倍下，刚重启的页面后台还在跑；不等的话第一划会吃到几秒的长帧）
      ctx.metric('quietBefore', await ctx.eval(`__pvqa.quiet(1000, 15000)`, { timeout: 25000 }).catch(() => null));
      const { w, h } = ctx.cfg;
      const per = [];
      for (let k = 1; k <= N; k++) {
        await ctx.eval(`__pvqa.armSwipe(${start + k}, { timeout: 8000 })`);
        // 右 → 左快速一划（约 60% 屏宽、160ms），落点避开顶栏和底部手势条
        await ctx.g.swipe({ x: w * 0.8, y: h * 0.55 }, { x: w * 0.2, y: h * 0.55 }, { ms: 160, steps: 8 });
        const r = await ctx.eval(`__pvqa.swipeResult()`, { timeout: 20000 });
        per.push(r);
        if (k === 1) await ctx.shot('after-1');
        await ctx.sleep(gap);
      }
      const reached = per.filter((r) => r.index === r.target).length;
      ctx.assert('每一划都翻到下一张', reached === N, `${reached}/${N}`);
      ctx.assert('每一划都出图', per.every((r) => r.readyMs != null), per.map((r) => r.readyMs));
      ctx.metric('readyMs', stats(per.map((r) => r.readyMs)));
      ctx.metric('decodedMs', stats(per.map((r) => r.decodedMs)));
      ctx.metric('indexMs', stats(per.map((r) => r.indexMs)));
      ctx.metric('blankFrames', per.reduce((s, r) => s + r.blankFrames, 0));
      ctx.metric('blurOnlyFrames', per.reduce((s, r) => s + r.blurOnlyFrames, 0));
      ctx.metric('longFrames', per.reduce((s, r) => s + r.longFrames, 0));
      ctx.metric('longestFrame', Math.max(0, ...per.map((r) => r.longestFrame)));
      ctx.metric('_perSwipe', per);
      // 改版目标：相册级——相邻张已预解码，松手到出图 < 100ms，零空白帧
      ctx.assert('零空白帧', per.every((r) => r.blankFrames === 0), per.map((r) => r.blankFrames), { level: 'goal' });
      ctx.assert('松手到出图中位数 < 100ms', (stats(per.map((r) => r.readyMs))?.median ?? 1e9) < 100, stats(per.map((r) => r.readyMs))?.median, { level: 'goal' });
    },
  };
}

export default [
  swipeScenario({ id: 'swipe-cloud', title: '云端序列图侧滑（4G、CPU×4）', mode: 'web', network: '4g', origin: 'cloud' }),
  swipeScenario({ id: 'swipe-local', title: '本地序列图侧滑（本地桩、CPU×4）', mode: 'apk', network: null, origin: 'local' }),
  // 连续快翻：每张只停 400ms（预载器来不及跑完），更接近「刷相册」；从第 31 张起，避开前面场景已缓存过的图
  swipeScenario({ id: 'swipe-cloud-fast', title: '云端序列图快翻（每张停 400ms、4G、CPU×4）', mode: 'web', network: '4g', origin: 'cloud', gap: 400, start: 30 }),
  swipeScenario({ id: 'swipe-local-fast', title: '本地序列图快翻（每张停 400ms、CPU×4）', mode: 'apk', network: null, origin: 'local', gap: 400, start: 30 }),
  swipeScenario({ id: 'swipe-local-saf150-fast', title: '本地序列图快翻（SAF 每请求 +150ms、每张停 400ms、CPU×4）', mode: 'apk:150', network: null, origin: 'local', gap: 400, start: 45 }),
  // SAF 慢路径：每个 /__localfile 请求先等 150ms（几千张的 DCIM 里逐段枚举父目录定位文件，见摸底「本地文件链路」差距 2）
  swipeScenario({ id: 'swipe-local-saf150', title: '本地序列图侧滑（SAF 每请求 +150ms、CPU×4）', mode: 'apk:150', network: null, origin: 'local', start: 15 }),
];
