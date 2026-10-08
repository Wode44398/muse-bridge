<script>
  // 报告问题：一句话描述（可以不写）+ 一键发送。版本、服务状态、最近的报错、出错前的几步操作由服务端
  // 按白名单自动附上（src/feedback/），不含对话、文件、key、地址；想看会发出去什么，点「查看会发送的内容」。
  // 入口：出错提示上的「报告问题」、设置 → 反馈。
  import { api } from '../lib/api.js';
  import { ui } from '../lib/state.svelte.js';
  import { reportDialog, trailLines, recentErrorFps, browserSummary } from '../lib/feedback.svelte.js';
  import { registerCloser } from '../lib/nav.js';
  import { t, tr, lang } from '../lib/i18n.js';

  const preset = reportDialog.preset || {};
  let kind = $state(preset.kind || 'bug');
  let desc = $state(preset.error ? t('出错提示：{msg}', { msg: tr(preset.error) }) + '\n' : '');
  let busy = $state(false);
  let err = $state('');
  let draft = $state(null);        // { id, title, body, key }
  let showPreview = $state(false);
  let result = $state(null);       // 发送结果

  const KINDS = [
    { k: 'bug', label: t('出问题了') },
    { k: 'idea', label: t('功能建议') },
    { k: 'security', label: t('安全问题') },
  ];
  const inputKey = () => kind + '\u0000' + desc;

  function close() { reportDialog.open = false; reportDialog.preset = null; }
  $effect(() => registerCloser('report', close));
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }

  async function makeDraft() {
    if (draft && draft.key === inputKey()) return draft;
    const r = await api.post('/api/feedback/draft', {
      kind, description: desc.trim(), trail: trailLines(), errorFps: recentErrorFps(),
      page: ui.screen, browser: browserSummary(), lang: lang(),
    });
    draft = { ...r, key: inputKey() };
    return draft;
  }
  const errText = (e) => (e?.body?.error ? tr(e.body.error) : t('出错了，稍后再试'));

  async function togglePreview() {
    if (showPreview) { showPreview = false; return; }
    err = ''; busy = true;
    try { await makeDraft(); showPreview = true; } catch (e) { err = errText(e); } finally { busy = false; }
  }
  async function send() {
    err = ''; busy = true;
    try {
      const d = await makeDraft();
      result = await api.post('/api/feedback/send', { id: d.id });
      if (result.status === 'missing') { result = null; draft = null; err = t('草稿过期了，再点一次发送'); }
    } catch (e) { err = errText(e); } finally { busy = false; }
  }
  function openUrl(u) { if (u) window.open(u, '_blank', 'noopener'); }
</script>

<svelte:window onkeydown={onKey} />

<button class="rp-bd" aria-label={t('关闭')} tabindex="-1" onclick={close}></button>
<div class="rp-wrap">
  <div class="rp" role="dialog" aria-modal="true" aria-label={t('报告问题')}>
    {#if result}
      <div class="rp-done">
        {#if result.status === 'sent'}
          <div class="ok-ic" aria-hidden="true">&#xe03b;</div>
          <h2 class="rp-t">{result.private ? t('已私下报告') : result.duplicate ? t('别人也遇到了') : t('已提交，谢谢')}</h2>
          <p class="rp-s">
            {#if result.private}{t('安全问题不公开，维护者会私下处理。')}
            {:else if result.duplicate}{t('同一个问题已经有人报告过，已经替你在原报告上 +1，修好的时候你会知道。')}
            {:else}{t('修好的时候，更新说明里会提到它。')}{/if}
          </p>
          {#if result.issue?.url}<button class="rp-link" onclick={() => openUrl(result.issue.url)}>{t('在 GitHub 上查看 #{n}', { n: result.issue.number })}</button>{/if}
        {:else if result.status === 'queued'}
          <h2 class="rp-t">{t('报告已存好')}</h2>
          <p class="rp-s">{t('现在连不上反馈服务，联网后会自动补发，不用再操作。')}</p>
          <button class="rp-link" onclick={() => openUrl(result.fallbackUrl)}>{t('等不及：自己在 GitHub 上提交')}</button>
        {:else}
          <h2 class="rp-t">{t('这次没能提交')}</h2>
          <p class="rp-s">{tr(result.reason || '')}</p>
          <button class="rp-link" onclick={() => openUrl(result.fallbackUrl)}>{t('改用 GitHub 自己提交（内容已填好）')}</button>
        {/if}
        <button class="rp-go" onclick={close}>{t('完成')}</button>
      </div>
    {:else}
      <h2 class="rp-t">{t('报告问题')}</h2>
      <p class="rp-s">{t('说一句发生了什么就行，版本、报错这些会自动附上。')}</p>
      <div class="rp-kinds" role="radiogroup" aria-label={t('类型')}>
        {#each KINDS as x (x.k)}
          <button role="radio" aria-checked={kind === x.k} class="chip" class:on={kind === x.k} onclick={() => { kind = x.k; }}>{x.label}</button>
        {/each}
      </div>
      <textarea class="rp-in" rows="4" bind:value={desc} maxlength="4000"
        placeholder={kind === 'idea' ? t('想要什么功能？') : t('比如：点发送之后一直转圈（可以不写）')}></textarea>
      {#if err}<div class="rp-err">{err}</div>{/if}
      <button class="rp-pv" onclick={togglePreview} disabled={busy} aria-expanded={showPreview}>
        {showPreview ? t('收起') : t('查看会发送的内容')}
      </button>
      {#if showPreview && draft}
        <pre class="rp-pre">{draft.title}

{draft.body.replace(/\n<!-- muse-fp:[0-9a-f]+ -->$/, '')}</pre>
      {/if}
      <p class="rp-note">
        {kind === 'security'
          ? t('安全问题会私下发给维护者，不公开。')
          : t('会提交到项目公开的 GitHub Issues，不含对话、文件、key 和地址。')}
      </p>
      <div class="rp-btns">
        <button class="rp-cancel" onclick={close}>{t('取消')}</button>
        <button class="rp-go" onclick={send} disabled={busy}>{busy ? t('发送中…') : t('发送')}</button>
      </div>
    {/if}
  </div>
</div>

<style>
  .rp-bd { position: fixed; inset: 0; z-index: 66; border: 0; background: var(--st-backdrop); cursor: default; }
  .rp-wrap { position: fixed; inset: 0; z-index: 67; display: flex; align-items: center; justify-content: center;
    padding: max(16px, var(--sat)) 16px max(16px, var(--sab)); overflow-y: auto; pointer-events: none; }
  .rp { pointer-events: auto; width: min(460px, 100%); margin: auto; padding: 26px 24px 20px; border-radius: 16px;
    background: var(--st-surface); box-shadow: 0 0 0 1px var(--st-line), 0 24px 64px rgba(0, 0, 0, .3);
    display: flex; flex-direction: column; font-family: var(--sans); color: var(--text); animation: rp-in .18s var(--ea-decel); }
  @keyframes rp-in { from { opacity: 0; transform: translateY(6px) scale(.99); } }
  .rp-t { margin: 0; font-family: var(--serif-stack); font-weight: 400; font-size: 24px; line-height: 30px; }
  .rp-s { margin: 6px 0 16px; font-size: 14px; line-height: 20px; color: var(--st-muted); }
  .rp-kinds { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 10px; }
  .chip { height: 30px; padding: 0 12px; border: 0; border-radius: 999px; cursor: pointer; font: inherit; font-size: 13.5px;
    background: transparent; color: var(--st-text2); box-shadow: inset 0 0 0 1px var(--st-line); transition: background-color .12s, color .12s; }
  .chip.on { background: var(--st-sel); color: var(--text); box-shadow: inset 0 0 0 1px var(--st-accent); }
  @media (hover: hover) { .chip:not(.on):hover { background: var(--st-hover); color: var(--text); } }
  .rp-in { resize: vertical; min-height: 92px; padding: 10px 12px; border: 0; border-radius: 10px; outline: none; font: inherit; font-size: 15px;
    line-height: 21px; color: var(--text); background: var(--st-field); box-shadow: inset 0 0 0 1px var(--st-line); transition: box-shadow .15s ease; }
  .rp-in::placeholder { color: var(--st-muted); }
  .rp-in:focus { box-shadow: inset 0 0 0 1px var(--st-accent), 0 0 0 3px color-mix(in srgb, var(--st-accent) 22%, transparent); }
  .rp-err { margin-top: 10px; padding: 8px 12px; border-radius: 10px; font-size: 13px; line-height: 18px;
    color: var(--crit); background: color-mix(in srgb, var(--crit) 12%, transparent); }
  .rp-pv { align-self: flex-start; margin-top: 10px; padding: 4px 2px; border: 0; background: none; cursor: pointer; font: inherit;
    font-size: 13px; color: var(--st-text2); text-decoration: underline; text-underline-offset: 3px; }
  .rp-pv:disabled { opacity: .5; cursor: default; }
  .rp-pre { margin: 8px 0 0; max-height: 260px; overflow: auto; padding: 10px 12px; border-radius: 10px; font-family: var(--mono, ui-monospace, monospace);
    font-size: 12px; line-height: 17px; white-space: pre-wrap; word-break: break-word; color: var(--st-text2); background: var(--st-field);
    box-shadow: inset 0 0 0 1px var(--st-line); }
  .rp-note { margin: 12px 0 0; font-size: 12.5px; line-height: 18px; color: var(--st-muted); }
  .rp-btns { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  .rp-cancel, .rp-go { height: 36px; padding: 0 16px; border: 0; border-radius: 9px; cursor: pointer; font: inherit; font-size: 14px; }
  .rp-cancel { background: transparent; color: var(--text); box-shadow: inset 0 0 0 1px var(--st-line); }
  .rp-go { background: var(--st-primary); color: var(--st-primary-ink); font-weight: 500; transition: opacity .15s ease; }
  .rp-go:disabled { opacity: .5; cursor: default; }
  @media (hover: hover) { .rp-cancel:hover { background: var(--st-hover); } .rp-go:hover:not(:disabled) { opacity: .88; } }
  .rp-done { display: flex; flex-direction: column; align-items: center; text-align: center; }
  .rp-done .rp-s { margin-bottom: 10px; }
  .rp-done .rp-go { margin-top: 14px; align-self: stretch; }
  .ok-ic { width: 44px; height: 44px; margin-bottom: 12px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
    font-family: var(--icons); font-size: 22px; line-height: 1; color: #2f9e5b; background: rgba(47, 158, 91, .13); }
  .rp-link { padding: 6px 4px; border: 0; background: none; cursor: pointer; font: inherit; font-size: 14px; color: var(--st-accent); }
  @media (hover: hover) { .rp-link:hover { text-decoration: underline; text-underline-offset: 3px; } }
</style>
