<script>
  // ChatGPT/Codex 专属侧边工作区。桌面是可拖拽右栏；手机是完整的独立页面，
  // 不压缩、不叠盖对话内容，底部四标签直接切换工具。
  import { onMount } from 'svelte';
  import { ui } from '../../lib/state.svelte.js';
  import { api } from '../../lib/api.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { codexDock, closeCodexDock, openCodexDock } from '../../lib/dock.svelte.js';
  import { layout } from '../../lib/layout.svelte.js';
  import { preview, closePreview } from '../../lib/preview.svelte.js';
  import ReviewPanel from './ReviewPanel.svelte';
  import TermPanel from './TermPanel.svelte';
  import BrowserPanel from './BrowserPanel.svelte';
  import WorkspaceEmbed from './WorkspaceEmbed.svelte';
  import MediaViewer from '../preview/MediaViewer.svelte';
  import { t, tc } from '../../lib/i18n.js';

  let { wide = false, workspaceName = '' } = $props();

  const TOOLS = [
    { key: 'review', label: tc('codex', '更改') },
    { key: 'term', label: t('终端') },
    { key: 'files', label: tc('codex', '文件') },
    { key: 'browser', label: t('浏览器') },
  ];
  const titleOf = (key) => TOOLS.find((x) => x.key === key)?.label || t('工作区');
  const projectLabel = $derived(workspaceName || codexDock.ws.split(/[\\/]/).pop() || t('项目'));

  const WIDTH_KEY = 'bridge-chatgpt-workspace-w';
  let panel = $state();
  let width = $state(null);
  let gripping = $state(false);
  onMount(() => {
    try { const n = Number(localStorage.getItem(WIDTH_KEY)); if (n >= 380) width = n; } catch {}
  });

  function gripDown(e) {
    if (!wide || !panel) return;
    e.preventDefault();
    const right = panel.getBoundingClientRect().right;
    gripping = true;
    document.body.style.userSelect = 'none';
    const move = (ev) => {
      // medium 档（折叠屏展开）横向紧张：下限 290、给对话留 280；宽屏维持原区间。
      const lo = layout.medium ? 290 : 380;
      const max = Math.max(lo, window.innerWidth - (layout.medium ? 280 : 520));
      width = Math.round(Math.min(Math.max(right - ev.clientX, lo), max));
    };
    const up = () => {
      gripping = false;
      document.body.style.userSelect = '';
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try { if (width) localStorage.setItem(WIDTH_KEY, String(width)); } catch {}
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  function resetWidth() { width = null; try { localStorage.removeItem(WIDTH_KEY); } catch {} }

  async function refreshMeta() {
    try { codexDock.meta = await api.get(`/api/claude/dock/meta?ws=${encodeURIComponent(codexDock.ws)}`); }
    catch { codexDock.meta = { git: false, shell: false }; }
  }
  $effect(() => { if (codexDock.open && codexDock.ws && !codexDock.meta) refreshMeta(); });
  // 侧列形态也占返回层：折叠屏展开仍是安卓，返回键该先收工作区（expanded 通常无返回键）。
  $effect(() => { if (codexDock.open && !layout.expanded) return pushBackLayer(closeCodexDock); });
  $effect(() => {
    if (!codexDock.open) return;
    return () => { if (preview.open && preview.host === 'codex-workspace') closePreview(); };
  });

  function pick(key) {
    if (key === 'term' || key === 'browser') {
      if (codexDock.meta?.shell === false) return;
    }
    codexDock.view = key;
    codexDock.browserLive = key === 'browser' ? '' : codexDock.browserLive;
  }

  const KEYS = [
    ['review', (e) => e.ctrlKey && e.shiftKey && e.code === 'KeyG'],
    ['term', (e) => e.ctrlKey && !e.shiftKey && e.code === 'Backquote'],
    ['files', (e) => e.ctrlKey && e.shiftKey && e.code === 'KeyE'],
    ['browser', (e) => e.ctrlKey && e.shiftKey && e.code === 'KeyB'],
  ];
  $effect(() => {
    if (ui.screen !== 'chatgpt') return;
    const onKey = (e) => {
      for (const [key, match] of KEYS) if (match(e)) {
        e.preventDefault();
        if (codexDock.open && codexDock.view === key) closeCodexDock();
        else { openCodexDock(key); pick(key); }
        break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
</script>

{#snippet icon(key)}
  {#if key === 'review'}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 5.5h16M4 12h10M4 18.5h7"/><path d="m16 16 2 2 3-4"/></svg>
  {:else if key === 'term'}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="4" width="17" height="16" rx="3"/><path d="m7.5 9 3 3-3 3M13 15h3.5"/></svg>
  {:else if key === 'files'}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3.5 7.5A2.5 2.5 0 0 1 6 5h4l2 2h6a2.5 2.5 0 0 1 2.5 2.5v8A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5z"/></svg>
  {:else}<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="8.5"/><path d="M3.5 12h17M12 3.5c2.5 2.4 3.8 5.2 3.8 8.5S14.5 18.1 12 20.5M12 3.5C9.5 5.9 8.2 8.7 8.2 12s1.3 6.1 3.8 8.5"/></svg>{/if}
{/snippet}

{#snippet body()}
  {#if !codexDock.ws}
    <div class="empty"><span class="spin"></span><p>{t('正在连接项目工作区…')}</p></div>
  {:else}
    {#key codexDock.ws}
      {#if codexDock.view === 'review'}<ReviewPanel dockState={codexDock} />
      {:else if codexDock.view === 'term'}<TermPanel dockState={codexDock} />
      {:else if codexDock.view === 'browser'}<BrowserPanel dockState={codexDock} />
      {:else if codexDock.view === 'files'}
        <div class="files-host">
          <WorkspaceEmbed {wide} ws={codexDock.ws} rootName={projectLabel} initialPath="" previewHost="codex-workspace" onExit={closeCodexDock} />
          <MediaViewer host="codex-workspace" />
        </div>
      {/if}
    {/key}
  {/if}
{/snippet}

{#if codexDock.open}
  <aside class:desktop={wide} class:mid={wide && layout.medium} class:mobile={!wide} class:gripping bind:this={panel} style={wide && width ? `width:${width}px` : ''}>
    {#if wide}<div class="resize" role="separator" aria-label={t('调整工作区宽度')} onpointerdown={gripDown} ondblclick={resetWidth}></div>{/if}
    <!-- 顶栏所有工具一致（文件视图也有）：收起恒在右上角 ✕ / 手机左上「对话」，
         内嵌工作空间页自己的 ‹ / ↑ 只管上一级（WorkspaceEmbed 传 hostChrome）。 -->
    <div class="topbar">
      {#if !wide}<button class="back" onclick={closeCodexDock} aria-label={t('返回对话')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 5-7 7 7 7"/></svg><span>{t('对话')}</span></button>{/if}
      <div class="heading"><strong>{wide ? titleOf(codexDock.view) : projectLabel}</strong><span>{wide ? projectLabel : titleOf(codexDock.view)}</span></div>
      <button class="close" onclick={closeCodexDock} aria-label={t('关闭工作区')}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
    </div>

    <div class="workspace-main">
      {#if wide}
        <nav class="rail" aria-label={t('工作区工具')}>
          {#each TOOLS as tool}
            <button class:on={codexDock.view === tool.key} disabled={(tool.key === 'term' || tool.key === 'browser') && codexDock.meta?.shell === false} onclick={() => pick(tool.key)} title={tool.label}>
              {@render icon(tool.key)}
              {#if tool.key === 'browser' && codexDock.browserLive && codexDock.view !== 'browser'}<i></i>{/if}
            </button>
          {/each}
        </nav>
      {/if}
      <section class="content">{@render body()}</section>
    </div>

    {#if !wide}
      <nav class="bottom" aria-label={t('工作区工具')}>
        {#each TOOLS as tool}
          <button class:on={codexDock.view === tool.key} disabled={(tool.key === 'term' || tool.key === 'browser') && codexDock.meta?.shell === false} onclick={() => pick(tool.key)}>
            <span>{@render icon(tool.key)}{#if tool.key === 'browser' && codexDock.browserLive && codexDock.view !== 'browser'}<i></i>{/if}</span>
            {tool.label}
          </button>
        {/each}
      </nav>
    {/if}
  </aside>
{/if}

<style>
  aside { --bg:#212121; --text:#ececec; --muted:#a8a8a8; --serif:#ececec; --hover:#2f2f2f; --hover-strong:#383838;
    --card:#2f2f2f; --divider:#383838; --coral:#10a37f; --ok:#10a37f; --card-shadow:none;
    display:flex; flex-direction:column; min-width:0; color:var(--text); background:var(--bg); font-family:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  :global(.light) aside { --bg:#fff; --text:#0d0d0d; --muted:#6b6b6b; --serif:#0d0d0d; --hover:#f3f3f3; --hover-strong:#ececec; --card:#f7f7f8; --divider:#e5e5e5; }
  aside.desktop { position:relative; flex:none; width:clamp(440px,45vw,820px); min-width:380px; max-width:calc(100vw - 520px); border-left:1px solid var(--divider); animation:sideIn .2s ease-out; padding-top:var(--sat,0px); padding-bottom:var(--sab,0px); }
  /* 桌面壳（WCO）：对齐 Claude 工作台——侧列把自己那段第一行整条让给系统窗控当标题栏带（对话 iframe 那边
     app.css 早已整体下推一条带，左右正好是同一行），顶栏的关闭钮、内嵌文件工具栏都从第二行起全宽，
     不再压在最小化/最大化/关闭底下。 */
  :global(html[data-wco="1"]) aside.desktop { padding-top:var(--wco-h,40px); }
  /* medium（折叠屏展开 ~750px / 竖屏平板）：整套桌面结构照用，只把宽度区间收窄——
     原 min-width:380 + max-width:calc(100vw-520) 在 750px 上互相矛盾（380 > 230），
     面板会顶破视口把对话挤没。给正文留 280px 下限。 */
  aside.desktop.mid { width:clamp(300px,52vw,560px); min-width:290px; max-width:calc(100vw - 280px); }
  /* 窄侧列里 56px 图标 rail 太占：缩到 46 并让内容区先吃宽度 */
  aside.desktop.mid .rail { width:46px; padding:8px 4px; }
  aside.desktop.mid .rail button { width:38px; height:38px; }
  aside.mobile { position:fixed; inset:0; z-index:74; width:100%; height:100dvh; animation:mobileIn .22s ease-out; padding-top:var(--sat); }
  @keyframes sideIn { from { opacity:.5; transform:translateX(12px); } }
  @keyframes mobileIn { from { opacity:.4; transform:translateX(8%); } }
  .resize { position:absolute; z-index:8; left:-5px; inset-block:0; width:10px; cursor:col-resize; touch-action:none; -webkit-app-region:no-drag; }
  .resize::after { content:""; position:absolute; left:4px; inset-block:0; width:2px; background:transparent; transition:.15s; }
  .resize:hover::after,.gripping .resize::after { background:#10a37f; }
  .topbar { height:54px; flex:none; display:flex; align-items:center; gap:10px; padding:0 12px; border-bottom:1px solid var(--divider); background:color-mix(in srgb,var(--bg) 94%,transparent); }
  .heading { min-width:0; flex:1; display:flex; align-items:baseline; gap:9px; }
  .heading strong { font-size:14.5px; font-weight:600; white-space:nowrap; }
  .heading span { color:var(--muted); font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .close,.back { height:36px; border-radius:9px; color:var(--muted); display:flex; align-items:center; justify-content:center; }
  .close { width:36px; }
  .close:hover,.back:hover { color:var(--text); background:var(--hover); }
  .close svg { width:18px; height:18px; }
  .back { padding:0 8px 0 2px; gap:3px; color:var(--text); }
  .back svg { width:22px; height:22px; }
  .back span { font-size:14px; }
  .workspace-main { flex:1; min-height:0; display:flex; }
  /* 顶部状态栏 / 窗控带、底部手势条已由 aside 根部（或手机底栏）让过：子树归零。此前内嵌文件页
     又自己加了一遍 --sat，折叠屏和手机上文件视图顶部白留双倍状态栏高度。 */
  .topbar, .workspace-main { --sat:0px; --sab:0px; --wco-right:0px; }
  .rail { width:56px; flex:none; display:flex; flex-direction:column; align-items:center; gap:5px; padding:10px 7px; background:#171717; border-right:1px solid var(--divider); }
  :global(.light) .rail { background:#f7f7f8; }
  .rail button { position:relative; width:40px; height:40px; border-radius:10px; display:grid; place-items:center; color:var(--muted); }
  .rail button:hover { background:var(--hover); color:var(--text); }
  .rail button.on { color:var(--text); background:var(--hover-strong); }
  .rail svg { width:20px; height:20px; }
  button:disabled { opacity:.3; pointer-events:none; }
  nav i { position:absolute; width:7px; height:7px; border-radius:50%; background:#10a37f; box-shadow:0 0 0 2px var(--bg); }
  .rail i { right:5px; top:5px; }
  .content { position:relative; flex:1; min-width:0; min-height:0; display:flex; flex-direction:column; overflow:hidden; }
  .files-host { flex:1; min-height:0; position:relative; overflow:hidden; transform:translateZ(0); }
  .empty { flex:1; display:grid; place-content:center; justify-items:center; gap:10px; color:var(--muted); font-size:14px; }
  .spin { width:22px; height:22px; border:2px solid var(--divider); border-top-color:#10a37f; border-radius:50%; animation:spin .8s linear infinite; }
  @keyframes spin { to { transform:rotate(360deg); } }
  .bottom { height:calc(62px + var(--sab)); flex:none; display:grid; grid-template-columns:repeat(4,1fr); padding:5px 5px var(--sab); border-top:1px solid var(--divider); background:#171717; }
  :global(.light) .bottom { background:#fff; }
  .bottom button { position:relative; min-width:0; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px; color:var(--muted); font-size:11px; border-radius:10px; }
  .bottom button.on { color:#10a37f; background:color-mix(in srgb,#10a37f 10%,transparent); }
  .bottom button > span { position:relative; display:flex; }
  .bottom svg { width:21px; height:21px; }
  .bottom i { right:-5px; top:-3px; }
  /* 这两条原本用 max-width:1023px 代指「手机形态」。折叠屏展开（700–1023）现在走的是
     桌面形态侧列，宽度也在 1023 以下——不限定 .mobile 就会把标题挤成两行、还把关闭钮
     藏掉（侧列里没有底部返回条，关不掉就出不去了）。 */
  aside.mobile .topbar { height:52px; }
  aside.mobile .heading { flex-direction:column; gap:0; align-items:flex-start; }
  aside.mobile .heading strong { font-size:14px; }
  aside.mobile .heading span { font-size:11px; }
  aside.mobile .content { padding-bottom:0; }
  aside.mobile .close { display:none; }
</style>
