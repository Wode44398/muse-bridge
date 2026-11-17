// 浏览器驱动共用的常量与小工具：截图上限、浏览器查找、视口预设与解析、UA 与仿真元数据、无头启动参数、delay。
import { existsSync } from 'node:fs';

export const MAX_CONSOLE = 400;
// 截图长边上限：与官方 computer use 的 maxTargetPx 一致，超过它 Claude Code 会再缩一次图。
export const SHOT_MAX_PX = 1568;
// 不算「还在加载」的长连接类请求（settle 不等它们）。
export const LONG_LIVED = new Set(['EventSource', 'WebSocket', 'Ping', 'Manifest', 'CSPViolationReport']);
// 页内 DOM 变动计数器（MutationObserver，按需装一次，导航后新文档自动重装）+ 地址：
// settle 比较这一串是否连续不变。与 browser-verify 的页内助手共用同一个计数器。
// n = DOM 变动条数，s = 滚动事件次数（含内层滚动容器，捕获阶段收）。
export const MUT_INIT = `if(!window.__bridgeMut){const m=window.__bridgeMut={n:0,s:0};try{new MutationObserver((l)=>{m.n+=l.length}).observe(document,{subtree:true,childList:true,attributes:true,characterData:true});addEventListener('scroll',(e)=>{m.s++;m.t=e.target},{capture:true,passive:true})}catch{}}`;
export const MUTATION_KEY = `(()=>{${MUT_INIT};return location.href+'#'+window.__bridgeMut.n})()`;

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
export const SCHEMES = ['auto', 'light', 'dark'];

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
export const HOST_PLATFORM = process.platform === 'win32' ? ['Win32', 'Windows', '10.0.0']
  : process.platform === 'darwin' ? ['MacIntel', 'macOS', '14.0.0'] : ['Linux x86_64', 'Linux', ''];
export function desktopUaMetadata(baseUa) {
  const major = /Chrome\/(\d+)/.exec(baseUa || '')?.[1] || '128';
  return {
    brands: [{ brand: 'Chromium', version: major }, { brand: 'Google Chrome', version: major }, { brand: 'Not/A)Brand', version: '99' }],
    fullVersion: `${major}.0.0.0`,
    platform: HOST_PLATFORM[1], platformVersion: HOST_PLATFORM[2], architecture: 'x86', model: '', mobile: false,
  };
}
export function mobileUaMetadata(baseUa, phone) {
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


export function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
