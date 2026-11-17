// 持久 headless Chrome/Edge 会话，经 Node 内置 WebSocket 说 CDP——零第三方依赖。
// 从 harness/server/cdp.ts 移植（去 TS 类型；砍掉 attach 外部应用与 canvas DPR 探针，
// bridge 的 Claude 分页用不上）。一个 CdpSession = 一个自有浏览器进程的首个 page target：
// 页面状态跨工具调用存活、console/network CDP 原生捕获、a11y 树带 [refN] 句柄、
// screencast 首订阅即播/末订阅即停。多实例管理（按工作空间）在 claude-browser.mjs。

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { liveDesktopHost } from './desktop-host.mjs';
import './cdp-ax.mjs';
import './cdp-page-text.mjs';
import './cdp-events.mjs';
import './cdp-input.mjs';
import './png-scale.mjs';
import { findBrowser, headlessArgs } from './cdp/shared.mjs';
import { CdpConnectMethods } from './cdp/connect.mjs';
import { CdpPageMethods } from './cdp/page.mjs';
import { CdpInputMethods } from './cdp/input.mjs';
import { CdpViewMethods } from './cdp/view.mjs';
export { SHOT_MAX_PX, MUT_INIT, pngSize, findBrowser, VIEWPORT_PRESETS, VIEWPORT_MIN, VIEWPORT_MAX, presetKeyFor, resolveViewportSpec, mobileUserAgent, desktopUserAgent, headlessArgs } from './cdp/shared.mjs';

export class CdpSession {
  child = null;
  spawnError = null;   // 子进程 'error' 事件（spawn 本身失败），由 readDevToolsPort 报出
  ws = null;
  tmp = '';
  nextId = 1;
  pending = new Map();
  loadWaiters = [];
  dead = false;
  url = '';
  viewport = { width: 1280, height: 900 };
  // 仿真旗标：mobile=触屏设备（touch 事件 + 移动端 UA + headless 下 viewport-meta 语义）、
  // scheme=prefers-color-scheme、dpr=deviceScaleFactor（只有 headless 能改，壳里跟显示器）。
  emu = { mobile: false, scheme: 'auto', dpr: 1 };
  // 最近一次 resize/截图后从页面里实测回来的 innerWidth/innerHeight 等。工具把它和期望值
  // 一起报给 agent——视口到底有没有真生效，以页面自己说的为准，不靠「我发过命令了」。
  measured = null;
  // 最近一次视口下发的结果（桌面壳旧版没有 viewport 接口时在这里留痕，工具如实报出）。
  applied = { ok: true, via: 'none' };
  baseUa = '';          // 真实 UA（改成移动端 UA 前先记住，好复原）
  uaOverridden = false;
  // 桌面壳的 DPR 校正（见 syncShellMetrics）：当前 target 上只覆盖 DSF 的值（0=没覆盖）、
  // 显示器本身的 DPR（量出来的）、agent 有没有用 resize(dpr) 指定过。
  dsfOverride = 0;
  displayDpr = 0;
  dprExplicit = false;
  // 新壳（2026-10-26）：几何与 DPR 由壳的设备指标覆盖负责（PUT viewport 回包 metrics:true），这里只量不校。
  shellMetrics = false;

  // ── 标签页（多 target，移植自 harness 011c927）──────────────────────────
  // 一条 browser 级 WebSocket 跑 Target 域（发现/新建/关闭/激活标签），page 级
  // ws 永远附着在「当前标签」上——工具、直播、输入回传都不用知道标签存在。
  tabs = [];              // [{id, url, title, active}]
  activeTargetId = '';
  debugPort = 0;
  // S10：/json/* 的基址——无头 = 调试端口；桌面壳 = broker 的 CDP 转发（新壳没有调试端口），旧壳才是它的调试端口
  cdpBase = '';
  browserWs = null;
  bNextId = 1;
  bPending = new Map();
  tabSubs = new Set();
  // 换附着（切标签/关当前标签）期间旧 page ws 的 close 不算 session 死亡。
  retargetN = 0;
  // bridge-client 桌面壳把 Electron 自己的 DevTools 端口传进来。此模式不再起
  // headless Edge；每个会话只拥有自己创建的 target，用户与 agent 看/操作同一页。
  external = false;
  sharedHost = null;   // 共享无头宿主的句柄（持久配置档，headless-host.mjs）；external 且无 desktopBroker 时有值
  closed = null;       // close() 的善后 Promise（共享宿主时 = 标签关完、宿主若因此退出也退完）
  // 隔离存储（claude-browser.mjs 按会话开关）：共享宿主里本会话独占的浏览上下文——cookie / 存储 / 缓存都不和别的会话共用，
  // 关掉即清空。'' = 用宿主的默认上下文（持久配置档，登录态共享）。
  browserContextId = '';
  desktopBroker = '';
  ownedTargets = new Set();
  // Web Bridge（用户自己的 Edge / Chrome，经扩展，runtime/web-bridge.mjs）：传输层 + 用户分享来、接手的标签
  //（close 只断开、绝不关它们）。这个模式下不做任何视口 / UA / 触屏仿真——那是用户正在用的窗口。
  webBridge = null;
  adopted = new Set();

  consoleBuf = [];
  // 文档纪元：主框架每换一次文档（导航 / 刷新，cdp-events 维护）、每换一次附着（切标签 / 重连，见 connect）
  // 就加一，console 条目落库时打上当前纪元。缓冲是整个会话共用的——同工作空间的别的对话、之前的页面
  // 留下的旧报错以前原样交给 agent（11-07 会话 9e77cfb8 被别人访问过的 awwwards 报错带偏两轮），
  // 现在 consoleEntries() 默认只给当前文档的。
  docSeq = 0;
  // 页面弹过的原生对话框（alert/confirm/prompt/beforeunload），由 cdp-events 自动应答后记在这里；
  // 工具层按序号取「这次动作期间弹过的」写进结果，agent 才知道页面说了什么、我们替它点了什么。
  dialogs = [];
  dialogSeq = 0;
  dialogReported = 0;   // 已回报给 agent 的最大序号（browser-extra.mjs dialogNote 推进）
  netByReqId = new Map();
  netOrder = [];
  // screencast：首个观众订阅即开播、最后一个离开即停。
  castSubs = new Set();
  casting = false;
  lastFrame = null;
  pointerSubs = new Set();
  viewportSubs = new Set();
  // ref → a11y 节点句柄，每次 axSnapshot 重建；backendId 驱动点击/输入。
  refs = new Map();
  // 主框架导航与加载状态（cdp-events 维护）：settle 据此区分「页面还在跳转」与「已经安定」。
  mainFrameId = '';
  navSeq = 0;
  loading = false;
  loadingSince = 0;
  // 最近一次 screenshot 的帧：图片像素 ↔ CSS 像素的换算比、当时的视口与标签。agent 给的
  // x,y 一律按这张图的像素读，frameToCss 换算并做越界检查（同 localPc 的做法）。
  frame = null;
  // 带 clip 的截图出图宽度应为 wantW。桌面壳里叠了 DSF 覆盖（syncShellMetrics）时，clip.scale 的
  // 语义不再是「CSS 像素 × scale × devicePixelRatio」（实测按覆盖值而不是 覆盖×zoom 算，1280 宽的
  // 视口截出 2038），这里量出偏差按比例重截一次，并把修正系数按当时的仿真记住，下次一次到位。
  shotFix = { key: '', c: 1 };
  // 桌面档的 navigator.maxTouchPoints：带触屏的电脑上真值是 10（主机台实测），按触点数判设备的页面会把「桌面档」
  // 当成触屏走另一套分支。桌面档把它盖成 0——新文档靠 addScriptToEvaluateOnNewDocument（按标签记 id）、当前文档
  // 当场盖；切回触屏档撤掉，交给 setTouchEmulationEnabled 报 5。旧壳的转发白名单没有这两个方法，失败就算了。
  touch0 = new Map();   // targetId → addScriptToEvaluateOnNewDocument 的 identifier
  // 谁开着这个浏览器的面板：claude-dock 的直播连接（/api/claude/browser/stream）各登记一条，断开即撤。
  // info = { kind: 'native' 桌面壳原生面板 | 'stream' 帧流面板 | 'guest' 快照访客, where: '手机' | '网页端' | '桌面客户端' }。
  // 工具据此（加上 shellViewState）告诉 agent 用户此刻看不看得到页面——要用户动手前先确认他看得见（对齐 Claude 桌面端 tabs_context）。
  viewers = new Map();
  viewerSeq = 0;

  get alive() {
    return !this.dead && this.ws?.readyState === WebSocket.OPEN
      && (this.webBridge ? this.webBridge.connected
        : this.external ? this.sharedHost?.alive !== false : this.child?.exitCode == null);
  }

  async launch(startUrl, { desktop = true, profileDir = '', isolate = false } = {}) {
    this.isolate = Boolean(isolate);   // 只对共享无头宿主有意义；临时 profile 本来就是独立进程
    // 宿主来源：env（壳 spawn 直传）→ 运行中注册（附着形态）→ 落盘文件（重启后）。
    // 现探活：壳没开/已退出 → 回落 headless，功能永不因壳缺席而断。
    // profileDir = 持久配置档（共享无头宿主）；空 = 临时 profile（快照访客、分享链接）。
    // desktop:false = 不进壳（壳里的 persist:agent-browser 分区是主机自己的网站登录态）：成员等其他属主的
    // 浏览器由 claude-browser.mjs 这样起，走无头（成员 = 他自己的持久配置档，临时身份 = 临时 profile；开源路线 C6）。
    const host = desktop ? await liveDesktopHost() : null;
    if (host) {
      await this.attachDesktop(host, startUrl || 'about:blank');
      return;
    }
    const browser = findBrowser();
    if (!browser) throw new Error('本机未找到 Chrome/Edge，无法启动浏览器');
    // 持久配置档（claude-browser.mjs 按属主给：主机身份 / 成员账号）：附着到这个人的共享无头宿主，登录态长期保留。
    // 宿主起不来（配置档被不应答的进程占着之类）就回落临时 profile——浏览器能用比记住登录更要紧。
    if (profileDir) {
      try {
        await this.attachShared(profileDir, browser, startUrl || 'about:blank');
        return;
      } catch (e) {
        console.warn('[cdp] 持久配置档不可用，改用临时 profile：', e?.message || e);
        this.external = false;
        this.browserContextId = '';
        this.ownedTargets.clear();
        try { this.browserWs?.close(); } catch {}
        this.browserWs = null;
        this.sharedHost?.release();
        this.sharedHost = null;
      }
    }
    this.tmp = mkdtempSync(path.join(tmpdir(), 'bridge-cdp-'));
    const args = [
      ...headlessArgs(this.viewport),
      `--user-data-dir=${path.join(this.tmp, 'profile')}`,
      startUrl || 'about:blank',
    ];
    this.child = spawn(browser, args, { stdio: 'ignore', windowsHide: true });
    // spawn 失败（EACCES / EMFILE / Edge 自更新换目录导致的 ENOENT…）是【异步的
    // 'error' 事件】，不是同步抛。没有监听者时 EventEmitter 会 throw，直接把整个
    // bridge 进程打死——没有任何路由 try/catch 接得住。存下来让 readDevToolsPort
    // 立刻报出真正的原因，而不是干等 15 秒超时。
    this.child.on('error', (e) => { this.dead = true; this.spawnError = e; });
    this.child.on('exit', () => { this.dead = true; });
    this.url = startUrl;

    const port = await this.readDevToolsPort();
    this.debugPort = port;
    this.cdpBase = `http://127.0.0.1:${port}`;
    const pages = await this.waitPages(port);
    const page = pages[0];
    this.activeTargetId = String(page.id ?? '');
    await this.connect(String(page.webSocketDebuggerUrl));
    await this.enableDomains();
    this.seedTabs(pages);
    await this.connectBrowserSocket().catch((e) => {
      // 目标管理不可用时退化为单标签（标签条只读，×/＋会报错）
      console.warn('[cdp] tab management unavailable:', e?.message || e);
    });
    // --window-size 给的是窗口外框，首屏 CSS 视口实测只有 1258×746——先把默认视口真落一次，
    // 否则 viewport 字段说 1280×900、页面却不是，click(x,y) 的坐标系从一开始就是歪的。
    await this.applyEmulation().catch(() => {});
  }


  close() {
    this.dead = true;
    clearTimeout(this.tabRefreshTimer);
    if (this.webBridge) {
      // 用户的浏览器：只断开（摘调试器），标签一个都不关——要关自己开的标签走 closeOwnTabs（close 动作）
      this.ownedTargets.clear();
      this.adopted.clear();
      try { this.ws?.close(); } catch {}
      try { this.browserWs?.close(); } catch {}
      this.ws = null;
      this.browserWs = null;
      this.closed = Promise.resolve();
      this.tabs = [];
      this.notifyTabs();
      return;
    }
    if (this.external) {
      // 只关本会话拥有的 target，绝不能杀 Electron（那里面还有 bridge UI 与其他工作空间）/ 共享宿主（同一个人别的工作空间）。
      const targets = [...this.ownedTargets];
      this.ownedTargets.clear();
      const closing = targets.map((targetId) => this.closeOwnedTarget(targetId).catch(() => {}));
      const host = this.sharedHost;
      this.sharedHost = null;
      const ctxId = this.browserContextId;
      this.browserContextId = '';
      this.closed = Promise.allSettled(closing).then(async () => {
        // 隔离上下文：显式销毁（断连接也会销毁，这里先说一声，宿主那边立刻清掉它的存储）
        if (ctxId) await this.bsend('Target.disposeBrowserContext', { browserContextId: ctxId }).catch(() => {});
        try { this.browserWs?.close(); } catch {}
        return host?.release();   // 最后一个会话走了，宿主体面退出（Cookie 落盘）
      });
      try { this.ws?.close(); } catch {}
      this.ws = null;
      this.tabs = [];
      this.notifyTabs();
      return;
    }
    // 先让浏览器自己整树退出（Windows 上 msedge 会把子进程挂在别处，只杀根 PID 偶尔收不干净），
    // 再兜底杀根进程
    try { if (this.browserWs?.readyState === WebSocket.OPEN) this.browserWs.send(JSON.stringify({ id: this.bNextId++, method: 'Browser.close' })); } catch { /* ignore */ }
    try { this.ws?.close(); } catch { /* ignore */ }
    try { this.browserWs?.close(); } catch { /* ignore */ }
    try { this.child?.kill('SIGKILL'); } catch { /* ignore */ }
    if (this.tmp) { try { rmSync(this.tmp, { recursive: true, force: true }); } catch { /* best effort */ } }
    this.ws = null;
    this.browserWs = null;
    this.child = null;
    this.tabs = [];
    this.notifyTabs();
  }
}

// CdpSession 的其余方法按职责分在 cdp/ 下的几个类里（方法体原样），在这里装回 CdpSession.prototype：原型上的自有方法
// 与拆分前是同一套，替换原型方法（测试换 launch / close 之类）的写法照样成立。字段仍全部在上面的类体里，初始化顺序不变。
for (const methods of [CdpConnectMethods, CdpPageMethods, CdpInputMethods, CdpViewMethods]) {
  for (const key of Object.getOwnPropertyNames(methods.prototype)) {
    if (key !== 'constructor') Object.defineProperty(CdpSession.prototype, key, Object.getOwnPropertyDescriptor(methods.prototype, key));
  }
}
