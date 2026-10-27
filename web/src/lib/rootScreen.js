// 单 agent 模式的根页判定（纯函数：state.svelte.js 的 rootScreen() 拿 me.agents 调它，node:test 直接测）。
//
// 这个身份能进的 agent 分页只剩一个，而且那一页做了「当根页」的外壳——没有主页，打开即是那一页；
// 设置 / 账户收进侧栏底部账户行；返回键到这一页就是底；工作空间等别的页关掉回这一页。
// 做了这层外壳的：Claude 页（ClaudePage）与 dimensio 页（HarnessPage：没有「主页」行、侧栏底部挂账户行、
// 没登录不挂页面只给登录）。只剩别的分页（Gemini / Codex）时仍走主页（主页上只有那一个入口）。
// 判定只看 agent 名单，不看发行版：任何只开了 Claude 或只开了 dimensio 的服务器都这样。
// 没登录时 me.agents 是服务器全局开着的名单：全局只开一个的服务器，登录框就直接压在那一页上。
// agents 不是数组（旧后端没登录、名单未知）= 当作都开着 → 主页。
import { AGENT_BY_ID } from '../../../src/config/agents.mjs';

export const ROOT_SCREENS = Object.freeze(['claude', 'harness']);

export function pickRootScreen(agents) {
  if (!Array.isArray(agents)) return 'home';
  const screens = new Set(agents.map((id) => AGENT_BY_ID[id]?.screen).filter(Boolean));
  if (screens.size !== 1) return 'home';
  const [s] = screens;
  return ROOT_SCREENS.includes(s) ? s : 'home';
}
