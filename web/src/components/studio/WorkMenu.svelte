<script>
  // 作品菜单（v3）：dimensio Popover + MenuItem / MenuLabel / MenuSep——「接着做」一组（平铺不嵌套，按目录里有没有模型
  // 接得了来显隐）→ 在画布中打开 / 存进工作空间 或 在文件中显示 / 下载 / 删除。鼠标、触屏同一种菜单（触屏行高 44）；
  // 「…」点出来的贴着整行上下沿开（不盖住这一行），右键点出来的锚在鼠标位置。
  // only='continue'：画布上作品下面的「接着做」钮，只出接着做那一组。
  import { t } from '../../lib/i18n.js';
  import { uiConfirm } from '../../lib/dialogs.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { layout } from '../../lib/layout.svelte.js';
  import { studio, continueActions, continueWith, openAsset, deleteAsset, saveAsset, mediaSrc, saveSide, reuseParams } from '../../modules/studio/media.svelte.js';
  import { visual } from '../../modules/studio/kinds.js';
  import { icon, ROLE_ICON } from '../../modules/studio/icons.js';
  import Popover from './ui/Popover.svelte';
  import Layer from './ui/Layer.svelte';

  let { asset, anchor = null, at = null, only = '', align = '', onclose } = $props();

  const actions = $derived(continueActions(asset));
  // 先把 asset 拍下来再关菜单：菜单一关组件就卸载，之后再读 props 拿到的是空的
  function act(fn) { return async () => { const a = asset; onclose?.(); await fn(a); }; }
  const doContinue = (id) => act((a) => { continueWith(a, id); if (!layout.expanded) studio.drawer = false; });
  const doOpen = act((a) => { openAsset(a); if (!layout.expanded) studio.drawer = false; });
  const doReuse = act((a) => { reuseParams(a); if (!layout.expanded) studio.drawer = false; });
  const doReveal = act((a) => {
    const p = String(a.wsPath || '');
    const i = p.lastIndexOf('/');
    studio.filesTarget = { dir: i > 0 ? p.slice(0, i) : '', open: p, seq: Date.now() };
    studio.side.tab = 'files'; saveSide();
    if (!layout.expanded) studio.drawer = true; else studio.side.pinned = true;
  });
  const doSave = act(async (a) => {
    const r = await saveAsset(a.id, studio.saveDir);
    if (r && r.ok !== false) showToast(t('已存进工作空间'));
    else showToast(r?.error || t('保存失败'), 'err');
  });
  const doDelete = act(async (a) => {
    if (!(await uiConfirm(t('删除这件作品？'), { detail: t('工作空间里已经存下的文件不受影响。'), okLabel: t('删除'), type: 'warning', danger: true }))) return;
    const r = await deleteAsset(a.id);
    if (!r.ok) showToast(r.error ? t('删除失败：{reason}', { reason: r.error }) : t('删除失败'), 'err');
  });
  const doDownload = act((a) => {
    const el = document.createElement('a');
    el.href = mediaSrc(a); el.download = (a.prompt || 'studio').slice(0, 40);
    document.body.appendChild(el); el.click(); el.remove();
  });
  const contIcon = (id) => (id === 'music' ? 'music' : id === 'voice' ? 'voice' : id === 'vref' ? 'ref' : id === 'vvideo' ? 'video' : id === 'vaudio' ? 'audio' : ROLE_ICON[id] || 'image');

  // 锚：右键 = 鼠标位置；作品行的「…」= 贴着整行上下沿（avoid），右对齐行尾
  const row = $derived(at ? null : anchor?.closest?.('.wr, [data-work]') || null);
  const point = $derived(at ? { getBoundingClientRect: () => ({ left: at.x, right: at.x, top: at.y, bottom: at.y, width: 0, height: 0 }), contains: () => false } : anchor);
  const avoid = $derived.by(() => { const r = row?.getBoundingClientRect?.(); return r ? { top: r.top, bottom: r.bottom } : null; });
</script>

{#snippet items()}
  {#if actions.length}
    {#if !only}<div class="wm-sec">{t('接着做')}</div>{/if}
    {#each actions as c (c.id)}
      <button class="wm-i" role="menuitem" onclick={doContinue(c.id)}>{@html icon(contIcon(c.id))}{c.label}</button>
    {/each}
    {#if !only}<div class="wm-sep"></div>{/if}
  {/if}
  {#if !only}
    <button class="wm-i" role="menuitem" onclick={doOpen}>{@html icon('open')}{t('在画布中打开')}</button>
    <button class="wm-i" role="menuitem" onclick={doReuse}>{@html icon('reuse')}{t('复用参数')}</button>
    {#if asset.wsPath}
      <button class="wm-i" role="menuitem" onclick={doReveal}>{@html icon('reveal')}{t('在文件中显示')}</button>
    {:else}
      <button class="wm-i" role="menuitem" onclick={doSave}>{@html icon('save')}{t('存进工作空间')}</button>
    {/if}
    <button class="wm-i" role="menuitem" onclick={doDownload}>{@html icon('download')}{t('下载')}</button>
    <div class="wm-sep"></div>
    <button class="wm-i danger" role="menuitem" onclick={doDelete}>{@html icon('trash')}{t('删除')}</button>
  {/if}
{/snippet}

{#if layout.compact}
  <Layer title={only ? t('接着做') : String(asset.prompt || t('（无提示词）')).replace(/\s+/g, ' ')} sheet role="menu" {onclose}>{@render items()}</Layer>
{:else}
  <Popover anchor={point} {avoid} align={align || (at ? 'start' : 'end')} role="menu" label={t('作品')} width={only ? 236 : 256} {onclose}>{@render items()}</Popover>
{/if}
