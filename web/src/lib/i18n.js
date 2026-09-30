// 界面语言：简体中文（默认）/ English。
//
// 用法（gettext 式——中文原文就是键）：
//   t('新建对话')                     中文原样返回；英文查 src/i18n/en/*.js 里的同名键
//   t('已选 {n} 项', { n })           {名字} 占位；英文值可写 { one: '{n} item', other: '{n} items' } 按 n 取单复数
//   tc('开关', '关闭')                同一句中文在不同语境要不同英文时加语境：字典键写 '开关::关闭'
//   tr(serverMsg)                     运行时文案（服务端报错、能力表标签…）：先精确匹配，再按带 {占位} 的键做模式匹配；都不中原样返回
//
// 语言在启动时定死：入口（main.js / quick.js / solo.js）先 await initI18n() 拿到字典，再加载业务模块——
// 所以模块顶层常量里调 t() 也安全。切换语言 = 写偏好 + 整页重载（setLang），不做热切换。
// 默认简体中文、不跟随系统：系统界面是英文的电脑很常见，跟随系统会让界面突然变英文。
//
// 字典存在 globalThis 上：dimensio（harness/web，经 @hx 编进本包）的 lib/i18n.ts 读同一份，两边 t() 结果一致。
// 字典键冲突、漏译、占位符不一致由 web/scripts/i18n-check.mjs 查（本文件自身 i18n-ignore-file）。

const KEY = 'bridge-lang';
export const LANGS = [
  { value: 'zh', label: '简体中文' },   // i18n-ignore 语言名永远用本族语写
  { value: 'en', label: 'English' },
];

const G = (globalThis.__bridgeI18n ??= { lang: 'zh', dict: Object.create(null), pats: null });

// 存下来的偏好（没存过 = null）。原生壳只同步这个，不同步 ?lang= 临时覆盖。
function storedPref() {
  try { const v = localStorage.getItem(KEY); return v === 'en' || v === 'zh' ? v : null; } catch { return null; }
}

// 没存过偏好时跟浏览器走：浏览器语言列表里有中文就用中文，一个都没有就用英文
// （与服务端分享密码页 share-gate 的 pageLang 同一规则）。Muse Bridge 是给所有 Muse 用户的公开产品，
// 不能像自用的 bridge 那样默认中文——英文用户装完打开第一眼就是一屏中文。
function browserDefault() {
  try {
    const langs = navigator.languages?.length ? navigator.languages : [navigator.language || ''];
    return langs.some((l) => /^zh/i.test(l)) ? 'zh' : 'en';
  } catch { return 'zh'; }
}

export function langPref() {
  try {
    const q = new URLSearchParams(location.search).get('lang');   // 调试/截图：?lang=en 临时覆盖
    if (q === 'zh' || q === 'en') return q;
  } catch {}
  return storedPref() || browserDefault();
}

/** 当前界面语言：'zh' | 'en'（启动后不变） */
export const lang = () => G.lang;
export const isEn = () => G.lang === 'en';
/** 给 Intl / toLocaleString 用的 BCP 47 标签 */
export const locale = () => (G.lang === 'en' ? 'en-US' : 'zh-CN');

/** 入口在挂载任何业务模块之前调一次。英文时并行拉 bridge 与 dimensio 两份字典。 */
export async function initI18n() {
  G.lang = langPref();
  try { document.documentElement.lang = G.lang === 'en' ? 'en' : 'zh-CN'; } catch {}
  if (G.lang === 'en') {
    const mods = await Promise.all([
      import('../i18n/en/index.js'),
      import('@hx/i18n/en/index.ts'),
    ].map((p) => p.catch((e) => { console.warn('[i18n] 字典加载失败', e); return null; })));
    for (const m of mods) if (m?.default) Object.assign(G.dict, m.default);
    G.pats = null;
  }
  // 原生壳（安卓通知/悬浮胶囊、桌面壳托盘/系统通知）跟着网页存下的偏好走；?lang= 临时覆盖不外溢到原生侧
  const saved = storedPref() || browserDefault();
  try { window.AndroidStore?.setLang?.(saved); } catch {}
  try { window.BridgeDesktop?.setLang?.(saved); } catch {}
}

/** 设置页切换语言：存偏好后整页重载 */
export function setLang(v) {
  if (v !== 'zh' && v !== 'en') return;
  try { localStorage.setItem(KEY, v); } catch {}
  try { window.AndroidStore?.setLang?.(v); } catch {}
  try { window.BridgeDesktop?.setLang?.(v); } catch {}
  if (v === G.lang) return;
  const u = new URL(location.href);
  if (u.searchParams.has('lang')) { u.searchParams.delete('lang'); location.replace(u.href); return; }
  location.reload();
}

function fill(s, p) {
  if (!p) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (p[k] === undefined || p[k] === null ? m : String(p[k])));
}

function pick(v, p) {
  if (typeof v === 'string') return v;
  const n = Number(p?.n ?? p?.count);
  return (n === 1 ? v.one : v.other) ?? v.other ?? v.one ?? '';
}

export function t(zh, p) {
  if (G.lang === 'en') {
    const v = G.dict[zh];
    if (v !== undefined) return fill(pick(v, p), p);
  }
  return fill(zh, p);
}

export function tc(ctx, zh, p) {
  if (G.lang === 'en') {
    const v = G.dict[ctx + '::' + zh];
    if (v !== undefined) return fill(pick(v, p), p);
  }
  return t(zh, p);
}

// —— 运行时文案（非字面量）：精确 → 模式 ——
const CJK = /[㐀-鿿]/;
function patterns() {
  if (G.pats) return G.pats;
  const out = [];
  for (const k of Object.keys(G.dict)) {
    if (!k.includes('{') || k.includes('::')) continue;
    // 至少两个汉字的字面部分才当模式，防止 '{x}' 这种万能键吞掉一切
    const lit = k.replace(/\{\w+\}/g, '');
    if ((lit.match(/[㐀-鿿]/g) || []).length < 2) continue;
    const names = [];
    const src = k.split(/(\{\w+\})/).map((part) => {
      const m = /^\{(\w+)\}$/.exec(part);
      if (m) { names.push(m[1]); return '([\\s\\S]+?)'; }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('');
    out.push({ re: new RegExp('^' + src + '$'), names, key: k });
  }
  // 字面部分长的先试（更具体）
  out.sort((a, b) => b.key.length - a.key.length);
  return (G.pats = out);
}

export function tr(s) {
  if (G.lang !== 'en' || typeof s !== 'string' || !s || !CJK.test(s)) return s;
  const v = G.dict[s];
  if (v !== undefined) return pick(v, null);
  const trimmed = s.trim();
  if (trimmed !== s && G.dict[trimmed] !== undefined) return pick(G.dict[trimmed], null);
  for (const p of patterns()) {
    const m = p.re.exec(trimmed);
    if (!m) continue;
    const params = {};
    p.names.forEach((n, i) => { params[n] = tr(m[i + 1]); });
    return fill(pick(G.dict[p.key], params), params);
  }
  return s;
}
