// 「单开一个对话」模式：独立入口 solo.html?solo=<会话 id>（src/solo.js 挂 SoloPage），只有那一个
// 对话，不要主页、不要侧栏。两处用它：
//   · 分屏的另一格——Claude 分页把会话拖到正文区左/右半边，那一格就是一个同源 iframe
//     （?solo=<id>&pane=1）。聊天内核（chat.svelte.js）是模块单例、一页只看一个会话，
//     同屏两个会话最稳的办法就是两份独立的页面实例，谁也不碰谁的状态。
//   · 拖出窗口——会话拖到 app 外面松手，新开一个窗口单独放这个对话（像把浏览器标签页拖出来，
//     只是侧栏里的那一条原地不动）。
//   · 卡片窗口（&card=<工具>&ws=<工作空间>）——工作台的一张卡片拖到 app 外面松手，新窗口里只放
//     这一张卡（终端 / 浏览器 / 文件……），作用域是拖出时那个工作空间。
// 是独立入口而不是 App 的一条路由：iframe / 新窗口只加载对话要的那点代码，不拖起主页那一整套。
// 卡片窗口没有会话（新对话还没落 id）时 solo 填 NO_SESSION：桌面壳开窗只认合法的 solo 参数。
export const NO_SESSION = 'nosession';
const CARD_KEYS = ['tasks', 'review', 'term', 'browser', 'files', 'memory'];
function parse() {
  try {
    if (!/\/solo\.html$/.test(location.pathname)) return null;
    const q = new URLSearchParams(location.search);
    const id = q.get('solo') || '';
    if (!/^[0-9a-zA-Z-]{8,80}$/.test(id)) return null;
    const card = CARD_KEYS.includes(q.get('card')) ? q.get('card') : '';
    return { id: id === NO_SESSION ? '' : id, pane: !card && q.get('pane') === '1', card, ws: card ? (q.get('ws') || '') : '' };
  } catch { return null; }
}
const SOLO = parse();

export const IS_SOLO = !!SOLO;
export const SOLO_ID = SOLO ? SOLO.id : '';
export const IS_PANE = !!(SOLO && SOLO.pane);
export const SOLO_CARD = SOLO ? SOLO.card : '';
export const SOLO_WS = SOLO ? SOLO.ws : '';

// 只放工作台一张卡的窗口地址（见上「卡片窗口」）。
export function cardUrl(view, { id = '', ws = '' } = {}) {
  const u = new URL(soloUrl(id || NO_SESSION));
  u.searchParams.set('card', view);
  if (ws) u.searchParams.set('ws', ws);
  return u.toString();
}

// 卡片窗口 ⇄ 主窗口（同源各窗口之间）：卡片窗口点「放回工作台」→ { t:'back', view, ws }，
// 工作空间对得上的那一页把这张卡重新摆回工作台。
export const DOCK_CHANNEL = 'bridge-claude-dock';

// 只开 id 这个对话的地址：<BASE_URL>solo.html（生产 /app/solo.html、dev /solo.html，apk 本地页同理）。
export function soloUrl(id, { pane = false } = {}) {
  const u = new URL(import.meta.env.BASE_URL + 'solo.html', location.href);
  u.searchParams.set('solo', id);
  if (pane) u.searchParams.set('pane', '1');
  return u.toString();
}

// —— 分屏格 ⇄ 宿主页的消息（同源 postMessage，信封带 bp:1 以免与别的消息混）——
//   格 → 宿主：ready / focus（点进来了）/ session {id,title}（这一格换了会话）/ close / dock {open} /
//             settings {sec}（格里要打开设置页：设置外壳只挂在宿主页）
//             search（焦点在这一格时按了 Ctrl+K：宿主开搜索面板）
//   宿主 → 格：open {id}（侧栏点会话、拖进这一格）/ quote {id,title}（会话拖到这一格的输入栏＝引用）/
//             wco {h,right}（桌面壳窗控避让）/ away（宿主那边被按下，收起弹层）
export const PANE_MSG = 'bp';
export function isPaneMsg(e) { return !!(e && e.data && e.data[PANE_MSG] === 1 && e.origin === location.origin); }
