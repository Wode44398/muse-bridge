<script>
  // 控制台 ·「接入新手机」卡（开源路线 S1-2）：点开才出配对二维码 + 8 位配对码（ConnectQr），手机 App 首屏「扫码连接」
  // 一扫就以管理员身份连上（发的是一张管理员会话，「用户 › 管理员登录」里能单独吊销）。下面是最近的配对记录
  // （/api/pair/connect/audit：谁出的码、哪台设备在什么时候从哪兑换、失败与封禁），只有元数据。
  // 样式沿用控制台的 sa-* 全局类（components/admin/admin.css）。
  import { api } from '../../lib/api.js';
  import { sa, fmtAgo } from '../../lib/serverAdmin.svelte.js';
  import { t, tr } from '../../lib/i18n.js';
  import ConnectQr from './ConnectQr.svelte';

  let open = $state(false);
  let log = $state(null);
  async function loadLog() {
    try { const r = await api.get('/api/pair/connect/audit'); log = (r.entries || []).filter((e) => e.ev !== 'mint').slice(0, 8); }
    catch { log = null; }
  }
  $effect(() => { sa.tick; open; loadLog(); });

  const EV = {
    redeem: () => t('已连接'),
    revoke: () => t('已撤销'),
    fail: () => t('兑换失败'),
    lock: () => t('触发限流'),
  };
  const WHY = {
    'bad-code': () => t('配对码不对'),
    'bad-qr': () => t('二维码无效'),
    'owner-invalid': () => t('出码的登录已失效'),
    ip: () => t('同一来源失败太多，封 15 分钟'),
    code: () => t('数字配对码失败太多，暂停 10 分钟'),
    // 失败审计限速（runtime/pair-connect.mjs）：一分钟里超过 30 次的只记一行计数
    suppressed: (e) => t('另有 {n} 次失败没有逐条记录', { n: e.n || 0 }),
  };
  const who = (e) => (e.as === 'admin' || e.by === 'admin' ? t('管理员') : (e.as || e.by || ''));
  const line = (e) => [EV[e.ev]?.() || e.ev, e.device ? tr(e.device) : '', e.why ? (WHY[e.why]?.(e) || e.why) : '', e.ev === 'redeem' || e.ev === 'revoke' ? who(e) : '']
    .filter(Boolean).join(' · ');
</script>

<div class="sa-card" style="margin-bottom:12px">
  <div class="sa-card-h ph">
    <span>{t('接入新手机')}</span>
    <span class="sa-sp"></span>
    <button class="sa-btn sm" onclick={() => { open = !open; }}>{open ? t('收起') : t('显示配对二维码')}</button>
  </div>
  {#if open}
    <ConnectQr via="console" />
  {:else}
    <div class="sa-rows"><div class="sa-row"><span class="sa-row-tx">{t('手机 App 首屏「扫码连接」扫一下就连上这台服务器，以管理员身份登录；不用抄地址和访问令牌。')}</span></div></div>
  {/if}
  {#if log && log.length}
    <div class="sa-rows">
      {#each log as e, i (i)}
        <div class="sa-row">
          <span class="sa-row-tx">{line(e)}{#if e.ip}<small class="sa-mono">{e.ip}</small>{/if}</span>
          <span class="sa-dim">{fmtAgo(Date.parse(e.t))}</span>
        </div>
      {/each}
    </div>
  {/if}
  <div style="height:8px"></div>
</div>

<style>
  .ph { display: flex; align-items: center; gap: 8px; }
</style>
