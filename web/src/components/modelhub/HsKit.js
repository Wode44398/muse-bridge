// HubService（模型中心服务浮层）各块共用的小件：线稿、地址 / 数字 / 时间的格式化、横滑条两端渐隐，
// 以及不依赖组件状态的纯逻辑（去向改动的计算、Claude 收不收某个模型、粘贴 Key 的清洗、连接改动的判断）——后者有单测 HsKit.test.js。
// 线稿与设置页 SI 同一家族（24 网格、1.6 描边、圆头圆角、currentColor），只在这个浮层里用，所以不进 settingsIcons.js。
import { t, locale } from '../../lib/i18n.js';
import { providerOf } from '../../../../src/model-knowledge/brands.mjs';

export const G = {
  back: '<path d="M14.5 5.5 8 12l6.5 6.5"/>',
  close: '<path d="M6.5 6.5l11 11M17.5 6.5l-11 11"/>',
  // 齿轮：与 Media Studio 的齿轮同形（同一套设置语言）
  gear: '<path d="M12.22 2.75h-.44a1.9 1.9 0 0 0-1.9 1.9v.17a1.9 1.9 0 0 1-.95 1.64l-.41.24a1.9 1.9 0 0 1-1.9 0l-.14-.08a1.9 1.9 0 0 0-2.6.7l-.21.36a1.9 1.9 0 0 0 .7 2.6l.14.09a1.9 1.9 0 0 1 .95 1.63v.49a1.9 1.9 0 0 1-.95 1.65l-.14.08a1.9 1.9 0 0 0-.7 2.6l.21.36a1.9 1.9 0 0 0 2.6.7l.14-.08a1.9 1.9 0 0 1 1.9 0l.41.24a1.9 1.9 0 0 1 .95 1.64v.17a1.9 1.9 0 0 0 1.9 1.9h.44a1.9 1.9 0 0 0 1.9-1.9v-.17a1.9 1.9 0 0 1 .95-1.64l.41-.24a1.9 1.9 0 0 1 1.9 0l.14.08a1.9 1.9 0 0 0 2.6-.7l.21-.37a1.9 1.9 0 0 0-.7-2.6l-.14-.08a1.9 1.9 0 0 1-.95-1.65v-.48a1.9 1.9 0 0 1 .95-1.65l.14-.08a1.9 1.9 0 0 0 .7-2.6l-.21-.36a1.9 1.9 0 0 0-2.6-.7l-.14.08a1.9 1.9 0 0 1-1.9 0l-.41-.24a1.9 1.9 0 0 1-.95-1.64v-.17a1.9 1.9 0 0 0-1.9-1.9z"/><circle cx="12" cy="12" r="2.8"/>',
  search: '<circle cx="11" cy="11" r="6.2"/><path d="m15.6 15.6 4 4"/>',
  // 输入框里的小叉（清空搜索）
  clear: '<path d="M8.5 8.5l7 7M15.5 8.5l-7 7"/>',
  // 地址框左侧的品牌位：还没填 = 链接，填了但认不出 = 地球（同 SI.connect）
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  globe: '<circle cx="12" cy="12" r="8"/><path d="M4 12h16"/><path d="M12 4c2.3 2.2 3.4 4.9 3.4 8s-1.1 5.8-3.4 8c-2.3-2.2-3.4-4.9-3.4-8s1.1-5.8 3.4-8z"/>',
  eye: '<path d="M2.8 12S6.2 5.8 12 5.8 21.2 12 21.2 12 17.8 18.2 12 18.2 2.8 12 2.8 12z"/><circle cx="12" cy="12" r="2.8"/>',
  eyeOff: '<path d="M4 4l16 16"/><path d="M10.2 6a9.6 9.6 0 0 1 1.8-.2c5.8 0 9.2 6.2 9.2 6.2a16.4 16.4 0 0 1-2.5 3.2M6.6 7.2C4.1 8.9 2.8 12 2.8 12s3.4 6.2 9.2 6.2c1.5 0 2.8-.4 4-1"/><path d="M9.9 10a2.8 2.8 0 0 0 4.1 3.9"/>',
  plus: '<path d="M12 5.5v13M5.5 12h13"/>',
  trash: '<path d="M5 7h14M10 4h4"/><path d="M7 7l.8 11.2a2 2 0 0 0 2 1.8h4.4a2 2 0 0 0 2-1.8L17 7"/>',
  refresh: '<path d="M19 12a7 7 0 1 1-2.05-4.95"/><path d="M19.2 4.6v3.6h-3.6"/>',
  chev: '<path d="m8 10 4 4 4-4"/>',
  // 调节（高级调用配置）：三道横线各带一个旋钮
  tune: '<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="17" r="2"/>',
};

/** 线稿 → 完整 svg 字符串（尺寸由外层 CSS 定） */
export const svg = (g, w = 1.6) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${g}</svg>`;

// 勾选框里的对勾 / 半选横杠（16 网格；描线动画靠 stroke-dasharray，路径长度都在 12 以内）
export const CHECK = '<svg viewBox="0 0 16 16" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="ck" d="M4 8.3l2.7 2.7L12 5.6"/><path class="dash" d="M4.6 8h6.8"/></svg>';

/** 给 Claude 的模型 id 须合这个格式（服务端同一条校验：src/runtime/claude-providers.mjs 的 MODEL_ID_RE） */
export const CLAUDE_ID = /^[\w.:/@+-]{1,200}$/;
/** Claude 自定义模型的上下文窗口下限（claude-providers.mjs 的 normalizeModel：int(…, 4096, 4_000_000)）；更小的它会悄悄跳过 */
export const CLAUDE_MIN_CTX = 4096;
/**
 * Claude 收不收这个模型：'' 收；'id' = 模型 ID 里有它不认的字符；'ctx' = 上下文窗口不到 4096。
 * 没报上下文窗口的（0 / 空）不拦——Claude 那边按默认窗口算。
 */
export function claudeBlock(id, ctx) {
  if (!CLAUDE_ID.test(String(id ?? ''))) return 'id';
  const n = Number(ctx);
  return n > 0 && n < CLAUDE_MIN_CTX ? 'ctx' : '';
}

/** 去向的固定顺序（叠放图标、提交的 agents 都按它排） */
export const AGENT_ORDER = ['claude', 'dimensio', 'studio'];
/** 去重并按固定顺序排好的去向 */
export const ordAgents = (a) => AGENT_ORDER.filter((x) => Array.isArray(a) && a.includes(x));

/**
 * 勾中的行 + 点亮的去向片 → 要提交的改动。
 *   rows      勾中的行：{ id, agents（现在的去向） }
 *   destIds   这一栏的去向片（文本栏 claude / dimensio，媒体栏 studio）
 *   chosen    点亮的片
 *   consistent 勾中的行现在的去向一致：这一栏的去向改成 chosen（取消点亮 = 批量取消添加）；不一致：只把点亮的加上去，不动别的
 *   blockOf(agent, row) 这一行加不进这个去向的原因（'' = 能加）
 * 加不进去的那一行跳过这个去向、别的去向照加（整批不会因为一行被服务端拒掉）；这一行已经在这个去向里的不动（留给用户自己取消）。
 * 返回 { changes: [{ id, agents }], skipped: { <去向>: { n, why } } }——skipped 给操作条写一行提示用。
 */
export function planAssign(rows, destIds, chosen, consistent, blockOf) {
  const changes = [], skipped = {};
  for (const r of rows || []) {
    const cur = Array.isArray(r.agents) ? r.agents : [];
    const add = [];
    for (const a of chosen || []) {
      const why = cur.includes(a) ? '' : blockOf?.(a, r) || '';
      if (!why) add.push(a);
      else (skipped[a] ||= { n: 0, why }).n++;
    }
    const next = ordAgents(consistent ? [...cur.filter((a) => !destIds.includes(a)), ...add] : [...cur, ...add]);
    if (!sameSet(next, cur)) changes.push({ id: r.id, agents: next });
  }
  return { changes, skipped };
}

/** 一栏的行按快照置顶：pin 里的排最前（打开 / 换栏 / 重新识别那一刻已添加的），tail(row) 为真的垫底，其余原序。都没有就原样返回。 */
export function pinFirst(list, pin, tail) {
  const top = [], mid = [], end = [];
  for (const r of list) (pin && pin.has(r.id) ? top : tail && tail(r) ? end : mid).push(r);
  return top.length || end.length ? [...top, ...mid, ...end] : list;
}

// 本机 / 局域网：不要 Key、默认不走出站代理（与 brands.mjs 的 LOOPBACK 同一组规则）
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[?::1\]?|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[\w.-]+\.local|host\.docker\.internal)$/i;
const LOCAL_PROVIDERS = new Set(['ollama', 'lmstudio', 'vllm', 'xinference']);

/** 补上 scheme、去掉末尾斜杠；本机地址补 http://，其余补 https://（大家复制来的地址常常不带 scheme） */
export function normUrl(s) {
  let u = String(s || '').trim();
  if (!u) return '';
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(u)) {
    const host = u.split(/[/?#]/)[0].replace(/:\d+$/, '');
    u = (LOCAL_HOST.test(host) ? 'http://' : 'https://') + u;
  }
  return u.replace(/\/+$/, '');
}

function parse(s) {
  try {
    const u = new URL(normUrl(s));
    return /^https?:$/.test(u.protocol) && u.hostname ? u : null;
  } catch { return null; }
}

/** 地址能不能用：http(s)、有主机名、没有空白 */
export const urlOk = (s) => !/\s/.test(String(s || '').trim()) && !!parse(s);
/** 主机名（带端口）；解析不了给 '' */
export const hostOf = (s) => parse(s)?.host || '';
/** 本机 / 局域网的服务（ollama、LM Studio、vLLM……）：Key 可以留空 */
export function isLocal(s) {
  const u = parse(s);
  if (!u) return false;
  if (LOCAL_HOST.test(u.hostname)) return true;
  return LOCAL_PROVIDERS.has(providerOf(u.href)?.key || '');
}

/** Key 尾号：'…a1b2'；太短的只给 '…'（不把整把 Key 露出来） */
export const keyTail = (k) => {
  const s = String(k || '').trim();
  return s ? (s.length > 8 ? '…' + s.slice(-4) : '…') : '';
};
/** 服务端给的 keyTail 已带 '…'，老数据可能没带 */
export const tailText = (s) => (!s ? '' : s.startsWith('…') ? s : '…' + s);

// Key 里不该有的字符：一切空白（含不间断空格、全角空格、行 / 段分隔符）、控制字符、零宽字符。
// 从网页、表格、折行的文档里复制常带进来；夹在中间的换行会让请求头不合法，报错里还会带出 Key。
const KEY_JUNK = /[\s\u0000-\u001f\u007f-\u009f​-‍⁠﻿]+/g;
/** 去掉 Key 里全部空白与控制字符（不只是首尾） */
export const cleanKey = (s) => String(s ?? '').replace(KEY_JUNK, '');
/**
 * 往 Key 框里粘贴：把剪贴板的字插到选区 [start, end) 处，整串去掉空白 / 控制字符。
 * 返回 { value, caret }——value 既写进状态也写回输入框（两边必须一致），caret 是粘贴内容之后的光标位置。
 */
export function pasteKey(cur, start, end, text) {
  const v = String(cur ?? '');
  const a = Math.max(0, Math.min(v.length, start ?? v.length));
  const b = Math.max(a, Math.min(v.length, end ?? v.length));
  const head = cleanKey(v.slice(0, a)), mid = cleanKey(text);
  return { value: head + mid + cleanKey(v.slice(b)), caret: head.length + mid.length };
}

/**
 * 已有服务保存连接时，「识别」要用的那一段变没变：'url' 地址变了；'key' 换了 Key、或识别用的那条线路换了一条；'' 没变。
 * 识别读的是存着的地址与「第一条启用且有 Key 的线路」（服务端 studio-link.mjs 的 mediaLine）。
 *   ed  面板里的编辑态 { baseUrl, lines: [{ id, enabled, hasKey, key（新填的） }] }
 *   svc 服务视图 { baseUrl, lines: [{ id, enabled, hasKey }] }
 */
export function connMoved(ed, svc) {
  if (!ed || !svc) return '';
  if (normUrl(ed.baseUrl) !== normUrl(svc.baseUrl)) return 'url';
  const typed = (l) => !!String(l.key || '').trim();
  const ls = (ed.lines || []).filter((l) => l.id || typed(l));
  if (ls.some(typed)) return 'key';
  const used = (lines) => {
    const on = (lines || []).filter((l) => l.enabled !== false);
    return (on.find((l) => l.hasKey) || on[0])?.id || '';
  };
  return used(ls) !== used(svc.lines) ? 'key' : '';
}

/** 上下文窗口：131072 → 128K、200000 → 200K、1048576 → 1M（能被 1024 整除按 1024 算，否则按 1000） */
export function fmtCtx(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n <= 0) return '';
  const fmt = (v, u) => (Math.round(v * 10) / 10).toString().replace(/\.0$/, '') + u;
  if (n >= 1e6) return fmt(n % 1048576 === 0 ? n / 1048576 : n / 1e6, 'M');
  if (n >= 1000) return fmt(n % 1024 === 0 ? n / 1024 : n / 1000, 'K');
  return String(n);
}

/** 缓存时长（分钟）→「5 分钟 / 1 小时 / 2 小时 / 1 天」；null / 0 → '' */
export function fmtCacheMin(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n >= 1440 && n % 1440 === 0) return t('{n} 天', { n: n / 1440, count: n / 1440 });
  if (n >= 60 && n % 60 === 0) return t('{n} 小时', { n: n / 60 });
  return t('{n} 分钟', { n });
}

/** 「刚刚 / n 分钟前 / n 小时前 / 11月3日」 */
export function ago(ts, now = Date.now()) {
  const v = typeof ts === 'number' ? ts : Date.parse(ts);
  if (!Number.isFinite(v) || v <= 0) return '';
  const s = Math.max(0, (now - v) / 1000);
  if (s < 60) return t('刚刚');
  if (s < 3600) return t('{n} 分钟前', { n: Math.floor(s / 60) });
  if (s < 86400) return t('{n} 小时前', { n: Math.floor(s / 3600) });
  try { return new Date(v).toLocaleDateString(locale(), { month: 'short', day: 'numeric' }); } catch { return ''; }
}

/** 两个去向集合是否相同（顺序无关） */
export const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * 横滑条两端渐隐（Svelte action）：只在那一侧还有内容时才渐隐，滚到头那一侧变实。
 * 给元素写 --fl / --fr，CSS 侧：mask-image: linear-gradient(to right, transparent, #000 var(--fl), #000 calc(100% - var(--fr)), transparent)
 */
export function edgeFade(node) {
  let raf = 0;
  const upd = () => {
    raf = 0;
    const max = node.scrollWidth - node.clientWidth;
    const x = Math.abs(node.scrollLeft);
    node.style.setProperty('--fl', x > 2 ? '20px' : '0px');
    node.style.setProperty('--fr', x < max - 2 ? '20px' : '0px');
  };
  const on = () => { if (!raf) raf = requestAnimationFrame(upd); };
  node.addEventListener('scroll', on, { passive: true });
  const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(on) : null;
  ro?.observe(node);
  // 内容变了（换种类、厂商列表重算）容器尺寸可能不变，ResizeObserver 不报：再盯一下子节点
  const mo = typeof MutationObserver !== 'undefined' ? new MutationObserver(on) : null;
  mo?.observe(node, { childList: true, subtree: true });
  upd();
  return { destroy() { cancelAnimationFrame(raf); node.removeEventListener('scroll', on); ro?.disconnect(); mo?.disconnect(); } };
}

// —— 高级调用配置（HsModelAdv，2026-11-15）：服务视图里的一条模型 ↔ 编辑草稿 ↔ 提交体（POST /model/advanced）——
// 草稿里空串 / 'auto' = 自动；提交体里 over / params 一个键都没有就给 null（服务端据此删掉这一块 = 恢复自动）。
/** 提示缓存时长的几档（分钟）：行上的菜单与高级设置共用 */
export const CACHE_STEPS = [5, 10, 30, 60, 120, 1440];
const tierCopy = (list) => (Array.isArray(list) ? list.map((x) => ({ id: x.id, name: x.name || x.id, value: x.value ?? null })) : []);
/** 服务视图的一条模型（带 auto / over / params / cacheTtl）→ 编辑草稿 */
export function advDraft(m) {
  const o = (m && m.over) || {}, a = (m && m.auto) || {}, p = (m && m.params) || {};
  const custom = !!o.think || typeof o.alwaysThinks === 'boolean';
  // 自定义思考写法的起点：用户存过的；没有就从自动的那份抄一份来改
  const src = o.think || (a.thinking && a.thinking !== 'none' ? a : null);
  return {
    ctx: Number.isFinite(o.contextWindow) ? o.contextWindow : '',
    out: Number.isFinite(o.maxOutput) ? o.maxOutput : '',
    vision: typeof o.vision === 'boolean' ? (o.vision ? 'yes' : 'no') : 'auto',
    cache: Number.isFinite(m && m.cacheTtl) ? String(m.cacheTtl) : 'auto',
    thinkMode: custom ? 'custom' : 'auto',
    think: {
      thinking: (src && src.thinking) || 'none', efforts: tierCopy(src && src.efforts),
      effortField: (src && src.effortField) || '', effortDefault: (src && src.effortDefault) || '',
      alwaysThinks: typeof o.alwaysThinks === 'boolean' ? o.alwaysThinks : !!a.alwaysThinks, source: {},
    },
    params: {
      maxTokens: p.maxTokens ?? null, temperature: p.temperature ?? null, topP: p.topP ?? null, topK: p.topK ?? null,
      thinking: p.thinking || 'auto', thinkingBudget: p.thinkingBudget ?? null, stop: [...(p.stop || [])], extraBody: p.extraBody || '',
    },
  };
}
/** 编辑草稿 → 提交体 { over, params, cacheTtl }（null = 恢复自动） */
export function advPayload(d) {
  const over = {};
  if (d.ctx !== '' && d.ctx !== null && d.ctx !== undefined) over.contextWindow = Number(d.ctx);
  if (d.out !== '' && d.out !== null && d.out !== undefined) over.maxOutput = Number(d.out);
  if (d.vision === 'yes' || d.vision === 'no') over.vision = d.vision === 'yes';
  if (d.thinkMode === 'custom') {
    const th = d.think;
    over.think = th.thinking === 'none'
      ? { thinking: 'none' }
      : { thinking: th.thinking, efforts: tierCopy(th.efforts), effortField: th.thinking === 'effort' ? (th.effortField || '').trim() : '', effortDefault: th.effortDefault || '' };
    over.alwaysThinks = !!th.alwaysThinks;
  }
  const p = d.params || {}, params = {};
  for (const k of ['maxTokens', 'temperature', 'topP', 'topK', 'thinkingBudget']) if (p[k] !== null && p[k] !== undefined && p[k] !== '') params[k] = p[k];
  if (p.thinking === 'on' || p.thinking === 'off') params.thinking = p.thinking;
  if (Array.isArray(p.stop) && p.stop.length) params.stop = [...p.stop];
  if (String(p.extraBody || '').trim()) params.extraBody = String(p.extraBody).trim();
  return {
    over: Object.keys(over).length ? over : null,
    params: Object.keys(params).length ? params : null,
    cacheTtl: d.cache === 'auto' || d.cache === '' || d.cache === undefined ? null : Number(d.cache),
  };
}
const intOk = (v, lo, hi) => Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi;
/** 草稿的毛病（拦保存；服务端同规则再查一遍）→ 人话，没毛病 ''。tierProblem：ThinkingTiers 导出的档位表检查 */
export function advProblem(d, { toClaude = false, tierProblem = null } = {}) {
  const has = (v) => v !== '' && v !== null && v !== undefined;
  if (has(d.ctx) && !intOk(d.ctx, 1024, 4_000_000)) return t('上下文窗口要是 1024–4000000 之间的整数');
  if (has(d.ctx) && toClaude && Number(d.ctx) < CLAUDE_MIN_CTX) return t('上下文窗口不到 4096，Claude 用不了');
  if (has(d.out) && !intOk(d.out, 256, 1_000_000)) return t('输出上限要是 256–1000000 之间的整数');
  if (has(d.ctx) && has(d.out) && Number(d.out) > Number(d.ctx)) return t('输出上限不能大于上下文窗口');
  if (d.thinkMode === 'custom') {
    if (d.think.thinking !== 'none' && !(d.think.efforts || []).length) return t('至少要有一个档位（不想发思考参数就选「不思考」）');
    const tp = tierProblem ? tierProblem(d.think) : '';
    if (tp) return tp;
  }
  const p = d.params || {};
  if (has(p.maxTokens) && !intOk(p.maxTokens, 1, 1_000_000)) return t('最大输出要是 1–1000000 之间的整数');
  if (has(p.topK) && !intOk(p.topK, 1, 1000)) return t('top_k 要是 1–1000 之间的整数');
  if (has(p.thinkingBudget) && !intOk(p.thinkingBudget, 1024, 200_000)) return t('思考预算要是 1024–200000 之间的整数');
  const x = String(p.extraBody || '').trim();
  if (x) {
    try { const o = JSON.parse(x); if (!o || typeof o !== 'object' || Array.isArray(o)) return t('额外请求体要是 JSON 对象（{…}）'); }
    catch { return t('额外请求体不是合法 JSON'); }
  }
  return '';
}

// —— 服务的高级设置（HsServiceAdv）：服务视图 ↔ 草稿 ↔ POST /update 的 patch ——
const COMPAT_KEYS = ['promptCaching', 'stripBetas', 'slimBody', 'stripThinkingHistory', 'replayReasoning'];
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const RESERVED_HEADER = /^(authorization|x-api-key|x-goog-api-key|host|content-length)$/i;
/** 服务视图 → 草稿：兼容项 'auto' | 'on' | 'off'；空串 = 自动 / 默认 */
export function svcAdvDraft(s) {
  const c = (s && s.compat) || {};
  return {
    compat: Object.fromEntries(COMPAT_KEYS.map((k) => [k, typeof c[k] === 'boolean' ? (c[k] ? 'on' : 'off') : 'auto'])),
    field: c.maxTokensField === 'max_tokens' || c.maxTokensField === 'max_completion_tokens' ? c.maxTokensField : 'auto',
    timeout: Number.isFinite(s && s.timeoutSec) && s.timeoutSec !== 600 ? s.timeoutSec : '',
    retries: Number.isInteger(s && s.retries) ? s.retries : '',
    authStyle: (s && s.authStyle) || 'bearer',
    headers: ((s && s.headers) || []).map((h) => ({ name: h.name, value: h.value })),
  };
}
/** 草稿 → patch（compat / retries 给 null = 恢复自动；超时留空 = 600 秒） */
export function svcAdvPayload(d) {
  const compat = {};
  for (const k of COMPAT_KEYS) if (d.compat[k] === 'on' || d.compat[k] === 'off') compat[k] = d.compat[k] === 'on';
  if (d.field !== 'auto') compat.maxTokensField = d.field;
  return {
    compat: Object.keys(compat).length ? compat : null,
    retries: d.retries === '' || d.retries === null || d.retries === undefined ? null : Number(d.retries),
    timeoutSec: d.timeout === '' || d.timeout === null || d.timeout === undefined ? 600 : Number(d.timeout),
    authStyle: d.authStyle,
    // 名字和值都空的行当没填
    headers: d.headers.filter((h) => h.name.trim() || h.value.trim()).map((h) => ({ name: h.name.trim(), value: h.value })),
  };
}
/** 草稿的毛病 → 人话，没毛病 '' */
export function svcAdvProblem(d) {
  const has = (v) => v !== '' && v !== null && v !== undefined;
  if (has(d.timeout) && !intOk(d.timeout, 10, 1800)) return t('超时要是 10–1800 秒之间的整数');
  if (has(d.retries) && !intOk(d.retries, 0, 5)) return t('失败重试要是 0–5 之间的整数');
  const seen = new Set();
  for (const h of d.headers) {
    const name = h.name.trim();
    if (!name && !h.value.trim()) continue;
    if (!HEADER_NAME.test(name)) return t('请求头名「{name}」不合法', { name: name.slice(0, 40) });
    if (RESERVED_HEADER.test(name)) return t('请求头「{name}」由 bridge 自己管，不能自定义', { name });
    if (seen.has(name.toLowerCase())) return t('请求头「{name}」重复了', { name });
    seen.add(name.toLowerCase());
  }
  return '';
}
