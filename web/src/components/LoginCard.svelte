<script>
  // 主页右上登录 pill ↔ 卡片单元素 morph：
  //   card 本体 pill↔卡片形变（left/top/width/height/圆角/背景/backdrop transition）
  //   + plabel 胶囊层（pill 文字与底，展开时移中心淡出）
  //   + content（表单/用户信息，展开时淡入）。
  // 四态：未登录 login/register/token(管理员令牌)/qr(扫码)；已登录用户信息。
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { api, setToken } from '../lib/api.js';
  import { ui, me, status, applyMe } from '../lib/state.svelte.js';
  import { openPage } from '../lib/pageMorph.js';
  import { startPairLogin } from '../lib/pair.js';
  import { fetchMyUsage, changeMyPassword, quotaRows, hasLimits } from '../lib/me.js';
  import { t, tc, tr, isEn } from '../lib/i18n.js';

  let mode = $state('login'); // 'login' | 'register' | 'token' | 'qr'(扫码登录：网页出码、手机扫)
  let username = $state(''), password = $state(''), password2 = $state(''), invite = $state(''), tok = $state('');
  let busy = $state(false), err = $state('');

  const open = $derived(ui.loginOpen);
  const pillLabel = $derived(me.kind === 'none' ? t('登录') : (me.user || (me.kind === 'admin' ? 'Admin' : t('我'))));

  // —— 几何：pill（右上小胶囊）↔ card（居中大卡，高度按 mode 取）——
  const PILL_H = 40, M = 16, CARD_W = 340;
  const MODE_H = { login: 392, register: 470, token: 300, qr: 452, user: 412, userScan: 470, pw: 404 };
  // 「扫一扫」入口只给触屏：桌面浏览器拿摄像头对着另一块屏幕扫码不是正常用法。
  const canScan = (() => { try { return matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
  // 注册用户多两样：「修改密码」一颗钮（+56），被设了额度时再多两行「我的额度」（+58）。
  let userMode = $state('main');   // 'main' | 'pw'（已登录时卡片里的两个视图）
  let mine = $state(null);         // /api/me/usage
  const userExtra = $derived(me.kind === 'user' ? 56 + (hasLimits(mine) ? 58 : 0) : 0);
  // 英文比中文多折行（中文恒为 0）：登录页底部两条链接排不下一行、各占一行（+44）；
  // 注册用户卡的「我的 · …」额度行与底部说明各多一行。
  const enExtra = $derived(!isEn() ? 0
    : me.kind !== 'none' ? (userMode !== 'pw' && me.kind === 'user' ? (hasLimits(mine) ? 52 : 16) : 0)
    : (mode === 'login' && me.features?.register !== false ? 44 : 0));
  const cardH = $derived((me.kind !== 'none'
    ? (userMode === 'pw' ? MODE_H.pw : (canScan ? MODE_H.userScan : MODE_H.user) + userExtra)
    : (MODE_H[mode] || 392)) + enExtra);

  let vw = $state(390), vh = $state(800), pillW = $state(88), pillEl = $state();
  // pill 顶距要让出系统状态栏：--sat 由 app.css env() 给出，getComputedStyle 拿解析后的 px。
  let insetTop = $state(0);
  function readInset() {
    try { insetTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sat')) || 0; } catch {}
  }
  onMount(() => {
    const upd = () => { vw = window.innerWidth; vh = window.innerHeight; readInset(); };
    upd(); window.addEventListener('resize', upd);
    return () => window.removeEventListener('resize', upd);
  });
  // 测量 pill 宽度：用隐藏探针测 label 的【自然宽度】（同字体样式）。
  // 不能测 plabel 自身——它的宽度被 width:${pillW}px 锁死，测回的是 pillW 自己
  //（循环依赖，长用户名会溢出）。上限封顶（不挤左上字标），超长由 ellipsis 兜底。
  function measureLabel(label) {
    const p = document.createElement('span');
    p.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;font-size:14px;font-weight:600;letter-spacing:.02em;';
    p.textContent = label;
    document.body.appendChild(p);
    const w = p.getBoundingClientRect().width;
    p.remove();
    return w;
  }
  $effect(() => {
    const natural = measureLabel(pillLabel) + 30;          // 文字 + 左右 padding 余量
    const max = Math.min(240, Math.round(vw * 0.5));       // 封顶：给左上字标留位
    pillW = Math.round(Math.min(Math.max(76, natural), max));
  });

  const pillTop = $derived(M + insetTop);
  const pillLeft = $derived(vw - M - pillW);
  // 键盘弹出时 vh 骤减（resize 监听已更新）：卡高/顶距按可视高度钳制，内容区可滚动，
  // 不再出现 register 卡 470px > 键盘后视口 → 标题被顶出屏外。卡宽同理防窄屏溢出。
  const cardW = $derived(Math.min(CARD_W, vw - 24));
  const effH = $derived(Math.min(cardH, vh - insetTop - 24));
  const cardTop = $derived(Math.max(insetTop + 12, (vh - effH) / 2));
  const dx = $derived(vw / 2 - (pillLeft + pillW / 2));
  const dy = $derived(cardTop + effH / 2 - (pillTop + PILL_H / 2));
  const baseGeom = $derived(`left:${pillLeft}px; top:${pillTop}px; width:${pillW}px; height:${PILL_H}px;`);
  const cardStyle = $derived(open
    ? `left:${(vw - cardW) / 2}px; top:${cardTop}px; width:${cardW}px; height:${effH}px; border-radius:30px;`
    : `${baseGeom} border-radius:22px;`);
  const plabelStyle = $derived(open ? `transform:translate(${dx}px,${dy}px); opacity:0; pointer-events:none;` : `transform:none; opacity:1;`);

  function toggle() { ui.loginOpen = !ui.loginOpen; }
  function close() { ui.loginOpen = false; err = ''; }
  function reset() { username = ''; password = ''; password2 = ''; invite = ''; tok = ''; err = ''; }

  // 登录成功后统一从 /api/auth 刷新身份（tier / agents 单一来源；login 响应不带这些）
  async function refreshMe(fallback) {
    try { const a = await api.auth(); applyMe(a); }
    catch { applyMe(fallback); }
  }
  async function doLogin() {
    if (busy) return; busy = true; err = '';
    // 拿到 session token 即存为 Bearer（cookie 之外的兜底）：否则一旦 cookie 不可用，refreshMe 的
    // /api/auth 会 401、回落 fallback 假登录，之后每个请求都 401 → 聊天卡在"重连中"。
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
  async function doLogout() {
    try { await api.logout(); } catch {}
    setToken(null); applyMe(null); mode = 'login'; userMode = 'main'; close();
  }
  // —— 改自己的密码（注册用户）：成功后本机保留登录，别的设备下线 ——
  let pwOld = $state(''), pwNew = $state(''), pwAgain = $state(''), pwDone = $state(false);
  function openPw() { userMode = 'pw'; err = ''; pwOld = ''; pwNew = ''; pwAgain = ''; }
  async function doChangePw() {
    if (busy) return;
    if (pwNew.length < 8) { err = t('新密码至少 8 位'); return; }
    if (pwNew !== pwAgain) { err = t('两次输入的新密码不一致'); return; }
    busy = true; err = '';
    try { await changeMyPassword(pwOld, pwNew); pwDone = true; userMode = 'main'; pwOld = pwNew = pwAgain = ''; }
    catch (e) { err = tr(e?.body?.error) || t('修改失败'); }
    busy = false;
  }
  // 工作空间从卡片里这一行长出来（与主页入口同一套转场）；卡片在旧快照里随主页一起退后
  function openWorkspace(ev) { openPage('files', { from: ev?.currentTarget || null, radius: 14, onSwitch: close }); }
  function openSettings() { ui.settingsOpen = true; close(); }
  // 手机端：账户卡「扫一扫」→ 全屏取景层（PairScan，App 挂载），扫网页登录页上的码替它登录。
  function openScan() { close(); ui.pairScan = { mode: 'scan' }; }

  // 网页端扫码登录：进 qr 模式即领票出码 + 长轮询；离开模式 / 关卡 / 登录成功即停
  // （cleanup 掐断长轮询，作废的码服务端 3 分钟后自己过期）。
  let pair = $state({ status: 'idle', svg: '', error: '' });
  let pairCtl = null;
  $effect(() => {
    if (!(open && me.kind === 'none' && mode === 'qr')) return;
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

  $effect(() => {
    if (open && me.kind !== 'none') {
      api.status().then((s) => { status.limits = s.limits || null; status.context = s.context || null; status.updatedAt = Date.now(); }).catch(() => {});
    }
  });
  $effect(() => { if (open && me.kind === 'user') fetchMyUsage().then((r) => { mine = r; }).catch(() => {}); });
  // 卡片收起就回到主视图（下次打开不停在改密码那页）
  $effect(() => { if (!open) { userMode = 'main'; pwDone = false; } });
  const lim = $derived(status.limits || {});
  const fiveH = $derived(lim.five_hour ? Math.round(lim.five_hour.pct || 0) : null);
  const weekly = $derived(lim.seven_day ? Math.round(lim.seven_day.pct || 0) : null);
  const onKey = (e, fn) => { if (e.key === 'Enter') fn(); };
</script>

<div class="lc-fade" class:appeared={ui.booted}>
<!-- pill 层（可点；展开时移中心淡出） -->
<button class="plabel" bind:this={pillEl} style="{baseGeom} {plabelStyle}" onclick={toggle}>{pillLabel}</button>

{#if open}<button class="card-bd" transition:fade={{ duration: 220 }} onclick={close} aria-label={t('关闭')}></button>{/if}

<!-- morph 卡片本体 -->
<div class="card {open ? 'expanded' : 'pill'}" style={cardStyle}>
  {#if open}
    <div class="content" in:fade={{ duration: 240, delay: 170 }}>
      {#if me.kind !== 'none' && userMode === 'pw'}
        <h3>{t('修改密码')}</h3>
        {#if err}<div class="err">{err}</div>{/if}
        <input class="lf" type="password" placeholder={t('原密码')} bind:value={pwOld} autocomplete="current-password" />
        <input class="lf" type="password" placeholder={t('新密码（至少 8 位）')} bind:value={pwNew} autocomplete="new-password" />
        <input class="lf" type="password" placeholder={t('再输一次新密码')} bind:value={pwAgain} autocomplete="new-password" onkeydown={(e) => onKey(e, doChangePw)} />
        <div class="acts">
          <button class="act primary" onclick={doChangePw} disabled={busy}>{busy ? t('保存中…') : t('保存')}</button>
          <button class="act ghost" onclick={() => { userMode = 'main'; err = ''; }}>{t('返回')}</button>
        </div>
      {:else if me.kind !== 'none'}
        <h3>{me.user || 'Admin'}</h3>
        <div class="usage">
          <div class="urow"><span>{t('5 小时额度')}</span><span>{fiveH == null ? '—' : fiveH + '%'}</span></div>
          <div class="urow"><span>{t('本周额度')}</span><span>{weekly == null ? '—' : weekly + '%'}</span></div>
          {#if hasLimits(mine)}
            {#each quotaRows(mine) as r (r.label)}
              <div class="urow"><span>{t('我的 · {label}', { label: r.label })}</span><span class:hot={r.hot}>{r.value}</span></div>
            {/each}
          {/if}
          <p class="uhint">{pwDone ? t('密码已改好，别的设备要用新密码重新登录') : hasLimits(mine) ? t('上两行为共享订阅用量，「我的」只算 Claude') : t('额度为共享订阅用量')}</p>
        </div>
        <div class="acts">
          <button class="act workspace" onclick={openWorkspace}>
            <img src="{import.meta.env.BASE_URL}assets/icons/workspace.png" alt="" />
            <span>{t('工作空间')}</span><span class="chev">›</span>
          </button>
          {#if canScan}
            <button class="act workspace" onclick={openScan}>
              <span class="scanico" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="18" height="18"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
              </span>
              <span>{t('扫一扫 · 登录网页版')}</span><span class="chev">›</span>
            </button>
          {/if}
          <button class="act primary" onclick={doLogout}>{t('退出登录')}</button>
          <button class="act ghost" onclick={openSettings}>{t('设置')}</button>
          {#if me.kind === 'user'}<button class="act ghost" onclick={openPw}>{t('修改密码')}</button>{/if}
        </div>
      {:else if mode === 'register'}
        <h3>{t('注册')}</h3>
        {#if err}<div class="err">{err}</div>{/if}
        <input class="lf" placeholder={t('账号（2–32 位字母/数字/_/-）')} bind:value={username} autocomplete="off" />
        <input class="lf" type="password" placeholder={t('密码（至少 8 位）')} bind:value={password} />
        <input class="lf" type="password" placeholder={t('确认密码')} bind:value={password2} onkeydown={(e) => onKey(e, doRegister)} />
        <input class="lf" placeholder={t('邀请码')} bind:value={invite} onkeydown={(e) => onKey(e, doRegister)} />
        <div class="acts">
          <button class="act primary" onclick={doRegister} disabled={busy}>{busy ? t('注册中…') : t('注册')}</button>
          <button class="act ghost" onclick={() => { mode = 'login'; err = ''; }}>{t('返回登录')}</button>
        </div>
      {:else if mode === 'qr'}
        <h3>{t('扫码登录')}</h3>
        <div class="qrwrap">
          <div class="qrbox" class:dim={pair.status !== 'pending'}>
            {#if pair.svg}{@html pair.svg}{/if}
          </div>
          {#if pair.status === 'scanned'}
            <div class="qrov" in:fade={{ duration: 160 }}><span class="qi ok">✓</span><b>{t('已扫描')}</b><small>{t('请在手机上确认')}</small></div>
          {:else if pair.status === 'approved'}
            <div class="qrov"><span class="spin"></span><b>{t('登录中…')}</b></div>
          {:else if pair.status === 'loading' || pair.status === 'idle'}
            <div class="qrov"><span class="spin"></span></div>
          {:else if pair.status !== 'pending'}
            <button class="qrov tap" onclick={() => pairCtl?.refresh()}>
              <span class="qi">↻</span><b>{pairMsg}</b><small>{t('点击刷新')}</small>
            </button>
          {/if}
        </div>
        <p class="qrhint">{t('在已登录的手机浏览器里打开本站，在账户菜单点「扫一扫」')}</p>
        <div class="acts">
          <button class="act ghost" onclick={() => { mode = 'login'; err = ''; }}>{t('账号密码登录')}</button>
        </div>
      {:else if mode === 'token'}
        <h3>{t('管理员令牌')}</h3>
        {#if err}<div class="err">{err}</div>{/if}
        <input class="lf" placeholder={t('访问令牌')} bind:value={tok} onkeydown={(e) => onKey(e, doToken)} />
        <div class="acts">
          <button class="act primary" onclick={doToken} disabled={busy}>{busy ? t('登录中…') : t('登录')}</button>
          <button class="act ghost" onclick={() => { mode = 'login'; err = ''; }}>{t('返回')}</button>
        </div>
      {:else}
        <h3>{t('欢迎回来')}</h3>
        {#if err}<div class="err">{err}</div>{/if}
        <input class="lf" placeholder={tc('settings', '账号')} bind:value={username} autocomplete="off" />
        <input class="lf" type="password" placeholder={t('密码')} bind:value={password} onkeydown={(e) => onKey(e, doLogin)} />
        <div class="acts">
          <button class="act primary" onclick={doLogin} disabled={busy}>{busy ? t('登录中…') : t('登录')}</button>
          <button class="act ghost" onclick={() => { mode = 'qr'; err = ''; }}>{t('扫码登录')}</button>
          <div class="links">
            <!-- 服务器没开注册（主机形态）就不摆：点进去也只会被拒 -->
            {#if me.features?.register !== false}
              <button class="act link" onclick={() => { mode = 'register'; err = ''; }}>{t('注册新账号')}</button>
            {/if}
            <button class="act link" onclick={() => { mode = 'token'; err = ''; }}>{t('用访问令牌登录')}</button>
          </div>
        </div>
      {/if}
    </div>
  {/if}
</div>
</div>

<style>
  /* iOS 弹性缓动 */
  .plabel, .card { transition-timing-function: cubic-bezier(.32, .72, 0, 1); }
  /* 出场动画：启动完成后整个登录胶囊（胶囊+本体）一起淡入。
     fixed 子元素靠外层 opacity group 一并淡入；外层占满视口、自身不拦事件（子元素各自接管）。 */
  .lc-fade { position: fixed; inset: 0; z-index: 30; pointer-events: none; opacity: 0; transition: opacity var(--mo-base) var(--ea-fade) var(--mo-quick); }
  .lc-fade.appeared { opacity: 1; }

  .plabel {
    position: fixed; z-index: 32; pointer-events: auto;
    /* 块级 + 行高居中（而非 flex），让超长用户名能 ellipsis（pillW 封顶后的兜底） */
    display: block; line-height: 40px; text-align: center; padding: 0 14px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border-radius: 20px;
    background: var(--card); box-shadow: var(--card-shadow);
    color: var(--text); font-size: 14px; font-weight: 600; letter-spacing: .02em;
    transform-origin: center center; transition-property: transform, opacity; transition-duration: .52s, .3s;
  }
  /* 胶囊本身是个按钮，鼠标划过得亮一下（transform/opacity 归 morph 动画管，这里只碰底色） */
  @media (hover: hover) {
    .plabel:hover { background: color-mix(in srgb, var(--card) 88%, var(--text)); }
  }

  .card-bd { position: fixed; inset: 0; z-index: 20; pointer-events: auto; background: rgba(0,0,0,.34); backdrop-filter: blur(2px); -webkit-backdrop-filter: blur(2px); }

  .card {
    position: fixed; z-index: 30; pointer-events: auto; overflow: hidden;
    transition-property: left, top, width, height, border-radius, background, box-shadow, backdrop-filter, -webkit-backdrop-filter;
    transition-duration: .52s; box-shadow: 0 0 0 0 rgba(0,0,0,0);
  }
  .card.pill { background: rgba(255,255,255,0); backdrop-filter: blur(0) saturate(1); -webkit-backdrop-filter: blur(0) saturate(1); }
  .card.expanded {
    background: rgba(240,243,250,.72); backdrop-filter: blur(34px) saturate(1.7); -webkit-backdrop-filter: blur(34px) saturate(1.7);
    box-shadow: 0 30px 90px rgba(0,0,0,.4), inset 0 1px 1px rgba(255,255,255,.7);
  }

  .content { position: absolute; inset: 0; padding: 26px 22px; display: flex; flex-direction: column; gap: 12px; overflow-y: auto; }
  .content h3 { font-size: 23px; font-weight: 800; color: #15171c; margin-bottom: 2px; }
  .lf { width: 100%; height: 50px; border: none; outline: none; border-radius: 14px; background: rgba(255,255,255,.66); box-shadow: inset 0 0 0 .5px rgba(0,0,0,.08); padding: 0 16px; font-size: 16px; color: #15171c; }
  .lf::placeholder { color: #8a8d96; }
  .acts { display: flex; flex-direction: column; gap: 10px; margin-top: auto; }
  .act { width: 100%; height: 50px; border-radius: 25px; font-size: 17px; font-weight: 700; display: flex; align-items: center; justify-content: center; transition: transform var(--mo-tap) var(--ea-out), filter var(--mo-micro) var(--ea-fade); }
  .act:active { transform: scale(.97); }
  .act.primary { background: #2f6fed; color: #fff; box-shadow: 0 6px 16px rgba(47,111,237,.4); }
  .act.primary:disabled { opacity: .6; }
  .act.ghost { background: rgba(0,0,0,.05); color: #2f6fed; font-weight: 600; height: 46px; }
  .act.workspace { position: relative; justify-content: flex-start; gap: 11px; padding: 0 17px; background: rgba(255,255,255,.62); color: #15171c; box-shadow: inset 0 0 0 .5px rgba(0,0,0,.08); }
  .act.workspace img { width: 28px; height: 28px; object-fit: contain; }
  .act.workspace .chev { margin-left: auto; color: #8a8d96; font-size: 27px; line-height: 1; font-weight: 400; }
  .act.link { background: none; color: #5a5e68; font-weight: 500; height: 38px; font-size: 14px; }
  /* 登录模式底部两条次级链接并排（注册 / 令牌），把主位让给「扫码登录」 */
  .links { display: flex; gap: 6px; }
  .links .act.link { width: auto; flex: 1; padding: 0 4px; }
  :global(html[lang='en']) .links { flex-wrap: wrap; }
  :global(html[lang='en']) .links .act.link { flex: 1 1 auto; }
  .act.workspace .scanico { width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; color: #2f6fed; }
  /* —— 扫码登录：白底码块 + 状态盖层 —— */
  .qrwrap { position: relative; width: 200px; height: 200px; margin: 2px auto 0; flex: none; }
  .qrbox { position: absolute; inset: 0; padding: 12px; border-radius: 16px; background: #fff; box-shadow: inset 0 0 0 .5px rgba(0,0,0,.08); transition: opacity .2s; }
  .qrbox :global(svg) { display: block; width: 100%; height: 100%; }
  .qrbox.dim :global(svg) { opacity: .1; }
  .qrov { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: #15171c; text-align: center; padding: 12px; border-radius: 16px; background: transparent; }
  .qrov b { font-size: 15px; font-weight: 700; }
  .qrov small { font-size: 12.5px; color: #6b6f78; }
  .qrov.tap:active { background: rgba(0,0,0,.04); }
  .qi { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 700; color: #2f6fed; background: rgba(47,111,237,.12); margin-bottom: 4px; }
  .qi.ok { color: #2f9e5b; background: rgba(47,158,91,.13); }
  .spin { width: 26px; height: 26px; border-radius: 50%; border: 3px solid rgba(47,111,237,.18); border-top-color: #2f6fed; animation: qrspin .8s linear infinite; }
  @keyframes qrspin { to { transform: rotate(360deg); } }
  .qrhint { font-size: 13px; color: #6b6f78; text-align: center; line-height: 1.4; }
  .err { background: rgba(217,106,90,.14); color: #b13b2a; font-size: 13px; padding: 9px 13px; border-radius: 11px; }
  .usage { display: flex; flex-direction: column; gap: 9px; margin: 4px 0 2px; }
  .urow { display: flex; justify-content: space-between; font-size: 15px; color: #2a2d34; }
  .urow span:last-child { font-weight: 700; }
  /* 英文「Your usage · Last 7 days」与「3 / 20 turns · $0.52 / $2.00」一行放不下：留缝、数值折行右对齐 */
  :global(html[lang='en']) .urow { gap: 10px; }
  :global(html[lang='en']) .urow span:last-child { text-align: right; }
  .uhint { font-size: 12px; color: #82858d; margin-top: 2px; }
  .urow span.hot { color: #d9453a; }
</style>
