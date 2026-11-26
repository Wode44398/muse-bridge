// dimensio 卡片窗口（solo.html?agent=dimensio）的皮肤：dimensio 的全局样式与明暗令牌。
// 经它懒加载（module-chunks 里登记为 dimensio 入口），核心的 AgentCardWindow 不再静态引 harness 源码。
import '@hx/app.css';

export { tokenVars } from '@hx/lib/theme.ts';
