<script>
  // 声明式应用的 chat 积木：一块轻量对话区，不嵌 solo 页。数据层在 lib/appChat.svelte.js。
  //   session 空：只有一个输入框；发第一句时确认 page.chat 授权 → 开对话 → ctx.run(onSession, { sessionId }) 让插件记下。
  //   session 有：先拉历史画出来，再订阅对话流；底下输入框接着聊（跑着时排队），跑着时有「停止」。
  //   审批 / 提问：页面批不了，显示「Claude 在等你批准」+「去处理」（去 Claude 页这个会话，系统返回回到应用）。
  //   右上「在 Claude 里打开」：看完整过程（工具细节、思考、文件）。
  // 高度：block.height 夹到 240～800（服务端已夹过，这里再兜一层）；session 空时只有输入框那么高。
  // 模型回复当不可信内容：renderMarkdown（marked + DOMPurify）；链接一律拦下来走 openExternalUrl。
  import { onDestroy, tick, untrack } from 'svelte';
  import { AppChat } from '../../lib/appChat.svelte.js';
  import { renderMarkdown, renderStreamingMarkdown } from '../../lib/md.js';
  import { openExternalUrl } from '../../lib/pluginUi.svelte.js';
  import { t } from '../../lib/i18n.js';

  let { block, ctx } = $props();

  const H_MIN = 240, H_MAX = 800, H_DEFAULT = 420;
  const height = $derived.by(() => {
    const h = Number(block?.height);
    return Number.isFinite(h) && h > 0 ? Math.max(H_MIN, Math.min(H_MAX, Math.round(h))) : H_DEFAULT;
  });

  let rootEl = $state(null);
  let listEl = $state(null);
  let inputEl = $state(null);
  let draft = $state('');
  let composing = false;

  // 这块此刻在不在使用者眼前（同 PluginFrame 的 foreground）：保活在后台的应用分页、被设置 / 弹层盖住、切走的标签都不算。
  // 积木根是普通元素，取点命中的是它里面的子元素，所以按 contains 判断
  const PROBES = [[0.5, 0.5], [0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]];
  function foreground() {
    const el = rootEl;
    if (!el || !el.isConnected || document.visibilityState !== 'visible' || el.closest('[inert]')) return false;
    if (typeof el.checkVisibility === 'function') {
      if (!el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) return false;
    } else if (!el.getClientRects().length || getComputedStyle(el).visibility !== 'visible') return false;
    const r = el.getBoundingClientRect();
    const x0 = Math.max(r.left, 0), x1 = Math.min(r.right, window.innerWidth);
    const y0 = Math.max(r.top, 0), y1 = Math.min(r.bottom, window.innerHeight);
    if (x1 - x0 < 2 || y1 - y0 < 2) return false;
    return PROBES.some(([a, b]) => {
      const hit = document.elementFromPoint(x0 + (x1 - x0) * a, y0 + (y1 - y0) * b);
      return !!hit && el.contains(hit);
    });
  }

  const chat = new AppChat({ getCtx: () => ctx, getBlock: () => block, isForeground: foreground });
  onDestroy(() => chat.destroy());

  // 只跟着树里的 session 走（插件写回 / 换了 / 清掉）；setSession 自己比对，同一个不重开
  $effect(() => {
    const s = block?.session ?? null;
    untrack(() => chat.setSession(s));
  });

  const desk = $derived(ctx?.variant === 'desktop');
  const started = $derived(!!chat.sid || chat.messages.length > 0);
  const placeholder = $derived(block?.placeholder || (started ? t('接着说…') : t('问 Claude…')));
  const canSend = $derived(!!draft.trim() && !chat.starting && !chat.needGrant);

  async function send() {
    const text = draft;
    if (!text.trim() || chat.starting) return;
    // 先清输入框（像发消息那样），没发出去再把字还回来——人在这期间又打了字就不盖
    draft = '';
    fit();
    stick = true;
    const ok = await chat.send(text);
    if (!ok && !draft) { draft = text; await tick(); fit(); }
  }

  function onkeydown(e) {
    if (e.key !== 'Enter' || e.isComposing || composing || e.keyCode === 229) return;
    // 桌面：回车发、Shift+回车换行；手机：回车就是换行，发送走按钮（软键盘上误触回车很常见）
    if (!desk || e.shiftKey || e.altKey) return;
    e.preventDefault();
    send();
  }

  // 输入框随内容长高，封顶后内部滚动
  function fit() {
    const el = inputEl;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, desk ? 160 : 140) + 'px';
  }

  // 贴底滚动：人在底部附近就跟着新内容走；往上翻看时不拽回来
  let stick = true;
  function onscroll() {
    const el = listEl;
    if (el) stick = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }
  $effect(() => {
    // 依赖：条数 + 最后一条的长度 / 工具状态（流式吐字时跟着滚）
    const list = chat.messages;
    const last = list[list.length - 1];
    void (list.length + (last ? last.text.length + (last.tools?.n || 0) + (last.error ? 1 : 0) : 0));
    void chat.approval;
    const el = listEl;
    if (!el) return;
    untrack(() => { if (stick) tick().then(() => { el.scrollTop = el.scrollHeight; }); });
  });

  function onMdClick(e) {
    const a = e.target?.closest?.('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    // '#id' 也要拦：放给浏览器会压一条历史、触发 popstate，nav.js 当成系统返回把整个应用页关掉；改成在本积木里找到目标滚过去
    e.preventDefault();
    if (href.startsWith('#')) { jumpTo(href.slice(1)); return; }
    if (/^https?:\/\//i.test(href) || /^\/(?!\/)/.test(href)) openExternalUrl(href);
  }

  function jumpTo(raw) {
    let id = raw;
    try { id = decodeURIComponent(raw); } catch {}
    if (!id || !rootEl) return;
    const esc = window.CSS?.escape ? CSS.escape(id) : id.replace(/["\\]/g, '\\$&');
    rootEl.querySelector('[id="' + esc + '"], a[name="' + esc + '"]')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // 工具调用：一行小字。正在用的报名字，用完了报次数（出错的另说）
  function toolLine(m) {
    const tl = m.tools;
    if (!tl || !tl.n) return '';
    if (tl.active && m.streaming) return t('正在用 {name}', { name: tl.active });
    const s = t('用了 {n} 次工具', { n: tl.n });
    return tl.err ? s + ' · ' + t('{n} 次出错', { n: tl.err }) : s;
  }

  const status = $derived(
    chat.needGrant ? '' :
    chat.loading ? t('加载中') :
    chat.approval ? t('等你批准') :
    chat.running ? t('正在回复') :
    chat.sid && !chat.connected && !chat.error ? t('正在连接') : '',
  );
</script>

{#snippet composer(inBox)}
  <div class="cb-comp" class:in-box={inBox}>
    <textarea bind:this={inputEl} bind:value={draft} rows="1" class="cb-in" {placeholder} aria-label={placeholder}
      disabled={chat.needGrant} oninput={fit} {onkeydown}
      oncompositionstart={() => (composing = true)} oncompositionend={() => (composing = false)}></textarea>
    {#if chat.running && chat.sid}
      <button type="button" class="cb-btn stop" onclick={() => chat.stop()} disabled={chat.stopping} aria-busy={chat.stopping || undefined}>
        {#if chat.stopping}<span class="av-spin" aria-hidden="true"></span>{:else}<span class="sq" aria-hidden="true"></span>{/if}{t('停止')}
      </button>
    {/if}
    {#if !(chat.running && chat.sid) || draft.trim()}
      <button type="button" class="cb-btn send" onclick={send} disabled={!canSend} aria-label={t('发送')} title={t('发送')} aria-busy={chat.starting || undefined}>
        {#if chat.starting}<span class="av-spin" aria-hidden="true"></span>{:else}
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 16V4M5 9l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        {/if}
      </button>
    {/if}
  </div>
{/snippet}

{#snippet grantRow()}
  <div class="cb-grant" role="status">
    <span>{t('这个应用想和 Claude 对话，要你先允许')}</span>
    <button type="button" class="cb-link strong" onclick={() => chat.grant()}>{t('允许')}</button>
  </div>
{/snippet}

<div class="cb" bind:this={rootEl}>
  {#if !started}
    <div class="cb-solo av-card">
      {@render composer(false)}
    </div>
    {#if chat.error}<p class="cb-err" role="alert">{chat.error}</p>{/if}
    {#if chat.needGrant}{@render grantRow()}{/if}
  {:else}
    <section class="cb-box av-card" style:height={height + 'px'} aria-label={t('与 Claude 的对话')}>
      <header class="cb-head">
        <span class="cb-status" aria-live="polite">
          {#if chat.running || chat.loading || (chat.sid && !chat.connected && !chat.error && !chat.needGrant)}<i class="dot" class:warn={!!chat.approval}></i>{/if}{status}
        </span>
        {#if chat.sid}
          <button type="button" class="cb-link" onclick={() => chat.openInClaude()}>
            {t('在 Claude 里打开')}
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3.5h6.5V10M12.5 3.5 4 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        {/if}
      </header>

      <div class="cb-list" bind:this={listEl} {onscroll} role="log" aria-live="off">
        {#if chat.loading && !chat.messages.length}
          <p class="cb-hint"><span class="av-spin" aria-hidden="true"></span>{t('加载中')}</p>
        {:else if !chat.messages.length && !chat.needGrant && !chat.error}
          <p class="cb-hint">{t('还没有消息')}</p>
        {/if}
        {#each chat.messages as m (m.key)}
          {#if m.role === 'user'}
            <div class="cb-u" class:pending={m.pending}><p>{m.text}</p></div>
          {:else}
            {@const tl = toolLine(m)}
            <div class="cb-a">
              {#if m.text}
                <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
                <div class="cb-md" onclick={onMdClick}>{@html m.streaming ? renderStreamingMarkdown(m.text) : renderMarkdown(m.text)}</div>
              {:else if m.streaming && !tl}
                <p class="cb-think" aria-label={t('正在想')}><i></i><i></i><i></i></p>
              {/if}
              {#if tl}<p class="cb-tool" class:live={m.streaming && m.tools?.active}>{tl}</p>{/if}
              {#if m.error}<p class="cb-merr">{m.error}</p>{/if}
              {#if m.stopped}<p class="cb-note">{t('已停止')}</p>{/if}
            </div>
          {/if}
        {/each}
      </div>

      {#if chat.approval}
        <div class="cb-appr" role="status">
          <div class="cb-appr-t">
            <b>{chat.approval.kind === 'question' ? t('Claude 在等你回答') : t('Claude 在等你批准')}</b>
            {#if chat.approval.title}<small>{chat.approval.title}</small>{/if}
          </div>
          <button type="button" class="cb-btn go" onclick={() => chat.openInClaude()}>{t('去处理')}</button>
        </div>
      {/if}
      {#if chat.needGrant}{@render grantRow()}{/if}
      {#if chat.error}<p class="cb-err in" role="alert">{chat.error}</p>{/if}

      {@render composer(true)}
    </section>
  {/if}
</div>

<style>
  .cb { min-width: 0; display: flex; flex-direction: column; gap: 6px; }

  /* —— 对话框整体：头 / 消息区（滚） / 审批条 / 输入区 —— */
  .cb-box { display: flex; flex-direction: column; min-height: 0; }
  .cb-head { flex: none; display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 6px var(--av-px) 4px; border-bottom: 1px solid var(--av-sep); }
  .cb-status { flex: 1; min-width: 0; display: inline-flex; align-items: center; gap: 7px; font-size: var(--av-fs-sm); line-height: var(--av-lh-sm); color: var(--av-ink2);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cb-status .dot { flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--av-ink3); animation: cb-pulse 1.4s ease-in-out infinite; }
  .cb-status .dot.warn { background: var(--av-warn); }
  @keyframes cb-pulse { 50% { opacity: .35; } }

  .cb-link { appearance: none; border: 0; background: none; font: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 4px;
    padding: 4px 6px; margin-right: -6px; border-radius: 6px; font-size: var(--av-fs-sm); line-height: var(--av-lh-sm); color: var(--av-ink2); white-space: nowrap; }
  .cb-link svg { width: 13px; height: 13px; }
  .cb-link:hover { color: var(--av-ink); background: var(--av-hover); }
  .cb-link:focus-visible { outline: none; box-shadow: var(--av-focus); }
  .cb-link.strong { color: var(--av-ink); font-weight: 600; text-decoration: underline; text-underline-offset: 3px; text-decoration-color: var(--av-ink3); }

  .cb-list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 12px var(--av-px) 8px; display: flex; flex-direction: column; gap: 12px; }
  .cb-hint { margin: auto; display: inline-flex; align-items: center; gap: 8px; font-size: var(--av-fs-sub); color: var(--av-ink3); }

  /* 用户：靠右一块浅底气泡；还在路上的淡一点 */
  .cb-u { align-self: flex-end; max-width: 86%; }
  .cb-u p { margin: 0; padding: 8px 12px; border-radius: 16px 16px 5px 16px; background: var(--av-fill2); color: var(--av-ink);
    font-size: var(--av-fs); line-height: var(--av-lh); white-space: pre-wrap; overflow-wrap: anywhere; }
  .cb-u.pending { opacity: .55; }
  /* 助手：不套气泡，正文直接铺（同 Claude 页的回复） */
  .cb-a { min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .cb-md { font-size: var(--av-fs); line-height: var(--av-lh); color: var(--av-ink); overflow-wrap: anywhere; --md-codecopy-bg: var(--av-card); }
  .cb-md > :global(:first-child) { margin-top: 0; }
  .cb-md > :global(:last-child) { margin-bottom: 0; }
  .cb-md :global(p) { margin: 0 0 .6em; }
  .cb-md :global(h1), .cb-md :global(h2), .cb-md :global(h3), .cb-md :global(h4) { margin: .9em 0 .4em; font-size: 1.05em; font-weight: 650; line-height: 1.3; }
  .cb-md :global(ul), .cb-md :global(ol) { margin: 0 0 .6em; padding-left: 1.4em; }
  .cb-md :global(li) { margin: .15em 0; }
  .cb-md :global(li > p) { margin: 0; }
  .cb-md :global(a) { color: inherit; text-decoration: underline; text-decoration-color: var(--av-ink3); text-underline-offset: 2px; }
  .cb-md :global(strong) { font-weight: 650; }
  .cb-md :global(blockquote) { margin: 0 0 .6em; padding: 2px 0 2px 12px; border-left: 2px solid var(--av-sep); color: var(--av-ink2); }
  .cb-md :global(code) { font-family: var(--mono, ui-monospace, "SF Mono", Consolas, monospace); font-size: .88em; padding: .1em .35em; border-radius: 5px; background: var(--av-fill2); }
  .cb-md :global(pre) { margin: 0 0 .6em; padding: 9px 11px; border-radius: var(--av-r-sm); overflow-x: auto; background: var(--av-fill); box-shadow: var(--av-hair); font-size: .88em; line-height: 1.5; }
  .cb-md :global(pre code) { padding: 0; background: none; font-size: 1em; }
  .cb-md :global(table) { border-collapse: collapse; font-size: .92em; }
  .cb-md :global(th), .cb-md :global(td) { padding: 5px 9px; border-bottom: 1px solid var(--av-sep); text-align: left; vertical-align: top; }
  .cb-md :global(th) { font-weight: 600; color: var(--av-ink2); }
  .cb-md :global(img) { max-width: 100%; height: auto; border-radius: var(--av-r-sm); }

  .cb-tool, .cb-note, .cb-merr { margin: 0; font-size: var(--av-fs-sm); line-height: var(--av-lh-sm); color: var(--av-ink3); }
  .cb-tool { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .cb-tool.live { color: var(--av-ink2); }
  .cb-merr { color: var(--av-err); }
  .cb-think { margin: 0; display: inline-flex; gap: 4px; padding: 6px 0; }
  .cb-think i { width: 6px; height: 6px; border-radius: 50%; background: var(--av-ink3); animation: cb-pulse 1.2s ease-in-out infinite; }
  .cb-think i:nth-child(2) { animation-delay: .15s; }
  .cb-think i:nth-child(3) { animation-delay: .3s; }

  /* 审批条：中性底 + 一点警示色的字，不上彩条 */
  .cb-appr { flex: none; display: flex; align-items: center; gap: 10px; margin: 0 var(--av-px) 8px; padding: 8px 8px 8px 12px; border-radius: var(--av-r-sm); background: var(--av-fill2); }
  .cb-appr-t { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .cb-appr-t b { font-size: var(--av-fs-sub); line-height: var(--av-lh-sub); font-weight: 600; color: var(--av-warn); }
  .cb-appr-t small { font-size: var(--av-fs-sm); line-height: var(--av-lh-sm); color: var(--av-ink2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .cb-grant { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 10px; padding: 6px var(--av-px); font-size: var(--av-fs-sub); line-height: var(--av-lh-sub); color: var(--av-ink2); }
  .cb-err { margin: 0; padding: 0 var(--av-px); font-size: var(--av-fs-sub); line-height: var(--av-lh-sub); color: var(--av-err); }
  .cb-err.in { padding-bottom: 6px; }

  /* —— 输入区：一条输入底 + 右侧圆钮 —— */
  .cb-comp { flex: none; display: flex; align-items: flex-end; gap: 6px; padding: 6px; }
  .cb-comp.in-box { padding: 0 8px 8px; }
  .cb-in { flex: 1; min-width: 0; resize: none; border: 0; outline: 0; margin: 0; font: inherit; font-size: var(--av-fs); line-height: var(--av-lh); color: var(--av-ink);
    background: var(--av-field); border-radius: calc(var(--av-btn-h) / 2 + 2px); padding: calc((var(--av-btn-h) - var(--av-lh)) / 2 + 2px) 14px; min-height: calc(var(--av-btn-h) + 4px);
    max-height: 160px; transition: box-shadow var(--av-t) ease; }
  .cb-solo .cb-in { background: transparent; }
  .cb-in:focus { box-shadow: var(--av-focus); }
  .cb-solo .cb-in:focus { box-shadow: none; }
  .cb-solo:focus-within { box-shadow: var(--av-hair), var(--av-focus); }
  .cb-in::placeholder { color: var(--av-ink3); }
  .cb-in:disabled { opacity: .5; }

  .cb-btn { appearance: none; border: 0; font: inherit; cursor: pointer; flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    height: calc(var(--av-btn-h) + 4px); border-radius: calc(var(--av-btn-h) / 2 + 2px); padding: 0 14px; font-size: var(--av-btn-fs); font-weight: 600; white-space: nowrap;
    transition: transform var(--mo-tap, .09s) var(--ea-out, ease-out), opacity var(--av-t), background var(--av-t); }
  .cb-btn:active:not(:disabled) { transform: scale(.95); }
  .cb-btn:focus-visible { outline: none; box-shadow: var(--av-focus); }
  .cb-btn:disabled { opacity: .35; cursor: default; }
  .cb-btn.send { width: calc(var(--av-btn-h) + 4px); padding: 0; background: var(--av-accent); color: var(--av-on-accent); }
  .cb-btn.send svg { width: 18px; height: 18px; }
  .cb-btn.stop { background: var(--av-fill2); color: var(--av-ink); }
  .cb-btn.stop .sq { width: 9px; height: 9px; border-radius: 2px; background: currentColor; }
  .cb-btn.go { height: var(--av-btn-h); border-radius: var(--av-btn-r); background: var(--av-accent); color: var(--av-on-accent); }
  .cb-btn[aria-busy] { cursor: progress; }
  :global(.av-desk) .cb-btn { font-weight: 500; }
  :global(.av-desk) .cb-btn.send svg { width: 15px; height: 15px; }
</style>
