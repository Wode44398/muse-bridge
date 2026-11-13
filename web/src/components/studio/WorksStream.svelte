<script>
  // 作品栏「作品」：跨四个种类的作品流。进行中的任务置顶，之后按天分组；左侧槽里画血缘线
  // （git graph 式泳道，modules/studio/lineage.js 算好每行的线段，这里每行只画自己那一小段 SVG，不量位置）。
  // 视觉（v3 §9.2）：dimensio 对话流左侧的「点 + 竖线」母题——灰点、1px 线，在跑的那一件是一粒带光晕的朱点；
  // 行与 dimensio 侧栏会话行同族（悬停墨 4.5%、画布上正看着的那件 = 白纸 + 细线）；悬停 / 按住时整条链变深、无关行淡下去。
  //
  // 交互：点一下＝在它的创作页画布里打开；桌面按下拖 4px 起拖、手机按住 420ms 起拖（原地按住松手弹菜单，
  // 同工作空间的 onStay 约定）；行尾「…」桌面悬停出现、触屏常显。起拖走全域拖放，落点是各创作页的输入框。
  import { t, tc } from '../../lib/i18n.js';
  import { dragScrollGuard } from '../../lib/dragdrop.svelte.js';
  import { studio, loadAssets, openAsset, mediaSrc, isActive, jobTiming, jobStateText, modelLabelOf } from '../../modules/studio/media.svelte.js';
  import { layoutLineage, chainOf, hasLineage } from '../../modules/studio/lineage.js';
  import { pageOf, visual } from '../../modules/studio/kinds.js';
  import { assetDrag } from '../../modules/studio/assetDrag.js';
  import { icon } from '../../modules/studio/icons.js';
  import WorkMenu from './WorkMenu.svelte';
  import Img from './ui/Img.svelte';
  import Measure from './ui/Measure.svelte';

  const AK = { speech: 'audio' };
  const jobAssetKind = (j) => AK[j.kind] || j.kind;
  const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };
  const ts = (x) => (typeof x === 'number' ? x : Date.parse(x) || 0);
  function dayLabel(ms) {
    const today = dayKey(Date.now()), y = dayKey(Date.now() - 86400e3), k = dayKey(ms);
    if (k === today) return t('今天');
    if (k === y) return t('昨天');
    const d = new Date(ms);
    return d.getFullYear() === new Date().getFullYear() ? t('{m}月{d}日', { m: d.getMonth() + 1, d: d.getDate() }) : t('{y}年{m}月{d}日', { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() });
  }

  const rows = $derived.by(() => {
    const out = [];
    const jobs = studio.jobs.filter((j) => isActive(j) && (studio.filter === 'all' || jobAssetKind(j) === studio.filter));
    if (jobs.length) {
      out.push({ header: true, key: 'h-live', label: tc('任务', '进行中') });
      for (const j of jobs) out.push({ id: 'job:' + j.id, key: 'j' + j.id, job: j, parents: j.parent ? [j.parent] : [], kind: jobAssetKind(j) });
    }
    let last = null;
    for (const a of studio.assets) {
      const k = dayKey(ts(a.createdAt));
      if (k !== last) { out.push({ header: true, key: 'h' + k, label: dayLabel(ts(a.createdAt)) }); last = k; }
      out.push({ id: a.id, key: a.id, asset: a, parents: a.parents || [], kind: a.kind });
    }
    return out;
  });
  const lanes = $derived(layoutLineage(rows));
  // 整列都没有血缘时不留槽（行直接顶格）；有血缘时只有参与血缘的行才画节点，别的行不留孤点
  const graph = $derived(hasLineage(rows));
  const linked = (L) => L.into.length || L.out.length || L.stub;
  let hoverId = $state('');
  const chain = $derived(hoverId ? chainOf(rows, hoverId) : new Set());
  const chainOn = $derived(chain.size > 1);

  // 此刻在当前创作页画布上「正看着」的那一件（那一行用选中底）：图像续改链只算最新一轮，不把整条链都涂上
  const openIds = $derived.by(() => {
    const p = studio.page;
    if (p === 'image') { const last = studio.views.image.turns.flatMap((x) => x.assets || []).at(-1); return new Set(last ? [last.id] : []); }
    const f = studio.views[p]?.focus;
    const job = f?.jobId ? studio.jobs.find((j) => j.id === f.jobId) : null;
    const id = f?.asset?.id || job?.result?.[0]?.id;
    return new Set(id ? [id] : []);
  });

  const LX = (l) => 8 + l * 7;   // 泳道 x
  const NY = 28;                  // 节点 y（缩略图中心）
  const lit = (e) => chainOn && chain.has(e.from) && chain.has(e.to);

  const modelName = (a) => modelLabelOf(a);
  // 元信息只放「模型短名 + 时刻」（尺寸、时长在详情里有）。模型名放不下时整段让开（CSS 把它挤到隐藏的第二行），
  // 不截出半个词；目录里认不出的模型用裸 id，去掉服务前缀（openai/…）。
  function shortModel(a) {
    const n = modelName(a);
    return String(n || '').replace(/^[\w.-]+\//, '');
  }
  function clock(a) {
    const d = new Date(ts(a.createdAt));
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // —— 无限滚动 ——
  let listEl = $state();
  function onScroll() {
    const el = listEl;
    if (!el || studio.assetsDone || studio.assetsLoading) return;
    if (el.scrollHeight - el.scrollTop - el.clientHeight < 320) loadAssets(false);
  }

  function clickRow(e, r) {
    if (e.target.closest('.wr-more')) return;
    if (r.asset) openAsset(r.asset);
    else if (r.job) { const p = pageOf(r.job.kind); if (p) { studio.page = p; if (p !== 'image') studio.views[p].focus = { jobId: r.job.id }; } }
  }

  // —— 菜单 ——
  let menu = $state(null);   // { asset, anchor, at? }
  function openMenu(a, anchor, at = null) { menu = { asset: a, anchor, at }; }
</script>

<div class="ws" class:flat={!graph} bind:this={listEl} onscroll={onScroll} use:dragScrollGuard>
  {#if !rows.length}
    <div class="ws-empty">
      {#if studio.assetsLoading}<Measure tone="live" />
      {:else if studio.assetsErr}<p>{studio.assetsErr}</p><button class="ws-retry" onclick={() => loadAssets(true)}>{t('重试')}</button>
      {:else if studio.q}<p>{t('没有结果')}</p>
      {:else if studio.filter !== 'all'}<p>{t('这一类还没有作品')}</p>
      {:else}<p>{t('还没有作品')}</p>{/if}
    </div>
  {/if}
  {#each rows as r, i (r.key)}
    {@const L = lanes[i]}
    {#if r.header}
      <div class="wr-h">
        {#if L.pass.length}
          <svg class="wr-g" aria-hidden="true">{#each L.pass as e}<line class:lit={lit(e)} x1={LX(e.lane)} x2={LX(e.lane)} y1="0" y2="100%" />{/each}</svg>
        {/if}
        <span>{r.label}</span>
      </div>
    {:else}
      {@const a = r.asset}
      {@const j = r.job}
      {@const inChain = chain.has(r.id)}
      <div class="wr" class:live={!!j} class:dim={chainOn && !inChain} class:cur={a && openIds.has(a.id)}
        class:flash={a && studio.flash === a.id} data-work={a?.id || null}
        role="button" tabindex="0" aria-label={(a?.prompt || j?.prompt || t('作品'))}
        onpointerenter={() => (hoverId = r.id)} onpointerleave={() => { if (hoverId === r.id) hoverId = ''; }}
        onfocus={() => (hoverId = r.id)} onblur={() => { if (hoverId === r.id) hoverId = ''; }}
        use:assetDrag={{ asset: a, onStay: (el) => openMenu(a, el) }}
        oncontextmenu={(e) => { if (a && e.pointerType !== 'touch') { e.preventDefault(); openMenu(a, e.currentTarget, { x: e.clientX, y: e.clientY }); } }}
        onclick={(e) => clickRow(e, r)} onkeydown={(e) => { if (e.key === 'Enter') clickRow(e, r); }}>
        <svg class="wr-g" aria-hidden="true">
          {#each L.pass as e}<line class:lit={lit(e)} x1={LX(e.lane)} x2={LX(e.lane)} y1="0" y2="100%" />{/each}
          {#each L.into as e}
            {#if e.lane === L.lane}<line class:lit={lit(e)} x1={LX(e.lane)} x2={LX(e.lane)} y1="0" y2={NY} />
            {:else}<path class:lit={lit(e)} d="M{LX(e.lane)} 0 V{NY - 6} Q{LX(e.lane)} {NY} {LX(L.lane)} {NY}" />{/if}
          {/each}
          {#each L.out as e}
            {#if e.lane === L.lane}<line class:lit={lit(e)} x1={LX(e.lane)} x2={LX(e.lane)} y1={NY} y2="100%" />
            {:else}<path class:lit={lit(e)} d="M{LX(L.lane)} {NY} Q{LX(e.lane)} {NY} {LX(e.lane)} {NY + 6}" /><line class:lit={lit(e)} x1={LX(e.lane)} x2={LX(e.lane)} y1={NY + 6} y2="100%" />{/if}
          {/each}
          {#if L.stub}<line class="stub" x1={LX(L.lane)} x2={LX(L.lane)} y1={NY - 16} y2={NY - 5} />{/if}
          {#if linked(L)}<line class="wr-br" class:lit={inChain && chainOn} x1={LX(L.lane) + 3} x2="30" y1={NY} y2={NY} />{/if}
          {#if j && linked(L)}<circle class="wr-halo" cx={LX(L.lane)} cy={NY} r="5" />{/if}
          {#if linked(L)}<circle class="wr-node" class:lit={inChain && chainOn} class:live={!!j} cx={LX(L.lane)} cy={NY} r="2.5" />{/if}
        </svg>
        <span class="wr-thumb">
          {#if j}
            <span class="wr-busy" aria-hidden="true"><span class="sd-dot live"></span></span>
          {:else if visual(a.kind)}
            <Img src={mediaSrc(a, 'thumb')} alt="" loading="lazy" decoding="async" draggable="false" />
            {#if a.kind === 'video'}<span class="wr-play">{@html icon('play')}</span>{/if}
          {:else}
            {@html icon(a.kind === 'music' ? 'music' : 'voice')}
          {/if}
        </span>
        <span class="wr-tx">
          <span class="wr-p">{(a?.prompt || j?.prompt) || t('（无提示词）')}</span>
          <span class="wr-m">
            <!-- 在跑：朱点和进度线已经说了「在跑」，这里只写计时（排队中才写字）；作品只写型号——时刻放不下时有的行有、有的行没有，
                 像缺数据（复核 11-06 第二轮）；列表本来按日期分组、按时间排，时刻在悬停里 -->
            {#if j}{#if j.state === 'queued'}<span>{jobStateText(j)}</span>{/if}<span class="mono live-t">{jobTiming(j)}</span>
            {:else}<span title={clock(a)}>{shortModel(a)}</span>{/if}
          </span>
        </span>
        {#if a}
          <button class="wr-more" data-nodrag aria-label={t('更多')} onclick={(e) => { e.stopPropagation(); openMenu(a, e.currentTarget); }}>{@html icon('more')}</button>
        {/if}
        {#if j}<Measure value={j.progress || null} tone="live" />{/if}
      </div>
    {/if}
  {/each}
  {#if rows.length && studio.assetsLoading}<div class="ws-load"><Measure tone="live" /></div>{/if}
</div>

{#if menu}
  <WorkMenu asset={menu.asset} anchor={menu.anchor} at={menu.at} onclose={() => (menu = null)} />
{/if}
