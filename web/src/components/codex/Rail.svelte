<script>
  // 窄栏：杂项都在这里，不和线程列表混（方案第十五节第 8 条）。
  // 从上到下：bridge 月桥（回主页）、线程、定时任务、插件与技能、产物，账号头像在最底下。
  // 选中的那一项底下垫一块底色，换页时滑过去；有线程在等你（审批、跑完没看、出错）而你在别的页时，「线程」上挂一个蓝点
  // （点的显隐由 .cx 根上的 data-attn 驱动，见 theme.css）。手机上窄栏和线程列表一起收在抽屉里。
  import { onMount, tick } from 'svelte';
  import { t } from '../../lib/i18n.js';
  import { me } from '../../lib/state.svelte.js';
  import { layout } from '../../lib/layout.svelte.js';
  import { closePage } from '../../lib/pageMorph.js';
  import { isPageWindow, focusMainWindow } from '../../lib/windowPage.svelte.js';
  import { codex } from '../../lib/codex/store.svelte.js';
  import { cxPop, togglePop, closePop } from '../../lib/codex/ui.svelte.js';
  import { anim, EASE, reduced } from '../../lib/codex/motion.js';
  import Icon from './Icon.svelte';
  import LottieIcon from './LottieIcon.svelte';

  const PAGES = [
    { v: 'tasks', lot: 'sidebar-tasks', icon: 'clock', label: () => t('定时任务') },
    { v: 'plugins', lot: 'sidebar-plugins', icon: 'sliders', label: () => t('插件与技能') },
    { v: 'library', lot: 'sidebar-library', icon: 'image', label: () => t('产物') },
  ];

  let navEl = $state(null);
  let selEl = $state(null);
  let homeEl = $state(null);
  const initial = $derived(String(me.user || '').trim().slice(0, 1).toUpperCase() || '·');

  function setView(v) {
    closePop();
    codex.view = v;
    // 手机上：去别的页就收起抽屉（那几页在主区）；点「线程」留在抽屉里看列表
    if (!layout.side && v !== 'threads') codex.drawer = false;
  }

  function goHome() {
    closePop();
    codex.drawer = false;
    if (isPageWindow()) focusMainWindow();
    else closePage('chatgpt');
  }

  // 月桥：悬停时拱抬一下、倒影荡一下（0.67 秒，和官方侧栏图标同一节奏）
  function bmarkHover(e) {
    if (e.pointerType === 'touch' || reduced() || !homeEl) return;
    const q = (s) => homeEl.querySelector(s);
    anim(q('.arch'), [{ transform: 'none' }, { transform: 'translateY(-3px)', offset: 0.35 }, { transform: 'none' }], { dur: 670, ease: EASE.io });
    anim(q('.refl'), [{ transform: 'none', opacity: 1 }, { transform: 'translateY(2px) scaleX(.9)', opacity: 0.35, offset: 0.4 }, { transform: 'none', opacity: 1 }], { dur: 670, ease: EASE.io });
    anim(q('.line'), [{ transform: 'scaleX(1)' }, { transform: 'scaleX(.94)', offset: 0.4 }, { transform: 'scaleX(1)' }], { dur: 670, ease: EASE.io });
  }

  function acct(e) {
    e.stopPropagation();
    togglePop('acct', e.currentTarget);
  }

  // 选中底块：跟着当前页滑；第一次摆位不滑
  let placed = false;
  function moveSel() {
    const btn = navEl?.querySelector(`.rl-btn[data-view="${codex.view}"]`);
    if (!btn || !selEl) return;
    if (!placed) selEl.style.transition = 'none';
    selEl.style.transform = `translateY(${btn.offsetTop}px)`;
    if (!placed) { void selEl.offsetHeight; selEl.style.transition = ''; placed = true; }
  }
  $effect(() => { void codex.view; tick().then(moveSel); });
  onMount(() => {
    // 桌面客户端标题栏、手机抽屉会改窄栏的内边距：位置跟着重算（不滑）
    const ro = new ResizeObserver(() => { placed = false; moveSel(); });
    if (navEl) ro.observe(navEl);
    return () => ro.disconnect();
  });
</script>

<nav class="cx-rail" bind:this={navEl} aria-label={t('Codex 导航')}>
  <span class="rl-sel" bind:this={selEl}></span>
  <button class="rl-btn rl-home" bind:this={homeEl} title={t('回到 bridge 主页')} aria-label={t('回到 bridge 主页')} onclick={goHome} onpointerenter={bmarkHover}>
    <svg class="bmark" viewBox="18 18 72 72" fill="none" stroke="currentColor" aria-hidden="true"><path class="arch" d="M35 55A19 19 0 0 1 73 55" stroke-width="7.4"/><path class="line" d="M23 55H85" stroke-width="3.4" stroke-linecap="round"/><path class="refl" d="M72.65 58.63A19 19 0 0 1 35.35 58.63" stroke-width="3.6" stroke-linecap="round" stroke-opacity=".42"/></svg>
  </button>
  <span class="rl-sep"></span>
  <button class="rl-btn" class:on={codex.view === 'threads'} data-view="threads" title={t('线程')} aria-label={t('线程')} aria-current={codex.view === 'threads' ? 'page' : undefined} onclick={() => setView('threads')}>
    <Icon name="msg" /><i class="rl-dot"></i>
  </button>
  {#each PAGES as p (p.v)}
    <button class="rl-btn" class:on={codex.view === p.v} data-view={p.v} title={p.label()} aria-label={p.label()} aria-current={codex.view === p.v ? 'page' : undefined} onclick={() => setView(p.v)}>
      <LottieIcon name={p.lot} icon={p.icon} />
    </button>
  {/each}
  <span class="rl-grow"></span>
  <button class="rl-btn rl-me" title={t('账号与额度')} aria-label={t('账号与额度')} aria-haspopup="menu" aria-expanded={cxPop.id === 'acct'} onclick={acct}>
    <span class="avatar">{initial}</span>
  </button>
</nav>
