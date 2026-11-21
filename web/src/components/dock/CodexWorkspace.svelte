<script>
  // Codex 分页的工作区：统一外壳（Workbench）+ ChatGPT 的中性灰皮。四件共用工具，按项目（会话的 cwd）作用域。
  // 手机上是整屏页（返回 + 自适应标签），不压缩、不叠盖对话。
  import { ui } from '../../lib/state.svelte.js';
  import { layout } from '../../lib/layout.svelte.js';
  import { codexHost, codexTools } from '../../lib/dock.svelte.js';
  import { toolAllowed } from '../../lib/dock/tools.js';
  import { t } from '../../lib/i18n.js';
  import Workbench from './Workbench.svelte';

  let { wide = false } = $props();
  const codexDock = codexHost.state;
  const tools = $derived(codexTools().filter((x) => toolAllowed(x, codexHost))
    .map((x) => (x.key === 'browser' ? { ...x, live: Boolean(codexDock.browserLive) } : x.key === 'term' ? { ...x, live: codexDock.termLive } : x)));
</script>

{#snippet empty()}
  <div class="empty"><span class="spin"></span><p>{t('正在连接项目工作区…')}</p></div>
{/snippet}

<!-- 对话是一整个 iframe（自带会话侧栏），工作区在它右边：给它留 560（折叠屏展开 280）；
     侧栏要占掉一截，所以比别的分页更宽才摆两列 -->
<Workbench host={codexHost} {tools} {wide} multi={layout.expanded} skin="codex" mobile="page"
  reserve={layout.medium ? 280 : 560} twoColHost={1280} widthKey="bridge-chatgpt-workspace-w" label={t('工作区')}
  {empty} keysOn={ui.screen === 'chatgpt'} />

<style>
  .empty { flex: 1; display: grid; place-content: center; justify-items: center; gap: 10px; color: var(--muted); font-size: 14px; }
  .spin { width: 22px; height: 22px; border: 2px solid var(--divider); border-top-color: #10a37f; border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
