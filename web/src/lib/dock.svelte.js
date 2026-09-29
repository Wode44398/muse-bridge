// Claude 分页右侧工作台（dock）的共享状态 + 小工具。
// 入口=每一格右上角标题栏带里的工具开关（Claude 桌面版同款；手机仍是两点键 + 底部 sheet）；
// 四件：任务 / 审阅（worktree 概览）/ 终端（工作空间 PTY）/ 文件（跳工作空间目录）。
// 面板一律按 dock.ws（当前会话工作空间绝对路径）作用域；切会话自动跟随。

import { apiUrl } from './server.js';
import { api, authHeaders } from './api.js';
import { t, tc } from './i18n.js';

// snap=聊天快照页（/c/<token>）：工作台只摆 审阅/文件/任务，终端没有。
// 快照的 ws 是服务端锁死的桶目录，前端并不知道（也不该知道）真实路径——这里放一个占位串
// 让 ws 相关的守卫/{#key} 照常工作，后端对 snap 身份一律忽略客户端传来的 ws。
// filesTarget = 文件视图的定位目标（产物文件夹卡/agent goto 用）：
//   { seq, rel, ws } —— ws 非空时文件页以该目录为根（服务端 /api/files?ws= 再授权一次），
//   rel = 初始相对路径。seq 递增让宿主 {#key} 每次都重挂 FilesPanel（初始路径是 onMount
//   一次性消费的）。null = 默认行为：以身份文件根打开、定位到会话工作空间目录。
// tasksFocus = 「任务」视图要定位/高亮的工具行条目（点对话里的 Workflow 卡 / Agent 行进来），{ tool, seq }；
// tasksAgent = 压在任务列表之上的子 agent 转录视图 { tool, wf }（wf = 工作流里那条 workflow_agent 记录，
// Agent 工具的子 agent 为 null）——官方 pushPaneView('tasks', {kind:'subagent'}) 的对应物。
// noAuto = agent 动了终端时【不】自动拉开工作台，只亮提示点（分屏时两格都窄、工作台默认收着）。
// —— 卡片（Claude 桌面版同款：标题栏里一排工具开关，每个开关管一张圆角卡片）——
// views = 此刻开着的卡片（按打开先后）；view = 最近打开/聚焦的那一张（手机 sheet、视图上报、
// 旧调用方都只认它）。open ≡ views 非空。
// multi = 允许几张卡同时开（宿主按形态定：主窗口单格够宽才开；分屏格 / 独立窗口 / 折叠屏 /
// 手机 sheet 一次只放一张——窄，而且终端占一条常驻 SSE，HTTP/1.1 每主机只有 6 条连接，
// 多窗口各开一堆会把别的请求挤到排队）。max = 放大铺满这一格的那张卡（'' = 没有）。
const claudeState = $state({ open: false, view: 'review', views: [], multi: false, max: '', ws: '', meta: null, termLive: false, snap: false, filesTarget: null, tasksFocus: null, tasksAgent: null, noAuto: false });

const TOOL_KEYS = ['tasks', 'review', 'term', 'files'];
function syncOpen() {
  claudeState.open = claudeState.views.length > 0;
  if (!claudeState.open) { claudeState.max = ''; claudeState.filesTarget = null; }
  else if (claudeState.max && !claudeState.views.includes(claudeState.max)) claudeState.max = '';
}
// view 缺省 / 'menu'（旧入口：顶栏两点键、快照页）= 上次用的那张，没有就「审阅」。
function openView(view) {
  const v = TOOL_KEYS.includes(view) ? view : (TOOL_KEYS.includes(claudeState.view) ? claudeState.view : 'review');
  const has = claudeState.views.includes(v);
  claudeState.views = claudeState.multi ? (has ? claudeState.views : [...claudeState.views, v]) : [v];
  claudeState.view = v;
  // 放大着别的卡时点开这一张：放大态让给它，不然新卡被藏在后面等于没开
  if (claudeState.max && claudeState.max !== v) claudeState.max = '';
  if (v === 'term') claudeState.termLive = false;
  syncOpen();
}

export const dock = claudeState;

export function openDock(view) {
  openView(view);
}

export function closeDock() { claudeState.views = []; syncOpen(); }

// 关掉一张卡；关的是最后一张 = 整个工作台收起。
export function closeDockView(view) {
  const rest = claudeState.views.filter((v) => v !== view);
  if (rest.length === claudeState.views.length) return;
  claudeState.views = rest;
  if (claudeState.view === view && rest.length) claudeState.view = rest[rest.length - 1];
  if (view === 'files') claudeState.filesTarget = null;
  syncOpen();
}

// 标题栏工具开关 / 快捷键：开着就关这一张，没开就开（多卡形态下是加一张，不顶掉别的）。
export function toggleDockView(view) {
  if (claudeState.open && claudeState.views.includes(view)) closeDockView(view);
  else openView(view);
}

// 放大 / 还原一张卡（铺满这一格，对话暂时让出来；再点一次还原）。
export function toggleDockMax(view) {
  claudeState.max = claudeState.max === view ? '' : view;
}

// 宿主形态变了（进分屏 / 窗口缩窄）：不许多卡时只留最近那张。
export function setDockMulti(on) {
  on = !!on;
  if (claudeState.multi === on) return;
  claudeState.multi = on;
  if (!on && claudeState.views.length > 1) {
    claudeState.views = [claudeState.views.includes(claudeState.view) ? claudeState.view : claudeState.views[claudeState.views.length - 1]];
    syncOpen();
  }
}

// 这个身份 / 这个工作空间能用哪些工具（标题栏开关、手机 sheet 的 chip 条共用一张表）。
// 任务 = 官方 Tasks 侧栏（只读数据，快照访客也给）；终端只给有 shell 的身份、快照没有。
// meta 没到之前按「有 shell」乐观摆，别让开关闪一下再消失。
export const DOCK_TOOLS = [
  { key: 'term', label: t('终端'), kbd: 'Ctrl+`' },
  { key: 'review', label: t('审阅'), kbd: 'Ctrl+Shift+G' },
  { key: 'files', label: tc('claude', '文件'), kbd: 'Ctrl+Shift+E' },
  { key: 'tasks', label: tc('claude', '任务'), kbd: '' },
];
export function dockSnapMode() { return claudeState.snap || claudeState.meta?.snap === true; }
export function dockToolOk(key) {
  const shell = !claudeState.meta || claudeState.meta.shell !== false;
  const snap = dockSnapMode();
  if (key === 'term') return shell && !snap;
  return TOOL_KEYS.includes(key);
}

// 在工作台的「文件」视图里打开一个目录：产物文件夹/文件卡点开、agent 的 wsx goto 都走这里。
// target = { rel, ws?, open? }（服务端算好的定位；ws 非空＝文件页以该目录为根；
// open 非空＝列表加载后自动打开该文件的面板内预览——文件产物「点链接进工作区」走它）。
let filesSeq = 0;
export function openDockFiles(target = {}) {
  claudeState.filesTarget = { seq: ++filesSeq, rel: target.rel || '', ws: target.ws || '', open: target.open || '' };
  openView('files');
}

// —— 「任务」视图（官方 Tasks 侧栏）——
// openTaskDetail(tool)：打开工作台的任务视图并定位到这条工具行（Workflow 卡 → 详细卡滚到可见；
// Agent 行 → 直接压上它的子转录视图，官方点 Agent 行就是开转录）。opts.agent 传工作流里的一条
// workflow_agent 记录时，压上的是那个 agent 的转录（磁盘 jsonl 轮询）。
let taskSeq = 0;
export function openTaskDetail(tool, opts = {}) {
  if (!tool) return;
  claudeState.tasksFocus = { tool, seq: ++taskSeq };
  const wantAgent = opts.agent !== undefined ? opts.agent : (tool.name === 'Agent' || tool.name === 'Task' ? null : undefined);
  claudeState.tasksAgent = wantAgent === undefined ? null : { tool, wf: wantAgent };
  openView('tasks');
}
export function backToTaskList() { claudeState.tasksAgent = null; }
export function closeTaskDetail() { claudeState.tasksFocus = null; claudeState.tasksAgent = null; }
// 某条工具行从视图里被撤掉（对账整段替换 / 撤回）：别让面板盯着一个已不在列表里的旧 proxy
export function forgetTaskTool(tool) {
  if (claudeState.tasksFocus && claudeState.tasksFocus.tool === tool) claudeState.tasksFocus = null;
  if (claudeState.tasksAgent && claudeState.tasksAgent.tool === tool) claudeState.tasksAgent = null;
}

// 会话切换/项目变化时由 ClaudePage 同步进来；ws 变化时面板经 {#key} 整体重建。
// 换工作空间清掉文件定位：下次打开是干净的工作空间视图。
export function setDockWs(ws) {
  const next = ws || '';
  if (claudeState.ws === next) return;
  claudeState.ws = next;
  claudeState.meta = null;
  claudeState.filesTarget = null;
}

// dock.meta 的唯一拉取口：工作台展开要它（rel/shell/snap），输入框上方的归属状态栏芯片
// 也要它（branch/worktree），而后者在工作台没展开时就得有值。放这里做「每个 ws 只拉一次 +
// 并发去重」，两边随便谁先要都行，不会打两遍。setDockWs 已把 meta 清空，换 ws 自然重拉。
let metaWs = '';
let metaInflight = null;
export function ensureDockMeta() {
  const ws = claudeState.ws;
  if (!ws) return Promise.resolve(null);
  if (claudeState.meta && metaWs === ws) return Promise.resolve(claudeState.meta);
  if (metaInflight && metaWs === ws) return metaInflight;
  metaWs = ws;
  metaInflight = (async () => {
    let m;
    // 必须走 api.get 而不是裸 fetch：网络层失败要 noteServerUnreachable 亮离线态，
    // 成功要 noteServerReachable 熄灭它。
    try { m = await api.get(`/api/claude/dock/meta?ws=${encodeURIComponent(ws)}`); } catch { m = null; }
    if (!m) m = { rel: null, git: false, branch: null, worktree: false, shell: false };
    // 拉取期间可能已切走工作空间——晚到的结果不许盖到新 ws 头上
    if (claudeState.ws === ws) claudeState.meta = m;
    metaInflight = null;
    return m;
  })();
  return metaInflight;
}

// 快照页（SnapPage）挂载时调一次：标记快照模式 + 给 ws 一个占位（真实桶路径在服务端）。
export function useSnapDock() {
  claudeState.snap = true;
  setDockWs('snap');
}

// agent 在共享终端里动了手（SSE 'term' 事件）：宽屏自动拉开终端面板同屏；
// 窄屏亮提示点等用户自己点开。
export function noteAgentTerm() {
  if (claudeState.open && claudeState.views.includes('term')) return;
  claudeState.termLive = true;
  try { if (window.innerWidth >= 1024 && !claudeState.open && !claudeState.noAuto) openView('term'); } catch {}
}

// —— fetch 版 SSE 读取器（EventSource 带不了 Authorization 头；沿用 sse.js 的帧解析思路）——
// onEvent 收 JSON 对象；返回 abort 函数。断流不自动重连——重连策略由各面板自己定。
export function readDockSse(path, onEvent, { onDead, onClose } = {}) {
  const ctrl = new AbortController();
  (async () => {
    let res;
    try {
      res = await fetch(apiUrl(path), { headers: authHeaders(), credentials: 'same-origin', signal: ctrl.signal });
    } catch { if (!ctrl.signal.aborted) onClose?.(); return; }
    if (!res.ok || !res.body) { onDead?.(res?.status || 0); return; }
    const dec = new TextDecoder();
    const reader = res.body.getReader();
    let buf = '';
    const drain = (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          try { onEvent(JSON.parse(line.slice(5).trim())); } catch { /* malformed frame */ }
        }
      }
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        drain(dec.decode(value, { stream: true }));
      }
    } catch { /* aborted / network */ }
    if (!ctrl.signal.aborted) onClose?.();
  })();
  return () => ctrl.abort();
}
