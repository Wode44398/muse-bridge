<script>
  // 「手机扫码连接」出示卡（开源路线 S1-2）：二维码 + 8 位数字配对码 + 倒计时，手机 App 首屏「扫码连接」一扫就连上，
  // 换到的是出示者自己身份的一张长期会话（管理员 → 管理员会话；普通账号 → 他自己的账号会话），拿不到主令牌。
  // 用在：桌面设置「连接与更新」、手机设置「关于」、服务端控制台「设备」。桌面客户端向导完成页走同一个接口，自己画（壳里没有 Svelte）。
  // 状态机在 lib/connectPair.js（startConnectPresenter）：挂上即领票，3 分钟过期自动换（最多 6 张），卸载时作废还没用的票。
  // 码由服务端画成 SVG（src/runtime/qr.mjs），这里只放进白底方块（深色主题下也扫得出）。
  // 不给「复制链接」：链接里就是这张票，贴进聊天记录等于把登录交出去；没有相机的用 8 位配对码。
  import { onDestroy, untrack } from 'svelte';
  import { startConnectPresenter } from '../../lib/connectPair.js';
  import { t, tr } from '../../lib/i18n.js';

  /** @type {{ compact?: boolean, via?: string }} */
  let { compact = false, via = '' } = $props();

  // 「不是你？撤销」的窗口：服务端兑换后留 10 分钟（runtime/pair-connect.mjs 的 KEEP_DONE），这边按收到「已连接」的时刻算、留半分钟余量；
  // 过了就收起按钮，改成一行字告诉他去哪收回
  const REVOKE_MS = 9.5 * 60 * 1000;

  let st = $state({ status: 'loading' });
  let receivedAt = 0;
  let redeemedAt = $state(0);
  let now = $state(Date.now());
  let busy = $state(false);

  const ctl = startConnectPresenter((u) => {
    if (u.status === 'pending') receivedAt = Date.now();
    if (u.status === 'redeemed') redeemedAt = Date.now();
    st = u;
  }, { via: untrack(() => via) });   // 出码来源只在领票时报一次，之后改了也不用重领
  const tick = setInterval(() => { now = Date.now(); }, 1000);
  onDestroy(() => { clearInterval(tick); ctl.stop(); });

  const tk = $derived(st.ticket || null);
  const left = $derived(tk && st.status === 'pending' ? Math.max(0, Math.round((receivedAt + (tk.ttl || 180000) - now) / 1000)) : 0);
  const leftText = $derived(left >= 60 ? Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') : String(left));
  const host = $derived(tk ? String(tk.origin || '').replace(/^https?:\/\//, '') : '');
  const asText = $derived(tk?.as?.kind === 'admin' ? t('以管理员身份登录') : t('以 {user} 的身份登录', { user: tk?.as?.user || '' }));
  const canRevoke = $derived(!!st.info?.revocable && now - redeemedAt < REVOKE_MS);

  async function revoke() {
    if (busy) return;
    busy = true;
    try { await ctl.revoke(); } catch (e) { st = { ...st, error: tr(e?.body?.error) || t('撤销失败') }; }
    busy = false;
  }
</script>

<div class="cq" class:compact>
  <div class="tile" class:dim={st.status !== 'pending'} aria-hidden={st.status !== 'pending'}>
    {#if tk?.svg && (st.status === 'pending' || st.status === 'loading')}{@html tk.svg}{/if}
    {#if st.status === 'loading'}
      <span class="ov"><span class="spin"></span></span>
    {:else if st.status === 'redeemed'}
      <span class="ov ok"><svg viewBox="0 0 48 48" width="40" height="40"><circle cx="24" cy="24" r="20" fill="none" stroke="currentColor" stroke-width="2.6"/><path d="M15 24l6 6 12-12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
    {:else if st.status !== 'pending'}
      <button class="ov tap" onclick={() => ctl.refresh()}>
        <b>{st.status === 'error' ? t('出错了') : st.status === 'revoked' ? t('已撤销') : t('二维码已过期')}</b>
        <small>{t('点击刷新')}</small>
      </button>
    {/if}
  </div>

  <div class="meta">
    {#if st.status === 'redeemed'}
      <div class="title">{t('已连接：{device}', { device: tr(st.info?.device) || t('未知设备') })}</div>
      <div class="sub">{asText}{st.info?.ip ? ' · ' + st.info.ip : ''}</div>
      <div class="acts">
        <button class="btn" onclick={() => ctl.refresh()}>{t('再连一台')}</button>
        {#if canRevoke}<button class="btn danger" onclick={revoke} disabled={busy}>{t('不是你？撤销')}</button>{/if}
      </div>
      {#if st.info?.revocable && !canRevoke}
        <div class="hint">{tk?.as?.kind === 'admin' ? t('要收回那台设备的登录：去控制台「管理员登录」或「设备」里单独吊销。') : t('要收回那台设备的登录：在「设置 › 账户」改一次密码，别的设备上的登录会全部下线。')}</div>
      {/if}
      {#if st.error}<div class="err">{st.error}</div>{/if}
    {:else if st.status === 'revoked'}
      <div class="title">{t('已撤销这次连接')}</div>
      <div class="sub">{t('那台设备刚拿到的登录已经作废。')}</div>
      <div class="acts"><button class="btn" onclick={() => ctl.refresh()}>{t('重新出码')}</button></div>
    {:else if st.status === 'error'}
      <div class="title">{t('没出成二维码')}</div>
      <div class="sub err">{st.error}</div>
      <div class="acts"><button class="btn" onclick={() => ctl.refresh()}>{t('重试')}</button></div>
    {:else}
      <div class="lab">{t('配对码')}</div>
      <!-- 只在码还能用时显示数字：过期 / 作废了还亮着，会有人照抄去输，白白记一次失败 -->
      <div class="code sel-text">{tk && st.status === 'pending' ? tk.codeText : '···· ····'}</div>
      <div class="sub">
        {#if st.status === 'pending'}{t('{t} 后换新码', { t: leftText })} · {asText}{:else if st.status === 'expired'}{t('二维码已过期')}{:else}&nbsp;{/if}
      </div>
      {#if tk && !tk.reachable}
        <div class="warn">{t('这台服务器只允许本机访问，手机连不上：先打开公网访问，或允许局域网连接，再出码。')}</div>
      {:else if host}
        <div class="sub">{t('手机会连到 {host}', { host })}</div>
      {/if}
      {#if !compact}
        <div class="hint">{t('用手机上的 The Bridge App 扫码（首屏「扫码连接」）；没装 App 用相机扫，也能直接打开网页版。没有相机就在 App 里填地址和配对码。')}</div>
        <div class="hint">{t('只给你自己的设备扫：扫到的人会以你的身份登录。')}</div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .cq { display: flex; gap: 16px; align-items: center; padding: 14px; color: inherit; }
  .tile { position: relative; flex: none; width: 152px; height: 152px; padding: 11px; border-radius: 14px; background: #fff; box-sizing: border-box;
    box-shadow: 0 0 0 1px rgba(0,0,0,.08); }
  .compact .tile { width: 132px; height: 132px; padding: 10px; }
  .tile :global(svg) { display: block; width: 100%; height: 100%; transition: opacity .2s; }
  .tile.dim :global(svg) { opacity: .08; }
  .ov { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; border: 0; border-radius: 14px;
    background: transparent; color: #15171c; padding: 10px; text-align: center; }
  .ov.ok { color: #2f9e5b; }
  .ov.tap { cursor: pointer; }
  .ov b { font-size: 14px; font-weight: 700; }
  .ov small { font-size: 12px; color: #5a5e68; }
  .spin { width: 24px; height: 24px; border-radius: 50%; border: 3px solid #2f6fed; border-right-color: transparent; animation: cq-spin .8s linear infinite; }
  @keyframes cq-spin { to { transform: rotate(360deg); } }
  .meta { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 5px; }
  .lab { font-size: 12px; opacity: .65; letter-spacing: .02em; }
  .code { font: 600 26px/1.15 ui-monospace, 'SF Mono', 'Cascadia Mono', Consolas, monospace; letter-spacing: .08em; }
  .title { font-size: 15px; font-weight: 650; overflow-wrap: anywhere; }
  .sub { font-size: 12.5px; opacity: .72; overflow-wrap: anywhere; }
  .hint { font-size: 12px; line-height: 1.5; opacity: .6; }
  .warn { font-size: 12.5px; line-height: 1.45; color: #c2410c; }
  .err { font-size: 12.5px; color: #c0392b; }
  .acts { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
  .btn { height: 30px; padding: 0 12px; border-radius: 8px; font-size: 13px; font-weight: 600; color: inherit;
    background: color-mix(in srgb, currentColor 9%, transparent); box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 14%, transparent); }
  .btn:hover { background: color-mix(in srgb, currentColor 14%, transparent); }
  .btn.danger { color: #d64545; }
  .btn:disabled { opacity: .55; }
  @media (max-width: 480px) {
    .cq { flex-direction: column; align-items: flex-start; }
  }
</style>
