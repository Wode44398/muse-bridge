<script lang="ts">
  let { onclose, onadd } = $props<{
    onclose: () => void;
    onadd: (paths: string[]) => void;
  }>();

  let tab = $state<"upload" | "browse">("upload");

  // ── Upload (device → workspace, one raw-body POST per file) ────────────────
  let fileInput = $state<HTMLInputElement>();
  let folderInput = $state<HTMLInputElement>();
  let uploading = $state(false);
  let progress = $state({ done: 0, total: 0 });
  let failed = $state<string[]>([]);

  async function uploadPicked(list: FileList | null, isFolder: boolean) {
    const files = [...(list ?? [])];
    if (!files.length) return;
    uploading = true;
    failed = [];
    progress = { done: 0, total: files.length };
    const added: string[] = [];
    const folderRoots = new Set<string>();
    for (const f of files) {
      const relName =
        isFolder && (f as any).webkitRelativePath ? (f as any).webkitRelativePath : f.name;
      const dest = `uploads/${relName}`;
      try {
        const res = await fetch(`/api/files/upload?path=${encodeURIComponent(dest)}`, {
          method: "POST",
          headers: { "content-type": "application/octet-stream" },
          body: f,
        });
        if (!res.ok) throw new Error(String(res.status));
        if (isFolder && (f as any).webkitRelativePath) {
          folderRoots.add(`uploads/${(f as any).webkitRelativePath.split("/")[0]}/`);
        } else {
          added.push(dest);
        }
      } catch {
        failed.push(relName);
      }
      progress = { done: progress.done + 1, total: progress.total };
    }
    uploading = false;
    const paths = [...added, ...folderRoots];
    if (paths.length) {
      onadd(paths);
      if (!failed.length) onclose();
    }
  }

  // ── Browse (pick existing workspace files/folders) ──────────────────────────
  type Entry = { name: string; dir: boolean; size: number };
  let cwd = $state("");
  let entries = $state<Entry[]>([]);
  let truncated = $state(false);
  let browseError = $state("");
  let selected = $state<string[]>([]);

  async function load(p: string) {
    browseError = "";
    try {
      const r = await fetch(`/api/files?path=${encodeURIComponent(p)}`);
      if (!r.ok) throw new Error((await r.json()).error ?? r.status);
      const data = await r.json();
      cwd = data.path === "." ? "" : data.path;
      entries = data.entries;
      truncated = data.truncated;
    } catch (e: any) {
      browseError = String(e?.message ?? e);
    }
  }

  function openBrowse() {
    tab = "browse";
    load(cwd);
  }

  const full = (name: string) => (cwd ? `${cwd}/${name}` : name);
  const key = (e: Entry) => full(e.name) + (e.dir ? "/" : "");

  function toggle(e: Entry) {
    const k = key(e);
    selected = selected.includes(k) ? selected.filter((x) => x !== k) : [...selected, k];
  }

  function crumbs(): { label: string; path: string }[] {
    const out = [{ label: "workspace", path: "" }];
    if (!cwd) return out;
    let acc = "";
    for (const part of cwd.split("/")) {
      acc = acc ? `${acc}/${part}` : part;
      out.push({ label: part, path: acc });
    }
    return out;
  }

  function addSelected() {
    if (!selected.length) return;
    onadd(selected);
    onclose();
  }

  const fmtSize = (n: number) =>
    n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(0)} KB` : `${n} B`;
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onclose()} />

<div class="overlay">
  <button class="backdrop" aria-label="Close attach dialog" onclick={onclose}></button>
  <div class="panel">
    <div class="head">
      <h2>Add files</h2>
      <button class="x" onclick={onclose}>✕</button>
    </div>

    <div class="tabs">
      <button class:on={tab === "upload"} onclick={() => (tab = "upload")}>Upload from device</button>
      <button class:on={tab === "browse"} onclick={openBrowse}>From workspace</button>
    </div>

    {#if tab === "upload"}
      <div class="upload">
        <p class="hint">
          Files land in the workspace under <code>uploads/</code> (folder structure preserved), so
          the agent can Read them.
        </p>
        <div class="pickers">
          <button class="pick" disabled={uploading} onclick={() => fileInput?.click()}>
            📄 Choose files…
          </button>
          <button class="pick" disabled={uploading} onclick={() => folderInput?.click()}>
            📁 Choose a folder…
          </button>
        </div>
        <input
          bind:this={fileInput}
          type="file"
          multiple
          hidden
          onchange={(e) => uploadPicked((e.target as HTMLInputElement).files, false)}
        />
        <input
          bind:this={folderInput}
          type="file"
          webkitdirectory
          multiple
          hidden
          onchange={(e) => uploadPicked((e.target as HTMLInputElement).files, true)}
        />
        {#if uploading}
          <p class="prog">Uploading {progress.done}/{progress.total}…</p>
        {/if}
        {#if failed.length}
          <p class="fail">Failed: {failed.join(", ")}</p>
        {/if}
      </div>
    {:else}
      <div class="browse">
        <div class="crumbs">
          {#each crumbs() as c, i}
            {#if i > 0}<span class="sep">/</span>{/if}
            <button class="crumb" onclick={() => load(c.path)}>{c.label}</button>
          {/each}
        </div>
        {#if browseError}
          <p class="fail">{browseError}</p>
        {:else}
          <div class="list">
            {#if !entries.length}
              <p class="hint">(empty directory)</p>
            {/if}
            {#each entries as e (e.name)}
              <div class="row">
                <input
                  type="checkbox"
                  checked={selected.includes(key(e))}
                  onchange={() => toggle(e)}
                />
                {#if e.dir}
                  <button class="name dir" onclick={() => load(full(e.name))}>📁 {e.name}/</button>
                {:else}
                  <button class="name" onclick={() => toggle(e)}>📄 {e.name}</button>
                  <span class="size">{fmtSize(e.size)}</span>
                {/if}
              </div>
            {/each}
            {#if truncated}<p class="hint">…listing truncated</p>{/if}
          </div>
        {/if}
        <div class="foot">
          <span class="count">{selected.length} selected</span>
          <button class="add" disabled={!selected.length} onclick={addSelected}>Add selected</button>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    z-index: 40;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    border: none;
  }
  .panel {
    position: relative;
    width: min(560px, calc(100vw - 32px));
    max-height: min(640px, calc(100vh - 48px));
    display: flex;
    flex-direction: column;
    background: var(--bg-elev);
    border: 1px solid var(--border);
    border-radius: 14px;
    padding: 18px;
    animation: pop 0.16s ease;
  }
  @keyframes pop {
    from {
      transform: translateY(8px);
      opacity: 0;
    }
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .head h2 {
    font-size: 16px;
  }
  .x {
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 15px;
  }
  .x:hover {
    color: var(--text);
  }

  .tabs {
    display: flex;
    gap: 6px;
    margin-bottom: 14px;
  }
  .tabs button {
    flex: 1;
    background: var(--bg-elev2);
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: 9px;
    padding: 8px 10px;
    font-size: 13px;
  }
  .tabs button.on {
    color: var(--text);
    border-color: var(--accent);
  }

  .hint {
    color: var(--text-faint);
    font-size: 12.5px;
    line-height: 1.5;
    margin-bottom: 12px;
  }
  .hint code {
    font-family: var(--mono);
    color: var(--text-dim);
  }
  .pickers {
    display: flex;
    gap: 10px;
  }
  .pick {
    flex: 1;
    background: var(--bg-elev2);
    border: 1px dashed var(--border);
    color: var(--text-dim);
    border-radius: 10px;
    padding: 22px 10px;
    font-size: 13.5px;
  }
  .pick:hover {
    border-color: var(--accent);
    color: var(--text);
  }
  .pick:disabled {
    opacity: 0.5;
  }
  .prog {
    margin-top: 12px;
    color: var(--amber);
    font-size: 13px;
  }
  .fail {
    margin-top: 10px;
    color: var(--red);
    font-size: 12.5px;
  }

  .browse {
    display: flex;
    flex-direction: column;
    min-height: 0;
  }
  .crumbs {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 2px;
    margin-bottom: 8px;
    font-size: 12.5px;
  }
  .crumb {
    background: none;
    border: none;
    color: var(--accent);
    padding: 2px 4px;
    font-size: 12.5px;
  }
  .crumb:hover {
    text-decoration: underline;
  }
  .sep {
    color: var(--text-faint);
  }
  .list {
    flex: 1;
    min-height: 120px;
    max-height: 340px;
    overflow-y: auto;
    border: 1px solid var(--border-soft);
    border-radius: 10px;
    padding: 6px;
  }
  .row {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 6px;
    border-radius: 7px;
  }
  .row:hover {
    background: var(--bg-elev2);
  }
  .name {
    background: none;
    border: none;
    color: var(--text);
    font-size: 13px;
    text-align: left;
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 2px 0;
  }
  .name.dir {
    color: var(--accent);
  }
  .size {
    color: var(--text-faint);
    font-size: 11.5px;
    flex: none;
  }
  .foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 12px;
  }
  .count {
    color: var(--text-faint);
    font-size: 12.5px;
  }
  .add {
    background: var(--accent);
    color: #0a0d16;
    border: none;
    border-radius: 9px;
    padding: 8px 18px;
    font-weight: 640;
    font-size: 13px;
  }
  .add:disabled {
    opacity: 0.4;
  }
</style>
