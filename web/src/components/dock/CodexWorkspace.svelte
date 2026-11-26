<script>
  // Codex 分页的工作区：统一外壳（Workbench）+ ChatGPT 的中性灰皮。四件共用工具，按项目（会话的 cwd）作用域。
  // 手机上是整屏页（返回 + 自适应标签），不压缩、不叠盖对话。
  import { ui } from '../../lib/state.svelte.js';
  import { codexHost, codexTools } from '../../lib/dock.svelte.js';
  import { toolAllowed } from '../../lib/dock/tools.js';
  import { t } from '../../lib/i18n.js';
  import { agentPopOut, listenCardBack } from '../../lib/solo.js';
  import Workbench from './Workbench.svelte';

  let { wide = false, aside = 0 } = $props();
  const codexDock = codexHost.state;
  const tools = $derived(codexTools().filter((x) => toolAllowed(x, codexHost))
    .map((x) => (x.key === 'browser' ? { ...x, live: Boolean(codexDock.browserLive) } : x.key === 'term' ? { ...x, live: codexDock.termLive } : x)));
  // 卡片拖出 app 成独立窗口（同 Claude 分页）；那扇窗点「放回工作台」就摆回这里
  const popOut = agentPopOut('codex', () => codexDock, () => (ui.theme === 'light' ? 'light' : 'dark'));
  $effect(() => listenCardBack('codex', (v) => { if (tools.some((x) => x.key === v)) { codexHost.open(v); try { window.focus(); } catch {} } }));
</script>

{#snippet empty()}
  <div class="empty"><span class="spin"></span><p>{t('正在连接项目工作区…')}</p></div>
{/snippet}

<!-- 侧列形态多卡、宽度规则与别的分页同一套（lib/dock/sizing.js）；线程列表和工作区同在一行，经 aside 报给外壳 -->
<Workbench host={codexHost} {tools} {wide} multi skin="codex" mobile="page"
  {aside} widthKey="bridge-chatgpt-workspace-w" label={t('工作区')}
  {empty} {popOut} keysOn={ui.screen === 'chatgpt'} />

<style>
  .empty { flex: 1; display: grid; place-content: center; justify-items: center; gap: 10px; color: var(--muted); font-size: 14px; }
  .spin { width: 22px; height: 22px; border: 2px solid var(--divider); border-top-color: #10a37f; border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
