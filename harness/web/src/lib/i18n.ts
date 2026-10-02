// 界面语言：简体中文 / English（没存过偏好时跟浏览器语言）。与 bridge 的 web/src/lib/i18n.js 同一套约定、同一份全局字典：
//   t('新建对话')、t('已选 {n} 项', { n })、tc('语境', '中文')、tr(运行时文案)
// 中文原文就是键；英文在 src/i18n/en/*.ts。嵌进 bridge 时由 bridge 的入口统一加载两份字典，
// 独立运行（8799 / dimensio 壳）时由本目录 main.ts 调 i18n-boot.ts 的 initI18n() 只加载本项目的字典。
// 本文件是纯函数层（服务端测试经 tasks.ts / feed-units.ts 等直接导入它）：不碰 DOM、不 import 字典；
// 读偏好、定语言、装字典、切换语言这些要浏览器的事都在 i18n-boot.ts。
// （本文件自身 i18n-ignore-file：它就是翻译层，不参与漏译检查）

type Plural = { one?: string; other?: string };
type Val = string | Plural;
type Params = Record<string, unknown> | null | undefined;
type Pat = { re: RegExp; names: string[]; key: string };
type Store = { lang: "zh" | "en"; dict: Record<string, Val>; pats: Pat[] | null };

const g = globalThis as unknown as { __bridgeI18n?: Store };
const G: Store = (g.__bridgeI18n ??= { lang: "zh", dict: Object.create(null), pats: null });

export const lang = () => G.lang;
export const isEn = () => G.lang === "en";
export const locale = () => (G.lang === "en" ? "en-US" : "zh-CN");

// 写入口：只给 i18n-boot.ts 在启动时调（语言启动时定死，业务代码不改它）
export function applyLang(v: "zh" | "en"): void {
  G.lang = v;
}

export function addDict(d: Record<string, Val>): void {
  Object.assign(G.dict, d);
  G.pats = null;
}

function fill(s: string, p: Params): string {
  if (!p) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (p[k] === undefined || p[k] === null ? m : String(p[k])));
}

function pick(v: Val, p: Params): string {
  if (typeof v === "string") return v;
  const n = Number(p?.n ?? p?.count);
  return (n === 1 ? v.one : v.other) ?? v.other ?? v.one ?? "";
}

export function t(zh: string, p?: Params): string {
  if (G.lang === "en") {
    const v = G.dict[zh];
    if (v !== undefined) return fill(pick(v, p), p);
  }
  return fill(zh, p);
}

export function tc(ctx: string, zh: string, p?: Params): string {
  if (G.lang === "en") {
    const v = G.dict[ctx + "::" + zh];
    if (v !== undefined) return fill(pick(v, p), p);
  }
  return t(zh, p);
}

const CJK = /[㐀-鿿]/;
function patterns(): Pat[] {
  if (G.pats) return G.pats;
  const out: Pat[] = [];
  for (const k of Object.keys(G.dict)) {
    if (!k.includes("{") || k.includes("::")) continue;
    const lit = k.replace(/\{\w+\}/g, "");
    if ((lit.match(/[㐀-鿿]/g) || []).length < 2) continue;
    const names: string[] = [];
    const src = k
      .split(/(\{\w+\})/)
      .map((part) => {
        const m = /^\{(\w+)\}$/.exec(part);
        if (m) {
          names.push(m[1]);
          return "([\\s\\S]+?)";
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("");
    out.push({ re: new RegExp("^" + src + "$"), names, key: k });
  }
  out.sort((a, b) => b.key.length - a.key.length);
  return (G.pats = out);
}

export function tr(s: string): string {
  if (G.lang !== "en" || typeof s !== "string" || !s || !CJK.test(s)) return s;
  const v = G.dict[s];
  if (v !== undefined) return pick(v, null);
  const trimmed = s.trim();
  if (trimmed !== s && G.dict[trimmed] !== undefined) return pick(G.dict[trimmed], null);
  for (const p of patterns()) {
    const m = p.re.exec(trimmed);
    if (!m) continue;
    const params: Record<string, string> = {};
    p.names.forEach((n, i) => {
      params[n] = tr(m[i + 1]);
    });
    return fill(pick(G.dict[p.key], params), params);
  }
  return s;
}
