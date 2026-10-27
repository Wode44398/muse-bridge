<script>
  // 设置 › Claude 页顶上的一小块：Claude Code 运行组件的状态（开源路线 2.2：安装包不再内嵌它，首次启动由服务端
  // 从官方源下到数据根，见服务端 runtime/claude-cli.mjs）。下载中显示进度；失败显示原因与「重试」；
  // 退而在用本机版本不一致的 Claude Code 时提醒一句。就绪且配套时什么都不显示。
  // 状态只给管理员（GET /api/claude-cli）；拿不到（普通用户、老服务端没有这个接口）就整块不出现。
  // 颜色沿用所在设置页的变量（手机 --i-*、桌面 --dsk-*），两边都放得进去。
  import { onDestroy } from 'svelte';
  import { api } from '../lib/api.js';
  import { t, tr } from '../lib/i18n.js';

  let st = $state(null);
  let busy = $state(false);
  let timer = null;
  let gone = false;
  const MB = (n) => Math.round((n || 0) / 1048576);

  async function load() {
    try { st = await api.get('/api/claude-cli'); } catch { st = null; }
    clearTimeout(timer);
    if (gone || !st) return;
    // 下载 / 校验中 1.5 秒刷一次；没就绪的其余情形 10 秒一次（服务端会自己隔一阵再试）
    const moving = st.state === 'downloading' || st.state === 'verifying' || !!st.progress;
    if (moving || st.state !== 'ready') timer = setTimeout(load, moving ? 1500 : 10000);
  }
  load();
  onDestroy(() => { gone = true; clearTimeout(timer); });

  async function retry() {
    if (busy) return;
    busy = true;
    try { st = await api.post('/api/claude-cli/retry', {}); } catch {}
    busy = false;
    load();
  }

  const pct = $derived(st?.progress?.total ? Math.min(100, Math.floor((st.progress.done / st.progress.total) * 100)) : 0);
  const mismatch = $derived(st?.state === 'ready' && st?.source === 'local-mismatch');
  const show = $derived(!!st && (st.state !== 'ready' || mismatch));
  const bad = $derived(st?.state === 'failed' || st?.state === 'missing');
  const head = $derived(!st ? ''
    : st.state === 'downloading' ? t('正在下载 · {pct}%', { pct })
    : st.state === 'verifying' ? t('正在校验…')
    : st.state === 'failed' ? t('没装好')
    : st.state === 'missing' ? t('没找到')
    : mismatch ? t('在用本机的 {have}', { have: st.version || '?' }) : '');
  const canRetry = $derived(!!st && st.download && !st.progress && st.state !== 'verifying' && (st.state === 'failed' || mismatch));
</script>

{#if show}
  <div class="ccs" class:bad>
    <div class="ccs-h">
      <span class="ccs-t">{t('Claude Code 运行组件')}</span>
      <span class="ccs-s">{head}</span>
    </div>
    {#if st.progress}
      <div class="ccs-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow={pct}><i style:width="{pct}%"></i></div>
      <p class="ccs-n">{t('{done} / {total} MB · 来自 {host}', { done: MB(st.progress.done), total: MB(st.progress.total), host: st.progress.host || '' })}</p>
      <!-- 下载量（压缩包）与解开后的大小分开说：progress.packed = 进度按压缩包算（服务端拿到了 Content-Length） -->
      {#if !mismatch}
        {#if st.progress.packed}<p class="ccs-n">{t('首次使用要从官方源下载约 {mb} MB（解开后约 {full} MB），只需一次；下载完就能对话。', { mb: MB(st.progress.total), full: MB(st.size) })}</p>
        {:else}<p class="ccs-n">{t('首次使用要从官方源下载运行组件（解开后约 {full} MB），只需一次；下载完就能对话。', { full: MB(st.size || st.progress.total) })}</p>{/if}
      {/if}
    {/if}
    {#if mismatch}<p class="ccs-n">{t('需要 {want}，正在用本机的 {have}，个别功能可能不正常。', { want: st.want || '?', have: st.version || '?' })}</p>{/if}
    {#if st.error}<p class="ccs-n" class:err={bad}>{tr(st.error)}</p>{/if}
    {#if st.state === 'missing'}<p class="ccs-n">{t('没找到 Claude Code {want}：在运行 bridge 服务端的电脑上安装它，或在服务端 config.json 里用 claudeCliPath 指定位置。', { want: st.want || '' })}</p>{/if}
    {#if canRetry}<button type="button" class="ccs-btn" onclick={retry} disabled={busy}>{busy ? t('正在重试…') : t('重试')}</button>{/if}
  </div>
{/if}

<style>
  .ccs {
    margin: 0 0 14px; padding: 12px 14px; border-radius: 14px;
    background: var(--i-card, var(--dsk-panel, rgba(127, 127, 127, .08)));
    color: var(--i-label, var(--dsk-ink, inherit));
    font-size: 13px; line-height: 1.5;
  }
  .ccs-h { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
  .ccs-t { font-weight: 600; }
  .ccs-s { color: var(--i-label2, var(--dsk-ink-2, currentColor)); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .ccs.bad .ccs-s, .ccs-n.err { color: var(--i-red, var(--dsk-crit, #c0392b)); }
  .ccs-bar { height: 4px; margin: 9px 0 6px; border-radius: 2px; overflow: hidden; background: var(--i-fill3, var(--dsk-ctl, rgba(127, 127, 127, .2))); }
  .ccs-bar i { display: block; height: 100%; background: var(--i-accent, var(--dsk-accent, currentColor)); transition: width .3s ease; }
  .ccs-n { margin: 3px 0 0; font-size: 12px; color: var(--i-label2, var(--dsk-ink-2, currentColor)); overflow-wrap: anywhere; }
  .ccs-btn {
    margin-top: 9px; padding: 4px 14px; border-radius: 8px; font: inherit; font-size: 12.5px; cursor: pointer;
    color: inherit; background: transparent; border: 1px solid var(--i-sep, var(--dsk-line, rgba(127, 127, 127, .35)));
  }
  .ccs-btn:disabled { opacity: .55; cursor: default; }
</style>
