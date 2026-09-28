<script>
  // 模型切换 / 安全栅门通知卡——官方 /code 页时间线里的 tR 告警卡（fallback-banner.md §2.1）。
  // 吃 notice 段：{ subtype, direction, scope, from, to, trigger, category, explanation, text, … }
  //   model_refusal_fallback     安全栅门把这条消息标记，已切到回退模型重试（text = CLI 同款整段文案）
  //   model_refusal_no_fallback  被标记但没有回退模型（text 为空 → 本地拼官方句式）
  //   model_fallback             非安全类回退（过载/不可用，带 trigger；不给 Details 与 Learn more）
  //   model_consent_fallback     Fable 5 用量同意门（同 text 拆分）
  // 文案规则：headline = text 首句（到首个 ". "），hint = 其余；CLI 尾巴上的 "Details: `[cat]`" 抠出来
  // 单独等宽渲染（官方 Wa），hint 里的 URL 渲染成链接。scope=local 的卡照常渲染（文案自己写明
  // "Your session model is unchanged"）。
  // 配色：只有首行 Warning 图标用 --crit（官方 text-danger），其余全黑白灰。
  import { modelLabel, learnMoreUrl } from '../../lib/toolVerbs.js';
  import { glyph } from '../../lib/claudeIcons.js';
  import { onMdClick } from '../../lib/linkNav.js';

  let { seg } = $props();

  const from = $derived(modelLabel(seg.from) || seg.from || 'This model');
  const to = $derived(modelLabel(seg.to) || seg.to || '');
  // 有 trigger（或 subtype 就是 model_fallback）= 非安全类回退：不显示 Details / Learn more（官方 e.trigger 分支）。
  // model_consent_fallback（Fable 5 用量额度同意门）同样与安全栅门无关：官方桌面端根本不把它当 model_fallback
  // 卡渲染，更不会挂 safeguards 文章——这里照 text 渲染但不给 Details / Learn more。
  const isTrigger = $derived(!!seg.trigger || seg.subtype === 'model_fallback' || seg.subtype === 'model_consent_fallback');

  const DETAILS_RE = /\n?\s*Details:\s*`?\[([^\]]*)\]`?\s*$/;
  const parsed = $derived.by(() => {
    let text = String(seg.text || '').trim();
    let cat = seg.category ? String(seg.category) : '';
    const dm = text.match(DETAILS_RE);
    if (dm) { text = text.slice(0, dm.index).trim(); if (!cat) cat = dm[1]; }
    let headline = '', hint = '';
    const expl = !isTrigger && seg.explanation ? String(seg.explanation).trim() : '';
    if (expl) {
      // 官方 tR：API 回了 stop_details.explanation（仅 client lane）→ headline「Switched to {fallback}」、hint 用解释文
      //（横条 Why? 弹层也优先显示它，两处同源不再各说各话）；没有回退模型时 headline 仍是「flagged」句
      headline = to ? `Switched to ${to}` : `${from}'s safeguards flagged this message`;
      hint = expl;
    } else if (text) {
      const i = text.indexOf('. ');
      if (i > 0) { headline = text.slice(0, i); hint = text.slice(i + 2).trim(); }
      else headline = text.replace(/\.$/, '');
    } else if (seg.subtype === 'model_refusal_no_fallback') {
      headline = `${from}'s safeguards flagged this message`;
      hint = `Claude Code can't respond to this message with ${from}. Try rephrasing the request or change your model.`;
    } else if (to) {
      headline = `Switched to ${to}`;
    } else {
      headline = `${from} is unavailable`;
    }
    return { headline, hint, cat };
  });

  // hint 里的 URL → 链接（其余原样，white-space: pre-line 保留 CLI 文案里的换行）。只放行 https 且落在
  // claude.com / claude.ai / anthropic.com 域下的（CLI 文案里是 support.claude.com）；解释文是 API 给的
  // 自由文本（"display only, never parse"），别的域名一律当纯文本。
  const URL_RE = /https?:\/\/[^\s<>()"']+/g;
  const LINK_OK = /^https:\/\/([a-z0-9-]+\.)*(claude\.com|claude\.ai|anthropic\.com)(\/|$)/i;
  const hintParts = $derived.by(() => {
    const s = parsed.hint;
    if (!s) return [];
    const out = [];
    let last = 0, m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(s))) {
      let url = m[0];
      const trail = url.match(/[.,;:!?)]+$/);   // 句末标点不算进 URL
      if (trail) url = url.slice(0, -trail[0].length);
      if (!LINK_OK.test(url)) continue;         // 不放行的留在后面的文本片里
      if (m.index > last) out.push({ text: s.slice(last, m.index) });
      out.push({ url });
      last = m.index + url.length;
    }
    if (last < s.length) out.push({ text: s.slice(last) });
    return out;
  });
  const learnHref = $derived(isTrigger ? '' : learnMoreUrl(seg.from, seg.category));
</script>

<!-- 点击只做链接分流（linkNav），卡片本身非交互 -->
<!-- svelte-ignore a11y_no_static_element_interactions, a11y_click_events_have_key_events -->
<div class="mn sel-text" data-subtype={seg.subtype} onclick={onMdClick}>
  <div class="mn-head">
    <span class="mn-ic" aria-hidden="true">{glyph('Warning')}</span>
    <span class="mn-title">{parsed.headline}</span>
  </div>
  {#if hintParts.length || (!isTrigger && parsed.cat)}
    <span class="mn-hint">
      {#each hintParts as p, i (i)}{#if p.url}<a href={p.url} target="_blank" rel="noopener noreferrer">{p.url}</a>{:else}{p.text}{/if}{/each}
      {#if !isTrigger && parsed.cat}<span class="mn-details">Details: <code>[{parsed.cat}]</code></span>{/if}
    </span>
  {/if}
  {#if learnHref}
    <div class="mn-actions">
      <a class="mn-btn" href={learnHref} target="_blank" rel="noopener noreferrer">Learn more</a>
    </div>
  {/if}
</div>

<style>
  /* 官方 tR：max-w 480 / r8 / p12 / 1px 描边（--t2）/ 行距 6 */
  .mn { display: flex; flex-direction: column; gap: 6px; width: 100%; max-width: 480px; box-sizing: border-box;
    border-radius: 8px; padding: 12px; box-shadow: 0 0 0 1px var(--divider); margin: 6px 0;
    font-size: 14px; line-height: 20px; color: var(--text); overflow-wrap: anywhere; }
  .mn-head { display: flex; align-items: center; gap: 6px; }
  /* Warning 图标：Anthropicons 字形，同状态栏芯片轴位 opsz16/wght533 */
  .mn-ic { flex: none; width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center;
    font-family: var(--icons); font-style: normal; font-feature-settings: "liga" 0; font-variation-settings: "opsz" 16, "wght" 533;
    font-size: 16px; line-height: 1; color: var(--crit); }
  .mn-title { min-width: 0; flex: 1; font-weight: 500; color: var(--text); }
  .mn-hint { display: block; color: var(--serif); white-space: pre-line; overflow-wrap: anywhere; }
  .mn-hint a { color: var(--text); text-decoration: underline; text-underline-offset: 3px; word-break: break-all; }
  .mn-details { display: block; padding-top: 4px; }
  .mn-details code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; word-break: break-all; }
  /* 次级 xxs 按钮（CDS Button secondary/xxs：高 20、字 12/17、r5、圆角描边） */
  .mn-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; padding-top: 8px; }
  .mn-btn { display: inline-flex; align-items: center; height: 20px; padding: 0 6px; border-radius: 5px;
    font-size: 12px; line-height: 17px; color: var(--serif); text-decoration: none; background: var(--hover);
    box-shadow: inset 0 0 0 1px var(--divider), 0 1px 2px rgba(0,0,0,.05); transition: background-color 60ms ease-out, color 60ms ease-out; }
  @media (hover: hover) { .mn-btn:hover { background: var(--hover-strong); color: var(--text); } }
  .mn-btn:active { transform: scale(.975); }
</style>
