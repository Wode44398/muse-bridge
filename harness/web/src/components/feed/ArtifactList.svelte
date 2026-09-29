<script lang="ts">
  // 产物卡：一个小图标瓦片 + 文件名 +「类型 · 大小」+ ›，悬停浮底。
  //
  // 点开 = 进右侧工作区的【文件】视图读（bridge 内置工作空间页渲染：文件页落到产物所在目录 + 自动弹出面板内预览，读完就地翻
  // 同目录别的文件，比全屏查看器顺手）。路径逃出了工作空间（绝对路径 / ../）或宿主没有文件视图时回落宿主的查看器，
  // 再没有就新窗口。
  // 桌面壳（bridge 附着形态）：产物卡可拖成 Windows 原生文件拖拽（Explorer / 微信输入框）。harness 前端要能脱离 bridge 跑，
  // 所以只 feature-detect 壳桥 window.BridgeDesktop.drag，不引 bridge 的模块；绝对路径 = 会话工作空间 + 相对路径（bridge 三形态都跑在本机）。
  import { app, openDockFiles, type ArtifactItem } from "../../lib/state.svelte.ts";
  import * as api from "../../lib/api.ts";
  import { press } from "../../lib/motion.ts";
  import Icon from "../ui/Icon.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let {
    items,
    onOpenArtifact = null,
  }: { items: ArtifactItem[]; onOpenArtifact?: ((artifact: ArtifactItem, sessionId: string) => void) | null } = $props();

  const shellDrag = (): any => (globalThis as any).BridgeDesktop?.drag ?? null;
  const dragOutOn = Boolean(shellDrag()?.start);

  function dragOut(e: DragEvent, artifact: ArtifactItem) {
    const d = shellDrag();
    const ws = String(pane.chat.cfg?.workspace || "");
    if (!d?.start || !ws) return;
    e.preventDefault();
    const rel = artifact.path.replace(/\\/g, "/");
    const abs = /[\\/]$/.test(ws) ? ws + rel : ws + "/" + rel;
    Promise.resolve(d.start([abs])).catch(() => {});
  }

  // artifact.path 是工作空间内的相对路径（服务端 sandbox.rel）；逃出工作空间时它是绝对路径
  function openArtifact(artifact: ArtifactItem) {
    if (!pane.chat.id) return;
    const rel = artifact.path.replace(/\\/g, "/");
    const escaped = /^([A-Za-z]:)?\//.test(rel) || rel.startsWith("../");
    if (app.hasFilesView && !escaped) {
      const cut = rel.lastIndexOf("/");
      openDockFiles({ rel: cut > 0 ? rel.slice(0, cut) : "", open: rel.slice(cut + 1) });
      return;
    }
    if (onOpenArtifact) onOpenArtifact(artifact, pane.chat.id);
    // guard: window-open ok — 没有宿主查看器（独立 8799 / 预览）时的兜底：新窗口开产物
    else window.open(api.artifactUrl(pane.chat.id, artifact.path), "_blank", "noopener,noreferrer");
  }

  function formatBytes(value: number): string {
    if (!value) return t("文件");
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
    return `${(value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`;
  }
  function artifactLabel(a: ArtifactItem): string {
    return a.kind === "image" ? t("图片") : a.kind === "video" ? t("视频") : a.kind === "audio" ? t("音频") : a.kind === "pdf" ? "PDF" : a.kind === "office" ? t("文档") : t("文件");
  }
</script>

<div class="arts" role="group" aria-label={t("生成的文件")}>
  {#each items as a (a.path)}
    <button
      class="art"
      draggable={dragOutOn ? "true" : undefined}
      ondragstart={(e) => dragOut(e, a)}
      onclick={() => openArtifact(a)}
      title={t("打开 {path}", { path: a.path })}
      use:press={{ scale: 0.985 }}
    >
      <span class="tile"><Icon name={a.kind === "image" ? "image" : "file"} size={18} /></span>
      <span class="txt">
        <span class="name">{a.name}</span>
        <span class="sub">{artifactLabel(a)}{a.size ? ` · ${formatBytes(a.size)}` : ""}</span>
      </span>
      <span class="go"><Icon name="chevronR" size={15} stroke={1.8} /></span>
    </button>
  {/each}
</div>

<style>
  .arts {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: min(360px, 100%);
    margin-left: -8px;
  }
  .art {
    display: flex;
    align-items: center;
    gap: 11px;
    width: 100%;
    min-height: 52px;
    padding: 6px 10px 6px 8px;
    border-radius: 14px;
    text-align: left;
    color: var(--text);
    transition: background-color var(--t-fast) var(--ease);
  }
  .tile {
    display: grid;
    place-items: center;
    flex: none;
    width: 38px;
    height: 38px;
    border-radius: 11px;
    background: var(--surface2);
    color: var(--text2);
    transition: background-color var(--t-fast) var(--ease);
  }
  .txt {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-base);
    font-weight: 500;
  }
  .sub {
    font-size: var(--fs-sm);
    color: var(--text3);
  }
  .go {
    display: inline-flex;
    flex: none;
    color: var(--text3);
  }
  .art:active {
    background: var(--surface2);
  }
  @media (hover: hover) {
    .art:hover {
      background: var(--surface2);
    }
    .art:hover .tile {
      background: var(--surface3);
    }
  }
</style>
