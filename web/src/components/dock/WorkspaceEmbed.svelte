<script>
  // 工作台侧栏里的「工作空间」——电脑上就该是电脑的样子。
  //
  // 从前侧栏恒挂手机版 FilesPanel：在 PC 上是一列 56px 高的大行、没有列、没有右键、
  // 没有键盘，和同一台机器上整页工作空间（FilesDesktop 那套 Explorer 级密度）完全两个东西。
  // 这里把「挂哪一套」收成【唯一一个判断点】，Claude 工作台 / dimensio 工作台共用：
  //   · 侧列形态 + 精确指针（鼠标/触控板）→ FilesDesktop（内嵌形态）
  //   · 手机 / 触屏 / 底部 sheet        → FilesPanel（iOS 文件 app 那套）
  // 折叠屏展开态宽度够但仍是手指，所以判据必须是「宽 + 指针精度」两条，缺一不可。
  //
  // 公开快照访客恒走 FilesPanel：只有它有 guest 形态（去掉分享铸造/发给 AI 这些不属于访客的入口）。
  import FilesPanel from '../FilesPanel.svelte';
  import FilesDesktop from '../FilesDesktop.svelte';
  import { pointer } from '../../lib/layout.svelte.js';

  let {
    wide = false, guest = false, ws = '', rootName = '', initialPath = null, initialOpen = '',
    previewHost = '', onExit = null,
    // theme：''＝跟全站 data-theme；'light'/'dark'＝宿主自有明暗档（dimensio），强制跟宿主
    theme = '',
  } = $props();

  const desktopUi = $derived(wide && pointer.fine && !guest);
</script>

{#if desktopUi}
  <FilesDesktop embedded workspaceRoot={ws} {rootName} {initialPath} {initialOpen} {previewHost} {onExit} {theme} />
{:else}
  <FilesPanel {guest} workspaceRoot={ws} {rootName} {initialPath} {initialOpen} {previewHost} {onExit} {theme} />
{/if}
