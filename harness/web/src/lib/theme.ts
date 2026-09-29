// dimensio 设计语言「纸墨」—— 令牌的唯一来源。与 bridge（官网 / 月桥图标）同一张纸、同一块墨。
//
// 主张：纸与墨。暖白的纸、墨色的字，层次靠纸色的深浅与一根根细线，不靠彩色；强调就是墨本身（选中、勾选、焦点、
// 链接、主按钮）。唯一的彩色是一抹朱（--live），只留给「正在发生」的东西：在跑的光点、实时节点、倒计时——
// 与 bridge 官网「一抹朱色只留给正在发生的东西」同一条规矩。品牌几何见 harness/web/brand/，色值与它同源。
//
// 结构约定：令牌全部经 applyTheme 用 JS 写到主题根（嵌入 bridge = .hxroot；独立运行另同步一份到
// <html>），CSS 只引用变量；本文件【绝不产出裸 :root 规则】（harness 随 @hx 打进 bridge 全局包，
// 裸 :root 会按源顺序覆盖宿主令牌——apk218 的暗色错乱事故）。

import { motionVars } from "./motion.ts";
import { t, tc } from "./i18n.ts";

export type Mode = "light" | "dark";
export type Appearance = Mode | "auto";

// ── 厂商元数据（身份识别：logo / 名称；界面视觉不随厂商换装）────────────────────────
export interface Vendor {
  id: string;
  name: string;
  company: string;
  color: string; // 品牌色：只用于厂商标志本身
}

export const VENDORS: Record<string, Vendor> = {
  anthropic: { id: "anthropic", name: "Claude", company: "Anthropic", color: "#d97757" },
  openai: { id: "openai", name: "DeepSeek", company: "DeepSeek", color: "#4d6bfe" },
  gemini: { id: "gemini", name: "Gemini", company: "Google", color: "#3186ff" },
  qwen: { id: "qwen", name: "Qwen", company: t("阿里云 · 通义"), color: "#7b5bff" },
  zhipu: { id: "zhipu", name: "GLM", company: t("智谱 · Z.ai"), color: "#2b62ff" },
  kimi: { id: "kimi", name: "Kimi", company: t("月之暗面"), color: "#1783FF" },
  mimo: { id: "mimo", name: "MiMo", company: t("小米 · Xiaomi"), color: "#ff6900" },
};
export const VENDOR_ORDER = ["anthropic", "openai", "gemini", "qwen", "zhipu", "kimi", "mimo"];

export function vendorOf(id: string | undefined | null): Vendor {
  return VENDORS[id ?? "anthropic"] ?? VENDORS.anthropic;
}

// 厂商标志的官方配色（VendorLogo 用；只有标志本身带色，界面其余部分不沾）
export const LOGO_COLORS = {
  qwen: ["#8b5cf6", "#4f46e5"],
  zhipuTile: "#2d2d2d",
  kimiTile: "#0d0d10",
  kimiDot: "#1783FF",
  geminiStops: ["#08B962", "#F94543", "#FABC12"],
  white: "#ffffff",
} as const;

// 时段问候（语气克制）
export function greeting(): string {
  const h = new Date().getHours();
  if (h < 5) return t("夜深了");
  if (h < 11) return t("早上好");
  if (h < 14) return t("中午好");
  if (h < 18) return t("下午好");
  return t("晚上好");
}

// ── 令牌 ─────────────────────────────────────────────────────────────────────────────
// 纸 / 墨 / 朱取 bridge 官网（site/assets/site.css）同值，夜取官网夜色段落。对比度（浅 / 深，对画布）：
// 正文 16.0 / 15.6，次要 8.5 / 9.0，辅助 4.7 / 5.1，朱 4.4 / 5.1（朱只做点和线，不做小字）。
interface Tokens {
  bg: string; // 主画布：纸
  rail: string; // 侧栏：深半档的纸（与画布之间再有一根细线）
  surface: string; // 浮起的面：输入框、卡片、菜单、sheet（更白的纸）
  surface2: string; // 纸色填充：悬停、芯片、用户气泡
  surface3: string; // 更深一阶：按下、分段控件轨道
  text: string;
  text2: string;
  text3: string;
  border: string; // 细线
  border2: string; // 强细线（悬停 / 结构线）
  accent: string; // 强调 = 墨：选中、勾选、焦点、链接、开关
  accentHover: string;
  onAccent: string;
  accentSoft: string;
  primary: string; // 主按钮：墨（深色档反相为象牙）
  onPrimary: string;
  live: string; // 朱：只给「正在发生」——在跑的光点、实时节点、倒计时、新消息的小点
  liveSoft: string;
  onLive: string; // 朱底上的字
  ok: string;
  warn: string;
  err: string;
  codeBg: string;
  codeK: string; // 代码关键字：石青（代码是内容不是界面，允许一点矿物色）
  scrim: string;
  shadow1: string; // 浮起（输入框、卡片）
  shadow2: string; // 悬浮（菜单、弹层）
  shadow3: string; // 模态（sheet、对话框）
  sheen: string; // 浮起的面上沿一道极淡的高光（纸的厚度；深色档几乎看不见）
  selection: string;
}

const LIGHT: Tokens = {
  bg: "#F4F1EA",
  rail: "#EEEAE2",
  surface: "#FBFAF6",
  surface2: "#ECE8DF",
  surface3: "#E2DDD1",
  text: "#171614",
  text2: "#48453F",
  text3: "#6F6B63",
  border: "rgba(23,22,20,.09)",
  border2: "rgba(23,22,20,.16)",
  accent: "#171614",
  accentHover: "#000000",
  onAccent: "#F4F1EA",
  accentSoft: "rgba(23,22,20,.07)",
  primary: "#171614",
  onPrimary: "#F4F1EA",
  live: "#C8412B",
  liveSoft: "rgba(200,65,43,.12)",
  onLive: "#FFF9F4",
  ok: "#3D7A4A",
  warn: "#98610F",
  err: "#AE2E3B",
  codeBg: "#EFEBE3",
  codeK: "#35597C",
  scrim: "rgba(23,22,20,.3)",
  // 暖墨投影：一道贴身的接触影 + 一道收着的远影（负扩散，影子只在下方）
  shadow1: "0 1px 1px rgba(23,22,20,.04), 0 3px 10px -3px rgba(23,22,20,.10)",
  shadow2: "0 1px 2px rgba(23,22,20,.06), 0 14px 34px -10px rgba(23,22,20,.22)",
  shadow3: "0 2px 6px rgba(23,22,20,.06), 0 30px 70px -18px rgba(23,22,20,.34)",
  sheen: "rgba(255,255,255,.75)",
  selection: "#EBCFC2",
};

const DARK: Tokens = {
  bg: "#131210",
  rail: "#0F0E0C",
  surface: "#1C1A17",
  surface2: "#25231F",
  surface3: "#2F2C28",
  text: "#EEEAE2",
  text2: "#B9B3A8",
  text3: "#8A857C",
  border: "rgba(238,234,226,.08)",
  border2: "rgba(238,234,226,.14)",
  accent: "#EEEAE2",
  accentHover: "#FFFFFF",
  onAccent: "#131210",
  accentSoft: "rgba(238,234,226,.09)",
  primary: "#EEEAE2",
  onPrimary: "#131210",
  live: "#E4553A",
  liveSoft: "rgba(228,85,58,.16)",
  onLive: "#1A0F0C",
  ok: "#79B887",
  warn: "#D9A650",
  err: "#E5707A",
  codeBg: "#0F0E0C",
  codeK: "#93B4D6",
  scrim: "rgba(0,0,0,.5)",
  shadow1: "0 1px 1px rgba(0,0,0,.3), 0 4px 14px -4px rgba(0,0,0,.4)",
  shadow2: "0 2px 4px rgba(0,0,0,.3), 0 16px 40px -10px rgba(0,0,0,.55)",
  shadow3: "0 4px 10px rgba(0,0,0,.34), 0 32px 80px -20px rgba(0,0,0,.66)",
  sheen: "rgba(255,255,255,.045)",
  selection: "rgba(228,85,58,.3)",
};

// 宿主（bridge 桌面壳）拿页面底色去刷窗口 backgroundColor / 窗控条：必须是真实的页面底色。
export function themeBg(mode: Mode): string {
  return (mode === "dark" ? DARK : LIGHT).bg;
}

// 字体：拉丁走内置的 Inter / JetBrains Mono 子集（只含拉丁，见 app.css 的 @font-face），
// 中文与全角标点（“” —— ……）落到系统中文字体——子集里刻意去掉了这几个标点。
const CJK = `"PingFang SC", "HarmonyOS Sans SC", "MiSans", "Noto Sans SC", "Source Han Sans SC", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`;
const FONT_UI = `"Dimensio Sans", system-ui, -apple-system, "Segoe UI", ${CJK}`;
const FONT_MONO = `"Dimensio Mono", ui-monospace, "SF Mono", "Cascadia Mono", Consolas, "PingFang SC", "Microsoft YaHei UI", monospace`;
// 展示用宋体：思源宋体 600 的子集（只含问候等固定展示文字，见 brand/serif-font.py）；缺字落到系统宋体
const FONT_SERIF = `"Dimensio Serif", "Noto Serif SC", "Source Han Serif SC", "Songti SC", "STSong", serif`;

// 形状 / 动效 / 字号：两档共用
const SHARED: Record<string, string> = {
  "--font-ui": FONT_UI,
  "--font-mono": FONT_MONO,
  "--font-serif": FONT_SERIF,
  // 字号阶梯（px）：11 · 12 · 13 · 14 · 15 · 17 · 20 · 26 · 34
  "--fs-xs": "11px",
  "--fs-sm": "12px",
  "--fs-md": "13px",
  "--fs-base": "14px",
  "--fs-body": "15px",
  "--fs-lg": "17px",
  "--fs-xl": "20px",
  "--fs-2xl": "26px",
  "--fs-3xl": "34px",
  "--lh-tight": "1.3",
  "--lh-ui": "1.45",
  "--lh-body": "1.72",
  // 圆角
  "--r-xs": "6px",
  "--r-sm": "8px",
  "--r-md": "12px",
  "--r-lg": "16px",
  "--r-xl": "22px",
  "--r-pill": "999px",
  // 动效：曲线与时长。弹簧曲线由 lib/motion.ts 算出（CSS linear()，app.css 里声明），这里只放三次贝塞尔。
  "--ease": "cubic-bezier(.2,.8,.2,1)",
  "--ease-out": "cubic-bezier(.16,1,.3,1)",
  "--ease-in": "cubic-bezier(.5,0,.75,0)",
  "--ease-in-out": "cubic-bezier(.65,0,.35,1)",
  "--t-fast": "140ms",
  "--t-med": "240ms",
  "--t-slow": "420ms",
};

// ── 应用到 DOM ────────────────────────────────────────────────────────────────────────
// token 一律写到 .hxroot（两种宿主都会注册它）：app.css 的兜底块定义在 .hxroot 类上，若只写 <html>，
// 类规则在更近的祖先上会永远遮蔽内联变量。独立运行时【另】同步一份到 <html>，让 body 背景 /
// theme-color / 壳状态栏与页面一致；嵌入 bridge 时绝不碰 <html>。
let themeRoot: HTMLElement | null = null;
export function setThemeRoot(el: HTMLElement | null) {
  themeRoot = el;
}

export function resolveMode(appearance: Appearance): Mode {
  if (appearance !== "auto") return appearance;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function tokenVars(mode: Mode): Record<string, string> {
  const tk = mode === "dark" ? DARK : LIGHT;
  return {
    "--bg": tk.bg,
    "--rail": tk.rail,
    "--surface": tk.surface,
    "--surface2": tk.surface2,
    "--surface3": tk.surface3,
    "--text": tk.text,
    "--text2": tk.text2,
    "--text3": tk.text3,
    "--border": tk.border,
    "--border2": tk.border2,
    "--accent": tk.accent,
    "--accent-hover": tk.accentHover,
    "--on-accent": tk.onAccent,
    "--accent-soft": tk.accentSoft,
    "--hx-accent": tk.accent, // 宿主（bridge）拖放高亮读它
    "--primary": tk.primary,
    "--on-primary": tk.onPrimary,
    "--live": tk.live,
    "--live-soft": tk.liveSoft,
    "--on-live": tk.onLive,
    "--ok": tk.ok,
    "--warn": tk.warn,
    "--err": tk.err,
    "--user-bubble": tk.surface2,
    "--on-user-bubble": tk.text,
    "--code-bg": tk.codeBg,
    "--code-k": tk.codeK,
    "--scrim": tk.scrim,
    "--shadow-1": tk.shadow1,
    "--shadow-2": tk.shadow2,
    "--shadow-3": tk.shadow3,
    "--sheen": tk.sheen,
    "--selection": tk.selection,
    ...SHARED,
    ...motionVars(),
  };
}

export function applyTheme(appearance: Appearance) {
  const mode = resolveMode(appearance);
  const tk = mode === "dark" ? DARK : LIGHT;
  const standalone = document.documentElement.dataset.hxStandalone === "1";
  const targets = [themeRoot, standalone ? document.documentElement : null].filter((el): el is HTMLElement => Boolean(el));
  const vars = tokenVars(mode);
  for (const root of targets) {
    root.dataset.mode = mode;
    root.style.colorScheme = mode;
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  }

  // 浏览器 UI / 壳状态栏：嵌入模式归宿主管，不越权
  if (standalone) {
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
      meta = document.createElement("meta");
      meta.name = "theme-color";
      document.head.appendChild(meta);
    }
    meta.content = tk.bg;
    try {
      (window as any).HarnessShell?.setBars?.(mode === "light", tk.bg);
    } catch {
      /* 非安卓壳 */
    }
  }
}
