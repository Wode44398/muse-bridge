<script>
  // Claude 工作台里的插件标签（ctx.ui.workbench，插件接口四期）：一张卡 = 插件 web/ 下的一个页面。
  // 网页 / 桌面壳：嵌 PluginFrame（不透明源 iframe + 宿主代发请求），把当前会话 / 工作目录作为 context 推给页面
  //   （SDK 的 bridge.context() / bridge.on('context')），切会话时再推一次。
  // 手机 App：主 WebView 的原生桥对所有帧可见，绝不内嵌第三方页面——lib/dock 打开时已经转去原生干净页面；
  //   万一这张卡还是摆出来了（比如 App 里旧的卡片状态），只给一个「打开」按钮，同一条路。
  import PluginFrame from '../ext/PluginFrame.svelte';
  import { inAndroidApp } from '../../lib/pluginPanels.svelte.js';
  import { openWorkbenchStandalone } from '../../lib/pluginUi.svelte.js';
  import { dockContext } from '../../lib/dock.svelte.js';
  import { t } from '../../lib/i18n.js';

  let { w } = $props();
  const app = inAndroidApp();
  const context = $derived(dockContext());
</script>

<div class="pw">
  {#if app}
    <div class="pw-app">
      <p>{t('插件页面在独立页面里打开')}</p>
      <button type="button" onclick={() => openWorkbenchStandalone(w, dockContext())}>{t('打开「{name}」', { name: w.title })}</button>
    </div>
  {:else}
    {#key w.plugin + '/' + w.page}
      <PluginFrame id={w.plugin} page={w.page} mode="panel" {context} />
    {/key}
  {/if}
</div>

<style>
  .pw { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; }
  .pw :global(.pf.panel) { flex: 1; min-height: 0; height: auto; }
  .pw-app { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; text-align: center; }
  .pw-app p { margin: 0; font-size: 14px; color: var(--muted); }
  .pw-app button { padding: 9px 18px; border-radius: 10px; background: var(--text); color: var(--bg); font-size: 14px; font-weight: 500; max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
