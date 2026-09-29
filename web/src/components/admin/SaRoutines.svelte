<script>
  // 定时任务：按用户查看其全部路由（名称/频率/下次/上次/状态/提示词）。只读监督面。
  import { api } from '../../lib/api.js';
  import { sa, fmtAgo } from '../../lib/serverAdmin.svelte.js';
  import { t, tc, locale, isEn } from '../../lib/i18n.js';

  let user = $state('admin');
  let list = $state([]);
  let loading = $state(true);
  const userList = $derived([{ name: 'admin' }, ...sa.users]);

  $effect(() => { sa.tick; user; load(); });
  async function load() {
    loading = true;
    try {
      const d = user === 'admin'
        ? await api.get('/api/routines')
        : await api.get('/api/admin/user/routines?name=' + encodeURIComponent(user));
      list = d?.routines || [];
    } catch { list = []; }
    loading = false;
  }

  const pad = (n) => String(n || 0).padStart(2, '0');
  // 钟点：中文照旧 HH:mm；英文按 en-US 12 小时制（2:30 PM）
  const hm = (h, m) => isEn()
    ? new Date(2000, 0, 1, h || 0, m || 0).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' })
    : `${pad(h)}:${pad(m)}`;
  function schedText(s) {
    if (!s) return '—';
    if (s.type === 'hourly') return t('每小时 :{mm}', { mm: pad(s.minute) });
    const time = hm(s.hour, s.minute);
    if (s.type === 'daily') return t('每天 {time}', { time });
    if (s.type === 'weekdays') return t('工作日 {time}', { time });
    if (s.type === 'weekly') return t('每周 {time}', { time });
    return `${s.type} ${time}`;
  }
  const nextText = (ts) => ts ? new Date(ts).toLocaleString(locale(), isEn()
    ? { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
    : { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
</script>

<div class="sa-chips" style="margin-bottom:12px">
  {#each userList as u (u.name)}
    <button class="sa-chip-btn" class:on={u.name === user} onclick={() => { user = u.name; }}>{u.name === 'admin' ? t('admin（我）') : u.name}</button>
  {/each}
</div>

<div class="sa-card">
  <div class="sa-card-h">{t('{user} 的定时任务', { user })}</div>
  {#if loading}
    <div class="sa-empty">{t('加载中…')}</div>
  {:else if !list.length}
    <div class="sa-empty">{t('无定时任务')}</div>
  {:else}
    <div class="sa-thead rcols"><span>{t('名称')}</span><span>{t('频率')}</span><span>{t('下次运行')}</span><span>{t('上次')}</span><span>{t('状态')}</span><span>{t('提示词')}</span></div>
    {#each list as r (r.id || r.name)}
      <div class="sa-tr rcols">
        <span class="sa-hrow" style="gap:7px;min-width:0">
          <b class="sa-trunc">{r.name || t('(未命名)')}</b>
          {#if r.enabled === false}<span class="sa-badge gray">{tc('开关', '停用')}</span>{/if}
        </span>
        <span class="sa-mut">{schedText(r.schedule)}</span>
        <span class="sa-mut sa-mono" style="font-size:12px">{nextText(r.nextRun)}</span>
        <span class="sa-mut">{r.lastRun ? fmtAgo(r.lastRun) : '—'}</span>
        <span>
          {#if r.lastStatus === 'running'}<span class="sa-badge amber"><span class="sa-live"></span>{t('运行中')}</span>
          {:else if r.lastStatus === 'ok'}<span class="sa-badge green">{t('成功')}</span>
          {:else if r.lastStatus === 'error'}<span class="sa-badge red">{t('出错')}</span>
          {:else}<span class="sa-badge gray">—</span>{/if}
        </span>
        <span class="sa-trunc sa-dim" title={r.prompt || ''}>{r.prompt || ''}</span>
      </div>
    {/each}
    <div style="height:8px"></div>
  {/if}
</div>
<div class="sa-foot">{t('调度器只在生产实例跑（30s tick，GMT+8 预设频率）；宕机错过的触发顺延不补跑。编辑路由请到该用户自己的「定时触发」页。')}</div>

<style>
  .rcols { grid-template-columns: minmax(110px, 1fr) 92px 110px 70px 84px minmax(140px, 1.3fr); }
  @media (max-width: 1080px) {
    .rcols { grid-template-columns: minmax(100px, 1fr) 90px 84px; }
    .rcols > :nth-child(3), .rcols > :nth-child(4), .rcols > :nth-child(6) { display: none; }
  }
  /* 英文：「Weekdays at 12:30 PM」「Sep 28, 12:30 PM」「Succeeded」比中文宽 */
  :global(html[lang='en']) .rcols { grid-template-columns: minmax(110px, 1fr) 140px 124px 80px 96px minmax(140px, 1.3fr); }
  @media (max-width: 1080px) {
    :global(html[lang='en']) .rcols { grid-template-columns: minmax(100px, 1fr) 140px 96px; }
  }
</style>
