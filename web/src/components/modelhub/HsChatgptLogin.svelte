<script>
  // Sign in with ChatGPT 的登录面板：添加页的第一步（mode 'new'）与已有服务里「添加账号 / 重新登录」（'add' / 'relogin'，compact）共用。
  // 流程：点「Continue with ChatGPT」→ login/start → 新窗口打开 authUrl → 每 2 秒问一次 login/status →
  //   服务器本机的浏览器会自己跳回 127.0.0.1 回调；别的设备上那一页打不开，要把地址栏整段粘回来走 login/finish。
  // 'new' 登录成功先停在「你正在使用 ChatGPT 套餐额度」那一句，点「知道了」才交给外面（ondone）进模型勾选；
  // 'add' / 'relogin' 成功直接 ondone（login.service 是更新后的服务视图）。
  // 组件卸载（关浮层、换步骤）时还没完成的登录顺手 cancel：服务端为它开着的本机回调端口早点收掉。
  // 这段脚本有单测：HubService.logic.test.js（把 <script> 抠出来跑），改 import / $props 的写法时同步那边。
  import { untrack } from 'svelte';
  import { fade } from 'svelte/transition';
  import BrandLogo from './BrandLogo.svelte';
  import { G, svg } from './HsKit.js';
  import { POLL_MS, USAGE_URL, loginPhase, loginLive, loginErrText, pasteProblem, minutesLeft } from './chatgptKit.js';
  import { hubPost, hubAsk } from '../../lib/modelHub.svelte.js';
  import { isNativeDesktop, desktopOpenExternal } from '../../lib/nativeDesktop.js';
  import { DUR } from '../../lib/motion.js';
  import { t, tr } from '../../lib/i18n.js';

  // email：重新登录时是哪个账号（说明里点名，免得用错号登录）；onback：添加页「改用 API Key 接入」
  let {
    mode = 'new', serviceId = '', lineId = '', email = '', narrow = false, compact = false,
    ondone, oncancel = undefined, onback = undefined,
  } = $props();

  let login = $state.raw(null);
  let busy = $state('');          // 'start' | 'finish'
  let err = $state('');           // 发起登录本身失败（不是登录流程里的错）
  let pollErr = $state('');       // 连着几次问不到状态：提示一句，照旧接着问
  let paste = $state('');
  let pasteErr = $state('');
  let now = $state(Date.now());
  // gen：取消 / 重来时 +1，在途的 start / status 回来对不上就作废；fired：ondone 只交一次
  let gen = 0, fails = 0, polling = false, fired = false, dead = false;

  const phase = $derived(loginPhase(login, now));
  const left = $derived(login ? minutesLeft(login.expiresAt, now) : 0);
  const errText = $derived(phase === 'expired' ? t('登录已过期，重新开始一次') : phase === 'error' ? loginErrText(login) : '');
  const account = $derived(login?.account?.email || '');

  // —— 打开登录页 ——
  // 浏览器里先在点击那一下开一个空标签占位：authUrl 要等 start 回来才有，那时再 window.open 已不算用户手势、会被拦。
  // 桌面壳交给系统浏览器、手机 App 的 WebView 不认占位，都不占
  function reserve() {
    if (isNativeDesktop() || (typeof navigator !== 'undefined' && /\bwv\b|Capacitor/i.test(navigator.userAgent || ''))) return null;
    try {
      const w = window.open('about:blank', '_blank');
      if (!w) return null;
      try { w.opener = null; w.document.title = '…'; w.document.body.textContent = t('正在打开登录页…'); } catch {}
      return w;
    } catch { return null; }
  }
  const closeWin = (w) => { try { w && !w.closed && w.close(); } catch {} };
  function openAuth(url, win = null) {
    if (!url) return;
    if (isNativeDesktop()) { closeWin(win); desktopOpenExternal(url); return; }
    if (win && !win.closed) { try { win.location.href = url; return; } catch {} }
    try { window.open(url, '_blank', 'noopener'); } catch {}
  }
  const cancelQuiet = (id) => { if (id) hubAsk('chatgpt/login/cancel', { loginId: id }).catch(() => {}); };

  async function start() {
    if (busy) return;
    const win = reserve();
    const old = login;
    const g = ++gen;
    busy = 'start'; err = ''; pollErr = ''; paste = ''; pasteErr = ''; fails = 0; fired = false;
    // 重来（过期、出错后再点）：上一次的登录作废
    if (old && loginLive(loginPhase(old, Date.now()))) cancelQuiet(old.id);
    login = null;
    try {
      const r = await hubPost('chatgpt/login/start', { ...(serviceId ? { serviceId } : {}), ...(lineId ? { lineId } : {}) });
      const l = r && r.login;
      if (g !== gen || dead) { closeWin(win); cancelQuiet(l?.id); return; }
      if (!l || !l.id) throw new Error(t('没有结果'));
      now = Date.now();
      absorb(l);
      if (l.status === 'pending') openAuth(l.authUrl, win); else closeWin(win);
    } catch (e) {
      closeWin(win);
      if (g === gen) err = tr(e.message);
    } finally {
      if (g === gen) busy = '';
    }
  }

  function absorb(l) {
    if (!l || dead) return;
    login = l;
    if (l.status === 'done' && !fired && mode !== 'new') { fired = true; ondone?.(l); }
  }

  async function poll(id) {
    if (polling || dead) return;
    polling = true;
    const g = gen;
    try {
      const r = await hubAsk('chatgpt/login/status', { loginId: id });
      if (g !== gen || login?.id !== id) return;
      fails = 0; pollErr = '';
      absorb(r.login);
    } catch (e) {
      // 断一两下网不算事；连着几次都问不到才说一声（登录在服务端照旧等着，好了会接上）
      if (g === gen && ++fails >= 3) pollErr = tr(e.message);
    } finally { polling = false; }
  }

  async function finish() {
    if (!login || busy) return;
    const p = pasteProblem(paste);
    if (p) { pasteErr = p; return; }
    const g = gen, id = login.id;
    busy = 'finish'; pasteErr = '';
    try {
      const r = await hubAsk('chatgpt/login/finish', { loginId: id, url: paste.trim() });
      if (g === gen && login?.id === id) absorb(r.login);
    } catch (e) {
      if (g === gen) pasteErr = tr(e.message);
    } finally { if (g === gen) busy = ''; }
  }

  function cancel() {
    const id = login && loginLive(phase) ? login.id : '';
    gen++;
    login = null; busy = ''; err = ''; pollErr = ''; paste = ''; pasteErr = '';
    cancelQuiet(id);
    oncancel?.();
  }

  function ack() {
    if (!login || login.status !== 'done' || fired) return;
    fired = true;
    ondone?.(login);
  }

  // 等着的时候每 2 秒问一次；终止（完成 / 出错 / 过期）或卸载时停
  $effect(() => {
    const id = login?.id;
    if (!id || !loginLive(phase)) return;
    const h = setInterval(() => { now = Date.now(); poll(id); }, POLL_MS);
    return () => clearInterval(h);
  });
  $effect(() => () => {
    dead = true;
    gen++;
    const l = untrack(() => login);
    // 还没完成的、以及 'new' 登录成功但没点「知道了」的（服务没建成，令牌留在服务端没人用）
    if (l && (loginLive(loginPhase(l)) || (l.status === 'done' && !fired && untrack(() => mode) === 'new'))) cancelQuiet(l.id);
  });
</script>

{#snippet siwc()}
  <!-- 官方 UI 规范要求的按钮文案与样式：黑底白字 + OpenAI 标，文案保留英文 -->
  <button type="button" class="siwc" class:busy={busy === 'start'} disabled={busy === 'start'} onclick={start}>
    {#if busy === 'start'}<span class="spin" aria-hidden="true"></span>{:else}<span class="mk"><BrandLogo plain size={18} logo="openai" name="ChatGPT" /></span>{/if}
    <span>Continue with ChatGPT</span>
  </button>
{/snippet}

<div class="cg" class:narrow class:compact>
  {#if phase === 'idle'}
    <div class="step" in:fade={{ duration: DUR.quick }}>
      {#if !compact}
        <div class="hero">
          <BrandLogo size={44} logo="openai" name="ChatGPT" />
          <h3 class="ht">{t('ChatGPT 订阅')}</h3>
          <p class="lead">{t('登录 ChatGPT 账号，用它的套餐额度给 Claude、dimensio、Codex 调模型，不用 API Key。')}</p>
          <p class="sub">{t('套餐额度与 ChatGPT、Codex 共用；需要 Plus / Pro 等付费套餐。')}</p>
        </div>
      {:else}
        <p class="sub">{mode === 'relogin' && email ? t('用 {email} 重新登录一次，额度就能接着用。', { email }) : t('再登录一个 ChatGPT 账号：一个账号额度用完时自动换下一个。')}</p>
      {/if}
      <div class="acts" class:center={!compact}>
        {@render siwc()}
        {#if compact && oncancel}<button type="button" class="btn" onclick={cancel}>{t('取消')}</button>{/if}
      </div>
      {#if err}<p class="err" role="alert">{err}</p>{/if}
      {#if onback}
        <div class="alt"><button type="button" class="tbtn" onclick={() => onback?.()}>{t('改用 API Key 接入')}</button></div>
      {/if}
    </div>
  {:else if phase === 'pending' || phase === 'exchanging'}
    <div class="step wait" in:fade={{ duration: DUR.quick }} aria-live="polite">
      <div class="wh">
        <span class="spin" aria-hidden="true"></span>
        <span class="wt">{phase === 'exchanging' ? t('正在完成登录…') : t('在打开的页面里登录并同意')}</span>
        {#if phase === 'pending' && left}<span class="hint">{t('{n} 分钟内有效', { n: left })}</span>{/if}
      </div>
      {#if mode === 'relogin' && email && phase === 'pending'}<p class="sub">{t('请用 {email} 登录。', { email })}</p>{/if}
      {#if phase === 'pending'}
        <div class="acts">
          <button type="button" class="btn" onclick={() => openAuth(login?.authUrl)}>{@html svg(G.out)}{t('重新打开登录页')}</button>
          <button type="button" class="btn" onclick={cancel}>{t('取消')}</button>
        </div>
        <form class="paste" onsubmit={(e) => { e.preventDefault(); finish(); }} novalidate>
          <label class="fl" for="cg-paste-{mode}">{t('登录后浏览器停在打不开的 127.0.0.1 页面？把地址栏整段复制到这里')}</label>
          <div class="pr">
            <input id="cg-paste-{mode}" class="in mono" type="url" inputmode="url" autocomplete="off" spellcheck="false" autocapitalize="off"
              bind:value={paste} oninput={() => { pasteErr = ''; }} placeholder="http://127.0.0.1:…/auth/callback?code=…" />
            <button type="submit" class="btn primary" class:busy={busy === 'finish'} disabled={busy === 'finish' || !paste.trim()}>
              {#if busy === 'finish'}<span class="spin" aria-hidden="true"></span>{/if}{t('完成登录')}
            </button>
          </div>
          {#if pasteErr}<p class="err" role="alert">{pasteErr}</p>{/if}
        </form>
      {/if}
      {#if pollErr}<p class="warn">{pollErr}</p>{/if}
    </div>
  {:else if phase === 'error' || phase === 'expired'}
    <div class="step" in:fade={{ duration: DUR.quick }}>
      <p class="err big" role="alert">{errText}</p>
      <div class="acts">
        {@render siwc()}
        <button type="button" class="btn" onclick={cancel}>{oncancel ? t('取消') : t('返回')}</button>
      </div>
      {#if err}<p class="err" role="alert">{err}</p>{/if}
    </div>
  {:else if phase === 'done' && mode === 'new'}
    <div class="step done" in:fade={{ duration: DUR.quick }}>
      <div class="hero">
        <span class="ok" aria-hidden="true">{@html svg(G.check, 2)}</span>
        <h3 class="ht">{account || t('已登录')}</h3>
        <p class="lead">
          {t('你正在使用 ChatGPT 套餐额度')} · <a href={USAGE_URL} target="_blank" rel="noopener noreferrer">{t('在 ChatGPT 设置里管理用量')}</a>
        </p>
      </div>
      <div class="acts center">
        <!-- svelte-ignore a11y_autofocus -->
        <button type="button" class="btn primary go" autofocus={!narrow} onclick={ack}>{t('知道了')}</button>
      </div>
    </div>
  {:else}
    <div class="step wait" aria-live="polite"><div class="wh"><span class="spin" aria-hidden="true"></span><span class="wt">{t('正在完成登录…')}</span></div></div>
  {/if}
</div>

<style>
  .cg { width: 100%; }
  .cg:not(.compact) { max-width: 520px; margin: 0 auto; padding: 8px 0 24px; }
  .step { display: flex; flex-direction: column; gap: 12px; }
  .compact .step { gap: 10px; }

  .hero { display: flex; flex-direction: column; align-items: center; gap: 8px; text-align: center; margin-bottom: 10px; }
  .ht { margin: 6px 0 0; font-family: var(--font-brand-serif), Georgia, serif; font-size: 22px; font-weight: 500; letter-spacing: -.01em; line-height: 1.25;
    overflow-wrap: anywhere; }
  .narrow .ht { font-family: inherit; font-size: 19px; font-weight: 600; }
  .lead { margin: 0; max-width: 440px; font-size: 14px; line-height: 1.6; color: var(--st-text2); }
  .lead a { color: var(--text); text-decoration: underline; text-underline-offset: 3px; text-decoration-color: color-mix(in srgb, var(--text) 35%, transparent); }
  .sub { margin: 0; font-size: 12.5px; line-height: 1.55; color: var(--st-muted); overflow-wrap: anywhere; }
  .hero .sub { max-width: 440px; }
  .narrow .lead { font-size: 15px; }
  .narrow .sub { font-size: 13px; }

  .acts { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .acts.center { justify-content: center; }
  .alt { display: flex; justify-content: center; margin-top: 2px; }

  /* Continue with ChatGPT：两种主题下都是黑底白字（官方规范）；暗色底上加一圈细线，免得黑块沉进面板里 */
  .siwc { display: inline-flex; align-items: center; justify-content: center; gap: 10px; height: 42px; min-width: 260px; padding: 0 22px; border: 0; border-radius: 12px;
    background: #000; color: #fff; box-shadow: inset 0 0 0 1px rgba(255, 255, 255, .14); font: inherit; font-size: 14.5px; font-weight: 600; letter-spacing: .005em;
    white-space: nowrap; cursor: pointer; transition: transform var(--mo-tap) var(--ea-std), opacity var(--mo-micro) var(--ea-fade); }
  :global(html[data-theme="light"]) .siwc { box-shadow: none; }
  @media (hover: hover) { .siwc:hover:not(:disabled) { opacity: .86; } }
  .siwc:active:not(:disabled) { transform: scale(.97); }
  .siwc:disabled { cursor: default; opacity: .78; }
  .siwc:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--st-surface), 0 0 0 4px var(--text); }
  /* BrandLogo 的标读 --text：在黑按钮里换成白 */
  .siwc .mk { --text: #fff; display: grid; place-items: center; }
  .compact .siwc { min-width: 0; height: 36px; padding: 0 16px; font-size: 13.5px; border-radius: 10px; }
  .narrow .siwc { width: 100%; height: 48px; border-radius: 14px; font-size: 16px; }
  .narrow.compact .siwc { height: 44px; border-radius: 13px; font-size: 15px; }

  /* —— 等待：一行状态 + 两个按钮 + 粘贴框 —— */
  .wh { display: flex; align-items: center; gap: 10px; min-height: 28px; flex-wrap: wrap; }
  .wt { font-size: 14.5px; font-weight: 600; color: var(--text); }
  .compact .wt { font-size: 13.5px; }
  .hint { font-size: 12.5px; color: var(--st-muted); font-variant-numeric: tabular-nums; }
  .paste { display: flex; flex-direction: column; gap: 7px; margin-top: 6px; padding-top: 14px; box-shadow: inset 0 1px 0 var(--st-hair); }
  .fl { display: block; margin: 0 0 0 2px; font-size: 12.5px; line-height: 1.5; font-weight: 600; color: var(--st-text2); }
  .narrow .fl { font-size: 13px; }
  .pr { display: flex; gap: 8px; }
  .narrow .pr { flex-direction: column; }
  .in { flex: 1; width: 100%; min-width: 0; height: 38px; padding: 0 12px; box-sizing: border-box; border: 0; border-radius: 10px; background: var(--st-field); color: var(--text);
    box-shadow: inset 0 0 0 1px var(--st-line); font: inherit; font-size: 14px; outline: none; transition: box-shadow var(--mo-micro) var(--ea-fade); }
  .in:focus { box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--text) 55%, transparent); }
  .in::placeholder { color: var(--st-muted); }
  .in.mono { font-family: ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace; font-size: 13px; }
  .narrow .in { height: 46px; border-radius: 14px; font-size: 16px; }
  .narrow .in.mono { font-size: 16px; }

  .done .ok { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 50%; background: var(--st-seg); color: var(--text); }
  .done .ok :global(svg) { width: 22px; height: 22px; }

  .err { margin: 0 2px; font-size: 13px; line-height: 1.5; color: var(--pm-red); overflow-wrap: anywhere; }
  .err.big { font-size: 14px; }
  .warn { margin: 0 2px; font-size: 12.5px; line-height: 1.5; color: var(--st-muted); overflow-wrap: anywhere; }

  /* —— 按钮（与 HsConn 同一套） —— */
  .btn { flex: none; display: inline-flex; align-items: center; justify-content: center; gap: 7px; height: 34px; padding: 0 14px; border: 0; border-radius: 10px;
    background: transparent; color: var(--text); box-shadow: inset 0 0 0 1px var(--st-line); font: inherit; font-size: 13px; font-weight: 500; white-space: nowrap; cursor: pointer;
    transition: transform var(--mo-tap) var(--ea-std), background-color var(--mo-micro) var(--ea-fade), opacity var(--mo-micro) var(--ea-fade); }
  .btn :global(svg) { width: 15px; height: 15px; }
  @media (hover: hover) { .btn:hover:not(:disabled) { background: var(--st-hover); } }
  .btn:active:not(:disabled) { transform: scale(.96); }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .btn.primary { background: var(--st-primary); color: var(--st-primary-ink); box-shadow: none; font-weight: 600; }
  @media (hover: hover) { .btn.primary:hover:not(:disabled) { background: var(--st-primary); opacity: .88; } }
  .btn.primary:disabled { opacity: 1; background: var(--st-seg); color: var(--st-muted); }
  .btn.primary.busy:disabled { background: var(--st-primary); color: var(--st-primary-ink); opacity: .72; }
  .btn.primary:focus-visible { box-shadow: 0 0 0 2px var(--st-surface), 0 0 0 4px var(--text); }
  .pr .btn { height: 38px; }
  .go { min-width: 120px; height: 38px; }
  .narrow .btn { height: 44px; border-radius: 13px; font-size: 15px; padding: 0 16px; }
  .narrow .pr .btn, .narrow .go { width: 100%; height: 46px; border-radius: 14px; }
  .tbtn { flex: none; display: inline-flex; align-items: center; height: 30px; padding: 0 8px; border: 0; border-radius: 8px; background: transparent; color: var(--st-text2);
    font: inherit; font-size: 12.5px; font-weight: 500; white-space: nowrap; cursor: pointer;
    transition: background-color var(--mo-micro) var(--ea-fade), color var(--mo-micro) var(--ea-fade), transform var(--mo-tap) var(--ea-std); }
  @media (hover: hover) { .tbtn:hover { background: var(--st-hover); color: var(--text); } }
  .tbtn:active { transform: scale(.96); }
  .tbtn:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--text); }
  .narrow .tbtn { height: 44px; padding: 0 12px; font-size: 14px; }

  @media (prefers-reduced-motion: reduce) {
    .siwc:active:not(:disabled), .btn:active:not(:disabled), .tbtn:active { transform: none; }
  }
</style>
