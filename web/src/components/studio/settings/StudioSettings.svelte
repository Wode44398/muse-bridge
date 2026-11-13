<script>
  // 设置 › Media Studio 的正文（懒加载入口：核心的两套设置外壳只经 modules/pages.js 的 loadPage.studioSettings 取它，
  // 不许静态 import——本目录与 modules/studio/** 都归 studio 扩展，见 web/scripts/module-chunks.mjs）。
  //
  // shell = 'ios'：手机 / 网页那套（components/Settings.svelte，iOS 27 设置 App）。推入式导航，外壳每一层页都挂一份本组件，
  //   page 指明是哪一页：'studio' 主页；'st:def:<种类>' 某种类的默认模型；'st:ch:<键>' 某个枚举项的单选。
  //   push(pid, title) 由外壳给（子页标题跟着传过去，外壳不认识 studio 的键）。
  // shell = 'desk'：桌面那套（desktop/settings/SettingsDesktop.svelte，macOS 系统设置风），单页，fl(id) 是搜索跳转后的行闪烁。
  //
  // 颜色：两套外壳各有令牌（手机 --i-*、桌面 --dsk-*），根上统一成 --c-*（子组件只读这一组），种类不着色（方案 §5.2）。
  // 浮层（媒体服务管理器、保存位置选择器）挂在主页这一份上；开着时经 onModal 告诉外壳（手机外壳据此让出顶栏那层 backdrop）。
  import { onMount } from 'svelte';
  import StudioBodyIos from './StudioBodyIos.svelte';
  import StudioBodyDesk from './StudioBodyDesk.svelte';
  import MediaProviderManager from './MediaProviderManager.svelte';
  import FolderPicker from './FolderPicker.svelte';
  import { loadAll, setSetting, valueOf } from '../../../modules/studio/settings.svelte.js';
  import { t } from '../../../lib/i18n.js';

  let { shell = 'ios', dark = false, page = 'studio', push = null, fl = () => false, agentIds = null, onModal = () => {} } = $props();

  const main = $derived(shell === 'desk' || page === 'studio');
  let mgr = $state(null);        // null | { view, id? }
  let picking = $state(false);   // 保存位置选择器
  $effect(() => { if (main) onModal(!!mgr || picking); });
  onMount(() => { if (main) loadAll(); });

  const openMgr = (init = { view: 'list' }) => { mgr = init; };
  const openFolder = () => { picking = true; };
  async function pickFolder(p) { picking = false; await setSetting('saveDir', p || ''); }
  // 浮层挂到 body 上：两套外壳的正文都在会圈住 fixed 的祖先里（桌面内容列给子元素限了 max-width，手机设置页的 .panel 带 transform），
  // 不挪出去就盖不满整屏。浮层自带令牌（--st-* 等），不依赖这里的 --c-*。
  function portal(node) { document.body.appendChild(node); return { destroy() { node.remove(); } }; }
</script>

<div class="sst" class:dark class:desk={shell === 'desk'}>
  {#if shell === 'desk'}
    <StudioBodyDesk {fl} {agentIds} {openMgr} {openFolder} />
  {:else}
    <StudioBodyIos {page} {push} {agentIds} {openMgr} {openFolder} />
  {/if}
</div>

{#if mgr}<div class="sst-layer" use:portal><MediaProviderManager initial={mgr} onClose={() => (mgr = null)} /></div>{/if}
{#if picking}<div class="sst-layer" use:portal><FolderPicker value={String(valueOf('saveDir') || '')} title={t('保存位置')} onPick={pickFolder} onClose={() => (picking = false)} /></div>{/if}

<style>
  .sst {
    --c-bg: var(--i-bg, var(--dsk-bg));
    --c-card: var(--i-card, var(--dsk-panel));
    --c-ink: var(--i-label, var(--dsk-ink));
    --c-ink2: var(--i-label2, var(--dsk-ink-2));
    --c-ink3: var(--i-label3, var(--dsk-ink-3));
    --c-line: var(--i-sep, var(--dsk-line));
    --c-sunk: var(--i-fill4, var(--dsk-hover));
    --c-press: var(--i-press, var(--dsk-active));
    --c-accent: var(--i-accent, var(--dsk-accent));
    --c-on: var(--i-on-accent, var(--dsk-accent-ink));
    --c-ok: var(--i-ok, var(--dsk-ok));
    --c-warn: var(--i-warn, var(--dsk-warn));
    --c-red: var(--i-red, var(--dsk-crit));
    --c-tile: var(--i-tile, var(--sd-tile, rgba(127, 127, 127, .08)));
    color: var(--c-ink);
    text-wrap: pretty;
  }
</style>
