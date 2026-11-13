// Claude 分页的浏览器实例池：一个对话一个 CdpSession（2026-11-08 起；以前是一个工作空间一个）。
// agent 的 MCP browser 工具与右侧栏浏览器面板共用同一实例——agent 浏览时面板实时同屏。
// 键 =（属主, 规范化工作空间路径, 会话 id）：同一工作空间里几个对话同时开发，各自的标签、前台标签、视口互不干扰。
// 没带会话 id 的老调用方（Codex 的浏览器通道、快照、还没发出第一条消息的新对话）仍按（属主, 工作空间）共用一份。
// 底层进程是共用的：桌面壳 / 同一个人的共享无头宿主里，每个会话只拥有自己建的标签，所以网站登录态大家共享、
// 不多占浏览器进程。要连 cookie / 存储也分开（两个对话用不同账号测同一个站），给这个会话开【隔离存储】：
// 换到共享无头宿主里的一个独立浏览上下文（Target.createBrowserContext，类似无痕窗口，关掉即清空）。
// 各函数的 ws 参数可以是路径，也可以是 principal.poolRef(ctx, 路径)：主机身份与只给路径的老调用方
// （Codex 的浏览器通道）仍只按路径，键与以前逐字一致；其他身份带属主前缀——将来两个人进了同一个
// 共享目录，也拿不到对方的那一份（开源路线 C6）。
// 登录态隔离：桌面壳在线时，主机身份的浏览器开在壳里（持久分区 persist:agent-browser，主机自己的网站登录态）；
// 其他属主（成员、快照访客、管理员代聊时被代的人）一律起无头浏览器，碰不到壳里的 cookie。
// 无头时的配置档（2026-10-26 起）：主机身份与成员账号用【自己的持久配置档】——同一个人所有工作空间共用一个
// 无头宿主进程（headless-host.mjs），登录一次、跨会话跨重启都在（对齐 Claude 桌面端内置浏览器）；配置档放在
// 主机 = 数据根/browser-profile、成员 = 他自己目录/.bridge/browser-profile（删号随目录一起删）。快照访客、
// 分享链接这类临时身份仍是一次性的临时 profile。BRIDGE_BROWSER_PERSIST=0 全部退回临时 profile。
// 懒启动、并发去重、LRU 上限、无人观看且无工具活动 15 分钟后回收；账号删除 / 停用时 closeBrowsersOf 按属主收。

import path from 'node:path';
import { CdpSession, VIEWPORT_PRESETS, resolveViewportSpec, presetKeyFor } from './cdp.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { poolKey, refOwner, refSession, parseOwnerKey, HOST_OWNER } from './principal.mjs';
import { busPublish } from './bus.mjs';
import { DATA_ROOT } from './paths.mjs';
import { userRoot } from '../config/index.mjs';
import { killAllHostsSync, hostsUnderClosed } from './headless-host.mjs';

// 这个属主的持久配置档目录；'' = 用临时 profile。
export function profileDirFor(owner) {
  if (process.env.BRIDGE_BROWSER_PERSIST === '0') return '';
  if (!owner || owner === HOST_OWNER) return path.join(DATA_ROOT, 'browser-profile');
  const p = parseOwnerKey(owner);
  if (p?.kind === 'user' && p.id && !/[\\/]/.test(p.id) && !p.id.startsWith('.')) return path.join(userRoot(p.id), '.bridge', 'browser-profile');
  return '';
}

export { VIEWPORT_PRESETS, resolveViewportSpec, presetKeyFor };

// resize / 查询视口的人话（Claude 的 SDK MCP 与 Codex 的 loopback 两条通道共用）：
// 期望值 vs 页面实测，对不上时说清楚是谁的问题——agent 拿到的是能直接信的结论，
// 不用再自己 eval innerWidth 猜。
const PRESET_LABEL = { mobile: '手机', tablet: '平板', desktop: '桌面' };
export function describeViewport(r) {
  const vp = r?.viewport || {};
  const emu = r?.emu || {};
  const m = r?.measured;
  const flags = [
    emu.mobile ? '触屏 + 移动端 UA' : '鼠标 + 桌面 UA',
    emu.scheme === 'auto' || !emu.scheme ? '配色跟随系统' : `强制${emu.scheme === 'dark' ? '深色' : '浅色'}`,
    r?.dprAuto ? `DPR 跟随显示器${r.dprWant ? `（${r.dprWant}）` : ''}` : emu.dpr && emu.dpr !== 1 ? `DPR ${emu.dpr}` : '',
  ].filter(Boolean);
  const lines = [`视口 ${vp.width}×${vp.height}（${PRESET_LABEL[r?.preset] || '自定义'}档 · ${vp.width > vp.height ? '横屏' : '竖屏'} · ${flags.join(' · ')}）`];
  if (m) {
    lines.push(`页面实测 innerWidth×innerHeight = ${m.w}×${m.h} · devicePixelRatio ${m.dpr} · maxTouchPoints ${m.touch} · pointer:coarse ${m.coarse ? '是' : '否'} · prefers-color-scheme ${m.dark ? 'dark' : 'light'}`);
    // 一像素也算：断点正好卡在 375 / 1280 这种值时，差 1px 媒体查询就判反了
    const off = m.w !== vp.width || m.h !== vp.height;
    const small = Math.abs(m.w - vp.width) <= 2 && Math.abs(m.h - vp.height) <= 2;
    if (r?.dprWant > 0 && m.dpr > 0 && Math.abs(m.dpr - r.dprWant) > 0.02) lines.push(`⚠ DPR 没有落到期望值：期望 ${r.dprWant}，页面实测 ${m.dpr}`);
    if (!off) lines.push('✓ 视口已真实生效，可以按这个尺寸验证响应式布局（媒体查询 / 断点 / 横向溢出）。');
    else if (r?.applied && !r.applied.ok) lines.push(`⚠ 视口没有真正落到页面上：${r.applied.error || '未知原因'}`);
    else if (small && r?.applied?.via === 'shell' && !r.applied.metrics) lines.push(`⚠ 差 ${vp.width - m.w}×${vp.height - m.h} px：这版桌面壳靠页面缩放把视口塞进面板，取整会差 1~2px（更新桌面客户端后精确）。测正好卡在这个宽度上的断点时别信这次结果。`);
    else if (emu.mobile && !m.meta) lines.push('⚠ 实测 ≠ 期望：页面没有 <meta name="viewport">，触屏档按真机规则以 980px 排版再整体缩小——这是页面自己的问题，不是 resize 没生效。给页面加上 viewport meta 再测。');
    else lines.push(`⚠ 实测 ≠ 期望（差 ${vp.width - m.w}×${vp.height - m.h}）：页面可能还在重排，或被固定尺寸元素/滚动条撑开；再 screenshot 或 eval innerWidth 确认一次。`);
  } else if (r?.applied && !r.applied.ok) {
    lines.push(`⚠ 视口没有真正落到页面上：${r.applied.error || '未知原因'}`);
  }
  return lines.join('\n');
}

// 用户此刻看不看得到这个浏览器（给 agent 的人话）。visible：true = 确认有人看着；false = 确认没人看得到；
// null = 只知道面板开着、看不出在不在前台（手机 / 网页端的帧流面板）。
export async function viewerReport(b) {
  const list = [...(b?.viewers?.values?.() || [])];
  const native = list.filter((v) => v.kind === 'native').length;
  const guests = list.filter((v) => v.kind === 'guest').length;
  const streams = {};
  for (const v of list) if (v.kind === 'stream') streams[v.where || '网页端'] = (streams[v.where || '网页端'] || 0) + 1;
  const shell = b?.desktopBroker ? await b.shellViewState().catch(() => null) : null;
  const seen = [];
  const unseen = [];
  if (shell?.windowShown && (shell.mounted || shell.parent === 'device')) {
    seen.push(shell.parent === 'device' ? '「这台电脑上的浏览器」窗口正显示着这个页面' : `桌面客户端的浏览器面板正显示着这个页面${shell.focused ? '' : '（窗口不在前台）'}`);
  } else if (native) {
    unseen.push(shell ? '桌面客户端开着浏览器卡片，但这个页面此刻不在屏幕上（切到了别的分页、窗口最小化，或面板显示的是别的标签）' : '桌面客户端开着浏览器面板（这版桌面客户端报不出它在不在屏幕上）');
  }
  const maybe = Object.entries(streams).map(([where, n]) => `${where}开着浏览器面板${n > 1 ? ` ${n} 处` : ''}`);
  if (guests) seen.push(`快照访客 ${guests} 人在看直播`);
  let visible;
  let text;
  if (seen.length) {
    visible = true;
    text = `用户看得到：${[...seen, ...maybe].join('；')}。`;
  } else if (maybe.length) {
    visible = null;
    text = `${[...maybe, ...unseen].join('；')}（看不出是否在前台）。要用户动手前，先在回复里说清楚请他看浏览器面板。`;
  } else {
    visible = false;
    text = `${unseen.length ? unseen[0] + '——' : ''}用户现在看不到这个浏览器，也不知道你在做什么。要他动手（登录、过验证、确认）前，先请他把浏览器打开：桌面端按 Ctrl+Shift+B 或点工作台的浏览器卡片，手机上点顶栏的眼睛键；做完的事在回复里说清楚。`;
  }
  return { visible, text, viewers: list.length };
}

// screenshot 附带的一行：期望视口 + 实测，让模型知道图片的坐标系到底是多少像素宽。
export function viewportLine(b) {
  const vp = b.viewport;
  const m = b.measured;
  const real = m && (m.w !== vp.width || m.h !== vp.height) ? ` · 实测 ${m.w}×${m.h}` : '';
  return `viewport ${vp.width}×${vp.height}${real}${b.emu?.mobile ? ' · 触屏' : ''}${b.emu?.scheme && b.emu.scheme !== 'auto' ? ` · ${b.emu.scheme}` : ''}`;
}

// 按会话开以后实例多了，但同一个人的实例大多只是共享宿主 / 桌面壳里的几个标签，不是独立进程。
const MAX_BROWSERS = 8;
const IDLE_MS = 15 * 60 * 1000;

const fold = (p) => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const keyOf = (ws) => poolKey(ws, fold);
export const _browserKey = keyOf;   // 单测用：不起真浏览器验池键
// 池项的属主：主机身份与只给路径的老调用方都记成 'admin'，其余是 owner 键原样。
const ownerOfRef = (ref) => { const o = refOwner(ref); return o && o !== HOST_OWNER ? o : HOST_OWNER; };
// 能不能开进桌面壳（壳里是主机自己的网站登录态）：只有主机身份。
export const _desktopAllowed = (ref) => ownerOfRef(ref) === HOST_OWNER;   // 单测用

const pool = new Map(); // key -> { owner, sid, session: CdpSession, launching: Promise|null, lastUsed: number, mounted, closed? }

function slot(ws) {
  const key = keyOf(ws);
  let s = pool.get(key);
  if (!s) { s = { owner: ownerOfRef(ws), sid: refSession(ws), session: null, launching: null, lastUsed: Date.now(), mounted: false }; pool.set(key, s); }
  return s;
}

// —— 挂载状态灯：这个会话的浏览器里有没有标签 ——
// 前端工具开关上的绿灯只在【这个会话】有标签时亮。标签增减、浏览器关掉（含闲置回收、关掉最后一个标签）都会
// 走 CdpSession.notifyTabs，这里去重后经账号总线推 {type:'browser.mount', sessionId, mounted, tabs}。
function noteMount(s, n) {
  const on = n > 0;
  if (s.mounted === on) return;
  s.mounted = on;
  if (s.sid) busPublish(s.owner || HOST_OWNER, { type: 'browser.mount', sessionId: s.sid, mounted: on, tabs: n });
}

// —— 隔离存储开关（按会话，跨重启记着）——
const ISO_FILE = path.join(DATA_ROOT, 'browser-isolated.json');
const ISO_MAX = 300;
let isoKeys = null;
function isoSet() {
  if (isoKeys) return isoKeys;
  try { isoKeys = new Set(JSON.parse(readFileSync(ISO_FILE, 'utf8')).filter((k) => typeof k === 'string')); } catch { isoKeys = new Set(); }
  return isoKeys;
}
function isoSave() {
  const all = [...isoSet()];
  if (all.length > ISO_MAX) isoKeys = new Set(all.slice(-ISO_MAX));
  try { writeFileSync(ISO_FILE, JSON.stringify([...isoKeys])); } catch (e) { console.warn('[browser] 隔离开关没存上：', e?.message || e); }
}
// 只有带会话的引用能开隔离（工作空间共用的那份开了，等于替同空间的别的对话做主）。
export function browserIsolated(ws) {
  return Boolean(refSession(ws)) && isoSet().has(keyOf(ws));
}
// 开 / 关隔离存储。模式变了就关掉这个会话现有的浏览器（标签随之关闭），下次打开按新模式起。返回 { isolated, restarted }。
export function setBrowserIsolated(ws, on) {
  if (!refSession(ws)) throw Object.assign(new Error('还没有对话，先发一条消息再开隔离存储'), { status: 400 });
  const key = keyOf(ws);
  const set = isoSet();
  const want = Boolean(on);
  if (set.has(key) === want) return { isolated: want, restarted: false };
  if (want) set.add(key); else set.delete(key);
  isoSave();
  const s = pool.get(key);
  const restarted = Boolean(s?.session);
  if (s?.session) { s.session.close(); s.session = null; }
  return { isolated: want, restarted };
}

// 这个引用的挂载状态（不触发启动）：前端切会话时拉一次，之后靠 browser.mount 总线事件。
export function browserMount(ws) {
  const b = existingBrowser(ws);
  return { mounted: Boolean(b && b.tabs.length), tabs: b ? b.tabs.length : 0, isolated: browserIsolated(ws) };
}

export function touchBrowser(ws) {
  const s = pool.get(keyOf(ws));
  if (s) s.lastUsed = Date.now();
}

// 已存在且存活的实例（不触发启动）。
export function existingBrowser(ws) {
  const s = pool.get(keyOf(ws));
  return s?.session?.alive ? s.session : null;
}

// 取或启动该工作空间的浏览器。并发调用共享同一次启动。
export async function getBrowser(ws) {
  const s = slot(ws);
  s.lastUsed = Date.now();
  if (s.session?.alive) return s.session;
  if (s.launching) return s.launching;
  s.session?.close();
  s.session = null;
  // 池满时踢出最久未用的其他实例（无人看直播的优先，本就该睡了）。
  const live = [...pool.entries()].filter(([, x]) => x.session?.alive);
  if (live.length >= MAX_BROWSERS) {
    live.sort((a, b) => a[1].lastUsed - b[1].lastUsed);
    const victim = live.find(([k]) => k !== keyOf(ws)) || live[0];
    victim[1].session.close();
    victim[1].session = null;
  }
  s.launching = (async () => {
    const sess = new CdpSession();
    // 隔离存储：不进桌面壳（壳里是主机的持久分区），在共享无头宿主里开独立浏览上下文；没有持久配置档的身份本来就是独立进程
    const isolate = browserIsolated(ws);
    await sess.launch('about:blank', { desktop: s.owner === HOST_OWNER && !isolate, profileDir: profileDirFor(s.owner), isolate });
    // 启动途中这个槽被 closeBrowsersOf 收了（账号删除 / 停用）：刚起来的进程不能留成没人管的孤儿
    if (s.closed) { sess.close(); throw Object.assign(new Error('浏览器已关闭'), { status: 410 }); }
    // 换了新实例后，旧实例晚到的「标签清空」不该把灯熄掉
    sess.subscribeTabs((tabs) => { if (!s.session || s.session === sess) noteMount(s, tabs.length); });
    s.session = sess;
    s.launching = null;
    return sess;
  })();
  try {
    return await s.launching;
  } catch (e) {
    s.launching = null;
    throw e;
  }
}

export function closeBrowser(ws) {
  const s = pool.get(keyOf(ws));
  if (s?.session) { s.session.close(); s.session = null; }
}

// 按属主收掉他名下的全部浏览器（账号删除 / 停用时调，runtime/account-lifecycle.mjs 按这个名字取）。
// owner = owner 键（'u:<账号 id>' 等）；主机的浏览器只有显式传 'admin' 才收。返回收掉几个池项。
export function closeBrowsersOf(owner) {
  const o = String(owner || '');
  if (!o) return 0;
  let n = 0;
  for (const [key, s] of [...pool]) {
    if (s.owner !== o) continue;
    s.closed = true;
    try { s.session?.close(); } catch { /* best effort */ }
    s.session = null;
    pool.delete(key);
    n++;
  }
  return n;
}

export function closeAllBrowsers() {
  for (const s of pool.values()) { s.session?.close(); s.session = null; }
  pool.clear();
}

// 删号前等这个人的共享无头宿主真正退出（Windows 上进程还开着配置档文件，目录删不掉）。account-lifecycle 在
// closeBrowsersOf 之后调；最多等 8 秒。
export async function browserProfilesReleased(owner) {
  const dir = profileDirFor(String(owner || ''));
  if (!dir || owner === HOST_OWNER) return;
  await hostsUnderClosed(dir);
}

// 地址栏输入的宽松 URL 归一：裸主机补协议（localhost/内网走 http，其余 https）。
export function normalizeUrl(raw) {
  const u = String(raw || '').trim();
  if (!u) return '';
  if (/^(https?|about|data|file):/i.test(u)) return u;
  const host = u.split('/')[0].split(':')[0];
  const isLocal = host === 'localhost' || /^127\./.test(host) || /^192\.168\./.test(host) || /^10\./.test(host) || host === '[::1]';
  return (isLocal ? 'http://' : 'https://') + u;
}

// 闲置回收收掉的（池键 → 时刻）：agent 隔了一阵再来，只看到「浏览器还没启动」会以为自己的页面莫名丢了——
// 结果里说清楚是闲置被收（runtime/browser-actions.mjs 用 reapedNote）。只留最近 50 条。
const reaped = new Map();

/** 这个工作空间的浏览器是不是被闲置回收关掉的：是就返回给 agent 的一句话，否则 ''。 */
export function reapedNote(ws) {
  const r = reaped.get(keyOf(ws));
  if (!r || Date.now() - r.t > 24 * 3600e3) return '';
  const at = new Date(r.t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return `（它在 ${at} 因为闲置超过 ${Math.round(IDLE_MS / 60_000)} 分钟、没人看，被自动关掉了——之前的页面和标签都没了，navigate 重新打开${r.persist ? '；网站登录状态还在' : ''}）`;
}

// 闲置回收：无直播观众且 IDLE_MS 内没有任何工具/面板活动 → 关进程省内存。
const reaper = setInterval(() => {
  const now = Date.now();
  for (const [key, s] of pool) {
    if (!s.session) { if (!s.launching) pool.delete(key); continue; }
    if (!s.session.alive) { s.session.close(); s.session = null; continue; }
    if (s.session.castSubs.size === 0 && now - s.lastUsed > IDLE_MS) {
      // 登录态留不留得住：桌面壳的持久分区、或真附着上了持久配置档的共享无头宿主（起不来时会退回临时 profile）
      const persist = Boolean(s.session.desktopBroker || s.session.sharedHost);
      s.session.close();
      s.session = null;
      reaped.set(key, { t: now, persist });
      if (reaped.size > 50) reaped.delete(reaped.keys().next().value);
    }
  }
}, 60_000);
reaper.unref?.();

// 进程退出时不留孤儿 headless 浏览器。
for (const sig of ['exit', 'SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try { closeAllBrowsers(); } catch { /* best effort */ }
    // 共享宿主的优雅退出是异步的，exit 里等不到：直接杀，最近几十秒的 Cookie 可能没落盘（下次登录一下即可）
    if (sig === 'exit') killAllHostsSync();
  });
}
