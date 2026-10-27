// 浏览器动作的唯一实现。Claude 的 SDK MCP（mcp/browser-tools.mjs）、Codex 的 stdio MCP
// （经 loopback 路由）、远程客户端执行器（remote-control-client.mjs）都调 runBrowserAction，
// 驱动同一个按工作空间隔离的 CDP 实例——侧栏面板实时直播 agent 的每一步。
// 2026-10-21 之前 Claude 与 Codex 各有一套 switch，加动作要两边接；现合成一套，Claude 的
// 聊天快照限制（去处白名单、关 eval、upload 限目录）经 opts 传进来。

import * as svc from './claude-browser.mjs';
import { EXTRA_ACTIONS, EXTRA_DESC, runExtraAction, withDialogNote } from './browser-extra.mjs';
import { TAB_DESC, tabsList, resolveTab, tabTag, focusTab, watchPopups } from './browser-tabs.mjs';
import {
  VERIFY_DESC, BATCH_MAX, probePoint, probeRef, focusInfo, pageState, afterAction, hasExpect, waitExpect, runBatch,
} from './browser-verify.mjs';

export const BROWSER_ACTIONS = ['navigate', 'back', 'forward', 'reload', 'click', 'type', 'key', 'scroll', 'hover', 'long_press', 'drag', 'pinch', 'read_page', 'screenshot', 'eval', 'console', 'resize', 'tabs', 'tab_new', 'tab_select', 'tab_close', 'close', ...EXTRA_ACTIONS, 'wait_for', 'batch'];

export const BROWSER_DESCRIPTION = `Drive a real browser scoped to this workspace (shared live with the user's 浏览器 side panel — they see every move as a live screencast).
Actions: navigate(url) opens/starts the browser (acts on the CURRENT tab) and returns once the page has loaded and settled; back/forward/reload; read_page(filter?, query?, ref? = only that element's subtree, depth?) returns the accessibility tree with [refN] handles; click(ref | text | x,y; modifiers? "ctrl"/"shift"/…) / hover(ref | x,y); type(text, ref?/selector? to focus first); key("enter"|"ctrl+a"|…); scroll(dy?, dx? = horizontal, ref? | x,y) — scroll(ref) alone scrolls that element into view; screenshot() returns a PNG of the current viewport; eval(js) runs JS in the page and returns the value; console(lines?, query?, errors_only?) tails console/network errors; close().
resize(preset mobile|tablet|desktop | width+height; landscape?, mobile?, scheme light|dark|auto?, dpr?) REALLY changes the page's CSS viewport (innerWidth, media queries, touch events + mobile UA when mobile) in every mode and reports the measured innerWidth×innerHeight back, pixel-exact — trust that line for responsive checks instead of guessing. It may be called before navigate (the browser starts on a blank page and keeps the viewport). Flags alone keep the size (e.g. resize(scheme:"dark")); dpr is kept unless you pass it (dpr:0 = back to default); resize() with no args just reports the current viewport. Presets: mobile 375×812 / tablet 768×1024 (touch) / desktop 1280×900; custom sizes 200–4000px.
Gestures: long_press(ref | x,y; ms=hold, default 800) holds the finger/mouse down for real (touch mode: the browser's own gesture pipeline fires contextmenu and suppresses click, like a phone); drag(from ref | x,y → to_ref | to_x,to_y; ms=hold before moving) moves in small steps — touch mode sends touchmove, mouse mode handles HTML5 drag-and-drop (draggable / links / images) via real drag events; pinch(x?,y?, scale) two-finger zoom in touch mode (scale>1 spreads, <1 pinches).
Prefer ref (from read_page / find) or text over coordinates. refs reset on every navigation/tab switch/snapshot.
Whether the user can see this browser right now is reported by navigate and tabs() (desktop panel on screen / phone or web panel open / nobody). Before asking the user to do something in it themselves (sign in, solve a verification, confirm), call tabs(); if they cannot see it, first ask them to open the browser panel, and always say in your reply what you found or did there — they may not have been watching. Sign-ins persist across sessions in this browser and belong to the user: never sign out or change credentials.` + VERIFY_DESC + TAB_DESC + EXTRA_DESC;

// 参数表（Claude 的 SDK MCP 与 Codex 的 stdio MCP 共用；传入各自的 zod 实例）。
export function browserParams(z) {
  const expect = z.object({
    text: z.string().optional().describe('页面文字里应出现这段'),
    gone: z.string().optional().describe('页面文字里应不再有这段'),
    url: z.string().optional().describe('地址应包含这段'),
    selector: z.string().optional().describe('应存在且可见的 CSS selector'),
    focus: z.string().optional().describe('焦点元素的描述（角色/名字/#id）应包含这段'),
    value: z.string().optional().describe('焦点输入框的内容应包含这段'),
    changed: z.boolean().optional().describe('true=动作后页面应有变化；false=应没有变化'),
  }).describe('结果预期：等到全部满足或 expect_timeout_ms 超时，不符合就报错');
  const step = {
    url: z.string().optional().describe('navigate / tab_new 的目标地址（可省协议）'),
    ref: z.number().int().optional().describe('read_page / find 给出的 [refN] 句柄（read_page 带它 = 只看这个元素的子树；scroll 带它 = 滚到它 / 在它上面滚）'),
    text: z.string().optional().describe('type 要输入的文本；click 时=按可见文本找元素'),
    selector: z.string().optional().describe('type 前先聚焦的 CSS selector'),
    x: z.number().optional().describe('最近一张截图里的横坐标（像素）'),
    y: z.number().optional().describe('最近一张截图里的纵坐标（像素）'),
    to_x: z.number().optional().describe('drag 终点横坐标（最近一张截图的像素）'),
    to_y: z.number().optional().describe('drag 终点纵坐标（最近一张截图的像素）'),
    to_ref: z.number().int().optional().describe('drag 终点元素的 [refN]'),
    scale: z.number().optional().describe('pinch 缩放倍数（>1 放大、<1 捏合，默认 2）'),
    button: z.enum(['left', 'right']).optional(),
    modifiers: z.string().optional().describe('click：按住修饰键点，如 "ctrl"（新标签打开 / 多选）、"shift"（连选）、"ctrl+shift"'),
    value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]).optional().describe('set_value 要设的值：下拉框给选项文字或 value（多选给数组）、勾选框/单选给 true/false、日期 YYYY-MM-DD、时间 HH:MM、滑块给数字'),
    double: z.boolean().optional(),
    force: z.boolean().optional().describe('click：ref 目标被遮挡时仍然硬点'),
    key: z.string().optional().describe('key 动作的键位，如 enter / ctrl+a / shift+tab'),
    dy: z.number().optional().describe('scroll 垂直滚动量（px，正=向下）'),
    dx: z.number().optional().describe('scroll 水平滚动量（px，正=向右）——横向轮播 / 宽表格'),
    depth: z.number().int().optional().describe('read_page：只展开到第几层（配合 ref 看局部）'),
    errors_only: z.boolean().optional().describe('console：只看错误 / 异常'),
    filter: z.enum(['all', 'interactive']).optional(),
    query: z.string().optional().describe('read_page 结果按包含此串过滤；network 按 url 子串过滤；console 按消息内容过滤'),
    maxChars: z.number().int().optional(),
    js: z.string().optional().describe('eval 要执行的 JS 表达式'),
    lines: z.number().int().optional().describe('console / network 返回最近几条（默认 30）'),
    preset: z.enum(['mobile', 'tablet', 'desktop']).optional().describe('resize 档位：mobile 375×812 / tablet 768×1024 / desktop 1280×900'),
    width: z.number().int().optional().describe('resize 自定义视口宽（CSS px，200~4000）；只给 width 则高照旧'),
    height: z.number().int().optional().describe('resize 自定义视口高（CSS px，200~4000）'),
    landscape: z.boolean().optional().describe('resize：true=横屏（宽≥高）、false=竖屏，需要时把宽高对调'),
    mobile: z.boolean().optional().describe('resize：触屏设备仿真（touch 事件 + 移动端 UA + pointer:coarse）。缺省 mobile/tablet 档为 true、desktop 档 false、自定义尺寸按短边 ≤768 判'),
    scheme: z.enum(['light', 'dark', 'auto']).optional().describe('resize：仿真 prefers-color-scheme（auto=跟随系统）'),
    dpr: z.number().optional().describe('resize：deviceScaleFactor 1~3；0 = 回到缺省（桌面壳跟随显示器、无头为 1）。不给就保持当前值。截图仍按 CSS 像素出，要看高 DPR 细节用 screenshot(region)'),
    tab: z.union([z.number().int(), z.string()]).optional().describe('tabs() 里的序号（1 起）或 tab id。tab_select/tab_close 的目标；其他动作带上它 = 先把该标签切到前台再做（如 screenshot + tab:2）'),
    id: z.string().optional().describe('network 取响应体用的请求 id（network 列表里 id=…）'),
    files: z.array(z.string()).optional().describe('upload 要塞进文件输入框的本机文件绝对路径（bridge 所在电脑上的路径）'),
    region: z.array(z.number()).length(4).optional().describe('screenshot：[x, y, w, h]（按最近那张截图的像素）只放大看这一块，不改坐标基准'),
    ms: z.number().optional().describe('wait_for：单纯等待的毫秒数（≤15000）；long_press / drag：按住多久（毫秒）'),
    expect: expect.optional(),
    expect_timeout_ms: z.number().optional().describe('expect / wait_for 最多等多久，默认 3000，最多 15000'),
    verify: z.boolean().optional().describe('false=跳过落点检查与结果确认（更快，但点空了也看不出来）'),
    screenshot_after: z.boolean().optional().describe('做完（页面安定后）顺带截一张图一并返回'),
  };
  return {
    action: z.enum(BROWSER_ACTIONS),
    ...step,
    actions: z.array(z.object({ action: z.enum(BROWSER_ACTIONS.filter((a) => a !== 'batch')), ...step }))
      .max(BATCH_MAX).optional().describe(`batch：按顺序执行的动作列表（≤${BATCH_MAX} 步），遇错即停`),
  };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const text = (value) => ({ content: [{ type: 'text', text: String(value) }] });
const error = (value) => ({ ...text(value), isError: true });

// 会改变页面、可以挂 expect 的动作。
const ACTING = new Set(['navigate', 'back', 'forward', 'reload', 'click', 'type', 'key', 'scroll', 'hover', 'long_press', 'drag', 'pinch', 'eval', 'tab_new', 'tab_select', 'upload', 'set_value', 'resize']);

// "ctrl+shift" → CDP 修饰位（Alt 1 / Ctrl 2 / Meta 4 / Shift 8）；空 = 0，认不出 = null。
const MOD_BITS = { alt: 1, option: 1, ctrl: 2, control: 2, meta: 4, cmd: 4, command: 4, win: 4, shift: 8 };
function modifierBits(spec) {
  if (spec == null || String(spec).trim() === '') return 0;
  let bits = 0;
  for (const part of String(spec).toLowerCase().split(/[+\s,]+/).filter(Boolean)) {
    if (!(part in MOD_BITS)) return null;
    bits |= MOD_BITS[part];
  }
  return bits;
}

/**
 * opts（Claude 快照模式用；Codex / 远程客户端不传）：
 *  - urlDenied(url) → Promise<拒绝原因|null>：去处白名单，动作前后都验
 *  - snap：快照访客（关 eval、拒 upload）
 *  - roots：upload 允许的目录（null = 不限）
 * onActivity({action, url})：页面变化时通知前端拉起/刷新面板。
 */
export async function runBrowserAction(ws, args = {}, onActivity = null, opts = {}) {
  if (String(args?.action || '') === 'batch') {
    return runBatch(args.actions, (step) => runOne(ws, step || {}, onActivity, opts));
  }
  return runOne(ws, args || {}, onActivity, opts);
}

async function runOne(ws, args, onActivity, opts) {
  const action = String(args.action || '');
  const { urlDenied = null, snap = false, roots = null } = opts;
  const emit = (browser) => onActivity?.({ action, url: browser?.url || '' });
  const verify = args.verify !== false;
  // 快照：每次动作【之后】再验一遍当前 URL——点链接/页面自己跳转/重定向都可能把页面带到
  // 白名单外，光在 navigate 入口拦不住。越界即刻拽回 about:blank。
  const strayed = async (browser) => {
    if (!urlDenied || !browser) return null;
    const why = await urlDenied(browser.url);
    if (!why) return null;
    try { await browser.navigate('about:blank'); } catch {}
    emit(browser);
    return error(`页面跳到了不允许的地址（${why}），已退回空白页。`);
  };
  let dB = null;        // 本次动作用的浏览器实例：结果末尾补对话框回报（见 withDialogNote）
  let changedNow = null; // afterAction 的结论，给 expect.changed 用
  try {
    let browser;
    let result;
    if (action === 'navigate') {
      const target = svc.normalizeUrl(args.url);
      if (!target) return error('navigate 需要 url');
      if (urlDenied) { const why = await urlDenied(target); if (why) return error(`拒绝打开 ${target}：${why}`); }
      browser = await svc.getBrowser(ws);
      dB = browser;
      const focusErr = await focusTab(browser, action, args.tab);
      if (focusErr) return error(focusErr);
      const t0 = Date.now();
      const nav = await browser.navigate(target);
      const stray = await strayed(browser); if (stray) return stray;
      emit(browser);
      const title = await browser.title();
      const doc = [...browser.netOrder].reverse().find((e) => e.t >= t0 && e.resourceType === 'Document');
      const warn = nav.errorText ? `\n⚠ 加载失败：${nav.errorText}`
        : doc?.status >= 400 ? `\n⚠ 服务器返回 ${doc.status}` : '';
      const slow = nav.settled ? '' : '（页面还在持续变化——动画或轮询，已先返回）';
      // 以前这里恒说「用户侧浏览器面板正在直播这个页面」——面板没开也这么说，agent 就会对着没人看的页面请用户动手
      const seen = await svc.viewerReport(browser);
      result = text(`已打开 ${browser.url}${title ? `\ntitle: ${title}` : ''}\n用时 ${(nav.ms / 1000).toFixed(1)} 秒${slow}${warn}\n${seen.text}`);
    } else {
      browser = svc.existingBrowser(ws);
      let launchedNote = '';
      // 先定尺寸再开页面是最自然的顺序（以前这里直接报错，会话记录里撞过 20 次）：先起一个空白页，视口随实例保留到之后的 navigate
      if (!browser && action === 'resize') {
        browser = await svc.getBrowser(ws);
        launchedNote = '\n（浏览器原本没开，已先开空白页；接着 navigate 会沿用这个视口）';
      }
      if (!browser) {
        if (action === 'close') return text('浏览器本就没在运行');
        return error('浏览器还没启动——先 navigate 打开一个页面');
      }
      svc.touchBrowser(ws);
      dB = browser;
      const focusErr = await focusTab(browser, action, args.tab);
      if (focusErr) return error(focusErr);
      if (args.tab != null) { const stray = await strayed(browser); if (stray) return stray; }   // 切过去的标签可能早在白名单外
      const popped = watchPopups(browser, action);
      const b = browser;
      result = await (async () => { switch (action) {
        case 'back':
        case 'forward': {
          const to = await b.history(action === 'back' ? -1 : 1);
          const stray = await strayed(b); if (stray) return stray;
          emit(b);
          return text(to ? `已${action === 'back' ? '后退' : '前进'}到 ${to}` : '该方向没有历史记录');
        }
        case 'reload': {
          await b.reload();
          const stray = await strayed(b); if (stray) return stray;
          emit(b);
          return text(`已刷新 ${b.url}`);
        }
        case 'click': {
          const mods = modifierBits(args.modifiers);
          if (mods == null) return error(`modifiers 只认 ctrl / shift / alt / meta 的组合（如 "ctrl+shift"），收到「${args.modifiers}」`);
          const options = { button: args.button === 'right' ? 'right' : 'left', clickCount: args.double ? 2 : 1, modifiers: mods };
          let pt;
          let where;
          let hitBefore;
          let hitDesc;
          if (args.ref != null) {
            if (verify) {
              const p = await probeRef(b, args.ref, { force: args.force });
              pt = p; hitBefore = p.before; hitDesc = p.hit;
              where = `ref${args.ref} ${p.hit}${p.covered ? `（被 ${p.covered} 挡着，按 force 硬点了）` : ''}`;
            } else { pt = await b.refCenter(args.ref); where = `ref${args.ref}`; }
          } else if (args.text) {
            pt = await b.findTextPoint(args.text);
            where = `文字「${args.text}」`;
            if (verify) { const p = await probePoint(b, pt.x, pt.y); hitBefore = p.before; hitDesc = p.hit; where = `文字「${args.text}」→ ${p.hit}`; }
          } else if (args.x != null && args.y != null) {
            pt = b.frameToCss(Number(args.x), Number(args.y));
            where = `(${args.x}, ${args.y})`;
            if (verify) {
              const p = await probePoint(b, pt.x, pt.y);
              hitBefore = p.before; hitDesc = p.hit;
              where += ` → ${p.hit || '(无元素)'}${p.iframe ? '（落在 iframe 里，看不到里面是什么）' : p.clicky ? '' : '（不是按钮/链接等可点控件）'}`;
            }
          } else return error('click 需要 ref、text 或 x+y');
          const before = verify ? await pageState(b) : null;
          if (before) { before.hitBefore = hitBefore; before.hitDesc = hitDesc; }
          await b.dispatchClick(pt.x, pt.y, options);
          let res = '';
          if (before) {
            const r = await afterAction(b, before, 'click');
            changedNow = r.changed;
            res = `\n结果：${r.lines.join('；')}`;
          } else await delay(300);
          const note = await popped();   // 先切到页面新开的标签，下面的越界检查才验的是它
          const stray = await strayed(b); if (stray) return stray;
          emit(b);
          // 原生 <select> 的下拉层由浏览器自己画，截图里看不见、也点不中选项——别让 agent 对着「没有变化」干猜
          const selHint = /^select\b/.test(String(hitDesc || '')) ? '\n提示：这是原生下拉框，弹出的选项层截图里看不见，也没法点选——用 set_value(ref|selector, value: "选项文字或 value") 直接选。' : '';
          const modTag = mods ? `（按住 ${String(args.modifiers).toLowerCase()}）` : '';
          return text(`已点击 ${where}${modTag}${res}${note}${selHint}\n（当前 ${b.url}）`);
        }
        case 'long_press':
        case 'drag':
        case 'pinch': {
          // 起点：ref 或 x,y（pinch 缺省视口中心）；drag 终点：to_ref 或 to_x,to_y
          const at = async (ref, x, y, tag) => {
            if (ref != null) {
              const p = verify ? await probeRef(b, ref, { force: true }) : await b.refCenter(ref);
              return { pt: p, where: `ref${ref}${p.hit ? ' ' + p.hit : ''}` };
            }
            if (x != null && y != null) {
              const pt = b.frameToCss(Number(x), Number(y));
              const hit = verify ? (await probePoint(b, pt.x, pt.y)).hit : '';
              return { pt, where: `(${x}, ${y})${hit ? ' → ' + hit : ''}` };
            }
            if (tag === 'center') {
              const pt = { x: Math.floor((b.measured?.w || b.viewport.width) / 2), y: Math.floor((b.measured?.h || b.viewport.height) / 2) };
              return { pt, where: '视口中心' };
            }
            return null;
          };
          const from = await at(args.ref, args.x, args.y, action === 'pinch' ? 'center' : '');
          if (!from) return error(`${action} 需要 ref 或 x+y`);
          let to = null;
          if (action === 'drag') {
            to = await at(args.to_ref, args.to_x, args.to_y, '');
            if (!to) return error('drag 需要终点：to_ref 或 to_x+to_y');
          }
          const before = verify ? await pageState(b) : null;
          let how = '';
          if (action === 'long_press') {
            await b.longPress(from.pt.x, from.pt.y, args.ms ?? 800);
            how = `已长按 ${from.where}（${b.emu?.mobile ? '触摸' : '鼠标'}按住 ${Math.round(Number(args.ms ?? 800))}ms）`;
          } else if (action === 'drag') {
            const r = await b.drag(from.pt, to.pt, { holdMs: args.ms });
            how = `已拖动 ${from.where} → ${to.where}（${b.emu?.mobile ? '触摸滑动' : r.html5 ? 'HTML5 拖放：dragstart → drop' : '鼠标按住移动'}）`;
          } else {
            await b.pinch(from.pt.x, from.pt.y, args.scale ?? 2);
            how = `已双指${(args.scale ?? 2) >= 1 ? '张开' : '捏合'} ${from.where}（×${args.scale ?? 2}）`;
          }
          let res = '';
          if (before) {
            const r = await afterAction(b, before, 'click');
            changedNow = r.changed;
            res = `\n结果：${r.lines.join('；')}`;
          } else await delay(300);
          const note = await popped();
          const stray = await strayed(b); if (stray) return stray;
          emit(b);
          return text(`${how}${res}${note}\n（当前 ${b.url}）`);
        }
        case 'hover': {
          let pt;
          let where;
          if (args.ref != null) {
            const p = verify ? await probeRef(b, args.ref, { force: true }) : await b.refCenter(args.ref);
            pt = p; where = `ref${args.ref}${p.hit ? ' ' + p.hit : ''}${p.covered ? `（被 ${p.covered} 挡着）` : ''}`;
          } else if (args.x != null && args.y != null) {
            pt = b.frameToCss(Number(args.x), Number(args.y));
            where = `(${args.x}, ${args.y})`;
            if (verify) where += ` → ${(await probePoint(b, pt.x, pt.y)).hit || '(无元素)'}`;
          } else return error('hover 需要 ref 或 x+y');
          const before = verify ? await pageState(b) : null;
          await b.hoverCoord(pt.x, pt.y);
          if (!before) return text(`已悬停 ${where}`);
          const r = await afterAction(b, before, 'hover', { maxMs: 1200 });
          changedNow = r.changed;
          return text(`已悬停 ${where}${r.lines.length ? `\n结果：${r.lines.join('；')}` : '\n结果：页面没有变化（没有悬停菜单/提示弹出）'}`);
        }
        case 'type': {
          const s = String(args.text ?? '');
          await b.focusTarget({ ref: args.ref ?? undefined, selector: args.selector || undefined });
          if (!verify) {
            await b.send('Input.insertText', { text: s });
            const note = await popped(); if (note) { const stray = await strayed(b); if (stray) return stray; emit(b); }
            return text('已输入' + note);
          }
          const f = await focusInfo(b);
          if (f && !f.editable) {
            return error(`没有输入：焦点在 ${f.desc} 上，不是可输入的框——先 click 输入框，或给 ref / selector`);
          }
          const before = await pageState(b);
          await b.send('Input.insertText', { text: s });
          const r = await afterAction(b, before, 'type', { maxMs: 1200 });
          changedNow = true;
          const f2 = await focusInfo(b);
          let back = '';
          if (f2?.editable) {
            if (f2.password) back = `\n密码框 ${f2.desc} 现有 ${f2.value?.length ?? 0} 个字符`;
            else {
              back = `\n${f2.desc} 现在的内容：「${f2.value ?? ''}」`;
              if (s && !(f2.value || '').includes(s)) back += '\n⚠ 内容里没有刚输入的文字——可能被页面拦截、格式化或截断（maxlength）';
            }
          } else if (f2) back = `\n⚠ 输入后焦点到了 ${f2.desc}`;
          const extra = r.lines.filter((l) => !/DOM 变动|⚠ 页面没有任何变化/.test(l));
          const note = await popped();
          if (note) { const stray = await strayed(b); if (stray) return stray; emit(b); }
          return text(`已输入${back}${extra.length ? `\n另外：${extra.join('；')}` : ''}${note}`);
        }
        case 'key': {
          const before = verify ? await pageState(b) : null;
          await b.pressKey(String(args.key || ''));
          let res = '';
          if (before) {
            const r = await afterAction(b, before, 'key');
            changedNow = r.changed;
            res = `\n结果：${r.lines.join('；')}`;
          } else await delay(200);
          const note = await popped();
          const stray = await strayed(b); if (stray) return stray;
          if (note || changedNow) emit(b);
          return text(`已按键 ${args.key || ''}${res}${note}\n（当前 ${b.url}）`);
        }
        case 'scroll': {
          // ref：把元素滚进视口正中（对齐桌面端 Browser 的 scroll_to），不给 dy/dx 就只做这一步
          if (args.ref != null && args.dy == null && args.dx == null) {
            const c = await b.refCenter(args.ref);
            emit(b);
            return text(`已把 ref${args.ref} 滚进视口（中心在 CSS ${Math.round(c.x)}, ${Math.round(c.y)}）`);
          }
          const dx = Number(args.dx ?? 0);
          const dy = Number(args.dy ?? (args.dx != null ? 0 : 600));
          let pt;
          if (args.ref != null) pt = await b.refCenter(args.ref);   // 在这个元素上滚（横向轮播、内层滚动区）
          else if (args.x != null && args.y != null) pt = b.frameToCss(Number(args.x), Number(args.y));
          else pt = { x: Math.floor((b.measured?.w || b.viewport.width) / 2), y: Math.floor((b.measured?.h || b.viewport.height) / 2) };
          const what = [dy ? `纵向 ${dy}px` : '', dx ? `横向 ${dx}px` : ''].filter(Boolean).join('、') || '0px';
          const before = verify ? await pageState(b) : null;
          await b.wheel(pt.x, pt.y, dy, dx);
          if (!before) { await delay(250); return text(`已滚动 ${what}`); }
          const r = await afterAction(b, before, 'scroll', { maxMs: 1200 });
          changedNow = r.changed;
          return text(`已滚动 ${what}\n结果：${r.lines.join('；')}`);
        }
        case 'read_page': {
          // 快照下先验 URL 再读——页面可能被定时器/重定向带出白名单，
          // read_page / screenshot 正是把页面内容交到模型手里的那两个口子。
          const stray = await strayed(b); if (stray) return stray;
          let rootBackendId;
          if (args.ref != null) rootBackendId = b.refInfo(args.ref).backendId;   // 只看这个元素的子树（refs 随之重编）
          const snapshot = await b.axSnapshot({ filter: args.filter, query: args.query || undefined, maxChars: args.maxChars, rootBackendId, depth: args.depth });
          return text(`url: ${b.url}${args.ref != null ? `\n（只列 ref${args.ref} 的子树，refs 已重编）` : ''}\n${snapshot.text}`);
        }
        case 'screenshot': {
          const stray = await strayed(b); if (stray) return stray;
          return shot(b, args.region, emit);
        }
        case 'eval': {
          // 快照下关掉：任意 JS 等于把 URL 白名单一句 location.href 绕过去。
          if (snap) return error('快照里不提供 eval——需要看页面内容请用 read_page / screenshot / console。');
          const value = await b.eval(String(args.js || ''));
          let output; try { output = JSON.stringify(value, null, 1); } catch { output = String(value); }
          output = output ?? 'undefined';
          const note = await popped();
          if (note) { const stray = await strayed(b); if (stray) return stray; emit(b); }
          return text((output.length > 8000 ? output.slice(0, 8000) + '\n…(truncated)' : output) + note);
        }
        case 'console': {
          let all = b.consoleEntries();
          if (args.errors_only) all = all.filter((entry) => /error|exception|assert/i.test(String(entry.type)));
          if (args.query) { const q = String(args.query).toLowerCase(); all = all.filter((entry) => String(entry.msg).toLowerCase().includes(q)); }
          const entries = all.slice(-Math.max(1, Math.min(200, Number(args.lines) || 30)));
          const filtered = args.errors_only || args.query ? `（已按${[args.errors_only ? '只看错误' : '', args.query ? `「${args.query}」` : ''].filter(Boolean).join(' + ')}过滤）` : '';
          return text(entries.length ? entries.map((entry) => `[${entry.type}] ${entry.msg}`).join('\n') + (filtered ? `\n${filtered}` : '') : `(console 为空${filtered})`);
        }
        case 'resize': {
          let spec;
          try { spec = svc.resolveViewportSpec(args, b); } catch (e) { return error(String(e?.message || e)); }
          if (!spec) { b.measured = await b.measure(); return text(svc.describeViewport(b.viewportReport()) + launchedNote); }
          const r = await b.setViewport(spec.width, spec.height, spec); emit(b);
          return text(svc.describeViewport(r) + '\n视口变了：要按坐标操作先重新 screenshot。' + launchedNote);
        }
        case 'tabs': return text(`${await tabsList(b)}\n${(await svc.viewerReport(b)).text}`);
        case 'tab_new': {
          const target = args.url ? svc.normalizeUrl(args.url) : 'about:blank';
          if (urlDenied) { const why = await urlDenied(target); if (why) return error(`拒绝打开 ${target}：${why}`); }
          const t0 = Date.now();
          await b.newTab(target);
          if (args.url) {
            await delay(80);
            await b.settle({ since: t0, quietMs: 300, maxMs: 8000 });   // 等新页首屏，替代原来固定的 1.2 秒
          }
          const stray = await strayed(b); if (stray) return stray;
          emit(b); return text(`已新建标签并切换到它\n${await tabsList(b)}`);
        }
        case 'tab_select': {
          const tab = resolveTab(b, args.tab); if (!tab) return error(`找不到标签 ${args.tab}——先 tabs() 看当前列表`);
          await b.activateTab(tab.id);
          const stray = await strayed(b); if (stray) return stray;
          emit(b); return text(`已切到标签 ${tab.title || tab.url}\n${await tabsList(b)}`);
        }
        case 'tab_close': {
          const tab = resolveTab(b, args.tab); if (!tab) return error(`找不到标签 ${args.tab}——先 tabs() 看当前列表`);
          await b.closeTab(tab.id);
          const alive = svc.existingBrowser(ws); return text(alive ? `已关闭该标签\n${await tabsList(alive)}` : '已关闭最后一个标签，浏览器随之退出');
        }
        case 'close': svc.closeBrowser(ws); return text('浏览器已关闭');
        case 'wait_for': {
          if (hasExpect(args.expect)) {
            const t0 = Date.now();
            const miss = await waitExpect(b, args.expect, { timeoutMs: args.expect_timeout_ms });
            if (miss) return error(`等到超时，条件仍不满足：${miss.join('；')}`);
            return text(`条件已满足（等了 ${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
          }
          if (args.ms != null) {
            const ms = Math.max(0, Math.min(15_000, Number(args.ms) || 0));
            await delay(ms);
            return text(`已等待 ${ms}ms`);
          }
          return error('wait_for 需要 expect（如 {text:"保存成功"}）或 ms');
        }
        case 'find':
        case 'network':
        case 'upload':
        case 'set_value':
        case 'page_text': {
          // find/network 都把页面内容交给模型：快照下先验 URL（同 read_page）。
          const stray = await strayed(b); if (stray) return stray;
          const r = await runExtraAction(b, action, args, { roots, snap });
          return r || error(`未知 action: ${action}`);
        }
        default: return error(`未知 action: ${action}`);
      } })();
    }

    // —— 通用收尾：expect → screenshot_after → 多标签角标 ——
    const live = svc.existingBrowser(ws);
    if (!result.isError && live && ACTING.has(action) && hasExpect(args.expect)) {
      const miss = await waitExpect(live, args.expect, { timeoutMs: args.expect_timeout_ms, changedNow });
      const last = [...result.content].reverse().find((c) => c.type === 'text');
      if (miss) {
        result.isError = true;
        if (last) last.text += `\n✗ 预期不符合：${miss.join('；')}`;
      } else if (last) {
        // 预期满足了，动作后「一时没变化」的警告就是过时结论，别留着误导
        last.text = last.text.replace(/⚠ 页面没有任何变化[^\n]*/, '动作后一时没有变化，随后预期满足') + '\n✓ 预期已满足';
      }
    }
    if (!result.isError && args.screenshot_after && action !== 'screenshot' && live) {
      const stray = await strayed(live); if (stray) return stray;
      const s = await shot(live, null, emit);
      result.content.push(...s.content);
    }
    // 多标签时结果尾巴补 [tab i/N]：agent 永远知道自己刚看/刚点的是哪一页
    const tag = tabTag(live);
    if (tag && !result.isError && !/^tab/.test(action)) {
      const last = [...result.content].reverse().find((c) => c.type === 'text');
      if (last) last.text += tag;
    }
    return withDialogNote(result, dB);
  } catch (e) {
    return withDialogNote(error(`浏览器操作失败：${String(e?.message || e)}`), dB);
  }
}

// 截图结果：整屏图会成为新的坐标基准；region 是只读放大。
async function shot(b, region, emit) {
  const r = await b.screenshot(region ? { region } : {});
  emit?.(b);
  let caption;
  if (r.zoom) {
    caption = `放大图 ${r.zoom.width}×${r.zoom.height}：页面区域 CSS (${r.zoom.css.join(', ')})。只供看清细节，坐标仍按之前那张整屏截图给。`;
  } else {
    const f = r.frame;
    const scaled = Math.abs(f.k - 1) > 0.001;
    caption = `url: ${b.url} · ${svc.viewportLine(b)} · 截图 ${f.imgW}×${f.imgH}${scaled ? `（页面按 ${(1 / f.k).toFixed(3)} 倍缩放；x,y 照这张图给，工具会换算）` : '（与 CSS 像素 1:1）'}`;
  }
  return { content: [{ type: 'image', data: r.buf.toString('base64'), mimeType: 'image/png' }, { type: 'text', text: caption }] };
}
