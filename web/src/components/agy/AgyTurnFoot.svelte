<script>
  // 消息底部运行状态栏：左侧 Antigravity 液态动效标记，右侧「时长 · tokens · 正在做什么」；
  // 跑完回归静止的 Antigravity 图标并只留「时长 · tokens」（仅停止 / 出错保留第三段状态提示）。只挂在最后一条助手消息上。
  // 这一轮说完了、后台还挂着东西在跑（转入后台的命令、定时任务、子代理）：标志停在等待形态（端正的拱原地浮沉），
  // 第三段写「后台任务在跑 · 已跑 4m12s · 在跑什么」，点它打开代理面板；15 分钟没动静时标志停住、字变黄。
  import { onDestroy, untrack } from 'svelte';
  import { fmtElapsed, fmtTokens } from '../../lib/format.js';
  import {
    computeDoing, computeDid, turnTokens, turnElapsed, TEXT_HOLD_MS, MARK_HOLD_MS,
    computeBgWait, fmtSpan, fmtLeft,
  } from '../../lib/agy/run-status.js';
  import { openAgyAgentsPanel } from '../../lib/dock.svelte.js';
  import { t } from '../../lib/i18n.js';
  import { toggleAgyTheme, agyIsDark } from '../../lib/agy/theme-toggle.js';
  import AgyWorkingMark from './AgyWorkingMark.svelte';
  import AgyRoll from './AgyRoll.svelte';

  // bgTree：当前会话的子代理树（含主会话挂着的后台任务）；只有最后一条助手消息会收到
  const { msg, sessionCwd = '', reconnecting = false, bgTree = null } = $props();

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

  // 后台在跑：等待形态；没动静了：停住（动 = 还活着）
  let bgNow = $state(Date.now());
  const bg = $derived(!live && bgTree && msg?.status !== 'error' ? computeBgWait(bgTree, bgNow) : null);
  const bgStalled = $derived(Boolean(bg && bg.stallMs > 0));
  const restMark = $derived(bg && !bgStalled ? 'waiting' : 'static');

  // 引擎收尾动效（success / error）播完自动落回 static 时同步更新 mark，避免长期滞留运行态
  function onMarkState(stateName) {
    if (!live && stateName === 'static') {
      clearSettle();
      if (mark !== restMark) mark = restMark;
    }
  }

  // 后台在跑时每秒走一次秒表（页面藏起来就不走）
  $effect(() => {
    if (live || !bgTree?.hasActive) return;
    bgNow = Date.now();
    const id = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) bgNow = Date.now();
    }, 1000);
    return () => clearInterval(id);
  });

  // 跑完后（收尾动效之外）标志跟着后台状态走：开始等 → 等待形态，等完 / 没动静 → 静止
  $effect(() => {
    const want = restMark;
    if (live) return;
    untrack(() => {
      if (!settleTimer && mark !== want) mark = want;
    });
  });

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
            if (!live) mark = restMark;
          }, 1400);
        } else if (!settleTimer && mark !== restMark) {
          mark = restMark;
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
  // 第三段：跑着时是「正在做什么」，跑完后仅停止 / 出错才显示简短状态提示；后台还在跑时换成后台状态（见下）
  const hintText = $derived(live ? (doing?.text || '') : did);
  const hintKey = $derived(bg ? `b:${bg.kind}:${bgStalled ? 's' : ''}` : (live ? 'l:' : 'd:') + hintText);
  const bgLabel = $derived.by(() => {
    if (!bg) return '';
    if (!bgStalled) return bg.label;
    const d = fmtLeft(bg.stallMs);
    return bg.kind === 'team' ? t('后台 {d}没有动静', { d }) : t('后台任务 {d}没有新输出', { d });
  });
  const bgSince = $derived.by(() => {
    if (!bg || !bg.since || bgStalled) return '';
    const d = fmtSpan(bgNow - bg.since);
    return bg.kind === 'team' ? t('已等 {d}', { d }) : t('已跑 {d}', { d });
  });
  // 手机上一行放不下时只留时长本身
  const bgSinceShort = $derived(bgSince && bg?.since ? fmtSpan(bgNow - bg.since) : '');
  const bgTitle = $derived(bg ? [bg.detail, bg.tail ? t('最近输出：{line}', { line: bg.tail }) : ''].filter(Boolean).join(String.fromCharCode(10)) : '');
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
    {#if bg}
      {#if head}<span class="dot">·</span>{/if}
      <AgyRoll key={hintKey} class="hint-roll">
        <button type="button" class="bg-hint" class:warn={bgStalled} title={bgTitle} onclick={() => openAgyAgentsPanel()}>
          <span class="hint bg-lbl" class:shimmer={!bgStalled}>{bgLabel}</span>
          {#if bgSince}<span class="dot">·</span><span class="bg-since long">{bgSince}</span><span class="bg-since short">{bgSinceShort}</span>{/if}
          {#if bg.detail}<span class="dot bg-ddot">·</span><span class="hint bg-detail">{bg.detail}</span>{/if}
          <span class="msr bg-chev" aria-hidden="true">expand_more</span>
        </button>
      </AgyRoll>
    {:else if hintText}
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
  /* 后台还在跑：整段是一个按钮（打开代理面板），说明部分放不下时尾部省略 */
  .bg-hint {
    display: flex;
    align-items: baseline;
    gap: 0 6px;
    min-width: 0;
    max-width: 100%;
    margin: -2px 0 -2px -6px;
    padding: 2px 4px 2px 6px;
    border-radius: 7px;
    color: inherit;
    font: inherit;
    text-align: left;
    transition: background var(--ag-dur-micro, 140ms) var(--ag-ease-std, ease);
  }
  .bg-hint:hover { background: var(--ag-hover); }
  .bg-hint:hover .bg-detail { color: var(--ag-on-sub); }
  .bg-lbl { flex: none; }
  .bg-since { flex: none; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .bg-since.short { display: none; }
  .bg-detail { flex: 0 1 auto; }
  .bg-hint.warn, .bg-hint.warn .bg-lbl { color: var(--ag-warn); }
  /* 手机上一行放不下：说明和箭头让位，留「后台任务在跑 · 已跑 5m55s」 */
  @media (max-width: 560px) {
    .bg-ddot, .bg-detail, .bg-chev, .bg-since.long { display: none; }
    .bg-since.short { display: inline; }
  }
  .bg-chev {
    flex: none;
    align-self: center;
    font-size: 15px;
    transform: rotate(-90deg);
    color: var(--ag-on-faint);
  }
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
