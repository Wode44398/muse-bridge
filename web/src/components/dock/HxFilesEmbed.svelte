<script>
  // dimensio 工作台「文件」视图的宿主实现：把 bridge 的完整工作空间页（FilesPanel +
  // 面板内 MediaViewer）注入 harness 的 Dock（经 HarnessPage 的 filesView snippet）。
  // dimensio 自己的文件浏览前端已删——单一真相源，长按菜单/文档三态编辑/实时跟盘等
  // 能力全部随 bridge 侧演进，不再两边各修一份。
  // ws 是 dimensio 会话的工作空间绝对路径：/api/files?ws= 会在服务端 authorizeProjectPath
  // 再授权一次（admin 任意已存在目录放行，普通身份按基目录约束）。
  import WorkspaceEmbed from './WorkspaceEmbed.svelte';
  import { ui } from '../../lib/state.svelte.js';
  import { layout } from '../../lib/layout.svelte.js';
  import MediaViewer from '../preview/MediaViewer.svelte';
  import { preview, closePreview } from '../../lib/preview.svelte.js';

  // target = 文件视图的定位目标（dimensio 的产物卡点开）：{ seq, rel, open }。
  // seq 递增让 {#key} 每次都重挂 FilesPanel——initialPath/initialOpen 是挂载时
  // 一次性消费的，连点两个产物也要每次都落到对的目录。
  let { ws = '', target = null, onExit = null } = $props();
  // 明暗跟 dimensio 自己的档（跟系统 / 浅 / 深），不跟 bridge 全站主题：HarnessPage 已把它同步进
  // ui.pageChrome。没有它（理论上不会）才退回跟全站。
  const theme = $derived(ui.pageChrome ? (ui.pageChrome.dark ? 'dark' : 'light') : '');
  const rootName = $derived(ws ? (ws.split(/[\\/]/).filter(Boolean).pop() || '') : '');
  const mountKey = $derived(ws + '|' + (target ? target.seq : ''));

  // 卸载（关工作区/切工具/换会话）时若本实例还开着预览，一并收掉——
  // 否则 preview.host='hx-files' 没有实例渲染，返回层还压着一层幽灵预览（同 ClaudeDock）。
  $effect(() => () => { if (preview.open && preview.host === 'hx-files') closePreview(); });
</script>

<!-- wide：dimensio 的工作台自己管形态，这里按视口档位判「是不是侧列」——与 Claude 工作台同一条规矩 -->
{#key mountKey}
  <WorkspaceEmbed
    wide={layout.side}
    ws={ws}
    rootName={rootName}
    initialPath={target?.rel || ''}
    initialOpen={target?.open || ''}
    {theme}
    previewHost="hx-files"
    onExit={onExit}
  />
  <MediaViewer host="hx-files" />
{/key}
