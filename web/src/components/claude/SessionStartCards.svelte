<script>
  // 「Claude 发起新会话」的卡（2026-10-20，对齐官方 Desktop 3.1623 渲染层 c96d752d0：CQ 卡组 / UJe 提议行 / BJe 按钮条 /
  // RJe 不再询问 / zJe 关闭 X / IJe 进行中 / _Q 只读结束行）。服务端：session-tools.mjs（三档）+ session-proposals.mjs（台账）。
  //
  // 一段连续的 start_session（toolVerbs.toolJoins 并成一段）进来，按 toolUseId 对上卡片台账（sessionFamily.collab）：
  //   · 有卡：画成一组（官方 max-w 480 的描边卡）——
  //       offer 待选      「单独开一个会话来做？」+ 用户原话 + 不再询问▾ /「在这里做」(esc) /「新会话」(ctrl+enter)
  //       提议卡待开      标题（点开看完整任务说明）+ 位置 · 一句话理由 + X 忽略 + 选项 /「开始」；≥2 张组头「全部开始」
  //       进行中          正在写任务说明…（offer 选了新会话、等 Claude 补说明）/ 正在开始…
  //       已开始          子会话一行：点开它；还在干活时可停止（「直接开始」档的「已开始」卡就是这一行）
  //       结束            已忽略 / 已过期 / 没能开始（提议卡可重试）
  //   · 没卡（用户明说的 user_asked、带 proposal_id 的那次、offer 留在这里做 / 没作答）：普通工具行。
  // 快照访客只看不点。界面文案无官方中文，按调研报告建议译法。
  import { untrack } from 'svelte';
  import ToolRow from './ToolRow.svelte';
  import { collab, proposalForTool, loadProposals, answerOffer, startProposals, dismissProposal, sessionById, sessionTitle } from '../../lib/sessionFamily.svelte.js';
  import { openSession } from '../../lib/chat.svelte.js';
  import { session } from '../../lib/state.svelte.js';
  import { approvalWaiting } from '../../lib/permissions.svelte.js';
  import { api } from '../../lib/api.js';
  import { IS_CSNAP } from '../../lib/csnap.js';
  import { openSettingsFromChat, canOpenSettingsFromChat } from '../../lib/settingsNav.svelte.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { glyph } from '../../lib/claudeIcons.js';
  import { t, tr } from '../../lib/i18n.js';

  let { tools = [], live = false } = $props();

  // 打开会话时拉一次它名下的卡（历史重开 / 别的设备上答过的）
  $effect(() => { const sid = session.id; if (sid) untrack(() => loadProposals(sid)); });

  // 卡片态：offer 留在这里做 / 没作答 / 被停下 → 退回工具行（官方 kept_here 不画卡）
  const ROW_ONLY = new Set(['kept_here', 'unanswered', 'superseded']);
  const cardOf = (p) => !!p && !(p.kind === 'offer' && (ROW_ONLY.has(p.status) || p.status === 'dismissed'));
  const entries = $derived(tools.map((tool) => ({ tool, p: proposalForTool(tool.id) })));
  const cards = $derived(entries.filter((e) => cardOf(e.p)).map((e) => e.p));
  // 带 proposal_id 的那次（offer 选了新会话后补说明）：卡就在同一段里、已经显示开没开起来，工具行不再重复
  const cardIds = $derived(new Set(cards.map((p) => p.id)));
  const rowOnly = (e) => !cardOf(e.p) && !(e.tool.input && e.tool.input.proposal_id && cardIds.has(e.tool.input.proposal_id));
  // 工具行按先后摆在卡组前 / 后（卡组的位置 = 第一张卡）
  const firstCard = $derived(entries.findIndex((e) => cardOf(e.p)));
  const rowsBefore = $derived(entries.filter((e, i) => rowOnly(e) && (firstCard < 0 || i < firstCard)));
  const rowsAfter = $derived(firstCard < 0 ? [] : entries.filter((e, i) => rowOnly(e) && i > firstCard));

  // 工具行：offer 的结局写进动词（toolVerbs 认 outcome）；直接开始档自动开的照「Started session」
  function rowTool(e) {
    const p = e.p;
    if (!p) {
      // 带 proposal_id 的那次没有标题：借卡上的，工具行才链得到子会话
      const pid = e.tool.input && e.tool.input.proposal_id;
      const src = pid ? collab.proposals[pid] : null;
      return src && src.title && !(e.tool.input && e.tool.input.title) ? { ...e.tool, input: { ...e.tool.input, title: src.title } } : e.tool;
    }
    return { ...e.tool, outcome: p.status };
  }

  // —— 组头 ——
  const OPEN = new Set(['pending', 'start_failed']);
  const startable = (p) => p.kind === 'own' && OPEN.has(p.status);
  const startableIds = $derived(cards.filter(startable).map((p) => p.id));
  const startedN = $derived(cards.filter((p) => p.status === 'started').length);
  const single = $derived(cards.length === 1 ? cards[0] : null);
  const offerPending = $derived(cards.find((p) => p.kind === 'offer' && p.status === 'pending' && p.qid) || null);
  const head = $derived(cards.length > 1 ? t('{n} 个建议任务', { n: cards.length })
    : single && single.kind === 'offer' && single.status === 'pending' ? t('单独开一个会话来做？') : t('新会话'));

  // >6 张只露前 5 张（官方）
  let more = $state(false);
  const shown = $derived(cards.length > 6 && !more ? cards.slice(0, 5) : cards);

  // —— 动作 ——
  let groupBusy = $state(false);
  async function startAll() {
    if (groupBusy || startableIds.length < 2) return;
    groupBusy = true;
    try { await startProposals(startableIds); } finally { groupBusy = false; }
  }
  const wtPick = $state({});   // 「选项」里改的 use_worktree（只这张卡、只这次开始）
  async function start(p) { await startProposals([p.id], { useWorktree: typeof wtPick[p.id] === 'boolean' ? wtPick[p.id] : undefined }); }
  async function stopChild(p) {
    if (!p.child || p.stopping) return;
    p.stopping = true;
    try { await api.stop(p.child); } catch {} finally { p.stopping = false; }
  }
  const working = (p) => !!(p.child && (collab.live[p.child] || sessionById(p.child)?.thinking));

  // 位置 · 一句话理由（官方 data-start-where + tldr；offer 是用户原话）
  function whereOf(p) {
    if (p.context === 'fork') return t('接着这段对话');
    if (p.useWorktree === true) return t('独立工作树');
    if (p.useWorktree === false) return t('当前目录');
    return '';
  }
  const subOf = (p) => [whereOf(p), p.kind === 'offer' ? p.asked : p.tldr].filter(Boolean).join(' · ');

  // —— 弹层：完整任务说明 / 选项 / 不再询问 ——（同一时刻只开一个；点外面、Esc、系统返回都关）
  let pop = $state(null);   // { kind:'brief'|'opts'|'mute', id }
  let root = $state(null);
  $effect(() => { if (pop) return pushBackLayer(() => { pop = null; }); });
  $effect(() => {
    if (!pop) return;
    const onDown = (e) => { if (!e.target.closest || !e.target.closest('.ssc-pop, .ssc-poptrig')) pop = null; };
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); pop = null; } };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey, true); };
  });
  const togglePop = (kind, id) => { pop = pop && pop.kind === kind && pop.id === id ? null : { kind, id }; };
  async function mute(p, choice) {
    pop = null;
    // 「Claude 发起新会话」那一项（设置注册表 group 'collab'）在设置的 Claude 分区：'claude' 是两套设置外壳共认的直达名
    //（桌面 SEC_ALIAS → ag-claude、手机 deepStack → ag-claude；由设置页那一路提供）
    // 分屏格里托宿主页开（openSettingsFromChat）；拖出去的独立窗口没有设置页，菜单里不给这一项
    if (choice === 'settings') { openSettingsFromChat('claude'); return; }
    await answerOffer(p, choice);
  }

  // —— offer 卡的快捷键（官方：卡在视口里、输入框没弹层时接管 esc / cmd+enter，出现 400ms 后才生效）——
  let visible = $state(false);
  $effect(() => {
    if (!root || !offerPending || IS_CSNAP || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver((es) => { visible = es.some((e) => e.isIntersecting); }, { threshold: 0.4 });
    io.observe(root);
    return () => { io.disconnect(); visible = false; };
  });
  $effect(() => {
    const p = offerPending;
    if (!p || !visible || IS_CSNAP) return;
    let armed = false;
    const arm = setTimeout(() => { armed = true; }, 400);
    const onKey = (e) => {
      // 别的处理器已认领这次按键、或同会话还挂着审批卡 / 计划卡：键归它们（它们也挂在 window 捕获阶段，
      // 只靠 stopPropagation 拦不住同层监听——不让路的话一次 Esc 会同时拒掉工具、又把 offer 答成「在这里做」）
      if (!armed || e.isComposing || pop || p.busy || e.defaultPrevented || approvalWaiting(session.id)) return;
      const esc = e.key === 'Escape' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey;
      const go = e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey;
      if (!esc && !go) return;
      // 输入框里有字（用户正要发别的）、或焦点在菜单 / 对话框 / 列表里：让给它们
      const a = document.activeElement;
      if (a && (a.tagName === 'TEXTAREA' || a.tagName === 'INPUT' || a.isContentEditable) && String(a.value ?? a.textContent ?? '').trim()) return;
      if (a && a.closest && a.closest('[role="menu"],[role="dialog"],[role="listbox"],[aria-modal="true"]')) return;
      e.preventDefault(); e.stopPropagation();
      answerOffer(p, esc ? 'here' : 'new_session');
    };
    window.addEventListener('keydown', onKey, true);
    return () => { clearTimeout(arm); window.removeEventListener('keydown', onKey, true); };
  });
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '');
</script>

{#each rowsBefore as e (e.tool.id || e.tool.index)}
  <ToolRow tool={rowTool(e)} {live} />
{/each}

{#if cards.length}
  <div class="ssc" role="group" aria-label={head} bind:this={root}>
    <div class="ssc-card">
      <div class="ssc-head">
        <span class="ssc-h">{head}</span>
        {#if cards.length > 1 && startedN}<span class="ssc-hn">{t('已开始 {n} 个', { n: startedN })}</span>{/if}
        {#if startableIds.length >= 2 && !IS_CSNAP}
          <button type="button" class="ghost sm push" disabled={groupBusy} onclick={startAll}>{t('全部开始')}</button>
        {/if}
      </div>
      {#each shown as p (p.id)}
        <div class="ssc-row" data-state={p.status}>
          {#if p.status === 'pending' || (p.status === 'start_failed' && p.kind === 'own')}
            <!-- 待选 / 待开：可交互 -->
            <div class="ssc-top">
              <div class="ssc-text">
                {#if p.kind === 'own' && p.prompt}
                  <button type="button" class="ssc-title tbtn ssc-poptrig" aria-expanded={pop?.kind === 'brief' && pop.id === p.id} onclick={() => togglePop('brief', p.id)}>{p.title || t('未命名任务')}</button>
                {:else}
                  <span class="ssc-title">{p.title || t('未命名任务')}</span>
                {/if}
                {#if subOf(p)}<span class="ssc-sub">{subOf(p)}</span>{/if}
                {#if p.status === 'start_failed'}<span class="ssc-err" title={tr(p.reason || '')}>{t('没能开始')}{#if p.reason}：{tr(p.reason)}{/if}</span>
                {:else if p.error}<span class="ssc-err">{tr(p.error)}</span>{/if}
              </div>
              {#if p.kind === 'own' && !IS_CSNAP}
                <button type="button" class="ssc-x" aria-label={t('忽略建议「{title}」', { title: p.title })} title={t('忽略')} disabled={p.busy} onclick={() => dismissProposal(p.id)}>
                  <span class="gi" aria-hidden="true">{glyph('X')}</span>
                </button>
              {/if}
            </div>
            {#if pop && pop.kind === 'brief' && pop.id === p.id}
              <div class="ssc-pop brief sel-text" role="dialog" aria-label={p.title}>{p.prompt}</div>
            {/if}
            {#if !IS_CSNAP}
              <div class="ssc-btns">
                {#if p.kind === 'offer'}
                  <div class="lead">
                    <button type="button" class="ghost sm ssc-poptrig" aria-haspopup="menu" aria-expanded={pop?.kind === 'mute' && pop.id === p.id} disabled={p.busy} onclick={() => togglePop('mute', p.id)}>
                      {t('不再询问')}<span class="gi car" aria-hidden="true">{glyph('CaretDown')}</span>
                    </button>
                    {#if pop && pop.kind === 'mute' && pop.id === p.id}
                      <div class="ssc-pop menu" role="menu">
                        <button type="button" role="menuitem" onclick={() => mute(p, 'always_new')}>{t('总是新建会话')}</button>
                        <button type="button" role="menuitem" onclick={() => mute(p, 'always_here')}>{t('总是在这里做')}</button>
                        {#if canOpenSettingsFromChat}
                          <div class="sep" role="separator"></div>
                          <button type="button" role="menuitem" onclick={() => mute(p, 'settings')}>{t('设置')}</button>
                        {/if}
                      </div>
                    {/if}
                  </div>
                  <button type="button" class="ghost" disabled={p.busy} onclick={() => answerOffer(p, 'here')}>{t('在这里做')}<kbd>esc</kbd></button>
                  <button type="button" class="primary" disabled={p.busy} onclick={() => answerOffer(p, 'new_session')}>{t('新会话')}<kbd>{isMac ? '⌘' : 'ctrl'}↵</kbd></button>
                {:else}
                  <div class="lead">
                    {#if p.context !== 'fork'}
                      <button type="button" class="ghost sm ssc-poptrig" aria-expanded={pop?.kind === 'opts' && pop.id === p.id} onclick={() => togglePop('opts', p.id)}>{t('选项')}</button>
                      {#if pop && pop.kind === 'opts' && pop.id === p.id}
                        <div class="ssc-pop opts" role="dialog" aria-label={t('选项')}>
                          <label class="opt">
                            <input type="checkbox" checked={typeof wtPick[p.id] === 'boolean' ? wtPick[p.id] : p.useWorktree === true} onchange={(ev) => (wtPick[p.id] = ev.currentTarget.checked)} />
                            <span>{t('在独立工作树里做')}</span>
                          </label>
                        </div>
                      {/if}
                    {/if}
                  </div>
                  <button type="button" class="primary" disabled={p.busy || groupBusy} onclick={() => start(p)}>{p.status === 'start_failed' ? t('重试') : t('开始')}</button>
                {/if}
              </div>
            {/if}
          {:else if p.status === 'accepted' || p.status === 'starting'}
            <!-- 进行中：offer 选了新会话、等 Claude 补任务说明 / 正在派生 -->
            <div class="ssc-line">
              <span class="ssc-title cl-shine">{p.title || t('未命名任务')}</span>
              <span class="ssc-st">{p.status === 'accepted' ? t('正在写任务说明…') : t('正在开始…')}</span>
            </div>
          {:else if p.status === 'started'}
            <!-- 已开始：子会话一行，点开它；还在干活时可停止 -->
            {@const busy = working(p)}
            <div class="ssc-line">
              <button type="button" class="ssc-child" disabled={IS_CSNAP || !p.child} title={t('打开这个会话')} onclick={() => openSession(p.child)}>
                <span class="dot" class:on={busy} aria-hidden="true"></span>
                <span class="ssc-title">{sessionTitle(p.child, p.title) || p.title || t('未命名任务')}</span>
              </button>
              <span class="ssc-st">{busy ? t('正在干活') : t('已开始')}</span>
              {#if busy && !IS_CSNAP}
                <button type="button" class="ghost sm" disabled={p.stopping} onclick={() => stopChild(p)}>{t('停止')}</button>
              {/if}
            </div>
          {:else}
            <!-- 结束：已忽略 / 已过期 / 没能开始（offer 的） -->
            <div class="ssc-line ended">
              <span class="ssc-title">{p.title || t('未命名任务')}</span>
              {#if p.status === 'start_failed'}<span class="ssc-st err" title={tr(p.reason || '')}>{t('没能开始')}</span>
              {:else if p.status === 'expired'}<span class="ssc-st">{t('已过期')}</span>
              {:else}<span class="ssc-st">{t('已忽略')}</span>{/if}
            </div>
          {/if}
        </div>
      {/each}
      {#if cards.length > 6}
        <button type="button" class="ssc-more" onclick={() => (more = !more)}>
          {more ? t('收起') : t('再显示 {n} 个', { n: cards.length - 5 })}<span class="gi car" aria-hidden="true">{glyph(more ? 'CaretDown' : 'CaretRight')}</span>
        </button>
      {/if}
    </div>
  </div>
{/if}

{#each rowsAfter as e (e.tool.id || e.tool.index)}
  <ToolRow tool={rowTool(e)} {live} />
{/each}

<style>
  /* 官方 MJe：epitaxy-card-outline / max-w 480 / rounded-card / overflow-clip；外包 my 6px */
  .ssc { margin: 6px 0; width: 100%; min-width: 0; }
  /* 不裁切（官方 overflow-clip）：「不再询问」/「选项」弹层要能伸出卡外——圆角改由组头自己带 */
  .ssc-card { position: relative; display: flex; flex-direction: column; width: 100%; max-width: 480px; box-sizing: border-box;
    border-radius: 12px; box-shadow: 0 0 0 1px var(--divider); background: var(--card); color: var(--text); font-size: 14px; line-height: 20px;
    animation: sscIn .24s cubic-bezier(.22,1,.36,1); }
  @keyframes sscIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  @media (prefers-reduced-motion: reduce) { .ssc-card { animation: none; } }
  /* 组头（官方 mQ：浅底条 gap-md px-lg py-md） */
  .ssc-head { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 22px; padding: 8px 12px; background: var(--hover); border-radius: 12px 12px 0 0; }
  .ssc-h { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-weight: 500; color: var(--text); }
  .ssc-hn { flex: none; font-size: 13px; color: var(--muted); }
  .push { margin-left: auto; }
  /* 行（官方 hQ：border-t、px-lg py-md、首行无上边） */
  .ssc-row { position: relative; display: flex; flex-direction: column; gap: 8px; min-width: 0; padding: 10px 12px; border-top: 1px solid var(--divider); }
  .ssc-head + .ssc-row { border-top: 0; }
  .ssc-top { display: flex; align-items: flex-start; gap: 8px; min-width: 0; }
  .ssc-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .ssc-title { min-width: 0; font-weight: 500; color: var(--text); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .tbtn { font: inherit; font-weight: 500; text-align: left; background: none; border: 0; padding: 0; color: var(--text); cursor: pointer; }
  @media (hover: hover) { .tbtn:hover { text-decoration: underline; text-underline-offset: 3px; text-decoration-color: color-mix(in srgb, currentColor 40%, transparent); } }
  .ssc-sub { color: var(--serif); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .ssc-err { color: var(--crit); font-size: 13px; overflow-wrap: anywhere; }
  .ssc-x { flex: none; width: 24px; height: 24px; margin: -2px -4px 0 0; display: inline-flex; align-items: center; justify-content: center; border-radius: 6px; color: var(--muted); }
  @media (hover: hover) { .ssc-x:hover:not(:disabled) { color: var(--text); background: var(--hover-strong); } }
  .ssc-x:disabled { opacity: .5; }
  /* 按钮条（官方 BJe）：左 leading（选项 / 不再询问），右 ghost + primary */
  .ssc-btns { display: flex; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 6px; min-width: 0; }
  .lead { position: relative; margin-right: auto; display: flex; align-items: center; min-width: 0; }
  .ghost, .primary { display: inline-flex; align-items: center; gap: 6px; min-height: 30px; padding: 5px 12px; border-radius: 8px; font-size: 14px; line-height: 20px;
    white-space: nowrap; transition: background-color 60ms ease-out, transform 60ms ease-out; }
  .ghost { color: var(--text); }
  .ghost.sm { min-height: 26px; padding: 3px 8px; font-size: 13px; color: var(--serif); }
  @media (hover: hover) { .ghost:hover:not(:disabled) { background: var(--hover); color: var(--text); } }
  .primary { color: var(--bg); background: var(--text); font-weight: 500; }
  .ghost:active:not(:disabled), .primary:active:not(:disabled) { transform: scale(.985); }
  .ghost:disabled, .primary:disabled { opacity: .5; cursor: default; }
  kbd { font: inherit; font-size: 11.5px; line-height: 16px; padding: 0 4px; border-radius: 4px; opacity: .6; box-shadow: 0 0 0 1px currentColor; }
  @media (pointer: coarse) { kbd { display: none; } }
  .car { font-size: 12px; width: 12px; height: 12px; }
  /* 进行中 / 已开始 / 结束：一行 */
  .ssc-line { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .ssc-line .ssc-title { flex: 0 1 auto; -webkit-line-clamp: 1; }
  .ssc-line.ended .ssc-title { color: var(--muted); font-weight: 400; }
  .ssc-st { flex: none; margin-left: auto; font-size: 13px; color: var(--muted); }
  .ssc-st.err { color: var(--crit); }
  .ssc-child { flex: 0 1 auto; min-width: 0; display: flex; align-items: center; gap: 8px; font: inherit; text-align: left; background: none; border: 0; padding: 0; color: inherit; cursor: pointer; }
  .ssc-child:disabled { cursor: default; }
  @media (hover: hover) { .ssc-child:not(:disabled):hover .ssc-title { text-decoration: underline; text-underline-offset: 3px; } }
  .ssc-line .ssc-st + .ghost { margin-left: 0; }
  .dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--muted); opacity: .6; }
  .dot.on { background: var(--text); opacity: 1; animation: sscPulse 1.6s ease-in-out infinite; }
  @keyframes sscPulse { 50% { opacity: .35; } }
  @media (prefers-reduced-motion: reduce) { .dot.on { animation: none; } }
  .ssc-more { display: flex; align-items: center; gap: 4px; padding: 8px 12px; border-top: 1px solid var(--divider); font-size: 13px; color: var(--serif); text-align: left; }
  @media (hover: hover) { .ssc-more:hover { color: var(--text); } }
  /* 弹层（官方 popover：完整任务说明 w-120 / 选项 w-114 / 不再询问菜单） */
  .ssc-pop { z-index: 6; box-sizing: border-box; background: var(--card); border: 1px solid var(--divider); border-radius: 12px;
    box-shadow: 0 8px 28px rgba(0,0,0,.28); animation: popIn .16s cubic-bezier(.22,1,.36,1); }
  @keyframes popIn { from { opacity: 0; transform: translateY(-3px); } to { opacity: 1; transform: none; } }
  .ssc-pop.brief { max-height: 280px; overflow: auto; padding: 10px 12px; font-size: 13.5px; line-height: 19px; color: var(--serif); white-space: pre-wrap; overflow-wrap: anywhere; }
  .ssc-pop.menu, .ssc-pop.opts { position: absolute; left: 0; top: calc(100% + 4px); min-width: 180px; padding: 4px; display: flex; flex-direction: column; }
  .ssc-pop.menu button { text-align: left; padding: 6px 10px; border-radius: 8px; font-size: 14px; color: var(--text); white-space: nowrap; }
  @media (hover: hover) { .ssc-pop.menu button:hover { background: var(--hover); } }
  .ssc-pop .sep { height: 1px; margin: 4px 6px; background: var(--divider); }
  .opt { display: flex; align-items: center; gap: 8px; padding: 6px 8px; font-size: 14px; color: var(--text); cursor: pointer; white-space: nowrap; }
  .gi { font-family: var(--icons); font-style: normal; font-feature-settings: "liga" 0; font-variation-settings: "opsz" 16, "wght" 533;
    font-size: 16px; line-height: 1; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; }
  .gi.car { font-size: 12px; width: 12px; height: 12px; }
</style>
