<script>
  // 消息底部运行状态栏：左侧 Antigravity 液态动效标记，右侧「时长 · tokens · 正在做什么」；
  // 跑完回归静止的 Antigravity 图标并只留「时长 · tokens」（仅停止 / 出错保留第三段状态提示）。只挂在最后一条助手消息上。
  import { onDestroy, untrack } from 'svelte';
  import { fmtElapsed, fmtTokens } from '../../lib/format.js';
  import {
    computeDoing, computeDid, turnTokens, turnElapsed, TEXT_HOLD_MS, MARK_HOLD_MS,
  } from '../../lib/agy/run-status.js';
  import { t } from '../../lib/i18n.js';
  import { toggleAgyTheme, agyIsDark } from '../../lib/agy/theme-toggle.js';
  import AgyWorkingMark from './AgyWorkingMark.svelte';
  import AgyRoll from './AgyRoll.svelte';

  const { msg, sessionCwd = '', reconnecting = false } = $props();

  const live = $derived(msg?.status === 'streaming');

  let now = $state(Date.now());
  let doing = $state(null);   // 正在显示的 { mark, text }
  let textAt = 0;
  let mark = $state(untrack(() => (msg?.status === 'streaming' ? 'waiting' : 'static')));
  let markAt = 0;
  let timer = null;
  let settleTimer = null;

  function clearSettle() {
    clearTimeout(settleTimer);
    settleTimer = null;
  }

  // 每 200ms 推进一次：文案与标记各有最短停留，换得太勤的中间态直接跳过
  function step() {
    if (msg?.status !== 'streaming') return;
    const n = Date.now();
    now = n;
    const want = computeDoing(msg, { sessionCwd, reconnecting });
    if (!doing || (want.text !== doing.text && n - textAt >= TEXT_HOLD_MS)) {
      doing = want;
      textAt = n;
    }
    if (want.mark !== mark && n - markAt >= MARK_HOLD_MS) {
      mark = want.mark;
      markAt = n;
    }
  }

  // 引擎收尾动效（success / error）播完自动落回 static 时同步更新 mark，避免长期滞留运行态
  function onMarkState(stateName) {
    if (!live && stateName === 'static') {
      clearSettle();
      if (mark !== 'static') mark = 'static';
    }
  }

  let prevLive = untrack(() => live);
  $effect(() => {
    const isLive = live;
    const st = msg?.status;
    untrack(() => {
      if (isLive) {
        clearSettle();
        step();
        clearInterval(timer);
        timer = setInterval(step, 200);
      } else {
        clearInterval(timer);
        timer = null;
        now = Date.now();
        // 只在亲眼看着它跑完时播一次收尾动效，随后（引擎回调或兜底超时）回归静止的 AGY 图标；打开历史直接静止
        if (prevLive && (st === 'done' || st === 'error')) {
          mark = st === 'done' ? 'success' : 'error';
          clearSettle();
          settleTimer = setTimeout(() => {
            settleTimer = null;
            if (!live) mark = 'static';
          }, 1400);
        } else if (!settleTimer && mark !== 'static') {
          mark = 'static';
        }
      }
      prevLive = isLive;
    });
  });
  onDestroy(() => {
    clearInterval(timer);
    clearSettle();
  });

  const elapsed = $derived(turnElapsed(msg, now));
  const tokens = $derived.by(() => { void now; return turnTokens(msg); });
  const did = $derived(live ? '' : computeDid(msg));
  const head = $derived.by(() => {
    if (live && reconnecting) return '';
    const parts = [];
    if (elapsed !== null) parts.push(fmtElapsed(elapsed));
    if (live || tokens > 0) parts.push(fmtTokens(tokens) + ' tokens');
    return parts.join(' · ');
  });
  // 第三段：跑着时是「正在做什么」，跑完后仅停止 / 出错才显示简短状态提示
  const hintText = $derived(live ? (doing?.text || '') : did);
  const hintKey = $derived((live ? 'l:' : 'd:') + hintText);
  const markGlow = $derived(live ? 'subtle' : 'none');
  const themeLabel = $derived(agyIsDark() ? t('切换浅色主题') : t('切换深色主题'));
</script>

<div class="agy-turn-foot" class:live>
  <!-- hero=foot：欢迎页那颗 logo 发出第一条消息时飞进这里（lib/agy/hero.js）；点它即可丝滑切换明暗 -->
  <AgyWorkingMark
    {mark}
    size={22}
    hero="foot"
    glow={markGlow}
    interactive
    onpress={(el) => toggleAgyTheme(el)}
    onstate={onMarkState}
    label={themeLabel}
  />
  <span class="meta">
    {#if head}<span class="nums">{head}</span>{/if}
    {#if hintText}
      {#if head}<span class="dot">·</span>{/if}
      <AgyRoll key={hintKey} class="hint-roll">
        <span class="hint" class:shimmer={live} class:err={!live && msg?.status === 'error'}>{hintText}</span>
      </AgyRoll>
    {/if}
  </span>
</div>

<style>
  .agy-turn-foot {
    display: flex;
    align-items: center;
    gap: 9px;
    min-height: 26px;
    margin-top: 12px;
  }
  /* 一行到底：前两段数字不缩，第三段占剩下的宽度，放不下时尾部省略（手机上不折行） */
  .meta {
    display: flex;
    flex: 1 1 auto;
    align-items: baseline;
    gap: 0 6px;
    min-width: 0;
    color: var(--ag-on-dim);
    font-size: 13px;
    line-height: 1.4;
  }
  .nums { flex: none; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .dot { flex: none; opacity: 0.7; }
  .meta :global(.hint-roll) { flex: 0 1 auto; }
  .hint {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .hint.err { color: var(--ag-err, #f28b82); }
  /* 进行中：一道浅色高光从左往右扫过文字（Gemini 系的流光字），换文案时淡入 */
  .hint.shimmer {
    color: transparent;
    background: linear-gradient(
      100deg,
      var(--ag-on-dim) 0%,
      var(--ag-on-dim) 38%,
      var(--ag-on) 50%,
      var(--ag-on-dim) 62%,
      var(--ag-on-dim) 100%
    );
    background-size: 250% 100%;
    background-clip: text;
    -webkit-background-clip: text;
    animation: agy-foot-sweep 2.2s linear infinite;
  }
  @keyframes agy-foot-sweep {
    from { background-position: 100% 0; }
    to { background-position: -150% 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    .hint.shimmer { animation: none; color: var(--ag-on-dim); background: none; }
  }
</style>
