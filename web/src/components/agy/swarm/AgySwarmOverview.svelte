<script>
  // Swarm 总览视图（对齐官方 swarm_pane Overview 信息结构，原生 --ag-* 克制排版）：
  // 告警条（停滞 / 需你回复 / 异常）→ 目标卡 → 正在进行 → 进度环与已完成折叠区 →
  // 工作分组（Threads）→ 截图进度时间线（带当前对比滑块与全屏预览）。
  import { agyArtifactUrl, openPreview } from '../../../lib/preview.svelte.js';
  import { t } from '../../../lib/i18n.js';

  const {
    vm,
    sessionId = '',
    onOpenMember = () => {},
    onJumpSeq = () => {},
  } = $props();

  let doneOpen = $state(false);
  let threadOpen = $state({});
  let reelIndex = $state(-1);
  let compareMode = $state(false);
  let compareSplit = $state(50);

  const frames = $derived(Array.isArray(vm?.frames) ? vm.frames : []);
  const activeFrameIdx = $derived.by(() => {
    if (!frames.length) return 0;
    if (reelIndex < 0 || reelIndex >= frames.length) return frames.length - 1;
    return reelIndex;
  });
  const activeFrame = $derived(frames[activeFrameIdx] || null);
  const latestFrame = $derived(frames.length ? frames[frames.length - 1] : null);

  function frameUrl(filePath) {
    return filePath ? agyArtifactUrl(sessionId, filePath) : '';
  }

  function isThreadExpanded(th) {
    if (th.id in threadOpen) return threadOpen[th.id];
    return th.state === 'blocked' || th.state === 'running';
  }
  function toggleThread(th) {
    threadOpen[th.id] = !isThreadExpanded(th);
  }

  function openMemberByName(name) {
    const m = vm?.memberByName?.get(name);
    if (m) onOpenMember(m);
  }

  function openFrameFull(frame) {
    if (!frame?.path) return;
    openPreview({
      origin: 'agy',
      id: sessionId,
      path: frame.path,
      name: frame.caption || frame.path.split(/[\\/]/).pop() || t('进度截图'),
      kind: 'image',
    });
  }

  function fmtFrameTime(ts) {
    if (!ts) return '';
    try {
      return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
    } catch {
      return '';
    }
  }

  function threadStateLabel(st) {
    switch (st) {
      case 'blocked': return t('受阻');
      case 'running': return t('进行中');
      case 'done': return t('已完成');
      default: return t('未开始');
    }
  }

  function ringSegs(totals) {
    const sum = (totals?.done || 0) + (totals?.running || 0) + (totals?.blocked || 0) + (totals?.queued || 0);
    const total = Math.max(1, sum);
    const C = 43.98;
    let off = 0;
    const segs = [];
    for (const k of ['done', 'running', 'blocked']) {
      const n = totals?.[k] || 0;
      if (!n) continue;
      const len = (n / total) * C;
      segs.push({ key: k, dash: `${len.toFixed(2)} ${C.toFixed(2)}`, off: (-off).toFixed(2) });
      off += len;
    }
    return { sum, allDone: sum > 0 && totals.done === sum, segs };
  }

  const ring = $derived(ringSegs(vm?.totals));
</script>

<div class="sw-ov">
  {#if vm.needsUser && vm.coordAsk}
    <section class="sw-alert warn" role="status">
      <span class="msr4 al-ic" aria-hidden="true">help</span>
      <div class="al-body">
        <div class="al-title">{t('协调者正在等待你的回复')}</div>
        <p class="al-text">{vm.coordAsk}</p>
      </div>
    </section>
  {/if}

  {#if vm.stall}
    <section class="sw-alert warn" role="status">
      <span class="msr4 al-ic" aria-hidden="true">warning</span>
      <div class="al-body">
        <div class="al-head">
          <span class="al-title">{t('协作已停滞 · 暂无成员在工作')}</span>
          <button type="button" class="al-link num" onclick={() => onJumpSeq(vm.stall.seq)}>
            @{vm.stall.agent} #{vm.stall.seq}
          </button>
        </div>
        <p class="al-text">{vm.stall.text}</p>
      </div>
    </section>
  {/if}

  {#if vm.systemAttention.length > 0}
    <section class="sw-alerts-list" aria-label={t('系统告警')}>
      {#each vm.systemAttention as item (item.id)}
        <div class="sw-alert err">
          <span class="msr4 al-ic" aria-hidden="true">error</span>
          <div class="al-body">
            <div class="al-head">
              <span class="al-title">
                {#if item.kind === 'quota'}
                  {t('@{name} 额度已耗尽', { name: item.member })}
                {:else if item.kind === 'stuck'}
                  {t('@{name} 长时间无进展', { name: item.member })}
                {:else}
                  {t('@{name} 执行出错', { name: item.member })}
                {/if}
              </span>
              {#if item.conversationId && item.member !== vm.leadName}
                <button type="button" class="al-link" onclick={() => openMemberByName(item.member)}>
                  {t('查看记录')}
                </button>
              {/if}
            </div>
            {#if item.detail}
              <p class="al-text">{item.detail}</p>
            {/if}
          </div>
        </div>
      {/each}
    </section>
  {/if}

  {#if vm.goal && (vm.goal.title || vm.goal.line)}
    <section class="sw-card sw-goal">
      <div class="sw-sec-kicker">{t('协作目标')}</div>
      {#if vm.goal.title}<h4 class="sw-goal-t">{vm.goal.title}</h4>{/if}
      {#if vm.goal.line}<p class="sw-goal-l">{vm.goal.line}</p>{/if}
    </section>
  {/if}

  {#if vm.runningTasks.length > 0 && !vm.finished}
    <section class="sw-card">
      <div class="sw-card-h">
        <span class="sw-live-dot" aria-hidden="true"></span>
        <h4>{t('正在进行')}</h4>
        <span class="sw-cnt num">{vm.runningTasks.length}</span>
      </div>
      <ul class="sw-run-list">
        {#each vm.runningTasks as item (item.id)}
          <li class="sw-run-row {item.state}">
            <span class="sw-ti {item.state}" aria-hidden="true"></span>
            <div class="sw-run-main">
              <div class="sw-run-top">
                <span class="sw-run-title">{item.title}</span>
                <span class="sw-owners">
                  {#each (item.owners || []).slice(0, 2) as owner (owner)}
                    <button type="button" class="sw-owner-chip" onclick={() => openMemberByName(owner)}>
                      @{owner}
                    </button>
                  {/each}
                </span>
              </div>
              {#if item.waitingOn}
                <div class="sw-run-note warn">{t('等待 @{name} 回复', { name: item.waitingOn })}</div>
              {:else if item.note}
                <div class="sw-run-note trunc" title={item.note}>{item.note}</div>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if vm.totals.total > 0}
    <section class="sw-card sw-prog">
      <button type="button" class="sw-prog-head" aria-expanded={doneOpen} onclick={() => { doneOpen = !doneOpen; }}>
        {#if ring.allDone}
          <span class="sw-ring-done" aria-hidden="true"><span class="msr4">check</span></span>
        {:else}
          <svg class="sw-ring" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
            <circle cx="9" cy="9" r="7" fill="none" class="trk" stroke-width="2.2" />
            {#each ring.segs as seg (seg.key)}
              <circle
                cx="9"
                cy="9"
                r="7"
                fill="none"
                class="seg {seg.key}"
                stroke-width="2.2"
                stroke-dasharray={seg.dash}
                stroke-dashoffset={seg.off}
              />
            {/each}
          </svg>
        {/if}
        <span class="sw-prog-lbl num">
          {t('已完成 {done} / {total} 项任务', { done: vm.totals.done, total: vm.totals.total })}
        </span>
        <span class="sw-prog-chips num">
          {#if vm.totals.running > 0}
            <span class="sw-pchip live">{t('{n} 进行中', { n: vm.totals.running })}</span>
          {/if}
          {#if vm.totals.blocked > 0}
            <span class="sw-pchip warn">{t('{n} 受阻', { n: vm.totals.blocked })}</span>
          {/if}
        </span>
        <span class="msr sw-chev" class:closed={!doneOpen} aria-hidden="true">expand_more</span>
      </button>

      {#if doneOpen}
        <div class="sw-prog-body">
          {#if vm.doneTasks.length > 0}
            <ul class="sw-mini-list">
              {#each vm.doneTasks as item (item.id)}
                <li class="sw-mini-row">
                  <span class="msr4 ok" aria-hidden="true">check</span>
                  <div class="sw-mini-main">
                    <span class="sw-mini-title">{item.title}</span>
                    {#if item.note}<span class="sw-mini-sub trunc">{item.note}</span>{/if}
                  </div>
                  <span class="sw-owners">
                    {#each (item.owners || []).slice(0, 2) as owner (owner)}
                      <button type="button" class="sw-owner-chip" onclick={() => openMemberByName(owner)}>@{owner}</button>
                    {/each}
                  </span>
                </li>
              {/each}
            </ul>
          {:else}
            <p class="sw-muted">{t('暂无已完成的任务')}</p>
          {/if}

          {#if vm.queuedTasks.length > 0}
            <div class="sw-queued-sec">
              <div class="sw-sec-kicker">{t('待开始 · {n}', { n: vm.queuedTasks.length })}</div>
              <ul class="sw-mini-list">
                {#each vm.queuedTasks as item (item.id)}
                  <li class="sw-mini-row">
                    <span class="sw-ti queued" aria-hidden="true"></span>
                    <div class="sw-mini-main">
                      <span class="sw-mini-title">{item.title}</span>
                    </div>
                    <span class="sw-owners">
                      {#each (item.owners || []).slice(0, 2) as owner (owner)}
                        <button type="button" class="sw-owner-chip" onclick={() => openMemberByName(owner)}>@{owner}</button>
                      {/each}
                    </span>
                  </li>
                {/each}
              </ul>
            </div>
          {/if}
        </div>
      {/if}
    </section>
  {/if}

  {#if frames.length > 0 && activeFrame}
    <section class="sw-card sw-reel">
      <div class="sw-reel-head">
        <span class="sw-sec-kicker">{t('进度截图')}</span>
        {#if activeFrame.ts}<span class="sw-reel-when num">{fmtFrameTime(activeFrame.ts)}</span>{/if}
        <span class="sw-spacer"></span>
        {#if frames.length >= 2}
          <button
            type="button"
            class="sw-ghost-btn"
            class:on={compareMode}
            aria-pressed={compareMode}
            onclick={() => { compareMode = !compareMode; }}
          >
            {compareMode ? t('退出对比') : t('与当前对比')}
          </button>
        {/if}
        <button
          type="button"
          class="sw-ic-btn"
          title={t('查看大图')}
          aria-label={t('查看大图')}
          onclick={() => openFrameFull(activeFrame)}
        >
          <span class="msr">open_in_new</span>
        </button>
      </div>

      <div class="sw-reel-stage">
        {#if compareMode && latestFrame}
          <img class="sw-reel-base" src={frameUrl(latestFrame.path)} alt={latestFrame.caption || t('最新截图')} />
        {/if}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
        <img
          class="sw-reel-img"
          src={frameUrl(activeFrame.path)}
          alt={activeFrame.caption || t('进度截图')}
          style={compareMode ? `clip-path:inset(0 ${100 - compareSplit}% 0 0)` : ''}
          onclick={() => !compareMode && openFrameFull(activeFrame)}
        />
        {#if compareMode}
          <span class="sw-cmp-line" style={`left:${compareSplit}%`} aria-hidden="true"></span>
          <input
            type="range"
            class="sw-cmp-range"
            min="0"
            max="100"
            bind:value={compareSplit}
            aria-label={t('拖动对比前后画面')}
          />
        {/if}
        <span class="sw-reel-badge num">
          {activeFrameIdx === frames.length - 1 ? t('最新') : `${activeFrameIdx + 1} / ${frames.length}`}
        </span>
      </div>

      <div class="sw-reel-meta">
        {#if activeFrame.caption}<p class="sw-reel-cap">{activeFrame.caption}</p>{/if}
        <div class="sw-reel-sub num">
          {#if activeFrame.seq > 0}
            <button type="button" class="sw-seq-link" onclick={() => onJumpSeq(activeFrame.seq)}>#{activeFrame.seq}</button>
          {/if}
          {#if activeFrame.total > 0}
            <span>{t('当时已完成 {done}/{total}', { done: activeFrame.doneAt, total: activeFrame.total })}</span>
          {/if}
        </div>
      </div>

      {#if frames.length > 1}
        <div class="sw-reel-scrub">
          <input
            type="range"
            min="0"
            max={frames.length - 1}
            step="1"
            value={activeFrameIdx}
            aria-label={t('拖动切换进度截图')}
            oninput={(e) => { reelIndex = Number(e.currentTarget.value); }}
          />
        </div>
      {/if}
    </section>
  {/if}

  {#if vm.threads.length > 0}
    <section class="sw-threads-sec">
      <div class="sw-sec-kicker">{t('工作分组')}</div>
      <div class="sw-threads">
        {#each vm.threads as th (th.id)}
          {@const open = isThreadExpanded(th)}
          {@const groupTitle = th.isFallbackGroup ? (th.hasOtherThreads ? t('其它任务') : t('任务列表')) : th.title}
          <section class="sw-card sw-th">
            <button type="button" class="sw-th-head" aria-expanded={open} onclick={() => toggleThread(th)}>
              <span class="sw-ti {th.state}" aria-hidden="true"></span>
              <span class="sw-th-title trunc">{groupTitle}</span>
              <span class="sw-th-st {th.state}">{threadStateLabel(th.state)}</span>
              <span class="sw-th-cnt num">{th.counts.done}/{th.total}</span>
              <span class="msr sw-chev" class:closed={!open} aria-hidden="true">expand_more</span>
            </button>
            {#if th.goal}
              <p class="sw-th-goal">{th.goal}</p>
            {/if}
            {#if open}
              <ul class="sw-th-list">
                {#each th.items as item (item.id)}
                  <li class="sw-th-item">
                    <span class="sw-ti {item.state}" aria-hidden="true"></span>
                    <div class="sw-th-item-main">
                      <span class="sw-th-item-t">{item.title}</span>
                      {#if item.waitingOn}
                        <span class="sw-th-item-w">{t('等待 @{name}', { name: item.waitingOn })}</span>
                      {/if}
                    </div>
                    <span class="sw-owners">
                      {#each (item.owners || []).slice(0, 2) as owner (owner)}
                        <button type="button" class="sw-owner-chip" onclick={() => openMemberByName(owner)}>@{owner}</button>
                      {/each}
                    </span>
                  </li>
                {/each}
              </ul>
            {/if}
          </section>
        {/each}
      </div>
    </section>
  {/if}
</div>

<style>
  .sw-ov {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .sw-alerts-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sw-alert {
    display: grid;
    grid-template-columns: 18px minmax(0, 1fr);
    column-gap: 8px;
    align-items: start;
    padding: 9px 11px;
    border-radius: 10px;
    font-size: 12px;
    line-height: 17px;
  }
  .sw-alert.warn {
    background: var(--ag-warn-bg);
    color: var(--ag-on);
  }
  .sw-alert.warn .al-ic { color: var(--ag-warn); }
  .sw-alert.err {
    background: var(--ag-err-bg);
    color: var(--ag-on);
  }
  .sw-alert.err .al-ic { color: var(--ag-err); }
  .al-ic { font-size: 16px; margin-top: 1px; }
  .al-body { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .al-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .al-title { font-weight: 500; color: var(--ag-on); }
  .al-text { margin: 0; color: var(--ag-on-sub); word-break: break-word; }
  .al-link {
    flex: none;
    font-size: 11.5px;
    color: var(--ag-accent);
    padding: 1px 6px;
    border-radius: 5px;
    background: color-mix(in srgb, var(--ag-accent) 12%, transparent);
  }
  .al-link:hover { background: color-mix(in srgb, var(--ag-accent) 20%, transparent); }

  .sw-card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 10px 11px;
    border-radius: 11px;
    background: var(--ag-surface-1);
    border: 1px solid var(--ag-border);
  }
  .sw-sec-kicker {
    font-size: 11px;
    font-weight: 500;
    color: var(--ag-on-faint);
    letter-spacing: 0.01em;
  }
  .sw-goal-t {
    margin: 0;
    font-size: 13.5px;
    line-height: 19px;
    font-weight: 540;
    color: var(--ag-on);
  }
  .sw-goal-l {
    margin: -2px 0 0;
    font-size: 12px;
    line-height: 17px;
    color: var(--ag-on-dim);
  }

  .sw-card-h {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sw-card-h h4 {
    margin: 0;
    font-size: 12.5px;
    font-weight: 500;
    color: var(--ag-on);
  }
  .sw-cnt { font-size: 11.5px; color: var(--ag-on-faint); }
  .sw-live-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--ag-accent);
    animation: sw-pulse 1.5s ease-in-out infinite;
  }
  @keyframes sw-pulse { 50% { opacity: 0.35; } }

  .sw-run-list, .sw-mini-list, .sw-th-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .sw-run-row {
    display: grid;
    grid-template-columns: 12px minmax(0, 1fr);
    column-gap: 8px;
    align-items: start;
  }
  .sw-run-main { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .sw-run-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
  }
  .sw-run-title {
    font-size: 12.5px;
    line-height: 17px;
    font-weight: 500;
    color: var(--ag-on);
  }
  .sw-run-note {
    font-size: 11.5px;
    line-height: 16px;
    color: var(--ag-on-dim);
    font-family: var(--ag-mono);
  }
  .sw-run-note.warn {
    font-family: inherit;
    color: var(--ag-warn);
  }

  .sw-ti {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    margin-top: 5px;
    flex: none;
    background: var(--ag-on-faint);
  }
  .sw-ti.running { background: var(--ag-accent); animation: sw-pulse 1.5s ease-in-out infinite; }
  .sw-ti.blocked { background: var(--ag-warn); }
  .sw-ti.done { background: var(--ag-ok); }
  .sw-ti.queued { background: transparent; border: 1.5px solid var(--ag-border-strong); box-sizing: border-box; }

  .sw-owners {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    flex: none;
  }
  .sw-owner-chip {
    font-size: 11px;
    line-height: 16px;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--ag-surface-2);
    color: var(--ag-on-sub);
    font-family: var(--ag-mono);
  }
  .sw-owner-chip:hover {
    background: var(--ag-hover);
    color: var(--ag-on);
  }

  /* 进度卡 */
  .sw-prog { padding: 0; gap: 0; overflow: hidden; }
  .sw-prog-head {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 9px 11px;
    text-align: left;
  }
  .sw-prog-head:hover { background: var(--ag-hover); }
  .sw-ring { flex: none; transform: rotate(-90deg); }
  .sw-ring .trk { stroke: var(--ag-border-strong); }
  .sw-ring .seg.done { stroke: var(--ag-ok); }
  .sw-ring .seg.running { stroke: var(--ag-accent); }
  .sw-ring .seg.blocked { stroke: var(--ag-warn); }
  .sw-ring-done {
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--ag-ok-bg);
    color: var(--ag-ok);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .sw-ring-done .msr4 { font-size: 14px; }
  .sw-prog-lbl { font-size: 12.5px; font-weight: 500; color: var(--ag-on); }
  .sw-prog-chips {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 11px;
  }
  .sw-pchip.live { color: var(--ag-accent); }
  .sw-pchip.warn { color: var(--ag-warn); }
  .sw-chev {
    flex: none;
    font-size: 16px;
    color: var(--ag-on-faint);
    transition: transform 0.16s ease;
  }
  .sw-chev.closed { transform: rotate(-90deg); }
  .sw-prog-body {
    padding: 8px 11px 10px;
    border-top: 1px solid var(--ag-border);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .sw-mini-row {
    display: flex;
    align-items: flex-start;
    gap: 7px;
  }
  .sw-mini-row .msr4.ok { font-size: 14px; color: var(--ag-ok); margin-top: 1px; }
  .sw-mini-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .sw-mini-title { font-size: 12px; color: var(--ag-on-sub); line-height: 16px; }
  .sw-mini-sub { font-size: 11px; color: var(--ag-on-faint); line-height: 15px; }
  .sw-queued-sec {
    padding-top: 8px;
    border-top: 1px solid var(--ag-border);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .sw-muted { margin: 0; font-size: 12px; color: var(--ag-on-faint); }

  /* 截图时间线 */
  .sw-reel-head {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sw-reel-when { font-size: 11px; color: var(--ag-on-faint); }
  .sw-spacer { flex: 1; }
  .sw-ghost-btn {
    height: 24px;
    padding: 0 8px;
    border-radius: 6px;
    font-size: 11.5px;
    color: var(--ag-on-sub);
    border: 1px solid var(--ag-border-strong);
  }
  .sw-ghost-btn:hover, .sw-ghost-btn.on {
    background: var(--ag-surface-2);
    color: var(--ag-on);
  }
  .sw-ic-btn {
    width: 24px;
    height: 24px;
    border-radius: 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--ag-on-dim);
  }
  .sw-ic-btn:hover { background: var(--ag-hover); color: var(--ag-on); }
  .sw-ic-btn .msr { font-size: 16px; }

  .sw-reel-stage {
    position: relative;
    border-radius: 8px;
    overflow: hidden;
    background: var(--ag-bg);
    border: 1px solid var(--ag-border);
    aspect-ratio: 16 / 10;
  }
  .sw-reel-base, .sw-reel-img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: contain;
    display: block;
  }
  .sw-reel-img { cursor: zoom-in; }
  .sw-cmp-line {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 1.5px;
    background: var(--ag-on);
    pointer-events: none;
    z-index: 2;
  }
  .sw-cmp-range {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    cursor: ew-resize;
    z-index: 3;
    margin: 0;
  }
  .sw-reel-badge {
    position: absolute;
    right: 6px;
    bottom: 6px;
    padding: 2px 7px;
    border-radius: 999px;
    font-size: 10.5px;
    background: rgba(19, 19, 19, 0.78);
    color: #f5f5f5;
    z-index: 4;
  }
  .sw-reel-meta { display: flex; flex-direction: column; gap: 2px; }
  .sw-reel-cap { margin: 0; font-size: 12px; color: var(--ag-on); line-height: 17px; }
  .sw-reel-sub { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--ag-on-dim); }
  .sw-seq-link { color: var(--ag-accent); font-family: var(--ag-mono); }
  .sw-seq-link:hover { text-decoration: underline; }
  .sw-reel-scrub input { width: 100%; accent-color: var(--ag-accent); margin: 0; }

  /* 工作分组 */
  .sw-threads-sec { display: flex; flex-direction: column; gap: 7px; }
  .sw-threads { display: flex; flex-direction: column; gap: 8px; }
  .sw-th { padding: 0; gap: 0; overflow: hidden; }
  .sw-th-head {
    display: flex;
    align-items: center;
    gap: 7px;
    width: 100%;
    padding: 9px 11px;
    text-align: left;
  }
  .sw-th-head:hover { background: var(--ag-hover); }
  .sw-th-head .sw-ti { margin-top: 0; }
  .sw-th-title { font-size: 12.5px; font-weight: 500; color: var(--ag-on); flex: 1; }
  .sw-th-st { font-size: 11px; color: var(--ag-on-dim); flex: none; }
  .sw-th-st.running { color: var(--ag-accent); }
  .sw-th-st.blocked { color: var(--ag-warn); }
  .sw-th-st.done { color: var(--ag-ok); }
  .sw-th-cnt { font-size: 11px; color: var(--ag-on-faint); flex: none; }
  .sw-th-goal {
    margin: -2px 11px 9px;
    font-size: 11.5px;
    line-height: 16px;
    color: var(--ag-on-dim);
  }
  .sw-th-list {
    padding: 7px 11px 10px;
    border-top: 1px solid var(--ag-border);
  }
  .sw-th-item {
    display: flex;
    align-items: flex-start;
    gap: 7px;
  }
  .sw-th-item-main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .sw-th-item-t { font-size: 12px; color: var(--ag-on-sub); line-height: 16px; }
  .sw-th-item-w { font-size: 11px; color: var(--ag-warn); }

  .trunc { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .num { font-variant-numeric: tabular-nums; }
</style>
