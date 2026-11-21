<script>
  // 设置的根页（账户卡、Agent / 服务器 / 偏好 / 这台设备分组、反馈与关于）及从它直达的账户、关于、版本历史（iOS 外壳）。
  // 状态都在外壳创建的控制器里（./ctx.js 的 useSettings），这里只画页面；样式是同一套 kit.css。
  import { useSettings, svgOf } from './ctx.js';
  import ConnectQr from '../../pairing/ConnectQr.svelte';
  import Sym from '../../ios27/Sym.svelte';
  import TextField from '../../ios27/TextField.svelte';
  import Toggle from '../../ios27/Toggle.svelte';
  import { DISTRO } from '../../../lib/distro.js';
  import { accessDisclosure, accessItems, logLine } from '../../../lib/adminAccess.js';
  import { ags } from '../../../lib/agentSettings.svelte.js';
  import { canSwitchServers } from '../../../lib/serverProfiles.js';
  import { costNote, hasLimits, quotaRows } from '../../../lib/me.js';
  import { extAuth, startExtLogin } from '../../../lib/authProviders.svelte.js';
  import { isOffline } from '../../../lib/server.js';
  import { me, pluginOn, prefs, status, ui } from '../../../lib/state.svelte.js';
  import { openInstallPermission } from '../../../lib/appUpdate.js';
  import { panelTitle, pluginPanels } from '../../../lib/pluginPanels.svelte.js';
  import { t, tc, tr } from '../../../lib/i18n.js';
  import { updateInfo } from '../../../lib/updateStore.svelte.js';

  let { pid } = $props();
  const S = useSettings();
  const { about, acc, ag, dev, fb, nav, phone, up } = S;

  // 应用图标：满版方图（apple-touch-icon），iOS 图标形状由平滑圆角遮罩给
  const appIcon = import.meta.env.BASE_URL + 'icons/apple-touch-icon.png';
</script>
{#snippet chev()}<Sym name="chevron.right" weight={600} size={13} class="chev" />{/snippet}
{#snippet check()}<Sym name="checkmark" weight={600} size={15} class="ck" />{/snippet}
<!-- 行首图标：中性底方格里一枚线稿（不上色块）；agent 行放各自的真品牌标 -->
{#snippet ico(name)}<span class="ri" aria-hidden="true">{@html svgOf(name)}</span>{/snippet}
{#snippet agMark(id)}<span class="ri brand" aria-hidden="true">{#if ag.markSrc(id)}<img src={ag.markSrc(id)} alt="" draggable="false" />{:else}{@html svgOf('orb')}{/if}</span>{/snippet}
{#snippet gfoot(text)}<p class="gfoot">{text}</p>{/snippet}
<!-- 这台设备上保存着登录的账号：点一下切换；当前这个打勾；别的号右边 × 从这台设备移除（顺手在服务端退出那张会话） -->
{#snippet acctRows()}
  {#each acc.accts as a (a.key)}
    <div class="r recent" class:sel={a.current}>
      <button class="rc-pick" type="button" onclick={() => acc.doSwitch(a)} disabled={a.current || !!acc.switching}>
        <span class="av sm" aria-hidden="true">{(a.user || '?').charAt(0).toUpperCase()}</span>
        <span class="r-main"><span class="r-tx">{a.user}<span class="r-sub">{a.kind === 'admin' ? t('管理员') : a.tier === 'pro' ? t('完全信任用户') : t('普通用户')}</span></span>
          {#if acc.switching === a.key}<span class="r-d">{t('切换中…')}</span>{/if}</span>
      </button>
      {#if a.current}
        <span class="rc-x" aria-label={t('当前账号')}>{@render check()}</span>
      {:else}
        <button class="rc-x" type="button" onclick={() => acc.dropAcct(a)} disabled={!!acc.switching} aria-label={t('从这台设备移除 {name}', { name: a.user })}><Sym name="xmark" weight={500} size={13} /></button>
      {/if}
    </div>
  {/each}
{/snippet}
{#snippet ghead(text)}<h2 class="ghead">{text}</h2>{/snippet}
<!-- 「软件更新」行：根页（带行首图标）与「关于 › 更新」组（组里其余行都没图标，这里也不带）共用一份，
     状态（检查中 / 下载进度环 / 一键更新）是同一个 up.upState，两处看到的永远一致 -->
{#snippet upRow(withIco)}
  <button class="r upr" type="button" onclick={up.onUpClick} disabled={up.upState === 'downloading' || up.upState === 'checking'}>
    {#if withIco}{@render ico('update')}{/if}
    <span class="r-main">
      <span class="r-tx">{t('软件更新')}</span>
      {#if up.upState === 'downloading'}
        <span class="r-d num">{Math.round(up.progress * 100)}%</span><span class="ring" style:--p="{Math.round(up.progress * 360)}deg"></span>
      {:else if up.upState === 'checking'}
        <span class="r-d">{up.upDetail}</span><span class="spin" aria-hidden="true"></span>
      {:else}
        <span class="r-d" class:accent={up.upState === 'installable'} class:err={up.upState === 'error'}>{#if up.upState === 'installable'}<span class="new-dot" aria-hidden="true"></span>{/if}{up.upDetail}</span>
        {@render chev()}
      {/if}
    </span>
  </button>
{/snippet}

{#snippet statusTail(ok)}
  {#if ok}<Sym name="checkmark.circle.fill" weight={400} size={20} class="okmark" />{:else}{@render chev()}{/if}
{/snippet}

<!-- ─────────────── 各页内容 ─────────────── -->
{#snippet avatar(big)}
  <span class="av" class:big class:none={me.kind === 'none'} aria-hidden="true">
    {#if me.kind === 'none'}
      <svg viewBox="0 0 24 24"><circle cx="12" cy="9" r="4.2" fill="currentColor" /><path d="M3.8 21.2c.9-4 4.2-6.4 8.2-6.4s7.3 2.4 8.2 6.4" fill="currentColor" /></svg>
    {:else}{acc.initial}{/if}
  </span>
{/snippet}

{#snippet pRoot()}
  <div class="ig">
    <button class="r acctcard" class:on={nav.cur === 'account'} type="button" onclick={() => nav.go('account')}>
      {@render avatar(false)}
      <span class="r-main">
        {#if me.kind === 'none'}
          <span class="r-tx"><span class="acct-title">{t('登录')}</span><span class="r-sub">{t('登录后使用对话、工作空间与用量')}</span></span>
        {:else}
          <span class="r-tx"><span class="acct-title">{acc.shownName}</span><span class="r-sub">{acc.roleLabel}{status.plan ? ' · ' + status.plan : ''}</span></span>
        {/if}
        {@render chev()}
      </span>
    </button>
  </div>

  <!-- Agent：每个 agent 一行、各自一页（开关与认证 + 它自己的设置） -->
  {@render ghead(tc('settings', 'Agent'))}
  <div class="ig">
    {#each ag.agentRows as a (a.id)}
      <button class="r" class:on={nav.cur === (a.id === 'studio' ? 'studio' : 'ag-' + a.id)} type="button" onclick={() => nav.go(a.id === 'studio' ? 'studio' : 'ag-' + a.id)}>
        {@render agMark(a.id)}
        <span class="r-main" class:dim={!a.local && !a.enabled}><span class="r-tx">{a.label}</span><span class="r-d" class:warn={!a.local && a.enabled && !a.authed && a.id !== 'studio'}>{ag.agTail(a)}</span>{@render chev()}</span>
      </button>
    {/each}
    <!-- 模型中心：模型从哪来、分给哪些 agent，一处管——排在各 agent 之后、「Agent 接入」之前（同桌面设置的侧栏）。
         管理员看总览，能自定义 API 的成员看自己那份；两份数据都没有就不出这一行 -->
    {#if S.hub.on}
      <button class="r" class:on={nav.cur === 'model-hub'} type="button" onclick={() => nav.go('model-hub')}>
        {@render ico('modelhub')}
        <span class="r-main"><span class="r-tx">{t('模型中心')}</span>{@render chev()}</span>
      </button>
    {/if}
    {#if dev.hasDevices && pluginOn('agent-api')}
      <button class="r" class:on={nav.cur === 'agentapi'} type="button" onclick={() => nav.go('agentapi')}>
        {@render ico('agentapi')}
        <span class="r-main"><span class="r-tx">{t('Agent 接入')}</span>{@render chev()}</span>
      </button>
    {/if}
  </div>

  {#if pluginPanels.list.length}
    {@render ghead(t('插件'))}
    <div class="ig">
      {#each pluginPanels.list as pp (pp.id)}
        <button class="r" class:on={nav.cur === 'plg-' + pp.id} type="button" onclick={() => nav.openPlg(pp)}>
          {@render ico('extensions')}
          <span class="r-main"><span class="r-tx">{panelTitle(pp)}</span>{@render chev()}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if S.ext.ok || (ags.policyOk && ags.multiUser) || S.srvAdmin.ok}
    {@render ghead(S.ext.member ? t('个性化') : t('服务器'))}
    <div class="ig">
      {#if S.ext.ok}
        <button class="r" class:on={nav.cur === 'extensions'} type="button" onclick={() => nav.go('extensions')}>
          {@render ico('extensions')}
          <span class="r-main"><span class="r-tx">{t('扩展')}</span>{#if me.pluginUpdates}<span class="r-d accent">{t('{n} 个插件有更新', { n: me.pluginUpdates })}</span>{/if}{@render chev()}</span>
        </button>
      {/if}
      {#if ags.policyOk && ags.multiUser}
        <button class="r" class:on={nav.cur === 'policy'} type="button" onclick={() => nav.go('policy')}>
          {@render ico('policy')}
          <span class="r-main"><span class="r-tx">{t('额度与注册')}</span><span class="r-d">{ags.regOpen ? t('开放注册') : t('注册已关')}</span>{@render chev()}</span>
        </button>
      {/if}
      {#if S.srvAdmin.ok}
        <button class="r" type="button" onclick={() => { ui.serverAdminOpen = true; }}>
          {@render ico('server')}
          <span class="r-main"><span class="r-tx">{t('服务端控制台')}</span><span class="live-dot" aria-hidden="true"></span>{@render chev()}</span>
        </button>
      {/if}
    </div>
  {/if}

  {@render ghead(t('偏好'))}
  <div class="ig">
    <button class="r" class:on={nav.cur === 'general'} type="button" onclick={() => nav.go('general')}>
      {@render ico('general')}
      <span class="r-main"><span class="r-tx">{t('通用')}</span>{@render chev()}</span>
    </button>
    <button class="r" class:on={nav.cur === 'appearance'} type="button" onclick={() => nav.go('appearance')}>
      {@render ico('appearance')}
      <span class="r-main"><span class="r-tx">{t('外观')}</span><span class="r-d">{prefs.followSys ? t('自动') : S.dark ? t('深色') : t('明亮')}</span>{@render chev()}</span>
    </button>
    <!-- 主页上摆哪些入口、什么顺序（只存这台设备）。单页模式没有主页，不给这一行 -->
    {#if !S.single}
      <button class="r" class:on={nav.cur === 'home'} type="button" onclick={() => nav.go('home')}>
        {@render ico('home')}
        <span class="r-main"><span class="r-tx">{t('主页')}</span>{@render chev()}</span>
      </button>
    {/if}
    <!-- 插件页面拿到的权限（跟人走：主机、成员各管各的；单页模式也有） -->
    {#if me.kind !== 'none'}
      <button class="r" class:on={nav.cur === 'page-grants'} type="button" onclick={() => nav.go('page-grants')}>
        {@render ico('page-grants')}
        <span class="r-main"><span class="r-tx">{t('页面权限')}</span>{@render chev()}</span>
      </button>
    {/if}
    {#if !S.single && pluginOn('wallpapers')}
      <button class="r" class:on={nav.cur === 'wallpaper'} type="button" onclick={() => nav.go('wallpaper')}>
        {@render ico('wallpaper')}
        <span class="r-main"><span class="r-tx">{t('壁纸')}</span>{@render chev()}</span>
      </button>
    {/if}
    {#if ui.glassMode === 'A' && !S.single}
      <button class="r" class:on={nav.cur === 'flux'} type="button" onclick={() => nav.go('flux')}>
        {@render ico('flux')}
        <span class="r-main"><span class="r-tx">{t('流体壁纸')}</span>{@render chev()}</span>
      </button>
    {/if}
  </div>

  {#if dev.phoneRow || dev.devRow}
    <!-- 小标题只给「手机操控」那种这台机器自己的能力；只剩账号级的「设备」一行时不挂标题 -->
    {#if dev.phoneRow}{@render ghead(t('这台设备'))}{/if}
    <div class="ig">
      {#if dev.phoneRow}
        <button class="r" class:on={nav.cur === 'phone'} type="button" onclick={() => nav.go('phone')}>
          {@render ico('phone')}
          <span class="r-main"><span class="r-tx">{t('手机操控')}</span><span class="r-d">{phone.phoneCtrlOn ? tc('开关', '打开') : tc('开关', '关闭')}</span>{@render chev()}</span>
        </button>
      {/if}
      {#if dev.devRow}
        <button class="r" class:on={nav.cur === 'devices'} type="button" onclick={dev.openDevices}>
          {@render ico('localpc')}
          <span class="r-main"><span class="r-tx">{t('设备')}</span><span class="r-d">{dev.dvOnline ? t('{n} 台在线', { n: dev.dvOnline }) : ''}</span>{@render chev()}</span>
        </button>
      {/if}
    </div>
  {/if}

  <div class="ig">
    <!-- 软件更新只给安卓壳：网页的界面就是服务器发的，刷新即最新（「关于」页里说明）；
         10-21 回归 FR7：以前网页上点这一行会把带令牌的 APK 下载地址交给浏览器 -->
    {#if S.plat !== 'web'}{@render upRow(true)}{/if}
    {#if pluginOn('feedback')}
    <button class="r" type="button" onclick={fb.openFeedback}>
      {@render ico('feedback')}
      <span class="r-main"><span class="r-tx">{t('提交反馈')}</span>{@render chev()}</span>
    </button>
    {/if}
    <button class="r" class:on={nav.cur === 'about'} type="button" onclick={() => nav.go('about')}>
      {@render ico('about')}
      <span class="r-main"><span class="r-tx">{t('关于')}</span><span class="r-d num">{up.verShort}</span>{@render chev()}</span>
    </button>
  </div>
{/snippet}

{#snippet pAbout()}
  <div class="hero">
    <img class="about-icon" src={appIcon} alt="" draggable="false" />
    <div class="hero-name">{DISTRO.brand}</div>
    <div class="hero-sub num">{up.verShort}</div>
  </div>
  <div class="ig">
    <button class="r" type="button" onclick={about.openAddr}>
      <span class="r-main"><span class="r-tx">{t('服务器地址')}</span><span class="r-d addr">{about.serverHost}</span>{@render chev()}</span>
    </button>
    {#if canSwitchServers()}
      <!-- 多服务器档案：在存过的几台服务器之间切换、添加新的（lib/serverProfiles.js） -->
      <button class="r" type="button" onclick={() => { ui.serverSwitcherOpen = true; }}>
        <span class="r-main"><span class="r-tx">{t('切换服务器')}</span><span class="r-d">{about.srvSummary}</span>{@render chev()}</span>
      </button>
    {/if}
    {#if isOffline()}
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('当前线路')}</span><span class="r-d"><span class="conn-dot {ui.connMode}"></span>{ui.connMode === 'lan' ? t('局域网直连') : t('Cloudflare 隧道')}</span></span>
      </div>
      <!-- 扫码连接（S1-2）：扫电脑上的配对二维码，换到那台服务器、并以出码的身份登录 -->
      <button class="r" type="button" onclick={() => { ui.pairScan = { mode: 'connect' }; }}>
        <span class="r-main"><span class="r-tx">{t('扫码连接服务器')}</span>{@render chev()}</span>
      </button>
    {/if}
    {#if me.kind !== 'none'}
      <!-- 出示配对码（S1-2）：让另一台手机 / 平板扫码连上这台服务器，并以你现在的身份登录。点开才出码 -->
      <button class="r" type="button" onclick={() => { about.connectOpen = !about.connectOpen; }}>
        <span class="r-main"><span class="r-tx">{t('让另一台设备扫码连接')}</span><span class="r-d accent">{about.connectOpen ? t('收起') : t('显示二维码')}</span></span>
      </button>
    {/if}
  </div>
  {#if about.connectOpen && me.kind !== 'none'}
    <div class="ig"><ConnectQr compact via="settings" /></div>
    {@render gfoot(t('只给你自己的设备扫：扫到的人会以你的身份登录。3 分钟内有效，只能用一次。'))}
  {/if}

  <!-- 服务器那头（要登录才拿得到）：出门在外用的公网地址、后端跑了多久 -->
  {#if about.srvInfo}
    {@render ghead(t('服务器'))}
    <div class="ig">
      {#if about.srvInfo.publicOrigin}
        <button class="r" type="button" onclick={about.copyPublic}>
          <span class="r-main"><span class="r-tx">{t('公网地址')}</span><span class="r-d addr sel">{about.srvInfo.publicOrigin.replace(/^https?:\/\//, '')}</span><span class="r-d accent">{about.pubCopied ? t('已复制') : t('复制')}</span></span>
        </button>
        {#if about.srvInfo.address?.kind}
          <div class="r">
            <span class="r-main"><span class="r-tx">{t('地址类型')}</span><span class="r-d">{about.srvInfo.address.kind === 'temporary' ? t('临时地址（重启会换）') : t('固定地址')}</span></span>
          </div>
        {/if}
      {/if}
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('后端')}{#if about.srvInfo.server?.node}<span class="r-sub">Node {about.srvInfo.server.node.replace(/^v/, '')}</span>{/if}</span><span class="r-d num">{t('已运行 {t}', { t: about.fmtUptime(about.srvInfo.server?.uptimeSec) })}</span></span>
      </div>
    </div>
    {#if about.srvInfo.address?.kind === 'temporary'}
      {@render gfoot(t('服务器用的是临时地址：电脑或服务重启后会换一个。App 会自动跟过去——在线时立即收到新地址，离线时回家连上同一个 Wi-Fi 就会更新。长期使用建议在服务器上绑定自己的域名。'))}
    {/if}
  {/if}

  <!-- 服务端更新（管理员）：查 GitHub 发布仓库上的版本，按部署形态一键更新服务端（lib/serverUpdate.svelte.js）。
       整行就是动作：「一键更新」「检查更新」「检查并更新」；没有能做的动作时行不可点，脚注说怎么更新 -->
  {#if about.srvUpd.st && about.srvUpdView}
    {@render ghead(t('服务端更新'))}
    <div class="ig">
      {#snippet srvUpdMain()}
        <span class="r-main">
          <span class="r-tx">{t('服务端版本')}<span class="r-sub" class:warn={about.srvUpdView.tone === 'warn'}>{about.srvUpdView.sub}</span></span>
          {#if about.srvUpd.busy || about.srvUpd.loading}<span class="spin" aria-hidden="true"></span>
          {:else if about.srvUpdView.action}<span class="r-d accent">{#if about.srvUpdView.action === 'update'}<span class="new-dot" aria-hidden="true"></span>{/if}{about.srvUpdView.label}</span>{/if}
        </span>
      {/snippet}
      <!-- 没有能做的动作（正在装 / 等对话跑完 / 这种部署形态只能手动）时是纯状态行，不摆成一个点了没反应的按钮 -->
      {#if about.srvUpdView.action}
        <button class="r" type="button" disabled={about.srvUpd.busy || about.srvUpd.loading} onclick={() => about.srvUpd.act(about.srvUpdView.action)}>{@render srvUpdMain()}</button>
      {:else}
        <div class="r">{@render srvUpdMain()}</div>
      {/if}
      {#if about.srvUpd.st.newer && about.srvUpd.st.page}
        <a class="r" href={about.srvUpd.st.page} target="_blank" rel="noopener noreferrer">
          <span class="r-main"><span class="r-tx">{t('新版本说明')}</span>{@render chev()}</span>
        </a>
      {/if}
    </div>
    {#if about.srvUpd.err}{@render gfoot(about.srvUpd.err)}{:else if about.srvUpd.note}{@render gfoot(about.srvUpd.note)}{:else if about.srvUpdView.how}{@render gfoot(about.srvUpdView.how)}{/if}
  {/if}

  <!-- 下载 App（网页，已登录）：一键下载这台服务器发的桌面客户端与安卓 App。没有可发的包时给发布页（推得出来才有） -->
  {#if S.plat === 'web' && me.kind !== 'none' && about.deskDl}
    {@render ghead(t('下载 App'))}
    <div class="ig">
      {#if about.deskDl.loading}
        <div class="r"><span class="r-main"><span class="r-tx">{t('Windows 桌面客户端')}</span><span class="spin" aria-hidden="true"></span></span></div>
      {:else if about.deskDl.available}
        <a class="r" href={about.withTok(about.deskDl.url || '/download/windows')} download>
          <span class="r-main"><span class="r-tx">{t('Windows 桌面客户端')}<span class="r-sub">{'v' + about.deskDl.version + about.mb(about.deskDl.size)}</span></span><span class="r-d accent">{t('下载')}</span></span>
        </a>
      {:else}
        <svelte:element this={about.deskDl.page ? 'a' : 'div'} class="r" href={about.deskDl.page || undefined} target={about.deskDl.page ? '_blank' : undefined} rel={about.deskDl.page ? 'noopener noreferrer' : undefined}>
          <span class="r-main"><span class="r-tx">{t('Windows 桌面客户端')}<span class="r-sub">{about.deskDl.failed ? t('暂时查不到') : t('这台服务器没有可发的版本')}</span></span>{#if about.deskDl.page}<span class="r-d accent">{t('去发布页')}</span>{/if}</span>
        </svelte:element>
      {/if}
      {#if about.upLatest && about.upLatest.available !== false}
        <a class="r" href={about.withTok(about.upLatest.pageUrl || '/download/android')} download>
          <span class="r-main"><span class="r-tx">{t('安卓 App')}<span class="r-sub">{'v' + t('{name}（{code}）', { name: about.upLatest.name, code: about.upLatest.code }) + about.mb(about.upLatest.size)}</span></span><span class="r-d accent">{t('下载')}</span></span>
        </a>
      {:else if about.upLatest}
        <svelte:element this={about.upLatest.releasePage ? 'a' : 'div'} class="r" href={about.upLatest.releasePage || undefined} target={about.upLatest.releasePage ? '_blank' : undefined} rel={about.upLatest.releasePage ? 'noopener noreferrer' : undefined}>
          <span class="r-main"><span class="r-tx">{t('安卓 App')}<span class="r-sub">{t('这台服务器没有可发的版本')}</span></span>{#if about.upLatest.releasePage}<span class="r-d accent">{t('去发布页')}</span>{/if}</span>
        </svelte:element>
      {/if}
    </div>
    {@render gfoot(about.dlFoot)}
  {/if}

  <!-- 更新：安卓壳是装包；网页的界面就是服务器发的，刷新即最新。
       「软件更新」这一行与根页共用：侧栏「关于与更新」直达的是这一页，有新版时在这里就能下载、装上，不用退回根页找 -->
  {#if S.plat === 'android'}
    {@render ghead(tc('settings', '更新'))}
    <div class="ig">
      {@render upRow(false)}
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('自动检查更新')}</span><Toggle checked={about.autoUp} onchange={about.toggleAutoUp} label={t('自动检查更新')} /></span>
      </div>
      {#if about.appInfo && typeof about.appInfo.canInstall === 'boolean'}
        <button class="r" type="button" onclick={() => { if (!about.appInfo.canInstall) openInstallPermission(); }}>
          <span class="r-main"><span class="r-tx">{t('安装权限')}</span>{#if !about.appInfo.canInstall}<span class="r-d warn">{t('未开启')}</span>{/if}{@render statusTail(about.appInfo.canInstall)}</span>
        </button>
      {/if}
      {#if up.upState === 'downloading' || up.upState === 'installable'}
        <button class="r" type="button" onclick={up.discardUpdate}>
          <span class="r-main center"><span class="r-tx red">{up.upState === 'downloading' ? t('取消下载') : t('丢弃已下载的新版本')}</span></span>
        </button>
      {/if}
      <!-- 服务器没有包：给发布页（服务器配了 / 推得出来才有）；App 只认所连这台服务器发的包，不自己去别处找 -->
      {#if updateInfo.noBuild && about.upLatest?.releasePage}
        <a class="r" href={about.upLatest.releasePage} target="_blank" rel="noopener noreferrer">
          <span class="r-main"><span class="r-tx">{t('去发布页下载')}</span>{@render chev()}</span>
        </a>
      {/if}
    </div>
    {#if about.aboutFoot}{@render gfoot(about.aboutFoot)}{/if}
    {#if updateInfo.blocked && updateInfo.blockedReason === 'package'}
      {@render gfoot(t('服务器上的这一版是另一个包名的 App（来自另一个发行渠道，或是自己编译的），装上会是另一个 App，不能用来更新这一个。要换用它，装好新的再卸载这个（本机缓存的聊天会清空，服务器上的数据不受影响）。'))}
    {:else if updateInfo.blocked}
      {@render gfoot(t('服务器上的这一版和手机上的 App 签名不同（来自另一个发行渠道，或是自己编译的），不能覆盖安装。要换用它，先卸载手机上的 App 再装（本机缓存的聊天会清空，服务器上的数据不受影响）。'))}
    {:else if updateInfo.noBuild}
      {@render gfoot(t('这台服务器没有可发的 App 版本：手机 App 由你连着的服务器自己发，服务器那头放上安装包后这里就能更新。'))}
    {:else if updateInfo.appNewer}
      {@render gfoot(t('手机上的 App 比服务器新：照常能用，个别新功能要等服务器更新后才有。'))}
    {/if}
    {#if about.newerNotes}
      {@render ghead(t('新版本说明'))}
      <div class="ig notes">
        <div class="n-h">{t('{name}（{code}）', { name: about.newerNotes.name, code: about.newerNotes.code })}{#if about.newerNotes.size}<span class="n-s">{(about.newerNotes.size / 1048576).toFixed(1)} MB</span>{/if}</div>
        <p class="n-b">{tr(about.newerNotes.notes)}</p>
      </div>
    {/if}
  {:else}
    <div class="ig">
      <div class="r"><span class="r-main"><span class="r-tx">{t('网页版总是最新的')}</span>{@render statusTail(true)}</span></div>
    </div>
    {@render gfoot(about.upLatest ? t('界面由服务器直接提供，刷新页面即是服务器上的版本（{version}）。', { version: about.upLatest.name }) : t('界面由服务器直接提供，刷新页面即是最新。'))}
  {/if}

  {#if about.upHistory.length}
    <div class="ig">
      <button class="r" type="button" onclick={() => nav.push('history')}>
        <span class="r-main"><span class="r-tx">{t('版本历史')}</span><span class="r-d num">{about.upLatest?.name || ''}</span>{@render chev()}</span>
      </button>
    </div>
  {/if}

  <!-- 这台手机（安卓壳才有）：系统、机型、首次安装与最近更新 -->
  {#if S.plat === 'android' && about.appInfo && about.appInfo.release}
    {@render ghead(t('设备'))}
    <div class="ig">
      <div class="r"><span class="r-main"><span class="r-tx">{t('系统')}</span><span class="r-d">{t('Android {release}（SDK {sdk}）', { release: about.appInfo.release, sdk: about.appInfo.sdk })}</span></span></div>
      {#if about.appInfo.model}<div class="r"><span class="r-main"><span class="r-tx">{t('机型')}</span><span class="r-d">{[about.appInfo.brand, about.appInfo.model].filter(Boolean).join(' ')}</span></span></div>{/if}
      {#if about.appInfo.firstInstall}<div class="r"><span class="r-main"><span class="r-tx">{t('首次安装')}</span><span class="r-d num">{about.fmtDay(about.appInfo.firstInstall)}</span></span></div>{/if}
      {#if about.appInfo.lastUpdate && about.appInfo.lastUpdate !== about.appInfo.firstInstall}<div class="r"><span class="r-main"><span class="r-tx">{t('最近更新')}</span><span class="r-d num">{about.fmtDay(about.appInfo.lastUpdate)}</span></span></div>{/if}
    </div>
  {/if}
{/snippet}

<!-- 版本历史（服务器上发过的每一版与说明；装着的那一版、最新那一版各打一个签） -->
{#snippet pHistory()}
  <div class="ig">
    {#each about.upHistory as h (h.code)}
      <div class="r hist">
        <span class="r-main">
          <span class="r-tx">
            <span class="r-lbl">{h.name}<span class="h-c">{t('（{code}）', { code: h.code })}</span>
              {#if S.plat === 'android' && h.code === about.installedCode}<span class="pill">{t('当前')}</span>{/if}
              {#if h.code === about.upLatest?.code && (S.plat !== 'android' || h.code !== about.installedCode)}<span class="pill">{t('最新')}</span>{/if}
            </span>
            {#if h.notes}<span class="r-sub">{tr(h.notes)}</span>{/if}
          </span>
          <span class="r-d num">{h.date}</span>
        </span>
      </div>
    {/each}
  </div>
{/snippet}

{#snippet pAccount()}
  {#if me.kind !== 'none'}
    <div class="hero">
      {@render avatar(true)}
      <div class="hero-name">{acc.shownName}</div>
      <div class="hero-sub">{acc.roleLabel}{status.plan ? ' · ' + status.plan : ''}</div>
    </div>

    {@render ghead(t('用量'))}
    <div class="ig usage">
      <!-- 没有 5 小时限额的号（部分 Ultra）不摆空的 5 小时条，只留本周 -->
      {#each [...(status.noFiveHour && !acc.lim.five_hour ? [] : [[t('当前会话（5 小时）'), acc.usePct(acc.lim.five_hour), acc.lim.five_hour]]), [t('本周'), acc.usePct(acc.lim.seven_day), acc.lim.seven_day]] as [name, p, b] (name)}
        <div class="u">
          <div class="u-top"><span class="u-l">{name}</span><span class="u-v">{p == null ? '—' : t('{pct}% 已用', { pct: p })}</span></div>
          <span class="bar-u">{#if p != null}<i style:width="{p}%" class:hot={p >= 80}></i>{/if}</span>
          {#if acc.resetIn(b)}<span class="u-r">{acc.resetIn(b)}</span>{/if}
        </div>
      {/each}
    </div>

    {#if me.kind === 'user'}
      {@render ghead(t('我的额度'))}
      <div class="ig">
        {#if acc.mine && hasLimits(acc.mine)}
          {#each quotaRows(acc.mine) as r (r.label)}
            <div class="r"><span class="r-main"><span class="r-tx">{r.label}</span><span class="r-d" class:err={r.hot}>{r.value}</span></span></div>
          {/each}
        {:else}
          <div class="r"><span class="r-main"><span class="r-tx">{acc.mine ? t('不限') : t('读取中…')}</span></span></div>
        {/if}
      </div>
      <!-- 额度里的美元按 API 价估算（S2-6：共用订阅号池时不是真花出去的钱） -->
      {#if acc.mine && hasLimits(acc.mine)}{@render gfoot(costNote())}{/if}
      {#if acc.aa}
        {@render ghead(t('管理员可见性'))}
        <div class="ig">
          {#each accessItems() as it (it.key)}
            <div class="r"><span class="r-main"><span class="r-tx">{it.title}<span class="r-sub">{it.sub}</span></span>
              <Toggle checked={!!acc.aa.consents[it.key]} onchange={() => acc.toggleAa(it.key)} label={it.title} /></span></div>
          {/each}
        </div>
        {@render gfoot(accessDisclosure())}
        {#if acc.aa.log?.length}
          {@render ghead(t('管理员的访问记录'))}
          <div class="ig">
            {#each acc.aa.log.slice(0, 10) as e, i (e.at + e.action + i)}
              <div class="r"><span class="r-main"><span class="r-tx">{logLine(e)}<span class="r-sub">{new Date(e.at).toLocaleString()}</span></span></span></div>
            {/each}
          </div>
        {/if}
      {/if}
    {/if}

    <div class="ig">
      <button class="r" type="button" onclick={acc.openWorkspaceFromAcct}>
        <span class="r-main"><span class="r-tx">{t('工作空间')}</span>{@render chev()}</span>
      </button>
      {#if acc.canScan}
        <button class="r" type="button" onclick={acc.openScanFromAcct}>
          <span class="r-main"><span class="r-tx">{t('扫一扫 · 登录网页版')}</span>{@render chev()}</span>
        </button>
      {/if}
      {#if me.kind === 'user'}
        <button class="r" type="button" onclick={() => { acc.pwDone = false; acc.pw = { old: '', next: '', again: '', busy: false, err: '' }; }}>
          <span class="r-main"><span class="r-tx">{t('修改密码')}{#if acc.pwDone}<span class="r-sub">{t('已改好。别的设备要用新密码重新登录，这台不受影响。')}</span>{/if}</span>{@render chev()}</span>
        </button>
      {/if}
    </div>

    {@render ghead(t('切换账号'))}
    <div class="ig">
      {@render acctRows()}
      <button class="r" type="button" onclick={acc.addSignIn} disabled={!!acc.switching}>
        <span class="r-main"><span class="r-tx accent">{t('添加账号')}</span></span>
      </button>
    </div>
    {@render gfoot(acc.acctErr || t('这台设备上登录过的账号会留着登录，点一下直接切换，不用重新输入密码。'))}

    <div class="ig">
      <button class="r" type="button" onclick={() => (acc.acctAsk = 'logout')}>
        <span class="r-main center"><span class="r-tx red">{t('退出登录')}</span></span>
      </button>
    </div>
  {:else}
    <div class="hero">
      {@render avatar(true)}
      <div class="hero-name">{acc.lgMode === 'register' ? t('注册新账号') : acc.lgMode === 'token' ? t('管理员令牌') : acc.lgMode === 'qr' ? t('扫码登录') : t('登录 The Bridge')}</div>
      <div class="hero-sub">{acc.lgMode === 'register' ? t('需要邀请码；注册即登录。') + ' ' + t('服主默认只看得到你的会话标题、时间和用量；看内容要你在设置里允许。') : acc.lgMode === 'token' ? t('粘贴服务端的访问令牌，以管理员身份直连。') : acc.lgMode === 'qr' ? t('打开手机上的 The Bridge，在设置 › 账户点「扫一扫」') : t('登录后使用对话、工作空间与用量')}</div>
    </div>

    {#if acc.lgMode === 'qr'}
      <div class="ig qr-card">
        <div class="qrbox" class:dim={acc.pair.status !== 'pending'}>
          {#if acc.pair.svg}{@html acc.pair.svg}{/if}
          {#if acc.pair.status !== 'pending'}
            <button class="qrov" type="button" onclick={() => acc.pairCtl?.refresh()}
              disabled={acc.pair.status === 'loading' || acc.pair.status === 'idle' || acc.pair.status === 'approved' || acc.pair.status === 'scanned'}>{acc.pairMsg}</button>
          {/if}
        </div>
      </div>
      <div class="ig">
        <button class="r" type="button" onclick={() => acc.lgSwitch('login')}><span class="r-main center"><span class="r-tx accent">{t('账号密码登录')}</span></span></button>
      </div>
    {:else}
      {#if acc.lgMode === 'login' && acc.accts.length}
        {@render ghead(t('这台设备上的账号'))}
        <div class="ig">{@render acctRows()}</div>
        {#if acc.acctErr}{@render gfoot(acc.acctErr)}{/if}
      {/if}
      {#if acc.lgMode === 'login' && acc.recentsShown.length}
        {@render ghead(t('最近登录'))}
        <div class="ig">
          {#each acc.recentsShown as name (name)}
            <div class="r recent" class:sel={acc.lgUser === name}>
              <button class="rc-pick" type="button" onclick={() => acc.pickRecent(name)}>
                <span class="av sm" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
                <span class="r-main"><span class="r-tx">{name}</span>{#if acc.lgUser === name}{@render check()}{/if}</span>
              </button>
              <button class="rc-x" type="button" onclick={() => acc.dropRecent(name)} aria-label={t('从列表移除 {name}', { name })}><Sym name="xmark" weight={500} size={13} /></button>
            </div>
          {/each}
        </div>
      {/if}
      <form class="lg-form" onsubmit={acc.lgSubmit}>
        {#if acc.lgMode === 'token'}
          <TextField bind:value={acc.lgTok} type="password" placeholder={t('访问令牌')} autocomplete="off" autocapitalize="off" spellcheck="false" />
        {:else}
          <TextField bind:value={acc.lgUser} placeholder={acc.lgMode === 'register' ? t('账号（2–32 位字母/数字/_/-）') : tc('settings', '账号')} autocomplete="username" autocapitalize="off" autocorrect="off" spellcheck="false" />
          <div class="lg-pass"><TextField bind:value={acc.lgPass} type="password" placeholder={acc.lgMode === 'register' ? t('密码（至少 8 位）') : t('密码')} autocomplete={acc.lgMode === 'register' ? 'new-password' : 'current-password'} /></div>
          {#if acc.lgMode === 'register'}
            <TextField bind:value={acc.lgPass2} type="password" placeholder={t('确认密码')} autocomplete="new-password" />
            <TextField bind:value={acc.lgInvite} placeholder={t('邀请码')} autocapitalize="off" autocorrect="off" spellcheck="false" />
          {/if}
        {/if}
        {#if acc.lgErr}<p class="lg-err">{acc.lgErr}</p>{/if}
        <button class="lg-go" type="submit" disabled={acc.lgBusy}>{acc.lgBusy ? t('请稍候…') : acc.lgMode === 'register' ? t('注册') : t('登录')}</button>
      </form>
      <div class="ig">
        {#if acc.lgMode === 'login'}
          {#each extAuth.list as p (p.key)}
            <button class="r" type="button" onclick={() => startExtLogin(p.key)}><span class="r-main"><span class="r-tx">{t('用 {name} 登录', { name: p.label })}</span>{@render chev()}</span></button>
          {/each}
          {#if !acc.canScan}
            <button class="r" type="button" onclick={() => acc.lgSwitch('qr')}><span class="r-main"><span class="r-tx">{t('扫码登录')}</span>{@render chev()}</span></button>
          {/if}
          {#if me.features?.register !== false}
            <button class="r" type="button" onclick={() => acc.lgSwitch('register')}><span class="r-main"><span class="r-tx">{t('注册新账号')}</span>{@render chev()}</span></button>
          {/if}
          <button class="r" type="button" onclick={() => acc.lgSwitch('token')}><span class="r-main"><span class="r-tx">{t('用访问令牌登录')}</span>{@render chev()}</span></button>
        {:else}
          <button class="r" type="button" onclick={() => acc.lgSwitch('login')}><span class="r-main center"><span class="r-tx accent">{t('返回登录')}</span></span></button>
        {/if}
      </div>
    {/if}
  {/if}
{/snippet}
{#if pid === 'root'}{@render pRoot()}
{:else if pid === 'account'}{@render pAccount()}
{:else if pid === 'about'}{@render pAbout()}
{:else if pid === 'history'}{@render pHistory()}
{/if}

<style>
  @import './kit.css';
</style>
