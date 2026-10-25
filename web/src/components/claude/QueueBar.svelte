<script>
  // 排队消息栏（官方 Code 页 EpitaxySessionScopeBody.QueuedMessageBar，Desktop 2.37337 逆向）：
  // 输入框正上方。只有 1 条 = 单行（预览 + 立即发送 / 放回输入框 / 移出 三个图标钮）；
  // 多条 = 折叠成「N 条排队消息 · 下一条：…」，点开是列表：每行两行截断，悬停露出拖动手柄和 ⋮ 菜单
  // （右键整行同一菜单：放回输入框编辑 / 立即发送 / 移出队列），底部「全部清除」。
  // 数据由服务端持有（claude-queue.mjs），这里只镜像 + 调操作口。
  import { session } from '../../lib/state.svelte.js';
  import { queuedItems, queueState, removeQueued, moveQueued, clearQueued, promoteQueued, editQueued } from '../../lib/chat.svelte.js';
  import { t } from '../../lib/i18n.js';

  const items = $derived(queuedItems(session.id));
  let open = $state(false);
  let menu = $state(null);           // { id, x, y }
  let busyId = $state('');           // 正在处理的那一条（发送中 / 移除中）
  let drag = $state(null);           // { id, from, to, startY, rowH }
  let listEl = $state(null);

  $effect(() => { if (items.length < 2) open = false; });
  $effect(() => {
    if (!queueState.error) return;
    const tm = setTimeout(() => (queueState.error = ''), 4500);
    return () => clearTimeout(tm);
  });

  const preview = (it) => {
    const txt = (it.text || '').replace(/\s+/g, ' ').trim();
    const files = (it.files || []).map((f) => '@' + f).join(' ');
    return [txt, files].filter(Boolean).join(' ') || t('（空消息）');
  };

  async function act(kind, it) {
    menu = null;
    if (!it || busyId) return;
    busyId = it.id;
    try {
      if (kind === 'send') await promoteQueued(it.id);
      else if (kind === 'remove') await removeQueued(it.id);
      else if (kind === 'edit') await editQueued(it.id);
    } finally { busyId = ''; }
  }

  function openMenu(e, it) {
    e.preventDefault(); e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const ctx = e.type === 'contextmenu';
    const x = Math.min((ctx ? e.clientX : r.right) , window.innerWidth - 8);
    const y = ctx ? e.clientY : r.bottom + 4;
    menu = menu && menu.id === it.id && !ctx ? null : { id: it.id, x, y };
  }
  const menuItem = () => items.find((x) => x.id === (menu && menu.id)) || null;

  // —— 拖动排序：只认手柄，纵向移动超过 5px 才算开始（官方 PointerSensor 同阈值）——
  function dragDown(e, it, i) {
    if (e.button !== undefined && e.button !== 0) return;
    const row = e.currentTarget.closest('.qb-row');
    if (!row) return;
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch {}
    drag = { id: it.id, from: i, to: i, startY: e.clientY, rowH: row.getBoundingClientRect().height || 36, active: false };
  }
  function dragMove(e) {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    if (!drag.active && Math.abs(dy) < 5) return;
    drag.active = true;
    drag.to = Math.max(0, Math.min(items.length - 1, drag.from + Math.round(dy / drag.rowH)));
  }
  async function dragUp() {
    if (!drag) return;
    const d = drag; drag = null;
    if (d.active && d.to !== d.from) await moveQueued(d.id, d.to);
  }
  // 拖动中的预览顺序
  const shown = $derived.by(() => {
    if (!drag || !drag.active || drag.to === drag.from) return items;
    const arr = items.slice();
    const [x] = arr.splice(drag.from, 1);
    arr.splice(drag.to, 0, x);
    return arr;
  });

  $effect(() => {
    if (!menu) return;
    const close = (e) => { if (!e.target.closest || !e.target.closest('.qb-menu')) menu = null; };
    const esc = (e) => { if (e.key === 'Escape') menu = null; };
    window.addEventListener('pointerdown', close, true);
    window.addEventListener('keydown', esc);
    return () => { window.removeEventListener('pointerdown', close, true); window.removeEventListener('keydown', esc); };
  });
</script>

{#snippet icoSend()}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 10 4 15l5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg>{/snippet}
{#snippet icoEdit()}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>{/snippet}
{#snippet icoX()}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>{/snippet}
{#snippet caret(up)}<svg class="qb-caret" class:up viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>{/snippet}

{#if items.length || queueState.error}
  <div class="qb">
    {#if items.length === 1}
      {@const it = items[0]}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div class="qb-one" oncontextmenu={(e) => openMenu(e, it)}>
        <span class="qb-count">{t('1 条排队消息')}</span>
        <span class="qb-prev">{busyId === it.id ? t('处理中…') : preview(it)}</span>
        <button class="qb-ib" title={t('立即发送')} aria-label={t('立即发送')} disabled={!!busyId} onclick={() => act('send', it)}>{@render icoSend()}</button>
        <button class="qb-ib" title={t('放回输入框编辑')} aria-label={t('放回输入框编辑')} disabled={!!busyId} onclick={() => act('edit', it)}>{@render icoEdit()}</button>
        <button class="qb-ib" title={t('移出队列')} aria-label={t('移出队列')} disabled={!!busyId} onclick={() => act('remove', it)}>{@render icoX()}</button>
      </div>
    {:else if items.length > 1 && !open}
      <button class="qb-collapsed" onclick={() => (open = true)}>
        <span class="qb-count">{t('{n} 条排队消息', { n: items.length })}</span>
        <span class="qb-prev">{t('下一条：{text}', { text: preview(items[0]) })}</span>
        {@render caret(false)}
      </button>
    {:else if items.length > 1}
      <div class="qb-card">
        <button class="qb-head" aria-label={t('收起排队消息')} onclick={() => (open = false)}>
          <span class="qb-count">{t('{n} 条排队消息', { n: items.length })}</span>
          {@render caret(true)}
        </button>
        <div class="qb-list" bind:this={listEl}>
          {#each shown as it, i (it.id)}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <div class="qb-row" class:dragging={drag && drag.active && drag.id === it.id} class:menuon={menu && menu.id === it.id} oncontextmenu={(e) => openMenu(e, it)}>
              <span class="qb-rtext">{busyId === it.id ? t('处理中…') : preview(it)}</span>
              <span class="qb-racts">
                <button class="qb-ib qb-grip" title={t('拖动排序')} aria-label={t('拖动排序')}
                  onpointerdown={(e) => dragDown(e, it, items.indexOf(it))} onpointermove={dragMove} onpointerup={dragUp} onpointercancel={dragUp}>
                  <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.5"/><circle cx="15" cy="6" r="1.5"/><circle cx="9" cy="12" r="1.5"/><circle cx="15" cy="12" r="1.5"/><circle cx="9" cy="18" r="1.5"/><circle cx="15" cy="18" r="1.5"/></svg>
                </button>
                <button class="qb-ib" title={t('排队消息操作')} aria-label={t('排队消息操作')} onclick={(e) => openMenu(e, it)}>
                  <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5.5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="18.5" r="1.6"/></svg>
                </button>
              </span>
            </div>
          {/each}
        </div>
        <div class="qb-foot"><button class="qb-clear" onclick={() => clearQueued()}>{t('全部清除')}</button></div>
      </div>
    {/if}
    {#if queueState.error}<div class="qb-err">{queueState.error}</div>{/if}
  </div>
{/if}

{#if menu && menuItem()}
  {@const it = menuItem()}
  <div class="qb-menu" role="menu" style="left:{Math.max(8, menu.x - 188)}px;top:{menu.y}px">
    <button role="menuitem" onclick={() => act('edit', it)}>{t('放回输入框编辑')}</button>
    <button role="menuitem" onclick={() => act('send', it)}>{t('立即发送')}</button>
    <div class="qb-sep"></div>
    <button role="menuitem" class="danger" onclick={() => act('remove', it)}>{t('移出队列')}</button>
  </div>
{/if}

<style>
  /* 官方 token：底色 alpha-1（正文色 5%）/ 悬停 alpha-2（10%）、圆角 10px、行高 40px；
     出现 .12s cubic-bezier(.165,.84,.44,1) 从下方 6px 淡入（@starting-style）。 */
  .qb { --qb-a1: color-mix(in srgb, var(--text) 5%, transparent); --qb-a2: color-mix(in srgb, var(--text) 10%, transparent);
    --qb-danger: #ff5c72; display: flex; flex-direction: column; gap: 6px; margin: 0 0 8px; font-size: 13.5px; }
  :global(html[data-theme="light"]) .qb, :global(html[data-theme="light"]) .qb-menu { --qb-danger: #cd2054; }
  .qb-one, .qb-collapsed, .qb-card { transition: opacity .12s cubic-bezier(.165,.84,.44,1), translate .12s cubic-bezier(.165,.84,.44,1); }
  @starting-style { .qb-one, .qb-collapsed, .qb-card { opacity: 0; translate: 0 6px; } }
  .qb-one { display: flex; align-items: center; gap: 5px; min-height: 40px; padding: 6px 8px 6px 12px; border-radius: 10px; background: var(--qb-a1); }
  .qb-count { flex: none; font-weight: 500; color: var(--text); }
  .qb-prev { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--muted); padding-left: 4px; }
  .qb-ib { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 7px; color: var(--muted); }
  .qb-ib svg { width: 15px; height: 15px; }
  .qb-ib:hover:not(:disabled) { background: var(--qb-a2); color: var(--text); }
  .qb-ib:disabled { opacity: .45; }
  .qb-collapsed { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 40px; padding: 0 12px; border-radius: 10px; background: var(--qb-a1); text-align: left; }
  .qb-collapsed:hover { background: var(--qb-a2); }
  .qb-caret { flex: none; width: 15px; height: 15px; color: var(--muted); transition: transform .15s; }
  .qb-caret.up { transform: rotate(180deg); }
  .qb-card { display: flex; flex-direction: column; border-radius: 10px; background: var(--qb-a1); overflow: clip; }
  .qb-head { display: flex; align-items: center; justify-content: space-between; min-height: 38px; padding: 0 12px; text-align: left; }
  .qb-list { max-height: min(40vh, 22rem); overflow-y: auto; padding: 4px; border-top: 1px solid var(--divider); }
  .qb-row { position: relative; display: flex; align-items: flex-start; gap: 5px; padding: 6px 8px; border-radius: 7px; }
  .qb-row + .qb-row { border-top: 1px solid var(--divider); }
  .qb-row.dragging { background: var(--qb-a2); opacity: .8; }
  .qb-rtext { flex: 1; min-width: 0; color: var(--text); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; word-break: break-word; }
  .qb-racts { position: absolute; right: 5px; top: 50%; translate: 0 -50%; display: flex; gap: 2px; opacity: 0; transition: opacity .12s; }
  .qb-row:hover .qb-racts, .qb-row.menuon .qb-racts, .qb-row:focus-within .qb-racts { opacity: 1; }
  .qb-row:hover .qb-rtext, .qb-row.menuon .qb-rtext { mask-image: linear-gradient(to right, black calc(100% - 120px), transparent calc(100% - 48px)); }
  @media (pointer: coarse) { .qb-racts { opacity: 1; } .qb-rtext { mask-image: linear-gradient(to right, black calc(100% - 120px), transparent calc(100% - 48px)); } }
  .qb-grip { cursor: grab; touch-action: none; }
  .qb-grip:active { cursor: grabbing; }
  .qb-foot { display: flex; justify-content: flex-end; padding: 4px 8px 6px; border-top: 1px solid var(--divider); }
  .qb-clear { font-size: 12px; color: var(--qb-danger); padding: 3px 6px; border-radius: 6px; }
  .qb-clear:hover { background: var(--qb-a2); }
  .qb-err { font-size: 12px; color: var(--qb-danger); padding: 0 4px; }
  .qb-menu { position: fixed; z-index: 1000; min-width: 188px; padding: 4px; border-radius: 10px; background: var(--card); box-shadow: var(--card-shadow); display: flex; flex-direction: column; font-size: 13.5px; }
  .qb-menu button { text-align: left; padding: 7px 10px; border-radius: 7px; color: var(--text); }
  .qb-menu button:hover { background: var(--hover); }
  .qb-menu button.danger { color: var(--qb-danger, #ff5c72); }
  .qb-sep { height: 1px; margin: 4px 6px; background: var(--divider); }
</style>
