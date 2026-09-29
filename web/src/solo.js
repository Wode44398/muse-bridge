// 「单开一个对话」的独立入口（solo.html?solo=<会话 id>）：分屏的另一格（&pane=1，同源 iframe）
// 与拖出 app 的独立窗口都是它。刻意【不】挂 App.svelte——那会把主页、会话恢复、登录流程一起拖起来，
// 而这一页只要一个对话。见 lib/solo.js、SoloPage。
import './lib/staleGuard.js';   // 构建漂移自愈：新部署后旧页面懒加载 404 → 自动刷新一次
import './app.css';
import { mount } from 'svelte';
import { initI18n } from './lib/i18n.js';

// 语言先定、字典先到，再加载组件（见 lib/i18n.js）
export default initI18n()
  .then(() => import('./components/SoloPage.svelte'))
  .then(({ default: SoloPage }) => mount(SoloPage, { target: document.getElementById('app') }));
