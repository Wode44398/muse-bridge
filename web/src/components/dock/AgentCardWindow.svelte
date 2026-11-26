<script>
  // 非 Claude 分页的卡片窗口（solo.html?card=…&agent=codex|agy|dimensio）：那一页工作区的一张共用卡
  // （文件 / 终端 / 浏览器 / 审阅 / 记忆）被拖出 app，整扇窗只放这一张。
  // 作用域 = 拖出时的工作空间；浏览器按拖出时那一页的会话那一份（sid）；明暗 = 拖出时那一页的档（th）。
  // 专属卡（Codex 无、Antigravity 的代理 / 活动 / 审阅、dimensio 的任务 / 审阅）读的是那一页的会话状态，不放出来。
  import { untrack } from 'svelte';
  import { ui } from '../../lib/state.svelte.js';
  import { codexHost, codexTools, agyHost, agyTools, createDockHost } from '../../lib/dock.svelte.js';
  import { sharedTool } from '../../lib/dock/tools.js';
  import { DOCK_CHANNEL, AGENT_CARD_KEYS } from '../../lib/solo.js';
  import Workbench from './Workbench.svelte';

  let { agent, card, ws = '', sid = '', theme = '' } = $props();

  const mode = $derived(theme === 'light' || theme === 'dark' ? theme : ui.theme === 'light' ? 'light' : 'dark');
  const light = $derived(mode === 'light');

  // dimensio 的工作区状态在它自己的页面里：卡片窗口另起一个同形状的宿主（只为这一张卡）
  const host = untrack(() => agent === 'codex' ? codexHost : agent === 'agy' ? agyHost : createDockHost({
    id: 'dimensio', initialView: card, keys: () => AGENT_CARD_KEYS.dimensio,
    caps: { filesRoot: 'ws', previewHost: 'hx-files', memoryAgent: 'dimensio' },
  }));
  const tools = $derived(agent === 'codex' ? codexTools() : agent === 'agy' ? agyTools()
    : AGENT_CARD_KEYS.dimensio.map((k) => sharedTool(k)).filter(Boolean));
  const skin = untrack(() => agent);

  // agy / dimensio 的样式与令牌属于各自的功能扩展：经登记的懒加载入口取，核心不静态引它们的源码（stage 闸门）
  let tokenVars = $state(null);
  let skinReady = $state(untrack(() => agent !== 'agy' && agent !== 'dimensio'));
  untrack(() => {
    const done = () => { skinReady = true; };
    if (agent === 'agy') import('../agy/card-skin.js').then(done, done);
    else if (agent === 'dimensio') import('./DimensioCardSkin.js').then((m) => { tokenVars = m.tokenVars; done(); }, done);
  });
  untrack(() => {
    host.setWs(ws);
    host.state.sessionId = sid;
    host.state.noAuto = true;
    host.open(card);
  });

  // dimensio 的令牌平时由它的 theme.ts 写进根节点；这里按拖出时的明暗写一份
  const hxVars = $derived.by(() => {
    if (agent !== 'dimensio' || !tokenVars) return '';
    try { return Object.entries(tokenVars(mode)).map(([k, v]) => `${k}:${v}`).join(';'); } catch { return ''; }
  });

  function back() {
    try { const ch = new BroadcastChannel(DOCK_CHANNEL); ch.postMessage({ t: 'back', agent, view: card, ws }); ch.close(); } catch {}
    setTimeout(() => window.close(), 40);
  }
</script>

<div class="acw" class:light class:agy-root={agent === 'agy'} class:hxroot={agent === 'dimensio'} style={hxVars}>
  {#if skinReady}
    <Workbench {host} {tools} wide {card} skin={skin} mobile="sheet" theme={mode}
      label={tools.find((x) => x.key === card)?.label || ''} keysOn={false} onCardBack={back} />
  {/if}
</div>

<style>
  .acw { flex: 1; min-height: 0; display: flex; flex-direction: column; background: transparent; }
  .acw > :global(.wb) { flex: 1; min-height: 0; }
</style>
