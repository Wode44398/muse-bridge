// Shared reactive app state (Svelte 5 runes). Import these objects anywhere and
// mutate their fields directly — reads inside components stay reactive.
import { storeGet, storeSet } from './store.js';
import { t } from './i18n.js';
import { presets } from './liquidGlass.js';
import { lastPrefs } from './chatPrefs.js';
import { IS_CSNAP } from './csnap.js';
import { serverHosted } from './deployFlags.js';
import { storedLocalImageSettings } from './localImageSettings.js';
import { AGENT_IDS, screenAgents } from '../../../src/config/agents.mjs';
import { pickRootScreen } from './rootScreen.js';

// The current Claude conversation + whether a turn is streaming.
export const session = $state({
  id: null,        // conversation id (null = fresh, not yet created server-side)
  busy: false,     // a generation is in flight
  pendingQid: null, // qid of an AskUserQuestion awaiting an answer, if any
  projectId: null  // 当前会话的项目（=工作空间路径 cwd）；新会话首轮随 /api/chat 带上
});

// Per-conversation model / effort selection (null → server default).
// 冷启动用「最近一次的选择」当默认（chatPrefs 本地镜像）——杀后台重进不再回默认档；
// 打开具体会话时 chat.svelte.js 再按该会话的记忆覆盖。快照页不吃主 app 的偏好。
const _lp = IS_CSNAP ? null : lastPrefs();
export const settings = $state({
  model: (_lp && _lp.model) || null,
  effort: (_lp && _lp.effort) || null,
  effortAt: 0,                     // 用户最近一次改 effort / Ultracode 的时刻——比它旧的「实际生效档」回报不再盖住新选择
  // Ultracode（动态工作流编排）：与 effort 档位独立的勾选（10-30，对齐桌面端 4.29）。只对当前会话生效，
  // 新对话从关着起步（lastPrefs 不带它）。
  ultracode: false,
  fast: !!(_lp && _lp.fast),       // fast mode（Opus 5/4.8/4.7；加速输出、消耗额外用量）

  style: 'normal',   // Use style: normal/learning/concise/explanatory/formal
  research: false,   // Research 深度研究模式（注入研究指令，放开多轮 WebSearch/Task）
});

// 发送前暂存的附件（上传后的 {path, name, kind, url?}），send 之后清空。
export const compose = $state({ attachments: [] });

// View + theme.
export const ui = $state({
  theme: (() => { try { return localStorage.getItem('bridge-theme') || 'dark'; } catch { return 'dark'; } })(), // 与 index.html 早绑定一致
  screen: 'home',         // 顶层页面: 'home' | 'claude' | 'harness' | 'vertex' | 'files'（预载页是 App 的 booting 覆盖层，不在此）
  // 分页自报的窗口 chrome 配色（桌面壳 WCO 窗控 glyph 跟它走）：null = 跟全局 ui.theme。
  // dimensio 分页有自己的明暗档（跟系统/浅/深），bridge 主题是深色时它可能是浅底——
  // 窗控 glyph 若还按 bridge 主题刷成白色，就成了「右上角三颗钮与白底融为一体」。
  pageChrome: null,       // null | { dark: boolean, bg: '#rrggbb' }
  filesPath: null,        // 工作空间页的一次性初始路径（相对文件根）——Claude 工作台内嵌 FilesPanel 前预置，onMount 消费后清空
  view: 'greeting',       // claude 页内部视图: 'greeting' | 'chat'
  drawerOpen: false,
  routinesOpen: false,    // the Routines (定时触发) full-screen page
  loginOpen: false,       // 登录/注册/用户信息卡（主页右上 pill 展开）
  serverSwitcherOpen: false, // 切换服务器面板（手机 App 多服务器档案，lib/serverProfiles.js + components/ServerSwitcher.svelte）
  serverSwitching: false, // 切换服务器的转场进行中（lib/serverSwitch.js）：主页标题让位给转场封面里的那一份
  pairScan: null,         // 手机端「扫一扫」登录网页版：null | { mode:'scan' } | { mode:'confirm', id, key }（系统相机扫到 ?pair= 直达确认卡）
  // 桌面 Dock / 命令面板要一次入场的旧契约旗子（App 接住后交给 lib/pageMorph.js，跑完放下）；手机四宫格直接调 openPage
  enterClaude: false,
  enterVertex: false,
  vertexSliding: false,   // vertex 左缘右滑跟手中（预测式返回，页面缩小露出身后主页）——唤醒被 display:none 的 Home
  claudeSliding: false,   // claude 同上——只有此时才唤醒被 display:none 省掉的 Home
  settingsOpen: false,    // 设置页是否打开（从登录 pill 菜单 morph 扩展到全屏）
  serverAdminOpen: false, // 服务端控制台（桌面服务端形态，设置页右上角入口）——盖在设置页之上
  agentsOpen: false,      // 设置「Agent」页（各 agent 开关 / 能否运行 / 认证，admin）——同样盖在设置页之上
  settingsPreview: false, // 设置页拖滑块预览中——此刻设置页透明露出主页看实时折射，临时恢复主页 backdrop-filter
  wpStage: false,         // 壁纸实景舞台中（设置页罩退散、主页即预览）——同样恢复主页 backdrop-filter
  homePop: 0,             // 自增计数：设置页返回主页时 bump 一下，触发主页四入口图标「鼓包」弹性（复用预载缓动）
  offline: false,         // 离线模式（连不上 PC，用本地 IndexedDB 缓存浏览历史聊天）——只读，发消息会失败
  connMode: 'tunnel',     // 当前数据线路: 'tunnel'（隧道/同源）| 'lan'（局域网直连）——设置页展示用
  taskDone: false,        // 有任务完成且用户还没看（不在 claude 页前台时收到 done/error）——主页 claude 小人举旗，回 claude 页清除
  enterOrigin: null,      // 旧契约：被点入口的 rect {x,y,w,h}，作为转场起点（DesktopHome 写）
  enterOriginTile: null,  // 旧契约：入口所在玻璃方块的 rect（有就优先用它当起点）
  enterBar: null,         // 桌面 Dock 栏 rect（旧契约，DesktopHome 仍会写；新转场引擎用它判断圆角后即清空）
  // 页面级转场（lib/pageMorph.js，View Transitions）进行中：'' | 'open' | 'close' | 'switch' | 'theme'。
  // 转场期间快照层盖在最上面、不吃点击；系统返回在这段时间里被吞掉（nav.js），不打断演出。
  morphing: '',
  booted: false,          // 预载页是否已结束——flux 等到此为 true（进主页）才挂载，好「从黑浮现」
  glassMode: (() => { try { return localStorage.getItem('bridge-glass') || 'B'; } catch { return 'B'; } })(), // iOS 玻璃方案: 'A'=flux+透光毛玻璃 / 'B'=多洛米蒂+WebGL 折射；点 THE BRIDGE 切换
  themeTransition: null,  // 主页明暗换场进行中: null | { dir:'AtoB'|'BtoA', phase:'reveal' }（lib/homeTheme.js）
  preloadPhase: 'cover',  // 预载演出阶段: 'cover'(封面驻留等加载，标题+方块居中) | 'expand'(方块放大，标题归位左上)
  revealIcons: false,     // 明亮主题(B)图标是否浮现(原地透明度 0→1)；预载/转场视频后段触发，暗主题(A)不用此
});

// —— Vertex (Gemini) 分页状态 ——
// Gemini 对话的系统提示词 / URL 上下文 / 代码执行 / 识图清晰度：模型菜单里改，持久化（老值不合法就回默认）。
const CHAT_OPTS_KEY = 'bridge-vertex-chatopts';
function storedChatOpts() {
  const d = { chatSystem: '', chatUrl: false, chatCode: false, chatMediaRes: 'auto' };
  try {
    const j = JSON.parse(localStorage.getItem(CHAT_OPTS_KEY) || 'null');
    if (j && typeof j === 'object') {
      if (typeof j.chatSystem === 'string') d.chatSystem = j.chatSystem.slice(0, 8000);
      d.chatUrl = j.chatUrl === true;
      d.chatCode = j.chatCode === true;
      if (['auto', 'low', 'medium', 'high'].includes(j.chatMediaRes)) d.chatMediaRes = j.chatMediaRes;
    }
  } catch {}
  return d;
}

// 当前模块(func) + 历史抽屉/模块菜单开关 + 各模块的模型与选项选择（null → 运行时取 caps 默认）。
export const vertex = $state({
  // Vertex 独立明暗（与全局 ui.theme 解耦，由分页顶栏日/月钮控制）；默认深色。
  theme: (() => { try { return localStorage.getItem('bridge-vertex-theme') || 'dark'; } catch { return 'dark'; } })(),
  func: 'chat',          // chat | image | video | voice | music
  drawerOpen: false,     // 左上历史抽屉
  funcMenuOpen: false,   // 右上模块菜单
  // 对话（联网搜索默认开——Gemini 不带 grounding 容易过时/胡说，按需手动关）
  chatModel: null, chatThink: null, chatSearch: true,
  ...storedChatOpts(),
  // 快速识图：图片降采样到 1600px 再喂模型（上传小、视觉 token 少、识图快）；关掉=发原图（慢但保细节，读小字用）。默认开。
  fastVision: (() => { try { return localStorage.getItem('bridge-vertex-fastvision') !== '0'; } catch { return true; } })(),
  // 图像
  imageModel: null, imageAspect: 'auto', imageSize: null, imageThink: null, imageSearch: false, imageImgSearch: false,
  ...storedLocalImageSettings(),
  imageFormat: 'both',   // 输出格式: 'both'(图文) | 'image'(仅图) → responseModalities
  imageTemp: 1, imageTopP: 0.95,   // Nano Banana 采样参数
  imagePersonGen: '',    // 人物生成 ''(默认) | ALLOW_ALL | ALLOW_ADULT | ALLOW_NONE
  // 视频。videoTask = 任务类型（t2v 文生 / i2v 图生 / interp 首尾插值 / ref 参考图）：
  // 它决定露哪几个素材槽、生成前校验什么，后端也按它取舍图片。
  videoModel: null, videoTask: 't2v', videoAspect: 'auto', videoResolution: '720p', videoDuration: 8, videoAudio: false,
  videoNeg: '', videoEnhance: true, videoQuality: '',   // Veo 专属：负面提示词 / 提示词增强 / 画质
  // 语音。voiceMulti = 多人对白模式（最多 2 人，各配一个音色）；voiceStyle = 风格指令前缀。
  voiceModel: null, voice: null, voiceStyle: '', voiceMulti: false,
  voiceSpeakers: [{ speaker: t('主持人'), voice: 'Kore' }, { speaker: t('嘉宾'), voice: 'Puck' }],
  // 音乐
  musicModel: null, musicNeg: '',
  // 助手「配置但不自动开始」预填：把提示词放进来，对应面板挂载/变化时塞进输入框（用户点生成），用后清空。
  // 工作空间「发送给 AI」复用：文本素材注入各媒体面板提示词栏（imageDraft/voiceDraft 新增），图片素材挂为源图（*SrcDraft）。
  videoDraft: '', musicDraft: '', imageDraft: '', voiceDraft: '',
  imageSrcDraft: null, videoSrcDraft: null,   // {path,url,name}：图片素材 → 图片/视频面板的 srcImage
  // 工作空间「发送给 AI」→ Gemini 对话：待投递的附件，VertexPage 的对话 composer 挂载/变化时消费进 vAtts。
  chatDraftAtts: [],
  // 媒体生成「+」素材来源菜单 / 工作空间素材选择器的开关（VertexPage 系统返回 closer 要读，故放 vs）。
  matMenu: false, matPicker: false,
});

// Capability catalog from /api/capabilities (models, efforts, media options).
export const caps = $state({ loaded: false, data: null });

// Who am I (/api/auth)：{ kind:'admin'|'user'|'none', user, tier, hosting, agents, features, canSnapshot, service, allow* }。
// 客户端不分版本，显示哪些分页全看 agents（统一 id：claude/gemini/codex/dimensio，服务端已把全局开关与
// 按人授权取过交集；没登录时是服务器全局开着的名单）。hosting = 'host' | 'server'（部署形态：自己的电脑 / 服务器，
// 「电脑 / 服务器」措辞据此挑，见 hostIsServer；旧后端不给 = 'host'）；features = { multiUser,
// register, remoteAdmin }。旧后端没有 agents 字段 → 按旧的 allow* 规则推（legacyAgents），新 apk 连旧服务器照常。
// 初始值从同步快照(storeGet)恢复：已登录用户每次进 app 启动瞬间即按上次登录态渲染，不再
// 闪一下"未登录"（旧：me 初始 none → 等 /api/auth 异步返回才变登录的那段窗口）。/api/auth
// 回来后经 applyMe 校正（仅 token 真失效才退登录）。快照非凭证（真鉴权靠 token），伪造无害。
function legacyAgents(m) {
  if (!m || !m.kind || m.kind === 'none') return null;   // 不知道 → 全显示（旧行为）
  return ['claude', 'gemini', ...((m.kind !== 'user' || m.allowCodex) ? ['codex'] : []), ...(m.allowDimensio ? ['dimensio'] : [])];
}
function normMe(m) {
  const kind = (m && m.kind) || 'none';
  return {
    kind, user: m?.user || null, tier: m?.tier || null,
    allowCodex: !!m?.allowCodex, allowDimensio: !!m?.allowDimensio,
    agents: Array.isArray(m?.agents) ? m.agents.filter((id) => AGENT_IDS.includes(id)) : legacyAgents(m),
    tokenHashed: !!m?.tokenHashed,
    hosting: m?.hosting === 'server' ? 'server' : 'host',
    features: m?.features && typeof m.features === 'object' ? { ...m.features } : null,
    canSnapshot: !!m?.canSnapshot, service: !!m?.service,
    // 关着的内置功能（插件，/api/auth 的 plugins.off；本地快照里存成 pluginsOff）
    pluginsOff: Array.isArray(m?.plugins?.off) ? m.plugins.off.filter((x) => typeof x === 'string') : Array.isArray(m?.pluginsOff) ? m.pluginsOff : [],
    // 插件市场里有更新的个数（只有主机拿得到；只提示不自动装）：设置 › 扩展 与「功能扩展」标签上的角标
    pluginUpdates: Math.max(0, Number(m?.plugins?.updates ?? m?.pluginUpdates ?? 0) || 0),
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
  if (!a) a = { kind: 'none', tokenHashed: me.tokenHashed, features: me.features, agents: me.agents };
  Object.assign(me, normMe(a));
  try { storeSet('bridge-me', JSON.stringify($state.snapshot(me))); } catch {}
}

// 服务端跑在服务器上（不是自己的电脑）：断线提示等说「服务器」而不是「电脑」。离线时读的是上次登录态的快照。
export const hostIsServer = () => serverHosted(me);

// 某项内置功能（插件，设置 › 扩展 › 功能扩展）在这台服务器上开着吗。旧后端不下发 = 都开着。
export function pluginOn(id) { return !me.pluginsOff.includes(id); }

// 这个 agent 对当前身份开着吗（agents 未知 = 旧后端没登录 → 当作开着，界面同旧版）。
export function agentOn(id) { return !Array.isArray(me.agents) || me.agents.includes(id); }
// 某个顶层页面该不该出现：由撑着它的任一 agent 决定（vertex 页 = Gemini）。主页 / 工作空间恒在。
export function screenOn(screen) {
  const ids = screenAgents(screen);
  return !ids.length || ids.some(agentOn);
}

// 单 agent 模式：这个身份能进的 agent 分页只剩一个，而且那一页做了「当根页」的外壳——没有主页，
// 打开即是那一页；设置 / 账户收进侧栏底部账户行（Claude in Finance 同款）；返回键到这一页就是底；
// 工作空间等别的页关掉回这一页。有这层外壳的是 Claude 页与 dimensio 页，判定规则见 lib/rootScreen.js。
// 没登录时 me.agents 是服务器全局开着的名单：全局只开一个的服务器，登录框就直接压在那一页上。
export function rootScreen() { return pickRootScreen(me.agents); }
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

// 任务详情（Agent 子转录 / Workflow 阶段面板）2026-09-05 起住进右侧工作台的「任务」视图
//（lib/dock.svelte.js 的 tasksFocus / tasksAgent），旧的底部抽屉 TaskSheet 与 taskSheet/wf 状态已删。

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

// Vertex 分页独立明暗切换（顶栏日/月钮）——只动 vertex.theme，不碰全局 ui.theme。
export function toggleVertexTheme() {
  vertex.theme = vertex.theme === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem('bridge-vertex-theme', vertex.theme); } catch {}
}
// 快速识图开关（Gemini 侧栏设置子栏）：开=图片降采样提速、关=发原图保细节。持久化。
export function setVertexFastVision(on) {
  vertex.fastVision = !!on;
  try { localStorage.setItem('bridge-vertex-fastvision', on ? '1' : '0'); } catch {}
}

// 对话选项（系统提示词 / URL 上下文 / 代码执行 / 识图清晰度）改完落盘
export function saveVertexChatOpts() {
  const { chatSystem, chatUrl, chatCode, chatMediaRes } = vertex;
  try { localStorage.setItem(CHAT_OPTS_KEY, JSON.stringify({ chatSystem, chatUrl, chatCode, chatMediaRes })); } catch {}
}

// iOS 两套玻璃方案切换（点 THE BRIDGE）：'A' flux+透光毛玻璃 ↔ 'B' 多洛米蒂+WebGL 折射
export function toggleGlassMode() {
  ui.glassMode = ui.glassMode === 'A' ? 'B' : 'A';
  try { localStorage.setItem('bridge-glass', ui.glassMode); } catch {}
}

// —— 偏好开关（设置页·通用/个性化）——
// followSys: 跟随系统明暗（prefers-color-scheme 驱动主页明暗系统）
// followPage: 分页跟随主页明暗（主页切明/暗时，claude 分页主题同步 light/dark）
// noEnterAnim: 禁用系统转场动画（claude/vertex 入场全跳过，直切页面）
// fullResMedia: 原图加载（相册/漫画查看器直接拉原图、预载也按原图跑；默认关=1280 轻量档+缩放时升级）
// worktree: 输入栏分支胶囊右半的 worktree 勾选框——勾着开新对话＝先切一个 git worktree 再跑（官方同款，默认关）
// promptSuggest: 输入建议（Claude 每轮回复完预测下一句，输入框空着时显示，Tab 填入；默认开，与官方同）
// claudeMark: Claude 运行标记——'clay'=新版 Claude Code 的活动标记（默认）/ 'sprite'=新版 claude.ai 聊天页（星形→节点）/ 'classic'=原来的 claude.ai 星标五态
// compactFrac: Claude 自动压缩点（用量弹层计量条上的滑块）= 占模型窗口的比例，null = 默认（CLI 自定）
const PREFS_KEY = 'bridge-prefs';
const fracOk = (v) => (typeof v === 'number' && v > 0 && v < 1 ? v : null);
function loadPrefs() {
  try { const p = JSON.parse(localStorage.getItem(PREFS_KEY) || 'null'); if (p) return { followSys: !!p.followSys, followPage: !!p.followPage, noEnterAnim: !!p.noEnterAnim, fullResMedia: !!p.fullResMedia, promptSuggest: p.promptSuggest !== false, worktree: !!p.worktree, claudeMark: p.claudeMark === 'classic' || p.claudeMark === 'sprite' ? p.claudeMark : 'clay', compactFrac: fracOk(p.compactFrac) }; } catch {}
  return { followSys: false, followPage: false, noEnterAnim: false, fullResMedia: false, promptSuggest: true, worktree: false, claudeMark: 'clay', compactFrac: null };
}
export const prefs = $state(loadPrefs());

// worktree 会话的真实工作目录：会话 id → { cwd, branch }。来源两处——首轮 session 帧（worktree
// 刚切出来，列表还没它）与 /api/session（重开 / 冷启动）；会话列表条目自带的 wt 优先。
// 工作台与归属芯片据此指向 worktree，而不是项目的主检出。
export const sessionWt = $state({});
export function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify({ followSys: prefs.followSys, followPage: prefs.followPage, noEnterAnim: prefs.noEnterAnim, fullResMedia: prefs.fullResMedia, promptSuggest: prefs.promptSuggest, worktree: prefs.worktree, claudeMark: prefs.claudeMark, compactFrac: prefs.compactFrac })); } catch {}
}

// 某个明暗系统在这台设备上能不能用：iOS 不跑流光动态壁纸，暗系统只在选了静态壁纸时才有。
// 判断要看壁纸槽，由 wallpaper.svelte.js 注册进来（它 import 本模块，反向 import 会成环）。
let homeModeOk = () => true;
export function setHomeModeGuard(fn) { homeModeOk = fn; }
export function canUseHomeMode(mode) { return homeModeOk(mode); }

// 静默设定主页明暗系统（壁纸预览/跟随系统用——不播 THE BRIDGE 的视频转场）。
// followPage 开时联动分页主题。
export function setHomeMode(mode) {
  if (mode !== 'A' && mode !== 'B') return;
  if (!homeModeOk(mode)) return;
  if (ui.glassMode !== mode) {
    ui.glassMode = mode;
    try { localStorage.setItem('bridge-glass', mode); } catch {}
    ui.revealIcons = mode === 'B';   // 明系统的图标浮现态（暗系统不用）
  }
  if (prefs.followPage) setTheme(mode === 'B' ? 'light' : 'dark');
}

// 跟随系统明暗：监听 prefers-color-scheme；开关打开瞬间也调一次（applyFollowSys）。
let _applyFollowSys = () => {};
if (typeof window !== 'undefined' && window.matchMedia) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = () => {
    if (!prefs.followSys) return;
    // 单 agent 模式没有主页：跟随系统直接驱动界面明暗（主页明暗系统与「分页跟随」在那里无从谈起）
    if (singleMode()) { setTheme(mq.matches ? 'dark' : 'light'); return; }
    setHomeMode(mq.matches ? 'A' : 'B');
  };
  try { mq.addEventListener('change', apply); } catch {}
  _applyFollowSys = apply;
}
export function applyFollowSys() { _applyFollowSys(); }

// 点 THE BRIDGE 的主页明暗换场住在 lib/homeTheme.js（要用转场引擎，放这里会循环引用）。
// ui.themeTransition 仍是「换场进行中」的标记：{ dir:'AtoB'|'BtoA', phase:'reveal' } | null。

// —— 旧版 SVG 液态玻璃的固定参数（10-07 起不再可调：设置页的画质预设与三滑块已删）——
// 新版 Figma 玻璃（FigmaGlass / Dock 同款）不读这些参数，只吃 ramp；这里只剩没有 WebGPU 时
// 的 SVG 退路、登录胶囊在用。数值＝原「平衡」档（09-23 维护者手机调定）。
// quality.ramp：折射/色散的瞬时倍率（0→1 鼓包动画用，Home 驱动）。
// 放在模块级 quality 上而非组件 $state——action 参数对 quality 的响应已被滑块路径验证可达。
export const quality = $state({ ss: 1, blur: 0, glow: 0.23, refraction: 46, dispersion: 5, ramp: 1 });
try { localStorage.removeItem('bridge-quality'); } catch {}   // 清掉旧版存的档位/滑块值

// 主页四入口图标 + 右上登录胶囊 + claude/vertex 入场转场玻璃【共用】的液态玻璃材质内核：
// bare=默认纯折射（去边光/高光/底色，暗壁纸下融入背景只留内容）；「光感」滑块 glow>0 时按强度
// 加回立体边光+镜面高光（见 app.css .lg-bare），= 原登录胶囊那套打光。参数统一取上面的 quality
// ——改一处全员同步。radius 各传各的（图标/转场 30 / 胶囊 22）；组件里用 $derived(bareGlass(r))。
export function bareGlass(radius = 30) {
  return { ...presets.dispersion, radius, bare: true,
    scale: quality.refraction, aberration: quality.dispersion, glow: quality.glow,
    supersampling: quality.ss, blur: quality.blur };
}

// —— flux 流体壁纸（暗主题 glassMode A）的可调参数 ——
// 暴露 Wallpaper Engine flux 壁纸的 user properties，做进设置页个性化栏（仅装载该壁纸=glassMode A 时显示）。
// 改动由 Home.svelte 的 $effect 实时 `wallpaperPropertyListener.applyUserProperties` 套到 iframe。
// 默认 = 维护者选定的「短点阵」（2026-10-23）：Orange set 预设（深蓝近黑 Poolside）的流体参数，线段缩成短点
// （线段长 20、宽 4、缩放 1）；原预设是 viewscale 1.4 / linelength 273 / linewidth 11。范围/类型抄壁纸 project.json。
export const FLUX_DEFAULTS = {
  colormode: 'Poolside', fps: 60, viewscale: 1, linelength: 20, linewidth: 4, gridspacing: 12,
  viscosity: 5, velocitydissipation: 0.21, diffusioniterations: 3, pressureiterations: 19, fluidsize: 128,
};
export const FLUX_COLORMODES = [
  { id: 'Poolside', name: t('池畔') }, { id: 'Original', name: t('原版') },
  { id: 'Plasma', name: t('等离子') }, { id: 'Freedom', name: t('自由') },
];
// label 中文显示；min/max/step 抄 project.json；step 缺省=1（整数滑块）；group:1 = 截图的「Simulation Parameters」组。
export const FLUX_SLIDERS = [
  { key: 'fps', label: t('演化速度'), min: 1, max: 240 },
  { key: 'viewscale', label: t('缩放'), min: 1, max: 5.5, step: 0.1 },
  { key: 'linelength', label: t('线段长度'), min: 20, max: 3000 },
  { key: 'linewidth', label: t('线段宽度'), min: 1, max: 60 },
  { key: 'gridspacing', label: t('线条间距'), min: 1, max: 100 },
  { key: 'viscosity', label: t('粘度'), min: 0.01, max: 200, step: 0.01, group: 1 },
  { key: 'velocitydissipation', label: t('速度耗散'), min: 0, max: 5, step: 0.01, group: 1 },
  { key: 'diffusioniterations', label: t('扩散迭代'), min: 0, max: 50, group: 1 },
  { key: 'pressureiterations', label: t('压力迭代'), min: 0, max: 200, group: 1 },
  // pow2：只能取 2 的幂，滑条按指数走（32/64/128/256/512 五档）。打包的 flux 流体尺寸不是 2 的幂时解算会炸，
  // 整屏变成一格一格的放射乱线（96、112、160、192 实测都炸，32–512 的 2 的幂都正常）。
  { key: 'fluidsize', label: t('流体尺寸'), min: 32, max: 512, pow2: true, group: 1 },
];
export function fluxPow2(v) { return 2 ** Math.round(Math.log2(Math.min(512, Math.max(32, Number(v) || 128)))); }
function loadFlux() {
  // 读入时就把旧存的非 2 的幂流体尺寸归位（之前滑条是逐个整数，存下过 96 这类坏值）
  try { const f = JSON.parse(storeGet('bridge-flux') || 'null'); if (f) return { ...FLUX_DEFAULTS, ...f, fluidsize: fluxPow2(f.fluidsize ?? FLUX_DEFAULTS.fluidsize) }; } catch {}
  return { ...FLUX_DEFAULTS };
}
export const fluxParams = $state(loadFlux());
// fluxParams → applyUserProperties 入参格式 {key:{value}}。「缩放」(viewscale) 只改流体在屏幕上的显示尺寸、
// 模拟域固定，离 1–5.5 太远流体会缩到屏幕中间露黑边（2026-06-23 bug），这里钳住并顺带修正越界旧值。
// 挂到 window 上：壁纸 iframe 在 flux 构造前就来取（wallpaper/index.html），免得先按引擎默认值建好再改。
export function fluxProps() {
  const p = {};
  for (const k in fluxParams) p[k] = { value: fluxParams[k] };
  if (p.viewscale) p.viewscale.value = Math.min(5.5, Math.max(1, fluxParams.viewscale));
  if (p.fluidsize) p.fluidsize.value = fluxPow2(fluxParams.fluidsize);
  return p;
}
if (typeof window !== 'undefined') window.__fluxProps = fluxProps;
export function saveFlux() { try { storeSet('bridge-flux', JSON.stringify({ ...fluxParams })); } catch {} }
export function resetFlux() { Object.assign(fluxParams, FLUX_DEFAULTS); saveFlux(); }
