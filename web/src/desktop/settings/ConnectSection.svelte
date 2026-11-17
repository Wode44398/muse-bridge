<script>
  // 桌面设置 › 连接与更新：服务器地址与线路、本机服务进程、服务端控制台入口、公网地址、手机扫码连接 / 下载 App、服务端更新、软件更新。
  // 状态在外壳创建的控制器里（./ctx.js 的 useDesk），这里只画；样式是同一套 kit.css。
  import { useDesk } from './ctx.js';
  import { fmtUptime } from '../../lib/settings/common.js';
  import ConnectQr from '../../components/pairing/ConnectQr.svelte';
  import DButton from '../kit/DButton.svelte';
  import DField from '../kit/DField.svelte';
  import DGroup from '../kit/DGroup.svelte';
  import DRow from '../kit/DRow.svelte';
  import DSwitch from '../kit/DSwitch.svelte';
  import { getServerBase } from '../../lib/server.js';
  import { hasSilentUpdate } from '../../lib/appUpdate.js';
  import { me, ui } from '../../lib/state.svelte.js';
  import { stripBrand } from '../../lib/distro.js';
  import { t, tc, tr } from '../../lib/i18n.js';

  const D = useDesk();
  const { conn } = D;
</script>
<DGroup label={t('服务器')}>
  <div class="addr-line" class:hl-line={D.fl('addr')}>
    <DField bind:value={conn.addr.addrInput} placeholder={getServerBase() || t('同源（当前页面地址）')} width="100%" />
    <DButton variant="primary" disabled={conn.addr.addrBusy} onclick={conn.addr.connectAddr}>{conn.addr.addrBusy ? t('连接中…') : t('连接')}</DButton>
  </div>
  {#if conn.addr.addrErr}<p class="err sel-text">{conn.addr.addrErr}</p>{/if}
  <DRow title={t('当前线路')} highlight={D.fl('route')}>
    {#snippet trailing()}<span class="state"><i class="dot ok"></i>{ui.connMode === 'lan' ? t('局域网直连') : t('隧道 / 同源')}</span>{/snippet}
  </DRow>
  <!-- 后端跑了多久（登录后才拿得到）：以前放在「公网」组里，没有公网地址时那组只剩这一行、标题对不上 -->
  {#if conn.srvInfo}
    <DRow title={t('后端')}>
      {#snippet trailing()}<span class="state">{t('已运行 {t}', { t: fmtUptime(conn.srvInfo.server?.uptimeSec) })}{conn.srvInfo.server?.node ? ' · Node ' + conn.srvInfo.server.node.replace(/^v/, '') : ''}</span>{/snippet}
    </DRow>
  {/if}
  {#if D.spCtl}
    <!-- 这一行不走 bridge：服务停着也能在这里把它拉起来、看日志 -->
    <DRow title={t('bridge 服务')} onclick={() => D.spCtl.open()} highlight={D.fl('srvproc')}>
      {#snippet trailing()}<span class="state"><i class="dot" class:ok={conn.spState?.health === 'up'} class:warn={conn.spState?.health === 'unresponsive'} class:bad={conn.spState && conn.spState.health !== 'up' && conn.spState.health !== 'unresponsive'}></i>{conn.spLine}</span>{/snippet}
    </DRow>
    {#if conn.spPrefs?.managed && typeof conn.spPrefs.confirmQuit === 'boolean'}
      <DRow title={t('退出前确认')} sub={t('点「退出」先问一句，默认隐藏到托盘、服务端照常运行；关掉后「退出」直接退出并停止本机服务端')} highlight={D.fl('quitconfirm')}>
        {#snippet trailing()}<DSwitch checked={conn.spPrefs.confirmQuit} onchange={conn.onConfirmQuit} />{/snippet}
      </DRow>
    {/if}
    {#if conn.spPrefs?.managed && typeof conn.spPrefs.keepOnline === 'boolean'}
      <DRow title={t('插电时保持在线')} sub={conn.keepOnlineSub} highlight={D.fl('keeponline')}>
        {#snippet trailing()}<DSwitch checked={conn.spPrefs.keepOnline} onchange={conn.onKeepOnline} />{/snippet}
      </DRow>
    {/if}
    {#if conn.spPrefs?.managed && D.ssCtl}
      <!-- 本机服务端：令牌只在壳自己的本地页里显示（网页拿不到它），这里只是入口 -->
      <DRow title={t('本机服务端访问信息')} sub={t('访问令牌、局域网与公网地址')} onclick={() => D.ssCtl.open('access')} highlight={D.fl('srvaccess')} />
      <DRow title={t('重新配置本机服务端')} sub={t('工作空间、端口、Claude 账号')} onclick={() => D.ssCtl.open('edit')} />
    {/if}
  {/if}
  <!-- 网页版控制台整页靠 /api/admin/*：服务停着点进去只会满屏「加载失败」，所以服务不在跑时不摆这一行 -->
  {#if conn.srvAdminOk && (conn.spState ? conn.spState.health === 'up' : true)}
    <DRow title={t('服务端控制台')} onclick={() => { ui.serverAdminOpen = true; }} highlight={D.fl('srvadmin')} />
  {/if}
</DGroup>
<!-- 服务器那头：出门在外用的公网地址（登录后才拿得到；没有公网地址就不出这一组） -->
{#if conn.srvInfo?.publicOrigin}
  <DGroup label={t('公网')} foot={conn.srvInfo.address?.kind === 'temporary' ? t('临时地址：电脑或服务重启后会换一个。连过的手机 App 会自动跟过去（在线时立即收到，离线时回家连上同一个 Wi-Fi 就会更新）；网页和分享出去的链接要手动改。长期使用建议绑定自己的域名。') : ''}>
    <DRow title={t('公网地址')} sub={conn.srvInfo.publicOrigin.replace(/^https?:\/\//, '')} highlight={D.fl('public')}>
      {#snippet trailing()}<DButton size="sm" onclick={conn.copyPublic}>{conn.pubCopied ? t('已复制') : t('复制')}</DButton>{/snippet}
    </DRow>
    {#if conn.srvInfo.address?.kind}
      <DRow title={t('地址类型')}>
        {#snippet trailing()}<span class="state">{conn.srvInfo.address.kind === 'temporary' ? t('临时地址（重启会换）') : t('固定地址')}</span>{/snippet}
      </DRow>
    {/if}
  </DGroup>
{/if}
<!-- 手机扫码连接（S1-2）：点开才出码（每次出码都是一张 3 分钟的一次性票，别一进页面就挂在屏幕上） -->
{#if me.kind !== 'none'}
  <DGroup label={t('手机扫码连接')} foot={conn.connectOpen ? '' : t('手机 App 首屏「扫码连接」扫一下就连上这台服务器，并以你现在的身份登录；不用抄地址和令牌。')}>
    {#if conn.connectOpen}
      <ConnectQr via="settings" />
      <DRow title={t('收起二维码')} chevron={false} onclick={() => { conn.connectOpen = false; }} />
    {:else}
      <DRow title={t('显示配对二维码')} chevron={false} onclick={() => { conn.connectOpen = true; }} highlight={D.fl('pairconnect')} />
    {/if}
  </DGroup>
{/if}
<!-- 手机扫码下载 App：指向这台服务器自己的 /download/android（同一次构建的包，版本和服务器对齐） -->
{#if conn.dlShow}
  <DGroup label={t('手机 App')} foot={t('用手机相机扫码，下载和这台服务器同一版本的安卓 App；装好后打开 App 连这台服务器。')}>
    <div class="dl-app">
      {#if conn.dlQr}<div class="dl-qr" aria-hidden="true">{@html conn.dlQr}</div>{/if}
      <div class="dl-meta">
        <span class="dl-url sel-text">{conn.dlUrl}</span>
        {#if conn.dlUrls.lan && conn.dlUrls.pub}
          <DButton size="sm" onclick={() => { conn.dlWhich = conn.dlPick === 'pub' ? 'lan' : 'pub'; }}>{conn.dlPick === 'pub' ? t('改用局域网地址') : t('改用公网地址')}</DButton>
        {/if}
      </div>
    </div>
  </DGroup>
{/if}
<!-- 服务端更新（管理员）：查 GitHub 发布仓库上的版本，按部署形态一键更新（安装包里的本机服务端交给那台电脑的客户端去装）。
     服务端随这台电脑的客户端一起装时不摆（下面的「软件更新」就是它） -->
{#if conn.srvUpdShow && conn.srvUpdView}
  <DGroup label={t('服务端更新')} foot={conn.srvUpdView.how}>
    <DRow title={t('服务端版本')} sub={conn.srvUpdView.sub} highlight={D.fl('server-update')}>
      {#snippet trailing()}
        {#if conn.srvUpd.busy || conn.srvUpd.loading}<span class="spin"></span>
        {:else if conn.srvUpdView.action}<DButton size="sm" variant={conn.srvUpdView.action === 'update' ? 'primary' : 'secondary'} onclick={() => conn.srvUpd.act(conn.srvUpdView.action)}>{conn.srvUpdView.label}</DButton>{/if}
      {/snippet}
    </DRow>
    {#if conn.srvUpd.st?.newer && conn.srvUpd.st?.page}
      <DRow title={t('新版本说明')} sub={conn.srvUpd.st.notes ? tr(conn.srvUpd.st.notes).slice(0, 160) + (conn.srvUpd.st.notes.length > 160 ? '…' : '') : ''} onclick={() => window.open(conn.srvUpd.st.page, '_blank', 'noopener')} />
    {/if}
    {#if conn.srvUpd.err}<p class="err sel-text">{conn.srvUpd.err}</p>{/if}
    {#if conn.srvUpd.note}<p class="note sel-text">{conn.srvUpd.note}</p>{/if}
  </DGroup>
{/if}
<DGroup label={tc('settings', '更新')}>
  <!-- 行本身不可点：动作只在右侧按钮上（行内再放按钮会成按钮套按钮） -->
  <DRow title={t('软件更新')} sub={conn.upState === 'idle' || conn.upState === 'checking' ? stripBrand(D.verLine) : ''} highlight={D.fl('update')}>
    {#snippet trailing()}
      {#if conn.upState === 'downloading'}<span class="num">{Math.round(conn.progress * 100)}%</span><span class="ring" style:--p="{Math.round(conn.progress * 360)}deg"></span>
      {:else if conn.upState === 'checking'}<span class="spin"></span><span>{conn.upMsg}</span>
      {:else if conn.upState === 'installable'}<DButton size="sm" variant="primary" onclick={conn.onUpdate}>{conn.upMsg}</DButton>
      {:else if conn.upState === 'waiting'}<span>{conn.upMsg}</span><DButton size="sm" onclick={conn.onCancelWait}>{tc('update', '取消等待')}</DButton><DButton size="sm" variant="danger" onclick={() => conn.installNow('now')}>{t('立即安装（会中断）')}</DButton>
      {:else if conn.upState === 'error'}<DButton size="sm" variant="danger" onclick={conn.onUpdate}>{conn.upMsg}</DButton>
      {:else if conn.upState === 'latest' || conn.upState === 'done'}<span>{conn.upMsg}</span>
      {:else}<DButton size="sm" onclick={conn.onUpdate}>{t('检查更新')}</DButton>{/if}
    {/snippet}
  </DRow>
  {#if hasSilentUpdate()}
    <DRow title={t('自动检查更新')} sub={conn.autoUp ? t('启动时检查，发现新版在后台下载好，装不装由你决定') : ''} highlight={D.fl('auto-update')}>
      {#snippet trailing()}<DSwitch checked={conn.autoUp} onchange={conn.onAutoUp} />{/snippet}
    </DRow>
  {/if}
  {#if conn.upErr}<p class="err sel-text">{conn.upErr}</p>{/if}
  {#if conn.upNote}<p class="note sel-text">{conn.upNote}</p>{/if}
</DGroup>

<style>
  @import './kit.css';
</style>
