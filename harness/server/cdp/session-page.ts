// CdpSession 的页面层：执行脚本、导航与等待、测量、截图、无障碍快照、正文、配色、画布探针、投屏、控制台与网络记录。
import { type AxSnapshot, axUrl, type CanvasProbeReport, type CanvasProbeSample, clampRegion, type ConsoleEntry, delay, INTERACTIVE_ROLES, judgeCanvasProbe, loadPageTextCore, LONG_LIVED, MAX_SHOT_WAIT_MS, type MeasuredViewport, MUTATION_KEY, type NetEntry, PAGE_TEXT_PLAIN, pngSize, PROMOTE_ROLES, type ScreenshotOptions, type ScreenshotResult, SETTLE_MAX_MS, SHOT_MAX_PX, SKIP_ROLES } from "./shared.ts";
import { CdpSessionCore } from "./session-core.ts";

export abstract class CdpSessionPage extends CdpSessionCore {
  // 输入层实现，这一层的 canvasDprProbe 要调用它
  abstract wheel(x: number, y: number, deltaY: number, deltaX?: number): Promise<void>;

  // Evaluate an expression in the page, returning its value (returnByValue).
  // replMode: allows top-level await and re-declaring let/const across calls —
  // both are things models naturally write in successive Eval calls.
  //
  // V4（#56）：replMode 只 await 顶层的 `await x`；表达式本身求值为 Promise 时（`(async()=>…)()`、
  // `(()=>Promise.resolve(true))()`），returnByValue 拿回的是 Promise 对象序列化出的 `{}`——工具描述
  // 却写着「promises are awaited」，验证证据里于是记下了 `FAIL …: {}`。现在先拿引用：是 Promise
  // 就 Runtime.awaitPromise，是对象就按值取回，最后整组释放。
  async eval(expression: string): Promise<any> {
    const objectGroup = "dimensio-eval";
    // 页面脚本自己抛的异常带上类名（pageException），Eval 工具据此区分「断言失败」与「写法错误」。
    const unwrap = (r: any) => {
      if (r?.exceptionDetails) {
        const err = new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "eval error");
        (err as Error & { pageException?: string }).pageException = String(r.exceptionDetails.exception?.className || "Error");
        throw err;
      }
      return r?.result;
    };
    let awaiting = false;
    try {
      let res = unwrap(
        await this.send("Runtime.evaluate", { expression, objectGroup, returnByValue: false, awaitPromise: true, replMode: true }),
      );
      if (res?.subtype === "promise" && res.objectId) {
        awaiting = true;
        res = unwrap(await this.send("Runtime.awaitPromise", { promiseObjectId: res.objectId, returnByValue: true }));
      } else if (res?.objectId) {
        res = unwrap(
          await this.send("Runtime.callFunctionOn", {
            objectId: res.objectId,
            functionDeclaration: "function () { return this; }",
            returnByValue: true,
          }),
        );
      }
      return res?.value;
    } catch (e) {
      if ((e as Error).message.includes("timed out")) {
        if (awaiting) {
          throw new Error("the returned promise did not settle within 30s — make sure it resolves (or rejects) and try again");
        }
        // A script spinning forever (e.g. a while-loop that never exits) wedges
        // the page's main thread — kill it so the page is usable again.
        await this.send("Runtime.terminateExecution", {}).catch(() => {});
        throw new Error(
          "the script ran too long and was terminated (infinite loop?) — the page has been recovered; fix the script and try again",
        );
      }
      throw e;
    } finally {
      await this.send("Runtime.releaseObjectGroup", { objectGroup }).catch(() => {});
    }
  }

  // 导航后不再固定白等 1.2 秒：等 load 事件（最多 10 秒），再等页面安定（DOM 不再变、请求落定，最多 3 秒）。
  // 快页面立刻返回，慢 SPA 也不会还没渲染完就交回去。errorText 是 Chrome 报的加载失败（DNS / 拒连……）。
  async navigate(url: string): Promise<{ ms: number; settled: boolean; errorText: string }> {
    const t0 = Date.now();
    const loaded = new Promise<void>((res) => this.loadWaiters.push(res));
    const r = await this.send("Page.navigate", { url });
    this.url = url;
    if (r?.loaderId) await Promise.race([loaded, delay(10_000)]); // 没有 loaderId = 同文档跳转（只改 #hash），没有 load 事件
    const s = await this.settle({ since: t0, quietMs: 300, maxMs: 3000 });
    return { settled: s.settled, ms: Date.now() - t0, errorText: String(r?.errorText || "") };
  }

  // history: -1 = back, +1 = forward. Returns the URL we moved to, or null when
  // there is no entry in that direction.
  async history(dir: -1 | 1): Promise<string | null> {
    const h = await this.send("Page.getNavigationHistory", {});
    const next = (h?.currentIndex ?? 0) + dir;
    const entry = h?.entries?.[next];
    if (!entry) return null;
    const t0 = Date.now();
    await this.send("Page.navigateToHistoryEntry", { entryId: entry.id });
    this.url = entry.url;
    await delay(60); // 让 frameStartedLoading 先到，settle 才知道在加载
    await this.settle({ since: t0, quietMs: 300, maxMs: 6000 });
    return String(entry.url);
  }

  // ── 等页面安定 ────────────────────────────────────────────────────────────
  // 每 ~80ms 看一次：主框架不在加载、页面 DOM 变动计数（页内 MutationObserver）与地址连续 quietMs 不变、since 之后发出
  // 的请求都已落定（长轮询 / SSE / WebSocket 与挂了 4 秒以上的不算）。满足即返回；页面一直在变（动画、轮播、时钟）就到
  // maxMs 为止。（截图前等动画跑完的是另一回事，见 settleAnimations。）
  async settle({ since = Date.now(), quietMs = 250, maxMs = 2000 }: { since?: number; quietMs?: number; maxMs?: number } = {}): Promise<{ settled: boolean; ms: number }> {
    const t0 = Date.now();
    let last: unknown = null;
    let quietFrom = 0;
    while (Date.now() - t0 < maxMs) {
      const loading = this.loading && Date.now() - this.loadingSince < 15_000;
      const busy = this.pendingRequests(since).length > 0;
      const key = await this.send("Runtime.evaluate", { expression: MUTATION_KEY, returnByValue: true }, 1500).then(
        (x) => x?.result?.value ?? null,
        () => null,
      );
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
  pendingRequests(since = 0): NetEntry[] {
    const now = Date.now();
    return this.netOrder.filter(
      (e) => e.state === "pending" && e.t >= since && now - e.t < 4000 && !LONG_LIVED.has(String(e.resourceType || "")),
    );
  }

  // agent 给的 x,y（最近一张整屏截图里的像素）→ 页面 CSS 像素。截图是 1:1 时原样；缩过的图按帧比例换算。
  // 越界、截图后视口或标签变了（且比例不是 1）直接报错，让 agent 重新截图，而不是悄悄点到别处。
  frameToCss(x: number, y: number): { x: number; y: number; k: number } {
    const vw = this.measured?.w || this.viewport.width;
    const vh = this.measured?.h || this.viewport.height;
    const f = this.frame;
    const fresh = Boolean(f && f.targetId === this.activeTargetId && f.vpW === this.viewport.width && f.vpH === this.viewport.height);
    if (f && Math.abs(f.k - 1) > 0.001 && !fresh) {
      throw new Error("the viewport or tab changed since the last screenshot, so its coordinates no longer line up — take a new screenshot and give x,y from it");
    }
    const k = fresh && f ? f.k : 1;
    const w = fresh && f ? f.imgW : vw;
    const h = fresh && f ? f.imgH : vh;
    if (!(x >= 0 && y >= 0 && x < w && y < h)) {
      throw new Error(
        `(${x}, ${y}) is outside ${fresh ? `the last screenshot (${w}×${h})` : `the viewport (${w}×${h})`} — give pixels you see in the screenshot, or target by ref / text instead`,
      );
    }
    return { x: x * k, y: y * k, k };
  }

  // 页面自己量视口（innerWidth / DPR / 触屏 / 配色）
  async measure(): Promise<MeasuredViewport | null> {
    try {
      const m = await this.eval(
        "({w:innerWidth,h:innerHeight,dpr:Math.round(devicePixelRatio*1000)/1000,touch:navigator.maxTouchPoints,coarse:matchMedia('(pointer:coarse)').matches,dark:matchMedia('(prefers-color-scheme: dark)').matches,sx:scrollX,sy:scrollY})",
      );
      return m && typeof m === "object" && m.w > 0 ? { ...m, at: Date.now() } : null;
    } catch {
      return null;
    }
  }

  async title(): Promise<string> {
    try {
      return String((await this.eval("document.title")) ?? "");
    } catch {
      return "";
    }
  }

  // U5（MiMo 反馈）：截图以前立刻取帧——切页、点完按钮马上截，拍到的是旧页或动画的半截。现在：
  //   · 默认先等：字体加载完、正在跑的有限长 CSS / JS 动画（过渡、一次性 keyframes）跑完，再等两帧，最多 SETTLE_MAX_MS；
  //     无限循环的动画（转圈）不等。waitMs > 0 先固定等这么久再做上面这步（等数据加载）；waitMs = 0 立刻截（就要半截的那一帧）。
  //   · 只截一块：selector（CSS）或 ref（ReadPage 的 [refN]）截那个元素（不在视口里先滚进来），clip 截视口坐标里的一块矩形。
  async screenshot(opts: ScreenshotOptions = {}): Promise<ScreenshotResult> {
    const group = "dimensio-shot";
    try {
      let el: string | null = null;
      if (opts.selector != null || opts.ref != null) {
        el = await this.shotElement(opts, group);
        await this.callOn(el, "function(){const r=this.getBoundingClientRect();if(r.top<0||r.left<0||r.bottom>innerHeight||r.right>innerWidth)this.scrollIntoView({block:r.height>innerHeight?'start':'center',inline:'center',behavior:'instant'});}");
      }
      const waitMs = opts.waitMs == null ? null : Math.max(0, Math.min(MAX_SHOT_WAIT_MS, Math.round(opts.waitMs)));
      if (waitMs) await delay(waitMs);
      const settle = waitMs === 0 ? null : await this.settleAnimations(SETTLE_MAX_MS);

      // 截图区域一律换成页面坐标（CSS px）：视口坐标 + 当前滚动量；超出视口的部分才让 Chrome 截视口以外
      let region: ScreenshotResult["region"];
      let beyond = false;
      if (el) {
        const box = await this.callOn(el, "function(){const r=this.getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height,sx:scrollX,sy:scrollY,vw:innerWidth,vh:innerHeight};}");
        if (!box || box.width < 1 || box.height < 1) {
          throw new Error(`${opts.ref != null ? `ref${opts.ref}` : `selector ${opts.selector}`} has no visible box (display:none, zero size, or detached)`);
        }
        region = clampRegion({ x: box.left + box.sx, y: box.top + box.sy, width: box.width, height: box.height });
        beyond = box.top < 0 || box.left < 0 || box.top + region.height > box.vh || box.left + region.width > box.vw;
      } else if (opts.clip) {
        const raw = opts.clip;
        if (![raw.x, raw.y, raw.width, raw.height].every(Number.isFinite) || raw.width < 1 || raw.height < 1) {
          throw new Error("clip needs numeric x, y, width, height (pixels of the last screenshot), width and height ≥ 1");
        }
        // clip 与 click 的 x,y 同一个坐标系＝最近那张整屏截图的像素：缩过的图按帧比例换回 CSS px
        const k = this.frameScale();
        const c = { x: raw.x * k, y: raw.y * k, width: raw.width * k, height: raw.height * k };
        const v = await this.eval("({sx:scrollX,sy:scrollY,vw:innerWidth,vh:innerHeight})");
        region = clampRegion({ x: c.x + v.sx, y: c.y + v.sy, width: c.width, height: c.height });
        beyond = c.x < 0 || c.y < 0 || c.x + region.width > v.vw || c.y + region.height > v.vh;
      }
      if (region) {
        const r = await this.send("Page.captureScreenshot", {
          format: "png",
          captureBeyondViewport: beyond,
          clip: { x: region.x, y: region.y, width: region.width, height: region.height, scale: 1 },
        });
        if (!r?.data) throw new Error("captureScreenshot returned no data");
        return { png: Buffer.from(r.data, "base64"), region, settle };
      }
      // 整屏：一律出成「CSS 像素 1:1、长边不超过 SHOT_MAX_PX」并记帧——桌面壳按显示器 DPR 渲染、视口宽过 1568 时
      // provider 又会再缩一次，原样截的图模型按图算坐标全对不上。之后 click(x,y) 由 frameToCss 换算回去。
      const m = await this.measure();
      if (m) this.measured = m;
      const cssW = m?.w || this.viewport.width;
      const cssH = m?.h || this.viewport.height;
      const dpr = m?.dpr && m.dpr > 0 ? m.dpr : 1;
      const fit = Math.min(1, SHOT_MAX_PX / Math.max(cssW, cssH));
      const params: Record<string, unknown> = { format: "png", captureBeyondViewport: false };
      if (Math.abs(dpr - 1) > 0.01 || fit < 1) {
        params.clip = { x: m?.sx ?? 0, y: m?.sy ?? 0, width: cssW, height: cssH, scale: fit / dpr };
      }
      const png = await this.capture(params, Math.round(cssW * fit));
      const { width: imgW, height: imgH } = pngSize(png);
      this.frame = {
        imgW: imgW || Math.round(cssW * fit),
        imgH: imgH || Math.round(cssH * fit),
        k: imgW ? cssW / imgW : 1 / fit,
        vpW: this.viewport.width,
        vpH: this.viewport.height,
        targetId: this.activeTargetId,
        t: Date.now(),
      };
      return { png, settle, frame: this.frame };
    } finally {
      await this.send("Runtime.releaseObjectGroup", { objectGroup: group }).catch(() => {});
    }
  }

  // 最近那张整屏截图的「CSS / 图片像素」比（帧过期或没有 = 1）
  frameScale(): number {
    const f = this.frame;
    return f && f.targetId === this.activeTargetId && f.vpW === this.viewport.width && f.vpH === this.viewport.height ? f.k : 1;
  }

  // 带 clip 的截图出图宽度应为 wantW：偏了（桌面壳里 clip.scale 与 zoom 叠出来的语义和文档不一致）就按比例重截一次。
  private async capture(params: Record<string, unknown>, wantW: number): Promise<Buffer> {
    let r = await this.send("Page.captureScreenshot", params);
    if (!r?.data) throw new Error("captureScreenshot returned no data");
    let buf = Buffer.from(r.data, "base64");
    const clip = params.clip as { scale: number } | undefined;
    const got = pngSize(buf).width;
    if (clip && wantW > 0 && got > 0 && Math.abs(got - wantW) > 2) {
      r = await this.send("Page.captureScreenshot", { ...params, clip: { ...clip, scale: clip.scale * (wantW / got) } });
      if (r?.data) buf = Buffer.from(r.data, "base64");
    }
    return buf;
  }

  private async shotElement(opts: ScreenshotOptions, group: string): Promise<string> {
    if (opts.ref != null) {
      const { backendId } = this.refInfo(opts.ref);
      const { object } = await this.send("DOM.resolveNode", { backendNodeId: backendId, objectGroup: group });
      if (!object?.objectId) throw new Error(`ref${opts.ref}: element is gone (page changed since ReadPage) — ReadPage again`);
      return object.objectId;
    }
    const sel = String(opts.selector);
    const r = await this.send("Runtime.evaluate", { expression: `document.querySelector(${JSON.stringify(sel)})`, objectGroup: group });
    if (r?.exceptionDetails) throw new Error(`invalid CSS selector ${JSON.stringify(sel)}`);
    if (!r?.result?.objectId) throw new Error(`no element matches selector ${JSON.stringify(sel)}`);
    return r.result.objectId;
  }

  private async callOn(objectId: string, fn: string): Promise<any> {
    const r = await this.send("Runtime.callFunctionOn", { objectId, functionDeclaration: fn, returnByValue: true });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || "page script failed");
    return r?.result?.value;
  }

  // 等页面「停下来」：字体、有限长的动画，最后两帧（后台页的 rAF 可能不跑，每帧最多等 100ms）。
  // 返回等了多久、到点时还有几个动画没跑完（那张截图可能是半截的，结果里要说）。
  private async settleAnimations(maxMs: number): Promise<{ waitedMs: number; stillRunning: number }> {
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
    } catch {
      return { waitedMs: 0, stillRunning: 0 }; // 页面拒绝脚本（CSP 之类）就不等，照常截
    }
  }

  // ── Accessibility snapshot ──────────────────────────────────────────────────

  // Read the page as an indented accessibility tree. Interactive nodes get a
  // [refN] tag; refs stay valid until the next snapshot or navigation.
  async axSnapshot(
    opts: { filter?: "all" | "interactive"; query?: string; maxChars?: number; rootBackendId?: number; depth?: number } = {},
  ): Promise<AxSnapshot> {
    const filter = opts.filter ?? "all";
    const maxChars = Math.max(2000, Math.min(80_000, opts.maxChars ?? 20_000));
    const r = await this.send("Accessibility.getFullAXTree", {});
    const nodes: any[] = r?.nodes ?? [];
    const byId = new Map<string, any>();
    for (const n of nodes) byId.set(String(n.nodeId), n);
    // rootBackendId：只列这个 DOM 节点的子树（ReadPage(ref)）；depth：从根往下最多展开几层
    const root = opts.rootBackendId != null
      ? nodes.find((n) => n.backendDOMNodeId === opts.rootBackendId)
      : (nodes.find((n) => !n.parentId) ?? nodes[0]);
    if (!root) {
      if (opts.rootBackendId != null) throw new Error("that element is no longer in the accessibility tree (the page changed) — ReadPage again for fresh refs");
      return { text: "(empty accessibility tree)", refCount: 0, lineCount: 0, truncated: false };
    }
    const maxDepth = Number(opts.depth) > 0 ? Number(opts.depth) : Infinity;

    // Link lines end with their address (same-origin as path only, no javascript:, capped at 120 chars)
    // so the model can navigate without an extra Eval over querySelectorAll.
    const pageRoot = nodes.find((n) => String(n.role?.value ?? "") === "RootWebArea" && axUrl(n)) ?? nodes.find((n) => !n.parentId);
    let origin = "";
    try { origin = new URL(axUrl(pageRoot)).origin; } catch { /* no page url on the root: write links in full */ }
    const linkUrl = (node: any, name: string): string => {
      const url = axUrl(node);
      if (!url || /^javascript:/i.test(url)) return "";
      let shown = url;
      try {
        const u = new URL(url);
        if (origin && origin !== "null" && u.origin === origin) shown = u.pathname + u.search + u.hash;
      } catch { /* not a parseable URL: keep as is */ }
      if (shown === name || url === name) return "";
      return ` → ${shown.length > 120 ? `${shown.slice(0, 119)}…` : shown}`;
    };

    this.refs.clear();
    let refN = 0;
    const lines: string[] = [];

    const emit = (node: any, depth: number): void => {
      const role = String(node.role?.value ?? "").toLowerCase();
      const name = String(node.name?.value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
      const children: any[] = (node.childIds ?? [])
        .map((id: string) => byId.get(String(id)))
        .filter(Boolean);

      if (SKIP_ROLES.has(role)) return;
      if (node.ignored || (PROMOTE_ROLES.has(role) && !name)) {
        for (const c of children) emit(c, depth);
        return;
      }

      const states: string[] = [];
      for (const p of node.properties ?? []) {
        const pn = String(p.name ?? "");
        const pv = p.value?.value;
        if (pn === "focusable" || pn === "readonly" || pv === false || pv == null) continue;
        if (["focused", "disabled", "required", "expanded", "selected", "pressed", "checked", "invalid", "multiline", "editable", "autocomplete", "haspopup", "level"].includes(pn)) {
          states.push(pv === true ? pn : `${pn}=${pv}`);
        }
      }
      const value = node.value?.value != null && String(node.value.value).trim() !== ""
        ? ` value="${String(node.value.value).replace(/\s+/g, " ").slice(0, 80)}"`
        : "";

      let refTag = "";
      const editable = (node.properties ?? []).some((p: any) => p.name === "editable" && p.value?.value);
      if ((INTERACTIVE_ROLES.has(role) || editable) && node.backendDOMNodeId != null) {
        refN++;
        this.refs.set(refN, { backendId: node.backendDOMNodeId, role, name });
        refTag = ` [ref${refN}]`;
      }

      const displayRole = role === "statictext" ? "text" : role;
      // Drop a StaticText child that merely repeats its parent's name (the
      // dominant pattern under links/buttons/headings) — pure noise.
      const href = role === "link" ? linkUrl(node, name) : "";
      const line = `${"  ".repeat(depth)}- ${displayRole}${name ? ` "${name}"` : ""}${refTag}${value}${states.length ? ` (${states.join(", ")})` : ""}${href}`;
      const isRefLine = refTag !== "";
      if (filter === "all" || isRefLine) {
        lines.push(filter === "interactive" ? line.trimStart() : line);
      }

      if (depth + 1 > maxDepth) return;
      for (const c of children) {
        const cRole = String(c.role?.value ?? "").toLowerCase();
        const cName = String(c.name?.value ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
        if (cRole === "statictext" && cName && cName === name) continue;
        emit(c, depth + 1);
      }
    };
    emit(root, 0);

    let out = lines;
    if (opts.query) {
      const q = opts.query.toLowerCase();
      out = lines.filter((l) => l.toLowerCase().includes(q)).map((l) => l.trimStart());
    }

    const total = out.length;
    let text = out.join("\n");
    let truncated = false;
    if (text.length > maxChars) {
      truncated = true;
      text = text.slice(0, maxChars);
      const cut = text.lastIndexOf("\n");
      if (cut > 0) text = text.slice(0, cut);
      const kept = text.split("\n").length;
      text += `\n… (truncated: showing ${kept} of ${total} lines — narrow with query or filter:"interactive")`;
    }
    if (!text.trim()) text = opts.query ? `(no nodes matching "${opts.query}")` : "(empty accessibility tree)";
    return { text, refCount: refN, lineCount: total, truncated };
  }

  refInfo(ref: number): { backendId: number; role: string; name: string } {
    const e = this.refs.get(ref);
    if (!e) {
      throw new Error(`ref${ref} is unknown — refs come from ReadPage and reset on every snapshot/navigation. Run ReadPage again.`);
    }
    return e;
  }

  // Scroll a ref's element into view and return its viewport center. Uses
  // DOM.resolveNode + callFunctionOn (works even where getBoxModel is flaky).
  async refCenter(ref: number): Promise<{ x: number; y: number; objectId: string }> {
    const { backendId } = this.refInfo(ref);
    const { object } = await this.send("DOM.resolveNode", { backendNodeId: backendId });
    if (!object?.objectId) throw new Error(`ref${ref}: element is gone (page changed since ReadPage)`);
    const r = await this.send("Runtime.callFunctionOn", {
      objectId: object.objectId,
      functionDeclaration:
        "function(){ this.scrollIntoView({block:'center',inline:'center'}); const r=this.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2,w:r.width,h:r.height}; }",
      returnByValue: true,
    });
    const c = r?.result?.value;
    if (!c || c.w === 0 || c.h === 0) throw new Error(`ref${ref}: element has no visible box (hidden?)`);
    await delay(100);
    return { x: c.x, y: c.y, objectId: String(object.objectId) };
  }


  // 页面正文：article / main / [role=main] 优先，退回 body——读文章、文档比 ReadPage 的无障碍树省得多。
  // 正文里有 open shadow DOM 时按扁平树取字（Web Components 渲染的代码示例、日期不再丢）；连续重复的长行折成「行（×N）」。
  async pageText(maxChars = 20_000): Promise<{ from: string; title: string; text: string; total: number; truncated: boolean; shadow: number }> {
    const cap = Math.max(1000, Math.min(100_000, Number(maxChars) || 20_000));
    const core = loadPageTextCore();
    const r = await this.eval(core ? core.pageTextExpression({ limit: cap * 4 }) : PAGE_TEXT_PLAIN);
    const raw = String(r?.text || "");
    const text = core ? core.foldRepeatedLines(raw) : raw;
    return {
      from: String(r?.from || ""), title: String(r?.title || ""), text: text.length > cap ? text.slice(0, cap) : text,
      total: text.length, truncated: text.length > cap || !!r?.more, shadow: Number(r?.shadow) || 0,
    };
  }


  async setColorScheme(scheme: "dark" | "light" | "auto"): Promise<void> {
    await this.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme === "auto" ? "" : scheme }],
    });
    await delay(200);
  }

  // Reload the CURRENT page at an emulated devicePixelRatio ≠ 1 and check every
  // canvas's backing store for DPR-scaling bugs. Real displays run DPR 1.25–3
  // (Windows default scaling, every phone); headless defaults to 1 — the ONE
  // ratio where "size × dpr" feedback loops are symptom-free, so passing
  // screenshots at DPR 1 prove nothing for canvas-drawing pages. The probe
  // reloads (entrance animations re-run under the new DPR), wheel-scrolls
  // through the page with REAL input (programmatic scrollTo does not feed
  // smooth-scroll libraries, so lazy charts would never initialize), samples
  // canvas geometry twice with no input in between, then restores DPR 1.
  async canvasDprProbe(dpr = 2): Promise<CanvasProbeReport> {
    const { width, height } = this.viewport;
    const SAMPLE_JS = `(() => {
      const cs = [...document.querySelectorAll("canvas")].map((cv, i) => {
        const r = cv.getBoundingClientRect();
        return { id: cv.id || ("canvas#" + i), attrW: cv.width, attrH: cv.height, rectW: Math.round(r.width), rectH: Math.round(r.height) };
      });
      return { docH: Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0), canvases: cs };
    })()`;
    const setDpr = (v: number) =>
      this.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: v, mobile: false });
    try {
      await setDpr(dpr);
      await this.reload();
      await delay(700); // let entrance JS run
      // Cruise with real wheel input so IO/ScrollTrigger reveals and chart
      // entrance animations actually run under the probed DPR. Step count is
      // capped: an exploding page never reaches its own bottom.
      for (let i = 0; i < 60; i++) {
        await this.wheel(Math.floor(width / 2), Math.floor(height / 2), 700);
        await delay(80);
        const done = await this.eval(
          "window.scrollY + innerHeight >= document.documentElement.scrollHeight - 4",
        ).catch(() => true);
        if (done) break;
      }
      await delay(600);
      const s0 = (await this.eval(SAMPLE_JS)) as CanvasProbeSample;
      await delay(1200); // zero input in this window — any growth is a feedback loop
      const s1 = (await this.eval(SAMPLE_JS)) as CanvasProbeSample;
      const verdict = judgeCanvasProbe(s0, s1, dpr);
      return {
        dpr,
        canvasCount: s1.canvases.length,
        ...verdict,
        note: s1.canvases.length === 0 ? "page has no <canvas> — nothing DPR-sensitive to probe" : undefined,
      };
    } finally {
      // Always hand the shared browser back at DPR 1 in a fresh, sane state.
      // 桌面壳模式必须【彻底清掉】模拟：留一个尺寸 override 在真 WebContentsView 上，
      // 画面就会被钉在控件左上角裁掉（见 setViewport 注释）。
      if (this.desktopBroker) await this.send("Emulation.clearDeviceMetricsOverride", {}).catch(() => {});
      else await setDpr(1).catch(() => {});
      await this.reload().catch(() => {});
    }
  }

  async reload(): Promise<{ settled: boolean; ms: number }> {
    const t0 = Date.now();
    const loaded = new Promise<void>((res) => this.loadWaiters.push(res));
    await this.send("Page.reload", {});
    await Promise.race([loaded, delay(10_000)]);
    const s = await this.settle({ since: t0, quietMs: 300, maxMs: 3000 });
    return { settled: s.settled, ms: Date.now() - t0 };
  }

  protected async startCast(): Promise<void> {
    await this.send("Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      maxWidth: 1600,
      maxHeight: 1600,
      everyNthFrame: 1,
    });
    this.casting = true;
  }


  consoleEntries(): ConsoleEntry[] {
    return this.consoleBuf;
  }

  clearConsole(): void {
    this.consoleBuf = [];
  }

  networkEntries(): NetEntry[] {
    return this.netOrder;
  }

  async responseBody(requestId: string): Promise<{ body: string; base64: boolean }> {
    const r = await this.send("Network.getResponseBody", { requestId });
    return { body: String(r?.body ?? ""), base64: Boolean(r?.base64Encoded) };
  }
}
