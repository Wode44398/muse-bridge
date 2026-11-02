<script>
  // 记忆卡的「逐层」视图：手机和窄卡片的主形态。导图在手机上要捏、要拖、字又小，这里换成一次只看一层：
  // 顶上是当前这一枝（大标题 + 说明），下面是它分出去的枝，沿一根彩色主干垂下来，每一行都是手指好点的大行。
  // 点有下级的 = 走进去；点一篇 = 打开 md。面包屑和系统返回键都是退回上一层。
  // 索引里的 ## 小节（分组节点）不单独占一层，直接当这一层里的小节标题——bridge 的三层索引两下就能点到底。
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { pushBackLayer } from '../../lib/nav.js';
  import { relTime } from '../../lib/format.js';
  import { nodeLabel, nodeSub, ancestors, branchMtime, typeLabel } from '../../lib/memoryTree.js';
  import { t, tc } from '../../lib/i18n.js';

  // level：当前这一层的节点 id（宿主持有，切到导图再切回来还在原处）
  let { graph, index, files, rootName = '', level = $bindable(''), onopen, onissues } = $props();

  const cur = $derived(index.info.get(level) && index.info.get(level).n.kind !== 'group' ? level : index.rootId);
  const node = $derived(index.info.get(cur)?.n);
  const isRoot = $derived(cur === index.rootId);
  // 小节（分组节点）只是这一层里的标题，不算一层：面包屑和「退一层」都跳过它
  const crumbs = $derived(ancestors(index, cur).filter((id) => index.info.get(id)?.n.kind !== 'group'));
  const label = (n) => nodeLabel(n, files, index, rootName);

  // 这一层的小节：分组 / 未索引各成一节；夹在中间的散篇并成无标题的一节
  const FOLD = 8;
  const sections = $derived.by(() => {
    if (!node) return [];
    const out = [];
    let loose = null;
    for (const c of node.children) {
      if (c.kind === 'group' || c.kind === 'unindexed') {
        loose = null;
        out.push({ key: c.id, title: label(c), hue: index.info.get(c.id)?.hue ?? null, items: c.children, unindexed: c.kind === 'unindexed' });
      } else {
        if (!loose) { loose = { key: 'loose:' + c.id, title: '', hue: isRoot ? null : index.info.get(c.id)?.hue ?? null, items: [] }; out.push(loose); }
        loose.items.push(c);
      }
    }
    return out;
  });
  let unfolded = $state(new Set());
  let subOpen = $state(false);
  // 类型标签只在一节里混着几种类型时才有信息量（一节全是「项目」就不必每行都标）
  const mixed = (items) => new Set(items.map((c) => (c.kind === 'file' ? files[c.ref]?.type || '' : '-'))).size > 1;

  // 进 / 退的方向（决定滑入方向）+ 每层的滚动位置（退回来时回到原处）
  let dir = $state(1);
  let scroller = $state();
  const scrollAt = new Map();
  function go(id) {
    if (id === cur) return;
    const down = ancestors(index, id).includes(cur);
    scrollAt.set(cur, scroller?.scrollTop || 0);
    dir = down ? 1 : -1;
    level = id;
    unfolded = new Set();
    subOpen = false;
    queueMicrotask(() => { if (scroller) scroller.scrollTop = down ? 0 : scrollAt.get(id) || 0; });
  }
  const up = () => { if (crumbs.length) go(crumbs[crumbs.length - 1]); };
  // 安卓返回键 / 侧滑返回：先退一层
  $effect(() => { if (!isRoot) return pushBackLayer(up); });

  function tap(c) {
    const kids = c.children.length;
    if (kids) go(c.id);
    else if (c.kind === 'file') onopen(c);
  }

  const headSub = $derived(!isRoot && node ? nodeSub(node, files) : '');
  const count = $derived(index.info.get(cur)?.count || 0);
  const when = $derived(node ? branchMtime(node, files) : 0);
  const hue = $derived(index.info.get(cur)?.hue ?? null);
  const stats = $derived(graph?.stats || {});
  const hueStyle = (h) => (h == null ? '' : `--h:${h}`);
</script>

<div class="ol">
  <div class="ol-scroll" bind:this={scroller}>
    {#key cur}
      <div class="ol-level" in:fly={{ x: 28 * dir, duration: 240, easing: cubicOut, opacity: 0 }}>
        <header class="ol-head" class:tinted={hue != null} class:root={isRoot} style={hueStyle(hue)}>
          {#if crumbs.length}
            <nav class="ol-crumbs" aria-label={tc('claude', '所在位置')}>
              <button class="ol-back" aria-label={t('返回')} onclick={up}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>
              </button>
              {#each crumbs as id, i (id)}
                {#if i}<span class="ol-sep">/</span>{/if}
                <button class="ol-crumb" onclick={() => go(id)}>{label(index.info.get(id).n)}</button>
              {/each}
            </nav>
          {/if}
          <!-- 根这一层不重复项目名（顶栏已经写着），只留一行概况 -->
          {#if !isRoot}
            <h2 class="ol-title">{label(node)}</h2>
            {#if headSub}<button class="ol-sub" class:open={subOpen} onclick={() => { subOpen = !subOpen; }}>{headSub}</button>{/if}
          {/if}
          <div class="ol-meta">
            <span>{t('{n} 篇', { n: count })}</span>
            {#if when}<span class="dot">·</span><span>{tc('claude', '{when}更新', { when: relTime(when) })}</span>{/if}
            {#if isRoot && stats.dead}<span class="dot">·</span><button class="ol-issue" onclick={() => onissues?.('dead')}>{tc('claude', '死链 {n}', { n: stats.dead })}</button>{/if}
            {#if node?.kind === 'file'}
              <button class="ol-read" onclick={() => onopen(node)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z"/><path d="M14 3.5V8h4M9 12.5h6M9 16h4"/></svg>
                {isRoot ? tc('claude', '打开总索引') : tc('claude', '阅读这篇')}
              </button>
            {/if}
          </div>
        </header>

        {#if !sections.length}
          <div class="ol-empty">{tc('claude', '这一篇下面没有链接到别的记忆')}</div>
        {/if}

        {#each sections as s (s.key)}
          {@const many = s.items.length > FOLD + 2 && !unfolded.has(s.key)}
          {@const shown = many ? s.items.slice(0, FOLD) : s.items}
          {@const showType = mixed(s.items)}
          <section class="ol-sec" class:neutral={s.hue == null} class:untitled={!s.title} style={hueStyle(s.hue)}>
            {#if s.title}
              <h3 class="ol-sec-t" class:loose={s.unindexed}><span class="ol-knot"></span>{s.title}<span class="ol-sec-n">{s.items.length}</span></h3>
            {/if}
            <ul class="ol-rows">
              {#each shown as c, i (c.id)}
                {@const m = c.kind === 'file' ? files[c.ref] : null}
                {@const h = index.info.get(c.id)?.hue}
                {@const kids = index.info.get(c.id)?.count || 0}
                <li class="ol-li" class:last={i === shown.length - 1 && !many} style={s.hue == null && h != null ? `--h:${h}` : ''}>
                  <button class="ol-row" class:branch={kids > 0} onclick={() => tap(c)}>
                    <span class="ol-twig" aria-hidden="true"></span>
                    <span class="ol-bud" aria-hidden="true"></span>
                    <span class="ol-main">
                      <span class="ol-t">{label(c)}</span>
                      {#if nodeSub(c, files)}<span class="ol-s">{nodeSub(c, files)}</span>{/if}
                    </span>
                    {#if m?.dead.length}<span class="ol-dead" title={t('死链：{list}', { list: m.dead.join('、') })}></span>{/if}
                    {#if kids}
                      <span class="ol-n">{kids}</span>
                      <svg class="ol-go" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 5l7 7-7 7"/></svg>
                    {:else if m?.type && showType}
                      <span class="ol-type">{typeLabel(m.type)}</span>
                    {/if}
                  </button>
                </li>
              {/each}
              {#if many}
                <li class="ol-li last">
                  <button class="ol-row more" onclick={() => { unfolded = new Set([...unfolded, s.key]); }}>
                    <span class="ol-twig" aria-hidden="true"></span>
                    <span class="ol-more">{tc('claude', '还有 {n} 篇', { n: s.items.length - FOLD })}</span>
                  </button>
                </li>
              {/if}
            </ul>
          </section>
        {/each}
        <div class="ol-end"></div>
      </div>
    {/key}
  </div>
</div>

<style>
  .ol { position: relative; flex: 1; min-height: 0; display: flex; flex-direction: column; }
  .ol-scroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior: contain; }
  .ol-level { padding: 4px 14px 0 12px; }

  /* —— 当前这一枝 —— */
  .ol-head { padding: 6px 4px 14px 6px; }
  .ol-crumbs { display: flex; align-items: center; gap: 2px; margin: 0 0 8px -6px; min-width: 0; overflow-x: auto; scrollbar-width: none; white-space: nowrap; }
  .ol-crumbs::-webkit-scrollbar { display: none; }
  .ol-back { flex: none; width: 30px; height: 30px; border-radius: 9px; display: flex; align-items: center; justify-content: center; color: var(--text); }
  .ol-back svg { width: 18px; height: 18px; }
  .ol-back:active { background: var(--hover-strong); }
  .ol-crumb { flex: none; max-width: 180px; overflow: hidden; text-overflow: ellipsis; padding: 4px 6px; border-radius: 7px; font-size: 13px; color: var(--muted); }
  .ol-crumb:active { background: var(--hover-strong); }
  @media (hover: hover) { .ol-crumb:hover, .ol-back:hover { background: var(--hover); color: var(--text); } }
  .ol-sep { flex: none; color: color-mix(in srgb, var(--muted) 55%, transparent); font-size: 12px; }
  .ol-title { margin: 0; font-family: var(--serif-stack); font-weight: 500; font-size: 23px; line-height: 1.25; letter-spacing: -.005em; color: var(--text); overflow-wrap: anywhere; }
  .ol-head.tinted .ol-title { color: color-mix(in oklch, var(--text) 78%, oklch(var(--mm-l) var(--mm-c) var(--h))); }
  .ol-sub { display: -webkit-box; -webkit-line-clamp: 3; line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; margin: 6px 0 0; padding: 0; text-align: left;
    font-size: 13.5px; line-height: 1.55; color: var(--serif); overflow-wrap: anywhere; }
  .ol-sub.open { -webkit-line-clamp: unset; line-clamp: unset; }
  .ol-head.root { padding-top: 2px; padding-bottom: 10px; }
  .ol-head.root .ol-meta { margin-top: 4px; }
  .ol-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 6px; margin-top: 10px; font-size: 12.5px; color: var(--muted); }
  .ol-meta .dot { opacity: .6; }
  .ol-issue { color: var(--crit); font-size: 12.5px; padding: 0; text-decoration: underline; text-decoration-color: color-mix(in srgb, var(--crit) 40%, transparent); text-underline-offset: 3px; }
  .ol-read { margin-left: auto; display: inline-flex; align-items: center; gap: 5px; height: 30px; padding: 0 12px 0 10px; border-radius: 999px;
    font-size: 13px; color: var(--text); background: color-mix(in srgb, var(--text) 7%, transparent); }
  .ol-read svg { width: 15px; height: 15px; }
  .ol-read:active { background: color-mix(in srgb, var(--text) 13%, transparent); }
  @media (hover: hover) { .ol-read:hover { background: color-mix(in srgb, var(--text) 11%, transparent); } }
  .ol-empty { padding: 30px 8px; color: var(--muted); font-size: 13.5px; text-align: center; }

  /* —— 分出去的枝：小节标题是枝上的结，下面一根主干垂下来，每行一根弯枝接一颗芽 ——
     --c = 这一枝的颜色（OKLCH，亮度 / 饱和度按明暗主题给，见 MemoryPanel 的 --mm-l / --mm-c） */
  .ol-sec { --c: oklch(var(--mm-l) var(--mm-c) var(--h, 60)); margin: 0 0 14px; }
  .ol-sec.neutral { --c: color-mix(in srgb, var(--muted) 70%, transparent); }
  .ol-sec-t { display: flex; align-items: center; gap: 9px; margin: 0; height: 30px; padding-left: 12px; font-size: 12.5px; font-weight: 600; letter-spacing: .02em; color: var(--serif); }
  .ol-sec-t.loose { color: var(--muted); }
  .ol-knot { width: 11px; height: 11px; border-radius: 50%; background: var(--c); box-shadow: 0 0 0 3px color-mix(in srgb, var(--c) 22%, transparent); flex: none; }
  .ol-sec-t.loose .ol-knot { background: transparent; border: 1.5px dashed var(--c); box-shadow: none; }
  .ol-sec-n { font-weight: 500; color: var(--muted); font-size: 12px; }
  .ol-rows { list-style: none; margin: 0; padding: 0; }
  .ol-li { position: relative; --lc: var(--c); }
  /* 每行自己的颜色（根层的散篇各是一枝） */
  .ol-sec.neutral .ol-li[style] { --lc: oklch(var(--mm-l) var(--mm-c) var(--h)); }
  /* 主干：从小节的结垂下来，最后一行只画到行中线 */
  .ol-li::before { content: ''; position: absolute; left: 17px; top: 0; bottom: 0; width: 1.5px; background: var(--c); opacity: .55; }
  .ol-li.last::before { bottom: calc(100% - 22px); }
  .ol-sec.untitled .ol-li:first-child::before { top: 14px; }
  .ol-row { position: relative; width: 100%; display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 7px 8px 7px 42px; border-radius: 12px; text-align: left; color: var(--text); }
  .ol-row:active { background: var(--hover-strong); }
  @media (hover: hover) { .ol-row:hover { background: var(--hover); } }
  /* 弯枝：主干 → 芽 */
  .ol-twig { position: absolute; left: 17px; top: 8px; width: 13px; height: 14px; border-left: 1.5px solid var(--c); border-bottom: 1.5px solid var(--lc); border-bottom-left-radius: 10px; opacity: .55; }
  .ol-bud { position: absolute; left: 30px; top: 18px; width: 8px; height: 8px; border-radius: 50%; border: 1.5px solid var(--lc); background: var(--bg); }
  .ol-row.branch .ol-bud { background: var(--lc); }
  .ol-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
  .ol-t { font-size: 14.5px; line-height: 1.35; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .ol-row.branch .ol-t { font-weight: 600; }
  .ol-s { font-size: 12.5px; line-height: 1.45; color: var(--muted); overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; }
  .ol-n { flex: none; min-width: 22px; height: 20px; padding: 0 6px; border-radius: 10px; font-size: 11.5px; font-variant-numeric: tabular-nums;
    display: inline-flex; align-items: center; justify-content: center; color: var(--lc); background: color-mix(in srgb, var(--lc) 14%, transparent); }
  .ol-go { width: 15px; height: 15px; flex: none; color: var(--muted); margin-right: -2px; }
  .ol-type { flex: none; font-size: 11px; color: var(--muted); padding: 2px 7px; border-radius: 6px; box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--text) 12%, transparent); }
  .ol-dead { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--crit); }
  .ol-row.more { min-height: 38px; }
  .ol-more { font-size: 13px; color: var(--muted); }
  .ol-end { height: 28px; }
  @media (pointer: coarse) {
    .ol-row { min-height: 52px; padding-top: 9px; padding-bottom: 9px; }
    .ol-t { font-size: 15px; }
    .ol-bud { top: 21px; }
    .ol-twig { top: 10px; height: 15px; }
    .ol-li.last::before { bottom: calc(100% - 25px); }
  }
</style>
