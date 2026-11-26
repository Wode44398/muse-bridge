<script>
  // 首页（新线程）：只有标志和一句话，输入栏一直在底部（方案第十五节第 7 条）。
  // 那句话照官方措辞「你想让我们在 <项目> 中构建什么？」，项目名是虚线下划线的按钮，点开换项目（页面级弹层 proj）；
  // 换项目时名字只滚变了的字、标志点一下头。还没有项目时这句话换成「先添加一个项目」，点它就是添加项目。
  // 从线程回到首页时标志从 0.9 轻轻弹回、那句话晚 70ms 上浮（首次进页不演，页面自己有进场）。
  import { onMount, untrack } from 'svelte';
  import { t } from '../../lib/i18n.js';
  import { codex, projectOf } from '../../lib/codex/store.svelte.js';
  import { cxPop, togglePop } from '../../lib/codex/ui.svelte.js';
  import { anim, EASE, rolled, reduced } from '../../lib/codex/motion.js';
  import { heroRef } from '../../lib/codex/chrome/hero.js';
  import CodexLogo from './CodexLogo.svelte';

  let { onAddProject = null } = $props();

  let heroEl = $state(null);
  let logoEl = $state(null);
  let logo = $state(null);
  let h1El = $state(null);

  const project = $derived(projectOf(codex.projectId));
  const hasProjects = $derived(codex.projects.length > 0);
  // 句子里的项目名占位：整句交给字典（英文语序不同），按 {project} 切成前后两段，中间放按钮
  const parts = $derived(t('你想让我们在 {project} 中构建什么？').split('{project}'));

  function pick(e) {
    e.stopPropagation();
    togglePop('proj', e.currentTarget);
  }

  // 换项目：点一下头（第一次读到的值不算）
  let lastProject = untrack(() => codex.projectId);
  $effect(() => {
    const id = codex.projectId;
    if (id === lastProject) return;
    lastProject = id;
    if (id) untrack(() => logo?.nod());
  });

  onMount(() => {
    heroRef.hero = heroEl;
    heroRef.logo = logoEl;
    heroRef.nod = () => logo?.nod();
    if (entered && !reduced() && logoEl) {
      const op = getComputedStyle(logoEl).opacity;
      anim(logoEl, [{ opacity: 0, transform: 'scale(.9)' }, { opacity: op, transform: 'none' }], { dur: 460, ease: EASE.soft });
      anim(h1El, [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }], { dur: 420, delay: 70 });
    }
    entered = true;
    return () => {
      if (heroRef.hero === heroEl) { heroRef.hero = null; heroRef.logo = null; heroRef.nod = null; }
    };
  });
</script>

<script module>
  // 同一次页面生命周期里首页第二次出现才演进场（模块级：Home 每次回首页都会重挂）
  let entered = false;
</script>

<section class="home">
  <div class="hero" bind:this={heroEl}>
    <CodexLogo bind:this={logo} bind:el={logoEl} />
    {#if !codex.booted && !hasProjects}
      <div class="wait h1" bind:this={h1El} aria-hidden="true">&nbsp;</div>
    {:else if !hasProjects}
      <h1 bind:this={h1El}><button class="proj-pick" onclick={() => onAddProject?.()}>{t('先添加一个项目')}</button></h1>
    {:else}
      <h1 bind:this={h1El}>{parts[0]}<button class="proj-pick" aria-haspopup="menu" aria-expanded={cxPop.id === 'proj'} aria-label={t('换项目：{name}', { name: project?.name || '' })} onclick={pick}><span class="roll" use:rolled={project?.name || t('选一个项目')}></span></button>{parts[1] ?? ''}</h1>
    {/if}
  </div>
</section>

<style>
  /* 还没拿到项目列表时占住标题那一行的高度（不读出来，免得屏幕阅读器念一个空标题） */
  .hero .h1 { margin: 0; font-size: 26px; line-height: 1.3; }
  @container cx (max-width: 640px) { .hero .h1 { font-size: 22px; } }
</style>
