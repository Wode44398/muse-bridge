<script lang="ts">
  let { config, info, onclose, onsaved } = $props<{
    config: any;
    info: any;
    onclose: () => void;
    onsaved: (cfg: any) => void;
  }>();

  let provider = $state(config?.provider ?? "anthropic");
  let model = $state(config?.model ?? "");
  let baseUrl = $state(config?.baseUrl ?? "");
  let apiKey = $state("");
  let permissionMode = $state(config?.permissionMode ?? "auto");
  let thinking = $state(config?.thinking ?? "off");
  let saving = $state(false);
  let saved = $state(false);

  const isCompat = (p: string) => p === "openai" || p === "qwen" || p === "zhipu";

  // Sensible defaults when the provider changes. Overwrite the model/baseUrl when
  // they clearly belong to a different provider so switching feels one-click.
  function onProviderChange() {
    const known = /^(claude|gpt|deepseek|qwen|glm)/;
    if (provider === "anthropic") {
      if (!model || known.test(model)) model = "claude-sonnet-4-6";
      baseUrl = "";
    } else if (provider === "qwen") {
      if (!model || known.test(model)) model = "qwen3.7-plus";
      baseUrl = "https://dashscope.aliyuncs.com/compatible-mode/v1";
    } else if (provider === "zhipu") {
      if (!model || known.test(model)) model = "glm-5.2";
      baseUrl = "https://open.bigmodel.cn/api/paas/v4";
    } else {
      if (!model || known.test(model)) model = "deepseek-v4-pro";
      if (!baseUrl || baseUrl.includes("dashscope") || baseUrl.includes("bigmodel"))
        baseUrl = "https://api.deepseek.com";
    }
  }

  async function save() {
    saving = true;
    saved = false;
    const patch: any = { provider, model, permissionMode, thinking };
    if (isCompat(provider)) patch.baseUrl = baseUrl;
    if (apiKey.trim()) patch.apiKey = apiKey.trim();
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const cfg = await res.json();
    saving = false;
    saved = true;
    apiKey = "";
    onsaved(cfg);
  }
</script>

<svelte:window onkeydown={(e) => e.key === "Escape" && onclose()} />

<div class="overlay">
  <button class="backdrop" aria-label="Close settings" onclick={onclose}></button>
  <div class="drawer">
    <div class="head">
      <h2>Settings</h2>
      <button class="x" onclick={onclose}>✕</button>
    </div>

    <span class="lbl">Provider</span>
    <div class="seg">
      <button class:on={provider === "anthropic"} onclick={() => { provider = "anthropic"; onProviderChange(); }}>
        Anthropic
        {#if info?.providers?.anthropic}<span class="dot ok"></span>{/if}
      </button>
      <button class:on={provider === "openai"} onclick={() => { provider = "openai"; onProviderChange(); }}>
        DeepSeek
        {#if info?.providers?.openai}<span class="dot ok"></span>{/if}
      </button>
      <button class:on={provider === "qwen"} onclick={() => { provider = "qwen"; onProviderChange(); }}>
        Qwen
        {#if info?.providers?.qwen}<span class="dot ok"></span>{/if}
      </button>
      <button class:on={provider === "zhipu"} onclick={() => { provider = "zhipu"; onProviderChange(); }}>
        Zhipu
        {#if info?.providers?.zhipu}<span class="dot ok"></span>{/if}
      </button>
    </div>

    <label for="f-model">Model</label>
    <input id="f-model" bind:value={model} placeholder="claude-sonnet-4-6 / gpt-4o / deepseek-chat" />

    {#if isCompat(provider)}
      <label for="f-baseurl">Base URL</label>
      <input id="f-baseurl" bind:value={baseUrl} placeholder="https://api.deepseek.com" />
      {#if provider === "qwen"}
        <p class="hint">Qwen (multimodal): <code>https://dashscope.aliyuncs.com/compatible-mode/v1</code> · model <code>qwen3.7-plus</code></p>
      {:else if provider === "zhipu"}
        <p class="hint">Zhipu GLM: <code>https://open.bigmodel.cn/api/paas/v4</code> · model <code>glm-5.2</code> (1M ctx, text)</p>
      {:else}
        <p class="hint">DeepSeek: <code>https://api.deepseek.com</code> · model <code>deepseek-v4-pro</code></p>
      {/if}
    {/if}

    <label for="f-apikey">
      API Key
      {#if config?.hasKey}<span class="tag">key set</span>{/if}
    </label>
    <input id="f-apikey" type="password" bind:value={apiKey} placeholder={config?.hasKey ? "•••••••• (leave blank to keep)" : "paste your API key"} />

    <div class="row">
      <div class="col">
        <label for="f-perm">Permission mode</label>
        <select id="f-perm" bind:value={permissionMode}>
          <option value="auto">auto (act in sandbox)</option>
          <option value="read-only">read-only</option>
        </select>
      </div>
      <div class="col">
        <label for="f-think">Thinking</label>
        <select id="f-think" bind:value={thinking}>
          <option value="off">off</option>
          <option value="low">low</option>
          <option value="high">high</option>
        </select>
      </div>
    </div>

    <button class="save" onclick={save} disabled={saving}>
      {saving ? "Saving…" : saved ? "Saved ✓" : "Save"}
    </button>
    <p class="note">Keys are held in memory only and never written to disk or returned to the browser.</p>
  </div>
</div>

<style>
  .overlay {
    position: fixed;
    inset: 0;
    display: flex;
    justify-content: flex-end;
    z-index: 50;
  }
  .backdrop {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(3px);
    border: none;
    padding: 0;
    z-index: 0;
  }
  .drawer {
    position: relative;
    z-index: 1;
    width: 400px;
    max-width: 92vw;
    height: 100%;
    background: var(--bg-elev);
    border-left: 1px solid var(--border);
    padding: 22px 24px;
    overflow-y: auto;
    animation: slide 0.18s ease;
  }
  @keyframes slide {
    from { transform: translateX(20px); opacity: 0; }
  }
  .head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 18px;
  }
  h2 { font-size: 16px; margin: 0; }
  .x {
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 15px;
  }
  label,
  .lbl {
    display: block;
    font-size: 12px;
    color: var(--text-dim);
    margin: 16px 0 6px;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }
  input,
  select {
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 8px;
    color: var(--text);
    padding: 9px 11px;
    font-size: 13px;
    font-family: var(--sans);
  }
  input:focus,
  select:focus {
    outline: none;
    border-color: var(--accent);
  }
  .seg {
    display: flex;
    gap: 8px;
  }
  .seg button {
    flex: 1;
    background: var(--bg);
    border: 1px solid var(--border);
    color: var(--text-dim);
    border-radius: 8px;
    padding: 9px;
    font-size: 12.5px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
  }
  .seg button.on {
    border-color: var(--accent);
    color: var(--text);
    background: var(--accent-soft);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    display: inline-block;
  }
  .dot.ok { background: var(--green); }
  .row { display: flex; gap: 12px; }
  .col { flex: 1; }
  .hint { font-size: 11.5px; color: var(--text-faint); margin: 6px 0 0; }
  .hint code { background: #0d1017; padding: 1px 4px; border-radius: 3px; }
  .tag {
    font-size: 10px;
    background: var(--green);
    color: #06210f;
    padding: 1px 6px;
    border-radius: 10px;
    margin-left: 6px;
    text-transform: none;
    letter-spacing: 0;
  }
  .save {
    width: 100%;
    margin-top: 22px;
    background: var(--accent);
    color: #0a0d16;
    border: none;
    border-radius: 8px;
    padding: 11px;
    font-weight: 650;
    font-size: 13.5px;
  }
  .save:disabled { opacity: 0.6; }
  .note { font-size: 11px; color: var(--text-faint); margin-top: 12px; line-height: 1.5; }
</style>
