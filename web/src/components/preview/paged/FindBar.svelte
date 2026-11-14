<script module>
  /**
   * 聚焦查找 / 跳行框，并在随后一小段时间里守住焦点（CodeView / TableView 的查找条也用）。
   * 触屏从 ⋯ 菜单点「查找」：MorphMenu 抬指时就执行了这一项，浏览器随后补发的兼容 mousedown 又把焦点交给正在收起的菜单项，
   * 菜单一卸载焦点掉回 body——查找框白开、软键盘收回；电脑菜单收起时把焦点还给 ⋯ 按钮也是同一类抢焦点。
   */
  export function holdFocus(el, ms = 600) {
    if (!el) return;
    const grab = () => { try { el.focus({ preventScroll: true }); } catch {} };
    grab();
    // 这一下点按补发的 mousedown：只拦它默认的「挪焦点」（落在收起中的菜单项或底下的容器上），click 照常
    const down = (e) => { const x = e.target; if (el.isConnected && x !== el && !x?.closest?.('input, textarea, select, [contenteditable]')) e.preventDefault(); };
    // 菜单收起把焦点还给菜单项 / ⋯ 按钮：拿回来
    const back = (e) => { const x = e.target; if (el.isConnected && x !== el && (x?.closest?.('[role=menu]') || x?.matches?.('[aria-haspopup="menu"]'))) grab(); };
    document.addEventListener('mousedown', down, true);
    document.addEventListener('focusin', back, true);
    setTimeout(() => { document.removeEventListener('mousedown', down, true); document.removeEventListener('focusin', back, true); }, ms);
  }
</script>

<script>
  // 查找条（PDF / 表格 / 幻灯片回落共用）：只管输入与显示，真正的查找交给调用方（PDFFindController、表格扫描…）。
  //   电脑：舞台右上角一张扁平小卡（Chrome / Acrobat 的位置），不挡顶栏；触屏：顶栏下方一整行，键盘弹起时不被盖住。
  //   输入停 140ms 才发一次 onquery（长文档每敲一个字就全文扫描太浪费）；Enter / Shift+Enter 下一个 / 上一个
  //   （还没发出去的输入先发出去，不跳）；Esc 关闭（吃掉这一下，外框不会顺手把查看器也关了）；
  //   开着时挂一层系统返回（安卓侧滑 / 返回键先收查找条，不直接关掉整个查看器）。
  //   计数：「当前 / 总数」，查找中且还没有结果显示「…」，没有命中显示「无结果」；hint 盖过计数（「可能是扫描件」这类说明）。
  // props
  //   open · query（可绑定）· current · total · pending · caseSensitive · hint · touch
  //   onquery(q) · onstep(dir: 1|-1) · oncase(on) · onclose()
  //   showCase（缺省 true）：表格等不分大小写的场景可以不出 Aa
  import { tick } from 'svelte';
  import VIcon from '../kit/VIcon.svelte';
  import { tip } from '../kit/tooltip.js';
  import { t } from '../../../lib/i18n.js';
  import { pushBackLayer } from '../../../lib/nav.js';

  let {
    open = false, query = $bindable(''), current = 0, total = 0, pending = false,
    caseSensitive = false, hint = '', touch = false, showCase = true,
    onquery, onstep, oncase, onclose,
  } = $props();

  let input = $state(null);
  let timer = 0, sent = '';

  /** 打开或再按一次 Ctrl+F：聚焦并全选 */
  export async function focus() {
    await tick();
    holdFocus(input);
    try { input?.select(); } catch {}
  }
  $effect(() => { if (open) focus(); });

  function flush() {
    clearTimeout(timer); timer = 0;
    if (query !== sent) { sent = query; onquery?.(query); return true; }
    return false;
  }
  function onInput() {
    clearTimeout(timer);
    timer = setTimeout(flush, 140);
  }
  function step(dir) {
    if (flush()) return;   // 刚输入的先查出来（查出来就定位到第一个），不连跳两下
    if (query) onstep?.(dir);
  }
  function onKey(e) {
    if (e.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'F3' || ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G'))) { e.preventDefault(); step(e.shiftKey ? -1 : 1); }
  }
  function close() { clearTimeout(timer); timer = 0; sent = ''; onclose?.(); }
  $effect(() => () => clearTimeout(timer));
  $effect(() => { if (open) return pushBackLayer(close); });
  // 外部清空查询（换文档）时同步
  $effect(() => { if (!open) sent = ''; });

  const count = $derived(
    hint ? hint
      : !query ? ''
      : pending && !total ? '…'
      : total ? `${Math.max(1, current).toLocaleString()}/${total.toLocaleString()}`
      : t('无结果'),
  );
  const none = $derived(!!query && !pending && !total && !hint);
</script>

{#if open}
  <div class="fb" class:touch class:fine={!touch} role="search" aria-label={t('在文档中查找')}>
    <div class="fb-field" class:none>
      {#if !touch}<VIcon name="search" size={16} class="fb-ic" />{/if}
      <!-- 不用 type=search：Chrome 会多画一个清除钮、Esc 先清空不关闭 -->
      <input bind:this={input} bind:value={query} type="text" class="fb-in" placeholder={t('查找')} spellcheck="false" autocomplete="off"
        enterkeyhint="search" aria-label={t('查找')} oninput={onInput} onkeydown={onKey} />
      <span class="fb-count" class:hint={!!hint} aria-live="polite">{count}</span>
    </div>
    {#if showCase}
      <button type="button" class="vw-btn fb-case" class:on={caseSensitive} aria-pressed={caseSensitive}
        onclick={() => oncase?.(!caseSensitive)} use:tip={t('区分大小写')}><span class="fb-aa">Aa</span></button>
    {/if}
    {#if !touch}<span class="fb-sep" aria-hidden="true"></span>{/if}
    <button type="button" class="vw-btn" disabled={!query || (!total && !pending)} onclick={() => step(-1)} use:tip={{ label: t('上一个'), kbd: 'Shift+Enter' }}><VIcon name="up" /></button>
    <button type="button" class="vw-btn" disabled={!query || (!total && !pending)} onclick={() => step(1)} use:tip={{ label: t('下一个'), kbd: 'Enter' }}><VIcon name="down" /></button>
    <button type="button" class="vw-btn" onclick={close} use:tip={{ label: t('关闭查找'), kbd: 'Esc' }}><VIcon name="close" /></button>
  </div>
{/if}

<style>
  .fb { display: flex; align-items: center; gap: 2px; box-sizing: border-box; color: var(--vw-fg, var(--md-fg)); }
  /* 电脑：右上角扁平卡（浮在页面上，不推开内容） */
  .fb.fine {
    position: absolute; z-index: 6; top: 10px; right: 16px; height: 40px; padding: 4px; border-radius: 10px;
    background: var(--vw-float-bg, var(--md-panel)); box-shadow: 0 0 0 1px var(--vw-line), 0 6px 20px rgba(0, 0, 0, .18);
    animation: fb-in var(--mo-quick) var(--ea-decel) both;
  }
  @keyframes fb-in { from { opacity: 0; transform: translateY(-4px); } }
  /* 触屏：顶栏下面一整行（在文档流里，键盘弹起时随视口一起上移） */
  .fb.touch {
    flex: none; width: 100%; height: 52px; padding: 0 6px 0 10px; gap: 4px;
    background: var(--md-bg); box-shadow: inset 0 -.5px 0 rgba(var(--md-ink), .12);
    animation: fb-fade var(--mo-quick) var(--ea-fade) both;
  }
  @keyframes fb-fade { from { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .fb.fine, .fb.touch { animation: none; } }

  .fb-field { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; height: 32px; padding: 0 10px; border-radius: 8px;
    background: rgba(var(--md-ink), .06); }
  .fine .fb-field { flex: none; width: 236px; padding: 0 8px; }
  .fb-field:focus-within { background: var(--md-field); box-shadow: 0 0 0 1px rgba(var(--md-ink), .22); }
  /* 触屏：整个输入区 44 高（命中区够），看得见的胶囊 38 高画在 ::before 上、垫在文字下面 */
  .touch .fb-field { position: relative; isolation: isolate; height: 44px; background: none; }
  .touch .fb-field::before { content: ''; position: absolute; z-index: -1; inset: 3px 0; border-radius: 10px;
    background: rgba(var(--md-ink), .06); pointer-events: none; }
  .touch .fb-field:focus-within { background: none; box-shadow: none; }
  .touch .fb-field:focus-within::before { background: var(--md-field); box-shadow: 0 0 0 1px rgba(var(--md-ink), .22); }
  .fb-field :global(.fb-ic) { color: var(--vw-fg-3); }
  .fb-in { flex: 1; min-width: 0; height: 100%; border: 0; outline: none; background: none; padding: 0; margin: 0;
    font: inherit; font-size: 14px; color: var(--md-fg); caret-color: var(--md-accent); }
  /* 触屏 16px：小于 16 时部分浏览器聚焦会自动放大页面 */
  .touch .fb-in { font-size: 16px; }
  .fb-in::placeholder { color: var(--md-fg-4); }
  .fb-count { flex: none; font-size: 12.5px; color: var(--vw-fg-3); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .fb-count.hint { max-width: 160px; overflow: hidden; text-overflow: ellipsis; }
  .touch .fb-count.hint { max-width: 120px; }
  .fb-field.none .fb-count { color: var(--md-danger); }
  .fb-sep { width: 1px; height: 18px; margin: 0 3px; background: var(--vw-line); flex: none; }
  .fb-aa { font-size: 13px; font-weight: 600; letter-spacing: -.2px; }
  .touch .fb-aa { font-size: 14px; }
</style>
