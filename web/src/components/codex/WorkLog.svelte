<script>
  // 一轮的工作记录（demo 的 class Log）。跑着时顶行是小球 + 「正在工作 · 0:12」，下面一条条长出来；
  // 跑完整段收成一行「工作了 1 分 12 秒 · 4 条命令 · 改了 3 个文件 +24 −6」，点开看完整记录。
  // 停了 / 出错的轮不收：你要看它停在哪一条。
  //
  // 小球（.ball data-s）：思考呼吸 think、跑命令压成闪烁的 `_` exec、等你批准停住 wait、开始回答时飞去回答开头 away，
  // 收尾变成 ✓ ok / × err / 停止方块 stop。ball 绑出去给回答那边做交接。
  import { onMount, untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import LogRow from './LogRow.svelte';
  import { t } from '../../lib/i18n.js';
  import { renderMarkdown } from '../../lib/md.js';
  import { turnSummary } from '../../lib/codex/turns.js';
  import { rolled, anim, EASE } from '../../lib/codex/motion.js';
  import { clock, cmdHead, summaryLine } from '../../lib/codex/thread/words.js';

  let { turn, sid = '', ask = null, ball = $bindable(null) } = $props();

  // 历史轮默认收着；停了、出错的默认摊开
  let open = $state(untrack(() => turn.status === 'stopped' || turn.status === 'error'));
  let everOpen = $state(untrack(() => turn.live || turn.status === 'stopped' || turn.status === 'error'));
  let ready = $state(false);       // 挂上之后才长出来的行才播「长出来」
  let thinkOpen = $state(false);
  let thinkEver = $state(false);
  let lblEl = $state(null);
  let sumEl = $state(null);

  onMount(() => { ready = true; });

  const done = $derived(!turn.live);
  $effect(() => { if (open || turn.live) everOpen = true; });
  $effect(() => { if (thinkOpen) thinkEver = true; });

  // 跑完那一刻：摘要淡入；正常完成的收起来，停了 / 出错的留着
  let wasLive = untrack(() => turn.live);
  $effect(() => {
    const live = turn.live;
    if (wasLive && !live) {
      open = turn.status === 'stopped' || turn.status === 'error';
      queueMicrotask(() => { if (sumEl) anim(sumEl, [{ opacity: 0, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }], { dur: 320, delay: 60 }); });
    }
    wasLive = live;
  });

  /* ---------------- 在跑时的顶行 ---------------- */

  const pending = $derived.by(() => {
    for (let i = turn.rows.length - 1; i >= 0; i--) {
      const r = turn.rows[i];
      if (r.status === 'run' || r.status === 'wait') return r;
    }
    return null;
  });

  const ballState = $derived.by(() => {
    if (!turn.live) return turn.status === 'error' ? 'err' : turn.status === 'stopped' ? 'stop' : 'ok';
    if (turn.status === 'ask') return 'wait';
    if (turn.status === 'write' && turn.shown !== 0 && turn.answer) return 'away';
    if (pending?.kind === 'cmd' && pending.status === 'run') return 'exec';
    return 'think';
  });

  const label = $derived.by(() => {
    if (turn.status === 'ask') return pending?.status === 'wait' || ask?.kind === 'perm' ? t('等你批准') : t('等你回答');
    if (turn.status === 'write' && turn.answer) return t('正在回答');
    if (pending?.kind === 'cmd') return t('正在运行 {cmd}', { cmd: cmdHead(pending.cmd) });
    if (pending?.kind === 'edit') return t('正在编辑 {name}', { name: pending.files?.[0]?.name || '' });
    if (pending?.kind === 'explore') return t('正在查看');
    if (!turn.rows.length) return t('正在思考');
    return t('正在工作');
  });
  const shimmer = $derived(turn.status !== 'ask');

  let lastLabel = '';
  $effect(() => {
    const l = label;
    if (lastLabel && l !== lastLabel && lblEl) anim(lblEl, [{ opacity: 0.2 }, { opacity: 1 }], { dur: 260 });
    lastLabel = l;
  });

  // 计时：只在跑着时走
  let now = $state(Date.now());
  $effect(() => {
    if (!turn.live) return;
    now = Date.now();
    const id = setInterval(() => { now = Date.now(); }, 250);
    return () => clearInterval(id);
  });
  const elapsed = $derived(clock(now - (turn.startedAt || now)));

  /* ---------------- 收起后的那一行 ---------------- */

  const sum = $derived(done ? summaryLine(turn.status, turnSummary(turn)) : null);

  function toggle() {
    if (!done) return;
    open = !open;
  }
  function onKey(e) {
    if (done && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(); }
  }
</script>

<div class="log" class:done class:open>
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="log-head" onclick={toggle} onkeydown={onKey} role={done ? 'button' : undefined} tabindex={done ? 0 : undefined} aria-expanded={done ? open : undefined}>
    <span class="ball" data-s={ballState} bind:this={ball}>
      <i></i>
      <svg class="mk ok" viewBox="0 0 14 14"><path d="M3 7.4l2.6 2.5L11 4.4" /></svg>
      <svg class="mk err" viewBox="0 0 14 14"><path d="M4 4l6 6M10 4l-6 6" /></svg>
      <svg class="mk stop" viewBox="0 0 14 14"><path d="M4.6 4.6h4.8v4.8H4.6z" /></svg>
    </span>
    <span class="log-live"><span class="lbl" class:shimmer bind:this={lblEl}>{label}</span> <span class="tm">· <span class="roll t" use:rolled={elapsed}></span></span></span>
    <span class="log-sum" bind:this={sumEl}>{#if sum}{sum.text}{#if sum.a != null}{' '}<span class="a">+{sum.a}</span> <span class="d">−{sum.d}</span>{/if}{/if}</span>
    <Icon name="chev" class="chev" />
  </div>
  <div class="log-body"><div><div class="log-items">
    {#if everOpen}
      {#if turn.thinking}
        <div class="row x" class:open={thinkOpen}>
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div class="row-line" role="button" tabindex="0" aria-expanded={thinkOpen} onclick={() => { thinkOpen = !thinkOpen; }} onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); thinkOpen = !thinkOpen; } }}>
            <span class="row-ico"><Icon name="eye" /></span>
            <span class="row-txt"><span class="v" class:shimmer={turn.live && turn.status === 'think'}>{t('思考')}</span></span>
            <span class="row-meta"></span>
            <Icon name="chev" class="row-chev" />
          </div>
          <div class="row-more"><div>{#if thinkEver}<div class="think-body md-lite">{@html renderMarkdown(turn.thinking)}</div>{/if}</div></div>
        </div>
      {/if}
      {#each turn.rows as row (row)}
        <LogRow {row} {turn} {sid} fresh={ready && turn.live} />
      {/each}
    {/if}
  </div></div></div>
</div>

<style>
  .log-sum .a { color: var(--add); }
  .log-sum .d { color: var(--del); }
  .log-sum { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .log-head { min-width: 0; }
  .log-live { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .log-live .roll.t { display: inline-flex; vertical-align: top; }
  .log-head:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
  /* 思考摘要：小一号的正文，粗体小标题单独成行（Codex 的摘要习惯写「**标题**」打头） */
  .md-lite :global(p) { margin: 0 0 6px; }
  .md-lite :global(p:last-child) { margin-bottom: 0; }
  .md-lite :global(strong) { font-weight: 500; color: var(--fg2); }
  .md-lite :global(code) { font: .9em var(--mono); }
</style>
