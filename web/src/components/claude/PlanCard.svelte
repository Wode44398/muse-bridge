<script module>
  // 没发出去的修改意见与划词批注按 tool id 暂存（官方 unsentFeedback）：attach 重放会重建段对象，切会话回来也还在
  const drafts = new Map();   // qid -> { text, comments:[{quote, text, at}] }
  // 全局快捷键只给最近一张还在等的计划卡（并行时不会两张同时响应）
  const stack = [];
</script>

<script>
  // 计划审批卡（官方 Claude Desktop 3.1623 cc32965c2 组件 gs + 侧栏 plan 面板的划词批注，A1 §10）。
  // 数据：消息流里的 plan 段（lib/permissions.svelte.js onPermEvent 落；历史重建 sessions.mjs 落同形的已处理段）。
  //   还在等：计划正文（markdown，可折叠）+ 划词批注 + 左「拒绝 / 修改…」右「接受」+ 主按钮「接受并{目标模式}」（分裂按钮，
  //          「更多接受选项」列出全部目标模式与「清空上下文后执行」）；修改态 = 多行输入 + 「修改」。
  //   已处理：结论一行（已批准 · 模式 / 已退回修改 + 意见 / 已拒绝 / 已在新会话中执行）+ 计划默认收起。
  // 快捷键（照官方，只在没在别处打字时生效、卡片出现 400ms 内不认）：Ctrl+Enter 主按钮、Ctrl+Shift+Enter「接受」、Esc 进修改态。
  import { onDestroy, tick } from 'svelte';
  import { renderMarkdown } from '../../lib/md.js';
  import { answerPlan, modeLabel, planFeedback, typingInto, keyYield, pendingCards } from '../../lib/permissions.svelte.js';
  import { openSession } from '../../lib/chat.svelte.js';
  import { session } from '../../lib/state.svelte.js';
  import { glyph } from '../../lib/claudeIcons.js';
  import { t, tc } from '../../lib/i18n.js';

  let { seg, live = false } = $props();

  const pending = $derived(!seg.answered);
  const draft = $derived.by(() => { let d = drafts.get(seg.qid); if (!d) { d = { text: '', comments: [] }; drafts.set(seg.qid, d); } return d; });
  let comments = $state([]);
  let text = $state('');
  $effect.pre(() => { comments = draft.comments.slice(); text = draft.text; });
  const keep = () => { draft.comments = comments.slice(); draft.text = text; };

  // 等待中默认展开、已处理默认收起（只看结论）。初值就按状态给——历史里的已处理卡要是先展开（计划正文最高 60vh）
  // 下一拍再收，重开会话时消息高度先大后小，滚动到底和锚点恢复会跳。effect 只管「等待中 → 已处理」那一次收起；
  // 人手动展开过就不再替他收。
  // svelte-ignore state_referenced_locally
  let open = $state(!seg.answered);
  let userToggled = false;
  $effect(() => { if (!pending && !userToggled) open = false; });
  let revising = $state(false);
  let menuOpen = $state(false);

  // —— 接受选项 ——
  const ACCEPT_LABEL = {
    default: () => t('接受'),
    acceptEdits: () => t('接受并允许编辑'),
    auto: () => t('接受并进入自动模式'),
    bypassPermissions: () => t('接受并绕过权限'),
  };
  const trust = $derived(seg.trust && (seg.trust === 'default' || (seg.accept || []).includes(seg.trust)) ? seg.trust : 'default');
  const showManual = $derived(trust !== 'default');
  const moreOpts = $derived([
    ...(seg.accept || []).map((m) => ({ key: 'a:' + m, label: ACCEPT_LABEL[m] ? ACCEPT_LABEL[m]() : m, run: () => accept(m) })),
    ...(seg.canClear ? [{ key: 'clear', label: t('清空上下文后执行（{mode}）', { mode: modeLabel(trust) }), hint: t('新开一个会话，只带着这份计划去做'), run: () => clearRun() }] : []),
  ]);
  const hasMenu = $derived(moreOpts.length > 1 || seg.canClear);

  async function accept(mode) { menuOpen = false; if (await answerPlan(seg, 'accept', { mode })) { drafts.delete(seg.qid); } }
  async function clearRun() { menuOpen = false; if (await answerPlan(seg, 'clear', { mode: trust })) drafts.delete(seg.qid); }
  async function reject() { if (await answerPlan(seg, 'reject')) drafts.delete(seg.qid); }
  async function submitRevise() {
    const fb = planFeedback(comments, text);
    const ok = await answerPlan(seg, fb ? 'revise' : 'reject', fb ? { feedback: fb } : {});
    if (ok) drafts.delete(seg.qid);
  }
  async function startRevise() {
    revising = true; menuOpen = false;
    await tick();
    taEl?.focus();
  }
  function backFromRevise() { keep(); revising = false; }

  // —— 划词批注（官方 plan 面板：选中任意文字给 Claude 留批注）——
  let bodyEl = $state(null), cardEl = $state(null), taEl = $state(null), noteEl = $state(null);
  let sel = $state(null);       // { quote, at, x, y } 选中了、还没开始写
  let noting = $state(null);    // { quote, at, x, y, text } 正在写批注
  function textOffset(range) {
    try { const r = document.createRange(); r.selectNodeContents(bodyEl); r.setEnd(range.startContainer, range.startOffset); return r.toString().length; } catch { return 0; }
  }
  function onSelect() {
    if (!pending || !bodyEl || noting) return;
    const s = window.getSelection();
    if (!s || s.isCollapsed || !s.rangeCount) { sel = null; return; }
    const range = s.getRangeAt(0);
    if (!bodyEl.contains(range.commonAncestorContainer)) { sel = null; return; }
    const quote = s.toString().trim();
    if (!quote) { sel = null; return; }
    const rr = range.getBoundingClientRect(), cr = cardEl.getBoundingClientRect();
    sel = { quote: quote.slice(0, 2000), at: textOffset(range), x: Math.max(8, Math.min(rr.left - cr.left, cr.width - 120)), y: rr.bottom - cr.top + 6 };
  }
  async function startNote() {
    if (!sel) return;
    noting = { ...sel, text: '' };
    sel = null;
    try { window.getSelection()?.removeAllRanges(); } catch {}
    await tick();
    noteEl?.focus();
  }
  function saveNote() {
    if (!noting || !noting.text.trim()) { noting = null; return; }
    comments = [...comments, { quote: noting.quote, text: noting.text.trim(), at: noting.at }].sort((a, b) => a.at - b.at);
    noting = null;
    keep();
  }
  function delNote(i) { comments = comments.filter((_, k) => k !== i); keep(); }
  function noteKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); saveNote(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); noting = null; }
  }
  function taKey(e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.isComposing) { e.preventDefault(); submitRevise(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); backFromRevise(); }
  }

  // —— 全局快捷键 ——
  const me = {};
  $effect(() => {
    if (!pending || !live) return;
    stack.push(me);
    const onKey = (e) => {
      if (stack[stack.length - 1] !== me || seg.submitting || e.isComposing) return;
      if (Date.now() - (seg.shownAt || 0) < 400) return;   // 卡片刚冒出来时的回车不算（官方防误触）
      if (revising || noting) return;                       // 修改态 / 写批注时键交给输入框
      if (typingInto(e.target)) return;
      if (e.key !== 'Escape' && !(e.key === 'Enter' && (e.ctrlKey || e.metaKey))) return;
      if (e.key === 'Escape' && menuOpen) { e.preventDefault(); menuOpen = false; return; }   // 先关自己的「更多接受选项」
      if (keyYield(e, cardEl)) return;                      // 别的浮层（芯片菜单 / 确认框 / 灯箱…）开着：它们的键归它们
      if (pendingCards(session.id).length) return;          // 同时挂着逐次审批卡（并行子 agent）：键先给停靠在输入框上的那张
      e.preventDefault(); e.stopPropagation();
      if (e.key === 'Escape') startRevise();
      else if (e.shiftKey) { if (showManual) accept('default'); }
      else accept(trust);
    };
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('keydown', onKey, true); const i = stack.indexOf(me); if (i >= 0) stack.splice(i, 1); };
  });
  $effect(() => {
    if (!menuOpen) return;
    const onDown = (e) => { if (cardEl && !e.target.closest?.('.pc-split')) menuOpen = false; };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  });
  onDestroy(() => { if (pending) keep(); });
  // 本机点的「清空上下文后执行」：新会话开起来了，等这一轮收住（loadSession 在跑时不动）就切过去
  let jumped = false;
  $effect(() => {
    if (jumped || !seg.__mine || !seg.newSessionId || session.busy) return;
    jumped = true;
    openSession(seg.newSessionId);
  });

  const html = $derived(seg.plan ? renderMarkdown(seg.plan) : '');
  const verdict = $derived.by(() => {
    switch (seg.decision) {
      case 'accept': return seg.mode ? t('已批准 · {mode}', { mode: modeLabel(seg.mode) }) : t('已批准');
      case 'clear': return t('已批准，在新会话中执行');
      case 'revise': return t('已退回修改');
      case 'reject': return tc('plan', '已拒绝');
      case 'cancelled': return t('没有批完（这一轮已停止）');
    }
    return '';
  });
  const kbd = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || '') ? '⌘' : 'Ctrl';
  const touchUI = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<div class="pc" class:done={!pending} bind:this={cardEl} role="group" aria-label={t('计划审批')} onmouseup={onSelect} ontouchend={() => setTimeout(onSelect, 30)}>
  <div class="pc-head">
    <span class="pc-ic" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2.5h6.5L13 5v8.5H4z"/><path d="M10.5 2.5V5H13"/><path d="M6 8h5M6 10.5h3.5"/></svg></span>
    <span class="pc-title">{t('Claude 提出了一个计划')}</span>
    {#if seg.planFile}<span class="pc-file" title={seg.planFile}>{seg.planFile}</span>{/if}
    <button type="button" class="pc-tog" aria-expanded={open} aria-label={open ? t('收起计划') : t('展开计划')} onclick={() => { userToggled = true; open = !open; }}>
      <span class="gi" aria-hidden="true">{glyph(open ? 'CaretDown' : 'CaretRight')}</span>
    </button>
  </div>

  {#if open}
    {#if html}
      <div class="pc-body sel-text" bind:this={bodyEl}>{@html html}</div>
    {:else}
      <div class="pc-empty">{t('这次没有附上计划正文')}</div>
    {/if}
    {#if pending && !touchUI && !comments.length && !noting}<div class="pc-tip">{t('选中计划里的文字，可以给 Claude 留批注')}</div>{/if}
  {/if}

  {#if sel && pending}
    <button type="button" class="pc-addnote" style:left={sel.x + 'px'} style:top={sel.y + 'px'} onmousedown={(e) => e.preventDefault()} onclick={startNote}>
      {t('批注')}
    </button>
  {/if}
  {#if noting}
    <div class="pc-note-edit" style:top={noting.y + 'px'}>
      <div class="pc-quote">{noting.quote}</div>
      <textarea bind:this={noteEl} bind:value={noting.text} rows="2" placeholder={t('给 Claude 的批注')} aria-label={t('计划批注')} onkeydown={noteKey}></textarea>
      <div class="pc-note-acts">
        <button type="button" class="pc-btn ghost" onclick={() => (noting = null)}>{t('取消')}</button>
        <button type="button" class="pc-btn primary" disabled={!noting.text.trim()} onclick={saveNote}>{t('保存')}</button>
      </div>
    </div>
  {/if}

  {#if comments.length && pending}
    <div class="pc-notes">
      {#each comments as c, i (i + ':' + c.at)}
        <div class="pc-note">
          <div class="pc-note-main">
            <div class="pc-quote">{c.quote}</div>
            <div class="pc-note-text sel-text">{c.text}</div>
          </div>
          <button type="button" class="pc-x" aria-label={t('删除批注')} onclick={() => delNote(i)}><span class="gi" aria-hidden="true">{glyph('X')}</span></button>
        </div>
      {/each}
    </div>
  {/if}

  {#if pending}
    {#if revising}
      <textarea class="pc-fb" bind:this={taEl} bind:value={text} rows="3" oninput={keep} onkeydown={taKey}
        placeholder={comments.length ? t('还有什么要补充？') : t('需要改什么？（可选）')} aria-label={t('修改意见')}></textarea>
    {/if}
    {#if seg.submitError}<div class="pc-err" role="status">{seg.submitError}</div>{/if}
    <div class="pc-acts">
      {#if revising}
        <div class="pc-left">
          {#if !comments.length}<button type="button" class="pc-btn" disabled={seg.submitting} onclick={backFromRevise}>{t('返回')}</button>{/if}
        </div>
        <div class="pc-right">
          <button type="button" class="pc-btn primary" disabled={seg.submitting} onclick={submitRevise}>{tc('plan', '修改')}</button>
        </div>
      {:else}
        <div class="pc-left">
          <button type="button" class="pc-btn" disabled={seg.submitting} onclick={reject}>{tc('plan', '拒绝')}</button>
          <button type="button" class="pc-btn" disabled={seg.submitting} title={touchUI ? '' : 'Esc'} onclick={startRevise}>{t('修改…')}</button>
        </div>
        <div class="pc-right">
          {#if showManual}
            <button type="button" class="pc-btn" disabled={seg.submitting} title={touchUI ? '' : kbd + '+Shift+Enter'} onclick={() => accept('default')}>{ACCEPT_LABEL.default()}</button>
          {/if}
          <div class="pc-split" class:has-menu={hasMenu}>
            <button type="button" class="pc-btn primary main" disabled={seg.submitting} title={touchUI ? '' : kbd + '+Enter'} onclick={() => accept(trust)}>{ACCEPT_LABEL[trust]()}</button>
            {#if hasMenu}
              <button type="button" class="pc-btn primary caret" aria-label={t('更多接受选项')} aria-expanded={menuOpen} disabled={seg.submitting} onclick={() => (menuOpen = !menuOpen)}>
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
              </button>
              {#if menuOpen}
                <div class="pc-menu" role="menu">
                  <div class="pc-menu-h">{t('更多接受选项')}</div>
                  {#each moreOpts as o (o.key)}
                    <button type="button" role="menuitem" class="pc-mi" onclick={o.run}>
                      <span>{o.label}</span>{#if o.hint}<small>{o.hint}</small>{/if}
                    </button>
                  {/each}
                </div>
              {/if}
            {/if}
          </div>
        </div>
      {/if}
    </div>
  {:else}
    <div class="pc-verdict" class:neg={seg.decision === 'reject' || seg.decision === 'cancelled'}>
      <span class="pc-v">{verdict}</span>
      {#if seg.decision === 'clear' && seg.newSessionId}
        <button type="button" class="pc-link" onclick={() => openSession(seg.newSessionId)}>{t('打开新会话')}</button>
      {:else if seg.decision === 'clear' && seg.error}
        <span class="pc-v-err">{t('新会话没能开起来')}</span>
      {/if}
    </div>
    {#if seg.decision === 'revise' && seg.feedback}<div class="pc-fbshow sel-text">{seg.feedback}</div>{/if}
  {/if}
</div>

<style>
  /* 官方 epitaxy-approval-card：r10 / p12 / 行距 12；底与阴影借问答卡的 --q-card / --q-shadow（与 Paused 卡同族） */
  .pc { position: relative; margin-top: 16px; display: flex; flex-direction: column; gap: 10px; padding: 12px; border-radius: 12px;
    background: var(--q-card, var(--card)); box-shadow: var(--q-shadow, 0 0 0 1px var(--divider)); color: var(--text);
    font-size: 14px; line-height: 20px; container-type: inline-size; animation: pcIn .22s cubic-bezier(.215,.61,.355,1); }
  @keyframes pcIn { from { opacity: .75; transform: translateY(-6px) scale(.98); } to { opacity: 1; transform: none; } }
  .pc.done { gap: 8px; }
  .pc-head { display: flex; align-items: center; gap: 8px; min-height: 24px; }
  .pc-ic { flex: none; width: 16px; height: 16px; color: var(--serif); }
  .pc-ic svg { width: 100%; height: 100%; display: block; }
  .pc-title { font-weight: 580; min-width: 0; }
  .pc-file { flex: 1; min-width: 0; color: var(--muted); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-family: ui-monospace, "SF Mono", Consolas, monospace; }
  .pc-tog { margin-left: auto; flex: none; width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border-radius: 6px; color: var(--muted); }
  @media (hover: hover) { .pc-tog:hover { background: var(--hover); color: var(--text); } }
  .gi { font-family: var(--icons); font-style: normal; font-feature-settings: "liga" 0; font-variation-settings: "opsz" 16, "wght" 533;
    font-size: 16px; line-height: 1; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; }

  /* 计划正文：聊天正文的排版缩一号，最高 60vh 自己滚 */
  .pc-body { max-height: 60vh; overflow-y: auto; padding: 10px 12px; border-radius: 9px; background: var(--hover);
    font-size: 14.5px; line-height: 1.65; overflow-wrap: break-word; }
  .pc-body :global(p) { margin: 0 0 10px; }
  .pc-body :global(p:last-child) { margin-bottom: 0; }
  .pc-body :global(h1), .pc-body :global(h2), .pc-body :global(h3), .pc-body :global(h4) { margin: 12px 0 6px; line-height: 1.3; font-size: 1.05em; }
  .pc-body :global(h1:first-child), .pc-body :global(h2:first-child), .pc-body :global(h3:first-child) { margin-top: 0; }
  .pc-body :global(ul), .pc-body :global(ol) { margin: 0 0 10px; padding-left: 20px; }
  .pc-body :global(li) { margin: 2px 0; }
  .pc-body :global(pre) { background: var(--bg); border: 1px solid var(--divider); border-radius: 8px; padding: 8px 10px; overflow-x: auto; margin: 0 0 10px; }
  .pc-body :global(code) { font-family: ui-monospace, "SF Mono", Consolas, monospace; font-size: .9em; }
  .pc-body :global(:not(pre) > code) { background: var(--hover-strong, var(--hover)); padding: 1px 4px; border-radius: 4px; }
  .pc-body :global(a) { color: var(--coral); }
  .pc-empty, .pc-tip { color: var(--muted); font-size: 12.5px; line-height: 18px; }

  /* 划词批注：选中后浮出的小按钮 / 写批注的浮层 / 已存批注的小卡 */
  .pc-addnote { position: absolute; z-index: 4; padding: 4px 10px; border-radius: 8px; font-size: 13px; background: var(--text); color: var(--bg);
    box-shadow: 0 4px 14px rgba(0,0,0,.25); }
  .pc-note-edit { position: absolute; left: 12px; right: 12px; z-index: 5; display: flex; flex-direction: column; gap: 6px; padding: 10px;
    border-radius: 10px; background: var(--card); border: 1px solid var(--divider); box-shadow: 0 8px 28px rgba(0,0,0,.28); }
  .pc-note-edit textarea, .pc-fb { width: 100%; box-sizing: border-box; resize: vertical; min-height: 44px; padding: 8px 10px; border-radius: 8px;
    border: 1px solid var(--q-skipborder, var(--divider)); background: transparent; color: var(--text); font: inherit; font-size: 14px; line-height: 20px; outline: none; }
  .pc-note-edit textarea:focus, .pc-fb:focus { border-color: var(--muted); }
  .pc-note-acts { display: flex; justify-content: flex-end; gap: 6px; }
  .pc-quote { padding-left: 8px; border-left: 2px solid var(--divider); color: var(--muted); font-size: 12.5px; line-height: 18px;
    max-height: 54px; overflow: hidden; white-space: pre-wrap; overflow-wrap: anywhere; }
  .pc-notes { display: flex; flex-direction: column; gap: 6px; }
  .pc-note { display: flex; align-items: flex-start; gap: 6px; padding: 8px 8px 8px 10px; border-radius: 9px; background: var(--hover); }
  .pc-note-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
  .pc-note-text { font-size: 13.5px; line-height: 19px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .pc-x { flex: none; width: 22px; height: 22px; display: inline-flex; align-items: center; justify-content: center; border-radius: 6px; color: var(--muted); }
  @media (hover: hover) { .pc-x:hover { color: var(--text); background: var(--hover-strong); } }

  /* 按钮行：左组次要、右组主按钮（分裂按钮：主键 + 下拉箭头），窄卡竖排撑满（官方 @container width<=420） */
  .pc-acts { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 8px; }
  .pc-left, .pc-right { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
  .pc-right { margin-left: auto; }
  .pc-btn { min-height: 32px; padding: 6px 12px; border-radius: 9px; font-size: 14px; line-height: 20px; font-weight: 500; color: var(--text);
    border: 1px solid var(--q-skipborder, var(--divider)); text-align: center; transition: background-color 60ms ease-out, transform 60ms ease-out; }
  @media (hover: hover) { .pc-btn:hover:not(:disabled) { background: var(--hover); } }
  .pc-btn:active:not(:disabled) { background: var(--hover-strong); transform: scale(.985); }
  .pc-btn:disabled { opacity: .5; cursor: default; }
  .pc-btn.primary { background: var(--text); color: var(--bg); border-color: transparent; }
  @media (hover: hover) { .pc-btn.primary:hover:not(:disabled) { background: var(--text); filter: brightness(.92); } }
  .pc-btn.ghost { border-color: transparent; }
  .pc-split { position: relative; display: flex; }
  .pc-split.has-menu .main { border-radius: 9px 3px 3px 9px; }
  .pc-split .caret { margin-left: 1.5px; padding: 6px 7px; border-radius: 3px 9px 9px 3px; display: inline-flex; align-items: center; }
  .pc-menu { position: absolute; right: 0; bottom: calc(100% + 6px); z-index: 30; min-width: 220px; max-width: min(320px, 86vw); padding: 4px;
    border-radius: 10px; background: var(--card); box-shadow: var(--card-shadow, 0 8px 28px rgba(0,0,0,.28)); display: flex; flex-direction: column; }
  .pc-menu-h { padding: 4px 10px 2px; font-size: 12px; color: var(--muted); }
  .pc-mi { display: flex; flex-direction: column; align-items: flex-start; gap: 1px; padding: 7px 10px; border-radius: 7px; text-align: left; font-size: 13.5px; color: var(--text); }
  .pc-mi small { font-size: 12px; color: var(--muted); }
  @media (hover: hover) { .pc-mi:hover { background: var(--hover); } }
  .pc-err { color: var(--err, #d98a6a); font-size: 13px; }

  /* 已处理：结论一行 */
  .pc-verdict { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; color: var(--serif); font-size: 13.5px; }
  .pc-verdict.neg { color: var(--muted); }
  .pc-link { padding: 0; color: var(--serif); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); font-size: 13.5px; }
  @media (hover: hover) { .pc-link:hover { color: var(--text); } }
  .pc-v-err { color: var(--err, #d98a6a); }
  .pc-fbshow { color: var(--muted); font-size: 13px; line-height: 19px; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 114px; overflow: hidden; }

  @container (width <= 420px) {
    .pc-acts { flex-direction: column; align-items: stretch; }   /* DOM 顺序 = 左组在上、主按钮那组在最下 */
    .pc-left, .pc-right { margin-left: 0; }
    .pc-right > .pc-btn, .pc-split, .pc-left > .pc-btn { flex: 1; }
    .pc-split .main { flex: 1; }
  }
  @media (prefers-reduced-motion: reduce) { .pc { animation: none; } }
</style>
