// 本机偏好：对话流显示密度、设置入口、明暗外观。
import { tick } from "svelte";
import { applyTheme, resolveMode, type Appearance } from "../theme.ts";
import { themeReveal, withViewTransition } from "../motion.ts";
import { app } from "./core.svelte.ts";

export function setFeedDetail(on: boolean) {
  app.feedDetail = on;
  try {
    if (on) localStorage.setItem("harness.feedDetail", "1");
    else localStorage.removeItem("harness.feedDetail");
  } catch {
    /* 隐私模式等写不进去：本次会话照样生效 */
  }
}
// 嵌在 bridge 里时这个开关在 bridge 设置 › dimensio › 对话（同源、写同一个 localStorage 键）：
// 那边改了发 harness-feed-detail 事件，这里即时跟上；别的标签页改了走 storage 事件
if (typeof window !== "undefined") {
  window.addEventListener("harness-feed-detail", (e) => {
    app.feedDetail = Boolean((e as CustomEvent).detail);
  });
  window.addEventListener("storage", (e) => {
    if (e.key === "harness.feedDetail") app.feedDetail = e.newValue === "1";
  });
}

// 打开设置：嵌在 bridge 里时交给宿主（像 Claude 页一样跳 bridge 设置 › dimensio，那里是全集），
// 独立运行（8799 直连 / Harness.apk）才开自己的设置面板（连接设置只有这里有）
let hostSettings: null | (() => void) = null;
export function setHostOpenSettings(fn: null | (() => void)) {
  hostSettings = fn;
}
export function openSettings(): void {
  if (hostSettings) hostSettings();
  else app.sheet = "settings";
}

export function setAppearance(a: Appearance) {
  app.appearance = a;
  localStorage.setItem("harness.appearance", a);
  // 深浅切换整页交叉淡化（浏览器支持视图过渡时），不是一帧硬切
  withViewTransition(() => applyTheme(a));
}

// 点标志切明暗（ThemeMark）：按此刻实际的明暗取反、落成手动档（跟系统档也一样——同 bridge 点 Claude 标志，手动一切就关跟随）。
// 新纸色从标志那一点涟漪般铺开（themeReveal）；状态在过渡的更新回调里才写，旧快照拍的是完整的旧画面
// （嵌在 bridge 里时 HarnessPage 据 app.appearance 回写宿主明暗，也落在新画面里）。
export function toggleAppearance(origin: Element | null) {
  const next: Appearance = resolveMode(app.appearance) === "dark" ? "light" : "dark";
  themeReveal(
    origin,
    async () => {
      app.appearance = next;
      localStorage.setItem("harness.appearance", next);
      applyTheme(next);
      await tick();
    },
    next === "dark",
  );
}

// 系统深浅变化时（auto 档）即时跟随
matchMedia("(prefers-color-scheme: dark)").addEventListener?.("change", () => {
  if (app.appearance === "auto") applyTheme("auto");
});
