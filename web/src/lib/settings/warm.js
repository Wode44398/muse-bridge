// 设置页的预取：在用户「快要进设置」时先把根页要的数据与子页的代码块拉上。
//
// 账户卡一展开（离点「设置」通常还有一两秒），或者设置页一挂上（子页的代码与数据，离点进某一页也还有一会儿），
// 就把请求发出去；之后设置的各控制器再拉同一份时，还在路上的直接复用（agentSettings 的 once、modelHub 的 pending），
// 已经回来的就是新的。配合 lib/lastKnown 的快照：快照让第一帧不空，预取让快照尽快被换成最新的。
import { me } from '../state.svelte.js';
import { loadAgents, loadPool, loadPolicy, agentById } from '../agentSettings.svelte.js';
import { loadHub } from '../modelHub.svelte.js';
import { watchPluginPanels } from '../pluginPanels.svelte.js';
import { loadClaudeSettings } from '../claudeSettings.svelte.js';
import { loadPage } from '../../modules/pages.js';
import { loadHubHome } from './bodies.svelte.js';

let dataAt = 0;
/** 根页的数据：账户卡展开时调。几秒内重复调只算一次。 */
export function warmSettings() {
  if (me.kind === 'none') return;
  const now = Date.now();
  if (now - dataAt < 4000) return;
  dataAt = now;
  if (me.kind === 'admin') { loadAgents(); loadPool(); loadPolicy(); loadHub(); }
  watchPluginPanels();
  loadClaudeSettings();
}

let bodiesAt = 0;
const idle = (fn) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 1200 }) : setTimeout(fn, 300));
/** 子页正文的代码块（模型中心、Antigravity / Codex / Media Studio 的设置）：设置页挂上后空闲时取，点进去那一下就不用再等下载。 */
export function warmSettingsBodies() {
  if (me.kind === 'none') return;
  const now = Date.now();
  if (now - bodiesAt < 30000) return;
  bodiesAt = now;
  idle(() => {
    const quiet = (p) => p?.catch?.(() => {});
    if (me.kind === 'admin' || me.kind === 'user') quiet(loadHubHome());
    // 扩展的正文只在这台服务器真有那个 agent 时才取（没装扩展的构建里取了也是 reject）
    // Antigravity / Codex 页的数据也一并发出去（入口在各自懒加载的正文模块里，核心不静态 import 扩展的控制器）
    if (agentById('agy')) quiet(loadPage.agyIosSettings()?.then((m) => m.warmAgySettings?.()));
    if (agentById('codex') || (me.kind === 'user' && me.agents?.includes('codex'))) quiet(loadPage.codexIosSettings()?.then((m) => m.warmCodexSettings?.()));
    if (agentById('studio') || (me.kind === 'user' && me.agents?.includes('studio'))) quiet(loadPage.studioSettings());
  });
}
