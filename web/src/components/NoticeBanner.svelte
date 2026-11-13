<script>
  // 会话消息通知的前台横幅（lib/notices.svelte.js 的渲染层）：像微信 / iOS 那样从顶部滑下一张卡——
  // 左边会话头像（会话名首字），会话名、「在等你回答 / 已完成 / 出错了」、内容摘要；点一下打开那个会话，
  // 往上一划收起，5 秒后自己收。好几条同时来时最新的在最上面，后面的在底下露一道边。
  import { fly } from 'svelte/transition';
  import { cubicOut } from 'svelte/easing';
  import { banners, dismissBanner, openBanner } from '../lib/notices.svelte.js';
  import { t } from '../lib/i18n.js';

  const top = $derived(banners.list[0] || null);
  const behind = $derived(Math.min(2, Math.max(0, banners.list.length - 1)));

  // 会话头像：首字 + 按会话 id 取一种颜色（同一个会话永远同一色）
  const HUES = [18, 38, 152, 198, 222, 262, 330, 96];
  function hue(sid) { let h = 0; for (const c of String(sid || 'x')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return HUES[h % HUES.length]; }
  function initial(s) { const c = [...String(s || 'C').trim()][0] || 'C'; return c.toUpperCase(); }

  // 自动收起：成为最上面那张起算 5.5 秒；按住 / 悬停时暂停
  let hold = $state(false);
  $effect(() => {
    const k = top?.key;
    if (!k || hold) return;
    const timer = setTimeout(() => dismissBanner(k), 5500);
    return () => clearTimeout(timer);
  });

  // 上划收起
  let dy = $state(0);
  let startY = 0, startX = 0, pid = null, moved = false;
  function down(e) {
    pid = e.pointerId; startY = e.clientY; startX = e.clientX; moved = false; hold = true;
    try { e.currentTarget.setPointerCapture(pid); } catch {}
  }
  function move(e) {
    if (e.pointerId !== pid) return;
    const d = e.clientY - startY;
    if (Math.abs(d) > 6 || Math.abs(e.clientX - startX) > 6) moved = true;
    dy = d < 0 ? d : d * 0.25;   // 往下拉只给一点阻尼
  }
  function up(e) {
    if (e.pointerId !== pid) return;
    pid = null; hold = false;
    const b = top;
    if (b && dy < -28) { dy = 0; dismissBanner(b.key); return; }
    dy = 0;
    if (b && !moved) openBanner(b);
  }
  function cancel() { pid = null; hold = false; dy = 0; }
  function onKey(e) {
    if (!top) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openBanner(top); }
    else if (e.key === 'Escape') dismissBanner(top.key);
  }
</script>

{#if top}
  <div class="nb-wrap" role="status" aria-live="polite">
    {#key top.key}
      <div class="nb-stack" in:fly={{ y: -28, duration: 300, easing: cubicOut }} out:fly={{ y: -36, duration: 200, opacity: 0 }}>
        {#each Array(behind) as _, i (i)}<span class="nb-peek" style:--i={i + 1} aria-hidden="true"></span>{/each}
        <button type="button" class="nb-card" style:transform={dy ? `translateY(${dy}px)` : ''} class:drag={!!dy}
          aria-label={t('{title}：{label}，{body}。点按打开', { title: top.title, label: top.label, body: String(top.body || '').replace(/[。.!！?？]+$/, '') })}
          onpointerdown={down} onpointermove={move} onpointerup={up} onpointercancel={cancel} onkeydown={onKey}
          onmouseenter={() => { hold = true; }} onmouseleave={() => { if (pid == null) hold = false; }}>
          <span class="nb-av" style:--h={hue(top.sessionId || top.title)} aria-hidden="true">
            {#if top.sub === 'routine'}
              <svg viewBox="0 0 24 24" width="19" height="19" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="8.2" /><path d="M12 7.6V12l3 2" /></svg>
            {:else}{initial(top.title)}{/if}
            <i class="nb-dot k-{top.kind}"></i>
          </span>
          <span class="nb-main">
            <span class="nb-row"><span class="nb-title">{top.title}</span><span class="nb-when">{t('现在')}</span></span>
            <span class="nb-body"><span class="nb-lbl k-{top.kind}">{top.label}</span>{top.body}</span>
          </span>
        </button>
      </div>
    {/key}
  </div>
{/if}

<style>
  .nb-wrap {
    position: fixed; z-index: 4100; pointer-events: none;
    left: 8px; right: 8px; top: calc(var(--sat, 0px) + 8px);
    display: flex; justify-content: center;
  }
  @media (min-width: 760px) {
    .nb-wrap { left: auto; right: 16px; top: 52px; width: 372px; }
  }
  .nb-stack { --nb-bg: rgba(38, 36, 33, .94); position: relative; width: 100%; max-width: 520px; }
  .nb-peek {
    position: absolute; left: calc(var(--i) * 10px); right: calc(var(--i) * 10px); bottom: calc(var(--i) * -6px);
    height: 40px; border-radius: 18px; z-index: calc(3 - var(--i));
    background: color-mix(in srgb, var(--nb-bg) calc(100% - var(--i) * 18%), transparent);
    box-shadow: 0 4px 14px rgba(0, 0, 0, .16);
  }
  .nb-card {
    position: relative; z-index: 4; pointer-events: auto; touch-action: none;
    width: 100%; display: flex; align-items: flex-start; gap: 11px;
    padding: 11px 13px 12px; border: 0; border-radius: 18px; text-align: left; cursor: pointer;
    font: inherit; color: #f3eee4;
    background: var(--nb-bg);
    -webkit-backdrop-filter: blur(24px) saturate(1.5); backdrop-filter: blur(24px) saturate(1.5);
    box-shadow: 0 10px 34px rgba(0, 0, 0, .34), inset 0 0 0 .5px rgba(255, 255, 255, .09);
    transition: transform .22s cubic-bezier(.2, .9, .3, 1.15);
    -webkit-tap-highlight-color: transparent; user-select: none; -webkit-user-select: none;
  }
  .nb-card.drag { transition: none; }
  .nb-card:active { filter: brightness(.97); }
  .nb-card:focus-visible { outline: 2px solid color-mix(in srgb, #f3eee4 50%, transparent); outline-offset: 2px; }
  :global(html[data-theme="light"]) .nb-stack { --nb-bg: rgba(252, 250, 246, .95); }
  :global(html[data-theme="light"]) .nb-card { color: #1d1b18; box-shadow: 0 10px 34px rgba(40, 30, 10, .18), inset 0 0 0 .5px rgba(29, 27, 24, .08); }

  .nb-av {
    position: relative; flex: none; width: 40px; height: 40px; border-radius: 11px;
    display: grid; place-items: center; font-size: 17px; font-weight: 600; color: #fff;
    background: linear-gradient(155deg, hsl(var(--h) 52% 58%), hsl(var(--h) 48% 44%));
  }
  .nb-dot {
    position: absolute; right: -3px; bottom: -3px; width: 12px; height: 12px; border-radius: 50%;
    box-shadow: 0 0 0 2.5px var(--nb-bg);
  }
  .nb-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; padding-top: 1px; }
  .nb-row { display: flex; align-items: baseline; gap: 8px; }
  .nb-title { flex: 1; min-width: 0; font-size: 14.5px; font-weight: 600; line-height: 1.3; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .nb-when { flex: none; font-size: 11.5px; opacity: .5; }
  .nb-body {
    font-size: 13.5px; line-height: 1.38; opacity: .86;
    display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; word-break: break-word;
  }
  .nb-lbl { font-weight: 600; margin-right: 6px; }

  /* 类别色：等你（提问 / 权限）琥珀，完成绿，出错红，模型提醒珊瑚。类名是运行时拼的，挂 :global 免得被剪 */
  .nb-card :global(.k-question), .nb-card :global(.k-permission) { --k: #e0a63f; }
  .nb-card :global(.k-done) { --k: #6fbf83; }
  .nb-card :global(.k-error) { --k: #ec7a66; }
  .nb-card :global(.k-push) { --k: #e48a6a; }
  :global(html[data-theme="light"]) .nb-card :global(.k-question), :global(html[data-theme="light"]) .nb-card :global(.k-permission) { --k: #b0741c; }
  :global(html[data-theme="light"]) .nb-card :global(.k-done) { --k: #3f8a52; }
  :global(html[data-theme="light"]) .nb-card :global(.k-error) { --k: #c4473b; }
  :global(html[data-theme="light"]) .nb-card :global(.k-push) { --k: #c0603f; }
  .nb-dot { background: var(--k, #8aa0b8); }
  .nb-lbl { color: var(--k, inherit); }

  @media (prefers-reduced-motion: reduce) { .nb-card { transition: none; } }
</style>
