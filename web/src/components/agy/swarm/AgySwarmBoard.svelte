<script>
  // Swarm 共享消息板视图：
  // 支持关键词搜索、折叠筛选（发帖人 / 接收人 / 按成员隐藏）、多频道标签条、频道控制行、
  // @mention / @#channel / #seq 引用点击跳转高亮、长帖折叠与贴图内联预览。
  import { tick, untrack } from 'svelte';
  import { agyArtifactUrl, openPreview } from '../../../lib/preview.svelte.js';
  import {
    collapseRecipientGroups,
    filterSwarmMessages,
    renderSwarmPostHtml,
  } from '../../../lib/agy/swarm-logic.js';
  import { t } from '../../../lib/i18n.js';

  const {
    snap,
    sessionId = '',
    jumpSeq = 0,
    jumpToken = 0,
    onOpenMember = () => {},
  } = $props();

  let search = $state('');
  let filtersOpen = $state(false);
  let fromFilter = $state('');
  let toFilter = $state('');
  let channelFilter = $state('');
  let hiddenAgents = $state({});
  let expandedSeqs = $state({});
  let targetSeq = $state(0);
  let feedEl = $state(null);

  const members = $derived(Array.isArray(snap?.members) ? snap.members : []);
  const messages = $derived(Array.isArray(snap?.messages) ? snap.messages : []);
  const channels = $derived(Array.isArray(snap?.channels) ? snap.channels : []);
  const hasChannels = $derived(channels.length > 0);

  const hiddenSet = $derived(new Set(Object.keys(hiddenAgents).filter((k) => hiddenAgents[k])));
  const hasActiveFilters = $derived(Boolean(search.trim() || fromFilter || toFilter || channelFilter || hiddenSet.size > 0));
  const hasInnerFilters = $derived(Boolean(fromFilter || toFilter || hiddenSet.size > 0));

  const visible = $derived(filterSwarmMessages(messages, {
    q: search,
    channel: channelFilter,
    from: fromFilter,
    to: toFilter,
    hiddenAgents: hiddenSet,
  }));

  const posters = $derived.by(() => {
    const names = new Set(members.map((m) => m.name));
    for (const m of messages) if (m?.agent) names.add(m.agent);
    return [...names];
  });

  const channelCounts = $derived.by(() => {
    const map = new Map();
    for (const m of messages) {
      const ch = m.channel || 'main';
      map.set(ch, (map.get(ch) || 0) + 1);
    }
    return map;
  });

  function clearAllFilters() {
    search = '';
    fromFilter = '';
    toFilter = '';
    channelFilter = '';
    hiddenAgents = {};
  }

  function toggleHiddenAgent(name) {
    hiddenAgents = { ...hiddenAgents, [name]: !hiddenAgents[name] };
  }

  function toggleExpand(seq) {
    expandedSeqs = { ...expandedSeqs, [seq]: !expandedSeqs[seq] };
  }

  async function scrollToSeq(seq) {
    if (!seq) return;
    if (!visible.some((m) => m.seq === seq) && hasActiveFilters) {
      clearAllFilters();
    }
    await tick();
    const el = feedEl?.querySelector?.(`[data-sw-seq-row="${seq}"]`);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      targetSeq = seq;
      setTimeout(() => { if (targetSeq === seq) targetSeq = 0; }, 1700);
    }
  }

  $effect(() => {
    const seq = jumpSeq;
    const tok = jumpToken;
    if (!seq || !tok) return;
    untrack(() => scrollToSeq(seq));
  });

  function fmtTime(ts) {
    if (!ts) return '';
    try {
      return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(ts));
    } catch {
      return '';
    }
  }

  function recipientsOf(m) {
    const direct = collapseRecipientGroups((m.mentions || []).filter((n) => n !== m.agent), members);
    const out = direct.map((n) => `@${n}`);
    for (const c of m.channelMentions || []) out.push(`@#${c}`);
    if (m.all) out.push('@all');
    return out;
  }

  function handleBodyClick(ev) {
    const seqBtn = ev.target?.closest?.('[data-sw-seq]');
    if (seqBtn) {
      const seq = Number(seqBtn.getAttribute('data-sw-seq'));
      if (seq > 0) scrollToSeq(seq);
      return;
    }
    const chBtn = ev.target?.closest?.('[data-sw-channel]');
    if (chBtn) {
      channelFilter = chBtn.getAttribute('data-sw-channel') || '';
      return;
    }
    const memBtn = ev.target?.closest?.('[data-sw-member]');
    if (memBtn) {
      const name = memBtn.getAttribute('data-sw-member') || '';
      const hit = members.find((m) => m.name === name);
      if (hit) onOpenMember(hit);
    }
  }

  function openShot(shot) {
    if (!shot?.path) return;
    openPreview({
      origin: 'agy',
      id: sessionId,
      path: shot.path,
      name: shot.caption || shot.path.split(/[\\/]/).pop() || t('进度截图'),
      kind: 'image',
    });
  }
</script>

<div class="sw-board">
  <div class="sw-btools">
    <div class="sw-search-row">
      <label class="sw-search-box">
        <span class="msr" aria-hidden="true">search</span>
        <input
          type="search"
          bind:value={search}
          placeholder={t('搜索消息板…')}
          aria-label={t('搜索消息板')}
          autocomplete="off"
        />
      </label>
      <button
        type="button"
        class="sw-flt-btn"
        class:on={filtersOpen || hasInnerFilters}
        aria-expanded={filtersOpen}
        aria-label={t('筛选条件')}
        title={t('筛选条件')}
        onclick={() => { filtersOpen = !filtersOpen; }}
      >
        <span class="msr">tune</span>
        {#if hasInnerFilters}<i class="sw-flt-dot" aria-hidden="true"></i>{/if}
      </button>
    </div>

    {#if hasChannels}
      <div class="sw-chans" role="tablist" aria-label={t('频道')}>
        <button
          type="button"
          role="tab"
          class="sw-ch-tab"
          class:on={channelFilter === ''}
          aria-selected={channelFilter === ''}
          onclick={() => { channelFilter = ''; }}
        >
          {t('全部')}
        </button>
        <button
          type="button"
          role="tab"
          class="sw-ch-tab"
          class:on={channelFilter === 'main'}
          aria-selected={channelFilter === 'main'}
          onclick={() => { channelFilter = 'main'; }}
        >
          #main
          {#if channelCounts.get('main')}<span class="num">{channelCounts.get('main')}</span>{/if}
        </button>
        {#each channels as ch (ch.name)}
          <button
            type="button"
            role="tab"
            class="sw-ch-tab"
            class:on={channelFilter === ch.name}
            class:archived={ch.archived}
            aria-selected={channelFilter === ch.name}
            title={ch.topic || ch.name}
            onclick={() => { channelFilter = ch.name; }}
          >
            #{ch.name}
            {#if channelCounts.get(ch.name)}<span class="num">{channelCounts.get(ch.name)}</span>{/if}
          </button>
        {/each}
      </div>
    {/if}

    {#if filtersOpen}
      <div class="sw-filters">
        <div class="sw-sel-row">
          <select bind:value={fromFilter} aria-label={t('按发帖人筛选')}>
            <option value="">{t('全部发帖人')}</option>
            {#each posters as name (name)}
              <option value={name}>@{name}</option>
            {/each}
          </select>
          <select bind:value={toFilter} aria-label={t('按接收对象筛选')}>
            <option value="">{t('全部接收对象')}</option>
            <option value="@all">@all</option>
            <option value="@none">{t('无 @提及')}</option>
            {#each members as m (m.name)}
              <option value={m.name}>→ @{m.name}</option>
            {/each}
          </select>
          {#if hasActiveFilters}
            <button type="button" class="sw-clr-btn" onclick={clearAllFilters}>{t('清空')}</button>
          {/if}
        </div>

        {#if members.length > 0}
          <div class="sw-mchips" role="group" aria-label={t('显示或隐藏成员消息')}>
            {#each members as m (m.name)}
              {@const hid = Boolean(hiddenAgents[m.name])}
              <button
                type="button"
                class="sw-mchip"
                class:dim={hid}
                aria-pressed={!hid}
                onclick={() => toggleHiddenAgent(m.name)}
              >
                <span>@{m.name}</span>
                <span class="num">{m.posts || 0}</span>
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  </div>

  <div class="sw-feed" bind:this={feedEl}>
    {#if visible.length === 0}
      <div class="sw-feed-empty">
        {#if messages.length > 0}
          <p>{t('没有符合筛选条件的消息')}</p>
          <button type="button" class="sw-reset-btn" onclick={clearAllFilters}>{t('清除筛选')}</button>
        {:else}
          <p>{t('消息板暂无动态')}</p>
        {/if}
      </div>
    {:else}
      {#each visible as m (m.seq)}
        {#if m.control}
          <div class="sw-sys-row" data-sw-seq-row={m.seq} class:hit={targetSeq === m.seq}>
            <span class="sw-sys-txt">{String(m.text || '').replace(/^\[channel\]\s*/, '')}</span>
            {#if m.ts}<span class="sw-ts num">{fmtTime(m.ts)}</span>{/if}
          </div>
        {:else}
          {@const recips = recipientsOf(m)}
          {@const isLong = String(m.text || '').length > 360 || String(m.text || '').split('\n').length > 7}
          {@const isOpen = !isLong || Boolean(expandedSeqs[m.seq])}
          {@const senderMem = members.find((x) => x.name === m.agent)}
          {@const hasShots = Array.isArray(m.screenshots) && m.screenshots.length > 0}
          <article class="sw-post" data-sw-seq-row={m.seq} class:hit={targetSeq === m.seq}>
            <header class="sw-post-head">
              <div class="sw-post-who">
                <button
                  type="button"
                  class="sw-author"
                  onclick={() => senderMem && onOpenMember(senderMem)}
                >
                  @{m.agent}
                </button>
                {#if m.channel && m.channel !== 'main'}
                  <button
                    type="button"
                    class="sw-post-ch"
                    onclick={() => { channelFilter = m.channel; }}
                  >
                    #{m.channel}
                  </button>
                {/if}
                {#if recips.length > 0}
                  <span class="sw-recips trunc">→ {recips.join(' ')}</span>
                {/if}
              </div>
              <span class="sw-ts num">#{m.seq}{#if m.ts} · {fmtTime(m.ts)}{/if}</span>
            </header>

            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div
              class="sw-post-body sel-text"
              class:clamped={isLong && !isOpen}
              onclick={handleBodyClick}
            >
              {@html renderSwarmPostHtml(m.text, {
                members,
                channels,
                messages,
                stripLead: recips.length > 0,
                hideShotLines: hasShots,
              })}
            </div>

            {#if hasShots}
              <div class="sw-shots">
                {#each m.screenshots as shot (shot.path)}
                  <button type="button" class="sw-shot" onclick={() => openShot(shot)} title={shot.caption || t('查看大图')}>
                    <img src={agyArtifactUrl(sessionId, shot.path)} alt={shot.caption || t('进度截图')} loading="lazy" />
                    {#if shot.caption}<span class="sw-shot-cap trunc">{shot.caption}</span>{/if}
                  </button>
                {/each}
              </div>
            {/if}

            {#if isLong}
              <button type="button" class="sw-more-btn" aria-expanded={isOpen} onclick={() => toggleExpand(m.seq)}>
                {isOpen ? t('收起') : t('展开全文')}
              </button>
            {/if}
          </article>
        {/if}
      {/each}
    {/if}
  </div>
</div>

<style>
  .sw-board {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .sw-btools {
    display: flex;
    flex-direction: column;
    gap: 7px;
  }
  .sw-search-row {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .sw-search-box {
    flex: 1;
    min-width: 0;
    height: 32px;
    padding: 0 9px;
    border-radius: 8px;
    background: var(--ag-surface-1);
    border: 1px solid var(--ag-border);
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--ag-on-dim);
  }
  .sw-search-box:focus-within { border-color: var(--ag-border-strong); }
  .sw-search-box .msr { font-size: 16px; flex: none; }
  .sw-search-box input {
    flex: 1;
    min-width: 0;
    border: 0;
    background: none;
    color: var(--ag-on);
    font: inherit;
    font-size: 12.5px;
    outline: none;
  }
  .sw-search-box input::placeholder { color: var(--ag-on-faint); }
  .sw-flt-btn {
    position: relative;
    width: 32px;
    height: 32px;
    border-radius: 8px;
    border: 1px solid var(--ag-border);
    background: var(--ag-surface-1);
    color: var(--ag-on-dim);
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
  }
  .sw-flt-btn:hover, .sw-flt-btn.on {
    background: var(--ag-surface-2);
    color: var(--ag-on);
    border-color: var(--ag-border-strong);
  }
  .sw-flt-btn .msr { font-size: 16px; }
  .sw-flt-dot {
    position: absolute;
    top: 6px;
    right: 6px;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--ag-accent);
  }

  /* 频道条 */
  .sw-chans {
    display: flex;
    align-items: center;
    gap: 4px;
    overflow-x: auto;
    scrollbar-width: none;
    padding-bottom: 1px;
  }
  .sw-chans::-webkit-scrollbar { display: none; }
  .sw-ch-tab {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 25px;
    padding: 0 9px;
    border-radius: 999px;
    font-size: 11.5px;
    color: var(--ag-on-dim);
    border: 1px solid var(--ag-border);
    background: var(--ag-surface-1);
  }
  .sw-ch-tab:hover { background: var(--ag-hover); color: var(--ag-on); }
  .sw-ch-tab.on {
    background: var(--ag-surface-2);
    border-color: var(--ag-border-strong);
    color: var(--ag-on);
    font-weight: 500;
  }
  .sw-ch-tab.archived { opacity: 0.6; }
  .sw-ch-tab .num { font-size: 10.5px; color: var(--ag-on-faint); }

  /* 折叠筛选区 */
  .sw-filters {
    display: flex;
    flex-direction: column;
    gap: 7px;
    padding: 8px 9px;
    border-radius: 9px;
    background: var(--ag-surface-1);
    border: 1px solid var(--ag-border);
  }
  .sw-sel-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }
  .sw-sel-row select {
    flex: 1;
    min-width: 110px;
    height: 28px;
    padding: 0 8px;
    border-radius: 7px;
    border: 1px solid var(--ag-border);
    background: var(--ag-bg);
    color: var(--ag-on);
    font: inherit;
    font-size: 12px;
    outline: none;
  }
  .sw-clr-btn {
    height: 28px;
    padding: 0 8px;
    border-radius: 7px;
    font-size: 11.5px;
    color: var(--ag-on-dim);
  }
  .sw-clr-btn:hover { background: var(--ag-hover); color: var(--ag-on); }
  .sw-mchips {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
  }
  .sw-mchip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 23px;
    padding: 0 8px;
    border-radius: 999px;
    font-size: 11px;
    font-family: var(--ag-mono);
    background: var(--ag-surface-2);
    color: var(--ag-on-sub);
  }
  .sw-mchip.dim { opacity: 0.42; text-decoration: line-through; }
  .sw-mchip .num { color: var(--ag-on-faint); font-size: 10px; }

  /* 消息流 */
  .sw-feed {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .sw-feed-empty {
    padding: 28px 12px;
    text-align: center;
    font-size: 12.5px;
    color: var(--ag-on-dim);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }
  .sw-feed-empty p { margin: 0; }
  .sw-reset-btn {
    height: 28px;
    padding: 0 12px;
    border-radius: 8px;
    border: 1px solid var(--ag-border-strong);
    background: var(--ag-surface-1);
    color: var(--ag-on);
    font-size: 12px;
  }

  .sw-sys-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 3px 6px;
    font-size: 11.5px;
    color: var(--ag-on-faint);
  }
  .sw-sys-txt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .sw-post {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 9px 11px;
    border-radius: 10px;
    background: var(--ag-surface-1);
    border: 1px solid var(--ag-border);
    transition: border-color 0.2s ease, box-shadow 0.2s ease;
  }
  .sw-post.hit, .sw-sys-row.hit {
    box-shadow: 0 0 0 1.5px color-mix(in srgb, var(--ag-accent) 60%, transparent);
    border-radius: 10px;
  }
  .sw-post-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    min-width: 0;
  }
  .sw-post-who {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    flex: 1;
  }
  .sw-author {
    flex: none;
    font-size: 12.5px;
    font-weight: 560;
    font-family: var(--ag-mono);
    color: var(--ag-on);
  }
  .sw-author:hover { text-decoration: underline; text-underline-offset: 2px; }
  .sw-post-ch {
    flex: none;
    font-size: 10.5px;
    padding: 1px 6px;
    border-radius: 999px;
    background: var(--ag-surface-2);
    color: var(--ag-on-dim);
    font-family: var(--ag-mono);
  }
  .sw-post-ch:hover { color: var(--ag-on); }
  .sw-recips {
    font-size: 11.5px;
    color: var(--ag-on-dim);
    font-family: var(--ag-mono);
  }
  .sw-ts {
    flex: none;
    font-size: 11px;
    color: var(--ag-on-faint);
    white-space: nowrap;
  }

  .sw-post-body {
    font-size: 12.5px;
    line-height: 1.55;
    color: var(--ag-on-sub);
    word-break: break-word;
  }
  .sw-post-body.clamped {
    max-height: calc(1.55em * 6);
    overflow: hidden;
    -webkit-mask-image: linear-gradient(to bottom, #000 66%, transparent);
    mask-image: linear-gradient(to bottom, #000 66%, transparent);
  }
  .sw-post-body :global(p) { margin: 0 0 6px; }
  .sw-post-body :global(p:last-child),
  .sw-post-body :global(ul:last-child),
  .sw-post-body :global(pre:last-child) { margin-bottom: 0; }
  .sw-post-body :global(ul) { margin: 0 0 6px; padding-left: 18px; }
  .sw-post-body :global(li) { margin: 2px 0; }
  .sw-post-body :global(h1),
  .sw-post-body :global(h2),
  .sw-post-body :global(h3),
  .sw-post-body :global(h4) {
    margin: 6px 0 4px;
    font-size: 12.5px;
    font-weight: 600;
    color: var(--ag-on);
  }
  .sw-post-body :global(code) {
    font-family: var(--ag-mono);
    font-size: 0.9em;
    padding: 0 4px;
    border-radius: 4px;
    background: var(--ag-code-bg);
    border: 1px solid var(--ag-code-bd);
    color: var(--ag-code-on);
  }
  .sw-post-body :global(pre) {
    margin: 4px 0 6px;
    padding: 7px 9px;
    border-radius: 7px;
    background: var(--ag-code-bg);
    border: 1px solid var(--ag-code-bd);
    overflow-x: auto;
  }
  .sw-post-body :global(pre code) {
    border: 0;
    padding: 0;
    background: none;
    font-size: 11.5px;
  }
  .sw-post-body :global(.sw-mention) {
    display: inline;
    font-family: var(--ag-mono);
    font-size: 0.94em;
    color: var(--ag-accent);
    font-weight: 500;
  }
  .sw-post-body :global(.sw-mention.all) {
    color: var(--ag-warn);
  }
  .sw-post-body :global(.sw-mention.archived) {
    color: var(--ag-on-faint);
    text-decoration: line-through;
  }
  .sw-post-body :global(.sw-seq-ref) {
    display: inline-flex;
    align-items: center;
    padding: 0 5px;
    border-radius: 5px;
    font-family: var(--ag-mono);
    font-size: 11px;
    line-height: 16px;
    background: color-mix(in srgb, var(--ag-accent) 13%, transparent);
    color: var(--ag-accent);
    vertical-align: baseline;
  }
  .sw-post-body :global(.sw-seq-ref:hover) {
    background: color-mix(in srgb, var(--ag-accent) 22%, transparent);
  }
  .sw-post-body :global(.sw-tag) {
    display: inline-block;
    padding: 0 5px;
    border-radius: 4px;
    font-family: var(--ag-mono);
    font-size: 11px;
    background: var(--ag-surface-2);
    color: var(--ag-on);
  }
  .sw-post-body :global(.sw-tag.done) {
    background: var(--ag-ok-bg);
    color: var(--ag-ok);
  }
  .sw-post-body :global(.sw-tag.stall) {
    background: var(--ag-warn-bg);
    color: var(--ag-warn);
  }

  .sw-shots {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(128px, 1fr));
    gap: 6px;
    margin-top: 2px;
  }
  .sw-shot {
    display: flex;
    flex-direction: column;
    border-radius: 8px;
    overflow: hidden;
    border: 1px solid var(--ag-border);
    background: var(--ag-bg);
    text-align: left;
  }
  .sw-shot img {
    width: 100%;
    aspect-ratio: 16 / 10;
    object-fit: cover;
    display: block;
  }
  .sw-shot-cap {
    padding: 4px 6px;
    font-size: 11px;
    color: var(--ag-on-dim);
  }

  .sw-more-btn {
    align-self: flex-start;
    font-size: 11.5px;
    color: var(--ag-accent);
    padding: 2px 4px;
    margin-left: -4px;
    border-radius: 5px;
  }
  .sw-more-btn:hover { background: var(--ag-hover); }

  .trunc { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .num { font-variant-numeric: tabular-nums; }
</style>
