// 内嵌图表的渲染壳：沙箱 iframe 的整页、壳样式、手机静态渲染的清洗，直接用 bridge 给 Claude 图表写的那一份
// （仓库根 web/src/lib/widgetShell.js：CSP 白名单、流式剥脚本、高度上报、sendPrompt / openLink / 下载转给父页、截图、DOMPurify 清洗）——
// 安全边界只维护一份。这里补的只有 dimensio 自己的主题：把「纸墨」令牌折算成图表约定的变量名（官方 visualize 同名，
// 模型照 WidgetGuide 指南写的就是这些名字）。
// @ts-ignore —— 纯 JS 模块、没有类型声明；用到的几个函数在下面手写类型
import * as raw from "../../../../web/src/lib/widgetShell.js";

type Vars = Record<string, string>;
interface Shell {
  buildSrcdoc(o: { nonce: string; mode: string; vars: Vars | null; maxH: number }): string;
  widgetCss(scope: { root: string; dark: string; body: string }): string;
  styleText(vars: Vars): string;
  sanitizeStatic(code: string): string;
  stripScripts(code: string): string;
  visibleMarkup(code: string): boolean;
  isSvgCode(code: string): boolean;
  standaloneFile(code: string, title: string): { name: string; mime: string; text: string };
  fileStem(title: string): string;
  ARROW_DEFS: string;
}
export const shell = raw as unknown as Shell;

// 图表变量 ← dimensio 令牌（直接取值）
const MAP: [string, string][] = [
  ["--surface-0", "--bg"],
  ["--surface-1", "--surface"],
  ["--surface-2", "--surface2"],
  ["--text-primary", "--text"],
  ["--text-secondary", "--text2"],
  ["--text-muted", "--text3"],
  ["--border", "--border"],
  ["--border-strong", "--border2"],
  ["--border-stronger", "--text3"],
  // 强调就是墨（DESIGN「纸与墨，一抹朱」）
  ["--text-accent", "--accent"],
  ["--bg-accent", "--accent-soft"],
  ["--text-danger", "--err"],
  ["--text-success", "--ok"],
  ["--text-warning", "--warn"],
  ["--font-sans", "--font-ui"],
  ["--font-mono", "--font-mono"],
  ["--font-voice", "--font-serif"],
];
// 图表变量 ← 令牌按比例混进透明（底色、描边）
const MIX: [string, string, number][] = [
  ["--border-accent", "--accent", 45],
  ["--bg-danger", "--err", 12],
  ["--border-danger", "--err", 45],
  ["--bg-success", "--ok", 12],
  ["--border-success", "--ok", 45],
  ["--bg-warning", "--warn", 12],
  ["--border-warning", "--warn", 45],
];
const mix = (v: string, pct: number) => `color-mix(in srgb, ${v} ${pct}%, transparent)`;

/** iframe 用：按卡片所在处的计算样式取具体值（iframe 读不到父页变量）。取不到的项不写，壳样式里有默认值。 */
export function themeVars(el: Element | null): Vars {
  const out: Vars = {};
  let cs: CSSStyleDeclaration | null = null;
  try {
    cs = getComputedStyle(el ?? document.documentElement);
  } catch {
    return out;
  }
  for (const [k, src] of MAP) {
    const v = cs.getPropertyValue(src).trim();
    if (v) out[k] = v;
  }
  for (const [k, src, pct] of MIX) {
    const v = cs.getPropertyValue(src).trim();
    if (v) out[k] = mix(v, pct);
  }
  return out;
}

/** 手机静态渲染（shadow 根）用：var() 引用，跟着父页主题自动变。 */
export function themeRefs(): Vars {
  const out: Vars = {};
  for (const [k, src] of MAP) out[k] = `var(${src})`;
  for (const [k, src, pct] of MIX) out[k] = mix(`var(${src})`, pct);
  return out;
}

/** 卡片所在处的明暗（dimensio 的主题根上有 data-mode）。 */
export function modeAt(el: Element | null): "light" | "dark" {
  const root = (el?.closest?.("[data-mode]") as HTMLElement | null) ?? document.documentElement;
  return root?.dataset?.mode === "dark" ? "dark" : "light";
}
