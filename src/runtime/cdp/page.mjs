// CdpSession 的页面方法（方法体原样，由 cdp.mjs 装回 CdpSession.prototype）：求值、导航与等待、截图、刷新、无障碍快照与 ref、正文。
import { snapshotAccessibility } from '../cdp-ax.mjs';
import { pageLayerIds } from '../page-layers.mjs';
import { foldRepeatedLines, PAGE_TEXT_LINKS_MAX, pageTextExpression } from '../cdp-page-text.mjs';
import { scalePng } from '../png-scale.mjs';
import { delay, LONG_LIVED, MUTATION_KEY, pngSize, SHOT_MAX_PX } from './shared.mjs';

export class CdpPageMethods {
  // 在页面里求值，按值取回。replMode 允许顶层 await 与跨调用重复声明 let/const。
  // replMode 只 await 顶层的 `await x`：表达式本身求值为 Promise（`snap()`、`(async()=>…)()`）时，
  // 直接 returnByValue 拿回的是 Promise 序列化出的 `{}`。所以先拿引用：是 Promise 就
  // Runtime.awaitPromise，是对象就按值取回，最后整组释放（harness cdp.ts 同款）。
  async eval(expression) {
    const objectGroup = 'bridge-eval';
    const unwrap = (x) => {
      if (x?.exceptionDetails) throw new Error(x.exceptionDetails.exception?.description || x.exceptionDetails.text || 'eval error');
      return x?.result;
    };
    let res;
    let held = false;
    try {
      res = unwrap(await this.send('Runtime.evaluate', { expression, objectGroup, returnByValue: false, awaitPromise: true, replMode: true }));
      held = Boolean(res?.objectId);
      if (res?.subtype === 'promise' && res.objectId) {
        res = unwrap(await this.send('Runtime.awaitPromise', { promiseObjectId: res.objectId, returnByValue: true }));
      } else if (res?.objectId) {
        res = unwrap(await this.send('Runtime.callFunctionOn', { objectId: res.objectId, functionDeclaration: 'function () { return this; }', returnByValue: true }));
      }
    } catch (e) {
      if (String(e?.message || '').includes('timed out')) {
        // 30 秒没回：可能是脚本死循环、页面主线程被别的长任务占着，也可能只是脚本 await 的 Promise
        // 一直没落定。先终止在跑的脚本，再用一个极短的探针看页面此刻还答不答话——如实报，别一律说「已恢复」。
        await this.send('Runtime.terminateExecution', {}, 5_000).catch(() => {});
        const alive = await this.send('Runtime.evaluate', { expression: '1', returnByValue: true }, 3_000).then(() => true, () => false);
        throw new Error(alive
          ? 'eval 30 秒没有返回，已终止。页面本身还能响应——多半是脚本死循环，或 await 的 Promise 一直没完成（耗时操作改成先存到 window.__x，再用一次 eval 去读）'
          : 'eval 30 秒没有返回，页面主线程至今仍无响应（被长任务占住了）。可以过一会儿再试，或者 reload / navigate 重新载入页面');
      }
      throw e;
    } finally {
      if (held) this.send('Runtime.releaseObjectGroup', { objectGroup }, 5_000).catch(() => {});
    }
    // NaN / Infinity / -0 / BigInt 不能按 JSON 回传，CDP 放在 unserializableValue 里
    if (res?.value === undefined && res?.unserializableValue) return res.unserializableValue;
    return res?.value;
  }

  // 导航后不再固定白等 1.2 秒：等 load 事件（最多 10 秒），再等页面安定（DOM 不再变、
  // 请求落定，最多 3 秒）。快页面立刻返回，慢 SPA 也不会还没渲染完就交给 agent。
  // 返回 { ms, settled, errorText }——errorText 是 Chrome 报的加载失败（DNS/拒连…）。
  async navigate(url) {
    const t0 = Date.now();
    const loaded = new Promise((res) => this.loadWaiters.push(res));
    const r = await this.send('Page.navigate', { url });
    this.url = url;
    if (r?.loaderId) await Promise.race([loaded, delay(10_000)]);   // 没有 loaderId = 同文档跳转（只改 #hash），没有 load 事件
    const s = await this.settle({ since: t0, quietMs: 300, maxMs: 3000 });
    if (this.desktopBroker) await this.syncShellMetrics().catch(() => {});   // 换了 origin 可能换了 zoom
    return { ...s, ms: Date.now() - t0, errorText: r?.errorText || '' };
  }

  // history：-1=后退、+1=前进。返回到达的 URL；该方向没有条目时返回 null。
  async history(dir) {
    const h = await this.send('Page.getNavigationHistory', {});
    const next = (h?.currentIndex ?? 0) + dir;
    const entry = h?.entries?.[next];
    if (!entry) return null;
    const t0 = Date.now();
    await this.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    this.url = entry.url;
    await delay(60);   // 让 frameStartedLoading 先到，settle 才知道在加载
    await this.settle({ since: t0, quietMs: 300, maxMs: 6000 });
    if (this.desktopBroker) await this.syncShellMetrics().catch(() => {});
    return String(entry.url);
  }

  // ── 等页面安定 ────────────────────────────────────────────────────────────
  // 每 ~80ms 看一次：主框架不在加载、页面 DOM 变动计数（页内 MutationObserver）与地址连续
  // quietMs 不变、since 之后发出的请求都已落定（长轮询 / SSE / WebSocket 与挂了 4 秒以上的
  // 不算）。满足即返回；页面一直在变（动画、轮播、时钟）就到 maxMs 为止。
  async settle({ since = Date.now(), quietMs = 250, maxMs = 2000 } = {}) {
    const t0 = Date.now();
    let last = null;
    let quietFrom = 0;
    while (Date.now() - t0 < maxMs) {
      const loading = this.loading && Date.now() - this.loadingSince < 15_000;
      const busy = this.pendingRequests(since).length > 0;
      const key = await this.send('Runtime.evaluate', { expression: MUTATION_KEY, returnByValue: true }, 1500)
        .then((x) => x?.result?.value ?? null, () => null);
      if (key != null && key === last && !loading && !busy) {
        if (!quietFrom) quietFrom = Date.now();
        if (Date.now() - quietFrom >= quietMs) return { settled: true, ms: Date.now() - t0 };
      } else {
        quietFrom = 0;
      }
      last = key;
      await delay(80);
    }
    return { settled: false, ms: Date.now() - t0 };
  }

  // since 之后发出、还没落定的请求（settle 与动作结果用）。
  pendingRequests(since = 0) {
    const now = Date.now();
    return this.netOrder.filter((e) => e.state === 'pending' && e.t >= since && now - e.t < 4000
      && !LONG_LIVED.has(String(e.resourceType || '')));
  }

  // agent 给的 x,y（最近一张截图里的像素）→ 页面 CSS 像素。截图是 1:1 时原样；缩过的图按
  // 帧比例换算。越界、截图后视口或标签变了（且比例不是 1）直接报错，让 agent 重新截图，
  // 而不是悄悄点到别处。返回 { x, y, k }（k = CSS/图片像素比）。
  frameToCss(x, y) {
    const vw = this.measured?.w || this.viewport.width;
    const vh = this.measured?.h || this.viewport.height;
    const f = this.frame;
    const fresh = f && f.targetId === this.activeTargetId && f.vpW === this.viewport.width && f.vpH === this.viewport.height;
    if (f && Math.abs(f.k - 1) > 0.001 && !fresh) {
      throw new Error('截图之后视口或标签变了，旧截图的坐标已经对不上——先重新 screenshot，再按新图给坐标');
    }
    const k = fresh ? f.k : 1;
    const w = fresh ? f.imgW : vw;
    const h = fresh ? f.imgH : vh;
    if (!(x >= 0 && y >= 0 && x < w && y < h)) {
      throw new Error(`坐标 (${x}, ${y}) 超出${fresh ? `最近那张截图（${w}×${h}）` : `视口（${w}×${h}）`}的范围——按截图里看到的像素给，或改用 ref / text 定位`);
    }
    return { x: x * k, y: y * k, k };
  }

  async title() {
    try { return String((await this.eval('document.title')) ?? ''); } catch { return ''; }
  }

  // 截图一律出成「CSS 像素 1:1、长边不超过 SHOT_MAX_PX」的图并记帧（this.frame）：
  //  - 桌面壳按显示器 DPR × 面板 zoom 渲染、headless 可 resize(dpr:2)，原样截会得到
  //    「不是视口尺寸」的图，模型按图算坐标全对不上；
  //  - 视口宽过 1568 时 Claude Code 会把图再缩一次给模型，同样对不上。
  // 所以在这里先缩到位、记下比例，click(x,y) 由 frameToCss 换算回去。要看高 DPR 细节用
  // region（只读放大，不改坐标基准）。
  // opts.region = [x, y, w, h]（按最近那张截图的像素）→ 返回该区域按设备像素截的放大图。
  async screenshot(opts = {}) {
    let m = await this.measure();
    // 壳里面板一挂一收 zoom 就变：截图前把视口与 DPR 校回来，坐标系和画面才是 agent 以为的那个
    if (this.desktopBroker && m) m = (await this.syncShellMetrics({ m }).catch(() => m)) || m;
    this.measured = m || this.measured;
    // 用户自己的窗口随时会被他拉大缩小：坐标基准跟着实测走
    if (this.webBridge && m?.w > 0) this.viewport = { width: m.w, height: m.h };
    const cssW = m?.w > 0 ? m.w : this.viewport.width;
    const cssH = m?.h > 0 ? m.h : this.viewport.height;
    const dpr = m?.dpr > 0 ? m.dpr : (this.emu.dpr || 1);
    const params = { format: 'png', captureBeyondViewport: false };
    if (opts.region) {
      const [rx, ry, rw, rh] = opts.region.map(Number);
      const a = this.frameToCss(rx, ry);
      const k = a.k;
      const w = Math.max(1, Math.min(cssW - a.x, rw * k));
      const h = Math.max(1, Math.min(cssH - a.y, rh * k));
      const s = Math.min(1, SHOT_MAX_PX / (Math.max(w, h) * dpr));   // 设备像素原样，太大才缩
      params.clip = { x: a.x, y: a.y, width: w, height: h, scale: s };
      const buf = await this.capture(params, Math.round(w * dpr * s));
      return { buf, zoom: { css: [a.x, a.y, w, h].map(Math.round), ...pngSize(buf) } };
    }
    const fit = Math.min(1, SHOT_MAX_PX / Math.max(cssW, cssH));
    if (Math.abs(dpr - 1) > 0.01 || fit < 1 || this.dsfOverride > 0) {
      params.clip = { x: 0, y: 0, width: cssW, height: cssH, scale: fit / dpr };
    }
    const buf = await this.capture(params, Math.round(cssW * fit));
    const { width: imgW, height: imgH } = pngSize(buf);
    this.frame = {
      imgW: imgW || Math.round(cssW * fit), imgH: imgH || Math.round(cssH * fit),
      k: imgW ? cssW / imgW : 1 / fit,
      vpW: this.viewport.width, vpH: this.viewport.height, targetId: this.activeTargetId, t: Date.now(),
    };
    return { buf, frame: this.frame };
  }


  async capture(params, wantW) {
    // 用户自己的浏览器：不让 Chromium 代缩（clip.scale≠1 会临时套设备指标覆盖，截图途中链路一断就留在页面上——
    // 页面缩在窗口左上角，只有刷新或改窗口大小才好）。按原尺寸截（scale 1 打断了也不留痕），在本地缩。
    if (this.webBridge && params.clip && Math.abs(params.clip.scale - 1) > 1e-6) {
      const r = await this.send('Page.captureScreenshot', { ...params, clip: { ...params.clip, scale: 1 } });
      if (!r?.data) throw new Error('captureScreenshot returned no data');
      const full = Buffer.from(r.data, 'base64');
      return wantW > 0 ? scalePng(full, wantW) : full;
    }
    const key = `${this.activeTargetId}|${this.dsfOverride}|${this.measured?.dpr ?? ''}`;
    const fix = params.clip && this.shotFix.key === key ? this.shotFix.c : 1;
    const p = fix !== 1 ? { ...params, clip: { ...params.clip, scale: params.clip.scale * fix } } : params;
    let r = await this.send('Page.captureScreenshot', p);
    if (!r?.data) throw new Error('captureScreenshot returned no data');
    let buf = Buffer.from(r.data, 'base64');
    const got = pngSize(buf).width;
    if (params.clip && wantW > 0 && got > 0 && Math.abs(got - wantW) > 2) {
      const c = fix * (wantW / got);
      this.shotFix = { key, c };
      r = await this.send('Page.captureScreenshot', { ...params, clip: { ...params.clip, scale: params.clip.scale * c } });
      if (r?.data) buf = Buffer.from(r.data, 'base64');
    } else if (params.clip) this.shotFix = { key, c: fix };
    return buf;
  }

  // 截图前等页面「停下来」：字体加载完、有限长的 CSS / JS 动画（过渡、一次性 keyframes）跑完，再等两帧（后台页 rAF
  // 可能不跑，每帧最多等 100ms），最多 maxMs；无限循环的动画（转圈）不等。切页、点完按钮立刻截，拍到的常是半截动画。
  // 返回等了多久、到点还有几个没跑完（那张图可能是半截的）。页面拒绝脚本（CSP 之类）就不等。
  async settleAnimations(maxMs = 3000) {
    const js = `(async (maxMs) => {
      const t0 = performance.now();
      const left = () => Math.max(0, maxMs - (performance.now() - t0));
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const frame = () => Promise.race([new Promise((r) => requestAnimationFrame(() => r())), sleep(100)]);
      try { if (document.fonts && document.fonts.status !== "loaded") await Promise.race([document.fonts.ready, sleep(left())]); } catch {}
      const busy = () => document.getAnimations().filter((a) => {
        if (a.playState !== "running") return false;
        const end = a.effect && a.effect.getComputedTiming ? a.effect.getComputedTiming().endTime : Infinity;
        return Number.isFinite(end);
      });
      let running = busy();
      while (running.length && left() > 0) {
        await Promise.race([Promise.allSettled(running.map((a) => a.finished)), sleep(Math.min(100, left()))]);
        running = busy();
      }
      await frame();
      await frame();
      return { waitedMs: Math.round(performance.now() - t0), stillRunning: running.length };
    })(${Math.round(maxMs)})`;
    try {
      const r = await this.eval(js);
      return { waitedMs: Number(r?.waitedMs) || 0, stillRunning: Number(r?.stillRunning) || 0 };
    } catch { return { waitedMs: 0, stillRunning: 0 }; }
  }

  // 只截一个元素（target = { ref } | { selector }）：不在视口里先滚进来，按页面坐标截它的盒子（CSS 像素 × 设备像素比出图，
  // 每边最多 SHOT_MAX_PX）。不改坐标基准（this.frame 不动）：点击坐标仍按最近那张整屏截图给。
  async elementShot(target = {}) {
    const group = 'bridge-shot';
    try {
      let objectId;
      if (target.ref != null) {
        const { backendId } = this.refInfo(Number(target.ref));
        const { object } = await this.send('DOM.resolveNode', { backendNodeId: backendId, objectGroup: group });
        if (!object?.objectId) throw new Error(`ref${target.ref} 对应的元素已经不在了（页面变过）——重新 read_page`);
        objectId = object.objectId;
      } else {
        const sel = String(target.selector || '');
        const r = await this.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)})`, objectGroup: group });
        if (r?.exceptionDetails) throw new Error(`CSS selector 写法不对：${sel}`);
        if (!r?.result?.objectId) throw new Error(`没有匹配 ${sel} 的元素`);
        objectId = r.result.objectId;
      }
      const call = async (fn) => {
        const r = await this.send('Runtime.callFunctionOn', { objectId, functionDeclaration: fn, returnByValue: true });
        if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面脚本出错');
        return r?.result?.value;
      };
      await call("function(){const r=this.getBoundingClientRect();if(r.top<0||r.left<0||r.bottom>innerHeight||r.right>innerWidth)this.scrollIntoView({block:r.height>innerHeight?'start':'center',inline:'center',behavior:'instant'});}");
      await delay(60);
      const box = await call('function(){const r=this.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,sx:scrollX,sy:scrollY,vw:innerWidth,vh:innerHeight,dpr:devicePixelRatio};}');
      if (!box || box.width < 1 || box.height < 1) throw new Error(`${target.ref != null ? `ref${target.ref}` : `selector ${target.selector}`} 没有可见的盒子（display:none、尺寸为 0 或已脱离文档）`);
      const width = Math.min(10_000, box.width);
      const height = Math.min(10_000, box.height);
      const dpr = box.dpr > 0 ? box.dpr : 1;
      const scale = Math.min(1, SHOT_MAX_PX / (Math.max(width, height) * dpr));
      const beyond = box.top < 0 || box.left < 0 || box.top + height > box.vh || box.left + width > box.vw;
      const r = await this.send('Page.captureScreenshot', {
        format: 'png', captureBeyondViewport: beyond,
        clip: { x: box.left + box.sx, y: box.top + box.sy, width, height, scale },
      });
      if (!r?.data) throw new Error('captureScreenshot returned no data');
      const buf = Buffer.from(r.data, 'base64');
      return { buf, element: { css: [box.left, box.top, width, height].map(Math.round), clamped: width !== box.width || height !== box.height, ...pngSize(buf) } };
    } finally {
      this.send('Runtime.releaseObjectGroup', { objectGroup: group }, 5_000).catch(() => {});
    }
  }

  async reload() {
    const t0 = Date.now();
    const loaded = new Promise((res) => this.loadWaiters.push(res));
    await this.send('Page.reload', {});
    await Promise.race([loaded, delay(10_000)]);
    const s = await this.settle({ since: t0, quietMs: 300, maxMs: 3000 });
    if (this.desktopBroker) await this.syncShellMetrics().catch(() => {});
    return s;
  }

  // ── a11y 快照：页面读成缩进树，可交互节点带 [refN]，refs 到下次快照/导航前有效 ──
  // 看整页（不带 query / ref）时先分层：看不见的抽屉折叠、可见弹窗排最前（page-layers.mjs）
  async axSnapshot(opts = {}) {
    const send = this.send.bind(this);
    const layers = opts.layers !== false && !opts.query && opts.rootBackendId == null ? await pageLayerIds(send) : null;
    return snapshotAccessibility(send, this.refs, layers ? { ...opts, layers } : opts);
  }

  refInfo(ref) {
    const e = this.refs.get(ref);
    if (!e) throw new Error(`ref${ref} is unknown — refs come from read_page and reset on every snapshot/navigation. Run read_page again.`);
    return e;
  }

  // 元素滚进视口并返回其中心坐标。DOM.resolveNode + callFunctionOn（getBoxModel 不稳时也可用）。
  async refCenter(ref) {
    const { backendId } = this.refInfo(ref);
    const { object } = await this.send('DOM.resolveNode', { backendNodeId: backendId });
    if (!object?.objectId) throw new Error(`ref${ref}: element is gone (page changed since read_page)`);
    const r = await this.send('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration:
        "function(){ this.scrollIntoView({block:'center',inline:'center'}); const r=this.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}; }",
      returnByValue: true,
    });
    const c = r?.result?.value;
    if (!c || c.w === 0 || c.h === 0) throw new Error(`ref${ref}: element has no visible box (hidden?)`);
    await delay(100);
    return { x: c.x, y: c.y, objectId: object.objectId };
  }


  // 页面正文：article / main / [role=main] 优先，退回 body——读文章、文档比 read_page 的无障碍树省得多。
  // 页面里那段脚本在 cdp-page-text.mjs：有 open shadow DOM 时走扁平树（Web Components 里的正文 innerText 读不到）。
  // 连续重复的长行先折叠再按 maxChars 截；扁平遍历攒到 4 倍 maxChars 就停（more）。links=true 顺带收链接（query 过滤）。
  async pageText(maxChars = 20_000, { links = false, query = '' } = {}) {
    const cap = Math.max(1000, Math.min(100_000, Number(maxChars) || 20_000));
    const r = await this.eval(pageTextExpression({ links: !!links, query: links ? String(query || '') : '', maxLinks: PAGE_TEXT_LINKS_MAX, limit: cap * 4 }));
    const text = foldRepeatedLines(String(r?.text || ''));
    return {
      from: r?.from || '', title: r?.title || '', text: text.length > cap ? text.slice(0, cap) : text, total: text.length,
      truncated: text.length > cap || !!r?.more, more: !!r?.more, shadow: Number(r?.shadow) || 0,
      lazy: Array.isArray(r?.lazy) ? r.lazy : [], links: Array.isArray(r?.links) ? r.links : null,
    };
  }
}
