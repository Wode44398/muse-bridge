// 持久 headless Chrome/Edge 会话，经 Node 内置 WebSocket 说 CDP——零第三方依赖。
// 从 harness/server/cdp.ts 移植（去 TS 类型；砍掉 attach 外部应用与 canvas DPR 探针，
// bridge 的 Claude 分页用不上）。一个 CdpSession = 一个自有浏览器进程的首个 page target：
// 页面状态跨工具调用存活、console/network CDP 原生捕获、a11y 树带 [refN] 句柄、
// screencast 首订阅即播/末订阅即停。多实例管理（按工作空间）在 claude-browser.mjs。

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { liveDesktopHost } from './desktop-host.mjs';
import { snapshotAccessibility } from './cdp-ax.mjs';
import { handleBrowserMessage, handlePageMessage } from './cdp-events.mjs';
import { parseKeySpec } from './cdp-input.mjs';

const MAX_CONSOLE = 400;
// 截图长边上限：与官方 computer use 的 maxTargetPx 一致，超过它 Claude Code 会再缩一次图。
export const SHOT_MAX_PX = 1568;
// 不算「还在加载」的长连接类请求（settle 不等它们）。
const LONG_LIVED = new Set(['EventSource', 'WebSocket', 'Ping', 'Manifest', 'CSPViolationReport']);
// 页内 DOM 变动计数器（MutationObserver，按需装一次，导航后新文档自动重装）+ 地址：
// settle 比较这一串是否连续不变。与 browser-verify 的页内助手共用同一个计数器。
// n = DOM 变动条数，s = 滚动事件次数（含内层滚动容器，捕获阶段收）。
export const MUT_INIT = `if(!window.__bridgeMut){const m=window.__bridgeMut={n:0,s:0};try{new MutationObserver((l)=>{m.n+=l.length}).observe(document,{subtree:true,childList:true,attributes:true,characterData:true});addEventListener('scroll',(e)=>{m.s++;m.t=e.target},{capture:true,passive:true})}catch{}}`;
const MUTATION_KEY = `(()=>{${MUT_INIT};return location.href+'#'+window.__bridgeMut.n})()`;

// PNG 头里读宽高（IHDR 固定在第 16~24 字节）。
export function pngSize(buf) {
  if (!buf || buf.length < 24 || buf.readUInt32BE(12) !== 0x49484452) return { width: 0, height: 0 };
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

// 浏览器二进制发现：环境变量优先，Chrome 优先、Edge 兜底（含 x86 路径）。
const BROWSER_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  // Linux（发行版包 / 官方 Chrome / snap）与 macOS
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium', '/usr/bin/microsoft-edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];
export function findBrowser() {
  const env = process.env.BRIDGE_BROWSER || process.env.HEADLESS_BROWSER;
  if (env && existsSync(env)) return env;
  for (const p of BROWSER_CANDIDATES) if (existsSync(p)) return p;
  return null;
}

// 视口档位【单一真相】：agent 的 resize、面板的设备切换按钮、resize 路由必须共用，
// 面板才能仅凭尺寸点亮当前设备档。mobile = 触屏设备语义：touch 事件 + 移动端 UA +
// （headless 下）viewport-meta 的真机处理。三档之外允许任意 width×height 自定义。
export const VIEWPORT_PRESETS = {
  mobile: { width: 375, height: 812, mobile: true },
  tablet: { width: 768, height: 1024, mobile: true },
  desktop: { width: 1280, height: 900, mobile: false },
};
export const VIEWPORT_MIN = 200;
export const VIEWPORT_MAX = 4000;
const SCHEMES = ['auto', 'light', 'dark'];

// 尺寸反查档位（横竖都算同一档）；不是三档之一返回 ''。
export function presetKeyFor(width, height) {
  for (const [key, p] of Object.entries(VIEWPORT_PRESETS)) {
    if ((p.width === width && p.height === height) || (p.width === height && p.height === width)) return key;
  }
  return '';
}

// 把 resize 的参数（preset / width+height / landscape / mobile / scheme / dpr）归一成一份
// 完整的视口规格。cur = 当前 {viewport, emu}，没给的项沿用当前值：只给 scheme/mobile/
// landscape 这类旗标 = 在当前尺寸上改旗标；只给 width = 宽改、高照旧。什么都没给 → null
// （调用方按「查询当前视口」处理）。非法值直接抛，让工具把原因报给 agent。
export function resolveViewportSpec(args = {}, cur = {}) {
  const a = args || {};
  const preset = a.preset ? VIEWPORT_PRESETS[String(a.preset)] : null;
  if (a.preset && !preset) throw new Error(`未知 preset: ${a.preset}（可用 mobile / tablet / desktop）`);
  const hasSize = Boolean(preset) || a.width != null || a.height != null;
  const hasFlag = ['landscape', 'mobile', 'scheme', 'dpr'].some((k) => a[k] != null);
  if (!hasSize && !hasFlag) return null;
  const curVp = cur.viewport || { width: VIEWPORT_PRESETS.desktop.width, height: VIEWPORT_PRESETS.desktop.height };
  const curEmu = cur.emu || { mobile: false, scheme: 'auto', dpr: 1 };
  let width = preset ? preset.width : (a.width != null ? Math.round(Number(a.width)) : curVp.width);
  let height = preset ? preset.height : (a.height != null ? Math.round(Number(a.height)) : curVp.height);
  if (!(width > 0 && height > 0)) throw new Error('resize 需要 preset（mobile/tablet/desktop）或正数的 width / height');
  width = Math.max(VIEWPORT_MIN, Math.min(VIEWPORT_MAX, width));
  height = Math.max(VIEWPORT_MIN, Math.min(VIEWPORT_MAX, height));
  if (a.landscape != null) {
    const landscape = Boolean(a.landscape);
    if (landscape && height > width) [width, height] = [height, width];
    if (!landscape && width > height) [width, height] = [height, width];
  }
  let mobile;
  if (a.mobile != null) mobile = Boolean(a.mobile);
  else if (preset) mobile = preset.mobile;
  else if (a.width != null || a.height != null) mobile = Math.min(width, height) <= 768;   // 自定义尺寸按短边判设备
  else mobile = Boolean(curEmu.mobile);
  const scheme = a.scheme != null ? String(a.scheme) : (curEmu.scheme || 'auto');
  if (!SCHEMES.includes(scheme)) throw new Error('scheme 只能是 light / dark / auto');
  // dpr 只在调用方明说时才进规格：以前没给也填当前值（壳里 = 1），setViewport 当成「指定过」，
  // 随便一次 resize 就把「跟随显示器」钉死成 1（10-26 实测）。0 = 撤回指定、回到跟随显示器。
  const spec = { width, height, mobile, scheme, preset: presetKeyFor(width, height) };
  if (a.dpr != null) {
    const dpr = Number(a.dpr);
    if (!(dpr === 0 || (dpr >= 1 && dpr <= 3))) throw new Error('dpr 只能在 1~3 之间（0 = 跟随显示器）');
    spec.dpr = dpr;
  }
  return spec;
}

// 触屏档的 UA：从真实 UA 抄 Chrome 主版本（按版本号分流的站点不至于把我们当古董浏览器）。
// 短边 <600 当手机（Pixel 8），否则当平板（Galaxy Tab）。
export function mobileUserAgent(baseUa, phone) {
  const major = /Chrome\/(\d+)/.exec(baseUa || '')?.[1] || '128';
  return phone
    ? `Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`
    : `Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}
// 无头 Edge 的 UA 自报 HeadlessChrome/…，navigator.userAgentData 里也挂着 HeadlessChrome——不少站点见了就
// 拦（验证码 / 403 / 降级页），agent 看到的就不是用户会看到的页面。桌面档一律换回普通 Chrome 的自报。
export function desktopUserAgent(baseUa) {
  return String(baseUa || '').replace(/HeadlessChrome\//g, 'Chrome/');
}
const HOST_PLATFORM = process.platform === 'win32' ? ['Win32', 'Windows', '10.0.0']
  : process.platform === 'darwin' ? ['MacIntel', 'macOS', '14.0.0'] : ['Linux x86_64', 'Linux', ''];
function desktopUaMetadata(baseUa) {
  const major = /Chrome\/(\d+)/.exec(baseUa || '')?.[1] || '128';
  return {
    brands: [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }, { brand: 'Not/A)Brand', version: '99' }],
    fullVersion: `${major}.0.0.0`,
    platform: HOST_PLATFORM[1], platformVersion: HOST_PLATFORM[2], architecture: 'x86', model: '', mobile: false,
  };
}
function mobileUaMetadata(baseUa, phone) {
  const major = /Chrome\/(\d+)/.exec(baseUa || '')?.[1] || '128';
  return {
    brands: [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }, { brand: 'Not/A)Brand', version: '99' }],
    fullVersion: `${major}.0.0.0`,
    platform: 'Android', platformVersion: '14', architecture: '', model: phone ? 'Pixel 8' : 'SM-X910', mobile: phone,
  };
}

// 无头 Edge 的公共启动参数（不含 --user-data-dir 与起始页）：临时 profile 与共享宿主（headless-host.mjs）共用。
export function headlessArgs(viewport = { width: 1280, height: 900 }) {
  return [
    '--headless=new',
    // 不再 --disable-gpu：那样 WebGL 走软件光栅（实测 Microsoft Basic Render Driver），重 WebGL / 多 canvas
    // 页面又慢又卡。有显卡就用显卡，没有 Chromium 自己回落软件；BRIDGE_CDP_DISABLE_GPU=1 可复原旧行为。
    ...(process.env.BRIDGE_CDP_DISABLE_GPU === '1' ? ['--disable-gpu'] : []),
    '--no-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    // 验收滚条类视觉时设 BRIDGE_CDP_KEEP_SCROLLBARS=1 保留滚条（默认隐藏，screencast 更干净）
    ...(process.env.BRIDGE_CDP_KEEP_SCROLLBARS ? [] : ['--hide-scrollbars']),
    '--force-device-scale-factor=1',
    `--window-size=${viewport.width},${viewport.height}`,
    '--remote-debugging-port=0',
  ];
}

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
  desktopBroker = '';
  ownedTargets = new Set();

  consoleBuf = [];
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

  get alive() {
    return !this.dead && this.ws?.readyState === WebSocket.OPEN
      && (this.external ? this.sharedHost?.alive !== false : this.child?.exitCode == null);
  }

  async launch(startUrl, { desktop = true, profileDir = '' } = {}) {
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
    const { acquireHeadlessHost } = await import('./headless-host.mjs');
    this.sharedHost = await acquireHeadlessHost(profileDir, { browserPath, args: headlessArgs(this.viewport) });
    this.external = true;
    this.debugPort = this.sharedHost.port;
    this.cdpBase = this.sharedHost.cdpBase;
    this.url = startUrl;
    await this.connectBrowserSocket();
    const created = await this.bsend('Target.createTarget', { url: 'about:blank' });
    const id = String(created?.targetId ?? '');
    if (!id) throw new Error('Target.createTarget returned no targetId');
    this.ownedTargets.add(id);
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

  // 建 / 关一个本会话拥有的标签：桌面壳经 broker，共享无头宿主经 Target 域。
  async createOwnedTarget(url) {
    const r = this.desktopBroker
      ? await this.desktopTarget('POST', '', { url })
      : await this.bsend('Target.createTarget', { url });
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
    const res = await fetch(`${this.cdpBase}/json/list`);
    const targets = await res.json();
    const pages = targets.filter(
      (t) => t.type === 'page' && t.webSocketDebuggerUrl && !/^(devtools|chrome-extension):/.test(String(t.url ?? '')),
    );
    return this.external ? pages.filter((t) => this.ownedTargets.has(String(t.id ?? ''))) : pages;
  }

  connect(wsUrl) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      this.ws = ws;
      this.dsfOverride = 0;   // 仿真随 CDP 会话走：换附着后新 target 上没有我们的覆盖
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', () => reject(new Error('CDP websocket error')));
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
        const res = await fetch(`${this.cdpBase}/json/version`);
        const v = await res.json();
        const wsUrl = v?.webSocketDebuggerUrl;
        if (!wsUrl) throw new Error('browser exposes no browser-level debugger url');
        const ws = new WebSocket(wsUrl);
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
    this.consoleBuf.push({ t: Date.now(), type, msg: String(msg).slice(0, 2000) });
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

  // 带 clip 的截图出图宽度应为 wantW。桌面壳里叠了 DSF 覆盖（syncShellMetrics）时，clip.scale 的
  // 语义不再是「CSS 像素 × scale × devicePixelRatio」（实测按覆盖值而不是 覆盖×zoom 算，1280 宽的
  // 视口截出 2038），这里量出偏差按比例重截一次，并把修正系数按当时的仿真记住，下次一次到位。
  shotFix = { key: '', c: 1 };
  async capture(params, wantW) {
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
  async axSnapshot(opts = {}) {
    return snapshotAccessibility(this.send.bind(this), this.refs, opts);
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

  subscribePointer(cb) {
    this.pointerSubs.add(cb);
    return () => this.pointerSubs.delete(cb);
  }

  echoPointer(kind, x, y, source) {
    for (const cb of this.pointerSubs) {
      try { cb({ kind, x: Math.round(x), y: Math.round(y), source }); } catch { /* subscriber's problem */ }
    }
  }

  async dispatchClick(x, y, opts = {}) {
    const button = opts.button ?? 'left';
    const clickCount = opts.clickCount ?? 1;
    const modifiers = opts.modifiers ?? 0;
    // 触屏仿真（resize mobile）下左键点击改发真触摸：此时开着 setEmitTouchEventsForMouse，
    // 合成的 mousePressed 被转成 touchstart 后回执要等整个手势结束才回，而 mouseReleased 要等
    // 这个回执才发——互等 30 秒超时，页面只收到 touchstart、永远等不到 click（agent 和用户在面板
    // 里手点都一样）。dispatchTouchEvent 是触屏下的正路，手势识别照常合成 click。
    if (this.emu?.mobile && button === 'left' && !modifiers) {
      for (let i = 0; i < clickCount; i++) {
        await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      }
      this.echoPointer('click', x, y, opts.source ?? 'agent');
      return;
    }
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, modifiers });
    for (let i = 1; i <= clickCount; i++) {
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, clickCount: i, modifiers });
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, clickCount: i, modifiers });
    }
    this.echoPointer('click', x, y, opts.source ?? 'agent');
  }

  async clickRef(ref, opts = {}) {
    const c = await this.refCenter(ref);
    await this.dispatchClick(c.x, c.y, opts);
  }

  async clickCoord(x, y, opts = {}) {
    await this.dispatchClick(x, y, opts);
  }

  // 按可见文本点击（可交互元素里最佳匹配）——模型跳过 read_page 时的逃生门。
  async clickText(text) {
    const c = await this.findTextPoint(text);
    await this.dispatchClick(c.x, c.y);
  }

  // 按可见文本找可交互元素（滚进视口），返回中心点 CSS 坐标；找不到抛错。
  async findTextPoint(text) {
    const needle = JSON.stringify(text.toLowerCase());
    const c = await this.eval(
      `(()=>{const n=${needle};const sel='a,button,input,select,textarea,[role=button],[role=link],[role=tab],[role=menuitem],[onclick],label';
       const nodes=Array.from(document.querySelectorAll(sel)).filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&r.height>0;});
       const t=el=>(el.getAttribute('aria-label')||el.value||el.innerText||el.textContent||el.getAttribute('placeholder')||'').replace(/\\s+/g,' ').trim().toLowerCase();
       let hit=nodes.find(el=>t(el)===n)||nodes.find(el=>t(el).includes(n));
       if(!hit)return null;hit.scrollIntoView({block:'center'});const r=hit.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`,
    );
    if (!c) throw new Error(`页面上没有文字是「${text}」的可点击元素——换个词，或用 find / read_page 拿 ref`);
    await delay(60);   // 等 scrollIntoView 落定再点
    return c;
  }

  async hoverRef(ref) {
    const c = await this.refCenter(ref);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y });
    this.echoPointer('move', c.x, c.y, 'agent');
  }

  async hoverCoord(x, y, source = 'agent') {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    this.echoPointer('move', x, y, source);
  }

  // ── 手势：长按 / 拖拽 / 双指缩放 ──────────────────────────────────────────
  // 触屏档（emu.mobile）一律走真触摸事件，浏览器自己的手势管线照常判：按住真等 holdMs，长按就补
  // contextmenu、不合成 click；拖动是 touchMove 序列；双指是两个触点同帧移动（不会合成 click）。
  // 鼠标档：按下 → 插值移动（带 buttons）→ 松开。

  async longPress(x, y, holdMs = 800) {
    const hold = Math.max(100, Math.min(10_000, Number(holdMs) || 800));
    if (this.emu?.mobile) {
      // 不能用 dispatchTouchEvent：注入的触摸绕过了浏览器侧的手势识别，按多久都只合成 tap（click），
      // 永远等不到长按 → contextmenu（无头 / 壳实测一致）。触屏档开着 setEmitTouchEventsForMouse，
      // 鼠标事件经触摸仿真器转成触摸、由它做手势识别，长按真补 contextmenu。代价是这对事件的 CDP 回执
      // 要等整个手势收尾、而收尾又在等回执——互相挂住（见 dispatchClick），所以两下都不 await，
      // 回执超时静默丢掉；事件本身照常送达，之后的点击 / 触摸不受影响（实测连按两次再点一下都正常）。
      const quiet = (type, buttons) => this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', buttons, clickCount: 1 }, hold + 3_000).catch(() => {});
      quiet('mousePressed', 1);
      await delay(hold);
      quiet('mouseReleased', 0);
      await delay(150);
    } else {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
      await delay(hold);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    }
    this.echoPointer('click', x, y, 'agent');
  }

  // 返回 { html5 }：鼠标档里起点是 HTML5 可拖元素时，开 setInterceptDrags 把系统拖放接住，改发
  // dragEnter/dragOver/drop。不接的话有头视图（桌面壳）里 Chromium 会进系统拖放循环、等真鼠标松开，
  // 后面的事件全发不进去；headless 里则 dragstart 之后永远等不到 drop。接不住（旧壳没放行这两个
  // 方法）又遇上可拖元素就直说，别硬拖把壳卡住。
  async drag(from, to, { steps = 16, holdMs = 0 } = {}) {
    const n = Math.max(2, Math.min(60, Math.round(Number(steps) || 16)));
    const hold = Math.max(0, Math.min(5_000, Number(holdMs) || 0));
    const at = (i) => ({ x: from.x + ((to.x - from.x) * i) / n, y: from.y + ((to.y - from.y) * i) / n });
    if (this.emu?.mobile) {
      // 触点带显式 id、抬起时点名：不带 id 的触点在 CDP 那边会残留，下一场双指里冒出第三根手指
      const pt = (p) => [{ x: p.x, y: p.y, id: 0 }];
      await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(from) });
      if (hold) await delay(hold);
      for (let i = 1; i <= n; i++) {
        await this.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(at(i)) });
        await delay(16);
      }
      await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: pt(to) });
      this.echoPointer('move', to.x, to.y, 'agent');
      return { html5: false };
    }
    const draggable = await this.eval(`(()=>{const e=document.elementFromPoint(${from.x},${from.y});if(!e)return false;
      const d=e.closest('[draggable]');if(d)return d.getAttribute('draggable')!=='false';
      if(e.closest('a[href],img'))return true;const s=getSelection();return !!(s&&!s.isCollapsed&&s.containsNode(e,true));})()`).catch(() => false);
    let intercept = false;
    if (draggable) {
      intercept = await this.send('Input.setInterceptDrags', { enabled: true }).then(() => true, () => false);
      if (!intercept) throw new Error('起点是可拖拽元素（HTML5 拖放），但当前浏览器不接受拖放拦截（桌面壳版本过旧，更新客户端后可用）——没有硬拖，免得卡住窗口');
    }
    let data = null;
    this.onDragIntercepted = (p) => { data = p?.data || null; };
    try {
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: from.x, y: from.y });
      await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
      if (hold) await delay(hold);
      let i = 1;
      for (; i <= n && !data; i++) {
        const p = at(i);
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'left', buttons: 1 });
        await delay(16);
      }
      if (data) {
        // 拖放从第 i-1 步接管：dragEnter 落在当时的位置，dragOver 走完剩下的路，最后在终点 drop
        const start = at(i - 1);
        await this.send('Input.dispatchDragEvent', { type: 'dragEnter', x: start.x, y: start.y, data });
        for (; i <= n; i++) {
          const p = at(i);
          await this.send('Input.dispatchDragEvent', { type: 'dragOver', x: p.x, y: p.y, data });
          await delay(16);
        }
        await this.send('Input.dispatchDragEvent', { type: 'dragOver', x: to.x, y: to.y, data });
        await this.send('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data });
      }
      await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
    } finally {
      this.onDragIntercepted = null;
      if (intercept) await this.send('Input.setInterceptDrags', { enabled: false }).catch(() => {});
    }
    this.echoPointer('move', to.x, to.y, 'agent');
    return { html5: Boolean(data) };
  }

  // 双指缩放：以 (x,y) 为中心，两指从 ±r 开到 ±r×scale（scale>1 放大、<1 捏合）。只在触屏档有意义。
  async pinch(x, y, scale = 2, { steps = 12, radius = 60 } = {}) {
    if (!this.emu?.mobile) throw new Error('pinch 只在触屏档可用——先 resize(preset:"mobile") 或 resize(mobile:true)');
    const s = Math.max(0.1, Math.min(10, Number(scale) || 2));
    const n = Math.max(2, Math.min(60, Math.round(Number(steps) || 12)));
    const pts = (r) => [{ x: x - r, y, id: 0 }, { x: x + r, y, id: 1 }];
    await this.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(radius) });
    for (let i = 1; i <= n; i++) {
      await this.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(radius * (1 + ((s - 1) * i) / n)) });
      await delay(16);
    }
    await this.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: pts(radius * s) });
  }

  async focusRef(ref) {
    const { backendId } = this.refInfo(ref);
    await this.send('DOM.focus', { backendNodeId: backendId });
  }

  // 聚焦目标（ref 或 CSS selector；都没给则保持当前焦点）。
  async focusTarget(target) {
    if (target?.ref != null) {
      await this.focusRef(target.ref);
    } else if (target?.selector) {
      const ok = await this.eval(
        `(()=>{const e=document.querySelector(${JSON.stringify(target.selector)});if(!e)return false;e.focus();return true;})()`,
      );
      if (!ok) throw new Error(`no element matching selector ${target.selector}`);
    }
  }

  // 聚焦目标后输入文本。
  async typeText(text, target) {
    await this.focusTarget(target);
    await this.send('Input.insertText', { text });
  }

  // 按键或组合键（"enter"、"ctrl+a"、"shift+tab"）；解析细节集中在 cdp-input.mjs。
  async pressKey(spec) {
    const { key, modifiers } = parseKeySpec(spec);
    const ev = {
      key: key.key,
      code: key.code,
      windowsVirtualKeyCode: key.keyCode,
      nativeVirtualKeyCode: key.keyCode,
      modifiers,
    };
    // 可打印键的 keyDown 必须带 text 才会真正输入/提交。
    const withText = key.text && !(modifiers & ~8)
      ? { ...ev, text: key.text, unmodifiedText: key.text }
      : ev;
    await this.send('Input.dispatchKeyEvent', { type: key.text ? 'keyDown' : 'rawKeyDown', ...withText });
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...ev });
  }

  async scrollBy(dy, dx = 0) {
    await this.eval(`window.scrollBy(${Math.round(dx)}, ${Math.round(dy)})`);
    await delay(200);
  }

  // 改视口（CSS 像素）+ 可选仿真旗标 {mobile, scheme, dpr}（没给的沿用当前）。落地后从页面
  // 实测一遍 innerWidth/innerHeight，返回 viewportReport()——期望值、实测值、下发结果三样
  // 齐全，调用方直接转述给 agent。
  async setViewport(width, height, opts = {}) {
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

  // 桌面档的 navigator.maxTouchPoints：带触屏的电脑上真值是 10（主机台实测），按触点数判设备的页面会把「桌面档」
  // 当成触屏走另一套分支。桌面档把它盖成 0——新文档靠 addScriptToEvaluateOnNewDocument（按标签记 id）、当前文档
  // 当场盖；切回触屏档撤掉，交给 setTouchEmulationEnabled 报 5。旧壳的转发白名单没有这两个方法，失败就算了。
  touch0 = new Map();   // targetId → addScriptToEvaluateOnNewDocument 的 identifier
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

  // 谁开着这个浏览器的面板：claude-dock 的直播连接（/api/claude/browser/stream）各登记一条，断开即撤。
  // info = { kind: 'native' 桌面壳原生面板 | 'stream' 帧流面板 | 'guest' 快照访客, where: '手机' | '网页端' | '桌面客户端' }。
  // 工具据此（加上 shellViewState）告诉 agent 用户此刻看不看得到页面——要用户动手前先确认他看得见（对齐 Claude 桌面端 tabs_context）。
  viewers = new Map();
  viewerSeq = 0;
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

  consoleEntries() { return this.consoleBuf; }
  clearConsole() { this.consoleBuf = []; }
  networkEntries() { return this.netOrder; }

  async responseBody(requestId) {
    const r = await this.send('Network.getResponseBody', { requestId });
    return { body: String(r?.body ?? ''), base64: Boolean(r?.base64Encoded) };
  }

  // 往 <input type=file> 塞本机文件（DOM.setFileInputFiles）：隐藏的 input 同样有效，
  // Chrome 会照常派发 input/change。目标 = ref（read_page 句柄）/ CSS selector / 默认第一个
  // file input。先验目标真是 file input，再塞，再回读文件名——不接受多选的框只保留第一个。
  // ref（read_page / find 的句柄）或 CSS selector → 元素的 objectId。
  async objectFor(target = {}) {
    if (target.ref != null) {
      const { backendId } = this.refInfo(target.ref);
      const { object } = await this.send('DOM.resolveNode', { backendNodeId: backendId });
      if (!object?.objectId) throw new Error(`ref${target.ref}: element is gone (page changed since read_page)`);
      return object.objectId;
    }
    if (target.selector) {
      const r = await this.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(target.selector)})`, returnByValue: false });
      if (!r?.result?.objectId) throw new Error(`no element matching selector ${target.selector}`);
      return r.result.objectId;
    }
    throw new Error('需要 ref 或 selector');
  }

  // 直接设表单控件的值（对齐 Claude Code 桌面端 Browser 的 form_input）：原生 <select> 的下拉层截图里看不见、
  // 点开也选不了；date / time / range / color 打字进不去（10-26 实测日期框 type 后仍是空）。这里按控件类型设值，
  // 走原型上的 value setter（React 等受控组件认这个），再派发 input + change。
  async setValue(target, value) {
    const objectId = await this.objectFor(target);
    const r = await this.send('Runtime.callFunctionOn', {
      objectId, returnByValue: true, arguments: [{ value }],
      functionDeclaration: `function(v){
        const el = this, tag = el.tagName, desc = (e) => e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') + (e.name ? '[name=' + e.name + ']' : '');
        const fire = () => { el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
        const truthy = (x) => x === true || /^(true|1|on|yes|checked)$/i.test(String(x));
        try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}
        if (el.disabled) return { ok: false, why: desc(el) + ' 是禁用状态' };
        if (tag === 'SELECT') {
          const opts = [...el.options], want = Array.isArray(v) ? v.map(String) : [String(v)];
          const pick = (w) => opts.find((o) => o.value === w) || opts.find((o) => o.text.trim() === w.trim()) || opts.find((o) => o.text.toLowerCase().includes(w.trim().toLowerCase()));
          const hits = want.map(pick);
          if (hits.some((h) => !h)) return { ok: false, why: '没有匹配「' + want.join('、') + '」的选项', options: opts.slice(0, 30).map((o) => o.text.trim() + (o.value !== o.text.trim() ? ' (' + o.value + ')' : '')) };
          if (el.multiple) opts.forEach((o) => { o.selected = hits.includes(o); }); else el.value = hits[0].value;
          fire();
          return { ok: true, kind: 'select', desc: desc(el), now: [...el.selectedOptions].map((o) => o.text.trim()).join('、') };
        }
        if (tag === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
          const on = truthy(v);
          if (el.checked !== on) { el.click(); if (el.checked !== on) { el.checked = on; fire(); } }
          return { ok: true, kind: el.type, desc: desc(el), now: el.checked ? '已勾选' : '未勾选' };
        }
        if (tag === 'INPUT' || tag === 'TEXTAREA') {
          if (el.type === 'file') return { ok: false, why: '文件框请用 upload' };
          const proto = tag === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
          el.focus();
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, String(v));
          fire();
          const ok = el.value === String(v) || el.type === 'range' || el.type === 'number';
          return { ok, kind: el.type || 'textarea', desc: desc(el), now: el.value, why: ok ? '' : '控件把值改成了「' + el.value + '」（格式不对？date 要 YYYY-MM-DD、time 要 HH:MM、color 要 #rrggbb）' };
        }
        if (el.isContentEditable) {
          el.focus();
          const sel = getSelection(); const range = document.createRange(); range.selectNodeContents(el); sel.removeAllRanges(); sel.addRange(range);
          if (!document.execCommand('insertText', false, String(v))) el.textContent = String(v);
          return { ok: true, kind: 'contenteditable', desc: desc(el), now: el.textContent.slice(0, 80) };
        }
        return { ok: false, why: desc(el) + ' 不是可设值的表单控件（select / input / textarea / contenteditable）——按钮类用 click' };
      }`,
    });
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'set_value 失败');
    return r?.result?.value || { ok: false, why: '没有返回结果' };
  }

  // 页面正文：article / main / [role=main] 优先，退回 body——读文章、文档比 read_page 的无障碍树省得多。
  async pageText(maxChars = 20_000) {
    const r = await this.eval(`(()=>{const pick=document.querySelector('article')||document.querySelector('main,[role=main]')||document.body;const t=(pick?.innerText||'').replace(/\\n{3,}/g,'\\n\\n').trim();return{from:pick?(pick.tagName.toLowerCase()+(pick.id?'#'+pick.id:'')):'',title:document.title,text:t}})()`);
    const text = String(r?.text || '');
    const cap = Math.max(1000, Math.min(100_000, Number(maxChars) || 20_000));
    return { from: r?.from || '', title: r?.title || '', text: text.length > cap ? text.slice(0, cap) : text, total: text.length, truncated: text.length > cap };
  }

  async setInputFiles(files, target = {}) {
    let objectId;
    let chosenNote = '';
    if (target.ref != null) {
      const { backendId } = this.refInfo(target.ref);
      const { object } = await this.send('DOM.resolveNode', { backendNodeId: backendId });
      objectId = object?.objectId;
    } else if (target.selector) {
      const sel = target.selector;
      const r = await this.send('Runtime.evaluate', { expression: `document.querySelector(${JSON.stringify(sel)})`, returnByValue: false });
      objectId = r?.result?.objectId;
      if (!objectId) throw new Error(`no element matching selector ${sel}`);
    } else {
      // 没指定目标：只在【看得见的那部分页面】里找。文件框本身几乎都是隐藏的，所以看它父元素
      // 在不在渲染（display:none / content-visibility:hidden 的分页都算不在）——SPA 常把别的分页
      // 留在后台常驻，document 里的第一个文件框往往属于用户此刻根本没在看的页面（2026-10-07 实遇：
      // 塞进了后台 Claude 页的附件框，30MB 超限弹 alert 把整个页面挡死）。看得见的有多个时
      // 取第一个并在结果里列出其余，让 agent 需要时改用 selector / ref。
      const pick = await this.send('Runtime.evaluate', {
        returnByValue: false,
        expression: `(() => {
          const all = [...document.querySelectorAll('input[type=file]')];
          const shown = (el) => { const p = el.parentElement; if (!p) return false;
            try { return p.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }); } catch { return p.getClientRects().length > 0; } };
          const vis = all.filter(shown);
          const desc = (el) => { const bits = []; let n = el.parentElement;
            for (let k = 0; n && k < 3; k++, n = n.parentElement) { const c = typeof n.className === 'string' ? n.className.trim().split(/\\s+/).find((x) => !/^svelte-/.test(x)) : ''; bits.push(n.tagName.toLowerCase() + (n.id ? '#' + n.id : c ? '.' + c : '')); }
            return (el.multiple ? 'multiple ' : '') + (el.accept ? 'accept=' + el.accept + ' ' : '') + 'in ' + bits.join(' < '); };
          const el = vis[0] || null;
          window.__bridgeUploadPick = { total: all.length, visible: vis.length, chosen: el ? desc(el) : '', others: vis.slice(1, 5).map(desc) };
          return el;
        })()`,
      });
      objectId = pick?.result?.objectId;
      const meta = await this.send('Runtime.evaluate', { expression: 'window.__bridgeUploadPick', returnByValue: true }).then((x) => x?.result?.value || {}, () => ({}));
      if (!objectId) {
        throw new Error(meta.total
          ? `页面上有 ${meta.total} 个文件输入框，但都在当前看不见的部分（后台分页 / 已收起的面板）——先把要上传的界面打开，或用 selector / ref 明确指定`
          : '页面上没有 <input type=file>');
      }
      chosenNote = `（自动选了当前可见部分的文件框：${meta.chosen}${meta.others?.length ? `；可见的还有 ${meta.others.length} 个：${meta.others.join(' | ')}，要换就给 selector / ref` : ''}）`;
    }
    if (!objectId) throw new Error('目标元素已不在页面上（read_page 之后页面变了）');
    const probe = await this.send('Runtime.callFunctionOn', {
      objectId, returnByValue: true,
      functionDeclaration: "function(){ const ok = this instanceof HTMLInputElement && this.type === 'file'; return { ok, tag: this.tagName, type: this.type || '', multiple: !!this.multiple, id: this.id || '', name: this.name || '' }; }",
    });
    const info = probe?.result?.value || {};
    if (!info.ok) throw new Error(`目标不是 <input type=file>（是 ${info.tag || '?'}${info.type ? ' type=' + info.type : ''}）——用 read_page/find 找到文件输入框，或给 selector`);
    const list = info.multiple ? files : files.slice(0, 1);
    await this.send('DOM.setFileInputFiles', { files: list, objectId });
    const after = await this.send('Runtime.callFunctionOn', {
      objectId, returnByValue: true,
      functionDeclaration: 'function(){ return [...(this.files || [])].map((f) => f.name); }',
    });
    const label = info.id ? `#${info.id}` : (info.name ? `input[name=${info.name}]` : 'input[type=file]');
    return { names: after?.result?.value || [], target: label + chosenNote, multiple: !!info.multiple, dropped: !info.multiple && files.length > 1 };
  }

  close() {
    this.dead = true;
    clearTimeout(this.tabRefreshTimer);
    if (this.external) {
      // 只关本会话拥有的 target，绝不能杀 Electron（那里面还有 bridge UI 与其他工作空间）/ 共享宿主（同一个人别的工作空间）。
      const targets = [...this.ownedTargets];
      this.ownedTargets.clear();
      const closing = targets.map((targetId) => this.closeOwnedTarget(targetId).catch(() => {}));
      const host = this.sharedHost;
      this.sharedHost = null;
      this.closed = Promise.allSettled(closing).then(() => {
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

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
