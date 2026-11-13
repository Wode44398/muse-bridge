<script>
  // 模型列表：一行一个模型（勾选框 · 模型厂标 · 显示名 / id · 上下文 · 已添加的去向）。
  // 目录可能几百上千条：行用 content-visibility 跳过屏外渲染；事件全挂在列表根上（委托），不给每行挂监听；
  // 键盘焦点用 aria-activedescendant 指在行上（行本身不进 Tab 序列），↑↓ / Home / End 移动、空格 / 回车勾选。
  // 已添加的行名字用重字（其余常规字重），几百行里一眼能挑出来；pinN > 0 时前 pinN 行是置顶的已添加段，段后画一道分隔。
  import { untrack } from 'svelte';
  import BrandLogo from './BrandLogo.svelte';
  import AgentStack from './AgentStack.svelte';
  import { G, svg, CHECK } from './HsKit.js';
  import { DUR, EASE, reduced } from '../../lib/motion.js';
  import { t } from '../../lib/i18n.js';

  let {
    rows = [], picked, onpick, busy = false, filtered = false, onclearfilters,
    revealKey = '', narrow = false, listId = 'hs-list', label = '',
    onmanual, manualOk = true, pinN = 0,
  } = $props();

  let box = $state();
  let fi = $state(-1);          // 键盘焦点行（rows 的下标）
  let kbd = $state(false);      // 最近一次操作是键盘：才画焦点环（鼠标点过去不画）
  let focused = $state(false);
  let anchor = -1;              // Shift+点 的区间起点

  // 换种类 / 换厂商筛选 / 目录到了：前 12 行错峰进场（每行晚 12ms、各 200ms，整段约 330ms），播完收掉类名
  // （之后搜索打字、勾选不再重播）
  let stag = $state(false);
  $effect(() => {
    revealKey;
    // 减弱动效时 CSS 那边只留淡入（hs-row-fade）
    stag = true;
    const h = setTimeout(() => { stag = false; }, 420);
    return () => clearTimeout(h);
  });
  // 列表变了：焦点行夹回范围内，区间起点作废
  $effect(() => {
    const n = rows.length;
    untrack(() => {
      if (fi >= n) fi = n - 1;
      anchor = -1;
    });
  });

  const rowAt = (e) => {
    const el = e.target.closest?.('[data-i]');
    return el && box?.contains(el) ? { el, i: Number(el.dataset.i) } : null;
  };
  function bump(el) {
    // 勾选框短促的缩放（只在这一下点击时播，挂载时已勾着的不播）
    const cb = el?.querySelector('.hs-cb');
    if (cb && !reduced()) cb.animate([{ transform: 'scale(.82)' }, { transform: 'scale(1.06)' }, { transform: 'scale(1)' }], { duration: DUR.quick, easing: EASE.std });
  }
  function toggleAt(i, el, shift) {
    const r = rows[i];
    if (!r || !r.can) return;
    const on = !picked.has(r.id);
    if (shift && anchor >= 0 && anchor < rows.length && anchor !== i) {
      // 区间：两端之间所有可勾的行都设成被点这一行的新状态
      const [a, b] = anchor < i ? [anchor, i] : [i, anchor];
      onpick?.(rows.slice(a, b + 1).filter((x) => x.can).map((x) => x.id), on);
    } else {
      onpick?.([r.id], on);
    }
    anchor = i;
    bump(el);
  }
  function click(e) {
    const hit = rowAt(e);
    if (!hit) return;
    fi = hit.i;
    toggleAt(hit.i, hit.el, e.shiftKey);
  }
  // Shift+点时浏览器会顺手选中一段文字：按下那一刻拦掉
  function down(e) {
    kbd = false;
    if (e.shiftKey && rowAt(e)) e.preventDefault();
  }
  function rowEl(i) { return box?.querySelector(`[data-i="${i}"]`); }
  function moveTo(i) {
    if (!rows.length) return;
    fi = Math.max(0, Math.min(rows.length - 1, i));
    rowEl(fi)?.scrollIntoView({ block: 'nearest' });
  }
  function key(e) {
    if (e.target !== box || e.isComposing) return;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Home' || k === 'End' || k === 'PageDown' || k === 'PageUp') {
      e.preventDefault();
      kbd = true;
      const page = Math.max(1, Math.floor((box.closest('.body')?.clientHeight || 480) / (narrow ? 58 : 48)) - 3);
      const cur = fi < 0 ? -1 : fi;
      moveTo(k === 'Home' ? 0 : k === 'End' ? rows.length - 1
        : k === 'ArrowDown' ? cur + 1 : k === 'ArrowUp' ? Math.max(0, cur - 1)
        : k === 'PageDown' ? cur + page : cur - page);
    } else if (k === ' ' || k === 'Enter') {
      if (fi < 0) return;
      e.preventDefault();
      kbd = true;
      toggleAt(fi, rowEl(fi), e.shiftKey);
    }
  }
  function onFocus() {
    focused = true;
    // Tab 进来的（:focus-visible）才算键盘操作、画焦点环；鼠标点进来的不画
    try { if (box?.matches(':focus-visible')) kbd = true; } catch {}
    if (fi < 0 && rows.length) fi = 0;
  }

  // —— 手动添加模型 ID：一行低调的文字按钮，点了就地变成输入框，回车加进当前种类 ——
  let adding = $state(false);
  let mid = $state('');
  let merr = $state('');
  let mbusy = $state(false);
  let minput = $state();
  async function submitManual() {
    if (mbusy) return;
    mbusy = true; merr = '';
    try {
      const err = await onmanual?.(mid.trim());
      if (err) merr = err;
      else { mid = ''; minput?.focus(); }
    } finally { mbusy = false; }
  }
  function manualKey(e) {
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); submitManual(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); adding = false; mid = ''; merr = ''; }
  }
  $effect(() => { if (adding) minput?.focus(); });
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div class="list" class:narrow class:card={narrow && (rows.length || busy)} id={listId} role="listbox" aria-multiselectable="true" aria-label={label || undefined}
  tabindex={rows.length ? 0 : -1} aria-activedescendant={focused && fi >= 0 && rows[fi] ? `hs-row-${fi}` : undefined}
  bind:this={box} onclick={click} onmousedown={down} onkeydown={key} onfocus={onFocus} onblur={() => { focused = false; }}>
  {#each rows as r, i (r.id)}
    {@const on = r.can && picked.has(r.id)}
    {@const same = !r.label || r.label === r.id}
    <!-- 置顶的已添加段和其余行之间的分隔（真元素：行有 content-visibility，伸到行外的伪元素会被裁掉） -->
    {#if i === pinN && i > 0}<div class="sep" role="presentation"></div>{/if}
    <div class="row" class:on class:ad={r.agents.length > 0} class:na={!r.can} class:fo={kbd && focused && fi === i} class:st={stag && i < 12}
      style:--d={stag && i < 12 ? `${i * 12}ms` : undefined}
      id="hs-row-{i}" data-i={i} role="option" aria-selected={on} aria-disabled={!r.can || undefined}>
      {#if r.can}
        <span class="hs-cb" class:on aria-hidden="true">{@html CHECK}</span>
      {:else}
        <span class="cbph" aria-hidden="true"></span>
      {/if}
      <span class="vlg"><BrandLogo plain size={22} logo={r.vLogo} name={r.vName || r.id} /></span>
      <span class="tx">
        <span class="nm" class:mono={same} title={same ? r.id : r.label}>{same ? r.id : r.label}</span>
        <span class="sub">
          {#if !same}<span class="id" title={r.id}>{r.id}</span>{/if}
          {#if r.ctx}<span class="ctx" title={t('上下文')}>{r.ctx}</span>{/if}
        </span>
      </span>
      {#if !r.can}<span class="na-t" title={r.why || undefined}>{t('暂不支持')}</span>{/if}
      <span class="ags"><AgentStack agents={r.agents} size={16} /></span>
    </div>
  {/each}
  {#if busy}
    {#each { length: 6 } as _, k (k)}
      <div class="row sk" aria-hidden="true" style:--w="{[62, 48, 70, 55, 66, 44][k]}%">
        <span class="b cbk"></span><span class="b lgk"></span><span class="b txk"></span>
      </div>
    {/each}
  {/if}
</div>

{#if !rows.length && !busy}
  <div class="empty" class:narrow>
    {#if filtered}
      <span>{t('没有匹配的模型')}</span>
      <button type="button" class="tbtn" onclick={() => onclearfilters?.()}>{t('清除筛选')}</button>
    {:else}
      <span>{t('没有识别到模型')}</span>
    {/if}
  </div>
{/if}

{#if manualOk}
  <div class="man" class:narrow>
    {#if adding}
      <div class="mrow">
        <span class="mic" aria-hidden="true">{@html svg(G.plus)}</span>
        <input bind:this={minput} bind:value={mid} class="min" type="text" autocomplete="off" spellcheck="false" autocapitalize="off" enterkeyhint="done"
          placeholder={t('模型 ID')} aria-label={t('手动添加模型 ID')} aria-invalid={merr ? 'true' : undefined} onkeydown={manualKey}
          oninput={() => { merr = ''; }} disabled={mbusy} />
        <button type="button" class="tbtn" disabled={!mid.trim() || mbusy} onclick={submitManual}>
          {#if mbusy}<span class="spin" aria-hidden="true"></span>{/if}{t('添加')}
        </button>
        <button type="button" class="tbtn mute" onclick={() => { adding = false; mid = ''; merr = ''; }}>{t('取消')}</button>
      </div>
      {#if merr}<p class="merr" role="alert">{merr}</p>{/if}
    {:else}
      <button type="button" class="mbtn" onclick={() => { adding = true; }}>
        <span class="mic" aria-hidden="true">{@html svg(G.plus)}</span>{t('手动添加模型 ID')}
      </button>
    {/if}
  </div>
{/if}

<style>
  .list { outline: none; }
  .list.card { border-radius: 18px; background: var(--st-surface); overflow: hidden; }
  .row { position: relative; display: flex; align-items: center; gap: 12px; height: 48px; padding: 0 12px 0 14px; border-radius: 10px; cursor: pointer;
    content-visibility: auto; contain-intrinsic-size: auto 48px;
    scroll-margin-top: calc(var(--stickh, 0px) + 8px); scroll-margin-bottom: calc(var(--barh, 0px) + 12px);
    transition: background-color var(--mo-micro) var(--ea-fade); -webkit-tap-highlight-color: transparent; user-select: none; -webkit-user-select: none; }
  @media (hover: hover) { .row:not(.na):not(.sk):hover { background: var(--st-hover); } }
  .row.on, .row.on:hover { background: var(--st-sel); }
  /* 连着勾上的几行连成一整块（各自留着圆角的话，交界处左右会各凹进去一小块） */
  .row.on:has(+ .row.on) { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
  .row.on + .row.on { border-top-left-radius: 0; border-top-right-radius: 0; }
  .row:not(.na):not(.sk):active { background: var(--pm-press); }
  .row.on:active { background: color-mix(in srgb, var(--text) 13%, transparent); }
  .row.na { cursor: default; opacity: .45; }
  .row.fo { box-shadow: inset 0 0 0 2px var(--text); }
  .row.st { animation: hs-row-in var(--mo-quick) var(--ea-decel) both; animation-delay: var(--d, 0ms); }
  @keyframes hs-row-in { from { opacity: 0; transform: translateY(6px); } }
  /* 置顶的已添加段与其余行之间：一道细线，上下各留一点气 */
  .sep { height: 1px; margin: 6px 12px 6px 14px; background: var(--st-hair); }

  .cbph { flex: none; width: 18px; height: 18px; }
  /* 不叫 .lg：app.css 里有全局的 .lg（液态玻璃），撞名会给每行的厂商标套上玻璃边光 */
  .vlg { flex: none; display: grid; place-items: center; width: 24px; height: 24px; }
  /* 宽屏三列：名字 · ID · 上下文。名字列定宽（44%），ID 一律从同一条竖线起头——几百行看下来第二列是齐的，好比对、好复制；
     没有显示名的行（名字就是 ID）横跨前两列 */
  .tx { flex: 1; min-width: 0; display: grid; grid-template-columns: minmax(0, 44%) minmax(0, 1fr) auto; column-gap: 16px; align-items: baseline; }
  /* 字重分两级：没添加的常规（整列变轻），已添加的 600——它们是整列里唯一的重字 */
  .nm { min-width: 0; font-size: 14px; font-weight: 400; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row.ad .nm { font-weight: 600; }
  .nm.mono { grid-column: 1 / 3; font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 13px; }
  .sub { display: contents; }
  .id { min-width: 0; font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 12.5px; color: var(--st-muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ctx { grid-column: 3; justify-self: end; font-size: 12px; color: var(--st-muted); font-variant-numeric: tabular-nums; }
  .na-t { flex: none; font-size: 12px; color: var(--st-muted); white-space: nowrap; }
  /* 留足两枚叠放图标的宽度（20 + 20 − 压叠 3.2）：行尾图标多少不一，前面的上下文列照样对齐 */
  .ags { flex: none; display: flex; justify-content: flex-end; min-width: 37px; }

  /* 窄屏：卡片里的两行式，58 高，行间细线从文字起头处开始（iOS 列表的分隔） */
  .narrow .row { height: 58px; padding: 0 14px 0 16px; border-radius: 0; contain-intrinsic-size: auto 58px; }
  .narrow .row + .row::before { content: ''; position: absolute; top: 0; left: 82px; right: 0; height: 1px; background: var(--st-hair); }
  .narrow .row.on + .row::before, .narrow .row.on::before { background: transparent; }
  .narrow .sep { margin: 0; background: var(--st-line); }
  .narrow .tx { display: flex; flex-direction: column; align-items: stretch; gap: 2px; }
  .narrow .nm { font-size: 15px; }
  .narrow .nm.mono { font-size: 14px; }
  .narrow .sub { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
  .narrow .sub:empty { display: none; }
  /* ID 撑满第二行，上下文落在行尾（各行同一条右边线） */
  .narrow .id { flex: 1 1 0; font-size: 12.5px; }
  .narrow .ctx { flex: none; }

  /* 骨架：微光是伪元素的 translateX，不动 background-position（合成器上跑，几十行也不卡） */
  .row.sk { cursor: default; overflow: hidden; }
  .sk .b { display: block; flex: none; height: 12px; border-radius: 6px; background: var(--st-seg); }
  .sk .cbk { width: 18px; height: 18px; border-radius: 5px; }
  .sk .lgk { width: 22px; height: 22px; border-radius: 50%; }
  .sk .txk { flex: 0 1 var(--w); }
  .sk::after { content: ''; position: absolute; inset: 0; transform: translateX(-100%);
    background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--text) 6%, transparent), transparent);
    animation: hs-shimmer 1.4s var(--ea-std) infinite; }
  @keyframes hs-shimmer { to { transform: translateX(100%); } }

  .empty { display: flex; align-items: center; gap: 10px; min-height: 48px; padding: 0 14px; font-size: 13px; color: var(--st-muted); }
  .empty.narrow { padding: 0 16px; font-size: 14px; }

  .man { padding: 4px 0 0; }
  .mbtn { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 12px 0 10px; border: 0; border-radius: 9px; background: transparent;
    color: var(--st-muted); font: inherit; font-size: 13px; cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), color var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  @media (hover: hover) { .mbtn:hover { background: var(--st-hover); color: var(--text); } }
  .mbtn:active { transform: scale(.96); }
  .mbtn:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .mic { display: grid; place-items: center; width: 18px; height: 18px; flex: none; }
  .mic :global(svg) { width: 16px; height: 16px; }
  .mrow { display: flex; align-items: center; gap: 8px; height: 44px; padding: 0 4px 0 12px; border-radius: 10px; box-shadow: inset 0 0 0 1px var(--st-line); background: var(--st-field); }
  .mrow:focus-within { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--text) 50%, transparent); }
  .mrow .mic { color: var(--st-muted); }
  .min { flex: 1; min-width: 0; height: 100%; border: 0; background: transparent; color: var(--text); outline: none;
    font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 13px; }
  .min::placeholder { color: var(--st-muted); font-family: var(--font-brand-sans), system-ui, sans-serif; }
  .merr { margin: 6px 12px 0; font-size: 12.5px; line-height: 1.5; color: var(--pm-red); overflow-wrap: anywhere; }
  .tbtn { flex: none; display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border: 0; border-radius: 8px; background: transparent;
    color: var(--text); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), opacity var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  .tbtn.mute { color: var(--st-muted); font-weight: 400; }
  @media (hover: hover) { .tbtn:hover:not(:disabled) { background: var(--st-hover); } }
  .tbtn:active:not(:disabled) { transform: scale(.96); }
  .tbtn:disabled { opacity: .45; cursor: default; }
  .tbtn:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .narrow .mbtn { height: 44px; font-size: 14px; padding: 0 14px 0 12px; }
  .narrow .mrow { height: 50px; border-radius: 14px; background: var(--st-surface); box-shadow: none; }
  .narrow .min { font-size: 16px; }
  .narrow .tbtn { height: 44px; padding: 0 12px; font-size: 14px; }
  @media (prefers-reduced-motion: reduce) {
    .row.st { animation-name: hs-row-fade; }
    .sk::after { animation: none; }
    .mbtn:active, .tbtn:active:not(:disabled) { transform: none; }
  }
  @keyframes hs-row-fade { from { opacity: 0; } }
</style>
