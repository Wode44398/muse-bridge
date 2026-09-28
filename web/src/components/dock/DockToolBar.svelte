<script>
  // Claude 桌面版同款的【工具开关组】：终端 / 审阅 / 文件三颗常驻 + ⋮（任务、明暗），
  // 分屏格再多一颗 ✕。两处宿主、同一时刻只挂一处：
  //   · 工作台收着：TopBar 把它挂在这一格右上角；
  //   · 工作台展开：ClaudeDock 把它挂进自己顶上那条带里（docked），就坐在卡片正上方——
  //     位置跟着工作台这一列走，不靠这一格右上角的坐标去「碰巧」对上。
  // 材质：无边框、无高光、纯毛玻璃（backdrop blur）；内容滚到底下时透出模糊。
  import { toggleTheme, ui } from '../../lib/state.svelte.js';
  import { dock, toggleDockView, closeDock, ensureDockMeta, dockToolOk, DOCK_TOOLS } from '../../lib/dock.svelte.js';
  import { bgHoldNow } from '../../lib/chat.svelte.js';
  import { dockIcon } from '../../lib/dockIcons.js';
  // top：宿主算好的 top（TopBar 按 sat 属性给；docked 时由工作台带内的规则定，不用它）
  // split：分屏里的一格；onClose 给了就在末尾多一颗 ✕（关掉这一格）
  let { top = '10px', split = false, onClose = null, docked = false } = $props();

  const BAR = ['term', 'review', 'files'];            // 标题栏常驻三颗，其余收进 ⋮
  const MORE = ['tasks'];
  const LABEL = Object.fromEntries(DOCK_TOOLS.map((t) => [t.key, t]));
  const barTools = $derived(BAR.filter(dockToolOk));
  const moreTools = $derived(MORE.filter(dockToolOk));
  const isOn = (k) => dock.open && dock.views.includes(k);
  // agent 动了终端、本轮挂着等后台任务，而对应卡片没开：那颗开关亮呼吸点
  const bgLive = $derived(!!bgHoldNow());
  const live = (k) => !isOn(k) && ((k === 'term' && dock.termLive) || (k === 'tasks' && bgLive));
  const moreLive = $derived(moreTools.some(live));
  const tip = (k) => LABEL[k].label + (LABEL[k].kbd ? `（${LABEL[k].kbd}）` : '');

  // 开关组要知道这个身份有没有 shell（终端给不给）——meta 在工作台没开时也得有
  $effect(() => { if (dock.ws && !dock.meta) ensureDockMeta(); });

  let moreOpen = $state(false);
  let barEl = $state();
  $effect(() => {
    if (!moreOpen) return;
    const down = (e) => { if (barEl && !barEl.contains(e.target)) moreOpen = false; };
    const key = (e) => { if (e.key === 'Escape') moreOpen = false; };
    // 点进分屏的另一格（另一份文档）不会有 pointerdown 到本文档：宿主与格子互发消息后
    // 各自在本窗口派 bridge-pane-away（见 ClaudePage / SoloPage）；窗口失焦再兜一层。
    const away = () => { moreOpen = false; };
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('keydown', key);
    window.addEventListener('blur', away);
    window.addEventListener('bridge-pane-away', away);
    return () => {
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('keydown', key);
      window.removeEventListener('blur', away);
      window.removeEventListener('bridge-pane-away', away);
    };
  });
  function pick(k) { moreOpen = false; toggleDockView(k); }
</script>

<div class="tbar" class:split class:docked style:top={docked ? null : top} bind:this={barEl}>
  {#each barTools as k (k)}
    <button class="tb" class:on={isOn(k)} aria-pressed={isOn(k)} aria-label={LABEL[k].label} title={tip(k)} onclick={() => toggleDockView(k)}>
      {@html dockIcon(k)}
      {#if live(k)}<span class="live-dot"></span>{/if}
    </button>
  {/each}
  <button class="tb" class:on={moreOpen} aria-label="更多" aria-haspopup="menu" aria-expanded={moreOpen} title="更多" onclick={() => { moreOpen = !moreOpen; }}>
    {@html dockIcon('more')}
    {#if moreLive && !moreOpen}<span class="live-dot"></span>{/if}
  </button>
  {#if onClose}
    <span class="tb-sep" aria-hidden="true"></span>
    <button class="tb x" aria-label="关闭这一格" title="关闭这一格" onclick={onClose}>{@html dockIcon('close')}</button>
  {/if}
  {#if moreOpen}
    <div class="tb-menu" role="menu">
      {#each moreTools as k (k)}
        <button class="mi" role="menuitemcheckbox" aria-checked={isOn(k)} onclick={() => pick(k)}>
          <span class="mi-ic">{@html dockIcon(k)}</span>
          <span class="mi-lab">{LABEL[k].label}</span>
          {#if live(k)}<span class="mi-live"></span>{/if}
          {#if LABEL[k].kbd}<span class="mi-kbd">{LABEL[k].kbd}</span>{/if}
          <span class="mi-ck">{#if isOn(k)}{@html dockIcon('check')}{/if}</span>
        </button>
      {/each}
      <div class="mi-sep" role="separator"></div>
      <button class="mi" role="menuitem" onclick={() => { moreOpen = false; toggleTheme(); }}>
        <span class="mi-ic">{@html dockIcon(ui.theme === 'light' ? 'moon' : 'sun')}</span>
        <span class="mi-lab">{ui.theme === 'light' ? '深色模式' : '浅色模式'}</span>
      </button>
      {#if dock.open && dock.views.length > 1}
        <button class="mi" role="menuitem" onclick={() => { moreOpen = false; closeDock(); }}>
          <span class="mi-ic">{@html dockIcon('close')}</span>
          <span class="mi-lab">收起全部面板</span>
        </button>
      {/if}
    </div>
  {/if}
</div>

<style>
  /* 贴宿主右上角。z 压过盖在正文上的工作台（overlay 32）。
     docked 时工作台子树里 --sat 已归零，改读工作台在自己身上存下的 --dk-sat（见 ClaudeDock）。 */
  .tbar {
    position: absolute; right: 10px; z-index: 34; height: 36px; border-radius: 12px;
    display: flex; align-items: center; gap: 1px; padding: 0 4px;
    background: rgba(32, 32, 30, .42);
    -webkit-backdrop-filter: blur(18px) saturate(1.5);
    backdrop-filter: blur(18px) saturate(1.5);
    color: var(--serif);
  }
  :global(html[data-theme="light"]) .tbar { background: rgba(248, 248, 246, .5); }
  .tbar.docked { top: calc(var(--dk-sat, 0px) + 10px); }
  .tb {
    position: relative; flex: none; width: 32px; height: 28px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center; color: var(--serif);
    transition: background-color .12s ease, color .12s ease;
  }
  .tb :global(svg) { width: 18px; height: 18px; }
  .tb.x :global(svg) { width: 16px; height: 16px; }
  .tb:active { background: var(--hover-strong); }
  @media (hover: hover) { .tb:hover { background: var(--hover-strong); color: var(--text); } }
  /* 开着的那几颗：实底 + 正文色（官方是一块高亮底；bridge 的朱色只给「正在发生」，这里用中性色） */
  .tb.on { background: color-mix(in srgb, var(--text) 15%, transparent); color: var(--text); }
  /* agent 正在用终端 / 有后台任务且面板没开：呼吸绿点提示（点开即清） */
  .live-dot { position: absolute; top: 3px; right: 4px; width: 6px; height: 6px; border-radius: 50%;
    background: var(--ok); animation: tbPulse 1.2s ease-in-out infinite; }
  @keyframes tbPulse { 50% { opacity: .35; } }
  .tb-sep { flex: none; width: 1px; height: 16px; margin: 0 3px; background: color-mix(in srgb, var(--text) 16%, transparent); }
  /* 触屏（平板 / 折叠屏展开）：按钮放大到手指好点的尺寸；工作台顶上的带同步加高（ClaudeDock） */
  @media (pointer: coarse) {
    .tbar { height: 40px; border-radius: 14px; }
    .tb { width: 38px; height: 34px; border-radius: 10px; }
  }

  /* ⋮ 菜单：实底（不叠第二层 backdrop-filter——同屏多层会让上层静默失效） */
  .tb-menu {
    position: absolute; top: calc(100% + 6px); right: 0; z-index: 50; min-width: 208px; padding: 5px;
    border-radius: 12px; background: var(--q-card); box-shadow: 0 10px 30px rgba(0, 0, 0, .22), var(--q-shadow);
    display: flex; flex-direction: column; animation: tbMenuIn .14s ease;
  }
  @keyframes tbMenuIn { from { opacity: 0; transform: translateY(-4px); } }
  .mi {
    display: flex; align-items: center; gap: 10px; height: 34px; padding: 0 8px 0 10px; border-radius: 8px;
    color: var(--text); font-size: 13.5px; text-align: left; width: 100%;
  }
  .mi:active { background: var(--hover-strong); }
  @media (hover: hover) { .mi:hover { background: var(--hover); } }
  .mi-ic { width: 17px; height: 17px; flex: none; display: flex; color: var(--serif); }
  .mi-ic :global(svg) { width: 100%; height: 100%; }
  .mi-lab { flex: 1; min-width: 0; }
  .mi-live { width: 6px; height: 6px; border-radius: 50%; background: var(--ok); animation: tbPulse 1.2s ease-in-out infinite; flex: none; }
  .mi-kbd { font-size: 11.5px; color: var(--muted); font-family: Consolas, 'Cascadia Mono', Menlo, monospace; }
  @media (pointer: coarse) { .mi-kbd { display: none; } }
  .mi-ck { width: 15px; height: 15px; flex: none; display: flex; color: var(--text); }
  .mi-ck :global(svg) { width: 100%; height: 100%; }
  .mi-sep { height: 1px; margin: 4px 6px; background: var(--divider); }
</style>
