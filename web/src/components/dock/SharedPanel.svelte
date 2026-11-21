<script>
  // 各 agent 分页共用的工作区面板：按 key 把 lib/dock/tools.js 登记的共用工具摆出来。
  // 新增一张共用工具 = 登记表里加一行 + 这里加一个分支，四个分页的工作区就都有。
  // 作用域全来自宿主（lib/dock/host.svelte.js）：ws、会话、meta；这里不认是哪一家。
  import ReviewPanel from './ReviewPanel.svelte';
  import TermPanel from './TermPanel.svelte';
  import BrowserPanel from './BrowserPanel.svelte';
  import WorkspaceEmbed from './WorkspaceEmbed.svelte';
  import MemoryPanel from './MemoryPanel.svelte';
  import MediaViewer from '../preview/MediaViewer.svelte';
  import { t } from '../../lib/i18n.js';

  // files = 外壳算好的文件卡挂载参数（{ key, ws, rel, open, home }；null = 此刻挂不了，见下面的说明文案）
  // theme = 宿主自有明暗档（''＝跟全站）；snap = 快照访客（只读浏览器、访客版文件页）
  let { host, view, wide = false, snap = false, theme = '', files = null, onExitFiles = null } = $props();
  const st = $derived(host.state);
  const rootName = $derived(files?.ws ? (files.ws.split(/[\\/]/).filter(Boolean).pop() || '') : '');
  // 文件页里开预览用哪个查看器实例：缺省实例（'dock'）由文件页自己按「是不是内嵌」推出来，不用传
  const previewHost = $derived(host.previewHost === 'dock' ? '' : host.previewHost);
</script>

{#if view === 'memory'}
  <!-- 记忆按工作目录找记忆库，不用等 meta -->
  {#key st.ws}<MemoryPanel ws={st.ws} agent={host.memoryAgent} {theme} />{/key}
{:else if view === 'files'}
  {#if files}
    {#key files.key}
      <!-- transform 造 containing block：工作空间页的 fixed 根 / 浮层 / 菜单全被圈进这张卡 -->
      <div class="wb-embed">
        <WorkspaceEmbed {wide} guest={snap} ws={files.ws} home={files.home} {rootName} initialPath={files.rel}
          initialOpen={files.open || ''} {previewHost} {theme} onExit={onExitFiles} />
        <MediaViewer host={host.previewHost} />
      </div>
    {/key}
  {:else if st.meta?.gone}
    <div class="wb-wait">{t('该工作空间的文件夹已不存在（可能被移动或删除）')}</div>
  {:else if st.meta && (st.meta.rel == null || st.meta.shell === false)}
    <div class="wb-wait">{t('该工作空间在云端文件区之外，无法在侧栏打开工作空间页')}</div>
  {:else}
    <div class="wb-wait">{t('工作空间加载中…')}</div>
  {/if}
{:else}
  {#key st.ws}
    {#if view === 'review'}<ReviewPanel dockState={st} />
    {:else if view === 'term'}<TermPanel dockState={st} />
    {:else if view === 'browser'}{#key host.browserSession()}<BrowserPanel dockState={st} readonly={snap} />{/key}
    {/if}
  {/key}
{/if}

<style>
  .wb-embed { flex: 1; min-height: 0; position: relative; overflow: hidden; transform: translateZ(0); }
  .wb-wait { flex: 1; display: flex; align-items: center; justify-content: center; color: var(--muted); font-size: 14px; padding: 0 24px; text-align: center; line-height: 1.7; }
</style>
