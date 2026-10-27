// Quick Ask 浮窗的独立入口（全局热键呼出的那条置顶输入条）。
//
// 刻意【不】挂 App.svelte：那会把壁纸、Dock、会话恢复、LAN 探活一起拖起来，
// 而这个窗口从建好到藏着待命只为一件事——热键按下的那一刻立刻能打字。复用的只有
// 三个独立模块：sse.js（/api/chat 流式）、md.js（markdown）、app.css（令牌与字体）。
import './lib/staleGuard.js';   // 构建漂移自愈：新部署后旧页面懒加载 404 → 自动刷新一次
import './app.css';
import './lib/overlay.svelte.js';   // 私有 overlay（原版字体 / 素材）：有就叠加，公开版什么都不做
import { mount } from 'svelte';
import { initI18n } from './lib/i18n.js';

document.documentElement.dataset.desktop = '1';

// 语言先定、字典先到，再加载组件（见 lib/i18n.js）。nativeMenu = 桌面壳原生右键菜单（输入条粘贴全靠它），
// 菜单文字要走 t()，所以也放到字典之后加载。
export default initI18n()
  .then(() => Promise.all([import('./desktop/quick/QuickAsk.svelte'), import('./lib/nativeMenu.js')]))
  .then(([{ default: QuickAsk }]) => mount(QuickAsk, { target: document.getElementById('app') }));
