<script>
  // 设置 · 账户：个人资料、订阅用量、工作空间 / 扫码登录网页版、退出登录。
  // 没登录时只给一个「登录」入口（登录卡是单独的覆盖层，见 LoginCard.svelte）。
  import { ui, me, status, applyMe } from '../../lib/state.svelte.js';
  import { api, setToken } from '../../lib/api.js';
  import { fetchMyUsage, changeMyPassword, quotaRows, hasLimits } from '../../lib/me.js';
  import SSection from './SSection.svelte';
  import SRow from './SRow.svelte';
  import SButton from './SButton.svelte';
  import SField from './SField.svelte';

  let { onclose } = $props();

  const roleLabel = $derived(me.kind === 'admin' ? '管理员'
    : me.kind === 'user' ? (me.tier === 'pro' ? 'Pro 用户' : '普通用户') : '未登录');
  const shownName = $derived(me.user || (me.kind === 'admin' ? 'admin' : ''));
  const initial = $derived((shownName || '?').trim().charAt(0).toUpperCase());
  // 「扫一扫」只给触屏：电脑拿摄像头对着另一块屏幕扫码不是正常用法。
  const canScan = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } })();

  $effect(() => {
    if (me.kind === 'none') return;
    api.status().then((s) => {
      status.limits = s.limits || null;
      status.context = s.context || null;
      if (s.plan) status.plan = s.plan;
      status.updatedAt = Date.now();
    }).catch(() => {});
  });
  const lim = $derived(status.limits || {});
  const pct = (b) => (b && typeof b.pct === 'number' ? Math.max(0, Math.min(100, Math.round(b.pct))) : null);
  const fiveH = $derived(pct(lim.five_hour));
  const weekly = $derived(pct(lim.seven_day));
  // 「3 小时后重置」这种人话；过去的 / 没给的不显示
  function resetIn(b) {
    const t = b && b.resetsAt;
    if (!t) return '';
    const s = Math.round((t - Date.now()) / 1000);
    if (s <= 0) return '';
    if (s < 3600) return Math.max(1, Math.round(s / 60)) + ' 分钟后重置';
    if (s < 86400) return Math.round(s / 3600) + ' 小时后重置';
    return Math.round(s / 86400) + ' 天后重置';
  }

  // —— 我的额度 / 改密码（注册用户）——
  let mine = $state(null);
  $effect(() => { if (me.kind === 'user') fetchMyUsage().then((r) => { mine = r; }).catch(() => {}); });
  let pw = $state(null);             // null | { old, next, again, busy, err, done }
  async function savePw() {
    if (!pw || pw.busy) return;
    if (pw.next.length < 8) { pw.err = '新密码至少 8 位'; return; }
    if (pw.next !== pw.again) { pw.err = '两次输入的新密码不一致'; return; }
    pw.busy = true; pw.err = '';
    try { await changeMyPassword(pw.old, pw.next); pw = { done: true }; }
    catch (e) { pw.err = e?.body?.error || '修改失败'; pw.busy = false; }
  }

  function openWorkspace() { onclose?.(); ui.screen = 'files'; }
  function openScan() { onclose?.(); ui.pairScan = { mode: 'scan' }; }
  function login() { onclose?.(); ui.loginOpen = true; }
  let busy = $state(false);
  async function logout() {
    if (busy) return;
    busy = true;
    try { await api.logout(); } catch {}
    setToken(null);
    applyMe(null);
    busy = false;
    onclose?.();
    ui.loginOpen = true;
  }
</script>

{#if me.kind !== 'none'}
  <SSection title="个人资料">
    <SRow label="头像" sid="avatar">
      {#snippet trailing()}<span class="av" aria-hidden="true">{initial}</span>{/snippet}
    </SRow>
    <SRow label="用户名" sid="username">
      {#snippet trailing()}<span class="val">{shownName}</span>{/snippet}
    </SRow>
    <SRow label="身份" sid="role">
      {#snippet trailing()}<span class="val">{roleLabel}{status.plan ? ' · ' + status.plan : ''}</span>{/snippet}
    </SRow>
  </SSection>

  <SSection title="用量" foot="共享订阅的滚动用量：5 小时窗口与 7 天窗口，用满后随窗口滑动释放。">
    <div class="usage" data-sid="usage">
      {#each [['当前会话（5 小时）', fiveH, lim.five_hour], ['本周', weekly, lim.seven_day]] as [name, p, b] (name)}
        <div class="u">
          <div class="u-top">
            <span class="u-l">{name}</span>
            <span class="u-v">{p == null ? '—' : p + '% 已用'}</span>
          </div>
          <span class="bar">{#if p != null}<i style:width="{p}%" class:hot={p >= 80}></i>{/if}</span>
          {#if resetIn(b)}<span class="u-r">{resetIn(b)}</span>{/if}
        </div>
      {/each}
    </div>
  </SSection>

  {#if me.kind === 'user'}
    <SSection title="我的额度" foot={hasLimits(mine) ? '只算 Claude 的对话轮数与花费；「今天」按' + (mine.timezone === 'Asia/Shanghai' ? '北京时间' : mine.timezone) + ' 0 点换日。' : '管理员没给你设上限。'}>
      {#if mine}
        {#each quotaRows(mine) as r (r.label)}
          <SRow label={r.label} sid={r.label === '今天' ? 'quota' : ''}>
            {#snippet trailing()}<span class="val" class:hot={r.hot}>{r.value}</span>{/snippet}
          </SRow>
        {/each}
      {:else}
        <SRow label="读取中…" />
      {/if}
    </SSection>

    <SSection title="密码">
      {#if pw && !pw.done}
        <div class="pwf" data-sid="password">
          <SField password bind:value={pw.old} placeholder="原密码" width="100%" />
          <SField password bind:value={pw.next} placeholder="新密码（至少 8 位）" width="100%" />
          <SField password bind:value={pw.again} placeholder="再输一次新密码" width="100%" />
          {#if pw.err}<p class="err">{pw.err}</p>{/if}
          <div class="pw-b">
            <SButton onclick={() => { pw = null; }}>取消</SButton>
            <SButton variant="primary" size="md" onclick={savePw} disabled={pw.busy}>{pw.busy ? '保存中…' : '保存'}</SButton>
          </div>
        </div>
      {:else}
        <SRow label="修改密码" desc={pw?.done ? '已改好。别的设备要用新密码重新登录，这台不受影响。' : '改完之后，别的设备需要重新登录'} sid="password">
          {#snippet trailing()}<SButton onclick={() => { pw = { old: '', next: '', again: '', busy: false, err: '' }; }}>修改</SButton>{/snippet}
        </SRow>
      {/if}
    </SSection>
  {/if}

  <SSection title="工作空间">
    <SRow label="文件与分享" desc="工作空间里的文件、上传与分享链接" sid="workspace">
      {#snippet trailing()}<SButton onclick={openWorkspace}>打开</SButton>{/snippet}
    </SRow>
    {#if canScan}
      <SRow label="登录网页版" desc="扫电脑上网页登录页的二维码，在手机上确认即可登录，免输密码" sid="scan">
        {#snippet trailing()}<SButton onclick={openScan}>扫一扫</SButton>{/snippet}
      </SRow>
    {/if}
  </SSection>

  <SSection title="账户">
    <SRow label="退出登录" desc="只退出这台设备，其它设备上的登录不受影响" sid="logout">
      {#snippet trailing()}<SButton onclick={logout} disabled={busy}>退出</SButton>{/snippet}
    </SRow>
  </SSection>
{:else}
  <SSection title="账户">
    <SRow label="未登录" desc="登录后才能使用对话、工作空间与用量" sid="login">
      {#snippet trailing()}<SButton variant="primary" size="md" onclick={login}>登录</SButton>{/snippet}
    </SRow>
  </SSection>
{/if}

<style>
  .av { width: 32px; height: 32px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
    background: var(--avatar-bg); color: var(--text); font-size: 14px; font-weight: 560; }
  .val { font-size: 14px; color: var(--st-text2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 260px; }

  .usage { display: flex; flex-direction: column; gap: 18px; padding: 12px 0 14px; }
  .u { display: flex; flex-direction: column; gap: 8px; }
  .u-top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .u-l { font-size: 14px; color: var(--text); }
  .u-v { font-size: 13px; color: var(--st-muted); font-variant-numeric: tabular-nums; }
  .bar { display: block; height: 6px; border-radius: 999px; background: var(--st-seg); overflow: hidden; }
  .bar i { display: block; height: 100%; min-width: 2px; border-radius: 999px; background: var(--st-accent); transition: width .4s var(--ea-std); }
  .bar i.hot { background: var(--crit); }
  .u-r { font-size: 12.5px; color: var(--st-muted); }
  :global(.stg.compact) .usage { padding: 14px 0 16px; }
  .val.hot { color: var(--crit); }
  .pwf { display: flex; flex-direction: column; gap: 8px; padding: 12px 0 14px; }
  .pw-b { display: flex; justify-content: flex-end; gap: 8px; }
  .err { margin: 0; font-size: 13px; color: var(--crit); }
</style>
