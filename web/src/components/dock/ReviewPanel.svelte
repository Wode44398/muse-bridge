<script>
  // 审阅面板：工作空间 worktree 概览（基线 → working tree 的变更清单），
  // 行点开懒加载单文件 unified diff（+绿 −红），Claude 分页配色。
  import { api } from '../../lib/api.js';
  import { dock } from '../../lib/dock.svelte.js';
  import { t, tc, tr } from '../../lib/i18n.js';
  let { dockState = dock } = $props();

  let loading = $state(true);
  let err = $state('');
  let data = $state(null);          // { git, branch, base, files:[{path,from,add,del,bin,st}], total, truncated }
  let open = $state({});            // path -> { loading, text, bin, truncated, err }

  const enc = encodeURIComponent;

  async function refresh() {
    loading = true; err = '';
    try {
      data = await api.get(`/api/claude/review?ws=${enc(dockState.ws)}`);
      open = {};
    } catch (e) { err = tr(e?.body?.error || e?.body) || t('加载失败'); data = null; }
    loading = false;
  }
  $effect(() => { if (dockState.ws) refresh(); });

  async function toggle(f) {
    if (open[f.path]) { const { [f.path]: _, ...rest } = open; open = rest; return; }
    open = { ...open, [f.path]: { loading: true } };
    try {
      // 注意别用 st= 传状态——st/ct 是身份系统保留参数（share/snap token），会被识别成假身份 401。
      const q = `ws=${enc(dockState.ws)}&file=${enc(f.path)}${f.st === 'U' ? '&u=1' : ''}${f.from ? `&from=${enc(f.from)}` : ''}`;
      const d = await api.get(`/api/claude/review/diff?${q}`);
      open = { ...open, [f.path]: { loading: false, text: d.text || '', bin: !!d.bin, truncated: !!d.truncated } };
    } catch (e) {
      open = { ...open, [f.path]: { loading: false, err: tr(e?.body?.error) || t('加载失败') } };
    }
  }

  // unified diff → 渲染行分类（hunk 头 / + / − / 上下文；文件头 diff/index/---/+++ 淡化）。
  function diffLines(text) {
    const out = [];
    for (const l of String(text || '').split('\n')) {
      let cls = 'ctx';
      if (l.startsWith('@@')) cls = 'hunk';
      else if (l.startsWith('+++') || l.startsWith('---') || l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('new file') || l.startsWith('deleted file') || l.startsWith('rename ') || l.startsWith('similarity ') || l.startsWith('Binary files')) cls = 'meta';
      else if (l.startsWith('+')) cls = 'add';
      else if (l.startsWith('-')) cls = 'del';
      else if (l.startsWith('\\')) cls = 'meta';
      out.push({ cls, l });
    }
    while (out.length && out[out.length - 1].l === '') out.pop();
    return out;
  }

  const stLabel = { A: tc('diff', '新增'), D: tc('diff', '删除'), R: tc('diff', '改名'), U: tc('diff', '未跟踪'), C: tc('diff', '复制') };
</script>

<div class="rv">
  {#if loading}
    <div class="rv-empty"><span class="spin"></span>{t('正在读取变更…')}</div>
  {:else if err}
    <div class="rv-empty">{err}<button class="rv-retry" onclick={refresh}>{t('重试')}</button></div>
  {:else if !data || !data.git}
    <div class="rv-empty">{t('该工作空间不是 git 仓库')}</div>
  {:else}
    <div class="rv-head">
      <span class="rv-branch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.6"/><circle cx="6" cy="18" r="2.6"/><circle cx="18" cy="8" r="2.6"/><path d="M6 8.6v6.8M18 10.6c0 4-5 3.4-8 5"/></svg>{data.base}</span>
      <span class="rv-arrow">→</span>
      <span class="rv-wt">working tree</span>
      <button class="rv-refresh" aria-label={t('刷新')} onclick={refresh}><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v5h-5"/></svg></button>
    </div>
    {#if !data.files.length}
      <div class="rv-empty">{t('工作树很干净，没有改动')}</div>
    {:else}
      <div class="rv-hint">{t('大文件默认折叠，点击文件展开 diff。共 {n} 个文件', { n: data.files.length })} <em class="add">+{data.total.add}</em> <em class="del">−{data.total.del}</em>{#if data.truncated}{t('（已截断）')}{/if}</div>
      <div class="rv-list">
        {#each data.files as f (f.path)}
          <div class="rv-file">
            <button class="rv-row" onclick={() => toggle(f)}>
              <svg class="chev" class:open={!!open[f.path]} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>
              <span class="rv-name" title={f.from ? `${f.from} → ${f.path}` : f.path}>{f.path}</span>
              {#if f.st && f.st !== 'M'}<span class="rv-st st-{f.st}">{stLabel[f.st] || f.st}</span>{/if}
              {#if f.bin}<span class="rv-bin">{t('二进制')}</span>{:else}<span class="rv-count add">+{f.add}</span><span class="rv-count del">−{f.del}</span>{/if}
            </button>
            {#if open[f.path]}
              <div class="rv-diff">
                {#if open[f.path].loading}
                  <div class="rv-dload"><span class="spin"></span></div>
                {:else if open[f.path].err}
                  <div class="rv-dload">{open[f.path].err}</div>
                {:else if open[f.path].bin}
                  <div class="rv-dload">{t('二进制文件，无法展示 diff')}</div>
                {:else if !open[f.path].text}
                  <div class="rv-dload">{t('（无差异内容）')}</div>
                {:else}
                  <div class="rv-code">
                    {#each diffLines(open[f.path].text) as ln}
                      <div class="dl {ln.cls}">{ln.l || ' '}</div>
                    {/each}
                    {#if open[f.path].truncated}<div class="dl meta">{t('…（diff 过长，已截断）')}</div>{/if}
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .rv { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow-y: auto; padding: 4px 10px 16px; }
  .rv::-webkit-scrollbar { width: 6px; }
  .rv::-webkit-scrollbar-track { background: transparent; }
  .rv::-webkit-scrollbar-thumb { background: color-mix(in srgb, var(--muted) 38%, transparent); border-radius: 999px; }

  .rv-empty { flex: none; display: flex; align-items: center; justify-content: center; gap: 10px; color: var(--muted); font-size: 14px; padding: 48px 16px; text-align: center; }
  .rv-retry { color: var(--coral); padding: 4px 10px; border-radius: 8px; }
  .rv-retry:active { background: var(--hover); }

  .rv-head { display: flex; align-items: center; gap: 8px; padding: 10px 6px 4px; font-size: 14px; color: var(--text); }
  .rv-branch { display: flex; align-items: center; gap: 6px; font-weight: 560; }
  .rv-branch svg { width: 16px; height: 16px; color: var(--muted); }
  .rv-arrow { color: var(--muted); }
  .rv-wt { color: var(--serif); }
  .rv-refresh { margin-left: auto; width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center; color: var(--muted); }
  .rv-refresh svg { width: 16px; height: 16px; }
  .rv-refresh:active { background: var(--hover); }
  @media (hover: hover) { .rv-refresh:hover { background: var(--hover); color: var(--text); } }

  .rv-hint { color: var(--muted); font-size: 12px; padding: 2px 6px 10px; }
  .rv-hint .add { color: var(--ok); font-style: normal; }
  .rv-hint .del { color: var(--crit); font-style: normal; }

  .rv-list { display: flex; flex-direction: column; gap: 2px; }
  .rv-row { width: 100%; display: flex; align-items: center; gap: 7px; padding: 7px 8px; border-radius: 8px; font-size: 13.5px; color: var(--serif); text-align: left; transition: background-color .12s ease; }
  .rv-row:active { background: var(--hover); }
  @media (hover: hover) { .rv-row:hover { background: var(--hover); color: var(--text); } }
  .chev { width: 14px; height: 14px; flex: none; color: var(--muted); transition: transform .16s ease; }
  .chev.open { transform: rotate(90deg); }
  .rv-name { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; direction: rtl; text-align: left; }
  .rv-name::after { content: '\200e'; }
  .rv-st { flex: none; font-size: 11px; padding: 1px 6px; border-radius: 6px; background: var(--hover); color: var(--muted); }
  /* st-* / dl 的分类 class 是模板插值动态拼的，scoped 规则会被编译器当 unused 剪掉——:global 保住 */
  .rv-st:global(.st-A), .rv-st:global(.st-U) { color: var(--ok); }
  .rv-st:global(.st-D) { color: var(--crit); }
  .rv-bin { flex: none; font-size: 12px; color: var(--muted); }
  .rv-count { flex: none; font-size: 12.5px; font-variant-numeric: tabular-nums; }
  .rv-count.add { color: var(--ok); }
  .rv-count.del { color: var(--crit); }

  .rv-diff { margin: 2px 0 8px 20px; border: 1px solid var(--divider); border-radius: 10px; overflow: hidden; }
  .rv-dload { display: flex; align-items: center; justify-content: center; gap: 8px; color: var(--muted); font-size: 13px; padding: 16px; }
  .rv-code { overflow-x: auto; font-family: Consolas, 'Cascadia Mono', Menlo, monospace; font-size: 12px; line-height: 1.5; padding: 6px 0; }
  .dl { white-space: pre; padding: 0 10px; min-width: max-content; }
  .dl:global(.add) { background: color-mix(in srgb, var(--ok) 12%, transparent); color: var(--text); }
  .dl:global(.del) { background: color-mix(in srgb, var(--crit) 11%, transparent); color: var(--text); }
  .dl:global(.hunk) { color: #7aa2f7; background: color-mix(in srgb, #7aa2f7 7%, transparent); padding-top: 2px; padding-bottom: 2px; }
  .dl:global(.meta) { color: var(--muted); }
  .dl:global(.ctx) { color: var(--serif); }

  .spin { width: 14px; height: 14px; border: 2px solid var(--divider); border-top-color: var(--coral); border-radius: 50%; animation: rvspin .8s linear infinite; flex: none; }
  @keyframes rvspin { to { transform: rotate(360deg); } }
</style>
