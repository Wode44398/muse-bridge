<script lang="ts">
  // 添加文件（输入框的 ＋ 呼出；App 以 <AttachSheet onclose> 挂载）：从设备上传（文件 / 文件夹），或从工作空间里挑。
  // 上传落进这个对话自己的附件目录（.dimensio/uploads/<会话 id 或草稿 id>/，U4 / K08）：不进项目仓库、随对话删除回收、
  // 保留目录结构；同名不覆盖（服务端加序号，芯片用它回的路径）。上传途中切了会话，也落回发起时的那个会话。
  // 工作空间里挑中的项在切目录、切页签之间都留着，关掉面板才清。
  import { app, toast } from "../../lib/state.svelte.ts";
  import { listDir } from "../../lib/api.ts";
  import { uploadBase, uploadToChat } from "../../lib/attach.svelte.ts";
  import { haptic } from "../../lib/touch.ts";
  import { collapse } from "../../lib/motion.ts";
  import Sheet from "../ui/Sheet.svelte";
  import Segmented from "../ui/Segmented.svelte";
  import Button from "../ui/Button.svelte";
  import Icon from "../ui/Icon.svelte";
  import Measure from "../ui/Measure.svelte";
  import Empty from "../ui/Empty.svelte";
  import Mark from "../brand/Mark.svelte";
  import { isEn, t, tr } from "../../lib/i18n.ts";

  let { onclose }: { onclose: () => void } = $props();

  type Tab = "upload" | "browse";
  const TABS: { value: Tab; label: string }[] = [
    { value: "upload", label: t("从设备上传") },
    { value: "browse", label: t("工作空间") },
  ];
  let tab = $state<Tab>("upload");
  function switchTab(next: Tab) {
    haptic("light");
    if (next === "browse") openBrowse();
    else tab = next;
  }

  // ── 从设备上传 ─────────────────────────────────────────────────────────────────────────
  let fileInput: HTMLInputElement | undefined = $state();
  let folderInput: HTMLInputElement | undefined = $state();
  let uploading = $state(false);
  let progress = $state({ done: 0, total: 0 });
  let failed = $state<string[]>([]);

  function picked(e: Event, isFolder: boolean) {
    const input = e.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    input.value = ""; // Q6：清掉，同一个文件再挑一次也会触发 change
    void uploadPicked(files, isFolder);
  }

  async function uploadPicked(files: File[], isFolder: boolean) {
    if (!files.length) return;
    uploading = true;
    failed = [];
    progress = { done: 0, total: files.length };
    const added: string[] = [];
    const folderRoots = new Set<string>();
    const chat = app.chat; // 上传途中切了会话，也落回发起时的那个
    const base = uploadBase(chat);
    for (const f of files) {
      const rel = isFolder && f.webkitRelativePath ? f.webkitRelativePath : f.name;
      try {
        const saved = await uploadToChat(chat, rel, f);
        // 文件夹：每个顶层目录一枚芯片；单个文件：用服务端实际落盘的路径（同名会被加序号）
        if (isFolder && f.webkitRelativePath) folderRoots.add(`${base}/${f.webkitRelativePath.split("/")[0]}/`);
        else added.push(saved);
      } catch {
        failed = [...failed, rel];
      }
      progress = { done: progress.done + 1, total: progress.total };
    }
    uploading = false;
    const paths = [...added, ...folderRoots];
    if (paths.length) {
      chat.attachments = [...new Set([...chat.attachments, ...paths])];
      haptic("light");
      if (!failed.length) onclose();
      else toast(t("{n} 个文件上传失败", { n: failed.length }));
    }
  }

  // ── 从工作空间挑 ───────────────────────────────────────────────────────────────────────
  type Entry = { name: string; dir: boolean; size: number };
  let cwd = $state("");
  let entries = $state<Entry[]>([]);
  let truncated = $state(false);
  let browseError = $state("");
  let loading = $state(false);
  let loadSeq = 0; // 连点面包屑时只认最后一次
  let selected = $state<string[]>([]);

  async function load(p: string) {
    const seq = ++loadSeq;
    browseError = "";
    loading = true;
    try {
      const data = await listDir(p);
      if (seq !== loadSeq) return;
      cwd = data.path === "." ? "" : data.path;
      entries = data.entries;
      truncated = Boolean(data.truncated);
    } catch (e: any) {
      if (seq === loadSeq) browseError = String(e?.message ?? e);
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }
  function openBrowse() {
    tab = "browse";
    void load(cwd);
  }

  const full = (name: string) => (cwd ? `${cwd}/${name}` : name);
  const keyOf = (e: Entry) => full(e.name) + (e.dir ? "/" : "");
  const isSel = (e: Entry) => selected.includes(keyOf(e));
  function toggle(e: Entry) {
    const k = keyOf(e);
    selected = selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k];
    haptic("light");
  }
  const crumbs = $derived.by(() => {
    const out = [{ label: t("工作空间"), path: "" }];
    let acc = "";
    for (const part of cwd ? cwd.split("/") : []) {
      acc = acc ? `${acc}/${part}` : part;
      out.push({ label: part, path: acc });
    }
    return out;
  });
  function addSelected() {
    if (!selected.length) return;
    app.chat.attachments = [...new Set([...app.chat.attachments, ...selected])];
    haptic("light");
    onclose();
  }

  // 整句一个键，里面的路径 {path} 仍渲染成等宽的 .path（按占位拆开）
  const noteParts = t("存进这个对话自己的附件目录（{path}，不进你的项目仓库、随对话删除回收，保留目录结构）；PNG/JPEG/WebP 会原生发送给多模态主模型，其他资源由 agent 按需 Read。").split("{path}");

  const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`);
</script>

{#snippet addFooter()}
  <Button variant="primary" disabled={!selected.length} onclick={addSelected}>{selected.length ? t("添加 ({n})", { n: selected.length }) : t("添加")}</Button>
{/snippet}

<Sheet title={t("添加文件")} {onclose} footer={tab === "browse" ? addFooter : undefined}>
  <div class="tabs">
    <Segmented full label={t("添加方式")} options={TABS} value={tab} onchange={switchTab} />
  </div>

  {#if tab === "upload"}
    <div class="pickers">
      <button class="pick" disabled={uploading} onclick={() => fileInput?.click()}>
        <span class="pic"><Icon name="file" size={22} stroke={1.5} /></span>
        <span>{t("选文件")}</span>
      </button>
      <button class="pick" disabled={uploading} onclick={() => folderInput?.click()}>
        <span class="pic"><Icon name="folder" size={22} stroke={1.5} /></span>
        <span>{t("选文件夹")}</span>
      </button>
    </div>

    {#if uploading || progress.total > 0}
      <div class="progwrap" transition:collapse>
        <div class="prog" role="status">
          <span class="ptext">
            {uploading ? t("上传中") : t("完成")}
            <span class="num">{uploading ? progress.done : progress.done - failed.length}/{progress.total}</span>
          </span>
          <span class="pbar">
            <Measure value={progress.total ? progress.done / progress.total : 0} tone={!uploading && failed.length ? "err" : "accent"} thick label={t("上传进度")} />
          </span>
        </div>
      </div>
    {/if}
    {#if failed.length}
      <p class="fails">{t("失败：{names}", { names: failed.join(isEn() ? ", " : "、") })}</p>
    {/if}
    <p class="note">
      {noteParts[0]}<span class="path">.dimensio/uploads/</span>{noteParts[1]}
    </p>
    <input bind:this={fileInput} type="file" multiple hidden onchange={(e) => picked(e, false)} />
    <input bind:this={folderInput} type="file" webkitdirectory multiple hidden onchange={(e) => picked(e, true)} />
  {:else}
    <nav class="crumbs" aria-label={t("位置")}>
      {#each crumbs as c, i (c.path)}
        {#if i > 0}<span class="csep" aria-hidden="true"><Icon name="chevronR" size={12} /></span>{/if}
        <button class="crumb" class:cur={c.path === cwd} aria-current={c.path === cwd ? "location" : undefined} onclick={() => load(c.path)}>
          {c.label}
        </button>
      {/each}
    </nav>

    {#if browseError}
      <p class="fails">{tr(browseError)}</p>
    {:else if loading && !entries.length}
      <div class="loading" aria-busy="true"><Mark size={24} live /></div>
    {:else}
      <div class="files">
        {#each entries as en (en.name)}
          {@const sel = isSel(en)}
          <div class="fr" class:sel>
            <button class="ck" role="checkbox" aria-checked={sel} aria-label={t("选择 {name}", { name: en.name })} onclick={() => toggle(en)}>
              <span class="cbx">{#if sel}<Icon name="check" size={12} stroke={2.4} />{/if}</span>
            </button>
            <button class="main" onclick={() => (en.dir ? load(full(en.name)) : toggle(en))}>
              <span class="fic"><Icon name={en.dir ? "folder" : "file"} size={16} /></span>
              <span class="nm">{en.name}</span>
              {#if en.dir}
                <span class="arr"><Icon name="chevronR" size={14} /></span>
              {:else}
                <span class="sz">{fmtSize(en.size)}</span>
              {/if}
            </button>
          </div>
        {:else}
          <Empty compact icon="folder" title={t("空目录")} />
        {/each}
        {#if truncated}<p class="note trunc">{t("（列表过长已截断）")}</p>{/if}
      </div>
    {/if}
  {/if}
</Sheet>

<style>
  .tabs {
    margin: 2px 0 16px;
  }

  /* 从设备上传 */
  .pickers {
    display: flex;
    gap: 10px;
  }
  .pick {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 22px 10px 18px;
    border-radius: 16px;
    background: var(--surface2);
    color: var(--text);
    font-size: var(--fs-base);
    font-weight: 500;
    transition:
      background-color var(--t-fast) var(--ease),
      opacity var(--t-fast) var(--ease);
  }
  .pic {
    display: inline-flex;
    color: var(--text2);
  }
  @media (hover: hover) {
    .pick:hover:not(:disabled) {
      background: var(--surface3);
    }
  }
  .pick:active:not(:disabled) {
    background: var(--surface3);
  }
  .pick:disabled {
    opacity: 0.45;
  }
  .prog {
    display: flex;
    align-items: center;
    gap: 12px;
    padding-top: 14px;
  }
  .ptext {
    flex: none;
    font-size: var(--fs-md);
    color: var(--text2);
  }
  .pbar {
    flex: 1;
    min-width: 0;
  }
  .num {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    font-variant-numeric: tabular-nums;
  }
  .fails {
    margin: 12px 0 0;
    font-size: var(--fs-md);
    line-height: var(--lh-ui);
    color: var(--err);
    overflow-wrap: anywhere;
  }
  .note {
    margin: 14px 0 0;
    font-size: var(--fs-sm);
    line-height: 1.6;
    color: var(--text3);
  }
  .path {
    font-family: var(--font-mono);
  }

  /* 从工作空间挑 */
  .crumbs {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px;
    margin: 0 0 8px -6px;
  }
  .crumb {
    padding: 4px 6px;
    border-radius: 7px;
    font-size: var(--fs-md);
    color: var(--text2);
    transition: background-color var(--t-fast) var(--ease);
  }
  .crumb.cur {
    color: var(--text);
    font-weight: 600;
  }
  @media (hover: hover) {
    .crumb:hover {
      background: var(--surface2);
    }
  }
  .crumb:active {
    background: var(--surface3);
  }
  .csep {
    display: inline-flex;
    color: var(--text3);
  }
  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 160px;
    color: var(--text3);
  }
  .files {
    display: flex;
    flex-direction: column;
    min-height: 160px;
    max-height: 46vh;
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 4px;
    border-radius: 14px;
    background: var(--surface2);
  }
  .fr {
    display: flex;
    align-items: center;
    min-height: 40px;
    border-radius: 10px;
    transition: background-color var(--t-fast) var(--ease);
  }
  .fr.sel {
    background: var(--accent-soft);
  }
  @media (hover: hover) {
    .fr:not(.sel):hover {
      background: color-mix(in srgb, var(--text) 5%, transparent);
    }
  }
  .ck {
    align-self: stretch;
    display: inline-flex;
    align-items: center;
    padding: 0 6px 0 10px;
  }
  .cbx {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 6px;
    background: var(--surface);
    box-shadow: inset 0 0 0 1.5px var(--border2);
    color: var(--on-accent);
    transition:
      background-color var(--t-fast) var(--ease),
      box-shadow var(--t-fast) var(--ease);
  }
  .sel .cbx {
    background: var(--accent);
    box-shadow: none;
  }
  .main {
    flex: 1;
    min-width: 0;
    align-self: stretch;
    display: flex;
    align-items: center;
    gap: 9px;
    padding: 0 10px 0 4px;
    text-align: left;
    color: var(--text2);
  }
  .fic {
    display: inline-flex;
    flex: none;
    color: var(--text3);
  }
  .nm {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-base);
    color: var(--text);
  }
  .sz {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  .arr {
    display: inline-flex;
    flex: none;
    color: var(--text3);
  }
  .trunc {
    margin: 8px 8px 4px;
  }
  @media (pointer: coarse) {
    .fr {
      min-height: 44px;
    }
    .crumb {
      padding: 10px 8px;
    }
  }
</style>
