<script>
  // 应用内对话框宿主：把 lib/dialogState.svelte.js 的队列画出来（uiAlert / uiConfirm 的界面层）。
  //
  // 两种外观，按输入方式分（与 PermissionCard / PlanCard 判触屏的口径一致）：
  //   鼠标 / 触控板 → 墨与象牙扁平卡片：宽 320–400、圆角 16、实心墨色确认钮，危险操作实心红；
  //   触屏（pointer: coarse）→ iOS 27 玻璃警告框（ios27/Alert，与设置页同一个组件，手机上不突兀）。
  // 一次只画一条（FIFO）；上一条退场动画和下一条入场同时进行，叠在同一格里交叉淡化。
  //
  // 挂载：dialogs.js 第一次调用时 mount 到 document.body；App 也可以显式挂一份。
  // 同一时刻只认第一个实例（host.owner），后来的实例什么都不画——防两层遮罩叠在一起。
  //
  // 层级 z-index 3500：压过设置 60、模型中心 200、扫码 400、切服 450、菜单 1000、DSelect 3000；
  // 低于拖拽层 / 桌面提示 4000 与 NoticeBanner 4100（那几个本来就该在一切之上）。
  import { onDestroy, setContext, untrack } from 'svelte';
  import Alert from './ios27/Alert.svelte';
  import './ios27/ink.css';
  import {
    dlg, host, hooks, settle, activeRequest, defaultRole, escRole, cycleIndex,
    eventTime, pressTooSoon, strayClick, msgLayout,
  } from '../lib/dialogState.svelte.js';
  import { pushBackLayer } from '../lib/nav.js';
  import { pushNativeOverlay } from '../lib/nativeDesktop.js';
  import { pressable } from '../lib/motion.js';
  import { t } from '../lib/i18n.js';

  // —— 认领：只有第一个实例干活 ——
  const me = {};
  const owner = !host.owner;
  if (owner) {
    host.owner = me;
    host.ready = true;
    hooks.key = onKey;
  }
  onDestroy(() => {
    if (host.owner !== me) return;
    host.owner = null;
    host.ready = false;
    hooks.key = null;
  });

  const uid = $props.id();

  // —— 环境：触屏与否、明暗 ——
  // 明暗读 <html data-theme>（state.svelte.js 与 SharePage 都写它），不读 ui.theme：
  // SharePage / QuickAsk 这类入口没有完整的 ui 状态，属性是唯一一致的真相源。
  const mqCoarse = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
  let coarse = $state(!!mqCoarse?.matches);
  const readDark = () => typeof document === 'undefined' || document.documentElement.dataset.theme !== 'light';
  let dark = $state(readDark());
  $effect(() => {
    const onMq = () => { coarse = !!mqCoarse?.matches; };
    mqCoarse?.addEventListener?.('change', onMq);
    let mo = null;
    try {
      mo = new MutationObserver(() => { dark = readDark(); });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    } catch {}
    return () => { mqCoarse?.removeEventListener?.('change', onMq); mo?.disconnect(); };
  });
  // ios27 控件读这个上下文决定明暗（先例 Settings.svelte:119）
  setContext('ios27', { get dark() { return dark; }, ink: true });

  // —— 当前请求与要画的卡片 ——
  const cur = $derived(owner ? activeRequest(dlg.queue) : null);
  // 正在显示的那条 + 还在退场的；排在后面的等轮到再画
  const shown = $derived(owner ? dlg.queue.filter((r) => r.closing || r === cur) : []);
  const open = $derived(owner && dlg.queue.length > 0);
  const isDanger = (r) => r.kind === 'confirm' && r.danger;

  let rootEl = $state(null);

  // —— 按钮查找：按视觉顺序 [取消, 确认]（两种外观都是取消在左） ——
  const ORDER = ['cancel', 'ok'];
  function buttons() {
    if (!rootEl || !cur) return [];
    const card = rootEl.querySelector(`[data-dlg-id="${cur.id}"]`);
    if (!card) return [];
    const out = [];
    for (const role of ORDER) {
      const b = card.querySelector(`[data-act="${role}"]`);
      if (b) out.push(b);
    }
    return out;
  }
  function focusRole(role) {
    const list = buttons();
    const b = list.find((x) => x.dataset.act === role) || list[list.length - 1];
    try { b?.focus({ preventScroll: true }); } catch {}
    return !!b;
  }
  function focusedRole() {
    const a = typeof document !== 'undefined' ? document.activeElement : null;
    const b = a?.closest?.('[data-act]');
    return b && buttons().includes(b) ? b.dataset.act : null;
  }

  // 每换一条：默认焦点给它（危险确认给「取消」），清掉上一条的按下记录，记下出现时刻（防误触的时间窗从这里起算）
  $effect(() => {
    const r = cur;
    void coarse;   // 外观切换后按钮换了一批，焦点要重新落
    if (!r) return;
    untrack(() => {
      downIn = false; downScrim = false; swallow = false;
      shownAt = performance.now();
      // 玻璃框的按钮由子组件渲染，个别情况下同一帧还没进 DOM：找不到就下一帧再试一次
      if (!focusRole(defaultRole(r))) requestAnimationFrame(() => { if (cur === r) focusRole(defaultRole(r)); });
    });
  });

  // 系统返回（安卓侧滑 / 返回键）= 取消；弹窗最后压栈，天然排在模型中心、设置之前被关
  $effect(() => {
    const r = cur;
    if (!r) return;
    const id = r.id, role = escRole(r);
    return pushBackLayer(() => { settle(id, role); });
  });

  // 桌面壳的内嵌原生浏览器视图盖在网页之上，弹窗开着时让它让位（整串弹窗只让一次，免得逐条闪）
  $effect(() => { if (open) return pushNativeOverlay(); });

  // 这串弹窗里用过 Tab / 方向键：触屏玻璃外观也画焦点圈（平时程序落的默认焦点在触屏上不画，见样式）
  let kbd = $state(false);
  $effect(() => { if (!open) kbd = false; });

  // 焦点圈在框里：点到框外（理论上被遮罩挡住）或程序把焦点挪走时拉回默认按钮
  $effect(() => {
    if (!open) return;
    const onIn = (e) => {
      if (!cur || !rootEl) return;
      if (e.target instanceof Node && rootEl.contains(e.target)) return;
      focusRole(defaultRole(cur));
    };
    document.addEventListener('focusin', onIn, true);
    return () => document.removeEventListener('focusin', onIn, true);
  });

  // —— 键盘（由 dialogs.js 的全局捕获监听转进来，已挡住底下的快捷键）——
  function onKey(e) {
    const r = cur;
    if (!r) return;
    const k = e.key;
    if (k === 'Escape') {
      e.preventDefault();
      if (!e.repeat) settle(r.id, escRole(r));
      return;
    }
    if (k === 'Enter') {
      e.preventDefault();   // 不让按钮再触发一次原生 click
      // 按住的回车（打开弹窗的那一下还没松手）不算确认；输入法组字中的回车也不算
      if (e.repeat || e.isComposing) return;
      settle(r.id, focusedRole() || defaultRole(r));
      return;
    }
    if (k === 'Tab' || k === 'ArrowLeft' || k === 'ArrowRight') {
      e.preventDefault();
      kbd = true;
      const list = buttons();
      if (!list.length) return;
      const dir = k === 'ArrowLeft' || (k === 'Tab' && e.shiftKey) ? -1 : 1;
      const at = list.indexOf(document.activeElement?.closest?.('[data-act]'));
      try { list[cycleIndex(list.length, at, dir)]?.focus({ preventScroll: true }); } catch {}
      return;
    }
    // 焦点一直在按钮上，长文案靠上下键 / 翻页键滚文字区（否则键盘用户看不到被截在框外的部分）
    if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'PageDown' || k === 'PageUp') {
      const box = rootEl?.querySelector(`[data-dlg-id="${r.id}"] .dh-body, [data-dlg-id="${r.id}"] .al-tm`);
      if (!box || box.scrollHeight <= box.clientHeight) return;
      e.preventDefault();
      const page = Math.max(40, box.clientHeight - 40);
      const dy = k === 'ArrowDown' ? 40 : k === 'ArrowUp' ? -40 : k === 'PageDown' ? page : -page;
      box.scrollBy({ top: dy });
    }
    // 空格：按钮的原生行为（松开时 click），不拦
  }

  // —— 指针：只认「按下也发生在弹窗出现之后」的点击 ——
  // 触屏上「打开弹窗的那一下」随后补发的兼容 click 会落在新画出来的遮罩 / 按钮上，
  // 不防的话弹窗一出现就被关掉或被替用户点了（与 ios27/Alert 同一个坑）。键盘触发的 click detail=0，照常放行。
  //
  // 再加两道（dialogState 的 SHOW_GUARD_MS / strayClick）：双击一个会弹确认框的按钮时，第二下的按下发生在
  // 弹窗出现之后，上面那道防不住——确认框当场按取消返回、提示框一闪就没；连点「确定」还会穿到排队的下一条。
  //   ① 出现后的时间窗：窗内的按下在根节点捕获阶段就截住（stopPropagation：ios27/Alert 自己的按下记录、
  //      按钮的按压动效都收不到，玻璃外观的按钮一并挡住），随后的 mousedown / click 一起吞掉；
  //   ② 连击：click 的 detail > 1 一律吞掉，挡住比时间窗更慢的双击。
  // 两道都在根节点的捕获阶段做，扁平卡片、遮罩、玻璃框不用各自再判。
  let downIn = false, downScrim = false;
  let shownAt = -Infinity;   // 当前这条画出来的时刻（performance.now 口径）
  let swallow = false;       // 最近一次按下落在时间窗里
  function onRootDown(e) {
    if (pressTooSoon(eventTime(e, performance.now()), shownAt)) {
      downScrim = false; downIn = false; swallow = true;
      e.stopPropagation();
      return;
    }
    swallow = false;
    const el = e.target instanceof Element ? e.target : null;
    downScrim = !!el?.classList.contains('dh-scrim');
    downIn = !!(cur && el?.closest(`[data-dlg-id="${cur.id}"]`));
  }
  // 被挡掉的那一下：兼容 mousedown 的默认行为会把焦点挪到按下的按钮上——危险确认的默认焦点本在「取消」，
  // 双击恰好落在「删除」上时焦点被挪过去，用户再按回车就成了确认。连焦点一起挡住。
  function onRootMouseDown(e) {
    if (!swallow) return;
    e.preventDefault();
    e.stopPropagation();
  }
  function onRootClick(e) {
    if (!strayClick(e.detail, swallow)) return;
    e.preventDefault();
    e.stopPropagation();   // 委托在 body 上的 onclick（act / scrimClick / Alert 的按钮）都收不到
  }
  function scrimClick() {
    const ok = downScrim;
    downScrim = false;
    if (ok && cur) settle(cur.id, escRole(cur));
  }
  function act(e, r, role) {
    if (e.detail > 0 && !downIn) return;
    settle(r.id, role);
  }

  // 玻璃外观的按钮：[主操作, 取消]（Alert 并排时 row-reverse，取消在左）
  function glassActions(r) {
    const ok = { label: r.okLabel, role: isDanger(r) ? 'destructive' : 'default', act: 'ok', onclick: () => settle(r.id, 'ok') };
    if (r.kind !== 'confirm') return [ok];
    return [ok, { label: r.cancelLabel, role: 'cancel', act: 'cancel', onclick: () => settle(r.id, 'cancel') }];
  }
  const countText = (r) => (r.count > 1 ? ` ×${r.count}` : '');
  // 玻璃框的文字：有小标题时它是粗体标题、正文整段常规字；没有时粗体标题 = 拆出来的问句，正文 = 拆下来的说明
  function glassText(r, L) {
    if (r.title) return { title: r.title, message: r.message + countText(r) };
    return { title: L.lead + countText(r), message: L.rest };
  }
  // 扁平卡片的读屏描述：有小标题时它是名字，问句本身也要读出来；再加上说明
  function describedBy(r, L, sub) {
    const ids = [];
    if (r.title && (L.lead || r.count > 1)) ids.push(`${uid}-m${r.id}`);
    if (sub) ids.push(`${uid}-d${r.id}`);
    return ids.length ? ids.join(' ') : undefined;
  }
</script>

{#if open}
  <!-- 三个捕获监听都是指针防误触（见脚本「指针」一节）；键盘走 dialogs.js 的全局监听 -->
  <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
  <div
    class="dh-root i27ink"
    class:dark
    class:glass={coarse}
    class:idle={!cur}
    class:kbd
    data-dialog-host
    role="presentation"
    bind:this={rootEl}
    onpointerdowncapture={onRootDown}
    onmousedowncapture={onRootMouseDown}
    onclickcapture={onRootClick}
  >
    <!-- 键盘走 dialogs.js 的全局监听（Esc = 点遮罩），这里只接指针 -->
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="dh-scrim ov-scrim" class:closing={!cur} onclick={scrimClick}></div>

    {#each shown as r (r.id)}
      {@const L = msgLayout(r.message, r.detail)}
      {@const sub = L.rest || r.detail}
      {#if coarse}
        {@const g = glassText(r, L)}
        <div class="dh-glass" class:long={!r.title && L.long} data-dlg-id={r.id} inert={r.closing}>
          <Alert
            dim={false}
            closing={r.closing}
            title={g.title}
            message={g.message}
            detail={r.detail}
            actions={glassActions(r)}
          />
        </div>
      {:else}
        <div
          class="dh-card ov-panel"
          class:closing={r.closing}
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={r.title ? `${uid}-t${r.id}` : `${uid}-m${r.id}`}
          aria-describedby={describedBy(r, L, sub)}
          data-dlg-id={r.id}
          inert={r.closing}
        >
          <div class="dh-body">
            {#if r.title}<div class="dh-title" id="{uid}-t{r.id}">{r.title}</div>{/if}
            {#if L.lead || r.count > 1}
              <p class="dh-msg" class:long={L.long} id="{uid}-m{r.id}">{L.lead}{#if r.count > 1}<span class="dh-count" aria-label={t('重复 {n} 次', { n: r.count })}>×{r.count}</span>{/if}</p>
            {/if}
            <!-- 调用方给的 detail，或从一整段 message 里拆下来的说明（两者不会同时有） -->
            {#if sub}<p class="dh-detail sel-text" id="{uid}-d{r.id}">{sub}</p>{/if}
          </div>
          <div class="dh-acts">
            {#if r.kind === 'confirm'}
              <button type="button" class="dh-btn" data-act="cancel" use:pressable onclick={(e) => act(e, r, 'cancel')}>{r.cancelLabel}</button>
            {/if}
            <button
              type="button"
              class="dh-btn primary"
              class:danger={isDanger(r)}
              data-act="ok"
              use:pressable
              onclick={(e) => act(e, r, 'ok')}
            >{r.okLabel}</button>
          </div>
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  /* 「墨与象牙」令牌（契约 §8）：本组件常挂在 document.body 上、不在任何设置外壳里，令牌自己带齐。
     暗色是默认，亮色由 <html data-theme="light"> 决定（脚本侧换 class，见 dark）。 */
  .dh-root {
    --pm-bg: #f2f0eb; --st-surface: #fcfbf8; --text: #1d1b18;
    --st-text2: rgba(29, 27, 24, .72); --st-muted: rgba(29, 27, 24, .5);
    --st-line: rgba(29, 27, 24, .1); --st-hair: rgba(29, 27, 24, .075);
    --st-sel: rgba(29, 27, 24, .08); --st-hover: rgba(29, 27, 24, .04); --pm-press: rgba(29, 27, 24, .055);
    --st-field: rgba(29, 27, 24, .045); --st-seg: rgba(29, 27, 24, .06);
    --st-accent: #1d1b18; --st-primary: #1d1b18; --st-primary-ink: #f6f3ec;
    --pm-warn: #b0741c; --pm-red: #c4473b;
    --dh-shadow: 0 24px 70px rgba(24, 21, 17, .2), 0 2px 8px rgba(24, 21, 17, .08);

    position: fixed; inset: 0; z-index: 3500;
    display: grid; grid-template: minmax(0, 1fr) / minmax(0, 1fr); place-items: center;
    padding: calc(var(--sat, 0px) + 24px) 24px calc(var(--sab, 0px) + 24px);
    font-family: var(--sans, system-ui, sans-serif); color: var(--text);
    -webkit-tap-highlight-color: transparent;
  }
  .dh-root.dark {
    --pm-bg: #100f0d; --st-surface: #1a1917; --text: #f1ece2;
    --st-text2: rgba(241, 236, 226, .74); --st-muted: rgba(241, 236, 226, .5);
    --st-line: rgba(241, 236, 226, .1); --st-hair: rgba(241, 236, 226, .065);
    --st-sel: rgba(241, 236, 226, .1); --st-hover: rgba(241, 236, 226, .05); --pm-press: rgba(241, 236, 226, .06);
    --st-field: rgba(241, 236, 226, .06); --st-seg: rgba(241, 236, 226, .07);
    --st-accent: #ebe5d8; --st-primary: #ebe5d8; --st-primary-ink: #151412;
    --pm-warn: #d9a441; --pm-red: #e2725f;
    --dh-shadow: 0 24px 70px rgba(0, 0, 0, .45), 0 2px 8px rgba(0, 0, 0, .25);
  }
  /* 最后一条在退场：遮罩也在淡出，别再拦住用户点底下的界面 */
  .dh-root.idle { pointer-events: none; }

  /* 遮罩不加 blur：同屏只留一层 backdrop-filter（玻璃框自己有一层） */
  .dh-scrim { position: absolute; inset: 0; background: rgba(0, 0, 0, .42); touch-action: none; }
  .dh-root.glass .dh-scrim { background: var(--i-dim); }

  /* —— 扁平卡片 —— */
  .dh-card {
    grid-area: 1 / 1; position: relative;
    display: flex; flex-direction: column;
    width: fit-content; min-width: min(320px, 100%); max-width: min(400px, 100%);
    max-height: min(70vh, 100%);
    box-sizing: border-box;
    background: var(--st-surface); border: 1px solid var(--st-line); border-radius: 16px;
    box-shadow: var(--dh-shadow);
  }
  .dh-card.closing { pointer-events: none; }
  .dh-body {
    min-height: 0; overflow-y: auto; overscroll-behavior: contain;
    padding: 20px 22px 4px;
    display: flex; flex-direction: column; gap: 6px;
  }
  .dh-title { font-size: 12.5px; line-height: 18px; font-weight: 500; color: var(--st-muted); }
  /* 问句：短句均衡断行（不留「会一 / 并移除」这种孤字尾巴）；拆不开的长句降到中等字重、按正文断行 */
  .dh-msg {
    margin: 0; font-size: 15px; line-height: 22px; font-weight: 600; color: var(--text);
    white-space: pre-line; overflow-wrap: anywhere; text-wrap: balance;
  }
  .dh-msg.long { font-weight: 500; text-wrap: pretty; }
  .dh-count {
    display: inline-block; margin-left: 8px; padding: 0 7px; border-radius: 999px; vertical-align: 1px;
    font-size: 12px; line-height: 18px; font-weight: 500; font-variant-numeric: tabular-nums;
    color: var(--st-text2); background: var(--st-seg);
  }
  .dh-detail {
    margin: 0; font-size: 13px; line-height: 19px; color: var(--st-text2);
    white-space: pre-line; overflow-wrap: anywhere; text-wrap: pretty;
  }
  .dh-acts { flex-shrink: 0; display: flex; justify-content: flex-end; gap: 8px; padding: 18px 22px 20px; }
  .dh-btn {
    min-width: 76px; height: 34px; padding: 0 16px; border: 0; border-radius: 10px; cursor: pointer;
    font: inherit; font-size: 14px; line-height: 20px; font-weight: 500; white-space: nowrap;
    color: var(--text); background: var(--st-seg);
    transform: scale(var(--press-s, 1));
    transition: background-color var(--mo-micro) var(--ea-fade), opacity var(--mo-micro) var(--ea-fade);
  }
  .dh-btn:hover { background: var(--st-sel); }
  .dh-btn.primary { color: var(--st-primary-ink); background: var(--st-primary); }
  .dh-btn.primary.danger { color: #fff; background: var(--pm-red, #c4473b); }
  .dh-btn.primary:hover { opacity: .9; }
  /* 全局 :focus-visible 是珊瑚色，弹窗里换成墨色（契约：墨是唯一强调色） */
  .dh-btn:focus-visible { outline: 2px solid color-mix(in srgb, var(--text) 55%, transparent); outline-offset: 2px; }

  /* 窄窗口（鼠标但窗口窄，或平板横竖屏切换）：按钮铺满、加高到可点区 44 */
  @media (max-width: 699px) {
    .dh-card { width: 100%; }
    .dh-body { padding: 20px 20px 4px; }
    .dh-acts { padding: 16px 20px 20px; }
    .dh-btn { flex: 1 1 0; min-width: 0; height: 44px; border-radius: 12px; font-size: 15px; }
  }

  /* —— 玻璃外观：Alert 自带 fixed 根与动画，这一层只是给查找按钮用的容器 —— */
  .dh-glass { display: contents; }
  /* 断行同扁平卡片：粗体标题均衡、正文与说明避免孤字尾行；拆不开的长句标题降到中等字重 */
  .dh-glass :global(.al-tm h3) { text-wrap: balance; }
  .dh-glass :global(.al-tm p) { text-wrap: pretty; }
  .dh-glass.long :global(.al-tm h3) { font-weight: 500; text-wrap: pretty; }
  /* 焦点圈：触屏（hover: none）上程序落的默认焦点也会命中 :focus-visible，画一圈像「被选中」的主按钮——
     只在有悬停的设备（手机接鼠标、平板接触控板）上画，或者这串弹窗里按过 Tab / 方向键之后（平板只接了键盘）。
     颜色换成墨色，不用全局的珊瑚色。 */
  .dh-glass :global(.al-btn:focus-visible) { outline: none; }
  .dh-root.kbd .dh-glass :global(.al-btn:focus-visible) { outline: 2px solid color-mix(in srgb, var(--i-label) 55%, transparent); outline-offset: 2px; }
  @media (hover: hover) {
    .dh-glass :global(.al-btn:focus-visible) { outline: 2px solid color-mix(in srgb, var(--i-label) 55%, transparent); outline-offset: 2px; }
  }
</style>
