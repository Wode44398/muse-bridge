// 查看器外框契约（ViewerShell = components/preview/MediaViewer.svelte 提供，子查看器 useViewer() 取用）。
//
// 子查看器不再自画头部 / 菜单 / 转圈 / toast，而是向外框「声明」自己要什么：
//
//   const viewer = useViewer();
//   $effect(() => viewer.declare({
//     title: () => item.name,                    // 可以是值，也可以是 getter（外框模板里求值，跟着子组件状态响应）
//     subtitle: () => `${page} / ${pages}`,
//     tools: () => [{ id: 'zoomIn', icon: 'zoomIn', label: t('放大'), kbd: '+', onClick: zoomIn }],   // ≤3 个
//     menu: () => [{ label: t('旋转'), icon: 'rotate', onSelect: rotate }],                          // 溢出菜单（通用项外框自己补）
//   }));
//
// declare 返回撤销函数（放进 $effect 的返回值即可）。同一条目可以叠多份声明，后声明的覆盖先声明的
// （OfficeView 转 PDF 成功后内嵌的 PdfView 再声明一次，就盖过 OfficeView 的）；撤销后露出下面那份。
// 声明按条目 key 归属：默认归当前条目；一页里同时挂着多个条目时可传 { key: item.key }，外框只采用当前条目的那份。
// 缺省情况下外框换条目就整页重建（{#key}），各查看器按「一页一个条目」写即可。
// 要做滑轨 / 混排画廊 / 文档上一个下一个不闪：declare(spec, { follow: true })——这份声明跟着当前条目走，
// 同时外框在「同 kind 的条目之间」切换时保留这一页不重建（item 经 props 换新、页面自己跟着变；
// 换到别的 kind 照常重建）。邻居条目用 viewer.items / viewer.itemAt(i) 取。
//
// —— 声明字段（spec）——（带 * 的可以是值或 getter）
//   title*        标题（缺省 = 条目文件名）          subtitle*      副标题：计数 / 页码 / 保存状态（缺省 = 画廊「i / n」）
//   subtitleSnippet  复杂副标题（Snippet，盖过 subtitle；DocViewer 的保存状态）
//   barEnd        Snippet：顶栏主工具左侧的自定义区（段控件、文字按钮）
//   tools*        主工具 Tool[]（≤3）：{ id, icon, label, kbd?, onClick?, href?, download?, active?, disabled?, hidden? }
//   menu*         溢出菜单 MenuItem[]（放在通用项之前）：见 ViewerMenu.svelte 的条目格式
//   common*       通用菜单项：true（缺省）| false | 要去掉的 id 数组（'download'|'share'|'openWith'|'reveal'|'copyPath'|'copyLink'|'info'|'sendAi'|'rename'|'trash'）
//   info*         文件信息面板追加行 [{ label, value }]（图片尺寸、PDF 页数、时长…）
//   bottom        Snippet：底栏（媒体压在画面上随沉浸显隐；文档是实底一行）。高度自动写进根节点 --vw-bottom
//   float         Snippet：电脑端居中浮动工具条（.vw-float 容器外框给，里面放 .vw-btn）；触屏不渲染
//   bar*          顶栏形态：'auto'（缺省：媒体压在画面上、文档实底）| 'overlay' | 'solid' | 'none'
//   autoHide*     沉浸自动隐藏：true 时鼠标静止 / 触屏无操作 2.6s 后顶栏、底栏、浮条一起淡出（视频播放中）
//   arrows*       外框是否接管 ←/→ 与左右箭头翻画廊（缺省 true；子查看器在 keys 里先吃掉也行）
//   arrowKbd*     左右箭头 / 顶栏上一个下一个的提示里写哪两个键（缺省 ['←', '→']；视频是 ['PgUp', 'PgDn']）
//   seekKeys      true = 混排画廊里 ←/→/Home/End 不交给画廊翻页，留给这一页自己的 keys（视频 ±10 秒）
//   soloBottom    true = 混排画廊里底栏只出这一页自己的，不在下面叠画廊的缩略图条（视频）
//   barNav*       为真 = 顶栏出「上一个 / 下一个」（媒体皮肤缺省不出：图片靠滑动；触屏视频横滑是拖进度，所以要）
//   keys          (e: KeyboardEvent) => boolean：先于外框默认键处理；返回 true = 已处理（外框 preventDefault）
//   dragItem*     顶栏标题拖出去时代表的条目（缺省 = 当前条目；DocViewer 笔记栈里换篇时给栈顶那篇）
//   onBack        () => boolean：关闭钮 / Esc 先问它；返回 true = 自己消费了（DocViewer 先退笔记栈、未保存先确认）
//   closeAnim     () => Promise | null：关闭时由子查看器自己演（图片缩回缩略图原位）；返回 Promise 时外框只淡出背景与 chrome，
//                 等它落定再收起（900ms 兜底）；返回 null 走外框默认的整体淡出
//   flipIn*       为真 = 子查看器正从缩略图放大打开：外框不做整体淡入，只淡入背景与顶栏（锁存到收起）
//   dragLift      false = 下拉关闭时外框不做舞台微缩 + 圆角（子查看器自己演跟手缩小）
//
// —— 外框提供（viewer.*）——
//   item / index / count / host / active / skin('media'|'doc') / touch / canPrev / canNext / closing   只读
//   items（整组条目，只读）/ itemAt(i) → 条目或 null / menuOpen / infoOpen   只读
//   declare(spec, { key?, follow?, kinds? }) → 撤销函数；kinds（配 follow）= 这一页同时管哪几种 kind（图片画廊连带混排里的视频页：['image', 'video']）
//   chrome.visible / show() / hide() / toggle() / poke()（唤出并重新计时）/ hold(reason) → release（保持显示：菜单开着、拖进度、暂停）
//   toast(text, { kind?: 'ok'|'err', ms?: 2200（0 = 常驻）, action?: { label, onClick } }) → { close() }
//   requestClose()（走 onBack + 关闭动画）/ close()（同 requestClose）/ next() / prev() / go(i)
//   dragProgress(p 0..1)：下滑关闭进度（调暗背景、舞台微缩）
//   openMenu({ anchor, items, title?, place?: 'auto'|'top', onclose? })：在外框浮层槽里开一个菜单（两端分流）；
//     onclose 不论怎么关（选完 / 点外面 / Esc / 返回 / 被别的菜单顶掉）都回调一次 / closeMenu()；
//     没有锚点按钮时给 point: {x,y}（视口坐标）按落点弹
//   contextMenu({x,y}) → boolean：图片条目的上下文菜单（保存 / 分享 / 复制图片 / 发送给 AI），外框已接舞台的 contextmenu；
//     子查看器自己认出长按（设备没派发 contextmenu）时调它
//   openInfo() / closeInfo()：文件信息面板（触屏 Sheet、电脑右侧抽屉）
//   download() → boolean / canDownload()：通用「下载 / 另存为」
//   root() → 外框根节点（定位浮层用）
import { getContext, setContext } from 'svelte';

const KEY = Symbol.for('bridge.viewer');

export function provideViewer(api) { setContext(KEY, api); return api; }

const noop = () => {};
const off = () => noop;
// 不在外框里（单独挂载调试 / 以后别的宿主复用某个查看器）时的兜底：所有调用都是安全的空操作
const FALLBACK = Object.freeze({
  inShell: false,
  get item() { return null; }, get index() { return 0; }, get count() { return 0; },
  get host() { return ''; }, get active() { return false; }, get skin() { return 'doc'; }, get touch() { return false; },
  get canPrev() { return false; }, get canNext() { return false; }, get closing() { return false; },
  get items() { return []; }, itemAt: () => null, get menuOpen() { return false; }, get infoOpen() { return false; },
  declare: off,
  chrome: Object.freeze({ get visible() { return true; }, show: noop, hide: noop, toggle: noop, poke: noop, hold: off }),
  toast: () => ({ close: noop }),
  close: noop, requestClose: noop, next: noop, prev: noop, go: noop,
  dragProgress: noop,
  openMenu: noop, closeMenu: noop, contextMenu: () => false, openInfo: noop, closeInfo: noop,
  download: () => false, canDownload: () => false,
  root: () => null,
});

/** 取外框契约；不在外框里返回安全的空实现（inShell=false）。 */
export function useViewer() { return getContext(KEY) || FALLBACK; }

/** 取值：声明字段可以是值或 getter（snippet 字段不经这里） */
export const val = (x, ...a) => (typeof x === 'function' ? x(...a) : x);

/** 焦点是否在可编辑元素里（键盘快捷键要先让给输入） */
export function isEditable(el) {
  if (!el || el === document.body) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !/^(button|checkbox|radio|range|color|file|submit|reset|image)$/i.test(el.type || '');
  return !!el.closest?.('.cm-editor, [contenteditable="true"]');
}
