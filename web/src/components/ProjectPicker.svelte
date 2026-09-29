<script>
  // 「新建项目」工作空间选择器。
  //
  // Claude 与 dimensio 共用这一个。
  // 基底就是 bridge 现成的工作空间文件管理器本体（FilesPanel 的 picker 形态），不是仿它的
  // 另一套控件——面包屑、缩略图、新建文件夹、搜索全是同一份代码。
  //
  // 选定手势只有一个：长按文件夹（或顶部当前路径条）拖到底栏松手。刻意不做「点一下选中」的
  // 兜底——点文件夹恒等于「进去」，一旦同一次点按也可能是「选它」，用户和代码都再分不清。
  //
  // 位置栏：文件管理器锁在身份工作空间根内（admin=vault），但真实项目大量在库外
  // （claude-bridge / agent trading / Dimensio Projects…）。/api/project/locations 给出
  // 工作空间 + 主目录 + Dimensio Projects + 各盘符，把可达范围补回与旧自建选择器等价。
  // 授权边界一字未改：服务端 authorizeProjectPath 判，Pro 只会拿到自己那一条（位置栏不出现）。
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';
  import { pushBackLayer } from '../lib/nav.js';
  import FilesPanel from './FilesPanel.svelte';
  import { t, tr } from '../lib/i18n.js';

  // title/hint 由调用方给（三家措辞略有不同）；busy 期间盖一层遮罩免得连拖两次。
  const {
    title = t('新建项目'),
    hint = t('把文件夹拖进底栏，它就是新项目的工作空间'),
    preferPath = '',          // 优先落到哪个位置（一般传当前项目路径，开箱即在熟悉的地方）
    onPick,                   // (absPath) => Promise|void
    onClose,
  } = $props();

  let locations = $state([]);
  let locId = $state('');
  let loadErr = $state('');
  let busy = $state(false);
  let err = $state('');

  const current = $derived(locations.find((l) => l.id === locId) || null);
  const fold = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
  const under = (base, target) => {
    const b = fold(base), tg = fold(target);
    return !!b && (tg === b || tg.startsWith(b + '/') || tg.startsWith(b + '\\'));
  };

  $effect(() => pushBackLayer(() => onClose?.()));

  onMount(async () => {
    try {
      const r = await api.projectLocations();
      locations = r.locations || [];
    } catch (e) {
      loadErr = tr(e?.body?.error) || t('无法读取可选位置');
      return;
    }
    if (!locations.length) { loadErr = t('没有可用的位置'); return; }
    // 落点：能包住 preferPath 的最深那个位置（盘符与工作空间可能互相嵌套，取最长匹配），
    // 都不匹配就用第一条（恒为「工作空间」）。
    let best = null;
    for (const loc of locations) {
      if (preferPath && under(loc.path, preferPath) && (!best || fold(loc.path).length > fold(best.path).length)) best = loc;
    }
    locId = (best || locations[0]).id;
  });

  async function pick(abs) {
    if (busy || !abs) return;
    busy = true; err = '';
    try { await onPick?.(abs); }
    catch (e) { err = tr(e?.body?.error || e?.message) || t('创建失败'); busy = false; return; }
    busy = false;
  }
</script>

<div class="pp-root">
  <button class="pp-scrim" aria-label={t('关闭')} onclick={() => onClose?.()}></button>
  <!-- .pp-card 带 transform：FilesPanel 的 fixed 根/浮层/长按弹层全被圈进这张卡里
       （与 Claude 工作台的 .dk-embed 同一手法），否则它会铺满整个视口。 -->
  <div class="pp-card" role="dialog" aria-modal="true" aria-label={title}>
    <div class="pp-head">
      <div class="pp-tt"><h2>{title}</h2><p>{hint}</p></div>
      <button class="pp-x" aria-label={t('关闭')} onclick={() => onClose?.()}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M2.5 2.5l11 11M13.5 2.5l-11 11" /></svg>
      </button>
    </div>
    <div class="pp-body">
      {#if loadErr}
        <div class="pp-msg">{loadErr}</div>
      {:else if current}
        {#key current.id}
          <FilesPanel
            picker
            workspaceRoot={current.path}
            rootName={current.name}
            pickerLocations={locations}
            pickerLocationId={locId}
            onPickLocation={(loc) => (locId = loc.id)}
            onPick={pick}
            onExit={() => onClose?.()}
          />
        {/key}
      {:else}
        <div class="pp-msg">{t('正在读取位置…')}</div>
      {/if}
      {#if busy}<div class="pp-busy">{t('创建中…')}</div>{/if}
    </div>
    {#if err}<div class="pp-err">{err}</div>{/if}
  </div>
</div>

<style>
  .pp-root { position: fixed; inset: 0; z-index: 96; display: flex; align-items: center; justify-content: center; }
  .pp-scrim { position: absolute; inset: 0; background: rgba(0,0,0,.42); border: none; animation: pp-fade .18s ease both; }
  @keyframes pp-fade { from { opacity: 0; } }
  .pp-card {
    position: relative; display: flex; flex-direction: column;
    width: min(760px, 100%); height: min(78vh, 760px);
    border-radius: 20px; overflow: hidden; background: #f2f2f7; color: #000;
    box-shadow: 0 26px 70px rgba(0,0,0,.34);
    animation: pp-in .26s cubic-bezier(.22,1,.36,1) both;
    font-family: -apple-system, 'SF Pro Text', BlinkMacSystemFont, 'PingFang SC', 'HarmonyOS Sans SC', 'Microsoft YaHei UI', sans-serif;
  }
  @keyframes pp-in { from { opacity: 0; transform: translateY(12px) scale(.985); } }
  .pp-head { display: flex; align-items: flex-start; gap: 14px; padding: 16px 16px 12px; background: #fff;
    border-bottom: 1px solid rgba(60,60,67,.12); flex: none; }
  .pp-tt { min-width: 0; flex: 1; }
  .pp-tt h2 { font-size: 19px; font-weight: 680; letter-spacing: -.02em; }
  .pp-tt p { margin-top: 3px; font-size: 12.5px; color: rgba(60,60,67,.6); }
  .pp-x { width: 30px; height: 30px; flex: none; border-radius: 50%; display: inline-flex; align-items: center;
    justify-content: center; background: rgba(120,120,128,.14); color: rgba(60,60,67,.7); border: none; }
  .pp-x svg { width: 13px; height: 13px; }
  /* transform 造包含块（与工作台 .dk-embed 同一手法）：FilesPanel 是 fixed inset:0 的整页，
     不圈住就会连头带尾铺满整个视口。圈在 body 上而不是卡上，头部才不会被它盖掉。 */
  /* --sat 归零：安全区已由 .pp-head 让过一次，FilesPanel 内部再让一次就是双份留白 */
  .pp-body { position: relative; flex: 1; min-height: 0; overflow: hidden; transform: translateZ(0); --sat: 0px; }
  .pp-msg { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    font-size: 14px; color: rgba(60,60,67,.6); }
  .pp-busy { position: absolute; inset: 0; z-index: 90; display: flex; align-items: center; justify-content: center;
    background: rgba(255,255,255,.72); font-size: 15px; font-weight: 620; color: #0088ff; }
  .pp-err { flex: none; padding: 9px 16px; background: #fff; border-top: 1px solid rgba(60,60,67,.12);
    color: #ff383c; font-size: 12.5px; }

  /* 手机 / 窄屏：整屏接管（工作台在窄屏也是这个形态） */
  @media (max-width: 719px) {
    .pp-card { width: 100%; height: 100%; border-radius: 0; animation: pp-up .3s cubic-bezier(.32,.72,0,1) both; }
    @keyframes pp-up { from { transform: translateY(16px); opacity: 0; } }
    .pp-head { padding: calc(var(--sat,0px) + 14px) 14px 11px; }
    .pp-scrim { display: none; }
  }
</style>
