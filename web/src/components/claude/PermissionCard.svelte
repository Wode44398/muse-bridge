<script>
  // 逐次工具审批卡（官方 Claude Desktop 3.1623 cc32965c2 组件 I_，dock 形态：停在输入框上方，A1 §9）。
  // 数据：lib/permissions.svelte.js 的 perm.cards[sid]（只放还在等的；同账号任何一台设备答了，perm_answer 帧到了就摘）。
  // 多张排队时只摆第一张，标题旁标 +N（并行工具 / 多个子 agent 各自要批）。
  // 标题句「允许 Claude {动作} {对象}？」；按内容给命令 / 文件改动预览 / 网址 / MCP「Claude 发送的内容」。
  // 按钮照官方：拒绝（Esc）……「始终允许」（Ctrl+Shift+Enter，范围由 CLI 给的 suggestions 决定）「允许一次」（Ctrl+Enter，主按钮），
  // 主按钮下拉「允许，并切换到自动模式」（自动模式可用时）。defaultToNo：主按钮换成「拒绝」，没有一键批准。
  // 只在这一轮还活着、且是当前会话时显示（同 RefusalBand 的判据）；ClaudePage / SoloPage 的 .band-slot 靠 :has() 判空收起。
  import { session } from '../../lib/state.svelte.js';
  import { pendingCards, answerPermission, permTitleParts, modeLabel, typingInto, keyYield, permReason, modeView } from '../../lib/permissions.svelte.js';
  import { t, tc, tr } from '../../lib/i18n.js';

  let { sessionId = null } = $props();

  const list = $derived(sessionId ? pendingCards(sessionId) : []);
  const card = $derived(session.busy && list.length && session.id === sessionId ? list[0] : null);
  const parts = $derived(card ? permTitleParts(card) : null);
  const p = $derived((card && card.preview) || {});
  const busy = $derived(!!(card && card.submitting));
  const alwaysLabel = $derived(card && card.always && card.always.persistent ? t('始终允许') : t('本会话都允许'));
  let menuOpen = $state(false);
  let showFields = $state(false);
  let autoAsk = $state(false);   // 「允许，并切换到自动模式」：还没确认过自动模式就先在卡里展开同一个首次确认（A1 §8.7）
  let rootEl = $state(null);
  $effect(() => { if (card) { card.qid; menuOpen = false; showFields = false; autoAsk = false; } });

  // 说明行：工具自己给的说明（标题里已经用了的——Bash 的 description 就是标题的对象——不再重复一行）；
  // 原因行：CLI 的 decision_reason 按类型给一句本地化引子 + 原文（permReason）
  const descLine = $derived(card && card.description && card.description !== (parts && parts.meta) ? tr(card.description) : '');
  const why = $derived(card ? permReason(card) : { lead: '', detail: '' });

  // 关沙箱的命令（官方 read gate）：命令框要滚到底才能允许——看不全的命令不许一键放行
  let codeEl = $state(null);
  let readAll = $state(true);
  const gated = $derived(!!(card && p.kind === 'command' && p.unsandboxed));
  const checkRead = () => { if (codeEl) readAll = codeEl.scrollTop + codeEl.clientHeight >= codeEl.scrollHeight - 2; };
  $effect(() => { if (card) { card.qid; readAll = !gated; if (gated) queueMicrotask(checkRead); } });
  const allowBlocked = $derived(gated && !readAll);
  // 文件改动预览：old → 「−」行，new → 「+」行（官方 Writes / Removes / Adds 片段）
  const MAX_LINES = 40;
  function lines(s, sign) {
    const arr = String(s || '').split('\n');
    const out = arr.slice(0, MAX_LINES).map((l) => ({ sign, text: l }));
    if (arr.length > MAX_LINES) out.push({ sign: '…', text: t('还有 {n} 行', { n: arr.length - MAX_LINES }) });
    return out;
  }
  const diff = $derived.by(() => {
    if (!card) return [];
    if (p.kind === 'write') return [lines(p.content, '+')];
    if (p.kind === 'edit') return (p.edits || []).map((e) => [...(e.old ? lines(e.old, '−') : []), ...lines(e.new, '+')]);
    return [];
  });
  const scopeText = (it) => (it.kind === 'mode' ? t('切到{mode}', { mode: modeLabel(it.mode) })
    : it.kind === 'dirs' ? t('访问 {dir}', { dir: (it.dirs || []).join('、') })
      : it.content ? `${it.tool}(${it.content})` : t('{tool} 的所有调用', { tool: it.tool }));

  const decide = (d) => {
    menuOpen = false;
    if (!card) return;
    if (d === 'auto') { const v = modeView(card.sessionId, null) || modeView(); if (!(v && v.consent && v.consent.auto)) { autoAsk = true; return; } }
    answerPermission(card, d);
  };
  const confirmAuto = () => { autoAsk = false; if (card) answerPermission(card, 'auto', { ack: true }); };

  // 快捷键：别处在打字（输入框有草稿）就不抢；卡片刚冒出来 400ms 内的回车不认（防误触）；
  // 别的浮层（模式芯片菜单 / 确认框 / 灯箱…）开着时让路（keyYield）——它们的 Esc 只该关它们自己。
  // defaultToNo（高风险请求，SDK 约定不能被一次误触批准）：所有批准类快捷键都不认，只能鼠标点；关沙箱命令没看完同理。
  $effect(() => {
    if (!card) return;
    const c = card;
    const onKey = (e) => {
      if (e.isComposing || c.submitting || typingInto(e.target)) return;
      if (e.key === 'Escape' && !e.ctrlKey && !e.metaKey) {
        if (menuOpen) { menuOpen = false; e.preventDefault(); return; }
        if (autoAsk) { autoAsk = false; e.preventDefault(); e.stopPropagation(); return; }
        if (keyYield(e, rootEl)) return;
        e.preventDefault(); e.stopPropagation(); decide('deny'); return;
      }
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
      if (autoAsk) return;   // 确认框开着：只能点
      if (keyYield(e, rootEl)) return;
      if (Date.now() - (c.shownAt || 0) < 400 || c.defaultToNo || allowBlocked) return;
      e.preventDefault(); e.stopPropagation();
      if (e.shiftKey) { if (c.canAlways) decide('always'); }
      else decide('once');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  $effect(() => {
    if (!menuOpen) return;
    const onDown = (e) => { if (!e.target.closest?.('.pm-split')) menuOpen = false; };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  });
  const kbd = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || '') ? '⌘' : 'Ctrl';
  const touchUI = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
</script>

{#if card}
  <div class="pm" role="alertdialog" aria-label={t('权限请求：{action}', { action: parts.action })} tabindex="-1" bind:this={rootEl}>
    <div class="pm-head">
      <span class="pm-title sel-text">
        {tc('perm', '允许 Claude')}<b>{parts.action}</b>{#if parts.meta}<span class="pm-meta" title={parts.meta}>{parts.meta}</span>{/if}{tc('perm', '？')}
      </span>
      {#if list.length > 1}<span class="pm-q" title={t('还有 {n} 个请求在排队', { n: list.length - 1 })}>+{list.length - 1}</span>{/if}
    </div>

    {#if card.planMode}<div class="pm-note">{t('Claude 处于计划模式，这一步只能由你批准。')}</div>{/if}
    {#if card.agentId}<div class="pm-desc">{t('子 agent 发起的请求')}</div>{/if}
    {#if descLine}<div class="pm-desc sel-text">{descLine}</div>{/if}
    {#if why.lead || why.detail}
      <div class="pm-desc sel-text">{why.lead}{#if why.lead && why.detail}{' '}{/if}{#if why.detail}<span class="pm-why">{why.detail}</span>{/if}</div>
    {/if}

    {#if p.kind === 'command' && p.command}
      <pre class="pm-code sel-text" bind:this={codeEl} onscroll={gated ? checkRead : undefined}><span class="pm-ps">{card.tool === 'PowerShell' ? '>' : '$'}</span> {p.command}</pre>
      {#if p.background}<div class="pm-desc">{t('会在后台一直运行。')}</div>{/if}
      {#if p.unsandboxed}<div class="pm-desc warn">{t('在 Claude 的沙箱之外运行。')}</div>{/if}
      {#if allowBlocked}<div class="pm-desc">{t('把整条命令滚动看完才能允许。')}</div>{/if}
    {:else if (p.kind === 'write' || p.kind === 'edit') && p.path}
      <div class="pm-path sel-text" title={p.path}>{p.path}</div>
      {#each diff as block, bi (bi)}
        <div class="pm-diff sel-text">
          {#each block as ln, li (li)}<div class="dl" class:add={ln.sign === '+'} class:del={ln.sign === '−'}><span class="sg">{ln.sign}</span><span class="tx">{ln.text || ' '}</span></div>{/each}
        </div>
      {/each}
      {#if p.more}<div class="pm-desc">{t('这个文件里还有 {n} 处改动', { n: p.more })}</div>{/if}
    {:else if p.kind === 'fetch'}
      <div class="pm-path sel-text" title={p.url}>{p.url}</div>
      {#if p.prompt}<div class="pm-desc sel-text">{p.prompt}</div>{/if}
    {:else if p.kind === 'path' || (p.kind === 'search' && p.path)}
      <div class="pm-path sel-text">{p.kind === 'search' ? p.pattern + ' · ' + p.path : p.path}</div>
    {:else if p.kind === 'agent' && p.prompt}
      <div class="pm-desc sel-text clamp">{p.prompt}</div>
    {:else if p.kind === 'skill' && p.args}
      <div class="pm-desc sel-text">{p.args}</div>
    {:else if p.kind === 'fields' && (p.fields || []).length}
      <button type="button" class="pm-fold" aria-expanded={showFields} onclick={() => (showFields = !showFields)}>
        <span class="pm-caret" class:open={showFields} aria-hidden="true">›</span>{t('Claude 发送的内容')}
      </button>
      {#if showFields}
        <div class="pm-fields sel-text">
          {#each p.fields as [k, v] (k)}<div class="pm-kv"><span class="k">{k}</span><span class="v">{v}</span></div>{/each}
        </div>
      {/if}
    {/if}

    {#if card.canAlways && card.always && card.always.items.length}
      <div class="pm-scope">
        {card.always.persistent ? t('「始终允许」会写进这个项目的设置，涵盖：') : t('「本会话都允许」在本会话内有效，涵盖：')}
        {#each card.always.items as it, i (i)}<code>{scopeText(it)}</code>{/each}
      </div>
    {/if}
    {#if card.error}<div class="pm-err" role="status">{card.error}</div>{/if}

    <div class="pm-acts">
      <button type="button" class="pm-btn" class:primary={card.defaultToNo} disabled={busy} onclick={() => decide('deny')}>
        {t('拒绝')}{#if !touchUI}<span class="kb">Esc</span>{/if}
      </button>
      <span class="pm-grow"></span>
      {#if card.canAlways}
        <button type="button" class="pm-btn" disabled={busy || allowBlocked} title={touchUI || card.defaultToNo ? t('此工具不再询问') : t('此工具不再询问') + ' · ' + kbd + '+Shift+Enter'} onclick={() => decide('always')}>{alwaysLabel}</button>
      {/if}
      <div class="pm-split" class:has-menu={card.canAuto}>
        <button type="button" class="pm-btn main" class:primary={!card.defaultToNo} disabled={busy || allowBlocked} title={touchUI || card.defaultToNo ? '' : kbd + '+Enter'} onclick={() => decide('once')}>{t('允许一次')}</button>
        {#if card.canAuto}
          <button type="button" class="pm-btn caret" class:primary={!card.defaultToNo} aria-label={t('更多允许选项')} aria-expanded={menuOpen} disabled={busy || allowBlocked} onclick={() => (menuOpen = !menuOpen)}>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
          </button>
          {#if menuOpen}
            <div class="pm-menu" role="menu">
              <button type="button" role="menuitem" class="pm-mi" onclick={() => decide('auto')}>
                <span>{t('允许，并切换到自动模式')}</span><small>{t('本会话余下部分由自动模式审核')}</small>
              </button>
            </div>
          {/if}
        {/if}
      </div>
    </div>
    {#if autoAsk}
      <div class="pm-cf" role="group" aria-label={t('启用自动模式？')}>
        <div class="pm-cf-t">{t('启用自动模式？')}</div>
        <div class="pm-cf-b">{t('Claude 会自行判断哪些操作可以不经询问直接执行。较长的任务可以不被打断地运行，并有额外的提示注入防护。')}</div>
        <div class="pm-cf-f">{t('以后不会再问。自动模式的审核请求会计入用量。')}</div>
        <div class="pm-acts">
          <span class="pm-grow"></span>
          <button type="button" class="pm-btn" disabled={busy} onclick={() => (autoAsk = false)}>{t('取消')}</button>
          <button type="button" class="pm-btn primary" disabled={busy || allowBlocked} onclick={confirmAuto}>{t('启用自动模式')}</button>
        </div>
      </div>
    {/if}
  </div>
{/if}

<style>
  .pm-cf { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; border-radius: 8px; background: var(--hover); }
  .pm-cf-t { font-weight: 600; }
  .pm-cf-b { color: var(--text); }
  .pm-cf-f { font-size: 13px; color: var(--muted); }
  /* 官方 epitaxy-approval-card：r10 / p12 / 行距 12 / 升起动效；底与阴影借问答卡（与 Paused 卡同族） */
  .pm { display: flex; flex-direction: column; gap: 10px; width: 100%; box-sizing: border-box; padding: 12px; border-radius: 10px;
    background: var(--q-card, var(--card)); box-shadow: var(--q-shadow, 0 0 0 1px var(--divider), 0 4px 24px rgba(0,0,0,.08));
    font-size: 14px; line-height: 20px; color: var(--text); container-type: inline-size; outline: none;
    max-height: min(56vh, 520px); overflow-y: auto;
    transform-origin: bottom; animation: pmIn .22s cubic-bezier(.215,.61,.355,1); }
  @keyframes pmIn { from { opacity: .75; transform: translateY(6px) scale(.97); } to { opacity: 1; transform: none; } }
  .pm-head { display: flex; align-items: flex-start; gap: 8px; }
  .pm-title { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  .pm-title b { font-weight: 600; margin: 0 .25em; }
  .pm-meta { color: var(--serif); margin-right: .1em; }
  .pm-q { flex: none; padding: 1px 7px; border-radius: 999px; background: var(--hover-strong, var(--hover)); color: var(--muted); font-size: 12px; line-height: 18px; }
  .pm-note { color: var(--serif); font-size: 13px; }
  .pm-desc { color: var(--muted); font-size: 13px; line-height: 19px; overflow-wrap: anywhere; }
  .pm-desc.warn { color: var(--crit, #d98a6a); }
  .pm-why { color: var(--muted); opacity: .85; }
  .pm-desc.clamp { display: -webkit-box; -webkit-line-clamp: 4; line-clamp: 4; -webkit-box-orient: vertical; overflow: hidden; }
  .pm-scope code { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 12.5px; word-break: break-all; }
  .pm-code { margin: 0; padding: 8px 10px; border-radius: 8px; background: var(--hover); max-height: 180px; overflow: auto;
    font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 12.5px; line-height: 18px; white-space: pre-wrap; word-break: break-all; }
  .pm-ps { color: var(--muted); user-select: none; }
  .pm-path { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 12.5px; color: var(--serif); overflow-wrap: anywhere; }
  .pm-diff { border-radius: 8px; background: var(--hover); max-height: 200px; overflow: auto; padding: 4px 0;
    font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: 12px; line-height: 17px; }
  .dl { display: flex; padding: 0 10px 0 6px; white-space: pre-wrap; word-break: break-all; }
  .dl.add { background: color-mix(in srgb, var(--ok, #4caf50) 12%, transparent); }
  .dl.del { background: color-mix(in srgb, var(--crit, #d9534f) 12%, transparent); }
  .dl .sg { flex: none; width: 14px; color: var(--muted); user-select: none; }
  .dl.add .sg { color: var(--ok, #4caf50); }
  .dl.del .sg { color: var(--crit, #d9534f); }
  .dl .tx { flex: 1; min-width: 0; }
  .pm-fold { align-self: flex-start; display: inline-flex; align-items: center; gap: 4px; padding: 0; color: var(--serif); font-size: 13px; }
  .pm-caret { display: inline-block; transition: transform var(--mo-quick, .15s); }
  .pm-caret.open { transform: rotate(90deg); }
  .pm-fields { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; border-radius: 8px; background: var(--hover); max-height: 180px; overflow: auto; }
  .pm-kv { display: flex; gap: 10px; font-size: 12.5px; line-height: 18px; }
  .pm-kv .k { flex: none; color: var(--muted); font-family: ui-monospace, "SF Mono", Consolas, monospace; }
  .pm-kv .v { flex: 1; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .pm-scope { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 6px; color: var(--muted); font-size: 12.5px; line-height: 18px; }
  .pm-scope code { padding: 0 5px; border-radius: 4px; background: var(--hover); color: var(--serif); }
  .pm-err { color: var(--err, #d98a6a); font-size: 13px; }

  .pm-acts { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .pm-grow { flex: 1; }
  .pm-btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 32px; padding: 6px 12px; border-radius: 9px;
    font-size: 14px; line-height: 20px; font-weight: 500; color: var(--text); border: 1px solid var(--q-skipborder, var(--divider));
    transition: background-color 60ms ease-out, transform 60ms ease-out; }
  @media (hover: hover) { .pm-btn:hover:not(:disabled) { background: var(--hover); } }
  .pm-btn:active:not(:disabled) { background: var(--hover-strong); transform: scale(.985); }
  .pm-btn:disabled { opacity: .5; cursor: default; }
  .pm-btn.primary { background: var(--text); color: var(--bg); border-color: transparent; }
  @media (hover: hover) { .pm-btn.primary:hover:not(:disabled) { background: var(--text); filter: brightness(.92); } }
  .kb { font-size: 11.5px; opacity: .55; font-weight: 400; }
  .pm-split { position: relative; display: flex; }
  .pm-split.has-menu .main { border-radius: 9px 3px 3px 9px; }
  .pm-split .caret { margin-left: 1.5px; padding: 6px 7px; border-radius: 3px 9px 9px 3px; }
  .pm-menu { position: absolute; right: 0; bottom: calc(100% + 6px); z-index: 30; min-width: 230px; max-width: min(320px, 86vw); padding: 4px;
    border-radius: 10px; background: var(--card); box-shadow: var(--card-shadow, 0 8px 28px rgba(0,0,0,.28)); display: flex; flex-direction: column; }
  .pm-mi { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 7px 10px; border-radius: 7px; text-align: left; font-size: 13.5px; color: var(--text); }
  .pm-mi small { font-size: 12px; color: var(--muted); }
  @media (hover: hover) { .pm-mi:hover { background: var(--hover); } }
  /* 窄卡（手机 / 分屏）：按钮竖排撑满，主按钮在最下（拇指够得着） */
  @container (width <= 420px) {
    .pm-acts { flex-direction: column; align-items: stretch; }
    .pm-grow { display: none; }
    .pm-split .main { flex: 1; }
    .kb { display: none; }
  }
  @media (prefers-reduced-motion: reduce) { .pm { animation: none; } }
</style>
