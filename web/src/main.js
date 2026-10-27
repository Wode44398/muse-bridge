import './lib/devDesktopMock.js';   // 必须最先：dev ?fdmock 伪装桌面壳（prod 构建为空模块）
import './lib/staleGuard.js';       // 构建漂移自愈：新部署后旧页面懒加载 404 → 自动刷新一次
import './app.css';
import './lib/overlay.svelte.js';   // 私有 overlay（原版字体 / 素材）：有就叠加，公开版什么都不做
import { initI18n } from './lib/i18n.js';

// 界面语言先定、英文字典先到，再加载整个 app（app-main.js）——所有业务模块都在字典就绪后才求值，
// 模块顶层常量里的 t() 也拿得到英文。中文（默认）时 initI18n 不发任何请求，几乎零等待。
export default initI18n().then(() => import('./app-main.js')).then((m) => m.default);
