<script lang="ts">
  import { tick } from "svelte";
  import { runStream } from "./lib/sse.ts";
  import { renderMarkdown } from "./lib/markdown.ts";
  import Settings from "./lib/Settings.svelte";
  import AttachDialog from "./lib/AttachDialog.svelte";

  type ToolItem = {
    kind: "tool";
    id: string;
    name: string;
    args: any;
    status: "running" | "ok" | "fail" | "denied";
    summary: string;
    output: string;
    open: boolean;
  };
  type Item =
    | { kind: "user"; text: string }
    | { kind: "thinking"; text: string; open: boolean }
    | { kind: "text"; text: string }
    | { kind: "error"; text: string }
    | { kind: "screenshot"; dataUri: string; url: string; verdict: string }
    | ToolItem;

  let timeline = $state<Item[]>([]);
  let todos = $state<{ content: string; status: string }[]>([]);
  let sessionId = $state<string | null>(null);
  let running = $state(false);
  let input = $state("");
  let info = $state<any>(null);
  let config = $state<any>(null);
  let showSettings = $state(false);
  let usage = $state({ inTok: 0, outTok: 0 });
  let ctxUse = $state({ used: 0, limit: 0 });
  let preview = $state<{ url: string; frameUrl: string; serviceId: string } | null>(null);
  let previewOpen = $state(false);
  let previewNonce = $state(0);
  // Workspace-relative paths attached to the next message (dirs end with "/").
  let attachments = $state<string[]>([]);
  let showAttach = $state(false);

  let scroller: HTMLElement;
  let stick = true;
  let curText: any = null;
  let curThinking: any = null;
  const toolRefs = new Map<string, ToolItem>();
  let abort: AbortController | null = null;

  loadMeta();
  async function loadMeta() {
    try {
      const [i, c] = await Promise.all([
        fetch("/api/info").then((r) => r.json()),
        fetch("/api/config").then((r) => r.json()),
      ]);
      info = i;
      config = c;
    } catch {
      /* backend not up yet */
    }
  }

  function pushItem(item: Item): any {
    timeline.push(item);
    return timeline[timeline.length - 1]; // proxied element — mutate THIS, not the literal
  }

  function extractText(content: any[]): string {
    if (!Array.isArray(content)) return "";
    return content.map((b) => (b?.t === "text" ? b.text : "")).join("");
  }

  async function onScroll() {
    if (!scroller) return;
    stick = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
  }
  async function scrollDown() {
    if (!stick) return;
    await tick();
    scroller?.scrollTo({ top: scroller.scrollHeight });
  }

  function handleEvent(ev: any) {
    switch (ev.e) {
      case "session":
        sessionId = ev.sessionId;
        break;
      case "turn_start":
        curText = null;
        curThinking = null;
        break;
      case "thinking_delta":
        if (!curThinking) curThinking = pushItem({ kind: "thinking", text: "", open: false });
        curThinking.text += ev.text;
        break;
      case "text_delta":
        if (!curText) curText = pushItem({ kind: "text", text: "" });
        curText.text += ev.text;
        break;
      case "tool_start": {
        curText = null;
        curThinking = null;
        const t = pushItem({
          kind: "tool",
          id: ev.id,
          name: ev.name,
          args: ev.args,
          status: "running",
          summary: "",
          output: "",
          open: false,
        });
        toolRefs.set(ev.id, t);
        break;
      }
      case "tool_end": {
        const ref = toolRefs.get(ev.id);
        if (ref) {
          ref.status = ev.ok ? "ok" : "fail";
          ref.summary = ev.summary;
          ref.output = extractText(ev.content);
        }
        break;
      }
      case "tool_permission": {
        const ref = toolRefs.get(ev.id);
        if (ref && ev.decision === "deny") {
          ref.status = "denied";
          ref.summary = ev.reason;
        }
        break;
      }
      case "todo":
        todos = ev.items ?? [];
        break;
      case "preview":
        preview = { url: ev.url, frameUrl: ev.frameUrl ?? ev.url, serviceId: ev.serviceId };
        previewOpen = true;
        previewNonce++;
        break;
      case "preview_closed":
        if (preview && preview.serviceId === ev.serviceId) {
          preview = null;
          previewOpen = false;
        }
        break;
      case "screenshot":
        pushItem({ kind: "screenshot", dataUri: ev.dataUri, url: ev.url, verdict: ev.verdict ?? "" });
        break;
      case "usage":
        usage = { inTok: ev.totalInputTokens, outTok: ev.totalOutputTokens };
        break;
      case "context":
        ctxUse = { used: ev.usedTokens, limit: ev.limitTokens };
        break;
      case "error":
        pushItem({ kind: "error", text: ev.message });
        break;
    }
    scrollDown();
  }

  async function send() {
    let msg = input.trim();
    if ((!msg && !attachments.length) || running) return;
    if (attachments.length) {
      const list = attachments
        .map((p) => `- ${p}${p.endsWith("/") ? " (folder)" : ""}`)
        .join("\n");
      const block = `[Attached files — already in the workspace; Read them as needed]\n${list}`;
      msg = msg ? `${msg}\n\n${block}` : block;
      attachments = [];
    }
    input = "";
    pushItem({ kind: "user", text: msg });
    curText = null;
    curThinking = null;
    stick = true;
    scrollDown();
    running = true;
    abort = new AbortController();
    try {
      await runStream({ sessionId, message: msg }, handleEvent, abort.signal);
    } catch (e: any) {
      if (e?.name !== "AbortError") pushItem({ kind: "error", text: String(e?.message ?? e) });
    } finally {
      running = false;
      abort = null;
    }
  }

  async function stop() {
    abort?.abort();
    if (sessionId) {
      try {
        await fetch("/api/stop", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ sessionId }),
        });
      } catch {}
    }
    running = false;
  }

  function newSession() {
    if (running) return;
    timeline = [];
    todos = [];
    sessionId = null;
    usage = { inTok: 0, outTok: 0 };
    ctxUse = { used: 0, limit: 0 };
    toolRefs.clear();
    preview = null;
    previewOpen = false;
    fetch("/api/preview/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).catch(() => {});
  }

  function reloadPreview() {
    previewNonce++;
  }
  function closePreview() {
    previewOpen = false;
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const examples = [
    "Create a Node script fizzbuzz.js that prints FizzBuzz 1..30, then run it.",
    "Build a small static webpage (index.html) with a working click counter, then verify the file.",
    "Write a Python function to check if a string is a palindrome, add 3 tests, and run them.",
  ];

  const argPreview = (a: any) => {
    if (!a) return "";
    if (a.command) return a.command;
    if (a.path) return a.path;
    if (a.pattern) return a.pattern;
    if (a.todos) return `${a.todos.length} items`;
    return JSON.stringify(a).slice(0, 80);
  };

  const ctxPct = $derived(ctxUse.limit ? Math.min(100, Math.round((ctxUse.used / ctxUse.limit) * 100)) : 0);
</script>

<div class="workspace" class:split={previewOpen && preview}>
  <div class="app">
  <header>
    <div class="brand">
      <span class="logo"></span>
      <b>Harness</b>
      <span class="sub">agent preview</span>
    </div>
    <div class="meta">
      {#if config}
        <span class="chip" class:warn={!config.hasKey}>
          {config.provider} · {config.model}
          {#if !config.hasKey}<span class="miss">no key</span>{/if}
        </span>
      {/if}
      {#if info}<span class="chip ghost">{info.shell} · {info.workspace}</span>{/if}
      {#if preview && !previewOpen}
        <button class="icon" title="Show preview" onclick={() => (previewOpen = true)}>▷</button>
      {/if}
      <button class="icon" title="New session" onclick={newSession} disabled={running}>＋</button>
      <button class="icon" title="Settings" onclick={() => (showSettings = true)}>⚙</button>
    </div>
  </header>

  <main bind:this={scroller} onscroll={onScroll}>
    <div class="feed">
      {#if timeline.length === 0}
        <div class="empty">
          <h1>An autonomous coding agent</h1>
          <p>
            It plans, reads/writes/edits files, runs shell commands, and verifies its own work —
            all inside a sandboxed workspace. Give it a task:
          </p>
          <div class="examples">
            {#each examples as ex}
              <button onclick={() => { input = ex; }}>{ex}</button>
            {/each}
          </div>
          {#if config && !config.hasKey}
            <p class="need-key">
              First, open <button class="link" onclick={() => (showSettings = true)}>Settings</button>
              and add an API key.
            </p>
          {/if}
        </div>
      {/if}

      {#each timeline as item, i (i)}
        {#if item.kind === "user"}
          <div class="user"><div class="bubble">{item.text}</div></div>
        {:else if item.kind === "text"}
          <div class="assistant">{@html renderMarkdown(item.text)}</div>
        {:else if item.kind === "thinking"}
          <details class="thinking" bind:open={item.open}>
            <summary>thinking</summary>
            <div class="think-body">{item.text}</div>
          </details>
        {:else if item.kind === "error"}
          <div class="err">⚠ {item.text}</div>
        {:else if item.kind === "screenshot"}
          <div class="shot">
            <img src={item.dataUri} alt="screenshot of {item.url}" />
            <div class="shot-meta">
              <span class="shot-url">📷 {item.url}</span>
              {#if item.verdict}<div class="shot-verdict">👁 {item.verdict}</div>{/if}
            </div>
          </div>
        {:else if item.kind === "tool"}
          <div class="tool" class:running={item.status === "running"}>
            <button class="tool-head" onclick={() => (item.open = !item.open)}>
              <span class="st {item.status}"></span>
              <span class="tname">{item.name}</span>
              <span class="targs">{argPreview(item.args)}</span>
              <span class="tsum">{item.summary}</span>
            </button>
            {#if item.open}
              <div class="tool-body">
                <div class="tsec">args</div>
                <pre class="code">{JSON.stringify(item.args, null, 2)}</pre>
                {#if item.output}
                  <div class="tsec">result</div>
                  <pre class="code out">{item.output}</pre>
                {/if}
              </div>
            {/if}
          </div>
        {/if}
      {/each}
    </div>
  </main>

  {#if todos.length}
    <div class="todos">
      {#each todos as t}
        <div class="todo {t.status}">
          <span class="tick"></span>{t.content}
        </div>
      {/each}
    </div>
  {/if}

  <footer>
    <div class="statusline">
      {#if ctxUse.limit}
        <span class="ctxbar" title="context used"><span style="width:{ctxPct}%"></span></span>
        <span class="stat">{(ctxUse.used / 1000).toFixed(1)}k / {(ctxUse.limit / 1000).toFixed(0)}k ctx</span>
      {/if}
      {#if usage.inTok || usage.outTok}
        <span class="stat">↑{usage.inTok} ↓{usage.outTok} tok</span>
      {/if}
      {#if running}<span class="stat live">● running</span>{/if}
    </div>
    {#if attachments.length}
      <div class="attach-chips">
        {#each attachments as p (p)}
          <span class="attach-chip" title={p}>
            {p.endsWith("/") ? "📁" : "📄"}
            {p.replace(/\/$/, "").split("/").pop()}
            <button
              class="chip-x"
              title="Remove"
              onclick={() => (attachments = attachments.filter((x) => x !== p))}>✕</button
            >
          </span>
        {/each}
      </div>
    {/if}
    <div class="composer">
      <button class="attach" title="Add files" onclick={() => (showAttach = true)}>＋</button>
      <textarea
        bind:value={input}
        onkeydown={onKey}
        placeholder="Describe a task for the agent…"
        rows="1"
      ></textarea>
      {#if running}
        <button class="stop" onclick={stop}>Stop</button>
      {:else}
        <button class="send" onclick={send} disabled={!input.trim() && !attachments.length}>Send</button>
      {/if}
    </div>
  </footer>
  </div>

  {#if previewOpen && preview}
    <aside class="preview">
      <div class="pv-bar">
        <span class="pv-dot"></span>
        <span class="pv-url" title={preview.url}>{preview.url}</span>
        <button class="pv-btn" title="Reload" onclick={reloadPreview}>⟳</button>
        <a class="pv-btn" title="Open in new tab" href={preview.url} target="_blank" rel="noopener">↗</a>
        <button class="pv-btn" title="Hide preview" onclick={closePreview}>✕</button>
      </div>
      {#key previewNonce}
        <iframe class="pv-frame" title="App preview" src={preview.frameUrl}></iframe>
      {/key}
    </aside>
  {/if}
</div>

{#if showSettings}
  <Settings
    {config}
    {info}
    onclose={() => (showSettings = false)}
    onsaved={(cfg) => { config = cfg; loadMeta(); }}
  />
{/if}

{#if showAttach}
  <AttachDialog
    onclose={() => (showAttach = false)}
    onadd={(paths) => {
      attachments = [...new Set([...attachments, ...paths])];
    }}
  />
{/if}

<style>
  .workspace {
    display: flex;
    height: 100vh;
    overflow: hidden;
  }
  .app {
    display: flex;
    flex-direction: column;
    height: 100%;
    flex: 1;
    min-width: 0;
  }

  .preview {
    width: 46%;
    min-width: 380px;
    max-width: 62%;
    height: 100%;
    display: flex;
    flex-direction: column;
    border-left: 1px solid var(--border);
    background: var(--bg-elev);
    animation: slidein 0.22s ease;
  }
  @keyframes slidein { from { transform: translateX(24px); opacity: 0; } }
  .pv-bar {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg-elev2);
  }
  .pv-dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--green); flex: none;
  }
  .pv-url {
    flex: 1;
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .pv-btn {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: 7px;
    width: 26px; height: 26px;
    font-size: 13px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    text-decoration: none;
    flex: none;
  }
  .pv-btn:hover { color: var(--text); border-color: var(--accent); }
  .pv-frame {
    flex: 1;
    border: none;
    width: 100%;
    background: #fff;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border-soft);
    background: var(--bg-elev);
  }
  .brand { display: flex; align-items: center; gap: 8px; }
  .logo {
    width: 16px;
    height: 16px;
    border-radius: 5px;
    background: conic-gradient(from 210deg, var(--accent), var(--thinking), var(--green), var(--accent));
  }
  .brand b { font-size: 15px; }
  .sub { color: var(--text-faint); font-size: 12px; }
  .meta { display: flex; align-items: center; gap: 8px; }
  .chip {
    font-size: 12px;
    background: var(--bg-elev2);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 4px 11px;
    color: var(--text-dim);
    max-width: 340px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .chip.ghost { color: var(--text-faint); }
  .chip.warn { border-color: var(--amber); }
  .miss { color: var(--amber); margin-left: 6px; }
  .icon {
    background: var(--bg-elev2);
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: 8px;
    width: 30px;
    height: 30px;
    font-size: 15px;
  }
  .icon:hover { color: var(--text); border-color: var(--accent); }
  .icon:disabled { opacity: 0.4; }

  main {
    flex: 1;
    overflow-y: auto;
  }
  .feed {
    max-width: 820px;
    margin: 0 auto;
    padding: 26px 20px 40px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }

  .empty { text-align: center; margin-top: 12vh; color: var(--text-dim); }
  .empty h1 { color: var(--text); font-size: 24px; font-weight: 640; margin-bottom: 8px; }
  .empty p { max-width: 520px; margin: 0 auto 22px; line-height: 1.6; }
  .examples { display: flex; flex-direction: column; gap: 8px; max-width: 560px; margin: 0 auto; }
  .examples button {
    background: var(--bg-elev);
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: 10px;
    padding: 12px 14px;
    text-align: left;
    font-size: 13px;
  }
  .examples button:hover { border-color: var(--accent); color: var(--text); }
  .need-key { margin-top: 20px; color: var(--amber); }
  .link, .link:hover { background: none; border: none; color: var(--accent); text-decoration: underline; padding: 0; }

  .user { display: flex; justify-content: flex-end; }
  .user .bubble {
    background: var(--accent-soft);
    border: 1px solid #33406a;
    color: #eaf0ff;
    padding: 10px 14px;
    border-radius: 14px 14px 4px 14px;
    max-width: 80%;
    white-space: pre-wrap;
    line-height: 1.5;
  }
  .assistant {
    line-height: 1.65;
    color: var(--text);
    word-wrap: break-word;
  }
  .assistant :global(strong) { color: #fff; }

  .thinking {
    border-left: 2px solid var(--thinking);
    padding-left: 12px;
  }
  .thinking summary {
    color: var(--thinking);
    font-size: 12px;
    cursor: pointer;
    list-style: none;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .think-body {
    color: var(--text-dim);
    font-size: 13px;
    white-space: pre-wrap;
    margin-top: 6px;
    line-height: 1.6;
  }

  .err {
    background: rgba(229, 106, 106, 0.1);
    border: 1px solid rgba(229, 106, 106, 0.4);
    color: #f2b6b6;
    padding: 10px 14px;
    border-radius: 10px;
    font-size: 13px;
  }

  .shot {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-elev);
    overflow: hidden;
  }
  .shot img {
    display: block;
    width: 100%;
    max-height: 420px;
    object-fit: contain;
    background: #000;
  }
  .shot-meta {
    padding: 8px 12px;
    font-size: 12px;
  }
  .shot-url {
    color: var(--muted);
  }
  .shot-verdict {
    margin-top: 6px;
    color: var(--text);
    font-size: 13px;
    white-space: pre-wrap;
    line-height: 1.5;
  }

  .tool {
    border: 1px solid var(--border);
    border-radius: 10px;
    background: var(--bg-elev);
    overflow: hidden;
    animation: fade 0.2s ease;
  }
  @keyframes fade { from { opacity: 0; transform: translateY(4px); } }
  .tool.running { border-color: var(--amber); }
  .tool-head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    background: none;
    border: none;
    color: var(--text);
    padding: 10px 13px;
    text-align: left;
    font-size: 13px;
  }
  .st { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .st.running { background: var(--amber); animation: pulse 1s infinite; }
  .st.ok { background: var(--green); }
  .st.fail { background: var(--red); }
  .st.denied { background: var(--text-faint); }
  @keyframes pulse { 50% { opacity: 0.35; } }
  .tname { font-family: var(--mono); font-weight: 600; color: #fff; }
  .targs {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 300px;
  }
  .tsum { margin-left: auto; color: var(--text-faint); font-size: 12px; white-space: nowrap; }
  .tool-body { padding: 4px 13px 12px; border-top: 1px solid var(--border-soft); }
  .tsec {
    font-size: 10.5px;
    text-transform: uppercase;
    color: var(--text-faint);
    letter-spacing: 0.05em;
    margin: 10px 0 2px;
  }
  .out { max-height: 320px; overflow: auto; white-space: pre-wrap; }

  .todos {
    max-width: 820px;
    margin: 0 auto;
    width: 100%;
    padding: 0 20px 8px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .todo {
    font-size: 12.5px;
    color: var(--text-dim);
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .todo .tick {
    width: 12px; height: 12px; border-radius: 3px;
    border: 1.5px solid var(--text-faint); flex: none;
  }
  .todo.in_progress { color: var(--amber); }
  .todo.in_progress .tick { border-color: var(--amber); background: var(--amber); }
  .todo.completed { color: var(--text-faint); text-decoration: line-through; }
  .todo.completed .tick { border-color: var(--green); background: var(--green); }

  footer {
    border-top: 1px solid var(--border-soft);
    background: var(--bg-elev);
    padding: 8px 20px 14px;
  }
  .statusline {
    max-width: 820px;
    margin: 0 auto 8px;
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 11.5px;
    color: var(--text-faint);
    height: 14px;
  }
  .ctxbar {
    width: 90px; height: 5px; border-radius: 3px;
    background: var(--bg-elev2); overflow: hidden; display: inline-block;
  }
  .ctxbar span { display: block; height: 100%; background: var(--accent); transition: width 0.3s; }
  .stat.live { color: var(--green); }
  .composer {
    max-width: 820px;
    margin: 0 auto;
    display: flex;
    gap: 10px;
    align-items: flex-end;
  }
  .attach {
    background: var(--bg-elev2);
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: 12px;
    width: 46px;
    height: 46px;
    font-size: 19px;
    flex: none;
  }
  .attach:hover {
    color: var(--text);
    border-color: var(--accent);
  }
  .attach-chips {
    max-width: 820px;
    margin: 0 auto 8px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .attach-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--bg-elev2);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 4px 6px 4px 10px;
    font-size: 12px;
    color: var(--text-dim);
    max-width: 240px;
    overflow: hidden;
    white-space: nowrap;
  }
  .chip-x {
    background: none;
    border: none;
    color: var(--text-faint);
    font-size: 11px;
    padding: 2px 4px;
  }
  .chip-x:hover {
    color: var(--red);
  }
  textarea {
    flex: 1;
    resize: none;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 12px;
    color: var(--text);
    padding: 12px 14px;
    font-family: var(--sans);
    font-size: 14px;
    line-height: 1.5;
    max-height: 200px;
    min-height: 46px;
    field-sizing: content;
  }
  textarea:focus { outline: none; border-color: var(--accent); }
  .send, .stop {
    border: none;
    border-radius: 12px;
    padding: 0 20px;
    height: 46px;
    font-weight: 640;
    font-size: 14px;
  }
  .send { background: var(--accent); color: #0a0d16; }
  .send:disabled { opacity: 0.4; }
  .stop { background: var(--red); color: #fff; }
</style>
