<script>
  // 主页右上登录 pill ↔ 卡片单元素 morph（精修版，机制照搬 demo2）：
  //   card 本体 pill↔卡片形变（clip-path + transform，卡片始终按展开几何排版）
  //   + refract 折射玻璃层（pill 玻璃质感，展开时放大淡出）
  //   + plabel 文字层（pill 文字，展开时移中心淡出）
  //   + content（表单/用户信息，展开时淡入）。
  // 四态：未登录 login/register/token(管理员令牌)/qr；已登录＝一眼看的账户摘要（用量 + 工作空间 / 扫一扫），
  // 退出登录、切换账号、改密码都在设置 › 账户（「账户」钮直达），卡片里不放。
  // 展开后的卡＝iOS 27 警告框同一套材质（ios27/Alert：kit「Liquid Glass - Regular - Medium」9 宫图层 + frost 模糊 +
  // kit 大投影，圆角 34），配色是设置页的「墨与象牙」（ios27/ink.css），明暗跟 ui.theme。
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { api } from '../lib/api.js';
  import { signIn, signUp, signInToken } from '../lib/account.js';
  import { liquidGlass } from '../lib/liquidGlass.js';
  import { homeGlass } from '../lib/figmaHomeGlass.svelte.js';
  import FigmaGlass from './FigmaGlass.svelte';
  import TextField from './ios27/TextField.svelte';
  import Sym from './ios27/Sym.svelte';
  import './ios27/ink.css';
  import { SI } from '../lib/settingsIcons.js';
  import { ui, me, status, bareGlass } from '../lib/state.svelte.js';
  import { openPage } from '../lib/pageMorph.js';
  import { wcoRightInset } from '../desktop/chrome/wco.svelte.js';
  import { startPairLogin } from '../lib/pair.js';
  import { isOffline } from '../lib/server.js';
  import { fetchMyUsage, quotaRows, hasLimits } from '../lib/me.js';
  import { openSettings as openSettingsAt } from '../lib/settingsNav.svelte.js';
  import { t, tc, tr } from '../lib/i18n.js';
  import { ovUrl } from '../lib/overlay.svelte.js';
  import glassL_pub from '../assets/ios27/alert-light.png';
  import glassD_pub from '../assets/ios27/alert-dark.png';
  const glassL = $derived(ovUrl('ios27/alert-light.png', glassL_pub));
  const glassD = $derived(ovUrl('ios27/alert-dark.png', glassD_pub));

  let mode = $state('login'); // 'login' | 'register' | 'token' | 'qr'(扫码登录：网页出码、手机扫)
  let username = $state(''), password = $state(''), password2 = $state(''), invite = $state(''), tok = $state('');
  let busy = $state(false), err = $state('');

  const open = $derived(ui.loginOpen);
  const dark = $derived(ui.theme !== 'light');
  const pillLabel = $derived(me.kind === 'none' ? t('登录') : (me.user || (me.kind === 'admin' ? 'Admin' : t('我'))));
  const shownName = $derived(me.user || (me.kind === 'admin' ? 'Admin' : ''));
  const initial = $derived((shownName || '?').trim().charAt(0).toUpperCase());
  const roleLabel = $derived(me.kind === 'admin' ? t('管理员') : me.tier === 'pro' ? t('完全信任用户') : t('普通用户'));

  // —— 几何：pill（右上小胶囊）↔ card（居中大卡）——
  const PILL_H = 40, M = 16, CARD_W = 320, R = 34;
  // 卡高＝内容的自然高度（ResizeObserver 量 .inner，同一帧里就修正）：模式切换、英文折行、额度行多少都自动跟上，
  // 高度变化走 top/height 过渡。EST_H 只是第一次展开、还没量到之前那一帧的估值。
  const EST_H = { login: 330, register: 470, token: 290, qr: 440, user: 400 };
  let innerH = $state(0);
  const cardH = $derived(innerH || (me.kind !== 'none' ? EST_H.user : (EST_H[mode] || EST_H.login)));
  function measure(node) {
    const ro = new ResizeObserver(() => { const h = node.offsetHeight; if (h > 0) innerH = h; });
    ro.observe(node);
    return { destroy() { ro.disconnect(); } };
  }
  // 「扫一扫」入口只给手机形态（apk / 触屏）：桌面浏览器拿摄像头对着另一块屏幕扫码不是正常用法。
  const canScan = (() => { try { return isOffline() || matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
  let mine = $state(null);         // /api/me/usage（注册用户被设了额度时多几行「我的」）
  // 审查 2.3 / S1-2：单人服务器（没开多用户）账号密码只有服务账号能登，默认摆令牌登录；手机上「扫码登录」
  // （网页出码让手机扫）换成「扫码连接」——扫电脑上的配对码，换这台手机自己的会话（PairScan mode:'connect'）
  let picked = false;
  $effect(() => { if (open && me.kind === 'none' && !picked && mode === 'login' && me.features?.multiUser === false) mode = 'token'; });
  function scanConnect() { picked = true; ui.loginOpen = false; err = ''; ui.pairScan = { mode: 'connect' }; }

  let vw = $state(390), vh = $state(800), pillW = $state(88), pillEl = $state();
  // edge-to-edge：pill 顶距要让出系统状态栏。--sat 由 app.css env() 或 apk 原生注入，
  // getComputedStyle 拿解析后的 px；原生注入晚于挂载，故延迟重读兜底。
  let insetTop = $state(0);
  function readInset() {
    try { insetTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sat')) || 0; } catch {}
  }
  onMount(() => {
    const upd = () => { vw = window.innerWidth; vh = window.innerHeight; readInset(); };
    upd(); window.addEventListener('resize', upd);
    window.addEventListener('bridge-insets', readInset);   // apk 原生注入完成的广播
    const t1 = setTimeout(readInset, 600), t2 = setTimeout(readInset, 2000);
    return () => { window.removeEventListener('resize', upd); window.removeEventListener('bridge-insets', readInset); clearTimeout(t1); clearTimeout(t2); };
  });
  // 测量 pill 宽度：用隐藏探针测 label 的【自然宽度】（同字体样式）。
  // 不能测 plabel 自身——它的宽度被 width:${pillW}px 锁死，测回的是 pillW 自己
  //（循环依赖，旧实现长用户名永远溢出）。上限封顶（不挤左上标题），超长由 ellipsis 兜底。
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
    const max = Math.min(240, Math.round(vw * 0.5));       // 封顶：给左上 THE BRIDGE 留位
    pillW = Math.round(Math.min(Math.max(76, natural), max));
  });

  const pillTop = $derived(M + insetTop);
  // WCO frameless 壳：右上角被系统窗控按钮占掉一条，pill 左移避让（非 WCO 环境 inset=0 原样）。
  const pillLeft = $derived.by(() => {
    const inset = wcoRightInset();          // 依赖 vw：窗口尺寸变化时重测
    void vw;
    return vw - M - pillW - (inset ? inset + 6 : 0);
  });
  // 键盘弹出时 vh 骤减（resize 监听已更新）：卡高/顶距按可视高度钳制，内容区可滚动，
  // 不再出现 register 卡 > 键盘后视口 → 标题被顶出屏外。卡宽同理防窄屏溢出。
  const cardW = $derived(Math.min(CARD_W, vw - 24));
  const effH = $derived(Math.min(cardH, vh - insetTop - 24));
  const cardTop = $derived(Math.max(insetTop + 12, (vh - effH) / 2));
  const dx = $derived(vw / 2 - (pillLeft + pillW / 2));
  const dy = $derived(cardTop + effH / 2 - (pillTop + PILL_H / 2));
  const baseGeom = $derived(`left:${pillLeft}px; top:${pillTop}px; width:${pillW}px; height:${PILL_H}px;`);
  // 形变只动合成层属性（手机掉帧的根因是旧版逐帧过渡 left/top/width/height + 模糊半径 + 90px 阴影，
  // 每帧重排、重绘、重新模糊整片壁纸）：卡片始终按展开后的几何排版，收起态用 clip-path 裁成胶囊大小、
  // transform 平移到胶囊位置；投影是另一层，跟着 scale 缩回胶囊并淡出。
  const cardGeom = $derived(`left:${(vw - cardW) / 2}px; top:${cardTop}px; width:${cardW}px; height:${effH}px;`);
  const cardStyle = $derived(open
    ? `${cardGeom} transform:none; clip-path:inset(0px 0px 0px 0px round ${R}px);`
    : `${cardGeom} transform:translate(${-dx}px,${-dy}px); clip-path:inset(${(effH - PILL_H) / 2}px ${(cardW - pillW) / 2}px round ${PILL_H / 2}px);`);
  const shadowStyle = $derived(open
    ? `${cardGeom} transform:none;`
    : `${cardGeom} transform:translate(${-dx}px,${-dy}px) scale(${pillW / cardW},${PILL_H / effH});`);
  const plabelStyle = $derived(open ? `transform:translate(${dx}px,${dy}px); opacity:0; pointer-events:none;` : `transform:none; opacity:1;`);
  const refractGlass = $derived(bareGlass(22));   // 与四入口图标共用同一材质内核（bare 纯折射），仅圆角不同

  function toggle() { ui.loginOpen = !ui.loginOpen; }
  function close() { ui.loginOpen = false; err = ''; }
  function reset() { username = ''; password = ''; password2 = ''; invite = ''; tok = ''; err = ''; }
  function go(m) { mode = m; err = ''; }

  // 登录三步（存 Bearer、刷新身份、记进「最近登录」）与设置 › 账户同一套：lib/account.js
  async function run(fn, failMsg) {
    if (busy) return; busy = true; err = '';
    try { await fn(); reset(); close(); }
    catch (e) { err = tr(e?.body?.error) || failMsg; }
    busy = false;
  }
  const doLogin = () => run(() => signIn(username.trim(), password), t('登录失败'));
  const doRegister = () => run(() => signUp({ username: username.trim(), password, password2, invite: invite.trim() }), t('注册失败'));
  const doToken = () => run(() => signInToken(tok), t('令牌无效'));
  // 工作空间从卡片里这一行长出来（与主页四入口同一套转场）；卡片在旧快照里随主页一起退后
  function openWorkspace(ev) { openPage('files', { from: ev?.currentTarget || null, radius: 16, onSwitch: close }); }
  function openSettings() { ui.settingsOpen = true; close(); }
  function openAccount() { openSettingsAt('account'); close(); }
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
  const lim = $derived(status.limits || {});
  const pctOf = (b) => (b && typeof b.pct === 'number' ? Math.max(0, Math.min(100, Math.round(b.pct))) : null);
  const meters = $derived([{ label: t('5 小时额度'), pct: pctOf(lim.five_hour) }, { label: t('本周额度'), pct: pctOf(lim.seven_day) }]);
  const icon = (n) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${SI[n] || ''}</svg>`;
  const onKey = (e, fn) => { if (e.key === 'Enter') fn(); };
</script>

<!-- 折射玻璃层（pill 玻璃质感；展开时放大淡出） -->
<div class="lc-fade i27ink" class:dark class:appeared={ui.booted}>
{#if homeGlass.on}
  <!-- Figma 玻璃（与四个入口同一套，见 Home / FigmaGlass）；几何直接给，展开时的形变不影响取背景 -->
  <div class="refract"
    style:left="{pillLeft}px" style:top="{pillTop}px" style:width="{pillW}px" style:height="{PILL_H}px"
    style:transform={open ? `translate(${dx}px,${dy}px) scale(${cardW / pillW},${effH / PILL_H})` : 'none'}
    style:opacity={open ? 0 : 1}
    aria-hidden="true"><FigmaGlass bg={homeGlass.bg} radius={PILL_H / 2} rect={{ x: pillLeft, y: pillTop, w: pillW, h: PILL_H }} /></div>
{:else}
  <div class="refract" use:liquidGlass={refractGlass}
    style:left="{pillLeft}px" style:top="{pillTop}px" style:width="{pillW}px" style:height="{PILL_H}px"
    style:transform={open ? `translate(${dx}px,${dy}px) scale(${cardW / pillW},${effH / PILL_H})` : 'none'}
    style:opacity={open ? 0 : 1}
    aria-hidden="true"></div>
{/if}
<!-- pill 文字层（可点；展开时移中心淡出） -->
<button class="plabel" bind:this={pillEl} style="{baseGeom} {plabelStyle}" onclick={toggle}>{pillLabel}</button>

{#if open}<button class="card-bd" transition:fade={{ duration: 220 }} onclick={close} aria-label={t('关闭')}></button>{/if}

<!-- 卡片投影：单独一层（卡片本体被 clip-path 裁着，外投影画不出来） -->
<div class="card-shadow" class:expanded={open} style={shadowStyle} aria-hidden="true"></div>

<!-- morph 卡片本体 -->
<div class="card {open ? 'expanded' : 'pill'}" style={cardStyle} style:--glass={`url("${dark ? glassD : glassL}")`}>
  {#if open}
    <div class="content" in:fade={{ duration: 240, delay: 170 }}>
      <div class="inner" use:measure>
        {#key me.kind === 'none' ? mode : 'user'}
        <div class="pane" in:fade={{ duration: 200 }}>
        {#if me.kind !== 'none'}
          <div class="who">
            <span class="av" aria-hidden="true">{initial}</span>
            <span class="who-tx"><b>{shownName}</b><small>{roleLabel}{status.plan ? ' · ' + status.plan : ''}</small></span>
          </div>
          <div class="meters">
            {#each meters as m (m.label)}
              <div class="m">
                <div class="m-top"><span>{m.label}</span><span class="m-v">{m.pct == null ? '—' : m.pct + '%'}</span></div>
                <span class="bar">{#if m.pct != null}<i style:width="{m.pct}%" class:hot={m.pct >= 80}></i>{/if}</span>
              </div>
            {/each}
            {#if hasLimits(mine)}
              <div class="quota">
                {#each quotaRows(mine) as r (r.label)}
                  <div class="q"><span>{t('我的 · {label}', { label: r.label })}</span><span class:hot={r.hot}>{r.value}</span></div>
                {/each}
              </div>
            {/if}
            <p class="note">{hasLimits(mine) ? t('上两行为共享订阅用量，「我的」只算 Claude') : t('额度为共享订阅用量')}</p>
          </div>
          <div class="list">
            <button class="row" type="button" onclick={openWorkspace}>
              <span class="ri" aria-hidden="true">{@html icon('folder')}</span>
              <span class="row-tx">{t('工作空间')}</span>
              <Sym name="chevron.right" weight={600} size={13} class="chev" />
            </button>
            {#if canScan}
              <button class="row" type="button" onclick={openScan}>
                <span class="ri" aria-hidden="true">{@html icon('scan')}</span>
                <span class="row-tx">{t('扫一扫 · 登录网页版')}</span>
                <Sym name="chevron.right" weight={600} size={13} class="chev" />
              </button>
            {/if}
          </div>
          <!-- kit 警告框 Side-by-Side：次要在左、主操作在右 -->
          <div class="btns side">
            <button class="btn" type="button" onclick={openSettings}>{t('设置')}</button>
            <button class="btn default" type="button" onclick={openAccount}>{t('账户')}</button>
          </div>
        {:else if mode === 'register'}
          <div class="tm">
            <h3>{t('注册')}</h3>
            <p>{t('服主默认只看得到你的会话标题、时间和用量；看内容要你在设置里允许。')}</p>
            {#if err}<p class="err">{err}</p>{/if}
          </div>
          <div class="fields">
            <TextField placeholder={t('账号（2–32 位字母/数字/_/-）')} bind:value={username} autocomplete="off" autocapitalize="off" spellcheck="false" />
            <TextField type="password" placeholder={t('密码（至少 8 位）')} bind:value={password} />
            <TextField type="password" placeholder={t('确认密码')} bind:value={password2} onkeydown={(e) => onKey(e, doRegister)} />
            <TextField placeholder={t('邀请码')} bind:value={invite} autocapitalize="off" onkeydown={(e) => onKey(e, doRegister)} />
          </div>
          <div class="btns">
            <button class="btn default" type="button" onclick={doRegister} disabled={busy}>{busy ? t('注册中…') : t('注册')}</button>
            <button class="btn" type="button" onclick={() => go('login')}>{t('返回登录')}</button>
          </div>
        {:else if mode === 'qr'}
          <div class="tm center">
            <h3>{t('扫码登录')}</h3>
            <p>{t('打开手机上的 The Bridge，在账户卡点「扫一扫」')}</p>
          </div>
          <div class="qrwrap">
            <div class="qrbox" class:dim={pair.status !== 'pending'}>
              {#if pair.svg}{@html pair.svg}{/if}
            </div>
            {#if pair.status === 'scanned'}
              <div class="qrov" in:fade={{ duration: 160 }}><span class="qi ok"><Sym name="checkmark" weight={600} size={18} /></span><b>{t('已扫描')}</b><small>{t('请在手机上确认')}</small></div>
            {:else if pair.status === 'approved'}
              <div class="qrov"><span class="spin"></span><b>{t('登录中…')}</b></div>
            {:else if pair.status === 'loading' || pair.status === 'idle'}
              <div class="qrov"><span class="spin"></span></div>
            {:else if pair.status !== 'pending'}
              <button class="qrov tap" type="button" onclick={() => pairCtl?.refresh()}>
                <span class="qi">↻</span><b>{pairMsg}</b><small>{t('点击刷新')}</small>
              </button>
            {/if}
          </div>
          <div class="btns">
            <button class="btn" type="button" onclick={() => go('login')}>{t('账号密码登录')}</button>
          </div>
        {:else if mode === 'token'}
          <div class="tm">
            <h3>{t('管理员令牌')}</h3>
            {#if err}<p class="err">{err}</p>{/if}
          </div>
          <div class="fields">
            <TextField placeholder={t('访问令牌')} bind:value={tok} autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" onkeydown={(e) => onKey(e, doToken)} />
          </div>
          <div class="btns">
            <button class="btn default" type="button" onclick={doToken} disabled={busy}>{busy ? t('登录中…') : t('登录')}</button>
            {#if canScan}<button class="btn" type="button" onclick={scanConnect}>{t('扫码连接')}</button>{/if}
            <button class="btn" type="button" onclick={() => { picked = true; go('login'); }}>{t('返回')}</button>
          </div>
        {:else}
          <div class="tm">
            <h3>{t('欢迎回来')}</h3>
            {#if err}<p class="err">{err}</p>{/if}
          </div>
          <div class="fields">
            <TextField placeholder={tc('settings', '账号')} bind:value={username} autocomplete="username" autocapitalize="off" spellcheck="false" />
            <TextField type="password" placeholder={t('密码')} bind:value={password} autocomplete="current-password" onkeydown={(e) => onKey(e, doLogin)} />
          </div>
          <div class="btns">
            <button class="btn default" type="button" onclick={doLogin} disabled={busy}>{busy ? t('登录中…') : t('登录')}</button>
            {#if canScan}
              <button class="btn" type="button" onclick={scanConnect}>{t('扫码连接')}</button>
            {:else}
              <button class="btn" type="button" onclick={() => go('qr')}>{t('扫码登录')}</button>
            {/if}
          </div>
          <div class="links">
            <!-- 服务器没开注册（主机形态）就不摆：点进去也只会被拒 -->
            {#if me.features?.register !== false}
              <button class="link" type="button" onclick={() => go('register')}>{t('注册新账号')}</button>
              <span class="dot" aria-hidden="true">·</span>
            {/if}
            <button class="link" type="button" onclick={() => go('token')}>{t('用访问令牌登录')}</button>
          </div>
        {/if}
        </div>
        {/key}
      </div>
    </div>
  {/if}
</div>
</div>

<style>
  /* iOS 弹性缓动，与 demo2 一致 */
  .refract, .plabel, .card { transition-timing-function: cubic-bezier(.32, .72, 0, 1); }
  /* 出场动画：随主页露出，整个登录胶囊（玻璃+文字+本体）一起淡入，略晚于入口图标。
     fixed 子元素靠外层 opacity group 一并淡入；外层占满视口、自身不拦事件（子元素各自接管）。 */
  .lc-fade { position: fixed; inset: 0; z-index: 30; pointer-events: none; opacity: 0; transition: opacity var(--mo-base) var(--ea-fade) var(--mo-quick);
    font-family: var(--font-brand-sans), -apple-system, BlinkMacSystemFont, system-ui, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
    -webkit-font-smoothing: antialiased; }
  .lc-fade.appeared { opacity: 1; }

  .refract {
    position: fixed; z-index: 31; pointer-events: none;
    border-radius: 22px; transform-origin: center center;
    transition-property: transform, opacity; transition-duration: .52s, .42s;
  }
  .plabel {
    position: fixed; z-index: 32; pointer-events: auto;
    /* 块级 + 行高居中（而非 flex），让超长用户名能 ellipsis（pillW 封顶后的兜底） */
    display: block; line-height: 40px; text-align: center; padding: 0 14px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    color: #fff; font-size: 14px; font-weight: 600; letter-spacing: .02em; text-shadow: 0 1px 3px rgba(0,0,0,.35);
    transform-origin: center center; transition-property: transform, opacity; transition-duration: .52s, .3s;
  }
  /* 桌面：胶囊本身是个按钮，鼠标划过得亮一下（transform/opacity 归 morph 动画管，
     这里只碰文字发光，免得跟展开成卡片的那条 transition 打架） */
  @media (hover: hover) {
    .plabel:hover { text-shadow: 0 0 12px rgba(255,255,255,.55), 0 1px 3px rgba(0,0,0,.35); }
  }

  /* 遮罩＝kit「Overlay - Alerts」那层压暗（墨色令牌 --i-dim），不带 backdrop-filter：全屏模糊每帧都要重算整片壁纸，
     而且垫在卡片那层模糊底下会让它静默失效（同屏多层 backdrop 互扰）。 */
  .card-bd { position: fixed; inset: 0; z-index: 20; pointer-events: auto; border: 0; padding: 0; cursor: default; background: var(--i-dim); }

  /* 只过渡 transform / clip-path / opacity（+ 内容高度变化时的 top/height）。模糊半径不做动画：展开时立刻生效（此刻整层透明），
     收起时等形变走完再撤（时长 0、延迟 .52s），不然淡出途中毛玻璃会一下子变清。
     材质同 ios27/Alert：::before 铺 kit 玻璃 9 宫图层（亮 #F6F6F6@73% / 暗 #1B1B1D@98%，边缘一圈高光），frost 16 → blur 6.53px。 */
  .card {
    position: fixed; z-index: 30; pointer-events: none; overflow: hidden; opacity: 0; isolation: isolate;
    border-radius: 34px; color: var(--i-label);
    transition: transform .52s cubic-bezier(.32, .72, 0, 1), clip-path .52s cubic-bezier(.32, .72, 0, 1),
      top .52s cubic-bezier(.32, .72, 0, 1), height .52s cubic-bezier(.32, .72, 0, 1),
      opacity .4s cubic-bezier(.45, 0, .55, 1),
      backdrop-filter 0s linear .52s, -webkit-backdrop-filter 0s linear .52s;
  }
  .card::before { content: ''; position: absolute; z-index: -1; inset: 0; pointer-events: none;
    border: 0 solid transparent; border-image: var(--glass) 228 fill / 76px / 16px stretch; }
  .card.expanded {
    pointer-events: auto; opacity: 1;
    backdrop-filter: blur(6.53px); -webkit-backdrop-filter: blur(6.53px);
    transition: transform .52s cubic-bezier(.32, .72, 0, 1), clip-path .52s cubic-bezier(.32, .72, 0, 1),
      top .52s cubic-bezier(.32, .72, 0, 1), height .52s cubic-bezier(.32, .72, 0, 1),
      opacity .3s cubic-bezier(.32, .72, 0, 1),
      backdrop-filter 0s, -webkit-backdrop-filter 0s;
  }
  /* kit 警告框投影 0/8/48（σ=0.4227·r → 2σ=40.6），暗色加深 */
  .card-shadow {
    position: fixed; z-index: 29; pointer-events: none; opacity: 0;
    border-radius: 34px; box-shadow: 0 8px 40.6px rgba(0, 0, 0, .25); transform-origin: center center;
    transition-property: transform, opacity, top, height; transition-duration: .52s;
    transition-timing-function: cubic-bezier(.32, .72, 0, 1);
  }
  .dark .card-shadow { box-shadow: 0 8px 40.6px rgba(0, 0, 0, .45); }
  .card-shadow.expanded { opacity: 1; }

  .content { position: absolute; inset: 0; overflow-y: auto; overscroll-behavior: contain; scrollbar-width: none; }
  .content::-webkit-scrollbar { display: none; }
  .inner { padding: 14px; }
  .pane { display: flex; flex-direction: column; }

  /* —— 标题区（kit 警告框：内距 8、标题 17/22 Semibold，下方留 22 到正文） —— */
  .tm { display: flex; flex-direction: column; gap: 8px; padding: 8px 8px 22px; }
  .tm.center { text-align: center; align-items: center; }
  .tm h3 { margin: 0; font-size: 17px; line-height: 22px; font-weight: 600; letter-spacing: -.43px; }
  .tm p { margin: 0; font-size: 15px; line-height: 20px; color: var(--i-label2); }
  .tm .err { color: var(--i-red); }
  .fields { display: flex; flex-direction: column; gap: 8px; padding-bottom: 18px; }

  /* —— 按钮：kit 警告框 48 高胶囊、17/22 Semibold；主操作＝实心墨色（暗色是象牙），其余灰底 —— */
  .btns { display: flex; flex-direction: column; gap: 8px; }
  .btns.side { flex-direction: row; }
  .btns.side .btn { flex: 1; min-width: 0; }
  .btn {
    height: 48px; border-radius: 24px; border: 0; padding: 0 16px; cursor: pointer; font: inherit;
    font-size: 17px; line-height: 22px; font-weight: 600; letter-spacing: -.43px; color: var(--i-label);
    background: var(--i-btn); display: flex; align-items: center; justify-content: center;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; -webkit-tap-highlight-color: transparent;
    transition: transform 160ms cubic-bezier(.2, 0, 0, 1), filter 160ms linear, opacity 160ms linear;
  }
  .btn.default { background: var(--i-accent); color: var(--i-on-accent); }
  .btn:active:not(:disabled) { transform: scale(.97); filter: brightness(.92); }
  .btn:disabled { opacity: .45; cursor: default; }
  .links { display: flex; align-items: center; justify-content: center; flex-wrap: wrap; padding-top: 8px; }
  .link { height: 36px; padding: 0 8px; border: 0; background: none; cursor: pointer; font: inherit; font-size: 15px; line-height: 20px; color: var(--i-label2); -webkit-tap-highlight-color: transparent; }
  .link:active { color: var(--i-label); }
  .dot { color: var(--i-label3); font-size: 15px; }

  /* —— 已登录：头像 + 名字 / 用量条 / 分组列表 / 并排按钮 —— */
  .who { display: flex; align-items: center; gap: 12px; padding: 8px 8px 20px; min-width: 0; }
  /* 字母头像同设置页：墨色渐变底 + 象牙衬线字 */
  .av { width: 46px; height: 46px; flex: none; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
    background: var(--i-av); color: var(--i-av-ink); box-shadow: inset 0 0 0 .5px var(--i-label4);
    font-family: var(--font-brand-serif), Georgia, "Songti SC", serif; font-size: 21px; line-height: 1; font-weight: 500; }
  .who-tx { display: flex; flex-direction: column; min-width: 0; }
  .who-tx b { font-size: 19px; line-height: 24px; font-weight: 600; letter-spacing: -.3px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .who-tx small { font-size: 13px; line-height: 18px; color: var(--i-label2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .meters { display: flex; flex-direction: column; gap: 14px; padding: 0 8px 18px; }
  .m { display: flex; flex-direction: column; gap: 8px; }
  .m-top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; font-size: 15px; line-height: 20px; }
  .m-v { font-weight: 600; font-variant-numeric: tabular-nums; }
  .bar { display: block; height: 6px; border-radius: 3px; background: var(--i-fill3); overflow: hidden; }
  .bar i { display: block; height: 100%; min-width: 6px; border-radius: 3px; background: var(--i-accent);
    animation: lc-grow 700ms cubic-bezier(.2, .8, .2, 1) 260ms both; }
  .bar i.hot { background: var(--i-red); }
  @keyframes lc-grow { from { clip-path: inset(0 100% 0 0 round 3px); } to { clip-path: inset(0 0 0 0 round 3px); } }
  .quota { display: flex; flex-direction: column; gap: 6px; }
  .q { display: flex; justify-content: space-between; gap: 10px; font-size: 14px; line-height: 19px; }
  .q span:last-child { color: var(--i-label2); text-align: right; font-variant-numeric: tabular-nums; }
  .q span.hot { color: var(--i-red); }
  .note { margin: -4px 0 0; font-size: 12.5px; line-height: 17px; color: var(--i-label2); }

  /* 分组列表：玻璃上再垫一层浅底（同心圆角 34-14=20），行 52 高、行首 30 方格线稿图标 */
  .list { display: flex; flex-direction: column; border-radius: 20px; background: var(--i-list); box-shadow: inset 0 0 0 .5px var(--i-label4); overflow: hidden; margin-bottom: 14px; }
  .row { position: relative; width: 100%; height: 52px; display: flex; align-items: center; gap: 12px; padding: 0 14px 0 11px;
    border: 0; background: none; cursor: pointer; font: inherit; font-size: 17px; line-height: 22px; letter-spacing: -.43px; color: var(--i-label);
    text-align: left; -webkit-tap-highlight-color: transparent; transition: background-color 160ms linear; }
  .row + .row::before { content: ''; position: absolute; top: 0; left: 53px; right: 0; height: .5px; background: var(--i-label4); }
  .row:active { background: var(--i-fill4); }
  .ri { flex: none; width: 30px; height: 30px; border-radius: 8px; display: flex; align-items: center; justify-content: center; background: var(--i-tile); color: var(--i-tile-ink); }
  .ri :global(svg) { width: 18px; height: 18px; display: block; }
  .row-tx { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row :global(.chev) { color: var(--i-label3); }

  /* —— 网页扫码登录：白底码块 + 状态盖层 —— */
  .qrwrap { position: relative; width: 200px; height: 200px; margin: 0 auto 22px; flex: none; }
  .qrbox { position: absolute; inset: 0; padding: 14px; border-radius: 24px; background: #fff; box-shadow: 0 0 0 .5px rgba(0, 0, 0, .06), 0 8px 24px -8px rgba(0, 0, 0, .18); transition: opacity .2s; }
  .qrbox :global(svg) { display: block; width: 100%; height: 100%; transition: opacity .2s; }
  .qrbox.dim :global(svg) { opacity: .08; }
  .qrov { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: #1d1b18; text-align: center; padding: 12px; border: 0; border-radius: 24px; background: transparent; font: inherit; }
  .qrov b { font-size: 15px; line-height: 20px; font-weight: 600; }
  .qrov small { font-size: 12.5px; line-height: 17px; color: rgba(29, 27, 24, .56); }
  .qrov.tap { cursor: pointer; }
  .qrov.tap:active { background: rgba(0, 0, 0, .04); }
  .qi { width: 40px; height: 40px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 20px; font-weight: 600; color: #1d1b18; background: rgba(29, 27, 24, .07); margin-bottom: 6px; }
  .qi.ok { color: #4f8a5b; background: rgba(79, 138, 91, .14); }
  .spin { width: 24px; height: 24px; border-radius: 50%; border: 2.5px solid rgba(29, 27, 24, .14); border-top-color: #1d1b18; animation: qrspin .8s linear infinite; }
  @keyframes qrspin { to { transform: rotate(360deg); } }
</style>
