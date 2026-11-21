// 把一段文字交给 Claude：插件页面的 bridge.composer.prefill、
// 界面动作的「问 Claude」类按钮都走这里。
//
//   handoffToClaude(text, { send = false } = {}) → void
//
// 三步照 lib/agentUi.js 的 askClaudeAboutError：
//   ① 收掉盖在页面上的层（设置 / 定时任务 / 登录卡）并换到 Claude 页；
//   ② 派 bridge:newchat——Claude 页挂着就按它「新对话」的落点规则开（同侧栏「新对话」），没人接就 newConversation()；
//   ③ 80ms 后 prefillComposer：等新对话的输入栏换好草稿再填，别被「换成新对话那份草稿」冲掉。
// send 为假（页面那条路恒为假）只填不发——人看过、改过再自己按发送；为真时走输入栏自己的发送（同人按发送键）。
//
// 依赖纪律：这里会被 PluginFrame / 手机中转等引用，而它们也可能出现在 solo 入口（分屏格、拖出的窗口）里——
// 绝不能静态引 agentUi.js（它模块顶层就开视图心跳 startUiBeat，只该主界面开）。所以换页的小函数在这里自己写一份，
// 静态只引轻模块（state / toast / i18n），换页、聊天内核、输入栏桥一律动态 import。
import { ui, me, screenOn, rootScreen } from './state.svelte.js';
import { showToast } from './toast.svelte.js';
import { t } from './i18n.js';

/** 一次最多交多少字：与宿主中转 composer 载荷的上限一致。 */
export const HANDOFF_TEXT_MAX = 20000;
// 新对话的输入栏换好草稿要一点时间（同 askClaudeAboutError 的 80ms）
const PREFILL_DELAY = 80;

/** 换到某个顶层页面（'home' = 这个身份的根页）；先收掉盖在页面上的层，否则换了页用户也看不见。 */
export async function gotoScreen(screen) {
  const { goto } = await import('./pageMorph.js');
  ui.settingsOpen = false; ui.routinesOpen = false; ui.loginOpen = false;
  await goto(screen === 'home' ? rootScreen() : screen);
}

/** 截到上限；不劈开代理对（截在一个 emoji 中间会留下半个乱码）。 */
function clip(text) {
  const s = String(text ?? '');
  if (s.length <= HANDOFF_TEXT_MAX) return s;
  let cut = HANDOFF_TEXT_MAX;
  const c = s.charCodeAt(cut - 1);
  if (c >= 0xd800 && c <= 0xdbff) cut--;
  return s.slice(0, cut);
}

// 连点去重：同一段文字 1.5 秒内再来一次不再开第二个新对话（页面按钮连击、中转重放）
let lastKey = '';
let lastAt = 0;

export function handoffToClaude(text, { send = false } = {}) {
  const body = clip(text);
  const key = (send ? '1' : '0') + body;
  const now = Date.now();
  if (key === lastKey && now - lastAt < 1500) return;
  lastKey = key; lastAt = now;
  run(body, !!send).catch((e) => {
    try { console.warn('[handoffToClaude]', e?.message || e); } catch {}   // i18n-ignore 只进控制台
  });
}

async function run(body, send) {
  if (!screenOn('claude')) { showToast(t('这个分页没有对你开放'), 'err'); return; }
  // 没登录：去 Claude 页也只是一张登录卡，直接把登录卡拉出来（同 pluginApps.openApp 的口径）
  if (me.kind === 'none') { ui.loginOpen = true; return; }
  await gotoScreen('claude');
  ui.taskDone = false;
  const handled = !window.dispatchEvent(new CustomEvent('bridge:newchat', { cancelable: true }));
  if (!handled) { const { newConversation } = await import('./chat.svelte.js'); newConversation(); }
  // 空文字：只开新对话，不灌（灌空串会把别处来的草稿冲掉），更不发
  if (!body.trim()) return;
  const { prefillComposer } = await import('./composerBridge.svelte.js');
  setTimeout(() => prefillComposer(body, send ? { send: true } : null), PREFILL_DELAY);
}
