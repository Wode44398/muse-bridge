<script>
  // 工作台「记忆」卡里点开一条 dimensio 记忆：全文 + 按 dimensio 的治理规则给动作——确认（晋升：生效 + 你确认过）、
  // 编辑后确认、驳回（可附一句理由，模型以后看得到）、撤销驳回、删除（两步）。全部走 dimensio 自己的接口
  // （/api/harness/api/memory/:id/{promote,reject,restore,delete}），不碰它的文件：校验、同主题冲突、全局层预算都由它判。
  // ws = dimensio 的工作区绝对路径，全局层是 '@global'。
  import { api } from '../../lib/api.js';
  import { renderMarkdown } from '../../lib/md.js';
  import { relTime } from '../../lib/format.js';
  import { t, tr } from '../../lib/i18n.js';
  // 状态 / 类型 / 可信度的名字与问题码的人话：用 dimensio 自己记忆面板的那份文案表
  import { STATUS_LABEL, TYPE_LABEL, CONF_LABEL, issueText, fmtDate } from '@hx/components/sheets/memory-text.ts';

  let { ws = '', id = '', onclose = () => {}, onchanged = () => {} } = $props();

  const GLOBAL = '@global';
  const base = (rest = '') => `/api/harness/api/memory/${encodeURIComponent(id)}${rest}`;
  const query = () => (ws === GLOBAL ? 'layer=global' : 'workspace=' + encodeURIComponent(ws));
  const body = (extra = {}) => ({ ...(ws === GLOBAL ? { layer: 'global' } : { workspace: ws }), ...extra });

  let note = $state(null);
  let err = $state('');
  let busy = $state('');
  let problems = $state([]);
  let conflicts = $state(null);
  let editing = $state(false);
  let draft = $state({ title: '', description: '', content: '' });
  let rejecting = $state(false);
  let reason = $state('');
  let armed = $state(false);   // 删除两步：第一次只是上膛
  let done = $state('');

  async function load() {
    try { note = await api.get(base() + '?' + query()); err = ''; }
    catch (e) { err = tr(e?.body?.error) || t('加载失败'); }
  }
  $effect(() => { id; ws; load(); });

  const issues = $derived((note?.issues || []).map(issueText).filter(Boolean));
  const held = $derived(note && note.declaredStatus === 'active' && note.status !== 'active');
  const canPromote = $derived(note && note.declaredStatus !== 'rejected' && note.declaredStatus !== 'superseded');
  const promoteLabel = $derived(!note ? '' : note.declaredStatus === 'proposed' ? t('确认，让它生效') : note.status === 'active' ? t('保存并确认') : t('重新确认，让它生效'));
  const updated = $derived(note?.updated ? Date.parse(note.updated) : 0);

  async function act(kind, fn, okText) {
    busy = kind; problems = []; conflicts = null;
    try { await fn(); done = okText; await load(); onchanged(); editing = false; rejecting = false; armed = false; }
    catch (e) {
      const b = e?.body || {};
      if (Array.isArray(b.conflicts) && b.conflicts.length) conflicts = b.conflicts;
      else if (b.code === 'global_budget') problems = [t('全局记忆满了（生效的条目合计有长度上限，每个对话的提示里都有它们）：先驳回或删掉一条旧的，再确认这一条')];
      else problems = [tr(String(b.error || e?.message || e))];
    }
    busy = '';
  }
  const promote = (supersedes) => act('promote', () => api.post(base('/promote'), body({
    ...(editing ? { edits: { title: draft.title, description: draft.description, content: draft.content } } : {}),
    ...(supersedes ? { supersedes } : {}),
  })), supersedes ? t('已生效，替换了原来那条') : t('已生效，之后的对话会用上它'));
  const reject = () => act('reject', () => api.post(base('/reject'), body({ reason: reason.trim() || undefined })), t('已驳回，模型不会再用它、也不能再存同一条'));
  const restore = () => act('restore', () => api.post(base('/restore'), body()), t('已撤销驳回，回到待确认'));
  async function remove() {
    if (!armed) { armed = true; rejecting = false; return; }
    await act('delete', () => api.post(base('/delete'), body()), '');
    if (!problems.length) onclose();
  }
  function startEdit() {
    draft = { title: note.title, description: note.description, content: note.content };
    editing = true; rejecting = false; armed = false;
  }
</script>

<div class="dn">
  <header class="dn-head">
    <button class="dn-ib" aria-label={t('返回')} onclick={onclose}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5l-7 7 7 7"/></svg>
    </button>
    <span class="dn-t">{note?.title || id}</span>
  </header>

  <div class="dn-body">
    {#if err}
      <div class="dn-msg">{err}</div>
    {:else if note}
      <div class="dn-meta">
        <span class="dn-st" class:held class:rej={note.status === 'rejected'}>{held ? t('被隔离') : STATUS_LABEL[note.status] || note.status}</span>
        {#if TYPE_LABEL[note.type]}<span>{TYPE_LABEL[note.type]}</span>{/if}
        {#if CONF_LABEL[note.confidence]}<span>· {CONF_LABEL[note.confidence]}</span>{/if}
        {#if updated}<span>· {relTime(updated)}</span>{/if}
        <span class="mono">· {note.topic}</span>
      </div>
      {#if note.declaredStatus === 'rejected'}
        <p class="dn-banner bad">{note.rejectReason ? t('你在 {date} 驳回了它：{reason}', { date: fmtDate(note.rejectedAt), reason: note.rejectReason }) : t('你在 {date} 驳回了它。', { date: fmtDate(note.rejectedAt) })}</p>
      {:else if note.supersededBy}
        <p class="dn-banner">{t('已被「{id}」替代。', { id: note.supersededBy })}</p>
      {/if}
      {#if issues.length}
        <ul class="dn-issues">{#each issues as it}<li>{it}</li>{/each}</ul>
      {/if}

      {#if editing}
        <label class="dn-f"><span>{t('标题')}</span><input bind:value={draft.title} maxlength="120" /></label>
        <label class="dn-f"><span>{t('一句话说明')}</span><input bind:value={draft.description} maxlength="240" /></label>
        <label class="dn-f"><span>{t('正文')}</span><textarea bind:value={draft.content} rows="10" spellcheck="false"></textarea></label>
      {:else}
        {#if note.description}<p class="dn-desc">{note.description}</p>{/if}
        <div class="dn-md md-body">{@html renderMarkdown(note.content || '')}</div>
        {#if note.evidence?.length || note.anchors?.length || note.scope?.length}
          <dl class="dn-facts">
            {#if note.evidence?.length}<dt>{t('证据')}</dt><dd>{#each note.evidence as e}<div>{e}</div>{/each}</dd>{/if}
            {#if note.anchors?.length}<dt>{t('挂靠文件')}</dt><dd>{#each note.anchors as a}<div class="mono">{a}</div>{/each}</dd>{/if}
            {#if note.scope?.length}<dt>{t('适用范围')}</dt><dd>{note.scope.join(t('、'))}</dd>{/if}
          </dl>
        {/if}
      {/if}

      {#if problems.length}
        <div class="dn-banner bad" role="alert">{#each problems as p}<div>{p}</div>{/each}</div>
      {/if}
      {#if conflicts}
        <div class="dn-banner" role="alert">
          <div>{t('同一主题已经有生效的「{titles}」。', { n: conflicts.length, titles: conflicts.map((c) => c.title).join(t('」「')) })}</div>
          {#if conflicts.length === 1}
            <div class="dn-acts end">
              <button class="dn-btn" disabled={!!busy} onclick={() => (conflicts = null)}>{t('先不动')}</button>
              <button class="dn-btn pri" disabled={!!busy} onclick={() => promote(conflicts[0].id)}>{t('替换它')}</button>
            </div>
          {:else}<div>{t('先把多余的那几条驳回或删掉，再来确认这一条。')}</div>{/if}
        </div>
      {/if}
      {#if done && !busy}<div class="dn-done">{done}</div>{/if}
    {:else}
      <div class="dn-msg"><span class="dn-spin"></span></div>
    {/if}
  </div>

  {#if note && !err}
    <footer class="dn-foot">
      {#if rejecting}
        <input class="dn-reason" bind:value={reason} maxlength="240" placeholder={t('为什么驳回（可选，模型以后会看到这句）')} />
        <div class="dn-acts">
          <button class="dn-btn" disabled={!!busy} onclick={() => (rejecting = false)}>{t('取消')}</button>
          <button class="dn-btn danger" disabled={!!busy} onclick={reject}>{t('确认驳回')}</button>
        </div>
      {:else}
        <div class="dn-acts">
          {#if canPromote && !editing}<button class="dn-btn" disabled={!!busy} onclick={startEdit}>{t('编辑')}</button>
          {:else if editing}<button class="dn-btn" disabled={!!busy} onclick={() => { editing = false; problems = []; }}>{t('取消编辑')}</button>{/if}
          {#if note.declaredStatus !== 'rejected'}<button class="dn-btn" disabled={!!busy} onclick={() => { rejecting = true; armed = false; }}>{t('驳回')}</button>{/if}
          <button class="dn-btn" class:danger={armed} disabled={!!busy} onclick={remove}>{armed ? t('再点一次删除') : t('删除')}</button>
          <span class="dn-sp"></span>
          {#if canPromote && (note.status !== 'active' || editing)}
            <button class="dn-btn pri" disabled={!!busy} onclick={() => promote()}>{busy === 'promote' ? t('处理中…') : editing ? t('保存并确认') : promoteLabel}</button>
          {/if}
          {#if note.declaredStatus === 'rejected'}<button class="dn-btn pri" disabled={!!busy} onclick={restore}>{t('撤销驳回')}</button>{/if}
        </div>
      {/if}
    </footer>
  {/if}
</div>

<style>
  .dn { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--bg); color: var(--text); animation: dnIn .16s ease; }
  @keyframes dnIn { from { opacity: 0; transform: translateX(10px); } }
  .dn-head { flex: none; display: flex; align-items: center; gap: 4px; padding: 0 12px 8px 4px; border-bottom: 1px solid var(--dk-line, var(--divider)); }
  .dn-t { flex: 1; min-width: 0; font-size: 15px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dn-ib { flex: none; width: 32px; height: 32px; border-radius: 9px; display: flex; align-items: center; justify-content: center; color: var(--serif); }
  .dn-ib svg { width: 18px; height: 18px; }
  .dn-ib:active { background: var(--hover-strong); }
  @media (hover: hover) { .dn-ib:hover { background: var(--hover); } }
  .dn-body { flex: 1; min-height: 0; overflow-y: auto; padding: 12px 16px 20px; overscroll-behavior: contain; user-select: text; }
  .dn-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
  .dn-st { padding: 1px 8px; border-radius: 999px; font-weight: 500; color: var(--text); box-shadow: inset 0 0 0 1px var(--divider); }
  .dn-st.held, .dn-st.rej { color: var(--crit); }
  .mono { font-family: Consolas, 'Cascadia Mono', Menlo, monospace; font-size: 11.5px; }
  .dn-desc { margin: 12px 0 4px; font-size: 14px; color: var(--serif); line-height: 1.6; }
  .dn-md { font-size: 14px; line-height: 1.7; }
  .dn-banner { margin: 10px 0; padding: 9px 12px; border-radius: 10px; font-size: 13px; line-height: 1.55; background: color-mix(in srgb, var(--text) 5%, transparent); }
  .dn-banner.bad { color: var(--crit); background: color-mix(in srgb, var(--crit) 9%, transparent); }
  .dn-issues { margin: 10px 0; padding-left: 18px; font-size: 12.5px; color: var(--crit); }
  .dn-facts { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin: 16px 0 0; font-size: 12.5px; }
  .dn-facts dt { color: var(--muted); }
  .dn-facts dd { margin: 0; min-width: 0; word-break: break-all; }
  .dn-f { display: flex; flex-direction: column; gap: 4px; margin: 12px 0 0; font-size: 12px; color: var(--muted); }
  .dn-f input, .dn-f textarea, .dn-reason { font: inherit; font-size: 13.5px; color: var(--text); background: color-mix(in srgb, var(--text) 5%, transparent);
    border: 0; border-radius: 9px; padding: 8px 10px; outline: none; box-shadow: inset 0 0 0 1px var(--divider); }
  .dn-f textarea { font-family: Consolas, 'Cascadia Mono', Menlo, monospace; font-size: 12.5px; resize: vertical; min-height: 160px; }
  .dn-foot { flex: none; display: flex; flex-direction: column; gap: 8px; padding: 10px 12px calc(10px + var(--sab, 0px)); border-top: 1px solid var(--dk-line, var(--divider)); }
  .dn-acts { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .dn-acts.end { justify-content: flex-end; margin-top: 8px; }
  .dn-sp { flex: 1; }
  .dn-btn { height: 32px; padding: 0 13px; border-radius: 999px; font-size: 13px; color: var(--text); box-shadow: inset 0 0 0 1px var(--divider); }
  .dn-btn:disabled { opacity: .5; }
  .dn-btn.pri { color: var(--bg); background: var(--text); box-shadow: none; }
  .dn-btn.danger { color: var(--crit); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--crit) 45%, transparent); }
  .dn-btn:active { opacity: .8; }
  @media (hover: hover) { .dn-btn:not(.pri):hover { background: var(--hover); } }
  @media (pointer: coarse) { .dn-btn { height: 40px; } }
  .dn-done { margin-top: 12px; font-size: 12.5px; color: var(--muted); }
  .dn-msg { display: flex; align-items: center; justify-content: center; min-height: 160px; color: var(--muted); font-size: 13.5px; }
  .dn-spin { width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--divider); border-top-color: var(--muted); animation: dnSpin .8s linear infinite; }
  @keyframes dnSpin { to { transform: rotate(360deg); } }
</style>
