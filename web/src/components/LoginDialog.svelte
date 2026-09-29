<script>
  // 单 agent 模式的登录框（claude.ai 登录页样式）：只管「没登录时登录」——账号密码 / 注册 / 管理员令牌 /
  // 扫码登录（网页出码、已登录的手机浏览器扫）。已登录后的账户信息、用量、工作空间、扫一扫、退出都在
  // 设置 → 账户（侧栏底部账户卡菜单进）。
  // 常规模式的登录在主页右上角账户胶囊（LoginCard）里；单 agent 模式没有主页，
  // 由 ui.loginOpen 控制（启动时没登录会自动打开）。
  import { fade, scale } from 'svelte/transition';
  import { api, setToken } from '../lib/api.js';
  import { ui, me, applyMe } from '../lib/state.svelte.js';
  import { startPairLogin } from '../lib/pair.js';
  import { pushBackLayer } from '../lib/nav.js';
  import { t, tc, tr } from '../lib/i18n.js';

  let mode = $state('login');   // 'login' | 'register' | 'token' | 'qr'（扫码登录：网页出码、手机扫）
  let username = $state(''), password = $state(''), password2 = $state(''), invite = $state(''), tok = $state('');
  let busy = $state(false), err = $state('');

  const open = $derived(ui.loginOpen && me.kind === 'none');
  // 已登录还被人置了 loginOpen（旧入口 / 竞态）：这张卡没有东西可显示，直接收掉
  $effect(() => { if (ui.loginOpen && me.kind !== 'none') ui.loginOpen = false; });
  $effect(() => { if (open) return pushBackLayer(close); });

  function close() { ui.loginOpen = false; err = ''; }
  function reset() { username = ''; password = ''; password2 = ''; invite = ''; tok = ''; err = ''; }
  function setMode(m) { mode = m; err = ''; }

  // 登录成功后统一从 /api/auth 刷新身份（tier 等以它为准；login 响应不带这些）
  async function refreshMe(fallback) {
    try { const a = await api.auth(); applyMe(a); }
    catch { applyMe(fallback); }
  }
  async function doLogin() {
    if (busy) return; busy = true; err = '';
    // 拿到 session token 即存为 Bearer（cookie 之外的兜底）：否则一旦 cookie 不可用，
    // refreshMe 的 /api/auth 会 401、回落 fallback 假登录。
    try { const r = await api.login({ username, password }); if (r.token) setToken(r.token); await refreshMe({ kind: r.kind, user: r.user || username }); reset(); close(); }
    catch (e) { err = tr(e.body?.error) || t('登录失败'); }
    busy = false;
  }
  async function doRegister() {
    if (busy) return; busy = true; err = '';
    try { const r = await api.register({ username, password, password2, invite }); if (r.token) setToken(r.token); await refreshMe({ kind: r.kind, user: r.user || username }); reset(); close(); }
    catch (e) { err = tr(e.body?.error) || t('注册失败'); }
    busy = false;
  }
  async function doToken() {
    if (busy) return; busy = true; err = '';
    try { setToken(tok.trim()); const r = await api.login({}); if (r.token) setToken(r.token); await refreshMe({ kind: r.kind, user: r.user || null }); reset(); close(); }
    catch (e) { setToken(null); err = tr(e.body?.error) || t('令牌无效'); }
    busy = false;
  }
  function submit(e) {
    e.preventDefault();
    if (mode === 'register') doRegister(); else if (mode === 'token') doToken(); else doLogin();
  }

  // 网页端扫码登录：进 qr 模式即领票出码 + 长轮询；离开模式 / 关卡 / 登录成功即停
  // （cleanup 掐断长轮询，作废的码服务端 3 分钟后自己过期）。
  let pair = $state({ status: 'idle', svg: '', error: '' });
  let pairCtl = null;
  $effect(() => {
    if (!(open && mode === 'qr')) return;
    // 回调里【不读】pair（读了就成了本 effect 的依赖，写回 pair 触发自身重跑 → 停/起死循环，
    // 每圈领一张新票把服务端限流打满）。svg 用普通变量兜着。
    let svg = '';
    const ctl = startPairLogin((u) => {
      if (u.svg !== undefined) svg = u.svg;
      pair = { status: u.status, svg, error: u.error || '' };
      if (u.status === 'done') { reset(); close(); }
    });
    pairCtl = ctl;
    return () => { ctl.stop(); if (pairCtl === ctl) pairCtl = null; pair = { status: 'idle', svg: '', error: '' }; };
  });
  const pairMsg = $derived(pair.status === 'rejected' ? t('已在手机上取消')
    : pair.status === 'error' ? (tr(pair.error) || t('出错了'))
    : pair.status === 'expired' ? t('二维码已过期') : '');

  const TITLE = { login: t('欢迎回来'), register: t('注册新账号'), token: t('用访问令牌登录'), qr: t('扫码登录') };
  const SCAN = '<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M3 7V5.2A2.2 2.2 0 0 1 5.2 3H7M13 3h1.8A2.2 2.2 0 0 1 17 5.2V7M17 13v1.8a2.2 2.2 0 0 1-2.2 2.2H13M7 17H5.2A2.2 2.2 0 0 1 3 14.8V13M4 10h12"/></svg>';
  const focusFirst = (el) => { setTimeout(() => { try { if (!matchMedia('(pointer: coarse)').matches) el.focus(); } catch {} }, 60); };
</script>

{#if open}
  <button class="lg-bd" aria-label={t('关闭')} tabindex="-1" onclick={close} transition:fade={{ duration: 160 }}></button>
  <div class="lg-wrap">
    <div class="lg" role="dialog" aria-modal="true" aria-label={TITLE[mode]} transition:scale={{ duration: 180, start: .97, opacity: 0 }}>
      <div class="lg-logo">Muse Bridge</div>
      <h2 class="lg-t">{TITLE[mode]}</h2>
      <p class="lg-s">
        {#if mode === 'qr'}{t('在已登录的手机浏览器里打开本站，在账户菜单里点「扫一扫」')}
        {:else if mode === 'token'}{me.edition === 'server' ? t('粘贴安装时显示的访问令牌（服务器上只存它的哈希），以管理员身份登录') : t('粘贴服务器数据目录 config.json 里的 token，以管理员身份登录')}
        {:else if mode === 'register'}{t('需要邀请码；注册后直接登录')}
        {:else}{t('登录 Muse Bridge，继续你的工作')}{/if}
      </p>

      {#if err}<div class="lg-err" role="alert">{err}</div>{/if}

      {#if mode === 'qr'}
        <div class="qr">
          <div class="qr-box" class:dim={pair.status !== 'pending'}>{#if pair.svg}{@html pair.svg}{/if}</div>
          {#if pair.status === 'scanned'}
            <div class="qr-ov" in:fade={{ duration: 160 }}><span class="qi ok">&#xe03b;</span><b>{t('已扫描')}</b><small>{t('请在手机上确认')}</small></div>
          {:else if pair.status === 'approved'}
            <div class="qr-ov"><span class="spin"></span><b>{t('登录中…')}</b></div>
          {:else if pair.status === 'loading' || pair.status === 'idle'}
            <div class="qr-ov"><span class="spin"></span></div>
          {:else if pair.status !== 'pending'}
            <button class="qr-ov tap" onclick={() => pairCtl?.refresh()}><span class="qi">&#xe0ce;</span><b>{pairMsg}</b><small>{t('点击刷新')}</small></button>
          {/if}
        </div>
        <button class="lg-link" onclick={() => setMode('login')}>{t('用账号密码登录')}</button>
      {:else}
        <form class="lg-f" onsubmit={submit}>
          {#if mode === 'token'}
            <input class="lf" type="password" placeholder={t('访问令牌')} bind:value={tok} autocomplete="off" use:focusFirst />
          {:else}
            <input class="lf" placeholder={mode === 'register' ? t('账号（2–32 位字母 / 数字 / _ / -）') : tc('settings', '账号')} bind:value={username} autocomplete="username" autocapitalize="off" spellcheck="false" use:focusFirst />
            <input class="lf" type="password" placeholder={mode === 'register' ? t('密码（至少 8 位）') : t('密码')} bind:value={password} autocomplete={mode === 'register' ? 'new-password' : 'current-password'} />
            {#if mode === 'register'}
              <input class="lf" type="password" placeholder={t('确认密码')} bind:value={password2} autocomplete="new-password" />
              <input class="lf" placeholder={t('邀请码')} bind:value={invite} autocomplete="off" autocapitalize="off" spellcheck="false" />
            {/if}
          {/if}
          <button class="lg-go" type="submit" disabled={busy}>{busy ? t('请稍候…') : mode === 'register' ? t('注册并登录') : t('登录')}</button>
        </form>
        {#if mode === 'login'}
          <div class="lg-alt">
            <button class="lg-alt-b" onclick={() => setMode('qr')}><span class="ic" aria-hidden="true">{@html SCAN}</span>{t('扫码登录')}</button>
          </div>
          <div class="lg-links">
            <!-- 服务器没开注册（主机形态 / 管理员关了）：不给一个点了必然 403 的入口 -->
            {#if me.features?.register !== false}
              <button class="lg-link" onclick={() => setMode('register')}>{t('注册新账号')}</button>
              <span class="lg-dot">·</span>
            {/if}
            <button class="lg-link" onclick={() => setMode('token')}>{t('用访问令牌登录')}</button>
          </div>
        {:else}
          <button class="lg-link" onclick={() => setMode('login')}>{t('返回登录')}</button>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .lg-bd { position: fixed; inset: 0; z-index: 64; border: 0; background: var(--st-backdrop); cursor: default; }
  .lg-wrap { position: fixed; inset: 0; z-index: 65; display: flex; align-items: center; justify-content: center;
    padding: max(16px, var(--sat)) 16px max(16px, var(--sab)); overflow-y: auto; pointer-events: none; }
  .lg { pointer-events: auto; width: min(400px, 100%); margin: auto; padding: 32px 28px 24px; border-radius: 16px;
    background: var(--st-surface); box-shadow: 0 0 0 1px var(--st-line), 0 24px 64px rgba(0, 0, 0, .3);
    display: flex; flex-direction: column; align-items: stretch; font-family: var(--sans); color: var(--text); }
  .lg-logo { display: flex; justify-content: center; margin-bottom: 14px; font-family: var(--serif-stack); font-size: 15px;
    font-weight: 500; letter-spacing: .08em; text-transform: uppercase; color: var(--st-muted); }
  .lg-t { margin: 0; text-align: center; font-family: var(--serif-stack); font-weight: 400; font-size: 28px; line-height: 34px; color: var(--text); }
  .lg-s { margin: 8px 0 22px; text-align: center; font-size: 14px; line-height: 20px; color: var(--st-muted); }
  .lg-err { margin: -6px 0 14px; padding: 9px 12px; border-radius: 10px; font-size: 13px; line-height: 18px;
    color: var(--crit); background: color-mix(in srgb, var(--crit) 12%, transparent); }
  .lg-f { display: flex; flex-direction: column; gap: 10px; }
  .lf { height: 44px; padding: 0 14px; border: 0; border-radius: 10px; outline: none; font: inherit; font-size: 15px; color: var(--text);
    background: var(--st-field); box-shadow: inset 0 0 0 1px var(--st-line); transition: box-shadow .15s ease; }
  .lf::placeholder { color: var(--st-muted); }
  .lf:focus { box-shadow: inset 0 0 0 1px var(--st-accent), 0 0 0 3px color-mix(in srgb, var(--st-accent) 22%, transparent); }
  .lg-go { height: 44px; margin-top: 4px; border: 0; border-radius: 10px; cursor: pointer; font: inherit; font-size: 15px; font-weight: 500;
    background: var(--st-primary); color: var(--st-primary-ink); transition: opacity .15s ease, transform var(--mo-tap) var(--ea-out); }
  .lg-go:active:not(:disabled) { transform: scale(.99); }
  .lg-go:disabled { opacity: .5; cursor: default; }
  @media (hover: hover) { .lg-go:hover:not(:disabled) { opacity: .88; } }
  .lg-alt { display: flex; margin-top: 10px; }
  .lg-alt-b { flex: 1; height: 44px; display: flex; align-items: center; justify-content: center; gap: 8px; border: 0; border-radius: 10px; cursor: pointer;
    background: transparent; color: var(--text); font: inherit; font-size: 15px; box-shadow: inset 0 0 0 1px var(--st-line); transition: background-color .15s ease; }
  @media (hover: hover) { .lg-alt-b:hover { background: var(--st-hover); } }
  .ic { display: inline-flex; }
  .lg-links { display: flex; align-items: center; justify-content: center; gap: 6px; margin-top: 14px; }
  .lg-dot { color: var(--st-muted); font-size: 13px; }
  .lg-link { align-self: center; margin-top: 2px; padding: 6px 4px; border: 0; background: none; cursor: pointer; font: inherit; font-size: 13px; color: var(--st-text2); }
  @media (hover: hover) { .lg-link:hover { color: var(--text); text-decoration: underline; text-underline-offset: 3px; } }

  /* 扫码登录：白底码块（明暗主题下都可读）+ 状态盖层 */
  .qr { position: relative; width: 208px; height: 208px; margin: 0 auto 14px; }
  .qr-box { position: absolute; inset: 0; padding: 12px; border-radius: 14px; background: #fff; box-shadow: 0 0 0 1px var(--st-line); transition: opacity .2s; }
  .qr-box :global(svg) { display: block; width: 100%; height: 100%; }
  .qr-box.dim :global(svg) { opacity: .1; }
  .qr-ov { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px;
    padding: 12px; border: 0; border-radius: 14px; background: transparent; color: #15171c; text-align: center; font: inherit; }
  .qr-ov b { font-size: 15px; font-weight: 600; }
  .qr-ov small { font-size: 12.5px; color: #6b6f78; }
  .qr-ov.tap { cursor: pointer; }
  .qi { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; margin-bottom: 4px;
    font-family: var(--icons); font-size: 22px; line-height: 1; color: #2a78d6; background: rgba(42, 120, 214, .12); }
  .qi.ok { color: #2f9e5b; background: rgba(47, 158, 91, .13); }
  .spin { width: 26px; height: 26px; border-radius: 50%; border: 3px solid rgba(42, 120, 214, .18); border-top-color: #2a78d6; animation: qrspin .8s linear infinite; }
  @keyframes qrspin { to { transform: rotate(360deg); } }
  @media (max-width: 420px) { .lg { padding: 28px 20px 20px; } .lg-t { font-size: 25px; line-height: 31px; } }
</style>
