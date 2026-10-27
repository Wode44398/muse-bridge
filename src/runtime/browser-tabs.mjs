// 浏览器多标签的共用小件：Claude 的 SDK MCP（mcp/browser-tools.mjs）与 Codex 的
// loopback（runtime/browser-actions.mjs）两套 action switch 都用这一份。
//
// 解决三件 agent「用不明白多标签」的事（2026-09-30 实测）：
// - 页面自己开的标签（target=_blank / window.open）以前悄无声息——click 回「当前 /a」、
//   截图还是旧页，agent 只会以为没点中。现在切过去并在结果里明说（像真浏览器一样）。
//   桌面壳模式下壳把 _blank 改成当前标签打开，不会走到这里。
// - tabs() 标题以前常是 host/path（headless 不报标题变化），列前先按 /json/list 对一遍。
// - 任何动作都可带 tab：screenshot(tab:2) 一步看第 2 个标签，不用先 tab_select。

export const TAB_DESC = `
Multi-tab: tabs() lists open tabs (index + title + url, ▶ = foreground); tab_new(url?) opens a tab and switches to it; tab_select(tab) / tab_close(tab) take an index from tabs() or a tab id. ANY other action also accepts tab: it first brings that tab to the foreground, e.g. screenshot(tab:2) / read_page(tab:1) — so comparing pages is one call per look. Without tab, actions hit the foreground tab. If a click/key/eval makes the page open a new tab (target=_blank, window.open), the tool switches to it and says so; the opener stays in its old slot. When more than one tab is open, results end with [tab i/N] so you always know which page you are looking at. 对照类任务（如克隆网页）：tab 1 挂原站、tab 2 挂你的版本，screenshot(tab:1) / screenshot(tab:2) 轮流看着改。Closing the last tab shuts the browser.`;

const TAB_OPS = new Set(['tabs', 'tab_new', 'tab_select', 'tab_close', 'close']);
// 这些动作可能让页面开新标签（用户手势触发的 window.open / _blank 链接 / 表单 target）。
const MAY_POPUP = new Set(['click', 'key', 'type', 'eval']);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function tabsList(b) {
  await b.refreshTabs?.();
  if (!b.tabs.length) return '(没有打开的标签)';
  return b.tabs.map((t, i) => `${i + 1}. ${t.active ? '▶ ' : ''}${t.title || '(无标题)'} — ${t.url}`).join('\n');
}

// tab 参数解析：1 起的序号（tabs() 列表顺序）或 tab id 字符串。
export function resolveTab(b, spec) {
  if (spec == null || spec === '') return null;
  if (typeof spec === 'number') return b.tabs[spec - 1] || null;
  const s = String(spec).trim();
  if (/^\d{1,3}$/.test(s)) return b.tabs[Number(s) - 1] || null;
  return b.tabs.find((t) => t.id === s) || null;
}

// 结果尾巴：只有一个标签时不出，免得噪音。
export function tabTag(b) {
  if (!b || b.tabs.length < 2) return '';
  const i = b.tabs.findIndex((t) => t.active);
  return i < 0 ? '' : ` [tab ${i + 1}/${b.tabs.length}]`;
}

// 非标签管理动作带了 tab：先切到前台。返回错误文本或 null。
export async function focusTab(b, action, spec) {
  if (spec == null || spec === '' || TAB_OPS.has(action)) return null;
  const t = resolveTab(b, spec);
  if (!t) return `找不到标签 ${spec}——先 tabs() 看当前列表`;
  if (!t.active) await b.activateTab(t.id);
  return null;
}

// 动作前拍一张标签 id 快照，动作后调返回的函数：页面若新开了标签就切过去，
// 返回给 agent 的说明（没开则空串）。
export function watchPopups(b, action) {
  if (!MAY_POPUP.has(action)) return async () => '';
  const before = new Set(b.tabs.map((t) => t.id));
  const opener = b.tabs.findIndex((t) => t.active) + 1;
  return async () => {
    let fresh = b.tabs.filter((t) => !before.has(t.id));
    if (!fresh.length) {
      // Target.targetCreated 可能比动作返回晚一拍到
      await delay(120);
      fresh = b.tabs.filter((t) => !before.has(t.id));
      if (!fresh.length) return '';
    }
    const t = fresh[fresh.length - 1];
    await b.activateTab(t.id);
    for (let i = 0; i < 15; i++) {   // 给新页首屏最多 1.5s，之后的截图不至于是白板
      const st = await b.eval('document.readyState').catch(() => '');
      if (st === 'complete' || st === 'interactive') break;
      await delay(100);
    }
    await b.refreshTabs?.();
    const idx = b.tabs.findIndex((x) => x.id === t.id) + 1;
    const cur = b.tabs[idx - 1] || t;
    const more = fresh.length > 1 ? `（共新开 ${fresh.length} 个，其余见 tabs()）` : '';
    return `\n页面新开了一个标签${more}，已切到它：标签 ${idx} ${cur.title || '(无标题)'} — ${cur.url}` +
      (opener > 0 ? `\n原页面还在标签 ${opener}，要回去用 tab_select(${opener})，或直接给动作带 tab:${opener}。` : '');
  };
}
