<script>
  // 窄栏「定时任务」：就是 bridge 的定时任务（Routines，同一份数据、同一个开关接口），不另起一套。
  // 工作文件夹落在某个 Codex 项目里的排在前面（同一个仓库），其余放在「其它」。开关是真的：乐观切换、失败回滚并就地写原因。
  // 定时任务的执行者目前只有 Claude 和 dimensio（服务端 routines 没有 codex 引擎），这里如实写出来，不假装能让 Codex 跑。
  import { onMount } from 'svelte';
  import { t, tr } from '../../../lib/i18n.js';
  import { api } from '../../../lib/api.js';
  import { ui, pluginOn, screenOn, hostIsServer } from '../../../lib/state.svelte.js';
  import { goto } from '../../../lib/pageMorph.js';
  import { isPageWindow } from '../../../lib/windowPage.svelte.js';
  import { rt, loadRoutines, schedText, whenText, folderName } from '../../../lib/routines.svelte.js';
  import { codex } from '../../../lib/codex/store.svelte.js';
  import { anim, EASE, reduced } from '../../../lib/codex/motion.js';
  import { splitRoutines } from '../../../lib/codex/chrome/logic.js';
  import Icon from '../Icon.svelte';

  let inEl = $state(null);
  let err = $state('');
  let busy = $state(new Set());

  const on = $derived(pluginOn('routines'));
  const canOpenAll = $derived(on && screenOn('claude') && !isPageWindow());
  const split = $derived(splitRoutines(rt.items, codex.projects));
  const groups = $derived(split.inProject.length
    ? [{ cap: t('在 Codex 项目里'), rows: split.inProject }, ...(split.other.length ? [{ cap: t('其它'), rows: split.other }] : [])]
    : split.other.length ? [{ cap: '', rows: split.other }] : []);

  const done = (r) => r.schedule?.type === 'once' && !r.nextRun && r.lastRun;
  const switchable = (r) => r.schedule?.type !== 'manual' && !done(r);
  const engine = (r) => (r.agent === 'dimensio' ? 'dimensio' : 'Claude');
  function sideText(r) {
    if (r.schedule?.type === 'manual') return t('仅手动');
    if (done(r)) return t('已运行');
    if (r.enabled === false) return t('已暂停');
    return r.nextRun ? t('下次 {when}', { when: whenText(r.nextRun) }) : '';
  }
  function subText(r, project) {
    const where = project ? project.name : (r.cwd ? folderName(r.cwd) : t('默认工作空间'));
    return [schedText(r.schedule), where, engine(r)].filter(Boolean).join(' · ');
  }

  async function toggle(r) {
    if (busy.has(r.id)) return;
    const next = r.enabled === false;
    const i = rt.items.findIndex((x) => x.id === r.id);
    const prev = rt.items[i];
    if (i >= 0) rt.items[i] = { ...prev, enabled: next };
    busy = new Set([...busy, r.id]);
    err = '';
    try {
      const res = await api.updateRoutine({ id: r.id, enabled: next });
      if (res && res.ok === false) throw { body: res };
      await loadRoutines();
    } catch (e) {
      const j = rt.items.findIndex((x) => x.id === r.id);
      if (j >= 0) rt.items[j] = prev;
      const why = e?.body?.error ? tr(e.body.error) : hostIsServer() ? t('连不上服务器，请重试') : t('连不上电脑，请重试');
      err = next ? t('没能启用「{name}」：{why}', { name: r.name, why }) : t('没能暂停「{name}」：{why}', { name: r.name, why });
    } finally {
      const s = new Set(busy); s.delete(r.id); busy = s;
    }
  }

  async function openAll() {
    await goto('claude');
    ui.routinesOpen = true;
  }

  onMount(() => {
    if (on) loadRoutines();
    if (!reduced() && inEl) [...inEl.children].forEach((el, i) => anim(el, [{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { dur: 380, delay: i * 40, ease: EASE.out }));
  });
</script>

<div class="pg-in" bind:this={inEl}>
  <div class="pg-hd">
    <div class="t">
      <h2>{t('定时任务')}</h2>
      <p>{t('到点自动开一个会话去做，跑完通知你。和 bridge 的定时任务是同一套。')}</p>
    </div>
    {#if canOpenAll}<button class="tbtn pri" onclick={openAll}>{t('打开定时任务')}</button>{/if}
  </div>

  {#if !on}
    <p class="pg-note">{t('这台服务器关掉了定时任务功能。')}</p>
  {:else if rt.err && !rt.loaded}
    <div class="pg-list sq"><div class="pg-row"><span class="ic sq"><Icon name="warn" /></span><span class="tx"><b>{t('定时任务没读出来')}</b><span>{hostIsServer() ? t('连不上服务器，请重试') : t('连不上电脑，请重试')}</span></span><button class="tbtn" onclick={() => loadRoutines()}>{t('重试')}</button></div></div>
  {:else if !rt.loaded}
    <p class="pg-note">{t('正在读取…')}</p>
  {:else if !groups.length}
    <div class="pg-list sq"><div class="pg-row"><span class="ic sq"><Icon name="clock" /></span><span class="tx"><b>{t('还没有定时任务')}</b><span>{t('在定时任务页里新建一个，到点就会自动跑')}</span></span></div></div>
  {:else}
    {#each groups as g (g.cap)}
      {#if g.cap}<div class="pg-cap">{g.cap}</div>{/if}
      <div class="pg-list sq">
        {#each g.rows as { routine: r, project } (r.id)}
          <div class="pg-row" class:off={r.enabled === false}>
            <span class="ic sq"><Icon name="clock" /></span>
            <span class="tx"><b>{r.name || t('未命名任务')}</b><span>{subText(r, project)}</span></span>
            <span class="side">{sideText(r)}</span>
            {#if switchable(r)}
              <button class="sw" role="switch" aria-checked={r.enabled !== false} disabled={busy.has(r.id)}
                title={r.enabled === false ? t('启用定时任务') : t('暂停定时任务')} aria-label={r.name} onclick={() => toggle(r)}></button>
            {/if}
          </div>
        {/each}
      </div>
    {/each}
  {/if}
  {#if err}<p class="pg-err" role="alert"><Icon name="warn" />{err}</p>{/if}
  {#if on}<p class="pg-note">{t('执行者目前是 Claude 或 dimensio；Codex 还不能被定时任务调起。')}</p>{/if}
</div>

<style>
  .pg-note { margin: 14px 4px 0; color: var(--fg3); font-size: 12.5px; line-height: 1.55; }
  .pg-err { display: flex; gap: 7px; align-items: flex-start; margin: 12px 4px 0; color: var(--fg2); font-size: 12.5px; line-height: 1.5; }
  .pg-err :global(svg) { width: 15px; height: 15px; margin-top: 2px; flex: none; color: var(--warn); }
  .sw[disabled] { opacity: .6; cursor: default; }
</style>
