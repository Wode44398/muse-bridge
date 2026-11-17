// CdpSession 的接入与标签方法（方法体原样，由 cdp.mjs 装回 CdpSession.prototype）：桌面壳 / 共享宿主 / Web Bridge 接入、两条 CDP 连接、标签、页面事件、对话框。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { handleBrowserMessage, handlePageMessage } from '../cdp-events.mjs';
import { delay, headlessArgs, MAX_CONSOLE } from './shared.mjs';

export class CdpConnectMethods {
  // Electron 的 renderer 与多个工作空间浏览器都在同一个调试端口上。先连 browser
  // Target 域，再创建带所有权记录的 page；之后 list/tabs 只认 ownedTargets，绝不把
  // bridge UI 自身或另一个工作空间的 target 混进当前 agent。
  async attachDesktop(host, startUrl) {
    this.external = true;
    this.desktopBroker = String(host?.brokerUrl || '').replace(/\/+$/, '');
    if (!this.desktopBroker) throw new Error('桌面浏览器 broker 未启动');
    this.debugPort = Number(host?.cdpPort || 0);
    this.cdpBase = String(host?.cdpBase || (this.debugPort > 0 ? `http://127.0.0.1:${this.debugPort}` : '')).replace(/\/+$/, '');
    if (!this.cdpBase) throw new Error('桌面浏览器既没有 CDP 转发也没有调试端口');
    this.url = startUrl;
    await this.connectBrowserSocket();
    const marker = `about:blank#bridge-native-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const created = await this.desktopTarget('POST', '', { url: marker });
    const id = String(created?.targetId ?? '');
    if (!id) throw new Error('桌面浏览器 broker 没有返回 targetId');
    this.ownedTargets.add(id);
    this.activeTargetId = id;
    const pages = await this.waitPages(this.debugPort);
    const page = pages.find((p) => String(p.id ?? '') === id);
    if (!page?.webSocketDebuggerUrl) throw new Error('Electron browser target 未暴露调试连接');
    await this.connect(String(page.webSocketDebuggerUrl));
    await this.enableDomains();
    this.seedTabs([{ ...page, url: startUrl }]);
    // 壳里新 target 的逻辑视口默认 1280×900，这里下发一次让两边对齐（顺带触屏/配色旗标）。
    await this.applyEmulation().catch(() => {});
    // 去掉只用于认领 target 的 marker；about:blank 用零等待导航，其余沿用正常 settle。
    if (startUrl === 'about:blank') {
      await this.send('Page.navigate', { url: 'about:blank' });
      this.url = 'about:blank';
      this.syncActiveTabUrl(this.url);
    } else {
      await this.navigate(startUrl);
    }
  }

  // 附着到某个持久配置档的共享无头宿主（runtime/headless-host.mjs）：进程归宿主，本会话只拥有自己建的标签。
  async attachShared(profileDir, browserPath, startUrl) {
    const { acquireHeadlessHost } = await import('../headless-host.mjs');
    this.sharedHost = await acquireHeadlessHost(profileDir, { browserPath, args: headlessArgs(this.viewport) });
    this.external = true;
    this.debugPort = this.sharedHost.port;
    this.cdpBase = this.sharedHost.cdpBase;
    this.url = startUrl;
    await this.connectBrowserSocket();
    if (this.isolate) {
      // disposeOnDetach：这条 browser 级连接一断（close / bridge 崩了）上下文就随之销毁，不会在宿主里留下孤儿
      const c = await this.bsend('Target.createBrowserContext', { disposeOnDetach: true });
      this.browserContextId = String(c?.browserContextId || '');
      if (!this.browserContextId) throw new Error('Target.createBrowserContext returned no id');
    }
    const id = await this.createOwnedTarget('about:blank');
    if (!id) throw new Error('Target.createTarget returned no targetId');
    this.activeTargetId = id;
    const pages = await this.waitPages(this.debugPort);
    const page = pages.find((p) => String(p.id ?? '') === id);
    if (!page?.webSocketDebuggerUrl) throw new Error('新标签没有暴露调试连接');
    await this.connect(String(page.webSocketDebuggerUrl));
    await this.enableDomains();
    this.seedTabs([{ ...page, url: 'about:blank' }]);
    await this.applyEmulation().catch(() => {});
    if (startUrl !== 'about:blank') await this.navigate(startUrl);
  }

  // 附着到用户自己的浏览器（Web Bridge 扩展的一条链路上、属于这个 agent 会话的那部分）。
  // transport：runtime/web-bridge.mjs WebBridgeHub.transport()。标签 id 是扩展给的 't<tabId>'。
  // 会话自己标签组里已有的标签（客户端重启前开的、用户拖进来的）全部认领；adopt = 先接手这个用户分享的标签；
  // 都没有就在会话的标签组里新开一个空白标签。
  async attachWebBridge(transport, { adopt = '' } = {}) {
    this.external = true;
    this.webBridge = transport;
    this.applied = { ok: true, via: 'user-browser' };
    await this.connectBrowserSocket();
    const { mine, shared } = await transport.list();
    for (const t of mine) this.ownedTargets.add(String(t.id));
    let id = '';
    if (adopt) {
      if (![...mine, ...shared].some((t) => String(t.id) === adopt)) throw new Error(`标签 ${adopt} 不在你的标签组里，也不在用户分享的「Web Bridge」组里——先 tabs() 看能用哪些`);
      this.ownedTargets.add(adopt);
      if (!mine.some((t) => String(t.id) === adopt)) this.adopted.add(adopt);
      id = adopt;
    } else {
      id = String((mine.find((t) => t.active) || mine[0])?.id || '');
    }
    if (!id) {
      const created = await this.bsend('Target.createTarget', { url: 'about:blank' });
      id = String(created?.targetId ?? '');
      if (!id) throw new Error('浏览器没有返回新标签');
      this.ownedTargets.add(id);
    }
    this.activeTargetId = id;
    await this.connect(`wb:${id}`);
    await this.enableDomains();
    const pages = [...mine, ...shared].filter((t) => this.ownedTargets.has(String(t.id)));
    this.seedTabs(pages.length ? pages : [{ id, url: 'about:blank', title: '' }]);
    this.url = String(pages.find((t) => String(t.id) === id)?.url || 'about:blank');
    this.measured = await this.measure();
    if (this.measured?.w > 0) this.viewport = { width: this.measured.w, height: this.measured.h };
  }

  // Web Bridge：把一个用户分享的标签接进来并切过去（tab_select / 任何带 tab:"t…" 的动作）。
  async adoptTab(targetId) {
    const id = String(targetId || '');
    if (!this.webBridge || !id || this.ownedTargets.has(id)) {
      if (id && id !== this.activeTargetId && this.ownedTargets.has(id)) await this.activateTab(id);
      return;
    }
    const { mine, shared } = await this.webBridge.list();
    const t = [...mine, ...shared].find((x) => String(x.id) === id);
    if (!t) throw new Error(`标签 ${id} 不在你的标签组里，也不在用户分享的「Web Bridge」组里——先 tabs() 看能用哪些`);
    this.ownedTargets.add(id);
    if (!mine.some((x) => String(x.id) === id)) this.adopted.add(id);
    this.upsertTab({ id, url: String(t.url || ''), title: String(t.title || ''), active: false });
    try {
      await this.activateTab(id);
    } catch (e) {
      // 别的会话正占着它：退回原状，报原因
      this.ownedTargets.delete(id);
      this.adopted.delete(id);
      const i = this.tabs.findIndex((x) => x.id === id);
      if (i >= 0) { this.tabs.splice(i, 1); this.notifyTabs(); }
      throw e;
    }
  }

  // Web Bridge 的 close 动作：关掉本会话自己开的标签（用户分享来的只断开）。返回关了几个。
  async closeOwnTabs() {
    if (!this.webBridge) return 0;
    // 也算上会话组里还没接手过的（客户端重启前开的、漏报的弹窗）；用户拖进组的标签扩展会拒关（只关 agent 自己开的）
    const ids = new Set([...this.ownedTargets].filter((id) => !this.adopted.has(id)));
    try { for (const t of (await this.webBridge.list()).mine) ids.add(String(t.id)); } catch { /* 列不出就只关已知的 */ }
    let n = 0;
    for (const id of ids) {
      try { await this.bsend('Target.closeTarget', { targetId: id }); n++; } catch { /* 用户已经关了 / 不是 agent 开的 */ }
    }
    return n;
  }

  // 建 / 关一个本会话拥有的标签：桌面壳经 broker，共享无头宿主经 Target 域。
  async createOwnedTarget(url) {
    const r = this.desktopBroker
      ? await this.desktopTarget('POST', '', { url })
      : await this.bsend('Target.createTarget', this.browserContextId ? { url, browserContextId: this.browserContextId } : { url });
    const id = String(r?.targetId ?? '');
    if (id) this.ownedTargets.add(id);
    return id;
  }

  closeOwnedTarget(id) {
    return this.desktopBroker ? this.desktopTarget('DELETE', id) : this.bsend('Target.closeTarget', { targetId: id });
  }

  async desktopTarget(method, id = '', body = null) {
    if (!this.desktopBroker) throw new Error('desktop browser broker unavailable');
    const response = await fetch(this.desktopBroker + '/target' + (id ? '/' + encodeURIComponent(id) : ''), {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 204) return { ok: true };
    let payload = null;
    try { payload = await response.json(); } catch { /* empty */ }
    if (!response.ok) throw new Error(payload?.error || `desktop browser broker HTTP ${response.status}`);
    return payload || { ok: true };
  }

  async enableDomains() {
    await this.send('Page.enable', {});
    await this.send('Runtime.enable', {});
    await this.send('DOM.enable', {});
    await this.send('Log.enable', {}).catch(() => {});
    await this.send('Network.enable', { maxTotalBufferSize: 20_000_000, maxResourceBufferSize: 8_000_000 }).catch(() => {});
    await this.send('Accessibility.enable', {}).catch(() => {});
  }

  // Chrome 把真实调试端口写进 <user-data-dir>/DevToolsActivePort。
  async readDevToolsPort(timeoutMs = 15_000) {
    const file = path.join(this.tmp, 'profile', 'DevToolsActivePort');
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (existsSync(file)) {
        const line = readFileSync(file, 'utf8').split('\n')[0]?.trim();
        const p = Number(line);
        if (p > 0) return p;
      }
      if (this.spawnError) throw new Error('浏览器启动失败：' + (this.spawnError.message || this.spawnError));
      if (this.child?.exitCode != null) throw new Error('浏览器进程在暴露调试端口前退出了');
      await delay(80);
    }
    throw new Error('等待浏览器调试端口超时');
  }

  // 轮询 /json/list 直到出现真实 page target，返回完整页列表（id/url/title/ws url）。
  async waitPages(port, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const pages = await this.listPages();
        if (pages.length) return pages;
      } catch { /* not ready */ }
      await delay(80);
    }
    throw new Error('浏览器未暴露 page target');
  }

  async listPages() {
    if (this.webBridge) return (await this.webBridge.listPages()).filter((t) => this.ownedTargets.has(String(t.id ?? '')));
    const res = await fetch(`${this.cdpBase}/json/list`);
    const targets = await res.json();
    const pages = targets.filter(
      (t) => t.type === 'page' && t.webSocketDebuggerUrl && !/^(devtools|chrome-extension):/.test(String(t.url ?? '')),
    );
    return this.external ? pages.filter((t) => this.ownedTargets.has(String(t.id ?? ''))) : pages;
  }

  connect(wsUrl) {
    return new Promise((resolve, reject) => {
      // Web Bridge 的标签：wb:<targetId> → 扩展上的一个页面频道（别的会话占着这个标签时 error 里带原因）
      const ws = this.webBridge && String(wsUrl).startsWith('wb:') ? this.webBridge.openPage(String(wsUrl).slice(3)) : new WebSocket(wsUrl);
      this.ws = ws;
      this.dsfOverride = 0;   // 仿真随 CDP 会话走：换附着后新 target 上没有我们的覆盖
      // 换附着 = 换了一份文档：之后 Runtime/Log.enable 重放的是新标签当前文档自己的日志，正好落进新纪元
      this.docSeq++;
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (ev) => reject(new Error(this.webBridge && ev?.message ? ev.message : 'CDP websocket error')));
      ws.addEventListener('message', (ev) => this.onMessage(String(ev.data)));
      ws.addEventListener('close', () => {
        for (const p of this.pending.values()) p.reject(new Error('CDP connection closed'));
        this.pending.clear();
        // 换附着（切标签）是我们主动关的旧 ws——session 没死，工具无感。
        if (this.retargetN > 0) return;
        this.dead = true;
      });
    });
  }

  // ── 标签页管理（browser 级 Target 域）───────────────────────────────────

  connectBrowserSocket() {
    return new Promise((resolve, reject) => {
      (async () => {
        let ws;
        if (this.webBridge) ws = this.webBridge.openBrowser();   // 扩展用 chrome.tabs / tabGroups 模拟 Target 域
        else {
          const res = await fetch(`${this.cdpBase}/json/version`);
          const v = await res.json();
          const wsUrl = v?.webSocketDebuggerUrl;
          if (!wsUrl) throw new Error('browser exposes no browser-level debugger url');
          ws = new WebSocket(wsUrl);
        }
        this.browserWs = ws;
        ws.addEventListener('open', async () => {
          try {
            await this.bsend('Target.setDiscoverTargets', { discover: true });
            resolve();
          } catch (e) { reject(e); }
        });
        ws.addEventListener('error', () => reject(new Error('browser CDP websocket error')));
        ws.addEventListener('message', (ev) => this.onBrowserMessage(String(ev.data)));
        ws.addEventListener('close', () => {
          this.browserWs = null;
          for (const p of this.bPending.values()) p.reject(new Error('browser CDP connection closed'));
          this.bPending.clear();
        });
      })().catch(reject);
    });
  }

  bsend(method, params) {
    if (!this.browserWs || this.browserWs.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('browser-level CDP not connected'));
    }
    const id = this.bNextId++;
    this.browserWs.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.bPending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.bPending.has(id)) { this.bPending.delete(id); reject(new Error(`CDP ${method} timed out`)); }
      }, 15_000);
    });
  }

  onBrowserMessage(data) {
    handleBrowserMessage(this, data);
  }

  seedTabs(pages) {
    this.tabs = pages.map((p) => ({
      id: String(p.id ?? ''),
      url: String(p.url ?? ''),
      title: String(p.title ?? ''),
      active: String(p.id ?? '') === this.activeTargetId,
    }));
    this.notifyTabs();
  }

  upsertTab(tab) {
    const cur = this.tabs.find((t) => t.id === tab.id);
    if (cur) {
      cur.url = tab.url || cur.url;
      cur.title = tab.title || cur.title;
    } else {
      this.tabs.push(tab);
    }
    this.notifyTabs();
  }

  // 目标从外面没了（页面 window.close()、崩溃、我们关的）：同步列表；若是当前
  // 标签且不是我们在换附着，自动接管下一个标签，一个都不剩就开张空白页——
  // 浏览器进程还在，面板不该掉进「未启动」死态。
  onTargetGone(id) {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const wasActive = this.tabs[idx].active;
    this.tabs.splice(idx, 1);
    if (this.external) this.ownedTargets.delete(id);
    this.notifyTabs();
    if (!wasActive || this.retargetN > 0 || !this.alive) return;
    const next = this.tabs[0];
    if (next) this.activateTab(next.id).catch(() => {});
    else if (this.webBridge) this.close();   // 用户浏览器里不替他凭空开空白标签：断开，下次 navigate 再开
    else this.newTab().catch(() => {});
  }

  subscribeTabs(cb) {
    this.tabSubs.add(cb);
    try { cb(this.tabs.map((t) => ({ ...t }))); } catch { /* subscriber's problem */ }
    return () => this.tabSubs.delete(cb);
  }

  notifyTabs() {
    const snap = this.tabs.map((t) => ({ ...t }));
    for (const cb of this.tabSubs) {
      try { cb(snap); } catch { /* subscriber's problem */ }
    }
  }

  // 标题/地址以 /json/list 为准再对一遍：headless 下 Target.targetInfoChanged 常常不报
  // 标题变化（标签条和 tabs() 全是 host/path），页面加载完与 agent 看列表前各对一次。
  async refreshTabs() {
    if (this.dead) return;
    let pages;
    try { pages = await this.listPages(); } catch { return; }
    let changed = false;
    for (const tab of this.tabs) {
      const p = pages.find((item) => String(item.id ?? '') === tab.id);
      if (!p) continue;
      const url = String(p.url ?? '') || tab.url;
      const title = String(p.title ?? '') || tab.title;
      if (url !== tab.url || title !== tab.title) { tab.url = url; tab.title = title; changed = true; }
    }
    if (changed) this.notifyTabs();
  }

  refreshTabsSoon() {
    clearTimeout(this.tabRefreshTimer);
    this.tabRefreshTimer = setTimeout(() => { this.refreshTabs(); }, 150);
  }

  syncActiveTabUrl(url) {
    const tab = this.tabs.find((t) => t.active);
    if (tab && tab.url !== url) {
      tab.url = url;
      this.notifyTabs();
    }
  }

  requireTargetDomain() {
    if (!this.browserWs || this.browserWs.readyState !== WebSocket.OPEN) {
      throw new Error('该浏览器不支持标签页管理');
    }
  }

  // 新建标签并切过去（＋按钮；url 缺省 about:blank）。
  async newTab(url = 'about:blank') {
    this.requireTargetDomain();
    const id = this.external
      ? await this.createOwnedTarget(url || 'about:blank')
      : String((await this.bsend('Target.createTarget', { url: url || 'about:blank' }))?.targetId ?? '');
    if (!id) throw new Error('Target.createTarget returned no targetId');
    this.upsertTab({ id, url: url || 'about:blank', title: '', active: false });
    await this.activateTab(id);
    return id;
  }

  // 把 page 级附着换到另一个标签：旧 ws 停播/关闭 → 连新目标 → 重开域、
  // 重挂视口、恢复直播。工具层无感——之后所有操作都落在新的前台标签上。
  async activateTab(id) {
    if (id === this.activeTargetId) return;
    const pages = await this.listPages();
    const target = pages.find((p) => String(p.id ?? '') === id);
    if (!target?.webSocketDebuggerUrl) throw new Error(`标签 ${id} 已不存在`);
    this.retargetN++;
    try {
      const resume = this.casting;
      if (resume) {
        this.casting = false;
        await this.send('Page.stopScreencast', {}).catch(() => {});
      }
      try { this.ws?.close(); } catch { /* ignore */ }
      this.ws = null;
      this.refs.clear();   // backendId 是每页私有的，旧标签的 ref 全部作废
      this.lastFrame = null;
      this.mainFrameId = '';
      this.loading = false;
      await this.connect(String(target.webSocketDebuggerUrl));
      await this.enableDomains();
      // 先换 activeTargetId 再重挂视口：桌面壳模式下视口是按 target id 发给壳的，
      // 晚一步就把新标签的视口发到旧标签上（新标签停在 1280×900、面板档位却亮着手机）。
      this.activeTargetId = id;
      await this.setViewport(this.viewport.width, this.viewport.height).catch(() => {});
      this.url = String(target.url ?? '');
      for (const t of this.tabs) t.active = t.id === id;
      await this.bsend('Target.activateTarget', { targetId: id }).catch(() => {});
      if (resume) {
        try { await this.startCast(); } catch { /* 下一帧来了自然恢复 */ }
      }
      this.notifyTabs();
    } finally {
      this.retargetN--;
    }
  }

  // 关闭标签（×按钮）。关的是当前标签就接管下一个；最后一个标签 = 关窗口，
  // 整个浏览器退出（面板回到「未启动」空态，地址栏/＋可重新拉起）。
  async closeTab(id) {
    this.requireTargetDomain();
    const tab = this.tabs.find((t) => t.id === id);
    if (!tab) return;
    if (!tab.active) {
      if (this.external) await this.closeOwnedTarget(id);
      else await this.bsend('Target.closeTarget', { targetId: id });
      const i = this.tabs.findIndex((t) => t.id === id);
      if (i >= 0) { this.tabs.splice(i, 1); this.notifyTabs(); }
      if (this.external) this.ownedTargets.delete(id);
      return;
    }
    const rest = this.tabs.filter((t) => t.id !== id);
    this.retargetN++;
    try {
      if (this.external) await this.closeOwnedTarget(id);
      else await this.bsend('Target.closeTarget', { targetId: id });
      const i = this.tabs.findIndex((t) => t.id === id);
      if (i >= 0) { this.tabs.splice(i, 1); this.notifyTabs(); }
      if (this.external) this.ownedTargets.delete(id);
      if (rest.length) await this.activateTab(rest[0].id);
      else this.close();
    } finally {
      this.retargetN--;
    }
  }

  pushConsole(type, msg) {
    this.consoleBuf.push({ t: Date.now(), type, msg: String(msg).slice(0, 2000), doc: this.docSeq, url: this.url });
    if (this.consoleBuf.length > MAX_CONSOLE) this.consoleBuf.splice(0, this.consoleBuf.length - MAX_CONSOLE);
  }

  onMessage(data) {
    handlePageMessage(this, data);
  }

  send(method, params, timeoutMs = 30_000) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('CDP not connected'));
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }
      }, timeoutMs);
    });
  }

  // 页面弹出原生对话框（cdp-events 收到 Page.javascriptDialogOpening 时调）。对话框会把页面主线程
  // 整个挡住——之后的 eval / 点击 / 塞文件统统等不到回执，headless 里又没人去点「确定」。所以一律
  // 当场应答：alert、beforeunload 点确定（只是通知 / 放行离开）；confirm、prompt 点取消——它们常
  // 守着删除之类的动作，不能替 agent 默认同意。真要确认，先 eval 把 window.confirm 换成返回 true。
  onDialog(params = {}) {
    const type = String(params.type || 'alert');
    const accept = type === 'alert' || type === 'beforeunload';
    const entry = { seq: ++this.dialogSeq, type, message: String(params.message || '').slice(0, 500), accepted: accept, t: Date.now() };
    this.dialogs.push(entry);
    if (this.dialogs.length > 20) this.dialogs.splice(0, this.dialogs.length - 20);
    this.pushConsole(`dialog.${type}`, `${entry.message}（已自动${accept ? '点确定' : '取消'}）`);
    this.send('Page.handleJavaScriptDialog', { accept }, 5_000).catch(() => {});
  }

  /** 序号 mark 之后弹过的对话框（工具在动作前记 mark = dialogSeq）。 */
  dialogsSince(mark) { return this.dialogs.filter((d) => d.seq > mark); }
}
