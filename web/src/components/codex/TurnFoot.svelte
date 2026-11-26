<script>
  // 一轮收尾之后挂在回答下面的：出错提醒（重试 / 查看原文 / 额度用完换号继续）、计划模式出的计划（「是的，执行此计划」）、
  // 改动卡（点了进右侧「审阅」）、这一轮做出来的文件。提醒一律同一种平铺浅底（.note），不加彩条彩点。
  import { untrack } from 'svelte';
  import Icon from './Icon.svelte';
  import { t, tr } from '../../lib/i18n.js';
  import { renderMarkdown, renderStreamingMarkdown } from '../../lib/md.js';
  import { codexArtifactUrl, openPreview, kindOf } from '../../lib/preview.svelte.js';
  import { openCodexDock } from '../../lib/dock.svelte.js';
  import { codex, send, isAdmin, errText } from '../../lib/codex/store.svelte.js';
  import { codexApi } from '../../lib/codex/api.js';
  import { accLabel } from '../../lib/codex/settings-logic.js';
  import { turnSummary } from '../../lib/codex/turns.js';
  import { splitPath, bar5 } from '../../lib/codex/thread/diff.js';
  import { fmtUntil, pickAccount, firstLine, isMultiline, fmtSize } from '../../lib/codex/thread/words.js';
  import { codexMdClick } from '../../lib/codex/thread/links.js';
  import { rise } from '../../lib/codex/thread/fx.js';

  let { turn, sid = '', last = false, running = false } = $props();

  // 在你眼前跑完的这一轮：卡片从下面淡上来；打开旧线程时直接摆好
  const wasLive = untrack(() => turn.live);
  const enter = (node) => { if (wasLive) rise(node); };

  /* ---------------- 出错 ---------------- */

  const err = $derived(turn.status === 'error' ? turn.error : null);
  const limit = $derived(err?.limit && !err.limit.switched ? err.limit : null);
  const target = $derived(limit && limit.accountId !== 'hub' ? pickAccount(codex.pool, limit.accountId) : null);
  const accName = (id) => { const a = (codex.pool?.accounts || []).find((x) => x.id === id); return a ? accLabel(a) : ''; };
  const canRetry = $derived(last && !running && !turn.live && !!(turn.user?.text || turn.user?.attachments?.length));

  let rawOpen = $state(false);
  let busy = $state('');
  let opErr = $state('');

  function retry() {
    if (!canRetry) return;
    send(turn.user.text, { attachments: turn.user.attachments || [] });
  }

  async function switchAndGo() {
    if (!target || busy || !sid) return;
    busy = 'switch';
    opErr = '';
    try {
      await codexApi.op('migrate', sid, { toAccount: target.id });
      busy = '';
      send(turn.user.text, { attachments: turn.user.attachments || [] });
    } catch (e) {
      busy = '';
      opErr = errText(e, t('没换成，再试一次'));
    }
  }

  /* ---------------- 计划模式 ---------------- */

  const canRunPlan = $derived(last && !turn.live && !running && turn.status === 'done' && !!turn.planText.trim());
  function runPlan() {
    if (!canRunPlan) return;
    codex.plan = false;
    send(t('是的，执行此计划'));
  }

  /* ---------------- 改动卡 ---------------- */

  const MAX_FILES = 8;
  const sum = $derived(turn.live ? null : turnSummary(turn));
  const files = $derived(sum?.files?.filter((f) => f.a || f.d) || []);
  const review = () => openCodexDock('review');

  /* ---------------- 做出来的文件 ---------------- */

  const outs = $derived((turn.live ? [] : turn.attachments || []).filter((a) => a?.path).map((a) => {
    const name = String(a.name || splitPath(a.path).name);
    const k = kindOf(name);
    return { ...a, name, kind: k === 'other' ? a.kind || 'other' : k };
  }));
  const imgs = $derived(outs.filter((a) => a.kind === 'image'));
  const docs = $derived(outs.filter((a) => a.kind !== 'image'));
  function openOut(a) {
    const items = outs.map((x) => ({ origin: 'codex', id: sid, path: x.path, name: x.name, kind: x.kind, size: x.size, mime: x.mime }));
    openPreview(items, Math.max(0, outs.indexOf(a)));
  }
</script>

{#if turn.planText}
  <div class="cx-planres sq" use:enter>
    <div class="pr-hd"><Icon name="plan" class="mi-ico" /><b>{t('计划')}</b></div>
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="md pr-md" onclick={(e) => codexMdClick(e, sid)}>{@html turn.live ? renderStreamingMarkdown(turn.planText) : renderMarkdown(turn.planText)}</div>
    {#if canRunPlan}
      <div class="pr-ft"><button class="tbtn pri" onclick={runPlan}>{t('是的，执行此计划')}</button></div>
    {/if}
  </div>
{/if}

{#if err}
  <div class="note sq" class:raw-open={rawOpen} use:enter>
    {#if limit}
      <span class="n-ico"><Icon name="pause" /></span>
      <div class="n-txt">
        <b>{limit.reason === 'hub' ? t('模型中心的额度用完了') : t('这个号额度用完了')}</b>{#if fmtUntil(limit.until)}{t('，{time} 恢复', { time: fmtUntil(limit.until) })}{/if}
        <div class="n-sub">
          {#if opErr}{opErr}
          {:else if limit.reason === 'migrate-failed' && limit.error}{t('自动换号没成功：{msg}', { msg: tr(limit.error) })}
          {:else if limit.accountId && limit.accountId !== 'hub'}{accName(limit.accountId)}{#if isAdmin() && !target} · {t('号池里没有能换的号')}{/if}{/if}
        </div>
      </div>
      <div class="n-act">
        {#if isAdmin() && target}
          <button class="tbtn pri" onclick={switchAndGo} disabled={!!busy || running} title={t('换到 {name} 接着跑这一句', { name: accLabel(target) })}>
            {#if busy === 'switch'}<svg class="spin" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.2" /></svg>{/if}<span class:ghost={busy === 'switch'}>{t('换号继续')}</span>
          </button>
        {/if}
        {#if canRetry}<button class="tbtn" onclick={retry}>{t('重试')}</button>{/if}
      </div>
    {:else}
      {@const msg = tr(err.message || '') || t('这一轮没跑完')}
      <span class="n-ico"><Icon name="warn" /></span>
      <div class="n-txt">
        <b>{t('这一轮出错了')}</b>
        <div class="n-sub">{firstLine(msg)}</div>
        {#if isMultiline(msg)}<div class="raw">{msg}</div>{/if}
      </div>
      <div class="n-act">
        {#if canRetry}<button class="tbtn" onclick={retry}>{t('重试')}</button>{/if}
        {#if isMultiline(msg)}<button class="tbtn" onclick={() => { rawOpen = !rawOpen; }}>{rawOpen ? t('收起') : t('查看原文')}</button>{/if}
      </div>
    {/if}
  </div>
{/if}

{#if files.length}
  <div class="changes sq" use:enter>
    <div class="hd">
      <Icon name="branch" class="mi-ico" />
      <b>{t('已编辑的文件')}</b>
      <span class="st">{t('{n} 个文件已更改', { n: files.length })} · <span class="a">+{sum.a}</span> <span class="d">−{sum.d}</span></span>
      <span class="grow"></span>
      <button class="tbtn" onclick={review}>{t('查看更改')}</button>
    </div>
    {#each files.slice(0, MAX_FILES) as f}
      {@const sp = splitPath(f.path)}
      <button class="cf" onclick={review} title={f.path}>
        <span class="p"><span>{sp.dir}</span>{sp.name}</span>
        <span class="s"><span class="a">+{f.a}</span> <span class="d">−{f.d}</span></span>
        <span class="bar5">{#each bar5(f.a, f.d) as c}<i class={c}></i>{/each}</span>
      </button>
    {/each}
    {#if files.length > MAX_FILES}
      <button class="cf more" onclick={review}><span class="p">{t('还有 {n} 个文件', { n: files.length - MAX_FILES })}</span></button>
    {/if}
  </div>
{/if}

{#if outs.length}
  <div class="outs" use:enter>
    {#if imgs.length}
      <div class="o-imgs">
        {#each imgs as a}
          <button class="o-img sq" onclick={() => openOut(a)} title={a.name}><img src={codexArtifactUrl(sid, a.path, { name: a.name })} alt={a.name} loading="lazy" /></button>
        {/each}
      </div>
    {/if}
    {#each docs as a}
      <button class="o-file sq" onclick={() => openOut(a)} title={a.path}>
        <span class="th sq"><Icon name="file" /></span>
        <span class="tx"><b>{a.name}</b><span>{[a.name.includes('.') ? a.name.split('.').pop().toUpperCase() : '', fmtSize(a.size)].filter(Boolean).join(' · ')}</span></span>
      </button>
    {/each}
  </div>
{/if}

<style>
  .note .n-act .tbtn { position: relative; }
  .note .n-act .tbtn:disabled { opacity: .5; cursor: default; }
  .note .n-act .spin { position: absolute; left: 50%; top: 50%; margin: -7px 0 0 -7px; }
  .note .n-act .ghost { visibility: hidden; }

  .changes .cf.more .p { color: var(--fg3); font-family: var(--font); }

  .cx-planres { --r: 16px; border: 1px solid var(--line2); padding: 10px 14px 12px; }
  .pr-hd { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; font-size: 12.5px; color: var(--fg2); }
  .pr-hd b { font-weight: 500; color: var(--fg); }
  .pr-md { font-size: 14px; }
  .pr-ft { display: flex; justify-content: flex-end; margin-top: 10px; }

  .outs { display: flex; flex-direction: column; gap: 6px; }
  .o-imgs { display: flex; flex-wrap: wrap; gap: 6px; }
  .o-img { --r: 12px; overflow: hidden; border: 1px solid var(--line2); background: var(--fill1); }
  .o-img img { display: block; height: 140px; max-width: 260px; object-fit: cover; }
  .o-file { align-self: flex-start; max-width: min(100%, 420px); display: flex; align-items: center; gap: 10px; padding: 6px 14px 6px 6px; --r: 12px; background: var(--fill2); font-size: 12.5px; transition: background-color var(--d-2); }
  .o-file:hover { background: var(--fill3); }
  .o-file .th { width: 32px; height: 32px; --r: 8px; display: grid; place-items: center; background: var(--fill3); color: var(--fg2); flex: none; }
  .o-file .th :global(svg) { width: 18px; height: 18px; }
  .o-file .tx { min-width: 0; display: flex; flex-direction: column; }
  .o-file .tx b { font-weight: 500; line-height: 1.3; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .o-file .tx span { color: var(--fg3); font-size: 11.5px; }

  @container cx (max-width: 640px) {
    .changes .hd .st { display: none; }
    .o-img img { height: 110px; max-width: 200px; }
  }
</style>
