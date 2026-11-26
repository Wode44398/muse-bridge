<script>
  // Claude 页右侧的「Antigravity 对话预览栏」（demo 第二版 Claude 侧的 peek）：数据在 lib/claudePage/agyPeek.svelte.js。
  // 桌面：本格正文右边推出一根 372 宽的栏（宽度 200ms ease-out 展开，不回弹），把正文挤窄；
  // 手机：盖满全屏，从右边推进来（250ms ease-out），退场 200ms。
  // 正文只读、按 Claude 页的排法压缩：用户一句一个气泡，Antigravity 的回复是正文，工具和步骤压成一行灰字，在跑时末尾一行「Antigravity 在跑：…」。
  // 底部是输入框：打了字才出现方形发送键（120ms 淡入 + 200ms 轻微回冲放大，Anthropic 只在按钮出现时用一点回冲），
  // 以你的名义发给这个会话；下面一行小字说明。
  import { tick } from 'svelte';
  import AgentTile from './AgentTile.svelte';
  import { agyPeek, closeAgyPeek, sendAgyPeek, registerAgyPeekHost } from '../../../lib/claudePage/agyPeek.svelte.js';
  import { compactItems, liveStep } from '../../../lib/claudePage/agyPeekView.js';
  import { openTarget } from '../../../lib/pluginUi.svelte.js';
  import { layout, pointer } from '../../../lib/layout.svelte.js';
  import { renderMarkdown } from '../../../lib/md.js';
  import { t, tr } from '../../../lib/i18n.js';

  const items = $derived(compactItems(agyPeek.turns));
  const step = $derived(liveStep(agyPeek.turns));
  const folder = $derived(String(agyPeek.path || agyPeek.cwd || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || '');
  const phone = $derived(layout.compact);

  // 关掉时内容还要在收拢的那 200ms 里留着
  let shown = $state(false);
  let leaveT = 0;
  $effect(() => {
    clearTimeout(leaveT);
    if (agyPeek.open) { shown = true; return; }
    leaveT = setTimeout(() => { shown = false; }, 220);
  });

  let draft = $state('');
  let ta = $state(null);
  let body = $state(null);
  $effect(() => registerAgyPeekHost());
  $effect(() => { agyPeek.sid; draft = ''; });

  function grow() {
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(ta.scrollHeight, 132) + 'px';
  }
  async function send() {
    const text = draft;
    if (!text.trim()) return;
    draft = '';
    await tick(); grow();
    const ok = await sendAgyPeek(text);
    if (!ok && !draft) { draft = text; await tick(); grow(); }
  }
  function key(e) {
    // 有实体键盘：Enter 发、Shift+Enter 换行；触屏的回车只换行
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && pointer.fine) { e.preventDefault(); send(); }
    else if (e.key === 'Escape') { e.preventDefault(); closeAgyPeek(); }
  }
  function openInAgy() {
    const sid = agyPeek.sid, path = agyPeek.path || agyPeek.cwd, plugin = agyPeek.plugin;
    closeAgyPeek();
    openTarget({ session: { agent: 'agy', id: sid } }, { plugin, path, agent: 'claude' });
  }

  // 新内容进来时贴底（人往上翻着看时不拽）
  let stick = true;
  const onScroll = () => { if (body) stick = body.scrollHeight - body.scrollTop - body.clientHeight < 48; };
  $effect(() => {
    items.length; step.kind; step.label; agyPeek.live; agyPeek.loading;
    const last = items[items.length - 1];
    last && last.text;
    if (!body || !stick) return;
    queueMicrotask(() => { if (body) body.scrollTop = body.scrollHeight; });
  });
  $effect(() => { if (agyPeek.open) { stick = true; } });
</script>

<aside class="apk" class:on={agyPeek.open} class:phone aria-hidden={!agyPeek.open} aria-label={t('Antigravity 的对话')}>
  {#if shown}
    <div class="apk-in">
      <header class="apk-h">
        <AgentTile agent="agy" size={20} mark={agyPeek.live ? 'writing' : 'static'} />
        <span class="apk-tx">
          <b>{tr(agyPeek.title) || t('（无标题）')}</b>
          <span>{folder ? t('Antigravity 的对话 · {folder}', { folder }) : t('Antigravity 的对话')}</span>
        </span>
        <button type="button" class="apk-open" onclick={openInAgy}>{t('在 Antigravity 打开')}</button>
        <button type="button" class="apk-x" aria-label={t('关闭')} onclick={closeAgyPeek}>
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>
        </button>
      </header>

      <div class="apk-body" bind:this={body} onscroll={onScroll}>
        {#if agyPeek.loading && !items.length}
          <div class="apk-note">{t('加载中…')}</div>
        {:else if agyPeek.error}
          <div class="apk-note err">{agyPeek.error}</div>
        {:else if !items.length && !agyPeek.live}
          <div class="apk-note">{t('这个对话还没有内容。')}</div>
        {/if}
        {#each items as it (it.key)}
          {#if it.kind === 'user'}
            <div class="apk-u" class:mine={it.mine}>
              {#if it.mine}<span class="who">{t('你 · 从 Claude 页发')}</span>{/if}
              <span class="ub">{it.text}</span>
            </div>
          {:else if it.kind === 'text'}
            <div class="apk-a">
              {#if it.first}<span class="who">Antigravity</span>{/if}
              <div class="apk-md">{@html renderMarkdown(it.text)}</div>
            </div>
          {:else}
            <div class="apk-s"><span class="dot" aria-hidden="true"></span><span class="sl">{tr(it.label) || t('一步操作')}</span>{#if it.more}<span class="sm">{t('另 {n} 步', { n: it.more })}</span>{/if}</div>
          {/if}
        {/each}
        {#if agyPeek.live}
          <div class="apk-s run" role="status"><span class="dot" aria-hidden="true"></span><span class="sl">{step.kind === 'tool' && step.label
            ? t('Antigravity 在跑：{step}', { step: tr(step.label) })
            : step.kind === 'write' ? t('Antigravity 在跑：在写回复') : t('Antigravity 在跑：在想')}</span></div>
        {/if}
      </div>

      <div class="apk-c">
        <div class="apk-box">
          <textarea bind:this={ta} bind:value={draft} rows="1" placeholder={t('发给这个 Antigravity 对话…')} oninput={grow} onkeydown={key}
            aria-label={t('发给这个 Antigravity 对话…')}></textarea>
          <button type="button" class="apk-send" class:on={!!draft.trim()} disabled={!draft.trim() || agyPeek.sending} aria-label={t('发送')} onclick={send}>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 13V3.5M3.8 7.6 8 3.4l4.2 4.2"/></svg>
          </button>
        </div>
        <div class="apk-hint">{t('以你的名义发出')}</div>
      </div>
    </div>
  {/if}
</aside>

<style>
  /* 桌面：本格里正文右边的一根栏。宽度从 0 推到 372（200ms ease-out，不回弹），内层定宽，推的过程中内容不重排。
     盖住本格右上角那组浮动工具（DockToolBar z 34）：栏开着时它的头部就在那个位置，关掉栏工具就回来 */
  .apk { flex: none; width: 0; overflow: hidden; position: relative; z-index: 35; background: var(--bg);
    border-left: 1px solid transparent; transition: width 200ms cubic-bezier(.165, .84, .44, 1), border-color 200ms cubic-bezier(.165, .84, .44, 1); }
  .apk.on { width: 372px; border-left-color: var(--divider); }
  /* 收着时还剩 1px 透明左边框、又压在工作区之上（z 35）：正好盖在工作区左缘把手的骑缝处，按中就被它吞掉、拖不动宽度 */
  .apk:not(.on) { pointer-events: none; }
  /* 内层贴右缘：宽度展开时像整根栏从右边滑进来，而不是从左往右揭开 */
  .apk-in { position: absolute; top: 0; right: 0; bottom: 0; width: 372px; display: flex; flex-direction: column; background: var(--bg); color: var(--text); }
  /* 手机：盖满全屏，从右边推进来 */
  .apk.phone { position: fixed; inset: 0; z-index: 60; width: auto; border: 0; transform: translateX(100%); visibility: hidden;
    transition: transform 200ms cubic-bezier(.165, .84, .44, 1), visibility 0s linear 200ms; }
  .apk.phone.on { transform: none; visibility: visible; transition: transform 250ms cubic-bezier(.165, .84, .44, 1), visibility 0s; }
  .apk.phone .apk-in { width: 100%; left: 0; padding-top: var(--sat, 0px); }

  .apk-h { flex: none; height: 52px; display: flex; align-items: center; gap: 10px; padding: 0 8px 0 16px; border-bottom: 1px solid var(--divider); }
  .apk-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .apk-tx b { font-size: 14px; font-weight: 500; line-height: 19px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .apk-tx span { font-size: 12px; line-height: 16px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .apk-open { flex: none; height: 28px; padding: 0 9px; border: 0; border-radius: 8px; background: none; color: var(--serif); font: inherit; font-size: 12.5px;
    box-shadow: inset 0 0 0 1px var(--cc-ring); cursor: pointer; transition: background-color 60ms cubic-bezier(.165, .84, .44, 1), color 60ms cubic-bezier(.165, .84, .44, 1); }
  .apk-x { flex: none; width: 32px; height: 32px; display: grid; place-items: center; border: 0; border-radius: 8px; background: none; color: var(--muted); cursor: pointer;
    transition: background-color 60ms cubic-bezier(.165, .84, .44, 1), color 60ms cubic-bezier(.165, .84, .44, 1); }
  .apk-x svg { width: 16px; height: 16px; }
  .apk-open:active, .apk-x:active { background: var(--hover-strong); color: var(--text); }
  @media (hover: hover) { .apk-open:hover, .apk-x:hover { background: var(--hover); color: var(--text); } }

  .apk-body { flex: 1; min-height: 0; overflow-y: auto; padding: 14px 16px 10px; display: flex; flex-direction: column; gap: 12px;
    font-size: 14px; line-height: 1.6; overscroll-behavior: contain; scrollbar-width: thin; }
  .apk-note { color: var(--muted); font-size: 13px; }
  .apk-note.err { color: var(--crit); }
  .who { display: block; font-size: 12px; line-height: 16px; color: var(--muted); margin-bottom: 2px; }
  .apk-u { align-self: flex-end; max-width: 86%; display: flex; flex-direction: column; align-items: flex-end; }
  .apk-u .ub { background: var(--userbubble); border-radius: 12px; padding: 8px 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .apk-u.mine .who { color: var(--serif); }
  .apk-a { min-width: 0; }
  .apk-md { overflow-wrap: anywhere; }
  .apk-md :global(p) { margin: 0 0 .5em; }
  .apk-md :global(p:last-child) { margin-bottom: 0; }
  .apk-md :global(h1), .apk-md :global(h2), .apk-md :global(h3), .apk-md :global(h4) { font-size: 1em; font-weight: 600; margin: 0 0 4px; }
  .apk-md :global(ul), .apk-md :global(ol) { padding-left: 1.3em; margin: 0 0 .5em; }
  .apk-md :global(pre) { background: var(--userbubble); border-radius: 8px; padding: 8px 10px; overflow-x: auto; font-size: 12.5px; }
  .apk-md :global(code) { font-family: "Anthropic Mono", ui-monospace, Consolas, monospace; font-size: .9em; }
  .apk-md :global(a) { color: inherit; text-decoration: underline; text-underline-offset: 3px; }
  .apk-s { display: flex; align-items: baseline; gap: 8px; font-size: 13px; line-height: 1.5; color: var(--serif); min-width: 0; }
  .apk-s .dot { flex: none; width: 5px; height: 5px; border-radius: 1.5px; background: var(--muted); transform: translateY(-2px); }
  .apk-s .sl { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .apk-s .sm { flex: none; color: var(--muted); }
  .apk-s.run .dot { animation: apkBlink 1.2s ease-in-out infinite; }
  @keyframes apkBlink { 50% { opacity: .15; } }

  .apk-c { flex: none; padding: 10px 12px calc(12px + var(--sab, 0px)); }
  .apk-box { display: flex; align-items: flex-end; gap: 8px; border-radius: 12px; padding: 8px 8px 8px 12px; background: var(--card);
    box-shadow: inset 0 0 0 1px var(--cc-ring); }
  .apk-box:focus-within { box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 28%, transparent); }
  .apk-box textarea { flex: 1; min-width: 0; min-height: 32px; max-height: 132px; resize: none; border: 0; outline: none; background: none; color: var(--text);
    font: inherit; font-size: 14px; line-height: 20px; padding: 6px 0; }
  .apk-box textarea::placeholder { color: var(--muted); }
  .apk-send { flex: none; width: 32px; height: 32px; display: grid; place-items: center; border: 0; border-radius: 8px; background: var(--text); color: var(--bg);
    opacity: 0; transform: scale(.9); pointer-events: none; cursor: pointer;
    transition: opacity 120ms cubic-bezier(.165, .84, .44, 1), transform 200ms cubic-bezier(.34, 1.3, .64, 1); }
  .apk-send.on { opacity: 1; transform: none; pointer-events: auto; }
  .apk-send:disabled.on { opacity: .5; }
  .apk-send:active { transform: scale(.94); }
  .apk-send svg { width: 16px; height: 16px; }
  .apk-hint { font-size: 11.5px; color: var(--muted); padding: 6px 4px 0; }
  @media (pointer: coarse) { .apk-box textarea { font-size: 16px; } }
  @media (prefers-reduced-motion: reduce) {
    .apk, .apk.phone, .apk.phone.on, .apk-send { transition: none; }
    .apk-s.run .dot { animation: none; }
  }
</style>
