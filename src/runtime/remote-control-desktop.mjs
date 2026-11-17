// 反向控制·二期：真·桌面控制（截真屏 + 真鼠标键盘），跑在被控客户端里；本机 Agent（localPc）也走这一份。
//
// 一期是工作区级（shell/文件/无头浏览器）；二期让远程 agent 看真实屏幕、点真实界面、
// 敲真实键盘——能操作任何桌面应用，不再局限于工作区。这是比一期大一个量级的暴露面
// （截屏=看到整个屏幕含其它应用/通知/别处输入的内容），所以另有一道**独立开关**
// BRIDGE_ALLOW_DESKTOP_CONTROL（客户端 control.allowDesktop，默认关；且需先开 allowRemote）。
//
// 实现：零原生依赖，用 Windows 自带 PowerShell + .NET——CopyFromScreen/PrintWindow 截屏、
// SendInput 鼠标键盘、UI Automation 读控件。起一个**常驻 PS 宿主**：Add-Type 只编译一次，
// 之后按行 JSON 协议收发命令，摊薄冷启动开销。截图写临时文件回传路径（避免大块 base64 挤爆
// stdout 行协议），node 侧现读现删再转 base64。
//
// 坐标体系（2026-10-20 照官方 Claude Desktop computer use 重做）：
//   · 截图在宿主里就缩到模型的图片预算内（官方同参：28px/token、最长边 ≤1568、≤1568 token），
//     模型看到的图＝坐标帧，客户端不会再二次缩放；
//   · 每张截图记一个「帧」（物理区域 + 图片尺寸 + 是否某个窗口），之后的点击/移动/滚动收的是
//     「这张图里读到的像素」，这里换算回屏幕；超出帧直接报错、没截过图也报错——不再静默点歪；
//   · 帧是某个窗口时按窗口**当前**位置换算（窗口挪了照样点准），尺寸变了就要求重新截图；
//   · 点之前做命中测试：落点属于哪个窗口/控件随结果回报；落在急停横幅上、或窗口截图的目标被
//     别的程序挡住时拒绝点击并说明。

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PS_SCRIPT } from './remote-control-desktop/host-script.mjs';

// 图片预算：与官方 Windows executor 相同（index.chunk-BKirSAUO 的 qz）。
export const IMAGE_BUDGET = Object.freeze({ pxPerToken: 28, maxTargetPx: 1568, maxTargetTokens: 1568 });

let host = null;       // { child, ready, pending:Map, seq, buf }
// 事件观察者：桌面壳（本机 broker）注册后，宿主在动作进行中实时推 move/click/scroll/type/key/target/shot，
// 用来画覆盖层上的 Claude 指针与动效；没注册（远程客户端）就不发、也不做平滑移动。坐标都是物理像素。
let observer = null;
export function setDesktopObserver(fn) { observer = typeof fn === 'function' ? fn : null; }
let starting = null;   // 正在起宿主的 promise
let generation = 0;    // 急停/关宿主时 +1：正在跑的 batch 看到变化就停，不会把宿主又拉起来接着点
const HOST_SCRIPT = path.join(os.tmpdir(), `bridge-desktop-host-${process.pid}.ps1`);

function ensureScript() {
  // 带 BOM：脚本里有中文注释，Windows PowerShell 5.1 读无 BOM 文件按 ANSI 码页解，会把引号吃乱导致整篇解析失败
  writeFileSync(HOST_SCRIPT, '﻿' + PS_SCRIPT, 'utf8');
  return HOST_SCRIPT;
}

function startHost() {
  if (host && host.child && !host.child.killed) return Promise.resolve(host);
  if (starting) return starting;
  const p = new Promise((resolve, reject) => {
    let child;
    try { child = spawn('powershell.exe', ['-NoProfile', '-NoLogo', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ensureScript()], { windowsHide: true }); }
    catch (e) { reject(new Error('无法启动 PowerShell 桌面宿主：' + e.message)); return; }
    const h = { child, ready: false, pending: new Map(), seq: 0, buf: '' };
    let settled = false;
    let startupTimer = null;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      h.buf += chunk;
      let i;
      while ((i = h.buf.indexOf('\n')) >= 0) {
        const line = h.buf.slice(0, i).trim(); h.buf = h.buf.slice(i + 1);
        if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.evt) { try { observer?.(msg); } catch {} continue; }
        if (msg.ready) {
          h.ready = true;
          host = h;
          if (!settled) {
            settled = true;
            clearTimeout(startupTimer);
            resolve(h);
          }
          continue;
        }
        const pend = h.pending.get(msg.id);
        if (pend) { h.pending.delete(msg.id); pend.settle(msg); }
      }
    });
    child.stderr.on('data', (b) => { const s = b.toString().trim(); if (s) console.error('[remote-desktop] ' + s); });
    // spawn 失败是【异步 'error' 事件】——上面那个同步 try/catch 只挡得住参数非法，
    // 挡不住 ENOENT（PATH 里没有 powershell.exe）/ EACCES。没有监听者时未处理的
    // 'error' 会把整个 bridge 进程打死，而不是让这次调用失败。
    child.on('error', (e) => {
      clearTimeout(startupTimer);
      for (const [, pend] of h.pending) pend.fail(e);
      h.pending.clear();
      if (host === h) host = null;
      if (!settled) { settled = true; reject(new Error('无法启动 PowerShell 桌面宿主：' + (e?.message || e))); }
    });
    child.on('exit', (code) => {
      clearTimeout(startupTimer);
      for (const [, pend] of h.pending) pend.fail(new Error('桌面控制宿主已退出（' + code + '）'));
      h.pending.clear();
      if (host === h) host = null;
      if (!settled) { settled = true; reject(new Error('桌面控制宿主启动失败（退出码 ' + code + '）；确认在交互式桌面会话中运行。')); }
    });
    startupTimer = setTimeout(() => { if (!settled) { settled = true; try { child.kill(); } catch {} reject(new Error('桌面控制宿主启动超时')); } }, 30_000);
  });
  starting = p;
  // finally 派生的新 promise 也会带着启动失败的原因 reject，没人接就是 unhandled rejection（会打死宿主进程）
  p.finally(() => { if (starting === p) starting = null; }).catch(() => {});
  return p;
}

// raw=true：宿主回 ok:false 时不抛，原样交回（命中测试的拒绝要带上落点信息）
function sendCmd(op, args, timeoutMs = 20_000, { raw = false } = {}) {
  return startHost().then((h) => new Promise((resolve, reject) => {
    const id = ++h.seq;
    const timer = setTimeout(() => { h.pending.delete(id); reject(new Error('桌面操作超时（' + op + '）')); }, timeoutMs);
    h.pending.set(id, {
      settle: (msg) => {
        clearTimeout(timer);
        if (msg.ok === false && !raw) reject(new Error(msg.error || `桌面操作「${op}」失败（宿主没给原因）`));
        else resolve(msg);
      },
      fail: (e) => { clearTimeout(timer); reject(e); },
    });
    // 动效事件开关叫 emitEvents，别叫 fx——fx/fy 是指针指令里的帧内坐标，重名会把横坐标盖成 0
    try { h.child.stdin.write(JSON.stringify({ id, op, ...args, emitEvents: Boolean(observer) }) + '\n', 'utf8'); }
    catch (e) { clearTimeout(timer); h.pending.delete(id); reject(e); }
  }));
}

// —— 键名 → 虚拟键码（SendInput）——
const MOD_VK = { ctrl: 0x11, control: 0x11, alt: 0x12, shift: 0x10, win: 0x5B, meta: 0x5B, cmd: 0x5B, super: 0x5B };
const KEY_VK = {
  enter: 0x0D, return: 0x0D, tab: 0x09, esc: 0x1B, escape: 0x1B,
  backspace: 0x08, bs: 0x08, del: 0x2E, delete: 0x2E, ins: 0x2D, insert: 0x2D,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  home: 0x24, end: 0x23, pageup: 0x21, pgup: 0x21, pagedown: 0x22, pgdn: 0x22,
  space: 0x20, capslock: 0x14, printscreen: 0x2C, prtsc: 0x2C, menu: 0x5D, apps: 0x5D, pause: 0x13,
  numlock: 0x90, scrolllock: 0x91,
  volumeup: 0xAF, volumedown: 0xAE, volumemute: 0xAD,
  plus: '+',
};
// 覆盖层上显示的键帽文字：「ctrl+shift+s」→ ['Ctrl', 'Shift', 'S']
const KEY_NAMES = { ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', shift: 'Shift', win: 'Win', meta: 'Win', cmd: 'Win', super: 'Win',
  enter: 'Enter', return: 'Enter', esc: 'Esc', escape: 'Esc', tab: 'Tab', backspace: 'Backspace', bs: 'Backspace', del: 'Delete', delete: 'Delete',
  up: '↑', down: '↓', left: '←', right: '→', pageup: 'PgUp', pgup: 'PgUp', pagedown: 'PgDn', pgdn: 'PgDn', space: 'Space', home: 'Home', end: 'End' };
export function keyLabels(spec) {
  const parts = String(spec == null ? '' : spec).split('+').map((x) => x.trim());
  if (parts.length >= 2 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') parts.splice(-2, 2, '+');
  return parts.filter(Boolean).map((x) => KEY_NAMES[x.toLowerCase()] || (x.length === 1 ? x.toUpperCase() : x[0].toUpperCase() + x.slice(1)));
}

// "Ctrl+Shift+C" / "Enter" / "Alt+F4" / "Win+R" / "Ctrl+Plus" → { mods:[vk], key?:vk, char?:'c' }
export function parseKeys(spec) {
  const parts = String(spec == null ? '' : spec).split('+').map((s) => s.trim());
  // "Ctrl++" 拆出来末尾是两个空串：还原成主键 '+'
  if (parts.length >= 2 && parts[parts.length - 1] === '' && parts[parts.length - 2] === '') { parts.splice(-2, 2, '+'); }
  const mods = []; let key = null; let char = null;
  for (const p of parts.filter(Boolean)) {
    const low = p.toLowerCase();
    if (MOD_VK[low] != null && (key != null || char != null || parts.length > 1)) { if (!mods.includes(MOD_VK[low])) mods.push(MOD_VK[low]); continue; }
    if (key != null || char != null) throw new Error(`组合键「${spec}」里有两个主键`);
    if (MOD_VK[low] != null) { key = MOD_VK[low]; continue; }   // 单按一个修饰键（如「Win」开开始菜单）
    const mapped = KEY_VK[low];
    if (typeof mapped === 'number') key = mapped;
    else if (typeof mapped === 'string') char = mapped;
    else if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(p)) key = 0x70 + Number(p.slice(1)) - 1;
    // 字母/数字直接给键码：大写的「S」不能走 VkKeyScan，否则 Ctrl+S 会被补成 Ctrl+Shift+S
    else if (/^[a-z0-9]$/i.test(p)) key = p.toUpperCase().charCodeAt(0);
    else if (p.length === 1) char = p;   // 符号按当前键盘布局查键位（需要 Shift 的自动补上）
    else throw new Error(`不认识的按键「${p}」（可用：Ctrl/Alt/Shift/Win + 字母数字符号、Enter、Tab、Esc、方向键、Home/End、PageUp/PageDown、F1–F24 等）`);
  }
  if (key == null && char == null) throw new Error('key 需要一个主键，例如 "Ctrl+S"、"Enter"');
  return { mods, key, char };
}

// —— 坐标帧 ——
// 每个调用方（frameKey：claude / dimensio / codex / 远程设备…）各记各的最近一张截图，互不覆盖。
const frames = new Map();
export function makeFrame(shot, { window = null } = {}) {
  return { ox: shot.ox, oy: shot.oy, pw: shot.w, ph: shot.h, fw: shot.fw, fh: shot.fh, window: window || null, at: Date.now() };
}
// 截图像素 → 帧内物理偏移（与官方相同：越界报错、结果夹在帧内）
export function toPhysical(frame, x, y, label = '坐标') {
  if (!frame) throw new Error('还没有截图可对照——先 screenshot，再按那张图里读到的像素点。');
  const nx = Number(x), ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new Error(`${label}需要 x 和 y（截图里的像素）`);
  if (nx < 0 || ny < 0 || nx > frame.fw || ny > frame.fh) {
    throw new Error(`${label} [${nx}, ${ny}] 超出了最近一张截图的范围（${frame.fw}×${frame.fh}）——坐标是那张图里的像素。重新截图后再选点。`);
  }
  const fx = Math.min(Math.max(Math.round(nx * frame.pw / frame.fw), 0), Math.max(frame.pw - 1, 0));
  const fy = Math.min(Math.max(Math.round(ny * frame.ph / frame.fh), 0), Math.max(frame.ph - 1, 0));
  return { fx, fy };
}
// 屏幕绝对坐标 → 截图像素（光标位置、落点回报用；不在帧内回 null）
export function toFramePixels(frame, absX, absY) {
  if (!frame || frame.window) return null;   // 窗口帧的原点会随窗口移动，绝对坐标没法稳定换算
  const x = Math.round((absX - frame.ox) * frame.fw / frame.pw);
  const y = Math.round((absY - frame.oy) * frame.fh / frame.ph);
  return x >= 0 && y >= 0 && x <= frame.fw && y <= frame.fh ? { x, y } : null;
}

const frameKeyOf = (args) => String(args?.frameKey || 'default').slice(0, 60);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const brief = (w) => (w ? { hwnd: w.hwnd, title: w.title, process: w.process } : null);
const describe = (t) => {
  const w = t?.window, c = t?.control;
  const where = w ? `「${w.title || w.className || '无标题窗口'}」(${w.process || '?'})` : '桌面';
  const what = c && (c.name || c.type) ? `的 ${c.type || '控件'}${c.name ? `「${String(c.name).slice(0, 60)}」` : ''}` : '';
  return where + what;
};

async function readShot(r) {
  try { return (await readFile(r.file)).toString('base64'); } finally { unlink(r.file).catch(() => {}); }
}

async function doScreenshot(args, key) {
  const display = typeof args.display === 'number' ? args.display : undefined;
  const window = args.window == null ? undefined : Number(args.window);
  const r = await sendCmd('shot', { display, window, grid: !!args.grid, ...budgetArgs() }, 25_000);
  const image = await readShot(r);
  const frame = makeFrame(r, { window: window || null });
  frame.display = display;
  frames.set(key, frame);
  return { image, mimeType: 'image/jpeg', w: r.w, h: r.h, ox: r.ox, oy: r.oy, fw: r.fw, fh: r.fh, window: window || null };
}
const budgetArgs = () => ({ maxPx: IMAGE_BUDGET.maxTargetPx, maxTok: IMAGE_BUDGET.maxTargetTokens });

async function doZoom(args, frame) {
  if (!frame) throw new Error('还没有截图——zoom 的区域按最近一张截图的像素给，先 screenshot。');
  const reg = Array.isArray(args.region) ? args.region.map(Number) : null;
  if (!reg || reg.length !== 4 || reg.some((v) => !Number.isFinite(v))) throw new Error('zoom 需要 region: [x0, y0, x1, y1]（最近一张截图里的像素）');
  const [x0, y0, x1, y1] = reg;
  if (x1 <= x0 || y1 <= y0) throw new Error('zoom 的 region 要求 x1>x0、y1>y0');
  const a = toPhysical(frame, x0, y0, 'region 左上角'), b = toPhysical(frame, x1, y1, 'region 右下角');
  const r = await sendCmd('zoom', {
    display: frame.display, window: frame.window, ox: frame.ox, oy: frame.oy,
    rx: a.fx, ry: a.fy, rw: Math.max(1, b.fx - a.fx), rh: Math.max(1, b.fy - a.fy), ...budgetArgs(),
  }, 25_000);
  return { image: await readShot(r), mimeType: 'image/jpeg', fw: r.fw, fh: r.fh, region: [x0, y0, x1, y1] };
}

const POINTER = { move: ['move', 1], click: ['click', 1], double_click: ['click', 2], triple_click: ['click', 3], right_click: ['click', 1], scroll: ['scroll', 1] };

// —— 结果确认（动作后自动比对 + 可选预期）——
// 默认开：点击/滚动/输入/按键/uia_action/launch 做完都附一份「发生了什么」。verify:false 关掉（追求速度时）。
const VERIFIED = new Set(['click', 'double_click', 'triple_click', 'right_click', 'scroll', 'type', 'key', 'uia_action', 'launch']);
// 只在带了 expect 时才确认：focus_window 自己就核对到没到前台，平时不必再等界面稳定
const VERIFIED_ON_EXPECT = new Set(['focus_window']);
// 带 window 时先确认前台是那个窗口再发（宿主 Ensure-Target），expect 的 window/gone 也按那个程序认
const TARGETED = new Set(['type', 'key']);
const EXPECT_KEYS = ['window', 'gone', 'focus', 'value', 'text'];
// 返回宿主要的 obs 参数（null＝不确认）以及 node 侧自己核对的 changed 预期
export function obsParams(action, args) {
  const none = { obs: null, wantChanged: undefined };
  if (!(VERIFIED.has(action) || VERIFIED_ON_EXPECT.has(action)) || args.verify === false) return none;
  const e = args.expect && typeof args.expect === 'object' ? args.expect : null;
  const hostExpect = {};
  for (const k of EXPECT_KEYS) if (e && e[k] != null && String(e[k]) !== '') hostExpect[k] = String(e[k]).slice(0, 200);
  const hasHost = Object.keys(hostExpect).length > 0;
  const wantChanged = e && typeof e.changed === 'boolean' ? e.changed : undefined;
  if (VERIFIED_ON_EXPECT.has(action) && !hasHost && wantChanged === undefined) return none;
  // 启动程序慢：窗口常常一两秒后才出来，等得比点击久
  const launch = action === 'launch';
  const expectMs = Math.max(500, Math.min(15_000, Number(args.expect_timeout_ms) || (launch ? 5000 : 3000)));
  const maxMs = hasHost || wantChanged === true ? expectMs : launch ? 5000 : 2500;
  // 一直没变化时等多久才下结论：按键（Ctrl+C 这类本就不改画面）短一点；期望「有变化」就等满预期时长
  const noChangeMs = wantChanged === true ? expectMs : action === 'key' ? 400 : launch ? 2500 : 800;
  const target = TARGETED.has(action) ? targetOf(args) : undefined;
  return { obs: { on: true, maxMs, noChangeMs, ...(hasHost ? { expect: hostExpect } : {}), ...(target ? { target } : {}) }, wantChanged };
}
const targetOf = (args) => (args.window != null && Number(args.window) > 0 ? Number(args.window) : undefined);

// 打字逐字发（宿主 TypeText 字间停 TYPE_DELAY_MS；Sleep(10) 在默认计时器精度下实际约 16ms），长文本要按字数放宽超时
export const TYPE_DELAY_MS = 10;
export function typeTimeoutMs(text) {
  const s = String(text ?? '');
  return Math.max(60_000, s.length * (TYPE_DELAY_MS + 16) * 2 + (s.match(/[\n\t]/g) || []).length * 60 + 20_000);
}

// launch 的参数数组 → 一条 Windows 命令行（CommandLineToArgvW 的规则）：含空白或引号的加引号，
// 引号前的反斜杠加倍再转义引号，结尾的反斜杠在收尾引号前加倍
export function winArg(a) {
  const s = String(a ?? '');
  if (s && !/[\s"]/.test(s)) return s;
  let out = '"', bs = 0;
  for (const ch of s) {
    if (ch === '\\') { bs++; continue; }
    if (ch === '"') { out += '\\'.repeat(bs * 2 + 1) + '"'; bs = 0; continue; }
    out += '\\'.repeat(bs) + ch; bs = 0;
  }
  return out + '\\'.repeat(bs * 2) + '"';
}
export const winArgs = (list) => (Array.isArray(list) ? list : list == null ? [] : [list]).map(winArg).join(' ');

const clip = (s, n = 120) => (s == null ? s : String(s).length > n ? String(s).slice(0, n) + '…' : String(s));
const elBrief = (s) => (s && !s.gone ? { type: s.type, name: clip(s.name, 60), automationId: s.automationId || undefined } : null);
const elId = (s) => (s && !s.gone ? `${s.type}|${s.name}|${s.automationId}` : '');
const STATE_KEYS = ['toggle', 'expand', 'selected', 'enabled', 'value', 'name'];

function stateChanges(before, after) {
  if (!before || before.gone) return { changes: [], gone: false };
  if (!after || after.gone) return { changes: [], gone: true };
  const changes = [];
  for (const k of STATE_KEYS) {
    if (k === 'value' && (before.password || after.password)) continue;
    const a = before[k], b = after[k];
    if (a === undefined && b === undefined) continue;
    if (String(a ?? '') !== String(b ?? '')) changes.push({ key: k, from: clip(a, 60), to: clip(b, 60) });
  }
  return { changes, gone: false };
}

// 宿主读文本控件最多读前 4000 字（TextPattern GetText(4000)）：读满了说明后面还有，看不到的部分不能判对错
const READ_CAP = 4000;
// 比对前抹掉编辑器自己加减的东西：空白（自动缩进、Tab 转空格）、弯引号、大小写（Word 句首自动大写）、行首的列表序号（Word 会把「1. 」变成自动编号）
const squash = (s) => String(s).replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, '').toLowerCase();
const LIST_MARK = /^\s*(?:\d{1,3}[.)、]|[-*•])\s+/;
// 打字后回读：刚打的每一段都要在焦点控件的内容里（不只看最后一行——中间丢字、乱序也要发现）。
// 回车、Tab 都切段：Tab 在表单里会跳到下一个框，前几段留在别的框里。
// kind：ok 都在 / unchanged 同一个控件、内容和打字前一模一样（没打进去）/ committed 带回车且内容被清空（已提交）/
//       mismatch 同一个控件内容变了但对不上，或只对上一部分（丢字、重复、乱序）/
//       elsewhere 焦点换了控件（或打字前读不到）且一段都对不上——字可能打到了别处，判断不了对错
export function readback(typed, after, before) {
  const text = String(typed ?? '');
  if (!text.trim()) return null;
  if (after?.password) return { password: true };
  if (!after || after.gone || after.value == null) return { ok: null };
  const norm = (s) => String(s).replace(/\r\n?/g, '\n');
  const segs = norm(text).split(/[\n\t]/).map((l) => squash(l.replace(LIST_MARK, ''))).filter(Boolean);
  const value = norm(after.value);
  const flat = squash(value);
  const enter = /[\r\n]/.test(text);
  const base = { value: clip(value, 120), enter };
  if (!segs.length) return { ok: null, ...base };
  const hits = segs.map((l) => flat.includes(l));
  if (hits.every(Boolean)) return { ok: true, kind: 'ok', ...base };
  // 单行框里回车把前面几行提交走了、或 Tab 跳到了下一个框：前面的段一段都不在、最后一段完整在
  if (/[\r\n\t]/.test(text) && hits[hits.length - 1] && hits.slice(0, -1).every((h) => !h)) return { ok: true, kind: 'ok', ...base };
  if (String(after.value).length >= READ_CAP) return { ok: null, truncated: true, ...base };
  if (enter && !value.trim()) return { ok: false, kind: 'committed', ...base };
  const sameEl = Boolean(before && !before.gone && before.value != null && elId(before) === elId(after));
  if (sameEl && norm(before.value) === value) return { ok: false, kind: 'unchanged', ...base };
  if (sameEl || hits.some(Boolean)) return { ok: false, kind: 'mismatch', ...base };
  return { ok: false, kind: 'elsewhere', ...base };
}

export function buildVerify(action, obs, { typed, wantChanged } = {}) {
  if (!obs) return null;
  const opened = (obs.opened || []).filter((w) => w && w.title !== BANNER_TITLE);
  const closed = (obs.closed || []).filter((t) => t && t !== BANNER_TITLE);
  const focusChanged = elId(obs.focusBefore) !== elId(obs.focusAfter);
  const control = obs.hasControl ? { ...elBrief(obs.controlBefore), ...stateChanges(obs.controlBefore, obs.controlAfter) } : null;
  // 输入框里的值变化本身就是打字的结果：算「有变化」，但不单列成控件变化（回读里说）
  const valueChanged = action === 'type' && String(obs.focusBefore?.value ?? '') !== String(obs.focusAfter?.value ?? '');
  const changed = Boolean(obs.pixels || opened.length || closed.length || obs.fgChanged || focusChanged || valueChanged
    || control?.gone || control?.changes?.length);
  const v = {
    settledMs: obs.settledMs, stable: obs.stable !== false, changed, pixels: !!obs.pixels,
    opened, closed,
    foreground: obs.fgChanged ? brief(obs.foreground) : null,
    focus: focusChanged ? elBrief(obs.focusAfter) : null,
    control: control && (control.gone || control.changes.length) ? control : null,
  };
  if (action === 'type') v.readback = readback(typed, obs.focusAfter, obs.focusBefore);
  if (obs.expect || wantChanged !== undefined) {
    const checks = [...(obs.expect?.checks || [])];
    if (wantChanged !== undefined) checks.push({ key: 'changed', want: wantChanged, ok: changed === wantChanged, got: changed });
    v.expect = { ok: checks.every((c) => c.ok), checks };
  }
  return v;
}
// 急停横幅的标题（main.cjs 里固定），它第一次出现时不算成「打开了窗口」
export const BANNER_TITLE = 'bridge-local-pc-banner';

async function doPointer(action, args, frame, extra) {
  const [kind, count] = POINTER[action];
  const button = action === 'right_click' ? 'right' : (args.button || 'left');
  let point;
  if (args.ref != null) point = { ref: Number(args.ref) };
  else {
    const { fx, fy } = toPhysical(frame, args.x, args.y);
    point = { fx, fy, ox: frame.ox, oy: frame.oy, win: frame.window, ew: frame.pw, eh: frame.ph };
  }
  const { obs, wantChanged } = obsParams(action, args);
  const r = await sendCmd('pointer', {
    ...point, kind, button, count, amount: Number(args.amount) || 0,
    guard: kind !== 'move', banner: extra.bannerHwnd || 0, bannerRect: extra.bannerRect, obs,
  }, obs ? 40_000 : 20_000, { raw: true });
  if (r.ok === false) {
    if (r.code === 'BANNER') throw new Error('这个落点在屏幕顶部的状态条上（「停止」键就在里面，截图里看不到它），点下去可能直接停掉本机 Agent。把目标窗口往下挪（set_window）或滚动后重新截图，或改用 uia_action / 键盘。');
    if (r.code === 'COVERED') throw new Error(`这个位置现在被${describe(r.target)}挡住了（截图是按窗口单独截的，看不到遮挡）。先 focus_window 把目标窗口提到最前，再点。`);
    const msg = String(r.error || '');
    if (msg.includes('FRAME_RESIZED')) throw new Error('截图之后这个窗口的大小变了，原来的坐标已经对不上——重新截图再选点。');
    if (msg.includes('FRAME_GONE')) throw new Error('截图里的那个窗口已经关掉了——重新 windows / 截图。');
    throw new Error(msg || `${action} 失败`);
  }
  const out = { ok: true, action, target: { window: brief(r.target?.window), control: r.target?.control || null }, landed: describe(r.target) };
  if (args.ref == null) out.at = [Number(args.x), Number(args.y)];
  else out.ref = Number(args.ref);
  const verify = buildVerify(action, r.obs, { wantChanged });
  if (verify) out.verify = verify;
  return out;
}

const BATCH_ACTIONS = new Set([
  'move', 'click', 'double_click', 'triple_click', 'right_click', 'scroll', 'type', 'key', 'wait',
  'screenshot', 'zoom', 'uia_action', 'focus_window', 'cursor', 'active_window',
]);

/**
 * 执行一条桌面 op。被控端唯一入口。
 * 观察：screenshot / zoom / windows / active_window / processes / uia_tree / displays / cursor / wait_for_window
 * 操作：move / click / double_click / triple_click / right_click / scroll / type / key / uia_action /
 *       launch / focus_window / set_window / close_window / wait / batch
 * 公共参数：frameKey（坐标帧归属，调用方标识）、screenshot_after（操作后等 settle_ms 再截一张，省一个来回）、
 *          _bannerHwnd（本机 broker 注入：急停横幅窗口，点击不许落在上面）
 */
export async function desktopOp(action, args = {}) {
  if (process.platform !== 'win32') throw new Error('桌面控制目前仅支持 Windows 客户端');
  const a = String(action || '');
  const key = frameKeyOf(args);
  const rect = Array.isArray(args._bannerRect) && args._bannerRect.length === 4 && args._bannerRect.every(Number.isFinite) ? args._bannerRect.map(Math.round) : null;
  const extra = { bannerHwnd: Number(args._bannerHwnd) || 0, bannerRect: rect };
  if (a === 'batch') return runBatch(args, key, extra);
  const result = await runOne(a, args, key, frames.get(key), extra);
  if (args.screenshot_after && a !== 'screenshot' && a !== 'zoom') {
    // 做过结果确认的动作已经等到界面稳定，直接截；没确认的按 settle_ms（默认 400）等
    const settle = args.settle_ms != null ? Number(args.settle_ms) : result.verify ? 0 : 400;
    await sleep(Math.max(0, Math.min(5000, settle || 0)));
    const f = frames.get(key);
    result.screenshot = await doScreenshot({ window: f?.window ?? args.window, display: f?.display }, key);
  }
  return result;
}

async function runOne(a, args, key, frame, extra) {
  switch (a) {
    case 'screenshot': return doScreenshot(args, key);
    case 'zoom': return doZoom(args, frame);
    case 'move': case 'click': case 'double_click': case 'triple_click': case 'right_click': case 'scroll':
      return doPointer(a, args, frame, extra);
    case 'type': {
      const text = String(args.text == null ? '' : args.text);
      const { obs, wantChanged } = obsParams(a, args);
      // target：发送前确认前台属于这个窗口（宿主 Ensure-Target）；别叫 win——那是指针指令的坐标帧窗口
      const r = await sendCmd('type', { text, obs, target: targetOf(args), delay: TYPE_DELAY_MS }, typeTimeoutMs(text));
      const out = { ok: true, action: a, chars: r.chars, sentTo: brief(r.sentTo), foreground: brief(r.foreground) };
      const verify = buildVerify(a, r.obs, { typed: text, wantChanged });
      if (verify) out.verify = verify;
      return out;
    }
    case 'key': {
      const k = parseKeys(args.keys);
      const { obs, wantChanged } = obsParams(a, args);
      const r = await sendCmd('chord', { mods: k.mods, key: k.key, char: k.char, obs, label: keyLabels(args.keys), target: targetOf(args) }, obs ? 40_000 : 20_000);
      const out = { ok: true, action: a, keys: String(args.keys), sentTo: brief(r.sentTo), foreground: brief(r.foreground) };
      const verify = buildVerify(a, r.obs, { wantChanged });
      if (verify) out.verify = verify;
      return out;
    }
    case 'wait': await sleep(Math.max(0, Math.min(10_000, Number(args.ms ?? args.duration_ms) || 500))); return { ok: true };
    case 'wait_for_window': return waitForWindow(args);
    case 'displays': { const r = await sendCmd('displays'); return { displays: r.displays || [] }; }
    case 'cursor': {
      const r = await sendCmd('cursor');
      const inFrame = toFramePixels(frame, r.absX, r.absY);
      return { absX: r.absX, absY: r.absY, ...(inFrame ? { x: inFrame.x, y: inFrame.y } : {}) };
    }
    case 'windows': { const r = await sendCmd('windows'); return { windows: r.windows || [] }; }
    case 'active_window': { const r = await sendCmd('active'); return { window: r.window || null }; }
    case 'processes': { const r = await sendCmd('processes'); return { processes: r.processes || [] }; }
    case 'launch': {
      const { obs, wantChanged } = obsParams(a, args);
      const r = await sendCmd('launch', {
        file: String(args.file || ''),
        argline: winArgs(Array.isArray(args.args) ? args.args.map(String) : []),
        cwd: args.cwd ? String(args.cwd) : undefined,
        obs,
      }, obs ? 45_000 : 30_000);
      // pid 为空＝网址/协议/已在运行的单实例程序：系统交给了别的进程，没有新进程可报
      const out = { ok: true, action: a, file: r.file, pid: r.pid ?? null, ...(r.activated ? { activated: true } : {}), foreground: brief(r.foreground) };
      const verify = buildVerify(a, r.obs, { wantChanged });
      if (verify) out.verify = verify;
      return out;
    }
    case 'focus_window': {
      const { obs, wantChanged } = obsParams(a, args);
      const r = await sendCmd('focus_window', { window: Number(args.window), obs }, obs ? 40_000 : 20_000);
      if (!r.focused) {
        const fg = r.foreground;
        throw new Error(`没能把窗口提到前台（Windows 前台锁拦下了；当前前台是「${fg?.title || fg?.process || '未知'}」）。可以直接点一下目标窗口的标题栏来激活它。`);
      }
      const out = { ok: true, action: a, window: r.window || null };
      const verify = buildVerify(a, r.obs, { wantChanged });
      if (verify) out.verify = verify;
      return out;
    }
    case 'set_window': {
      const r = await sendCmd('set_window', {
        window: Number(args.window),
        x: args.x == null ? null : Number(args.x),
        y: args.y == null ? null : Number(args.y),
        w: args.w == null ? null : Number(args.w),
        h: args.h == null ? null : Number(args.h),
      });
      return { ok: r.ok !== false, window: r.window || null };
    }
    case 'close_window': {
      const r = await sendCmd('close_window', { window: Number(args.window) });
      return { ok: r.ok !== false };
    }
    case 'uia_tree': {
      const r = await sendCmd('uia_tree', {
        window: args.window == null ? null : Number(args.window),
        depth: Math.max(0, Math.min(12, Number(args.depth) || 4)),
        max: Math.max(1, Math.min(1000, Number(args.max) || 250)),
      }, 30_000);
      return { window: r.window || null, nodes: r.nodes || [], truncated: !!r.truncated };
    }
    case 'uia_action': {
      const { obs, wantChanged } = obsParams('uia_action', args);
      const r = await sendCmd('uia_action', {
        ref: Number(args.ref),
        action: String(args.action || ''),
        value: args.value == null ? '' : String(args.value),
        obs,
      }, obs ? 40_000 : 20_000);
      const out = { ok: r.ok !== false, action: 'uia_action', ref: r.ref, uiaAction: r.action };
      const verify = buildVerify('uia_action', r.obs, { wantChanged });
      if (verify) out.verify = verify;
      return out;
    }
    default: throw new Error('未知桌面动作：' + a);
  }
}

// 等窗口出现（或消失）：按标题/进程名/类名子串匹配，250ms 一轮，最多 60 秒
async function waitForWindow(args) {
  const q = String(args.query || '').toLowerCase().trim();
  if (!q) throw new Error('wait_for_window 需要 query（窗口标题、进程名或类名里的一段字）');
  const gone = !!args.gone;
  const timeout = Math.max(250, Math.min(60_000, Number(args.timeout_ms) || 10_000));
  const start = Date.now();
  const gen = generation;
  for (;;) {
    const r = await sendCmd('windows');
    const hits = (r.windows || []).filter((w) => `${w.title} ${w.process} ${w.className}`.toLowerCase().includes(q));
    if (gone ? hits.length === 0 : hits.length > 0) return { ok: true, waitedMs: Date.now() - start, windows: hits.slice(0, 10) };
    if (Date.now() - start >= timeout) throw new Error(`等了 ${Math.round(timeout / 1000)} 秒，${gone ? '含' : '没有出现含'}「${args.query}」的窗口${gone ? '还在' : ''}。`);
    if (gen !== generation) throw new Error('桌面控制已停止');
    await sleep(250);
  }
}

// batch 里这一步做完要不要停：后面的步骤是照着「它成功了」写的，这一步没达到目的就不能接着做
export function batchStop(act, r) {
  if (r?.verify?.expect && !r.verify.expect.ok) return '预期不符，批处理在这一步停下';
  // 打字回读对不上：接着做（比如 Ctrl+S 保存）会把错的内容落下来
  const rb = act === 'type' ? r?.verify?.readback : null;
  if (rb?.kind === 'mismatch') return '回读和输入对不上（可能丢字或乱序），批处理在这一步停下';
  if (rb?.kind === 'unchanged') return '回读显示字没打进去，批处理在这一步停下';
  return null;
}

// 一次调用跑一串动作（官方 computer_batch 同语义）：
//   · 批里所有坐标都按【调用前】最近那张截图；批里中途截的图不改变本批的坐标基准，
//     批跑完后最后一张截图才成为下一次调用的基准；
//   · 顺序执行、遇错即停，回报已完成的每一步和出错那步；急停立即中止。
async function runBatch(args, key, extra) {
  const list = Array.isArray(args.actions) ? args.actions : [];
  if (!list.length) throw new Error('batch 需要 actions: [{action:"click",x,y}, {action:"type",text}, …]');
  if (list.length > 30) throw new Error('batch 一次最多 30 步');
  const startFrame = frames.get(key);
  const gen = generation;
  const steps = [];
  const images = [];
  let lastShotFrame = null;
  let waited = 0;
  const started = Date.now();
  for (let i = 0; i < list.length; i++) {
    if (gen !== generation) { steps.push({ step: i + 1, error: '桌面控制已停止（急停/关闭），批处理中止' }); break; }
    // 每步都可能等界面稳定、等预期：整批封顶 100 秒（调用方的请求超时是 120 秒）
    if (Date.now() - started > 100_000) { steps.push({ step: i + 1, error: 'batch 已跑满 100 秒，后面的步骤没执行' }); break; }
    const item = list[i] && typeof list[i] === 'object' ? list[i] : {};
    const act = String(item.action || '');
    if (!BATCH_ACTIONS.has(act)) { steps.push({ step: i + 1, action: act, error: `batch 里不支持「${act}」` }); break; }
    const sub = act === 'uia_action' ? { ...item, action: String(item.uiaAction || '') } : item;
    if (act === 'wait') {
      waited += Math.max(0, Math.min(10_000, Number(item.ms ?? item.duration_ms) || 500));
      if (waited > 30_000) { steps.push({ step: i + 1, action: act, error: 'batch 里的等待合计超过 30 秒' }); break; }
    }
    try {
      const shotKey = key + '#batch';
      const r = await runOne(act, sub, shotKey, startFrame, extra);
      if (act === 'screenshot') {
        lastShotFrame = frames.get(shotKey);
        images.push({ step: i + 1, kind: 'screenshot', image: r.image, mimeType: r.mimeType, fw: r.fw, fh: r.fh });
        steps.push({ step: i + 1, action: act, ok: true, size: `${r.fw}×${r.fh}` });
      } else if (act === 'zoom') {
        images.push({ step: i + 1, kind: 'zoom', image: r.image, mimeType: r.mimeType, fw: r.fw, fh: r.fh, region: r.region });
        steps.push({ step: i + 1, action: act, ok: true, region: r.region });
      } else {
        steps.push({ step: i + 1, ...r, action: act });
        const stop = batchStop(act, r);
        if (stop) { steps[steps.length - 1].error = stop; break; }
      }
    } catch (e) {
      steps.push({ step: i + 1, action: act, error: String(e?.message || e) });
      break;
    }
  }
  frames.delete(key + '#batch');
  if (lastShotFrame) frames.set(key, lastShotFrame);
  const failed = steps.find((s) => s.error);
  return { ok: !failed, completed: steps.filter((s) => !s.error).length, total: list.length, steps, images };
}

/** 关掉常驻宿主（急停/停止被控时调，确保截屏与输入真正停止）。 */
export function shutdownDesktop() {
  generation++;
  frames.clear();
  const h = host; host = null;
  if (h && h.child) { try { h.child.stdin.end(); } catch {} try { h.child.kill(); } catch {} }
  unlink(HOST_SCRIPT).catch(() => {});
}
