// 设备工具 mcp__device__*：让跑在 bridge 上的 Claude 操作用户自己的电脑（桌面客户端）。
//
// 对标官方「云会话连接本机」：Claude 自己的 Read / Write / Bash 作用在 bridge 所在的机器上，
// 用户电脑上的事一律经这组工具——看屏幕、点任何桌面程序（UIA 语义优先，截图坐标兜底）、
// 带用户登录态的浏览器、本机命令与文件、在两台机器之间搬文件。
//
// 这组工具替代了原来的两套：mcp__localPc__*（经桌面壳 broker 操作同一台电脑）与
// mcp__remotePc__*（经中继操作已配对的客户端）。现在同机就是「不经公网的那台设备」，同一套工具。
//
// 目标设备：参数 device（id 或名字）> 会话连接的设备（输入框下方的设备芯片）> 恰好一台在线。
// 权限：设备服务按用户在客户端里选的档位硬拦（observe 只能看，control 才能动）；这里只做解析与提示。

import { z } from 'zod';
import path from 'node:path';
import os from 'node:os';
import { open, mkdir, stat as fsStat } from 'node:fs/promises';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { resolveDevice, deviceDispatch, ownDevices } from '../runtime/devices.mjs';
import { listForwards, createForward, removeForward } from '../runtime/device-forward.mjs';
import { deliverRoots, deliverAnywhere } from '../runtime/deliverables.mjs';
import { withinRoot } from '../runtime/http-file.mjs';
import { VAULT } from '../config/index.mjs';
import { COORD_RULES, VERIFY_RULES, desktopContent, desktopResult, formatUia, formatWindows } from './desktop-format.mjs';

const txt = (text) => ({ content: [{ type: 'text', text: String(text) }] });
const err = (e) => ({ content: [{ type: 'text', text: '设备操作失败：' + String(e?.message ?? e).slice(0, 600) }], isError: true });
const json = (v) => JSON.stringify(v, null, 2);

export const INSPECT_ACTIONS = ['active_window', 'windows', 'processes', 'displays', 'cursor', 'screenshot', 'zoom', 'uia_tree', 'wait_for_window'];
export const ACT_ACTIONS = [
  'launch', 'focus_window', 'set_window', 'close_window',
  'move', 'click', 'double_click', 'triple_click', 'right_click', 'scroll', 'type', 'key', 'uia_action', 'wait', 'batch',
];
export const UIA_ACTIONS = ['focus', 'invoke', 'set_value', 'select', 'toggle', 'expand', 'collapse', 'scroll_into_view'];
const BATCH_ACTIONS = ['move', 'click', 'double_click', 'triple_click', 'right_click', 'scroll', 'type', 'key', 'wait', 'screenshot', 'zoom', 'uia_action', 'focus_window', 'cursor', 'active_window'];
// 需要新版执行层（2026-10-20 坐标帧重做之后）的动作：老客户端会回「未知桌面动作」
const NEW_DESKTOP_ACTIONS = new Set(['zoom', 'wait_for_window', 'triple_click', 'wait', 'batch']);

// 两台机器之间搬文件：每块 4MB 原始字节（base64 后约 5.4MB，远低于设备回传上限 16MB）。
const CHUNK = 4 * 1024 * 1024;
const MAX_TRANSFER = 512 * 1024 * 1024;
const LEGACY_MAX = 10 * 1024 * 1024;   // 老执行器不认分块，只能一次读 / 写这么大
// files(read) 回给模型的文本上限：同 Read 工具的口径，长文件按行分段读
const READ_MAX_LINES = 2000;
const READ_MAX_CHARS = 200 * 1024;

export const expectSchema = z.object({
  window: z.string().optional().describe('应出现标题含这段文字的窗口'),
  gone: z.string().optional().describe('标题含这段文字的窗口应消失'),
  focus: z.string().optional().describe('焦点控件的类型/名称/AutomationId 应含这段文字'),
  value: z.string().optional().describe('焦点输入框的内容应含这段文字（密码框不读）'),
  text: z.string().optional().describe('前台窗口的控件树里应出现这段文字（或某窗口标题含它）'),
  changed: z.boolean().optional().describe('true=画面/窗口/焦点应有变化；false=应没有变化'),
}).describe('结果预期：工具一直等到全部满足或 expect_timeout_ms 超时，不符合就报错');

const batchItem = z.object({
  action: z.enum(BATCH_ACTIONS),
  x: z.number().optional(), y: z.number().optional(),
  ref: z.number().int().optional(),
  button: z.enum(['left', 'right', 'middle']).optional(),
  amount: z.number().optional(),
  text: z.string().optional(),
  keys: z.string().optional(),
  ms: z.number().optional(),
  region: z.array(z.number()).length(4).optional(),
  window: z.number().optional(),
  display: z.number().int().optional(),
  uiaAction: z.enum(UIA_ACTIONS).optional(),
  value: z.string().optional(),
  expect: expectSchema.optional(),
  expect_timeout_ms: z.number().optional(),
  verify: z.boolean().optional(),
}).describe('一步动作，字段同 act/inspect 的同名参数；带 expect 的步骤不符合时整批停下');

const deviceArg = z.string().optional().describe('目标设备 id 或名字；省略 = 会话连接的那台（输入框下方的设备芯片），没连接且只有一台在线时用那台');

const TIER_LABEL = { control: '可观察并操作', observe: '只允许观察', off: '已关闭', workspace: '只开了命令与文件（老客户端，未开桌面控制）' };

// 提示词按 CLI 启动时定稿（停放的 CLI 跨轮复用），所以不写死「连的是哪台」——会话中途换了设备，
// 以 devices 工具现查为准。
export function deviceNudge() {
  return '\n\n【用户的电脑】你可以操作用户登记过的电脑（设备），会话连接的那台就是默认目标（输入框下方的设备芯片，用户随时可换）。' +
    '你（Claude）跑在 bridge 服务器上：Read/Write/Edit/Bash 作用在服务器上，**不是**用户的电脑——除非 `devices` 把那台设备标成「与 bridge 同一台机器」。' +
    '凡是用户电脑上的事——看他的屏幕、点他的程序、读写他电脑上的文件、在他电脑上跑命令、用他已登录的浏览器——一律用 `mcp__device__*`。' +
    '\n用法：`devices` 看有哪些设备、哪台连在本会话、各自在线与权限档；`inspect` 观察桌面（active_window → uia_tree 读控件，读不到再 screenshot），`act` 操作桌面（优先 uia_action 或 click+ref，坐标兜底）；' +
    '`browser` 驱动设备上的浏览器（带用户的登录态，操作对用户实时可见）；`shell` 在设备上跑命令（Windows 是 PowerShell）；`files` 读写设备上的文件（glob 找文件、grep 搜内容、read 按行分段读），`files(action:"pull")` 把设备上的文件拷到服务器、`files(action:"push")` 把服务器上的产物拷到设备；' +
    '`ports(action:"open", port)` 把设备上的本机端口（他电脑上跑着的 dev server、本机模型接口）接到服务器，给出服务器上能直接访问的地址。' +
    COORD_RULES + '\n提速：能预判的连续步骤用 `act(action:"batch")` 一次做完；单步可加 `screenshot_after:true`；等弹窗用 `inspect(action:"wait_for_window")`。' + VERIFY_RULES +
    '\n权限由设备自己硬拦：observe 档只能看，control 档才能点击、输入、跑命令、写文件。这是用户本人的真实电脑：严格只做被要求的事；发送消息、删除、下单、改安全设置、关闭含未保存内容的窗口等高风险动作，执行前必须用 AskUserQuestion 确认。' +
    '遇到 UAC 安全桌面、锁屏、受保护内容或截图黑屏时不要绕过，如实交还用户。用户可以随时在屏幕上方的提示条、托盘或 Ctrl+Alt+Shift+F11 急停，届时工具会回「设备已断开」。';
}

/**
 * @param {object} o
 * @param {object} o.ctx        调用者身份（设备归属按它）
 * @param {() => string} o.getLink  会话当前连接的设备 id（'' = 没连）——每次调用现取，芯片改了立刻生效
 * @param {(id:string) => void} [o.setLink]  agent 用 devices(use=…) 切换连接的设备
 * @param {() => string} [o.getSession]  会话 id（审计与设备侧「谁在操作」提示用）
 * @param {() => string} [o.getTitle]    会话标题（同上）
 */
export function makeDeviceMcp({ ctx, getLink = () => '', setLink = null, getSession = () => '', getTitle = () => '' }) {
  const target = (want) => {
    const r = resolveDevice(ctx, { want: want || '', linked: getLink() || '' });
    if (r.error) throw new Error(r.error);
    return r.device;
  };
  const send = (d, op, args, timeoutMs, onChunk = null) => deviceDispatch(ctx, d.id, op, args, {
    timeoutMs, onChunk, by: 'claude', session: getSession() || '', title: getTitle() || '',
  });
  const frameKey = () => 'claude:' + (getSession() || 'new');
  const tierOf = (d) => d.client?.tier || '';
  const caps = (d) => new Set(d.client?.caps || []);

  const desktop = async (d, action, args) => {
    if (tierOf(d) === 'workspace') throw new Error(`设备「${d.name}」没开桌面控制（老客户端只开了命令与文件）——请对方更新客户端，或在托盘里勾选「允许远程桌面控制」。`);
    const slow = action === 'screenshot' || action === 'zoom' || action === 'uia_tree' || action === 'launch' || args.screenshot_after;
    const timeout = action === 'batch' || action === 'wait_for_window' ? 120_000 : slow ? 30_000 : 20_000;
    try {
      return await send(d, 'desktop', { ...args, action, frameKey: frameKey() }, timeout);
    } catch (e) {
      if (NEW_DESKTOP_ACTIONS.has(action) && /未知桌面动作/.test(String(e?.message))) throw new Error(`设备「${d.name}」的客户端版本较旧，还不支持「${action}」——请对方更新客户端；眼下用单步 screenshot/click/type 代替。`);
      throw e;
    }
  };

  // 服务器一侧的路径：相对路径按会话工作目录；沙箱身份只能落在自己的空间里。
  const serverPath = (p) => {
    const abs = path.resolve(ctx.cwd || VAULT || os.homedir(), String(p || ''));
    if (!deliverAnywhere(ctx) && !deliverRoots(ctx, ctx.cwd, VAULT).filter(Boolean).some((r) => withinRoot(r, abs))) {
      throw new Error('服务器上的这个路径不在你的工作空间里：' + abs);
    }
    return abs;
  };

  const tools = [
    tool('devices',
      '列出你可以操作的电脑（设备）：在线状态、权限档、客户端版本，以及这个会话连接的是哪台。' +
      'use=设备 id 或名字：把这个会话改连到那台设备（用户口头指定「用我的笔记本」时用）；use="none" 断开连接。',
      { use: z.string().optional().describe('把会话连接改到这台设备（id 或名字）；"none" = 断开') },
      async (a) => {
        try {
          const mine = ownDevices(ctx);
          if (a.use && setLink) {
            if (a.use === 'none') setLink('none');
            else {
              const hit = mine.find((d) => d.id === a.use || d.name === a.use || d.name.toLowerCase() === String(a.use).toLowerCase());
              if (!hit) return err(new Error(`找不到设备「${a.use}」`));
              setLink(hit.id);
            }
          }
          if (!mine.length) return txt('还没有登记任何设备。要让我操作你的电脑：在那台电脑上装 bridge 桌面客户端、用同一个账号登录（登录即自动登记）。');
          const linked = getLink();
          const lines = mine.map((d) => {
            const c = d.client || {};
            return [
              d.online ? '● 在线' : '○ 离线', d.name, `[${d.id}]`,
              c.os || d.platform || '', c.version ? 'v' + c.version : '',
              d.online ? (TIER_LABEL[c.tier] || '') : (d.lastOfflineAt ? '最后在线 ' + d.lastOfflineAt.slice(0, 16).replace('T', ' ') + ' UTC' : ''),
              d.sameMachine ? '与 bridge 同一台机器' : '',
              d.id === linked ? '← 本会话连接的设备' : '',
            ].filter(Boolean).join('  ');
          });
          return txt('你的设备：\n' + lines.join('\n') + (linked === 'none' ? '\n\n（这个会话设为不连接设备。）' : ''));
        } catch (e) { return err(e); }
      }),

    tool('inspect',
      '观察设备的 Windows 桌面。action: active_window/windows/processes/displays/cursor/screenshot/zoom/uia_tree/wait_for_window。' +
      '优先 UIA 语义树，读不到再截图。不会点击或修改任何东西。' + COORD_RULES,
      {
        device: deviceArg,
        action: z.enum(INSPECT_ACTIONS),
        window: z.number().optional().describe('目标窗口 hwnd；uia_tree/screenshot 可用。省略=当前前台窗口（uia_tree）或主屏（screenshot）'),
        display: z.number().int().optional().describe('screenshot 的显示器序号；-1=全部显示器'),
        grid: z.boolean().optional().describe('screenshot 叠红色坐标网格（每 100 像素一条，标的就是点击要传的坐标）'),
        region: z.array(z.number()).length(4).optional().describe('zoom：[x0, y0, x1, y1]，最近一张截图里的像素'),
        depth: z.number().int().min(0).max(12).optional().describe('uia_tree 深度，默认4'),
        max: z.number().int().min(1).max(1000).optional().describe('uia_tree/processes 最大条目，默认250'),
        query: z.string().optional().describe('windows/processes 过滤词；wait_for_window 要等的窗口（标题/进程名/类名的一段）'),
        gone: z.boolean().optional().describe('wait_for_window：true=等它消失'),
        timeout_ms: z.number().optional().describe('wait_for_window 超时，默认 10000，最多 60000'),
      },
      async (a) => {
        try {
          const d = target(a.device);
          const { device, ...args } = a;
          const result = await desktop(d, a.action, args);
          const q = String(a.query || '').toLowerCase();
          if (a.action === 'windows') {
            const rows = (result.windows || []).filter((w) => !q || `${w.title} ${w.process} ${w.path} ${w.className}`.toLowerCase().includes(q));
            return txt(formatWindows(rows.slice(0, a.max || 250)));
          }
          if (a.action === 'processes') {
            const rows = (result.processes || []).filter((p) => !q || `${p.name} ${p.title} ${p.path}`.toLowerCase().includes(q));
            return txt(json(rows.slice(0, a.max || 250)));
          }
          if (a.action === 'uia_tree') return txt(formatUia(result));
          if (a.action === 'active_window') return txt(result.window ? formatWindows([result.window]) : '没有前台窗口（可能在锁屏/安全桌面）。');
          if (a.action === 'displays') return txt('显示器：\n' + (result.displays || []).map((x) => `[${x.index}]${x.primary ? ' 主屏' : ''} ${x.w}×${x.h} @${x.x},${x.y}`).join('\n'));
          if (['screenshot', 'zoom', 'cursor', 'wait_for_window'].includes(a.action)) return { content: desktopContent(a.action, result) };
          return txt(json(result));
        } catch (e) { return err(e); }
      }),

    tool('act',
      '操作设备的 Windows 桌面。优先 uia_action 或 click+ref（来自最近一次 uia_tree）；像素坐标仅作兜底。' +
      'action: launch/focus_window/set_window/close_window/move/click/double_click/triple_click/right_click/scroll/type/key/uia_action/wait/batch。' +
      COORD_RULES + ' type 直接输入 Unicode 文本（中文不受输入法影响、不占剪贴板）。' + VERIFY_RULES,
      {
        device: deviceArg,
        action: z.enum(ACT_ACTIONS),
        file: z.string().optional().describe('launch 的 exe/文档/URL'),
        args: z.array(z.string()).optional().describe('launch 参数数组'),
        cwd: z.string().optional().describe('launch 工作目录'),
        window: z.number().optional().describe('窗口 hwnd'),
        x: z.number().optional().describe('最近一次 screenshot 图片里的像素；set_window 时是窗口新位置（屏幕坐标）'),
        y: z.number().optional(),
        ref: z.number().int().optional().describe('uia_action 的目标；click/double_click/right_click/move/scroll 传 ref 则作用在该控件中心（来自最近一次 uia_tree）'),
        w: z.number().optional().describe('set_window 宽'), h: z.number().optional().describe('set_window 高'),
        button: z.enum(['left', 'right', 'middle']).optional(),
        amount: z.number().optional().describe('scroll 滚轮格数；正=上，负=下'),
        text: z.string().optional().describe('type 输入的字面文本，\\n 会按回车'),
        keys: z.string().optional().describe('key 组合键，如 Ctrl+S / Enter / Alt+F4 / Win+R'),
        uiaAction: z.enum(UIA_ACTIONS).optional().describe('uia_action: focus/invoke/set_value/select/toggle/expand/collapse/scroll_into_view'),
        value: z.string().optional().describe('uia_action=set_value 的值'),
        ms: z.number().optional().describe('wait 的毫秒数，最多 10000'),
        actions: z.array(batchItem).max(30).optional().describe('batch：按顺序执行的动作列表，遇错即停。其中坐标都按调用前最近那张截图；批里截的图在批结束后才成为新基准'),
        screenshot_after: z.boolean().optional().describe('做完后截一张同目标的图一并返回（会先等界面稳定）'),
        settle_ms: z.number().optional().describe('screenshot_after 前额外等待的毫秒数'),
        expect: expectSchema.optional(),
        expect_timeout_ms: z.number().optional().describe('expect 最多等多久，默认 3000，最多 15000'),
        verify: z.boolean().optional().describe('false=跳过结果确认（更快，但点空了也看不出来）'),
      },
      async (a) => {
        try {
          const d = target(a.device);
          const { device, ...args } = a;
          const result = await desktop(d, a.action, args);
          // batch 中途停下时执行层也回 ok:false，但每一步的结果都在里面——交给 desktopResult 逐步排版标错，别吞成一句
          if (result && result.ok === false && !result.verify && a.action !== 'batch') return { content: [{ type: 'text', text: `${a.action} 未生效（窗口/元素可能已变化，重新读 windows 或 uia_tree）` }], isError: true };
          if (['launch', 'set_window', 'close_window'].includes(a.action)) return txt(json(result));
          if (result && (result.landed || result.chars != null || result.keys || result.screenshot || result.verify || a.action === 'batch')) return desktopResult(a.action, result);
          return txt('已执行 ' + a.action + (result && result.window ? '：' + (result.window.title || result.window.hwnd) : ''));
        } catch (e) { return err(e); }
      }),

    tool('browser',
      '驱动设备上的浏览器（桌面客户端里的内置浏览器，带用户的登录态，操作对用户实时可见）。' +
      'action: navigate/back/forward/reload/click/type/key/scroll/hover/read_page/screenshot/eval/console/resize/tabs/tab_new/tab_select/tab_close/close/find/network/upload/wait_for/batch，用法同服务器上的浏览器工具。',
      {
        device: deviceArg,
        action: z.string().describe('浏览器动作'),
        url: z.string().optional(), ref: z.union([z.string(), z.number()]).optional(), text: z.string().optional(),
        x: z.number().optional(), y: z.number().optional(), key: z.string().optional(),
        dy: z.number().optional(), filter: z.string().optional(), query: z.string().optional(),
        js: z.string().optional(), preset: z.string().optional(), width: z.number().optional(), height: z.number().optional(),
        tab: z.union([z.string(), z.number()]).optional(), double: z.boolean().optional(), button: z.string().optional(),
        selector: z.string().optional(), force: z.boolean().optional(), region: z.array(z.number()).optional(), ms: z.number().optional(),
        expect: z.record(z.any()).optional(), expect_timeout_ms: z.number().optional(), verify: z.boolean().optional(),
        screenshot_after: z.boolean().optional(), actions: z.array(z.record(z.any())).optional(),
      },
      async (a) => {
        try {
          const d = target(a.device);
          const { device, ...args } = a;
          const r = await send(d, 'browser', args, a.action === 'batch' || a.action === 'wait_for' ? 120_000 : 60_000);
          if (r && r.mcp && Array.isArray(r.mcp.content)) return r.mcp;
          return txt(typeof r === 'string' ? r : json(r));
        } catch (e) { return err(e); }
      }),

    tool('shell',
      '在设备上执行一条命令（Windows=PowerShell，其余=bash），返回 stdout/stderr/退出码。需要设备开着 control 档。',
      {
        device: deviceArg,
        command: z.string().describe('要执行的命令'),
        cwd: z.string().optional().describe('工作目录（设备上的绝对路径）；默认用户主目录'),
        timeoutMs: z.number().optional().describe('超时毫秒，默认 120000，上限 300000'),
      },
      async (a) => {
        try {
          const d = target(a.device);
          const to = Math.min(300_000, Math.max(1000, Number(a.timeoutMs) || 120_000));
          const r = await send(d, 'shell', { command: a.command, cwd: a.cwd, timeoutMs: to }, to + 10_000);
          return txt(`退出码 ${r.exitCode}${r.clipped ? '（输出已截断）' : ''}\ncwd: ${r.cwd}\n\n[stdout]\n${r.stdout || '(空)'}\n\n[stderr]\n${r.stderr || '(空)'}`);
        } catch (e) { return err(e); }
      }),

    tool('files',
      '设备上的文件，以及两台机器之间搬文件。action: read/write/list/glob/grep/stat/mkdir/move/delete（作用在设备上）；' +
      'grep = 在 path（文件夹或文件）里按正则 pattern 搜文件内容，include 限定文件名（如 *.ts），自动跳过 node_modules/.git 与二进制；' +
      'read 可用 offset/limit 按行分段读（长文件不带范围时只回前 2000 行）；' +
      'pull = 把设备上的 path 拷到服务器（to，默认会话工作目录下同名文件）；push = 把服务器上的 from 拷到设备的 path。' +
      '大文件 pull/push 自动分块（上限 512MB）。',
      {
        device: deviceArg,
        action: z.enum(['read', 'write', 'list', 'glob', 'grep', 'stat', 'mkdir', 'move', 'delete', 'pull', 'push']),
        path: z.string().optional().describe('设备上的路径（绝对路径；read/write/list/grep/stat/mkdir/move/delete/pull/push）'),
        to: z.string().optional().describe('move：设备上的新路径；pull：服务器上的目标路径（相对 = 会话工作目录）'),
        from: z.string().optional().describe('push：服务器上的源文件（相对 = 会话工作目录）'),
        content: z.string().optional().describe('write 的内容'),
        encoding: z.enum(['utf8', 'base64']).optional().describe('read/write 编码，默认 utf8；二进制用 base64'),
        pattern: z.string().optional().describe('glob 的匹配式（如 **/*.mjs）；grep 时是要搜的正则'),
        cwd: z.string().optional().describe('glob 的基准目录'),
        include: z.string().optional().describe('grep：只搜文件名匹配这个通配的文件，如 *.ts 或 *.{js,mjs}'),
        ignore_case: z.boolean().optional().describe('grep：忽略大小写'),
        offset: z.number().int().optional().describe('read：从第几行开始（1 起）'),
        limit: z.number().int().optional().describe('read：读多少行'),
        recursive: z.boolean().optional().describe('delete 是否递归'),
      },
      async (a) => {
        try {
          const d = target(a.device);
          if (a.action === 'pull') return txt(await pull(d, a));
          if (a.action === 'push') return txt(await push(d, a));
          if (a.action === 'grep') return txt(await grep(d, a));
          const r = await send(d, 'fs.' + a.action, {
            path: a.path, to: a.to, content: a.content, encoding: a.encoding, pattern: a.pattern, cwd: a.cwd, recursive: a.recursive,
          }, 60_000);
          if (a.action === 'read') return txt(readText(r, a));
          if (a.action === 'write') return txt(`已写入 ${r.path}（${r.bytes} 字节）`);
          if (a.action === 'list') return txt(`${r.path}：\n` + (r.entries || []).map((e) => `${e.type === 'dir' ? '📁' : '📄'} ${e.name}${e.size != null && e.type !== 'dir' ? '  ' + e.size : ''}`).join('\n'));
          if (a.action === 'glob') return txt(`${r.matches.length} 个匹配（${r.pattern} @ ${r.cwd}）：\n` + r.matches.join('\n'));
          if (a.action === 'delete') return txt('已删除 ' + r.path + '（进了设备的回收站）');
          return txt(json(r));
        } catch (e) { return err(e); }
      }),

    tool('ports',
      '把设备上的本机端口接到服务器（端口转发）：他电脑上跑着的 dev server、本机模型的接口等。' +
      'open = 建转发并给出地址（local 是服务器上的地址，Bash/curl 与你的浏览器工具都能直接打开；用户在手机或别处看用 share 地址）；' +
      'list = 列出已有转发；close = 删掉（给 port 或 token）。只转设备的 127.0.0.1；WebSocket（热更新）暂不转，页面照常能用。',
      {
        device: deviceArg,
        action: z.enum(['open', 'list', 'close']),
        port: z.number().int().optional().describe('设备上的本机端口（open / close）'),
        label: z.string().optional().describe('备注，如「vite」「ollama」'),
        token: z.string().optional().describe('close：要删的那条转发的令牌'),
      },
      async (a) => {
        try {
          const show = (f) => `${f.deviceName || f.deviceId} 的 ${f.port} 端口${f.label ? `（${f.label}）` : ''}\n  · 服务器上访问：${f.urls.local}\n  · 分享给用户：${f.urls.preview || f.urls.path}`;
          if (a.action === 'list') {
            const list = listForwards(ctx);
            return txt(list.length ? '已有的端口转发：\n' + list.map(show).join('\n') : '还没有端口转发。');
          }
          if (a.action === 'close') {
            let tok = a.token || '';
            if (!tok && a.port) {
              const d = target(a.device);
              tok = (listForwards(ctx).find((f) => f.deviceId === d.id && f.port === a.port) || {}).token || '';
            }
            if (!tok) throw new Error('close 要给 token，或给 port（加 device）');
            const out = removeForward(ctx, tok);
            if (out.error) throw new Error(out.error);
            return txt('已删除这条端口转发，地址立即失效。');
          }
          if (!a.port) throw new Error('open 要给 port');
          const d = target(a.device);
          if (!caps(d).has('http')) throw new Error(`设备「${d.name}」的客户端版本较旧，还不支持端口转发——请对方更新客户端。`);
          const out = createForward(ctx, d.id, a.port, a.label || '');
          if (out.error) throw new Error(out.error);
          return txt((out.existed ? '这个端口已经接过了：\n' : '已接通：\n') + show(out.forward) +
            '\n设备上没有服务在监听时，访问会报「没有服务在监听」。设备在只看档时，第一次访问会在那台电脑上弹窗问用户。');
        } catch (e) { return err(e); }
      }),
  ];

  // 设备 → 服务器
  async function pull(d, a) {
    if (!a.path) throw new Error('pull 需要 path（设备上的文件）');
    const dest = serverPath(a.to || path.basename(String(a.path).replace(/[\\/]+$/, '')));
    await mkdir(path.dirname(dest), { recursive: true });
    const chunked = caps(d).has('fs.chunk');
    const fh = await open(dest, 'w');
    let offset = 0, size = -1;
    try {
      for (;;) {
        const r = await send(d, 'fs.read', chunked ? { path: a.path, encoding: 'base64', offset, length: CHUNK } : { path: a.path, encoding: 'base64' }, 120_000);
        const buf = Buffer.from(String(r.content || ''), 'base64');
        await fh.write(buf, 0, buf.length, offset);
        offset += buf.length;
        size = Number(r.size ?? r.bytes ?? offset);
        if (!chunked || r.eof || !buf.length || offset >= size) break;
        if (offset > MAX_TRANSFER) throw new Error(`文件超过 ${MAX_TRANSFER / 1048576}MB 上限`);
      }
    } finally { await fh.close(); }
    return `已从设备「${d.name}」拷到服务器：${dest}（${offset} 字节）`;
  }

  // 设备上搜文件内容（引用的文件夹按需读的主力）。老客户端没有 fs.grep：指路 shell 的 Select-String。
  async function grep(d, a) {
    if (!a.path) throw new Error('grep 需要 path（设备上的文件夹或文件）');
    if (!a.pattern) throw new Error('grep 需要 pattern（正则）');
    if (!caps(d).has('fs.grep')) {
      throw new Error(`设备「${d.name}」的客户端版本较旧，还不支持 grep——请对方更新客户端；眼下可用 shell：` +
        `Get-ChildItem -Path '<文件夹>' -Recurse -File -Include *.ts | Select-String -Pattern '<正则>' | Select-Object -First 200`);
    }
    const r = await send(d, 'fs.grep', { path: a.path, pattern: a.pattern, include: a.include, ignoreCase: !!a.ignore_case }, 90_000);
    const files = new Set((r.matches || []).map((m) => m.file)).size;
    const head = `${r.matches.length} 处匹配，${files} 个文件（/${r.pattern}/${r.ignoreCase ? 'i' : ''} @ ${r.path}，扫了 ${r.scanned} 个文件）`;
    const notes = [r.truncated && '匹配太多已截断，缩小 path 或 include 再搜', r.timedOut && '搜索超时只搜了一部分', r.skipped && `跳过 ${r.skipped} 个过大或二进制的文件`].filter(Boolean);
    return head + (notes.length ? '——' + notes.join('；') : '') + '：\n' + (r.matches || []).map((m) => `${m.file}:${m.line}: ${m.text}`).join('\n');
  }

  // read 的文本回显：带 offset/limit 按行切（带行号）；不带范围的长文件只回前 READ_MAX_LINES 行，提示怎么接着读。
  function readText(r, a) {
    const headOf = (extra) => `${r.path}（${r.bytes} 字节，${r.encoding}${extra}）：\n\n`;
    if (r.encoding !== 'utf8') return headOf('') + r.content;
    const ranged = a.offset != null || a.limit != null;
    const lines = String(r.content || '').split('\n');
    if (!ranged && lines.length <= READ_MAX_LINES && r.content.length <= READ_MAX_CHARS) return headOf('') + r.content;
    const from = Math.max(1, Number(a.offset) || 1);
    let slice = lines.slice(from - 1, from - 1 + Math.max(1, Math.min(READ_MAX_LINES, Number(a.limit) || READ_MAX_LINES)));
    let body = slice.map((l, i) => `${from + i}\t${l}`).join('\n');
    if (body.length > READ_MAX_CHARS) {   // 超长行把字数撑爆：截在最后一个整行处（一行都不完整就硬截）
      const cut = body.lastIndexOf('\n', READ_MAX_CHARS);
      body = body.slice(0, cut > 0 ? cut : READ_MAX_CHARS);
      slice = body.split('\n');
    }
    const to = from + slice.length - 1;
    const more = to < lines.length ? `；后面还有，用 offset:${to + 1} 接着读` : '';
    return headOf(`，共 ${lines.length} 行，这里是第 ${from}–${to} 行${more}`) + body;
  }

  // 服务器 → 设备
  async function push(d, a) {
    if (!a.from || !a.path) throw new Error('push 需要 from（服务器上的文件）和 path（设备上的目标路径）');
    const src = serverPath(a.from);
    const st = await fsStat(src);
    if (!st.isFile()) throw new Error('from 不是文件：' + src);
    if (st.size > MAX_TRANSFER) throw new Error(`文件超过 ${MAX_TRANSFER / 1048576}MB 上限`);
    const chunked = caps(d).has('fs.chunk');
    if (!chunked && st.size > LEGACY_MAX) throw new Error('对方客户端版本较旧，一次最多传 10MB——请对方更新客户端。');
    const fh = await open(src, 'r');
    let offset = 0;
    try {
      do {
        const len = Math.min(CHUNK, st.size - offset);
        const buf = Buffer.alloc(len);
        if (len) await fh.read(buf, 0, len, offset);
        await send(d, 'fs.write', { path: a.path, content: buf.toString('base64'), encoding: 'base64', ...(chunked ? { append: offset > 0 } : {}) }, 120_000);
        offset += len;
      } while (offset < st.size);
    } finally { await fh.close(); }
    return `已从服务器拷到设备「${d.name}」：${a.path}（${st.size} 字节）`;
  }

  return createSdkMcpServer({ name: 'device', version: '1.0.0', tools });
}
