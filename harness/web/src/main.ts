import { mount } from "svelte";
import "./app.css"; // dimensio 基础层（含 Geist @font-face，两种宿主共用）
import { initI18n } from "./lib/i18n-boot.ts";

// 独立运行标记：body 级样式（背景/滚动行为）只在此模式生效，
// 嵌入 bridge 分页时绝不碰宿主 body。
document.documentElement.dataset.hxStandalone = "1";

// 语言先定、字典先到，再加载业务模块——模块顶层常量里的 t() 才拿得到英文（见 lib/i18n-boot.ts）。
const app = initI18n()
  .then(() => import("./App.svelte"))
  .then(({ default: App }) => mount(App, { target: document.getElementById("app")! }));

export default app;
