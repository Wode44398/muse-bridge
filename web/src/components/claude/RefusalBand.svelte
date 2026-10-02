<script>
  // 输入栏上方的「已切换到 X」横条——官方 /code 页 composer aux band（_R，fallback-banner.md §2.2）。
  // 数据源 state.refusalBand.notice（chat 内核维护：最新一条 scope=session 的 model_refusal_fallback，
  // 新消息发出/切会话/回滚即置 null；本组件只读它，X 只把 dismissed 标 true）。
  // notice 为空 / 已 dismiss / 不是当前会话的 → 什么都不渲染（ClaudePage 的 .band-slot 靠 :has() 判空收起）。
  // 动作：Why?（弹层：Switched to X + 解释 + Details）、Edit prompt and retry with {原模型}
  // （refusalRetry.retryRefused：回滚到被拒消息 + 切回原模型 + 原文填回输入框，成功时内核已清 notice）、X。
  // 不做官方的「Don't switch models automatically」（bridge 聊天轮一律先暂停问人，见下）。
  //
  // 同一槽位的另一种形态：Paused 卡（claude.ai 的 Paused 卡 / 官方 /code 的 refusal_fallback_prompt 对话框 aR）。
  // 聊天轮不再自动切模型：被拒时本轮停在原地（state.refusalBand.prompt），卡上二选一——
  // 「Edit prompt and retry with {原模型}」「Switch to {回退模型}」，X = 不选（按经典拒答收尾）。
  // 文案是 CLI 同款（O2e：flagged 句 + Opus 5.5 专属的暂停引导句 + Learn more + Details），官方桌面端的
  // 对应文案是服务端下发的 secret id、bundle 里没有原文。有 prompt 时横条让位。
  import { refusalBand, session } from '../../lib/state.svelte.js';
  import { pushBackLayer } from '../../lib/nav.js';
  import { modelLabel, learnMoreUrl } from '../../lib/toolVerbs.js';
  import { glyph } from '../../lib/claudeIcons.js';
  import { onMdClick } from '../../lib/linkNav.js';

  let { sessionId = null } = $props();

  // —— Paused 卡 ——（只在这一轮还活着时显示：切到别的会话再回来，attach 重放会把仍在等的卡重建）
  const p = $derived(refusalBand.prompt);
  const paused = $derived(!!p && session.busy && (p.sessionId || '') === (sessionId || ''));
  // 按钮上只要模型名：剥掉 [1m]（否则读成「Fable 5.1 1M」）
  const bareId = (id) => String(id || '').replace(/\[1m\]$/i, '');
  const pFrom = $derived(p ? (modelLabel(bareId(p.from)) || bareId(p.from) || 'This model') : '');
  const pTo = $derived(p ? (modelLabel(bareId(p.to)) || bareId(p.to) || 'the fallback model') : '');
  // CLI Hxe/Bv/jj：Opus 5.5 在 cyber/bio/frontier_llm 类别下有专属说明 + 「Edit and retry, or continue with X.」；
  // 其余模型 cyber/bio 用「intentionally broad safeguards」句，别的类别用「safe, normal conversations」句。
  const OPUS55_TAIL = { cyber: ', which can sometimes flag non-cybersecurity work', bio: ', which can sometimes flag biology-research-adjacent work', frontier_llm: '' };
  const pCopy = $derived.by(() => {
    if (!p) return { body: '', recovery: '' };
    const cat = String(p.category || '').toLowerCase();
    const bare = String(p.from || '').toLowerCase().replace(/\[[^\]]+\]$/, '');
    if (/^claude-opus-5-5(-\d{8})?$/.test(bare) && Object.hasOwn(OPUS55_TAIL, cat)) {
      return {
        body: `${pFrom}'s safeguards flagged this session. You may be seeing this for the first time on an Opus model: ${pFrom} is more capable and has stronger safeguards as a result${OPUS55_TAIL[cat]}. We're improving these safeguards to reduce the amount of incorrectly flagged messages.`,
        recovery: `Edit and retry, or continue with ${pTo}.`,
      };
    }
    if (cat === 'cyber' || cat === 'bio') {
      return { body: `${pFrom}'s safeguards flagged this message. Our intentionally broad safeguards allow us to deliver more capabilities faster, but can sometimes flag legitimate ${cat === 'cyber' ? 'coding and cybersecurity' : 'biology'} tasks.`, recovery: '' };
    }
    return { body: `${pFrom}'s safeguards flagged this message. This sometimes happens with safe, normal conversations.`, recovery: '' };
  });
  const pLearn = $derived(p ? learnMoreUrl(p.from, p.category) : '');
  const pBusy = $derived(!!p && !!p.busy);

  async function choose(choice) {
    if (!p || p.busy) return;
    try {
      const m = await import('../../lib/refusalRetry.js').catch(() => null);
      if (m) await m.answerRefusalPrompt(p, choice);
    } catch {}
  }

  const n = $derived(refusalBand.notice);
  const show = $derived(!paused && !!n && !n.dismissed && (n.sessionId || '') === (sessionId || ''));
  const to = $derived(n ? (modelLabel(n.to) || n.to || 'the fallback model') : '');
  const from = $derived(n ? (modelLabel(n.from) || n.from || 'This model') : '');
  // 弹层正文：CLI 给的解释文优先；否则复用通知文本里「Switched to」之前的部分——CLI 已按类别选好句子
  //（cyber/bio 是「intentionally broad safeguards…」，其余是「safe, normal conversations」），与紧挨着的时间线卡
  // 同源，两处不再自相矛盾；没有 text 时才按类别拼官方那两句兜底。
  const BROAD = 'Our intentionally broad safeguards allow us to deliver more capabilities faster, but can sometimes flag legitimate coding, cybersecurity, and biology tasks.';
  const whyBody = $derived.by(() => {
    if (!n) return '';
    if (n.explanation) return String(n.explanation);
    const t = String(n.text || '');
    const i = t.indexOf('Switched to');
    const lead = (i > 0 ? t.slice(0, i) : '').trim();
    if (lead) return lead;
    const cat = String(n.category || '').toLowerCase();
    return `${from}'s safeguards flagged this message. ${cat === 'cyber' || cat === 'bio' ? BROAD : 'This sometimes happens with safe, normal conversations.'}`;
  });

  let why = $state(false);
  let busy = $state(false);
  let root = $state(null);
  let whyBtn = $state(null);
  let pop = $state(null);
  let popLeft = $state(0);

  // 弹层锚定（官方 Popover side=top align=end）：右缘对齐「Why?」触发器的右缘，越出横条左缘就贴到 0；
  // 横条宽度不够时整体靠右缘收
  $effect(() => {
    if (!why || !root || !whyBtn || !pop) return;
    const br = root.getBoundingClientRect(), wb = whyBtn.getBoundingClientRect();
    const pw = pop.offsetWidth || 0;
    popLeft = Math.max(0, Math.min(wb.right - br.left - pw, br.width - pw));
  });

  // 横条一收起弹层跟着关；弹层开着时接进系统返回键（后开先关），点外面 / Esc 也关
  $effect(() => { if (!show) why = false; });
  $effect(() => { if (why) return pushBackLayer(() => { why = false; }); });
  $effect(() => {
    if (!why) return;
    const onDown = (e) => { if (root && !root.contains(e.target)) why = false; };
    const onKey = (e) => { if (e.key === 'Escape') why = false; };
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('pointerdown', onDown, true); window.removeEventListener('keydown', onKey); };
  });

  async function retry() {
    if (busy || !n) return;
    busy = true;
    try {
      const m = await import('../../lib/refusalRetry.js').catch(() => null);
      if (m) await m.retryRefused(n);
    } catch {} finally { busy = false; }
  }
  function dismiss() { why = false; if (n) n.dismissed = true; }
</script>

{#if paused}
  <!-- 点击只做链接分流（linkNav：桌面壳外链交系统浏览器） -->
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="pz" role="alertdialog" aria-labelledby="pz-title" aria-describedby="pz-body" tabindex="-1" onclick={onMdClick}>
    <div class="pz-head">
      <span class="pz-title" id="pz-title">Session paused</span>
      <button type="button" class="band-x" aria-label="Dismiss" title="Dismiss" disabled={pBusy} onmousedown={(e) => e.preventDefault()} onclick={() => choose('cancelled')}>
        <span class="gi" aria-hidden="true">{glyph('X')}</span>
      </button>
    </div>
    <div class="pz-body sel-text" id="pz-body">
      {pCopy.body}{#if pCopy.recovery}{' '}{pCopy.recovery}{/if}
      {#if pLearn}{' '}<a href={pLearn} target="_blank" rel="noopener noreferrer">Learn more</a>{/if}
      {#if p.category}<span class="why-d">Details: <code>[{p.category}]</code></span>{/if}
    </div>
    <div class="pz-actions">
      <button type="button" class="pz-btn" disabled={pBusy} onclick={() => choose('edit_prompt')}>Edit prompt and retry with {pFrom}</button>
      <button type="button" class="pz-btn" disabled={pBusy} onclick={() => choose('retry_fallback')}>Switch to {pTo}</button>
    </div>
  </div>
{:else if show}
  <div class="band" role="status" aria-live="polite" bind:this={root}>
    <div class="band-main">
      <span class="band-msg">Switched to {to}</span>
      <span class="band-cta">
        <button type="button" class="lnk" aria-expanded={why} aria-haspopup="dialog" bind:this={whyBtn} onclick={() => { why = !why; }}>Why?</button>
        <button type="button" class="lnk" disabled={busy} onclick={retry}>Edit prompt and retry with {from}</button>
      </span>
    </div>
    <button type="button" class="band-x" aria-label="Dismiss" onmousedown={(e) => e.preventDefault()} onclick={dismiss}>
      <span class="gi" aria-hidden="true">{glyph('X')}</span>
    </button>
    {#if why}
      <div class="why-pop" role="dialog" aria-label="Why the model switched" bind:this={pop} style:left={popLeft + 'px'}>
        <span class="why-h">Switched to {to}</span>
        <span class="why-b sel-text">{whyBody}</span>
        {#if n.category}<span class="why-d">Details: <code>[{n.category}]</code></span>{/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* 官方 epitaxy-composer-aux-view：min-h 40 / p8 / r10 / 底 --t1 / 字 body；band 变体上下留白让文字居中 */
  .band { position: relative; display: flex; align-items: flex-start; gap: 5px; width: 100%; box-sizing: border-box;
    min-height: 40px; padding: 8px; border-radius: 10px; background: var(--hover); font-size: 14px; line-height: 20px; color: var(--text); }
  .band-main { flex: 1; min-width: 0; display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 8px; row-gap: 3px; padding: 2px 0 2px 4px; }
  .band-msg { min-width: 0; color: var(--text); }
  .band-cta { display: flex; flex-wrap: wrap; align-items: center; column-gap: 8px; row-gap: 3px; min-width: 0; }
  /* 文本链接按钮（官方 va）：次色 + 下划线，hover 转主色 */
  .lnk { flex: none; padding: 0; color: var(--serif); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: color-mix(in srgb, currentColor 45%, transparent);
    font-size: 14px; line-height: 20px; border-radius: 4px; }
  @media (hover: hover) { .lnk:hover { color: var(--text); } }
  .lnk:disabled { opacity: .5; cursor: default; }
  /* 右侧 X：ghost 图标钮 24×24 */
  .band-x { flex: none; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border-radius: 6px; color: var(--muted); }
  @media (hover: hover) { .band-x:hover { color: var(--text); background: var(--hover-strong); } }
  .band-x:active { background: var(--hover-strong); }
  .gi { font-family: var(--icons); font-style: normal; font-feature-settings: "liga" 0; font-variation-settings: "opsz" 16, "wght" 533;
    font-size: 16px; line-height: 1; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; }

  /* Why? 弹层（官方 MR Popup side=top align=end）：贴横条上方、220–320 宽，卡底 + 描边 + 阴影；left 由脚本按触发器右缘算 */
  .why-pop { position: absolute; left: 0; bottom: calc(100% + 6px); z-index: 6; width: min(320px, 100%); min-width: min(220px, 100%);
    box-sizing: border-box; display: flex; flex-direction: column; gap: 3px; padding: 10px 12px;
    background: var(--card); border: 1px solid var(--divider); border-radius: 12px; box-shadow: 0 8px 28px rgba(0,0,0,.28);
    animation: whyIn var(--mo-quick) var(--ea-decel); overflow-wrap: anywhere; }
  @keyframes whyIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  .why-h { font-size: 12.5px; line-height: 16px; font-weight: 500; color: var(--serif); padding-bottom: 4px; }
  .why-b { font-size: 14px; line-height: 20px; color: var(--muted); text-wrap: pretty; }
  .why-d { display: block; padding-top: 4px; font-size: 14px; line-height: 20px; color: var(--muted); }
  .why-d code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; word-break: break-all; }
  @media (prefers-reduced-motion: reduce) { .why-pop { animation: none; } }

  /* Paused 卡（官方 epitaxy-approval-card：r10 / p12 / 行距 12 / 升起动效；底与阴影借问答卡的 --q-card / --q-shadow） */
  .pz { display: flex; flex-direction: column; gap: 12px; width: 100%; box-sizing: border-box; padding: 12px;
    border-radius: 10px; background: var(--q-card, var(--card)); box-shadow: var(--q-shadow, 0 0 0 1px var(--divider), 0 4px 24px rgba(0,0,0,.08));
    font-size: 14px; line-height: 20px; color: var(--text); container-type: inline-size; outline: none;
    transform-origin: top; animation: pzIn .22s cubic-bezier(.215,.61,.355,1); }
  @keyframes pzIn { from { opacity: .75; transform: translateY(-6px) scale(.97); } to { opacity: 1; transform: none; } }
  .pz-head { display: flex; align-items: center; gap: 8px; min-height: 24px; }
  .pz-title { flex: 1; min-width: 0; font-weight: 580; color: var(--text); }
  .pz-body { color: var(--serif); overflow-wrap: anywhere; text-wrap: pretty; }
  .pz-body a { color: inherit; text-decoration: underline; text-underline-offset: 3px; text-decoration-color: color-mix(in srgb, currentColor 45%, transparent); }
  @media (hover: hover) { .pz-body a:hover { color: var(--text); } }
  .pz-body .why-d { color: var(--serif); }
  /* 两颗 secondary 按钮靠右；窄到 420 以下竖排撑满（官方 @container width<=420） */
  .pz-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px 6px; }
  .pz-btn { min-width: 0; min-height: 32px; padding: 6px 12px; border-radius: 9px; font-size: 14px; line-height: 20px; font-weight: 500;
    color: var(--text); border: 1px solid var(--q-skipborder, var(--divider)); text-align: center; overflow-wrap: anywhere;
    transition: background-color 60ms ease-out, transform 60ms ease-out; }
  @media (hover: hover) { .pz-btn:hover:not(:disabled) { background: var(--hover); } }
  .pz-btn:active:not(:disabled) { background: var(--hover-strong); transform: scale(.985); }
  .pz-btn:disabled { opacity: .5; cursor: default; }
  .band-x:disabled { opacity: .5; }
  @container (width <= 420px) { .pz-actions { flex-direction: column; align-items: stretch; } }
  @media (prefers-reduced-motion: reduce) { .pz { animation: none; } }
</style>
