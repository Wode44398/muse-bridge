<script>
  // 插件文件夹菜单项的确认框（ctx.ui.workspaceAction 的 dialog），Claude 页的画法：注册给数据层（registerWorkspaceDialog），
  // fn(dialog, meta) → { values } | { extra: true } | null。
  // Anthropic 的语言：圆角方块、1px 细描边、8 圆角按钮、不发光；开关开着是黑白反相（本页彩色只留星芒）。
  // 顶上的 hero 是几枚连接器方块，中间三个点相连。动效 60 / 120 / 200ms、ease-out (.165,.84,.44,1)：
  //   进场：底幕 120ms 淡入；卡片 200ms 上浮 6px 淡入；两枚方块各从外侧 6px 滑到位，第二枚晚 60ms；三个点随后逐个亮起（各隔 60ms）。
  //   退场：120ms 直接淡出（不演回去）。窄屏（≤560px）贴底成一张底部卡，从下面升上来。
  import { untrack } from 'svelte';
  import AgentTile from './AgentTile.svelte';
  import WorkspaceIcon from './WorkspaceIcon.svelte';
  import { registerWorkspaceDialog } from '../../../lib/pluginUi.svelte.js';
  import { t, tr } from '../../../lib/i18n.js';

  let cur = $state(null);        // { dialog, meta, values, resolve }
  let leaving = $state(false);
  let okBtn = $state(null);
  let leaveT = 0;

  function finish(result) {
    const c = cur;
    if (!c || leaving) return;
    leaving = true;
    c.resolve(result);
    clearTimeout(leaveT);
    leaveT = setTimeout(() => { if (cur === c) cur = null; leaving = false; }, 120);
  }

  $effect(() => {
    const off = registerWorkspaceDialog('claude', (dialog, meta) => new Promise((resolve) => {
      untrack(() => {
        if (cur && !leaving) cur.resolve(null);   // 前一个还开着：当取消
        clearTimeout(leaveT);
        leaving = false;
        const values = {};
        for (const f of dialog?.fields || []) values[f.id] = !!f.value;
        cur = { dialog: dialog || {}, meta: meta || {}, values, resolve };
      });
    }));
    return () => { off(); clearTimeout(leaveT); if (cur && !leaving) cur.resolve(null); cur = null; };
  });

  $effect(() => { if (cur && okBtn) queueMicrotask(() => okBtn?.focus({ preventScroll: true })); });

  function onKey(e) {
    if (!cur || leaving) return;
    if (e.key === 'Escape') { e.preventDefault(); finish(null); }
  }
  const toggle = (id) => { if (cur && !leaving) cur.values[id] = !cur.values[id]; };

  const d = $derived(cur?.dialog || null);
  const peers = $derived(d?.hero?.peers || []);
</script>

<svelte:window onkeydown={onKey} />

{#if cur && d}
  <button class="wd-bd" class:out={leaving} aria-label={t('关闭')} tabindex="-1" onclick={() => finish(null)}></button>
  <div class="wd" class:out={leaving} role="dialog" aria-modal="true" aria-labelledby="wd-title">
    {#if peers.length}
      <div class="wd-hero" aria-hidden="true">
        {#each peers as a, i (a)}
          {#if i}<span class="wd-link">{#each [0, 1, 2] as k (k)}<i style="animation-delay:{180 + k * 60}ms"></i>{/each}</span>{/if}
          <span class="wd-ht" style="--dx:{i ? 6 : -6}px;animation-delay:{i * 60}ms"><AgentTile agent={a} size={36} /></span>
        {/each}
      </div>
    {/if}
    <h3 id="wd-title" class="wd-title">{tr(d.title)}</h3>
    {#if d.subtitle}<p class="wd-sub">{tr(d.subtitle)}</p>{/if}

    <div class="wd-body">
      {#each d.sections || [] as sec, si (si)}
        <div class="wd-sec">
          {#if sec.label}<div class="wd-l">{tr(sec.label)}</div>{/if}
          {#each sec.items || [] as it, ii (ii)}
            <div class="wd-it">
              <span class="wd-ic">
                {#if it.icon}<WorkspaceIcon name={it.icon} size={16} />{:else if it.agent}<WorkspaceIcon name={it.agent} size={16} />{/if}
                {#if it.icon && it.agent}<span class="wd-badge"><AgentTile agent={it.agent} size={12} /></span>{/if}
              </span>
              <span class="wd-tx">
                <b>{tr(it.title)}</b>
                {#if it.desc}<span class="wd-d">{tr(it.desc)}</span>{/if}
                {#if it.chip}
                  <span class="wd-chip" class:ok={it.chip.ok}>
                    {#if it.chip.ok}<svg viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2.5 6.3 2.3 2.3 4.7-5"/></svg>{/if}
                    {#if it.chip.code}<code>{it.chip.code}</code>{/if}
                    {#if it.chip.text}<span>{tr(it.chip.text)}</span>{/if}
                  </span>
                {/if}
              </span>
            </div>
          {/each}
        </div>
      {/each}

      {#if (d.fields || []).length}
        <div class="wd-fields">
          {#each d.fields as f (f.id)}
            <button type="button" class="wd-f" role="switch" aria-checked={!!cur.values[f.id]} onclick={() => toggle(f.id)}>
              <span class="wd-tx"><b>{tr(f.label)}</b>{#if f.desc}<span class="wd-d">{tr(f.desc)}</span>{/if}</span>
              <span class="wd-sw" class:on={!!cur.values[f.id]} aria-hidden="true"><span></span></span>
            </button>
          {/each}
        </div>
      {/if}
    </div>

    <div class="wd-act">
      {#if d.extra}<button type="button" class="wd-b wd-x" class:danger={d.extra.danger} onclick={() => finish({ extra: true })}>{tr(d.extra.label)}</button>{/if}
      <span class="wd-gap"></span>
      <button type="button" class="wd-b wd-c" onclick={() => finish(null)}>{tr(d.cancel || '') || t('取消')}</button>
      <button type="button" class="wd-b wd-ok" class:danger={d.danger} bind:this={okBtn} onclick={() => finish({ values: { ...cur.values } })}>{tr(d.ok || '') || t('确定')}</button>
    </div>
  </div>
{/if}

<style>
  .wd-bd { position: fixed; inset: 0; z-index: 72; border: 0; padding: 0; background: rgba(0, 0, 0, .4); cursor: default;
    animation: wdFade 120ms cubic-bezier(.165, .84, .44, 1) both; }
  .wd { position: fixed; z-index: 73; left: 50%; top: 50%; translate: -50% -50%;
    width: min(440px, calc(100vw - 32px)); max-height: min(640px, calc(100vh - 64px)); display: flex; flex-direction: column;
    padding: 20px 20px 16px; border-radius: 12px; background: var(--q-card); color: var(--text);
    box-shadow: inset 0 0 0 1px var(--cc-ring), 0 12px 32px rgba(0, 0, 0, .22);
    animation: wdIn 200ms cubic-bezier(.165, .84, .44, 1) both; }
  .wd-bd.out { animation: wdOut 120ms cubic-bezier(.165, .84, .44, 1) forwards; pointer-events: none; }
  .wd.out { animation: wdOut 120ms cubic-bezier(.165, .84, .44, 1) forwards; pointer-events: none; }
  @keyframes wdFade { from { opacity: 0; } }
  @keyframes wdIn { from { opacity: 0; transform: translateY(6px); } }
  @keyframes wdOut { to { opacity: 0; } }

  /* hero：几枚连接器方块，中间三个点（像「连上」那一下），不画光 */
  .wd-hero { display: flex; align-items: center; gap: 10px; margin-bottom: 16px; }
  .wd-ht { display: inline-flex; animation: wdTile 200ms cubic-bezier(.165, .84, .44, 1) both; }
  @keyframes wdTile { from { opacity: 0; transform: translateX(var(--dx)); } }
  .wd-link { display: inline-flex; gap: 4px; }
  .wd-link i { width: 3px; height: 3px; border-radius: 1px; background: var(--muted); animation: wdDot 120ms cubic-bezier(.165, .84, .44, 1) both; }
  @keyframes wdDot { from { opacity: 0; transform: scale(.4); } }

  .wd-title { margin: 0; font-size: 16px; line-height: 22px; font-weight: 500; letter-spacing: -.1px; }
  .wd-sub { margin: 4px 0 0; font-size: 12.5px; line-height: 18px; color: var(--muted); overflow-wrap: anywhere; }
  .wd-body { flex: 1; min-height: 0; overflow-y: auto; margin: 12px -4px 0; padding: 0 4px; }
  .wd-sec + .wd-sec, .wd-fields { margin-top: 14px; }
  .wd-l { font-size: 12px; color: var(--muted); margin: 0 0 6px; }
  .wd-it { display: flex; gap: 12px; padding: 7px 0; }
  .wd-ic { position: relative; flex: none; width: 28px; height: 28px; border-radius: 7px; display: grid; place-items: center;
    box-shadow: inset 0 0 0 1px var(--cc-ring); color: var(--serif); }
  .wd-badge { position: absolute; right: -4px; bottom: -4px; display: inline-flex; border-radius: 4px; box-shadow: 0 0 0 2px var(--q-card); }
  .wd-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; text-align: left; }
  .wd-tx b { font-size: 14px; line-height: 20px; font-weight: 500; color: var(--text); }
  .wd-d { font-size: 12.5px; line-height: 18px; color: var(--muted); text-wrap: pretty; }
  .wd-chip { align-self: flex-start; max-width: 100%; display: inline-flex; align-items: center; gap: 6px; margin-top: 4px; padding: 2px 7px;
    min-height: 22px; border-radius: 6px; box-shadow: inset 0 0 0 1px var(--cc-ring); font-size: 12px; color: var(--muted); }
  .wd-chip.ok { color: var(--serif); }
  .wd-chip svg { width: 12px; height: 12px; flex: none; }
  .wd-chip code { font-family: "Anthropic Mono", ui-monospace, Consolas, monospace; font-size: 11.5px; color: var(--text);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }

  /* 开关行：整行可点；开着 = 黑白反相，滑块 200ms、底色 120ms */
  .wd-fields { border-top: 1px solid var(--divider); padding-top: 6px; }
  .wd-f { width: 100%; display: flex; align-items: center; gap: 12px; padding: 8px 0; border: 0; background: none; color: inherit; font: inherit; cursor: pointer; }
  .wd-f:focus-visible { outline: none; }
  .wd-f:focus-visible .wd-sw { box-shadow: 0 0 0 2px var(--q-card), 0 0 0 3px var(--text); }
  .wd-sw { flex: none; position: relative; width: 30px; height: 18px; border-radius: 9px; background: color-mix(in srgb, var(--text) 18%, transparent);
    transition: background-color 120ms cubic-bezier(.165, .84, .44, 1); }
  .wd-sw span { position: absolute; left: 2px; top: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--q-card);
    box-shadow: 0 1px 2px rgba(0, 0, 0, .2); transition: transform 200ms cubic-bezier(.165, .84, .44, 1); }
  .wd-sw.on { background: var(--text); }
  .wd-sw.on span { transform: translateX(12px); background: var(--bg); }

  .wd-act { display: flex; align-items: center; gap: 8px; margin-top: 16px; }
  .wd-gap { flex: 1; }
  .wd-b { height: 32px; padding: 0 12px; border: 0; border-radius: 8px; font: inherit; font-size: 14px; font-weight: 500; cursor: pointer;
    transition: background-color 60ms cubic-bezier(.165, .84, .44, 1), color 60ms cubic-bezier(.165, .84, .44, 1), transform 60ms cubic-bezier(.165, .84, .44, 1); }
  .wd-b:active { transform: scale(.98); }
  .wd-b:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--q-card), 0 0 0 3px var(--text); }
  .wd-c { background: none; color: var(--serif); box-shadow: inset 0 0 0 1px var(--cc-ring); }
  .wd-x { background: none; color: var(--serif); padding: 0 8px; margin-left: -8px; }
  .wd-x.danger { color: var(--crit); }
  .wd-ok { background: var(--text); color: var(--bg); }
  .wd-ok.danger { background: var(--crit); color: #fff; }
  @media (hover: hover) {
    .wd-c:hover, .wd-x:hover { background: var(--hover); color: var(--text); }
    .wd-x.danger:hover { color: var(--crit); }
    .wd-ok:hover { background: color-mix(in srgb, var(--text) 88%, var(--bg)); }
    .wd-ok.danger:hover { background: color-mix(in srgb, var(--crit) 90%, #000); }
  }

  /* 窄屏：贴底的底部卡（从下面升上来），按钮加高到 40 好按 */
  @media (max-width: 560px) {
    .wd { left: 0; right: 0; top: auto; bottom: 0; translate: none; width: auto; max-height: calc(100vh - 48px);
      border-radius: 14px 14px 0 0; padding: 20px 18px calc(14px + var(--sab, 0px)); animation-name: wdUp; }
    @keyframes wdUp { from { transform: translateY(24px); opacity: 0; } }
    .wd-act { flex-wrap: wrap; }
    .wd-b { height: 40px; }
  }
  @media (prefers-reduced-motion: reduce) {
    .wd, .wd-bd, .wd-ht, .wd-link i { animation: none; }
    .wd.out, .wd-bd.out { opacity: 0; }
  }
</style>
