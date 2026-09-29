import './lib/staleGuard.js';       // 构建漂移自愈：新部署后旧页面懒加载 404 → 自动刷新一次
import './app.css';
import { initI18n } from './lib/i18n.js';

// 界面语言先定、英文字典先到，再加载整个 app（app-main.js）——所有业务模块都在字典就绪后才求值，
// 模块顶层常量里的 t() 也拿得到英文。中文（默认）时 initI18n 不发任何请求，几乎零等待。
export default initI18n().then(() => import('./app-main.js')).then((m) => m.default);
