// 界面语言的浏览器侧：读偏好、启动时定语言并装字典、设置页切换语言。从 i18n.ts 挪出来——那边是纯函数层
// （服务端测试经 tasks.ts / feed-units.ts 等直接导入它），这里要碰 location / document，还要 import 用了
// import.meta.glob 的字典入口。
// 语言启动时定死，切换 = 写 localStorage['bridge-lang'] + 整页重载（与 bridge 共用同一个键）。
import { addDict, applyLang, lang } from "./i18n.ts";

const KEY = "bridge-lang";

export function langPref(): "zh" | "en" {
  try {
    const q = new URLSearchParams(location.search).get("lang");
    if (q === "zh" || q === "en") return q;
    const v = localStorage.getItem(KEY);
    if (v === "en" || v === "zh") return v;
    // 没存过偏好时跟浏览器走：语言列表里有中文就用中文，否则英文（与 bridge 的 web/src/lib/i18n.js 同一规则）
    const langs = navigator.languages?.length ? navigator.languages : [navigator.language || ""];
    return langs.some((l) => /^zh/i.test(l)) ? "zh" : "en";
  } catch {
    return "zh";
  }
}

/** 独立运行时的入口调用；嵌进 bridge 时不调（bridge 入口已加载好全局字典）。 */
export async function initI18n(): Promise<void> {
  applyLang(langPref());
  try {
    document.documentElement.lang = lang() === "en" ? "en" : "zh-CN";
  } catch {
    /* 无 DOM */
  }
  if (lang() === "en") {
    try {
      const m = await import("../i18n/en/index.ts");
      addDict(m.default);
    } catch (e) {
      console.warn("[i18n] 字典加载失败", e);
    }
  }
}

export function setLang(v: "zh" | "en"): void {
  try {
    localStorage.setItem(KEY, v);
  } catch {
    /* 存不了就只对本次生效 */
  }
  if (v === lang()) return;
  const u = new URL(location.href);
  if (u.searchParams.has("lang")) {
    u.searchParams.delete("lang");
    location.replace(u.href);
    return;
  }
  location.reload();
}
