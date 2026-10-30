<script>
  // 手机 App（离线壳）首次启动 / 地址失效时的「连接你的 bridge 服务器」（开源路线 S1-2、审查 2.3）。
  // 前端已离线内置（appassets 源），聊天数据要连服务器上的 bridge。
  //
  // 主路径：扫电脑上的配对二维码（PairScan，mode:'connect'）——服务器地址、一张自己的长期会话、局域网候选、服务器身份一次到位，
  //   扫完整页重载走正常启动流程。二维码在桌面客户端完成页、托盘「访问信息」、设置「连接与更新」、控制台「设备」、终端 `cli.mjs pair` 都有。
  // 兜底「手动填写地址」：地址 + 电脑上显示的 8 位配对码；这一栏也认访问令牌——拿它换一张管理员会话（可吊销），
  //   本地只存会话、不存主令牌（以前「管理员令牌（可选）」把主令牌原样存进本地，手机丢了只能换令牌）。只填地址 = 先连上，进去再用账号密码登录
  //   （朋友最常见的路子，所以折叠链接写明「有账号密码 / 配对码」）。只有数字却不是 8 位 = 抄错了的配对码，直接提示，不当令牌发去登录。
  // 首屏告诉用户去哪出码：桌面客户端「设置 › 连接与更新」/ 托盘「访问信息」、网页版「设置 › 关于」、Linux 终端 bridgectl pair。
  // 局域网地址没写协议时补 http（没有证书），裸 IP 没写端口补 :8787；其余补 https。
  import { ui } from '../lib/state.svelte.js';
  import { getServerBase, setServerBase } from '../lib/server.js';
  import { normalizeServerAddress, looksLikeCode, looksLikeDigits, redeemCode, loginWithToken, applyConnect, probeServer, connectErrorText } from '../lib/connectPair.js';
  import { t } from '../lib/i18n.js';
  import { listProfiles, monogram } from '../lib/serverProfiles.js';
  import { switchServer } from '../lib/serverSwitch.js';

  // 手机 App 存过别的服务器（多服务器档案）：正在添加新的、或者这台连不上时，可以直接切回去
  const saved = listProfiles().filter((p) => !p.active && !p.pending);

  // 地址失效（以前填过）时直接展开手填，方便改地址
  let manual = $state(!!getServerBase());
  let addr = $state(getServerBase() || '');
  let cred = $state('');
  let busy = $state(false), err = $state('');

  function scan() { err = ''; ui.pairScan = { mode: 'connect' }; }

  async function connect() {
    if (busy) return;
    const origin = normalizeServerAddress(addr);
    if (!origin) { err = t('请填入电脑上 bridge 的地址'); return; }
    const c = cred.trim();
    // 只有数字却不是 8 位：是抄错了的配对码——不能当访问令牌发去登录（那边会回「用户名或密码错误」，还记一次登录失败）
    if (c && looksLikeDigits(c) && !looksLikeCode(c)) { err = connectErrorText({ code: 'digits' }); return; }
    busy = true; err = '';
    try {
      if (c && looksLikeCode(c)) { applyConnect(await redeemCode(origin, c)); location.reload(); return; }
      if (c) { applyConnect(await loginWithToken(origin, c)); location.reload(); return; }
      const s = await probeServer(origin);
      if (s === 'ok') { setServerBase(origin); location.reload(); return; }
      err = s === 'unreachable' ? t('连不上这个地址，确认电脑 server 开着、地址没填错') : t('连接异常（HTTP {status}），检查地址', { status: s.slice(5) });
    } catch (e) { err = connectErrorText(e); }
    busy = false;
  }
  const onKey = (e) => { if (e.key === 'Enter') connect(); };
</script>

<div class="sc-mask">
  <div class="sc-card">
    <h2>{t('连接你的 bridge 服务器')}</h2>
    <p class="sc-hint">{t('在已经登录 bridge 的电脑上出示配对二维码，用这台手机扫一下就连上了：')}</p>
    <ul class="sc-where">
      <li>{t('桌面客户端：「设置 › 连接与更新 › 手机扫码连接」，本机服务端的托盘「访问信息」里也有')}</li>
      <li>{t('网页版：「设置 › 关于 › 让另一台设备扫码连接」')}</li>
      <li>{t('装在 Linux 上的服务器：在服务器终端运行 bridgectl pair')}</li>
    </ul>
    {#if err}<div class="sc-err">{err}</div>{/if}
    <button class="sc-btn" onclick={scan} disabled={busy}>
      <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      <span>{t('扫码连接')}</span>
    </button>
    {#if !manual}
      <button class="sc-link" onclick={() => { manual = true; err = ''; }}>{t('手动填写地址（有账号密码 / 配对码）')}</button>
    {:else}
      <div class="sc-sep"><span>{t('或者手动填写')}</span></div>
      <input class="sc-in" placeholder={t('服务器地址，如 192.168.1.5:8787')} bind:value={addr}
        autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" inputmode="url" onkeydown={onKey} />
      <input class="sc-in" placeholder={t('8 位配对码（也可填访问令牌）')} bind:value={cred}
        autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" onkeydown={onKey} />
      <p class="sc-note">{t('配对码和地址显示在电脑上的二维码旁边，3 分钟内有效。不填配对码也能先连上，进去再登录。')}</p>
      <button class="sc-btn ghost" onclick={connect} disabled={busy}>{busy ? t('连接中…') : t('连接')}</button>
    {/if}
    {#if saved.length}
      <div class="sc-sep"><span>{t('或者切到已保存的服务器')}</span></div>
      <div class="sc-saved">
        {#each saved as p (p.id)}
          <button class="sc-srv" style:--c={p.color} onclick={() => switchServer(p.id)} disabled={busy}>
            <span class="sc-orb">{monogram(p.name)}</span><span class="sc-nm">{p.name}</span>
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .sc-mask { position: fixed; inset: 0; z-index: 100; display: flex; align-items: center; justify-content: center; padding: 24px; background: #0a0a0a; overflow-y: auto; }
  .sc-card { width: 100%; max-width: 360px; display: flex; flex-direction: column; gap: 13px; }
  .sc-card h2 { font-size: 24px; font-weight: 800; color: #f2f2f2; margin-bottom: 2px; }
  .sc-hint { font-size: 14px; line-height: 1.55; color: #9a9a9a; margin-bottom: 4px; }
  .sc-note { font-size: 12.5px; line-height: 1.5; color: #7c7c7c; }
  .sc-where { margin: -6px 0 4px; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; font-size: 13px; line-height: 1.5; color: #8a8a8a; list-style: disc; }
  .sc-err { background: rgba(217,106,90,.16); color: #e0816f; font-size: 13px; line-height: 1.45; padding: 10px 13px; border-radius: 11px; }
  .sc-in { width: 100%; height: 50px; border: none; outline: none; border-radius: 14px; background: rgba(255,255,255,.08); box-shadow: inset 0 0 0 .5px rgba(255,255,255,.14); padding: 0 16px; font-size: 16px; color: #f2f2f2; }
  .sc-in::placeholder { color: #6c6c6c; }
  .sc-btn { width: 100%; height: 52px; border-radius: 26px; background: #2f6fed; color: #fff; font-size: 17px; font-weight: 700; margin-top: 5px; display: flex; align-items: center; justify-content: center; gap: 8px; transition: transform var(--mo-tap) var(--ea-out); }
  .sc-btn.ghost { background: rgba(255,255,255,.1); color: #f2f2f2; box-shadow: inset 0 0 0 .5px rgba(255,255,255,.18); margin-top: 0; }
  .sc-btn:disabled { opacity: .6; }
  .sc-btn:active { transform: scale(.98); }
  .sc-link { align-self: center; padding: 8px 12px; font-size: 14.5px; color: #8fb2ff; background: none; }
  .sc-sep { display: flex; align-items: center; gap: 10px; margin: 6px 0 2px; color: #6c6c6c; font-size: 12.5px; }
  .sc-saved { display: flex; flex-wrap: wrap; gap: 8px; }
  .sc-srv { display: flex; align-items: center; gap: 9px; height: 44px; max-width: 100%; padding: 0 16px 0 7px; border-radius: 22px;
    background: rgba(255,255,255,.08); box-shadow: inset 0 0 0 .5px rgba(255,255,255,.16); color: #f2f2f2; font-size: 15px; font-weight: 600; }
  .sc-srv:active { transform: scale(.97); }
  .sc-orb { flex: none; width: 30px; height: 30px; border-radius: 50%; display: grid; place-items: center; font-size: 14px; font-weight: 700; color: #fff;
    background: radial-gradient(circle at 32% 26%, color-mix(in srgb, var(--c) 45%, #fff), var(--c) 60%); }
  .sc-nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sc-sep::before, .sc-sep::after { content: ''; flex: 1; height: .5px; background: rgba(255,255,255,.14); }
</style>
