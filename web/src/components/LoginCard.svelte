<script>
  // 主页右上登录 pill ↔ 卡片单元素 morph（精修版，机制照搬 demo2）：
  //   card 本体 pill↔卡片形变（left/top/width/height/圆角/背景/backdrop transition）
  //   + refract 折射玻璃层（pill 玻璃质感，展开时放大淡出）
  //   + plabel 文字层（pill 文字，展开时移中心淡出）
  //   + content（表单/用户信息，展开时淡入）。
  // 四态：未登录 login/register/token(管理员令牌)/qr；已登录＝一眼看的账户摘要（用量 + 工作空间 / 扫一扫），
  // 退出登录、切换账号、改密码都在设置 › 账户（「账户」钮直达），卡片里不放。配色蓝、去 cancel。
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { api } from '../lib/api.js';
  import { signIn, signUp, signInToken } from '../lib/account.js';
  import { liquidGlass } from '../lib/liquidGlass.js';
  import { homeGlass } from '../lib/figmaHomeGlass.svelte.js';
  import FigmaGlass from './FigmaGlass.svelte';
  import { ui, me, status, bareGlass } from '../lib/state.svelte.js';
  import { openPage } from '../lib/pageMorph.js';
  import { wcoRightInset } from '../desktop/chrome/wco.svelte.js';
  import { startPairLogin } from '../lib/pair.js';
  import { isOffline } from '../lib/server.js';
  import { fetchMyUsage, quotaRows, hasLimits } from '../lib/me.js';
  import { openSettings as openSettingsAt } from '../lib/settingsNav.svelte.js';
  import { t, tc, tr, isEn } from '../lib/i18n.js';
  import { ovUrl } from '../lib/overlay.svelte.js';

  let mode = $state('login'); // 'login' | 'register' | 'token' | 'qr'(扫码登录：网页出码、手机扫)
  let username = $state(''), password = $state(''), password2 = $state(''), invite = $state(''), tok = $state('');
  let busy = $state(false), err = $state('');

  const open = $derived(ui.loginOpen);
  const pillLabel = $derived(me.kind === 'none' ? t('登录') : (me.user || (me.kind === 'admin' ? 'Admin' : t('我'))));

  // —— 几何：pill（右上小胶囊）↔ card（居中大卡，高度按 mode 取）——
  const PILL_H = 40, M = 16, CARD_W = 340;
  const MODE_H = { login: 392, register: 470, token: 300, qr: 452, user: 412, userScan: 470 };
  // 「扫一扫」入口只给手机形态（apk / 触屏）：桌面浏览器拿摄像头对着另一块屏幕扫码不是正常用法。
  const canScan = (() => { try { return isOffline() || matchMedia('(pointer: coarse)').matches; } catch { return false; } })();
  // 注册用户被设了额度时多两行「我的额度」（+58）。
  let mine = $state(null);         // /api/me/usage
  const userExtra = $derived(me.kind === 'user' && hasLimits(mine) ? 58 : 0);
  // 英文比中文多折行（中文恒为 0）：登录页底部两条链接排不下一行、各占一行（+44）；
  // 注册用户卡的「我的 · …」额度行与底部说明各多一行。
  const enExtra = $derived(!isEn() ? 0
    : me.kind !== 'none' ? (me.kind === 'user' ? (hasLimits(mine) ? 52 : 16) : 0)
    : (mode === 'login' && me.features?.register !== false ? 44 : 0));
  const cardH = $derived((me.kind !== 'none'
    ? (canScan ? MODE_H.userScan : MODE_H.user) + userExtra
    : (MODE_H[mode] || 392) + (mode === 'token' && canScan ? 56 : 0)) + enExtra);
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
  // 不再出现 register 卡 470px > 键盘后视口 → 标题被顶出屏外。卡宽同理防窄屏溢出。
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
    ? `${cardGeom} transform:none; clip-path:inset(0px 0px 0px 0px round 30px);`
    : `${cardGeom} transform:translate(${-dx}px,${-dy}px); clip-path:inset(${(effH - PILL_H) / 2}px ${(cardW - pillW) / 2}px round ${PILL_H / 2}px);`);
  const shadowStyle = $derived(open
    ? `${cardGeom} transform:none;`
    : `${cardGeom} transform:translate(${-dx}px,${-dy}px) scale(${pillW / cardW},${PILL_H / effH});`);
  const refractStyle = $derived(open
    ? `transform:translate(${dx}px,${dy}px) scale(${cardW / pillW},${effH / PILL_H}); opacity:0;`
    : `transform:none; opacity:1;`);
  const plabelStyle = $derived(open ? `transform:translate(${dx}px,${dy}px); opacity:0; pointer-events:none;` : `transform:none; opacity:1;`);
  const refractGlass = $derived(bareGlass(22));   // 与四入口图标共用同一材质内核（bare 纯折射），仅圆角不同

  function toggle() { ui.loginOpen = !ui.loginOpen; }
  function close() { ui.loginOpen = false; err = ''; }
  function reset() { username = ''; password = ''; password2 = ''; invite = ''; tok = ''; err = ''; }

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
  function openWorkspace(ev) { openPage('files', { from: ev?.currentTarget || null, radius: 14, onSwitch: close }); }
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
  const fiveH = $derived(lim.five_hour ? Math.round(lim.five_hour.pct || 0) : null);
  const weekly = $derived(lim.seven_day ? Math.round(lim.seven_day.pct || 0) : null);
  const onKey = (e, fn) => { if (e.key === 'Enter') fn(); };
</script>

<!-- 折射玻璃层（pill 玻璃质感；展开时放大淡出） -->
<div class="lc-fade" class:appeared={ui.booted}>
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
<div class="card {open ? 'expanded' : 'pill'}" style={cardStyle}>
  {#if open}
    <div class="content" in:fade={{ duration: 240, delay: 170 }}>
      {#if me.kind !== 'none'}
        <h3>{me.user || 'Admin'}</h3>
        <div class="usage">
          <div class="urow"><span>{t('5 小时额度')}</span><span>{fiveH == null ? '—' : fiveH + '%'}</span></div>
          <div class="urow"><span>{t('本周额度')}</span><span>{weekly == null ? '—' : weekly + '%'}</span></div>
          {#if hasLimits(mine)}
            {#each quotaRows(mine) as r (r.label)}
              <div class="urow"><span>{t('我的 · {label}', { label: r.label })}</span><span class:hot={r.hot}>{r.value}</span></div>
            {/each}
          {/if}
          <p class="uhint">{hasLimits(mine) ? t('上两行为共享订阅用量，「我的」只算 Claude') : t('额度为共享订阅用量')}</p>
        </div>
        <div class="acts">
          <button class="act workspace" onclick={openWorkspace}>
            <img src={ovUrl('assets/icons/workspace.png')} alt="" />
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
          <button class="act primary" onclick={openAccount}>{t('账户')}</button>
          <button class="act ghost" onclick={openSettings}>{t('设置')}</button>
        </div>
      {:else if mode === 'register'}
        <h3>{t('注册')}</h3>
        <p class="reg-note">{t('服主默认只看得到你的会话标题、时间和用量；看内容要你在设置里允许。')}</p>
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
        <p class="qrhint">{t('打开手机上的 The Bridge，在账户卡点「扫一扫」')}</p>
        <div class="acts">
          <button class="act ghost" onclick={() => { mode = 'login'; err = ''; }}>{t('账号密码登录')}</button>
        </div>
      {:else if mode === 'token'}
        <h3>{t('管理员令牌')}</h3>
        {#if err}<div class="err">{err}</div>{/if}
        <input class="lf" placeholder={t('访问令牌')} bind:value={tok} onkeydown={(e) => onKey(e, doToken)} />
        <div class="acts">
          <button class="act primary" onclick={doToken} disabled={busy}>{busy ? t('登录中…') : t('登录')}</button>
          {#if canScan}<button class="act ghost" onclick={scanConnect}>{t('扫码连接')}</button>{/if}
          <button class="act ghost" onclick={() => { picked = true; mode = 'login'; err = ''; }}>{t('返回')}</button>
        </div>
      {:else}
        <h3>{t('欢迎回来')}</h3>
        {#if err}<div class="err">{err}</div>{/if}
        <input class="lf" placeholder={tc('settings', '账号')} bind:value={username} autocomplete="off" />
        <input class="lf" type="password" placeholder={t('密码')} bind:value={password} onkeydown={(e) => onKey(e, doLogin)} />
        <div class="acts">
          <button class="act primary" onclick={doLogin} disabled={busy}>{busy ? t('登录中…') : t('登录')}</button>
          {#if canScan}
            <button class="act ghost" onclick={scanConnect}>{t('扫码连接')}</button>
          {:else}
            <button class="act ghost" onclick={() => { mode = 'qr'; err = ''; }}>{t('扫码登录')}</button>
          {/if}
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
  /* iOS 弹性缓动，与 demo2 一致 */
  .refract, .plabel, .card { transition-timing-function: cubic-bezier(.32, .72, 0, 1); }
  /* 出场动画：随主页露出，整个登录胶囊（玻璃+文字+本体）一起淡入，略晚于入口图标。
     fixed 子元素靠外层 opacity group 一并淡入；外层占满视口、自身不拦事件（子元素各自接管）。 */
  .lc-fade { position: fixed; inset: 0; z-index: 30; pointer-events: none; opacity: 0; transition: opacity var(--mo-base) var(--ea-fade) var(--mo-quick); }
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

  /* 遮罩不再带 backdrop-filter：全屏模糊每帧都要重算整片壁纸，而且垫在卡片那层模糊底下会让它静默失效
     （同屏多层 backdrop 互扰）；2px 的模糊本来也看不出，只留压暗。 */
  .card-bd { position: fixed; inset: 0; z-index: 20; pointer-events: auto; background: rgba(0,0,0,.34); }

  /* 只过渡 transform / clip-path / opacity。模糊半径不做动画：展开时立刻是 34px（此刻整层透明），
     收起时等形变走完再撤（时长 0、延迟 .52s），不然淡出途中毛玻璃会一下子变清。
     旧版是模糊半径与底色一起爬升，现在换成整层淡入淡出：展开淡入比形变快（.3s）、收起淡出放缓
     （.4s 两头缓），中途透出背后清晰壁纸的比例才跟旧版的毛玻璃观感对得上。 */
  .card {
    position: fixed; z-index: 30; pointer-events: none; overflow: hidden; opacity: 0;
    border-radius: 30px; background: rgba(240,243,250,.72); box-shadow: inset 0 1px 1px rgba(255,255,255,.7);
    transition: transform .52s cubic-bezier(.32, .72, 0, 1), clip-path .52s cubic-bezier(.32, .72, 0, 1),
      top .52s cubic-bezier(.32, .72, 0, 1), height .52s cubic-bezier(.32, .72, 0, 1),
      opacity .4s cubic-bezier(.45, 0, .55, 1),
      backdrop-filter 0s linear .52s, -webkit-backdrop-filter 0s linear .52s;
  }
  .card.expanded {
    pointer-events: auto; opacity: 1;
    backdrop-filter: blur(34px) saturate(1.7); -webkit-backdrop-filter: blur(34px) saturate(1.7);
    transition: transform .52s cubic-bezier(.32, .72, 0, 1), clip-path .52s cubic-bezier(.32, .72, 0, 1),
      top .52s cubic-bezier(.32, .72, 0, 1), height .52s cubic-bezier(.32, .72, 0, 1),
      opacity .3s cubic-bezier(.32, .72, 0, 1),
      backdrop-filter 0s, -webkit-backdrop-filter 0s;
  }
  .card-shadow {
    position: fixed; z-index: 29; pointer-events: none; opacity: 0;
    border-radius: 30px; box-shadow: 0 30px 90px rgba(0,0,0,.4); transform-origin: center center;
    transition-property: transform, opacity, top, height; transition-duration: .52s;
    transition-timing-function: cubic-bezier(.32, .72, 0, 1);
  }
  .card-shadow.expanded { opacity: 1; }

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
  .reg-note { margin: -2px 0 2px; font-size: 12.5px; line-height: 1.5; opacity: .7; }
  .usage { display: flex; flex-direction: column; gap: 9px; margin: 4px 0 2px; }
  .urow { display: flex; justify-content: space-between; font-size: 15px; color: #2a2d34; }
  .urow span:last-child { font-weight: 700; }
  /* 英文「Your usage · Last 7 days」与「3 / 20 turns · $0.52 / $2.00」一行放不下：留缝、数值折行右对齐 */
  :global(html[lang='en']) .urow { gap: 10px; }
  :global(html[lang='en']) .urow span:last-child { text-align: right; }
  .uhint { font-size: 12px; color: #82858d; margin-top: 2px; }
  .urow span.hot { color: #d9453a; }
</style>
