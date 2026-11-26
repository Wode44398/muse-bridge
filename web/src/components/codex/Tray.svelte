<script>
  // 托盘：官方那条压在输入栏后面的「文件夹标签」。左边 = 在哪跑（项目、运行环境、分支），
  // 右边 = 怎么跑、还剩多少（权限、上下文环）。每样只有一个入口：
  //   项目   首页点开换项目；线程里项目定了，点它在工作区打开项目文件
  //   环境 / 分支  只是写明白，不可点
  //   权限   平时安静，只有「完全访问」用官方警示色把字露出来；点开选档
  //   环     悬停露出百分比，超过 85% 一直露着并且呼吸；点开是用量卡
  import { t } from '../../lib/i18n.js';
  import Icon from './Icon.svelte';
  import { codex, current, projectOf, permOf } from '../../lib/codex/store.svelte.js';
  import { cxPop, togglePop } from '../../lib/codex/ui.svelte.js';
  import { rolled } from '../../lib/codex/motion.js';
  import { openCodexDock } from '../../lib/dock.svelte.js';

  let { onAddProject = null, ring = $bindable(null), projChip = $bindable(null) } = $props();

  const thread = $derived(current());
  const inThread = $derived(!!codex.sessionId);
  const proj = $derived(projectOf(inThread ? thread.projectId : codex.projectId));
  const projName = $derived(proj?.name || (inThread ? t('项目') : t('选择项目')));
  const branch = $derived(proj?.branch || '');
  const host = $derived(codex.host || proj?.host || '');
  const perm = $derived(permOf());
  const permLabel = $derived(perm === 'ask' ? t('每次询问') : perm === 'full' ? t('完全访问') : t('工作区内自动'));
  const pct = $derived(Math.round(thread.ctx?.pct || 0));
  const hot = $derived(pct >= 85);

  let wrap = $state(null);

  function onProj(e) {
    e.stopPropagation();
    if (inThread) { openCodexDock('files'); return; }
    if (!codex.projects.length && onAddProject) { onAddProject(); return; }
    togglePop('proj', e.currentTarget);
  }
  function onPerm(e) { e.stopPropagation(); togglePop('perm', e.currentTarget); }
  function onRing(e) { e.stopPropagation(); togglePop('usage', e.currentTarget); }

  // 名字放不下时右端淡出（滚动字是一串小格子，用不了省略号）。托盘本身不变宽、只是旁边的一颗被收起
  // （手机宽度藏掉「本地」那颗）时名字也会变得放得下：每个名字自己也盯着，宽度一变就重算
  let ro = null;
  function clipCheck() {
    requestAnimationFrame(() => wrap?.querySelectorAll('.tchip .t.roll').forEach((el) => {
      ro?.observe(el);
      el.classList.toggle('clip', el.scrollWidth > el.clientWidth + 1);
    }));
  }
  $effect(() => {
    if (!wrap) return;
    ro = new ResizeObserver(clipCheck);
    ro.observe(wrap);
    clipCheck();
    return () => { ro.disconnect(); ro = null; };
  });
  $effect(() => { void projName; void branch; clipCheck(); });
</script>

<div class="tray" bind:this={wrap}>
  <div class="tr-l">
    <button
      bind:this={projChip}
      type="button"
      class="tchip"
      id="tcProj"
      title={inThread ? t('在工作区打开项目文件') : t('换项目')}
      aria-expanded={cxPop.id === 'proj' ? 'true' : undefined}
      onclick={onProj}
    ><Icon name="folder" /><span class="t roll" use:rolled={projName}></span></button>
    <span class="tchip ro" id="tcEnv" title={host ? t('在 {host} 上本地运行', { host }) : t('在这台电脑上本地运行')}>
      <Icon name="laptop" /><span class="t">{t('本地')}{#if host}<span class="dim">{' · ' + host}</span>{/if}</span>
    </span>
    {#if branch}
      <span class="tchip ro" id="tcBranch" title={t('分支')}><Icon name="branch" /><span class="t roll" use:rolled={branch}></span></span>
    {/if}
  </div>
  <div class="tr-r">
    <button
      type="button"
      class="tchip perm"
      id="tcPerm"
      data-perm={perm}
      title={t('权限：{p}', { p: permLabel })}
      aria-label={t('权限：{p}', { p: permLabel })}
      aria-expanded={cxPop.id === 'perm' ? 'true' : undefined}
      onclick={onPerm}
    ><Icon name={perm === 'full' ? 'shield-warn' : 'shield'} /><span class="t">{permLabel}</span></button>
    <button
      bind:this={ring}
      type="button"
      class="tchip ring-btn"
      class:hot
      id="usage"
      title={hot ? t('上下文已用 {p}%，快满了——点开可以压缩', { p: pct }) : t('上下文已用 {p}%', { p: pct })}
      aria-label={t('上下文与额度')}
      aria-expanded={cxPop.id === 'usage' ? 'true' : undefined}
      onclick={onRing}
    >
      <span class="ring"><svg viewBox="0 0 16 16" aria-hidden="true"><circle class="t" cx="8" cy="8" r="6.2" /><circle class="v" cx="8" cy="8" r="6.2" pathLength="100" stroke-dasharray="{pct} 100" /></svg></span>
      <span class="pct roll" use:rolled={pct + '%'}></span>
    </button>
  </div>
</div>
