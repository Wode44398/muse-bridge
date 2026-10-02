// Shared reactive app state (Svelte 5 runes). Import these objects anywhere and
// mutate their fields directly — reads inside components stay reactive.
import { storeGet, storeSet } from './store.js';
import { lastPrefs } from './chatPrefs.js';
import { IS_CSNAP } from './csnap.js';
import { AGENT_IDS, AGENT_BY_ID, screenAgents } from '../../../src/config/agents.mjs';

// The current Claude conversation + whether a turn is streaming.
export const session = $state({
  id: null,        // conversation id (null = fresh, not yet created server-side)
  busy: false,     // a generation is in flight
  pendingQid: null, // qid of an AskUserQuestion awaiting an answer, if any
  projectId: null  // 当前会话的项目（=工作空间路径 cwd）；新会话首轮随 /api/chat 带上
});

// Per-conversation model / effort selection (null → server default).
// 冷启动用「最近一次的选择」当默认（chatPrefs 本地镜像）——关掉页面重进不再回默认档；
// 打开具体会话时 chat.svelte.js 再按该会话的记忆覆盖。快照页不吃主 app 的偏好。
const _lp = IS_CSNAP ? null : lastPrefs();
export const settings = $state({
  model: (_lp && _lp.model) || null,
  effort: (_lp && _lp.effort) || null,
  effortAt: 0,                     // 用户最近一次改 effort 的时刻——比它旧的「实际生效档」回报不再盖住新选择
  fast: !!(_lp && _lp.fast),       // fast mode（Opus 5/4.8/4.7；加速输出、消耗额外用量）

  style: 'normal',   // Use style: normal/learning/concise/explanatory/formal
  research: false,   // Research 深度研究模式（注入研究指令，放开多轮 WebSearch/Task）
});

// 发送前暂存的附件（上传后的 {path, name, kind, url?}），send 之后清空。
export const compose = $state({ attachments: [] });

// View + theme.
export const ui = $state({
  theme: (() => { try { return localStorage.getItem('bridge-theme') || 'dark'; } catch { return 'dark'; } })(), // 与 index.html 早绑定一致
  screen: 'home',         // 顶层页面: 'home' | 'claude' | 'harness' | 'files'
  // 分页自报的页面配色：null = 跟全局 ui.theme。dimensio 分页有自己的明暗档（跟系统/浅/深），
  // 它可能与 bridge 主题不一致——theme-color meta 与内嵌的工作空间视图据此跟它走。
  pageChrome: null,       // null | { dark: boolean, bg: '#rrggbb' }
  filesPath: null,        // 工作空间页的一次性初始路径（相对文件根）——Claude 工作台内嵌 FilesPanel 前预置，onMount 消费后清空
  view: 'greeting',       // claude 页内部视图: 'greeting' | 'chat'
  drawerOpen: false,
  routinesOpen: false,    // the Routines (定时触发) full-screen page
  loginOpen: false,       // 登录/注册/用户信息卡（主页右上 pill 展开 / 单页模式的登录框）
  pairScan: null,         // 手机端「扫一扫」登录网页版：null | { mode:'scan' } | { mode:'confirm', id, key }（系统相机扫到 ?pair= 直达确认卡）
  claudeSliding: false,   // claude 左缘右滑跟手中（预测式返回，页面缩小露出身后主页）——唤醒被 display:none 的 Home
  settingsOpen: false,    // 设置页是否打开
  serverAdminOpen: false, // 服务端控制台（设置页入口）——盖在设置页之上
  extensionsOpen: false,  // 扩展中心（技能/连接器/插件，设置入口，admin）——同样盖在设置页之上
  offline: false,         // 离线模式（连不上服务器，用本地 IndexedDB 缓存浏览历史聊天）——只读，发消息会失败
  taskDone: false,        // 有任务完成且用户还没看（不在 claude 页前台时收到 done/error）——回 claude 页清除
  // 页面级转场（lib/pageMorph.js，View Transitions）进行中：'' | 'open' | 'close' | 'switch'。
  // 转场期间快照层盖在最上面、不吃点击；系统返回在这段时间里被吞掉（nav.js），不打断演出。
  morphing: '',
  booted: false,          // 启动完成（auth 有结果）
});

// Capability catalog from /api/capabilities (models, efforts).
export const caps = $state({ loaded: false, data: null });

// Who am I (/api/auth)：{ kind:'admin'|'user'|'none', user, tier, edition, agents, features, canSnapshot, service }。
// 显示哪些分页全看 agents（统一 id：claude / dimensio，服务端已把全局开关与按人授权取过交集；
// 没登录时是服务器全局开着的名单）。edition = 'host' | 'server'；features = { multiUser, register, remoteAdmin }。
// 初始值从同步快照(storeGet)恢复：已登录用户每次进 app 启动瞬间即按上次登录态渲染，不再
// 闪一下"未登录"。/api/auth 回来后经 applyMe 校正（仅 token 真失效才退登录）。快照非凭证（真鉴权靠 token），伪造无害。
function normMe(m) {
  const kind = (m && m.kind) || 'none';
  return {
    kind, user: m?.user || null, tier: m?.tier || null,
    agents: Array.isArray(m?.agents) ? m.agents.filter((id) => AGENT_IDS.includes(id)) : null,
    edition: m?.edition === 'host' || m?.edition === 'server' ? m.edition : null,
    features: m?.features && typeof m.features === 'object' ? { ...m.features } : null,
    canSnapshot: !!m?.canSnapshot, service: !!m?.service,
  };
}
function loadMe() {
  try { const m = JSON.parse(storeGet('bridge-me') || 'null'); if (m && m.kind) return normMe(m); } catch {}
  return normMe(null);
}
export const me = $state(loadMe());
// 所有更新登录态的地方都走它（别直接赋值 me.kind=…，否则快照漂移）：更新 me + 同步写快照。
// 没登录也存（kind:'none' + 服务器开着的 agent 名单）：只开一个 agent 的服务器，下次打开直接落在那一页。
export function applyMe(a) {
  // 退出登录（applyMe(null)）：服务器形态与 agent 名单不变，只把身份清掉——单 agent 的服务器退出后
  // 还该停在那一页的登录框上，而不是闪回一个满是入口的主页。
  if (!a) a = { kind: 'none', edition: me.edition, features: me.features, agents: me.agents };
  Object.assign(me, normMe(a));
  try { storeSet('bridge-me', JSON.stringify($state.snapshot(me))); } catch {}
}

// 这个 agent 对当前身份开着吗（agents 未知 = 还没拿到 /api/auth → 当作开着）。
export function agentOn(id) { return !Array.isArray(me.agents) || me.agents.includes(id); }
// 某个顶层页面该不该出现：由撑着它的 agent 决定。主页 / 工作空间恒在。
export function screenOn(screen) {
  const ids = screenAgents(screen);
  return !ids.length || ids.some(agentOn);
}

// 单 agent 模式：这个身份能进的 agent 分页只剩一个，那一页就是「根页」——没有主页，打开即是
// 那一页；设置 / 账户收进侧栏底部账户卡；返回键到这一页就是底；工作空间等别的页关掉回这一页。
// Claude 页与 dimensio 页都做了这层外壳。
// 没登录时 me.agents 是服务器全局开着的名单：全局只开一个 agent 的服务器，登录框就直接压在那一页上。
const ROOT_SCREENS = new Set(['claude', 'harness']);
export function rootScreen() {
  if (!Array.isArray(me.agents)) return 'home';
  const screens = new Set(me.agents.map((id) => AGENT_BY_ID[id]?.screen).filter(Boolean));
  if (screens.size !== 1) return 'home';
  const [s] = screens;
  return ROOT_SCREENS.has(s) ? s : 'home';
}
export function singleMode() { return rootScreen() !== 'home'; }

// Rate-limit + context-fill snapshot (/api/status).
// contexts：按会话记的 context 填充（多对话并发下并行轮各自收尾，单槽会互相覆盖）。
// usages：按会话记的上下文分布（SDK getContextUsage 精确档，SSE ctx_usage / /api/status）；
// efforts：按会话记的实际生效 effort（Stop hook）；commands：斜杠命令表（/api/commands，5min 缓存）。
// plan：套餐名（如 "Max (20x)"，/api/status 的 plan 字段，弹层标题「Plan usage limits · …」）。
// models：按会话记的【实际模型】{id, from, at}——安全栅门把会话切到回退模型（SSE
// session{swapped} / model_notice scope=session）后，Composer 的模型芯片据此标「本会话已切换到 X」。
// suggestions：按会话记的输入建议 {text, at, dismissed?}——每轮定局后 CLI 预测的下一句（总线 suggestion /
// hello 帧），输入框空着时当占位文字显示，Tab 填入（见 chat.svelte.js noteSuggestion）。
export const status = $state({ limits: null, context: null, contexts: {}, usages: {}, efforts: {}, models: {}, suggestions: {}, commands: null, plan: null, updatedAt: 0, fast: null });

// 任务详情（Agent 子转录 / Workflow 阶段面板）住在右侧工作台的「任务」视图
//（lib/dock.svelte.js 的 tasksFocus / tasksAgent）。

// 输入栏上方的「已切换到 X」横条（RefusalBand）数据源：最新一条 scope=session 的
// model_refusal_fallback 通知（chat 内核维护）：
//   { subtype, from, to, scope, trigger, category, explanation, text, requestId, refusedUserUuid,
//     sessionId, at, dismissed }
// 新用户消息发出 / 切会话 / 回滚到被拒消息 → 置 null；横条的 X 只把 dismissed 标 true。
// prompt：安全栅门把本轮暂停、等人二选一时的 Paused 卡（服务端 refusal_prompt 事件）：
//   { qid, sessionId, from, to, category, busy }
// 收到 refusal_answer / 本轮收尾 / 切会话 → 置 null。同一槽位里 prompt 优先于 notice 横条。
export const refusalBand = $state({ notice: null, prompt: null });

export function setTheme(theme) {
  ui.theme = theme;
  try { document.documentElement.setAttribute('data-theme', theme); } catch {}
  try { localStorage.setItem('bridge-theme', theme); } catch {}
}
export function toggleTheme() { setTheme(ui.theme === 'dark' ? 'light' : 'dark'); }

// —— 偏好开关（设置页·通用）——
// followSys: 跟随系统明暗（prefers-color-scheme 驱动界面明暗）
// noEnterAnim: 禁用页面转场动画（直切页面）
// fullResMedia: 原图加载（相册/漫画查看器直接拉原图、预载也按原图跑；默认关=1280 轻量档+缩放时升级）
// worktree: 输入栏分支胶囊右半的 worktree 勾选框——勾着开新对话＝先切一个 git worktree 再跑（官方同款，默认关）
// promptSuggest: 输入建议（Claude 每轮回复完预测下一句，输入框空着时显示，Tab 填入；默认开，与官方同）
const PREFS_KEY = 'bridge-prefs';
function loadPrefs() {
  try { const p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); if (p) return { followSys: !!p.followSys, noEnterAnim: !!p.noEnterAnim, fullResMedia: !!p.fullResMedia, promptSuggest: p.promptSuggest !== false, worktree: !!p.worktree }; } catch {}
  return { followSys: false, noEnterAnim: false, fullResMedia: false, promptSuggest: true, worktree: false };
}
export const prefs = $state(loadPrefs());

// worktree 会话的真实工作目录：会话 id → { cwd, branch }。来源两处——首轮 session 帧（worktree
// 刚切出来，列表还没它）与 /api/session（重开 / 冷启动）；会话列表条目自带的 wt 优先。
// 工作台与归属芯片据此指向 worktree，而不是项目的主检出。
export const sessionWt = $state({});
export function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ followSys: prefs.followSys, noEnterAnim: prefs.noEnterAnim, fullResMedia: prefs.fullResMedia, promptSuggest: prefs.promptSuggest, worktree: prefs.worktree })); } catch {}
}

// 跟随系统明暗：监听 prefers-color-scheme；开关打开瞬间也调一次（applyFollowSys）。
let _applyFollowSys = () => {};
if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => { if (prefs.followSys) setTheme(mq.matches ? 'dark' : 'light'); };
  try { mq.addEventListener('change', apply); } catch {}
  _applyFollowSys = apply;
}
export function applyFollowSys() { _applyFollowSys(); }
