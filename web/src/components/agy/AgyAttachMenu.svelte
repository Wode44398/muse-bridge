<script>
  // 输入框加号的触屏菜单（Claude 加号菜单的照片入口同款）：照片 = 只收图片的选择器（安卓壳见 accept 全是 image/*
  // 就开系统照片选择器：相册网格、按时间倒序），文件 = 普通文件选择器。桌面不出这个菜单，加号直接选文件。
  // 两个 <input type=file> 留在 Composer 里：菜单关掉就卸载了，选择器的 change 要落在还活着的元素上。
  import { untrack } from 'svelte';
  import { t } from '../../lib/i18n.js';
  import AgyPopover from './AgyPopover.svelte';

  const { anchorEl = null, onPhotos, onFiles, onClose } = $props();

  let pop = $state(null);
  // 打开那一刻的位置兜底（锚点被卸载时用）；跟踪由 AgyPopover 按 anchorEl 实时做
  const anchor = untrack(() => {
    const r = anchorEl?.getBoundingClientRect?.();
    return r ? { left: r.left, top: r.top, bottom: r.bottom, width: r.width } : null;
  });

  // 先在点按手势里同步拉起选择器（异步之后浏览器就不认是用户操作了），再收起菜单
  function pick(fn) {
    fn?.();
    if (pop) pop.close();
    else onClose?.();
  }
</script>

<AgyPopover bind:this={pop} {anchor} {anchorEl} width={200} title={t('添加到对话')} {onClose}>
  <button type="button" class="agy-menu-row am-row" onclick={() => pick(onPhotos)}>
    <span class="msr4 row-ico" aria-hidden="true">image</span>
    <span class="row-main"><span class="row-name">{t('照片')}</span></span>
  </button>
  <button type="button" class="agy-menu-row am-row" onclick={() => pick(onFiles)}>
    <span class="msr4 row-ico" aria-hidden="true">attach_file</span>
    <span class="row-main"><span class="row-name">{t('文件')}</span></span>
  </button>
</AgyPopover>

<style>
  /* 触屏专用：行高按手指来 */
  .agy-menu-row.am-row { min-height: 44px; padding: 8px 12px; }
</style>
