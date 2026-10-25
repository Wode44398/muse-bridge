<script>
  // Claude 侧栏的「搜索会话」（2026-10-20，对齐官方 Claude Desktop 侧栏的 Search / Ctrl+K 搜索面板）。
  // 宽屏：居中的命令面板（距顶 12vh、宽 ≤640）；手机（full）：全屏页，顶部返回 + 输入框，结果满高。
  // 两段出结果：先在侧栏已加载的会话里按标题即时过滤（零延迟），停手 250ms 再问服务端全文搜索
  //（GET /api/claude/search：① 标题与曾用名 ② 宽松：多个词各自命中标题 / 项目名 / 分支 ③ 正文，覆盖所有项目
  // 与已归档会话，见 src/runtime/session-search.mjs），回来后整体换成服务端结果；索引还没建完（partial）就隔两秒再问一次。
  // 分层（官方面板同款）：标题 → 模糊匹配 → 对话内容，每层先给前 5 条、「再显示 n 条」展开；
  // 已归档的折成最后一行「显示已归档（n）」（官方 show-archived），点开才列出来。
  // 命中词加粗（官方 variant:"bold"）；↑↓ 选、Enter 打开 / 展开、Esc / 系统返回键关。
  import { api } from '../../lib/api.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { relTime } from '../../lib/format.js';
  import { titleFor } from '../../lib/library.svelte.js';
  import { t, tr } from '../../lib/i18n.js';
  import { highlightParts, normQuery as norm, groupHits } from '../../lib/sessionArchiveView.js';

  let { sessions = [], projects = [], full = false, onOpen, onClose } = $props();

  let q = $state('');
  let hi = $state(0);
  let remote = $state(null);      // { q, hits, partial }
  let busy = $state(false);
  let listEl = $state();
  let inputEl = $state();
  let open = $state({});          // 展开了的层
  let archOpen = $state(false);   // 「显示已归档」点开了

  const nq = $derived(norm(q));
  const projName = (id) => projects.find((p) => p.id === id)?.name || '';

  // 本地层：已加载的侧栏列表（空查询 = 最近几条）
  const localHits = $derived.by(() => {
    const rows = [];
    for (const s of sessions) {
      const title = titleFor(s.id, s.title) || '';
      if (nq && !norm(title).includes(nq)) continue;
      rows.push({ sessionId: s.id, title, projectId: s.projectId, project: projName(s.projectId), mtime: s.mtime, match: nq ? 'title' : 'recent' });
      if (rows.length >= (nq ? 20 : 8)) break;
    }
    return rows;
  });

  // 服务端层：防抖 250ms；只认最后一次请求的结果
  let seq = 0, timer = null, retry = null;
  $effect(() => {
    const qq = nq;
    clearTimeout(timer); clearTimeout(retry);
    open = {}; archOpen = false;    // 换了查询：各层收回去
    if (!qq) { remote = null; busy = false; seq++; return; }
    busy = true;
    timer = setTimeout(() => fetchRemote(qq, 0), 250);
    return () => { clearTimeout(timer); clearTimeout(retry); };
  });
  async function fetchRemote(qq, round) {
    const my = ++seq;
    try {
      const d = await api.get('/api/claude/search?q=' + encodeURIComponent(qq) + '&limit=40');
      if (my !== seq) return;
      remote = { q: qq, hits: Array.isArray(d?.hits) ? d.hits : [], partial: !!d?.partial };
      // 冷启动时正文索引在后台建，这次只搜到已建好的部分：隔两秒再问（最多两次）
      if (d?.partial && round < 2) { retry = setTimeout(() => fetchRemote(qq, round + 1), 2000); return; }
    } catch {
      if (my !== seq) return;
    }
    busy = false;
  }

  const shown = $derived(nq && remote && remote.q === nq ? remote.hits : localHits);
  const groups = $derived(groupHits(shown, { per: nq ? 5 : 8, open }));
  const layerName = (k) => (k === 'title' ? t('标题') : k === 'loose' ? t('模糊匹配') : t('对话内容'));
  // 键盘可达的一列：结果行 + 「再显示 n 条」+「显示已归档（n）」（小节标题不进）
  const items = $derived.by(() => {
    const out = [];
    for (const g of groups.layers) {
      out.push({ kind: 'sec', label: nq ? layerName(g.key) : t('最近') });
      for (const h of g.hits) out.push({ kind: 'hit', h });
      if (g.hidden) out.push({ kind: 'more', key: g.key, n: g.hidden });
    }
    if (groups.archived.length) {
      if (!archOpen) out.push({ kind: 'arch', n: groups.archived.length });
      else {
        out.push({ kind: 'sec', label: t('已归档') });
        for (const h of groups.archived) out.push({ kind: 'hit', h });
      }
    }
    return out;
  });
  const nav = $derived(items.map((it, i) => (it.kind === 'sec' ? -1 : i)).filter((i) => i >= 0));
  const anyHit = $derived(items.some((it) => it.kind === 'hit' || it.kind === 'arch'));
  $effect(() => { shown; hi = 0; });
  $effect(() => {
    const i = nav[hi];
    listEl?.querySelector(`[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  });

  // 命中词加粗：整句命中优先，整句找不到再按空格分开的各个词
  const marks = (text) => highlightParts(text, nq);

  const titleOf = (h) => tr(titleFor(h.sessionId, h.title)) || t('（无标题）');
  function act(it) {
    if (!it) return;
    if (it.kind === 'hit') { onOpen?.(it.h); return; }
    if (it.kind === 'more') open = { ...open, [it.key]: true };
    else if (it.kind === 'arch') archOpen = true;
    // 鼠标点了「再显示 / 显示已归档」焦点会落到那颗按钮上：拉回输入框，↑↓ / Enter / Esc 才接着管用（宽屏；触屏不弹键盘）
    if (!full) inputEl?.focus();
  }
  function onKey(e) {
    if (e.isComposing) return;
    const n = Math.max(1, nav.length);
    if (e.key === 'ArrowDown') { e.preventDefault(); hi = (hi + 1) % n; }
    else if (e.key === 'ArrowUp') { e.preventDefault(); hi = (hi + n - 1) % n; }
    else if (e.key === 'Enter') { e.preventDefault(); act(items[nav[hi]]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose?.(); }
  }
  const focusIt = (el) => { requestAnimationFrame(() => el.focus()); };
  $effect(() => pushBackLayer(() => onClose?.()));
</script>

<!-- 一行结果：标题（命中加粗）+ 所在项目 · 最近活动；第二行是正文片段或曾用名 -->
{#snippet hitRow(h, i)}
  <button class="ss-row" class:on={nav[hi] === i} data-i={i} onpointermove={() => { const k = nav.indexOf(i); if (k >= 0 && hi !== k) hi = k; }} onclick={() => onOpen?.(h)}>
    <span class="ss-l1">
      <span class="ss-t">{#each marks(titleOf(h)) as m, k (k)}{#if m.hit}<b>{m.s}</b>{:else}{m.s}{/if}{/each}</span>
      <span class="ss-meta">{#if h.project}{tr(h.project)}{' · '}{/if}{relTime(h.mtime)}</span>
    </span>
    {#if h.snippet}
      <span class="ss-l2">{#each marks(h.snippet) as m, k (k)}{#if m.hit}<b>{m.s}</b>{:else}{m.s}{/if}{/each}</span>
    {:else if h.former}
      <span class="ss-l2">{t('曾用名：{title}', { title: h.former })}</span>
    {/if}
  </button>
{/snippet}

{#if !full}<button class="ss-bd" aria-label={t('关闭')} onclick={() => onClose?.()}></button>{/if}
<div class="ss-pal" class:full role="dialog" aria-modal="true" aria-label={t('搜索会话')}>
  <div class="ss-head">
    {#if full}<button class="ss-back" aria-label={t('返回')} onclick={() => onClose?.()}><span class="gi">&#xe00c;</span></button>{/if}
    <label class="ss-field">
      <span class="gi ss-ic" aria-hidden="true">&#xe0d3;</span>
      <input type="search" bind:this={inputEl} bind:value={q} onkeydown={onKey} use:focusIt placeholder={t('搜索会话')} enterkeyhint="search"
        autocomplete="off" spellcheck="false" aria-label={t('搜索会话')} />
      {#if busy}<span class="ss-spin" title={t('正在深入搜索…')}></span>{/if}
    </label>
  </div>
  <div class="ss-list" bind:this={listEl}>
    {#each items as it, i (i)}
      {#if it.kind === 'sec'}
        <div class="ss-sec">{it.label}</div>
      {:else if it.kind === 'hit'}
        {@render hitRow(it.h, i)}
      {:else}
        <!-- 「再显示 n 条」（这一层展开）/「显示已归档（n）」（官方 show-archived）：不加粗、不带片段 -->
        <button class="ss-row ss-act" class:on={nav[hi] === i} data-i={i} onpointermove={() => { const k = nav.indexOf(i); if (k >= 0 && hi !== k) hi = k; }} onclick={() => act(it)}>
          {it.kind === 'more' ? t('再显示 {n} 条', { n: it.n }) : t('显示已归档（{n}）', { n: it.n })}
        </button>
      {/if}
    {/each}
    {#if nq && !busy && !anyHit}<div class="ss-empty">{t('没有与“{q}”匹配的会话。', { q: q.trim() })}</div>{/if}
    <!-- 冷启动正文索引还没建完、重试两次仍不全：说一声，免得以为没有 -->
    {#if nq && !busy && remote && remote.q === nq && remote.partial}<div class="ss-note">{t('搜索索引还在建立，结果可能不全。')}</div>{/if}
  </div>
</div>

<style>
  .ss-bd { position: fixed; inset: 0; z-index: 72; background: rgba(0, 0, 0, .35); animation: ssFade .14s ease; }
  .ss-pal { position: fixed; z-index: 73; left: 50%; top: 12vh; transform: translateX(-50%);
    width: min(640px, calc(100vw - 32px)); max-height: min(560px, 76vh); display: flex; flex-direction: column;
    background: var(--q-card, var(--card)); border-radius: 14px; box-shadow: var(--q-shadow); overflow: hidden;
    animation: ssPop .16s cubic-bezier(.22, 1, .36, 1); }
  .ss-pal.full { left: 0; right: 0; top: 0; bottom: 0; transform: none; width: auto; max-height: none; border-radius: 0;
    background: var(--bg); box-shadow: none; padding-top: var(--sat, 0px); padding-bottom: var(--kb, 0px); animation: ssFade .14s ease; }
  @keyframes ssPop { from { opacity: 0; transform: translateX(-50%) translateY(-6px) scale(.985); } to { opacity: 1; transform: translateX(-50%); } }
  @keyframes ssFade { from { opacity: 0; } to { opacity: 1; } }

  .ss-head { flex: none; display: flex; align-items: center; gap: 4px; padding: 8px; border-bottom: 1px solid var(--divider); }
  .full .ss-head { padding: 8px 12px 8px 6px; border-bottom: none; }
  .ss-back { flex: none; width: 40px; height: 40px; display: inline-flex; align-items: center; justify-content: center; border-radius: 10px; color: var(--text); }
  .ss-back:active { background: var(--hover); }
  .ss-field { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; height: 40px; padding: 0 10px; border-radius: 10px; }
  .full .ss-field { background: var(--hover); }
  .ss-field input { flex: 1; min-width: 0; height: 100%; border: none; outline: none; background: transparent; color: var(--text); font-size: 15px; }
  .ss-field input::-webkit-search-cancel-button { display: none; }
  .ss-ic { color: var(--muted); }
  .gi { font-family: var(--icons); font-style: normal; font-feature-settings: "liga" 0; font-variation-settings: "opsz" 20, "wght" 433;
    font-size: 18px; line-height: 1; display: inline-flex; align-items: center; justify-content: center; }
  .ss-spin { flex: none; width: 14px; height: 14px; border-radius: 50%; border: 1.5px solid color-mix(in srgb, var(--muted) 35%, transparent);
    border-top-color: var(--muted); animation: ssSpin .8s linear infinite; }
  @keyframes ssSpin { to { transform: rotate(360deg); } }

  .ss-list { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 6px 8px; overscroll-behavior: contain; }
  .ss-sec { padding: 10px 10px 4px; font-size: 12px; color: var(--muted); }
  .ss-row { width: 100%; display: flex; flex-direction: column; gap: 2px; padding: 8px 10px; border-radius: 8px; text-align: left; color: var(--serif); }
  .ss-row.on { background: var(--hover); }
  .ss-row:active { background: var(--hover-strong); }
  .full .ss-row.on:not(:active) { background: transparent; }   /* 触屏没有键盘选择：不留「选中」底色 */
  .ss-act { font-size: 13px; color: var(--muted); padding-top: 6px; padding-bottom: 6px; }
  .ss-note { padding: 10px 10px 4px; font-size: 12px; color: var(--muted); }
  @media (hover: hover) { .ss-act:hover { color: var(--text); } }
  .ss-l1 { display: flex; align-items: baseline; gap: 10px; min-width: 0; }
  .ss-t { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 14px; color: var(--text); }
  .ss-meta { flex: none; max-width: 45%; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; color: var(--muted); }
  .ss-l2 { display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
    font-size: 13px; line-height: 18px; color: var(--muted); overflow-wrap: anywhere; }
  .ss-row b { font-weight: 650; color: var(--text); }
  .ss-empty { padding: 18px 10px; font-size: 13px; color: var(--muted); text-align: center; }
  @media (prefers-reduced-motion: reduce) { .ss-pal, .ss-bd { animation: none; } }
</style>
