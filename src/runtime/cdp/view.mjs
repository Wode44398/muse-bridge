// CdpSession 的视口与观看方法（方法体原样，由 cdp.mjs 装回 CdpSession.prototype）：视口与仿真、桌面壳指标、触屏、UA、测量、观看者、配色、投屏、控制台与网络记录。
import { delay, desktopUaMetadata, desktopUserAgent, HOST_PLATFORM, mobileUaMetadata, mobileUserAgent, presetKeyFor, SCHEMES, VIEWPORT_MAX, VIEWPORT_MIN } from './shared.mjs';

export class CdpViewMethods {
  // 改视口（CSS 像素）+ 可选仿真旗标 {mobile, scheme, dpr}（没给的沿用当前）。落地后从页面
  // 实测一遍 innerWidth/innerHeight，返回 viewportReport()——期望值、实测值、下发结果三样
  // 齐全，调用方直接转述给 agent。
  async setViewport(width, height, opts = {}) {
    if (this.webBridge) {
      // 用户自己的窗口：不改尺寸，只量实际视口（切标签后坐标系以它为准）
      this.measured = await this.measure();
      if (this.measured?.w > 0) this.viewport = { width: this.measured.w, height: this.measured.h };
      return this.viewportReport();
    }
    const w = Math.max(VIEWPORT_MIN, Math.min(VIEWPORT_MAX, Math.round(width)));
    const h = Math.max(VIEWPORT_MIN, Math.min(VIEWPORT_MAX, Math.round(height)));
    this.viewport = { width: w, height: h };
    this.emu = {
      mobile: opts.mobile != null ? Boolean(opts.mobile) : this.emu.mobile,
      scheme: opts.scheme != null && SCHEMES.includes(String(opts.scheme)) ? String(opts.scheme) : this.emu.scheme,
      dpr: opts.dpr != null ? Math.max(1, Math.min(3, Number(opts.dpr) || 1)) : this.emu.dpr,
    };
    if (opts.dpr != null) this.dprExplicit = Number(opts.dpr) > 0;   // dpr 0 = 撤回指定、跟随显示器
    await this.applyEmulation();
    await delay(250); // 等响应式布局稳定
    this.measured = await this.measure();
    // 壳/面板重摆是异步的：实测没跟上就再等一拍量一次，别把过渡态当结论报出去。
    if (this.measured && (this.measured.w !== w || this.measured.h !== h)) {
      await delay(450);
      this.measured = await this.measure();
    }
    this.notifyViewport();
    return this.viewportReport();
  }

  // 把 viewport + emu 真正落到页面上，两种模式各走各的实现：
  //  - headless（自家 Edge）：CDP 设备指标模拟就是实现（mobile:true 连 viewport-meta 的真机
  //    规则一起仿——没 meta 的页面会像真手机一样按 980px 排版再缩小，measure 会把这点报出来）；
  //  - 桌面壳（真 WebContentsView）：逻辑视口交给壳（broker PUT target/<id>/viewport →
  //    壳按 contain 缩放 / 停靠尺寸重摆），这一层【绝不】叠 setDeviceMetricsOverride——
  //    override 撞 zoom 会把 CSS 视口翻倍、比控件大还会把画面钉在左上角裁掉（client/desktop
  //    main.cjs fitBounds 注释有实测数据）。2026-09-10 之前壳只在面板挂载那一刻才知道视口，
  //    面板没开/远端在看时 resize 等于没发生，页面 innerWidth 纹丝不动。
  //  触屏 / UA / 配色三样是页面级仿真，与几何无关，两种模式通用。
  async applyEmulation() {
    if (this.webBridge) return;
    const { width: w, height: h } = this.viewport;
    const { mobile, scheme, dpr } = this.emu;
    if (this.desktopBroker) {
      this.applied = await this.desktopViewport(w, h);
      await delay(120);
      await this.syncShellMetrics({ force: true }).catch(() => {});
    } else {
      await this.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile });
      this.applied = { ok: true, via: 'emulation' };
    }
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: 5 }).catch(() => {});
    await this.send('Emulation.setEmitTouchEventsForMouse', { enabled: mobile, configuration: 'mobile' }).catch(() => {});
    await this.syncTouchPoints(mobile);
    // 无头每次都下发（桌面档也要把 HeadlessChrome 换掉）；壳里是真 Electron UA，只在切过触屏后复原
    if (mobile || this.uaOverridden || !this.desktopBroker) {
      if (!this.baseUa) this.baseUa = await this.realUserAgent();
      const phone = Math.min(w, h) < 600;
      const params = mobile
        ? { userAgent: mobileUserAgent(this.baseUa, phone), platform: 'Linux armv8l', userAgentMetadata: mobileUaMetadata(this.baseUa, phone) }
        : this.desktopBroker
          ? { userAgent: this.baseUa, platform: HOST_PLATFORM[0] }
          : { userAgent: desktopUserAgent(this.baseUa), platform: HOST_PLATFORM[0], userAgentMetadata: desktopUaMetadata(this.baseUa) };
      if (params.userAgent) await this.send('Emulation.setUserAgentOverride', params).catch(() => {});
      this.uaOverridden = mobile;
    }
    await this.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme === 'auto' ? '' : scheme }],
    }).catch(() => {});
  }

  // 桌面壳：几何靠壳的 contain 缩放（setZoomFactor），而 Chromium 的 zoom【按 origin 同 session 共享】——
  //  ① 跨站导航后视图继承了别的面板给这个 origin 设的缩放，停靠尺寸却没跟着重算，innerWidth 就偏了
  //    （实测 1280 变 2037）。导航 / 切标签 / 截图前量一次，偏了就让壳按逻辑视口重摆。
  //  ② devicePixelRatio = 显示器缩放 × zoom：面板一缩，页面看到的就是 0.94、0.53 这种真机上不存在的
  //    值——canvas 发糊、DPR 相关的 bug 测不出，resize(dpr) 也落不下去。用【只覆盖 DSF】（width/height
  //    传 0，几何不动；实测与 zoom 相乘、真视图画面照常）把它拨回：没指定 = 显示器本身的 DPR，
  //    指定了 = 指定值。
  // m 传入刚量的实测可省一次 eval；返回校正后的实测。
  async syncShellMetrics({ force = false, m = null } = {}) {
    if (!this.desktopBroker) return m;
    m = m || await this.measure();
    if (!m) return m;
    const { width: w, height: h } = this.viewport;
    // 新壳精确到像素，差 1 也是真偏差（覆盖被冲掉之类）；旧壳 zoom 取整天生差 1~2，只管跨站漂移那种大偏差
    const tol = this.shellMetrics ? 0 : 2;
    if (Math.abs(m.w - w) > tol || Math.abs(m.h - h) > tol) {
      this.applied = await this.desktopViewport(w, h);
      await delay(150);
      m = (await this.measure()) || m;
    }
    if (this.shellMetrics) return m;   // DPR 归壳管
    if (!(m.dpr > 0)) return m;
    let zoom;
    if (this.dsfOverride > 0) zoom = m.dpr / this.dsfOverride;
    else {
      // 还没覆盖过：先覆盖成 1 量一次，此时 dpr 就是 zoom；显示器 DPR = 原生 dpr / zoom。
      const natural = m.dpr;
      await this.setDsf(1);
      const z = Number(await this.eval('devicePixelRatio').catch(() => 0));
      if (!(z > 0)) { await this.setDsf(0); return m; }
      zoom = z;
      this.displayDpr = Math.round((natural / z) * 100) / 100;
    }
    const want = this.dprExplicit ? this.emu.dpr : (this.displayDpr || 1);
    const d = Math.min(10, Math.max(0.1, want / zoom));
    if (force || Math.abs(d - this.dsfOverride) > 0.005) {
      await this.setDsf(d);
      m = (await this.measure()) || m;
    }
    return m;
  }


  async syncTouchPoints(mobile) {
    const src = "try{Object.defineProperty(navigator,'maxTouchPoints',{get:()=>0,configurable:true})}catch(e){}";
    const id = this.touch0.get(this.activeTargetId);
    if (!mobile) {
      if (!id) {
        const r = await this.send('Page.addScriptToEvaluateOnNewDocument', { source: src }).catch(() => null);
        if (r?.identifier) this.touch0.set(this.activeTargetId, r.identifier);
      }
      await this.send('Runtime.evaluate', { expression: src }).catch(() => {});
    } else {
      if (id) {
        await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: id }).catch(() => {});
        this.touch0.delete(this.activeTargetId);
      }
      await this.send('Runtime.evaluate', { expression: 'delete navigator.maxTouchPoints' }).catch(() => {});
    }
  }

  // 只覆盖 deviceScaleFactor（0 = 撤掉覆盖）。mobile 恒 false：壳里触屏走 setTouchEmulationEnabled，
  // 这里带 mobile 会顺带打开 viewport-meta 语义，把没 meta 的页面按 980px 重排。
  async setDsf(d) {
    if (d > 0) await this.send('Emulation.setDeviceMetricsOverride', { width: 0, height: 0, deviceScaleFactor: d, mobile: false });
    else await this.send('Emulation.clearDeviceMetricsOverride', {});
    this.dsfOverride = d > 0 ? d : 0;
  }

  async realUserAgent() {
    try {
      const v = await this.send('Browser.getVersion', {});
      if (v?.userAgent) return String(v.userAgent);
    } catch { /* 有的目标不给 Browser 域，退回页面里读 */ }
    try { return String((await this.eval('navigator.userAgent')) || ''); } catch { return ''; }
  }

  // 桌面壳：让壳改这个 target 的逻辑视口。旧壳没有这个接口 → 如实记下来，工具会告诉 agent
  // 「壳需要更新」而不是假装生效。
  async desktopViewport(width, height) {
    if (!this.activeTargetId) return { ok: false, via: 'shell', error: '没有前台标签' };
    try {
      const res = await fetch(`${this.desktopBroker}/target/${encodeURIComponent(this.activeTargetId)}/viewport`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        // dpr：新壳据此设设备指标覆盖（0 = 跟随显示器）；旧壳不认这个字段，DPR 仍由 syncShellMetrics 校
        body: JSON.stringify({ width, height, dpr: this.dprExplicit ? this.emu.dpr : 0 }),
        signal: AbortSignal.timeout(4000),
      });
      let payload = null;
      try { payload = await res.json(); } catch { /* 旧壳 404 没有 body */ }
      if (res.status === 404 && !payload) return { ok: false, via: 'shell', error: '桌面壳版本过旧，不支持改视口（更新 bridge-client 后重开）' };
      if (!res.ok || !payload?.ok) return { ok: false, via: 'shell', error: payload?.error || `桌面壳 HTTP ${res.status}` };
      if (payload.metrics) {
        this.shellMetrics = true;
        if (!this.dprExplicit && Number(payload.dpr) > 0) this.displayDpr = Number(payload.dpr);
      }
      return { ok: true, via: 'shell', mounted: Boolean(payload.mounted), zoom: payload.zoom, metrics: Boolean(payload.metrics) };
    } catch (e) {
      return { ok: false, via: 'shell', error: `桌面壳没有应答：${e?.message || e}` };
    }
  }

  // 从页面里实测视口——resize 到底生效没有，以页面自己说的为准。
  async measure() {
    try {
      const m = await this.eval(
        "(()=>({w:innerWidth,h:innerHeight,dpr:Math.round(devicePixelRatio*1000)/1000,touch:navigator.maxTouchPoints,coarse:matchMedia('(pointer:coarse)').matches,dark:matchMedia('(prefers-color-scheme: dark)').matches,meta:!!document.querySelector('meta[name=viewport i]'),mobileUa:/Mobile|Android/.test(navigator.userAgent)}))()",
      );
      return m && typeof m === 'object' ? { ...m, at: Date.now() } : null;
    } catch { return null; }
  }

  // 视口的完整快照：期望值 + 仿真旗标 + 页面实测 + 下发结果 + 命中的档位。
  viewportReport() {
    return {
      viewport: { ...this.viewport },
      emu: { ...this.emu },
      // 桌面壳没指定 DPR 时跟随显示器（syncShellMetrics 校正后的目标值）
      dprAuto: Boolean(this.desktopBroker) && !this.dprExplicit,
      dprWant: this.desktopBroker && !this.dprExplicit ? (this.displayDpr || 0) : this.emu.dpr,
      measured: this.measured ? { ...this.measured } : null,
      applied: { ...this.applied },
      preset: presetKeyFor(this.viewport.width, this.viewport.height),
    };
  }


  addViewer(info = {}) {
    const id = ++this.viewerSeq;
    this.viewers.set(id, { ...info, since: Date.now() });
    return () => { this.viewers.delete(id); };
  }

  // 桌面壳：当前标签此刻是不是挂在主窗口面板里、窗口有没有显示（broker GET target/<id>/view）。旧壳没有这条 → null。
  async shellViewState() {
    if (!this.desktopBroker || !this.activeTargetId) return null;
    try {
      const res = await fetch(`${this.desktopBroker}/target/${encodeURIComponent(this.activeTargetId)}/view`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return null;
      const payload = await res.json();
      return payload?.ok ? payload : null;
    } catch { return null; }
  }

  // 视口变化广播（回调收到 viewportReport()）：面板的设备钮点亮/实测角标靠它，桌面壳
  // 观众还要靠它按新视口重新缩放摆放原生视图（agent 自己调 browser(resize) 时用户那边
  // 也得跟上）。
  subscribeViewport(cb) {
    this.viewportSubs.add(cb);
    return () => this.viewportSubs.delete(cb);
  }

  notifyViewport() {
    const snap = this.viewportReport();
    for (const cb of this.viewportSubs) {
      try { cb(snap); } catch { /* subscriber's problem */ }
    }
  }

  async setColorScheme(scheme) {
    await this.send('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: scheme === 'auto' ? '' : scheme }],
    });
    await delay(200);
  }

  async startCast() {
    await this.send('Page.startScreencast', { format: 'jpeg', quality: 60, maxWidth: 1600, maxHeight: 1600, everyNthFrame: 1 });
    this.casting = true;
  }

  // 订阅 screencast 帧，返回退订函数。首订开播、末订停播；切标签由 activateTab 续播。
  async subscribeCast(cb) {
    this.castSubs.add(cb);
    if (this.lastFrame) { try { cb(this.lastFrame); } catch { /* ignore */ } }
    if (!this.casting) {
      try {
        await this.startCast();
      } catch (e) {
        this.casting = false;
        this.castSubs.delete(cb);
        throw e;
      }
    }
    return () => {
      this.castSubs.delete(cb);
      if (this.castSubs.size === 0 && this.casting) {
        this.casting = false;
        this.send('Page.stopScreencast', {}).catch(() => {});
      }
    };
  }

  // 页面坐标处的原生滚轮——滚的是指针下的容器（window.scrollBy 够不到内层滚动区）。
  async wheel(x, y, deltaY, deltaX = 0) {  // deltaX>0 = 向右
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
  }

  // 默认只给当前文档（本纪元）的条目；all:true = 整个缓冲（含之前的页面 / 标签，条目上 doc ≠ docSeq）。
  consoleEntries({ all = false } = {}) { return all ? this.consoleBuf : this.consoleBuf.filter((e) => e.doc === this.docSeq); }
  clearConsole() { this.consoleBuf = []; }
  networkEntries() { return this.netOrder; }

  async responseBody(requestId) {
    const r = await this.send('Network.getResponseBody', { requestId });
    return { body: String(r?.body ?? ''), base64: Boolean(r?.base64Encoded) };
  }
}
