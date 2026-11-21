// 同机 agent 实例（dimensio）用 bridge 核心运行时里的共享终端 / 共享浏览器：与工作台面板、Claude 的工具同一个实例。
// 认法与门禁见 agent-runtime/caller.mjs；各接口的实现在 agent-runtime/ 下。各由对应插件（terminal / browser）挂上。
import { handleAgentTerm } from './agent-runtime/term.mjs';
import { handleAgentBrowser } from './agent-runtime/browser.mjs';

export { agentBrowserSession, SESSION_PREFIX } from './agent-runtime/browser.mjs';

export function registerAgentTermRoutes(router) {
  router.on('POST', '/api/internal/agent-term', handleAgentTerm);
}

export function registerAgentBrowserRoutes(router) {
  router.on('POST', '/api/internal/agent-browser', handleAgentBrowser);
}
