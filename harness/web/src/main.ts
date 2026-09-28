import { mount } from "svelte";
import "./app.css"; // dimensio 基础层（含 Geist @font-face，两种宿主共用）
import App from "./App.svelte";

// 独立运行标记：body 级样式（背景/滚动行为）只在此模式生效，
// 嵌入 bridge 分页时绝不碰宿主 body。
document.documentElement.dataset.hxStandalone = "1";

const app = mount(App, { target: document.getElementById("app")! });

export default app;
