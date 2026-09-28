<script>
  // 定时任务：按用户查看其全部路由（名称/频率/下次/上次/状态/提示词）。只读监督面。
  import { api } from '../../lib/api.js';
  import { sa, fmtAgo } from '../../lib/serverAdmin.svelte.js';

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
  function schedText(s) {
    if (!s) return '—';
    if (s.type === 'hourly') return `每小时 :${pad(s.minute)}`;
    const t = { daily: '每天', weekdays: '工作日', weekly: '每周' }[s.type] || s.type;
    return `${t} ${pad(s.hour)}:${pad(s.minute)}`;
  }
  const nextText = (ts) => ts ? new Date(ts).toLocaleString('zh', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—';
</script>

<div class="sa-chips" style="margin-bottom:12px">
  {#each userList as u (u.name)}
    <button class="sa-chip-btn" class:on={u.name === user} onclick={() => { user = u.name; }}>{u.name === 'admin' ? 'admin（我）' : u.name}</button>
  {/each}
</div>

<div class="sa-card">
  <div class="sa-card-h">{user} 的定时任务</div>
  {#if loading}
    <div class="sa-empty">加载中…</div>
  {:else if !list.length}
    <div class="sa-empty">无定时任务</div>
  {:else}
    <div class="sa-thead rcols"><span>名称</span><span>频率</span><span>下次运行</span><span>上次</span><span>状态</span><span>提示词</span></div>
    {#each list as r (r.id || r.name)}
      <div class="sa-tr rcols">
        <span class="sa-hrow" style="gap:7px;min-width:0">
          <b class="sa-trunc">{r.name || '(未命名)'}</b>
          {#if r.enabled === false}<span class="sa-badge gray">停用</span>{/if}
        </span>
        <span class="sa-mut">{schedText(r.schedule)}</span>
        <span class="sa-mut sa-mono" style="font-size:12px">{nextText(r.nextRun)}</span>
        <span class="sa-mut">{r.lastRun ? fmtAgo(r.lastRun) : '—'}</span>
        <span>
          {#if r.lastStatus === 'running'}<span class="sa-badge amber"><span class="sa-live"></span>运行中</span>
          {:else if r.lastStatus === 'ok'}<span class="sa-badge green">成功</span>
          {:else if r.lastStatus === 'error'}<span class="sa-badge red">出错</span>
          {:else}<span class="sa-badge gray">—</span>{/if}
        </span>
        <span class="sa-trunc sa-dim" title={r.prompt || ''}>{r.prompt || ''}</span>
      </div>
    {/each}
    <div style="height:8px"></div>
  {/if}
</div>
<div class="sa-foot">调度器只在生产实例跑（30s tick，GMT+8 预设频率）；宕机错过的触发顺延不补跑。编辑路由请到该用户自己的「定时触发」页。</div>

<style>
  .rcols { grid-template-columns: minmax(110px, 1fr) 92px 110px 70px 84px minmax(140px, 1.3fr); }
  @media (max-width: 1080px) {
    .rcols { grid-template-columns: minmax(100px, 1fr) 90px 84px; }
    .rcols > :nth-child(3), .rcols > :nth-child(4), .rcols > :nth-child(6) { display: none; }
  }
</style>
