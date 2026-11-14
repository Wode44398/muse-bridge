<script>
  // Composer 加号菜单（claude.ai 原版子集）：Add files or photos / 挂载文件夹 / Research / 输出风格。
  // 图标见 lib/menuIcons.svelte.js（原版字形），viewBox 20、fill currentColor。
  // 2026-11-13：「回复语气」（claude.ai 的 Use style）与「输出风格」合并——只留输出风格（给【这个会话】单选 Claude Code
  // 输出风格，官方会话菜单 Output style 同款，lib/outputStyle），占回复语气原来的位置、沿用它的羽毛图标与子菜单行样式。
  import { settings } from '../lib/state.svelte.js';
  import { menuIcon } from '../lib/menuIcons.svelte.js';
  import { pushBackLayer } from '../lib/nav.js';
  import { IS_CSNAP } from '../lib/csnap.js';
  import { t } from '../lib/i18n.js';
  import { cs } from '../lib/claudeSettings.svelte.js';
  import { ostyle, outputStyleLabel, outputStyleDesc, outputStyleOptions, currentOutputStyle, loadSessionOutputStyle, setSessionOutputStyle } from '../lib/outputStyle.svelte.js';
  import { uiIcon } from '../lib/pluginUi.svelte.js';
  // pluginActions：插件登记的「＋」菜单项（ctx.ui.composerAction，lib/pluginUi）；按下交给 onPluginAction（Composer 带上输入框文字去调插件）
  // startView：工具条上的输出风格芯片点开时直接进子菜单
  let { onClose, onPickFiles, onPickPhotos, onPickFolder, dir = 'up', pluginActions = [], onPluginAction = null, startView = 'main' } = $props();

  let view = $state(startView === 'ostyle' && !IS_CSNAP ? 'ostyle' : 'main'); // 'main' | 'ostyle'

  // 安卓系统返回沿内部视图逐级退（风格→主菜单→关闭）；卸载自动出栈。
  $effect(() => pushBackLayer(() => {
    if (view === 'ostyle') { view = 'main'; return; }
    onClose?.();
  }));
  const close = () => onClose && onClose();
  function files() { close(); onPickFiles && onPickFiles(); }
  function photos() { close(); onPickPhotos && onPickPhotos(); }
  function folder() { close(); onPickFolder && onPickFolder(); }
  function toggleResearch() { settings.research = !settings.research; close(); }

  // —— 输出风格（这个会话）：null = 跟随设置里的默认 ——
  const curOStyle = $derived(currentOutputStyle());
  const defOStyle = $derived(cs.values.outputStyle || 'default');
  const oStyleName = $derived(curOStyle == null ? outputStyleLabel(defOStyle) : outputStyleLabel(curOStyle));
  // 设置里的默认就是「默认」风格时，单列的「默认」和「跟随默认（默认）」是一回事：不重复列（会话已显式选了「默认」的照列）
  const oStyleList = $derived(outputStyleOptions().filter((v) => v !== 'default' || defOStyle.toLowerCase() !== 'default' || curOStyle === 'default'));
  function openOStyle() { view = 'ostyle'; loadSessionOutputStyle(); }
  // 菜单一打开主行就要显示对：这个会话的覆盖本地还没有（别的设备改的、重载后没走 loadSession 的）就先补拉
  if (!IS_CSNAP && currentOutputStyle() === undefined) loadSessionOutputStyle();
  async function pickOStyle(v) { if (await setSessionOutputStyle(v)) close(); }

</script>

<button class="am-backdrop" aria-label={t('关闭')} onclick={close}></button>
<div class="am" class:down={dir === 'down'} role="menu">
  {#if view === 'main'}
    <!-- 照片专用入口：安卓壳见 accept 全是 image/* 就开系统照片选择器（相册网格、按时间倒序），
         不再进文件管理器翻目录；电脑上是只列图片的文件对话框。 -->
    {#if onPickPhotos}
      <button class="am-row" onclick={photos}>
        <svg class="am-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4.5" width="17" height="15" rx="2.7"/><circle cx="9" cy="9.7" r="1.6"/><path d="m4 17.2 4.6-4.6a1.6 1.6 0 0 1 2.2 0l5.7 5.7"/><path d="m14.3 15.4 1.6-1.6a1.6 1.6 0 0 1 2.2 0l2.4 2.4"/></svg>
        <span class="am-name">Add photos</span>
      </button>
    {/if}
    <button class="am-row" onclick={files}>
      <svg class="am-ic" viewBox="0 0 20 20" fill="currentColor"><path d={menuIcon('paperclip')} /></svg>
      <span class="am-name">{onPickPhotos ? 'Add files' : 'Add files or photos'}</span>
    </button>
    <!-- 挂载文件夹：整树传上去，Claude 用 Read/Glob/Grep 按需读（不塞进上下文） -->
    <button class="am-row" onclick={folder}>
      <svg class="am-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 7.2c0-1.5 1.2-2.7 2.7-2.7h3.4l2 2.3h6.2c1.5 0 2.7 1.2 2.7 2.7v8.3c0 1.5-1.2 2.7-2.7 2.7H6.2c-1.5 0-2.7-1.2-2.7-2.7z"/></svg>
      <span class="am-name">{t('挂载文件夹')}</span>
    </button>
    <div class="am-div"></div>
    <!-- 快照模式后端强制 research=false（子 agent 成本），开关一并隐藏免得看着能开实际无效 -->
    {#if !IS_CSNAP}
      <button class="am-row" onclick={toggleResearch}>
        <svg class="am-ic" viewBox="0 0 20 20" fill="currentColor"><path d={menuIcon('research')} /></svg>
        <span class="am-name">Research</span>
        {#if settings.research}<span class="am-check">✓</span>{/if}
      </button>
      <button class="am-row" onclick={openOStyle}>
        <svg class="am-ic" viewBox="0 0 20 20" fill="currentColor"><path d={menuIcon('feather')} /></svg>
        <span class="am-name">{t('输出风格')}</span><span class="am-right">{oStyleName} ›</span>
      </button>
    {/if}
    {#if pluginActions.length && onPluginAction}
      <div class="am-div"></div>
      {#each pluginActions as a (a.plugin + '/' + a.id)}
        <button class="am-row" title={a.pluginName} onclick={() => { close(); onPluginAction(a); }}>
          <span class="am-ic am-plg" aria-hidden="true">{@html uiIcon(a.icon)}</span>
          <span class="am-name">{a.label}</span><span class="am-right am-from">{a.pluginName}</span>
        </button>
      {/each}
    {/if}
  {:else if view === 'ostyle'}
    <button class="am-back" onclick={() => (view = 'main')}>{t('‹ 返回')}</button>
    <p class="am-note">{t('只改这个会话，下一条消息起生效')}</p>
    <button class="am-row" disabled={ostyle.busy} onclick={() => pickOStyle(null)}>
      <svg class="am-ic" viewBox="0 0 20 20" fill="currentColor"><path d={menuIcon('feather')} /></svg>
      <span class="am-name">{t('跟随默认（{name}）', { name: outputStyleLabel(defOStyle) })}</span>
      {#if curOStyle == null}<span class="am-check">✓</span>{/if}
    </button>
    <div class="am-div"></div>
    {#each oStyleList as v (v)}
      <button class="am-row two" disabled={ostyle.busy} onclick={() => pickOStyle(v)}>
        <svg class="am-ic" viewBox="0 0 20 20" fill="currentColor"><path d={menuIcon('feather')} /></svg>
        <span class="am-tx"><span class="am-name">{outputStyleLabel(v)}</span>{#if outputStyleDesc(v)}<span class="am-sub">{outputStyleDesc(v)}</span>{/if}</span>
        {#if curOStyle != null && curOStyle.toLowerCase() === v.toLowerCase()}<span class="am-check">✓</span>{/if}
      </button>
    {/each}
    {#if ostyle.err}<p class="am-note err">{ostyle.err}</p>{/if}
  {/if}
</div>

<style>
  .am-backdrop { position: fixed; inset: 0; z-index: 60; }
  .am {
    position: absolute; bottom: calc(100% + 8px); left: 0; z-index: 61;
    min-width: 246px; max-width: 88vw; padding: 6px;
    background: var(--q-card); border-radius: 16px; box-shadow: var(--q-shadow);
    max-height: 60vh; overflow-y: auto;
  }
  .am.down { bottom: auto; top: calc(100% + 8px); }
  .am-row { width: 100%; display: flex; align-items: center; gap: 11px; padding: 10px 12px; border-radius: 11px; text-align: left; }
  .am-row:active { background: var(--hover); }
  .am-ic { width: 20px; height: 20px; color: var(--serif); flex: none; }
  .am-name { font-size: 15px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .am-right { margin-left: auto; font-size: 13px; color: var(--muted); }
  /* 插件项：图标是插件给的名字（lib/pluginIcons），右侧小字标出自哪个插件 */
  .am-plg { display: flex; }
  .am-plg :global(svg) { width: 100%; height: 100%; }
  .am-from { flex: none; max-width: 40%; padding-left: 10px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; }
  /* claude 页配色铁律：除星芒图标外全部黑白灰——勾选/按钮不用 coral（审美统一）。 */
  .am-check { margin-left: auto; color: var(--text); font-size: 15px; padding-right: 10px; }
  .am-div { height: 1px; background: var(--divider); margin: 5px 8px; }
  .am-back { width: 100%; padding: 8px 12px; color: var(--muted); font-size: 14px; text-align: left; }
  /* 输出风格子菜单：两行行（名 + 一行说明）、顶部一句作用范围 */
  .am-row.two { align-items: flex-start; }
  .am-row:disabled { opacity: .55; }
  .am-tx { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .am-sub { font-size: 12.5px; line-height: 17px; color: var(--muted); white-space: normal; }
  .am-row.two .am-ic { margin-top: 1px; }
  .am-row.two .am-check { align-self: center; }
  .am-note { margin: 0; padding: 2px 12px 6px; font-size: 12.5px; line-height: 17px; color: var(--muted); }
  .am-note.err { color: var(--crit, #c43c3c); padding-top: 6px; }
</style>
