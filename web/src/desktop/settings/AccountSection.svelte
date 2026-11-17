<script>
  // 桌面设置 › 账户：已登录时是头图、额度、改密码、切换账号与退出；没登录时是登录 / 注册 / 令牌 / 扫码。
  // 状态在外壳创建的控制器里（./ctx.js 的 useDesk），这里只画；样式是同一套 kit.css。
  import { useDesk } from './ctx.js';
  import { PERSON } from './ctx.js';
  import AdminAccessSection from './AdminAccessSection.svelte';
  import DButton from '../kit/DButton.svelte';
  import DField from '../kit/DField.svelte';
  import DGroup from '../kit/DGroup.svelte';
  import DRow from '../kit/DRow.svelte';
  import { costNote, hasLimits, quotaRows } from '../../lib/me.js';
  import { extAuth, startExtLogin } from '../../lib/authProviders.svelte.js';
  import { me, status } from '../../lib/state.svelte.js';
  import { t, tc } from '../../lib/i18n.js';

  const D = useDesk();
  const { acc } = D;
</script>
{#snippet ava(cls = '')}
  <span class="ava {cls}" class:none={me.kind === 'none'}>{#if me.kind !== 'none'}{acc.initial}{:else}{@html PERSON}{/if}</span>
{/snippet}

<!-- 这台设备上保存着登录的账号：当前这个标「当前」，别的号「切换」/「移除」（移除 = 在服务端退出那张会话） -->
{#snippet acctRows()}
  {#each acc.accts as a (a.key)}
    <DRow title={a.user} sub={acc.acctRole(a)}>
      {#snippet trailing()}
        {#if a.current}<span class="qv">{t('当前账号')}</span>
        {:else}
          <DButton size="sm" variant="ghost" disabled={!!acc.switching} onclick={() => acc.dropAcct(a)}>{t('移除')}</DButton>
          <DButton size="sm" variant="secondary" disabled={!!acc.switching} onclick={() => acc.doSwitch(a)}>{acc.switching === a.key ? t('切换中…') : t('切换')}</DButton>
        {/if}
      {/snippet}
    </DRow>
  {/each}
{/snippet}

{#if me.kind !== 'none'}
  <div class="hero">
    {@render ava('xl')}
    <h2>{me.user || 'Admin'}</h2>
    <p>{acc.roleLabel}{status.plan ? ' · ' + status.plan : ''}</p>
  </div>
  <DGroup label={t('订阅额度')}>
    <div class="usage" class:hl-line={D.fl('usage')}>
      <!-- 没有 5 小时限额的号（部分 Ultra）不摆空的 5 小时条 -->
      {#each [...(status.noFiveHour && acc.fiveH == null ? [] : [[t('5 小时额度'), acc.fiveH]]), [t('本周额度'), acc.weekly]] as [name, v] (name)}
        <div class="u">
          <span class="ul">{name}</span>
          <span class="ubar">{#if v != null}<i style:width="{v}%" class:hot={v > 80}></i>{/if}</span>
          <span class="uv">{v == null ? '—' : v + '%'}</span>
        </div>
      {/each}
    </div>
  </DGroup>
  <DGroup>
    <DRow title={t('工作空间')} onclick={acc.openWorkspace} highlight={D.fl('acct')} />
    {#if me.kind === 'user'}
      {#if acc.pwForm}
        <form class="lform" onsubmit={acc.savePw}>
          {#if acc.pwForm.err}<p class="err">{acc.pwForm.err}</p>{/if}
          <DField bind:value={acc.pwForm.old} placeholder={t('原密码')} type="password" width="100%" />
          <DField bind:value={acc.pwForm.next} placeholder={t('新密码（至少 8 位）')} type="password" width="100%" />
          <DField bind:value={acc.pwForm.again} placeholder={t('再输一次新密码')} type="password" width="100%" />
          <div class="lacts">
            <span class="sp"></span>
            <DButton variant="ghost" onclick={() => { acc.pwForm = null; }}>{t('取消')}</DButton>
            <DButton variant="primary" type="submit" disabled={acc.pwForm.busy}>{acc.pwForm.busy ? t('保存中…') : t('保存')}</DButton>
          </div>
        </form>
      {:else}
        <DRow title={t('修改密码')} sub={acc.pwOk ? t('已改好。别的设备要用新密码重新登录，这台不受影响。') : ''} onclick={() => { acc.pwOk = false; acc.pwForm = { old: '', next: '', again: '', busy: false, err: '' }; }} />
      {/if}
    {/if}
  </DGroup>
  {#if me.kind === 'user'}
    <DGroup label={t('我的额度')} foot={acc.myUsage && hasLimits(acc.myUsage) ? costNote() : ''}>
      {#if acc.myUsage && hasLimits(acc.myUsage)}
        {#each quotaRows(acc.myUsage) as r (r.label)}
          <DRow title={r.label}>
            {#snippet trailing()}<span class="qv" class:hot={r.hot}>{r.value}</span>{/snippet}
          </DRow>
        {/each}
      {:else}
        <DRow title={acc.myUsage ? t('不限') : t('读取中…')} />
      {/if}
    </DGroup>
    <!-- 管理员可见性（S2-7）：成员自己决定管理员能不能看内容、代聊代答、看他的电脑，并看到访问记录 -->
    <AdminAccessSection highlight={D.fl('admin-access')} />
  {/if}
  <!-- 切换账号：这台设备上登录过的账号都留着登录（lib/accountVault.js），点「切换」直接换过去 -->
  <DGroup label={t('切换账号')} foot={acc.acctErr || t('这台设备上登录过的账号会留着登录，点一下直接切换，不用重新输入密码。')}>
    {@render acctRows()}
    <DRow title={t('添加账号')} chevron={false} onclick={acc.addSignIn} />
  </DGroup>
  <DGroup>
    <DRow title={t('退出登录')} danger chevron={false} onclick={() => { acc.logoutAsk = 'logout'; }} />
  </DGroup>
{:else}
  <div class="hero">
    {@render ava('xl')}
    <h2>{acc.mode === 'qr' ? t('扫码登录') : acc.mode === 'register' ? t('注册新账号') : acc.mode === 'token' ? t('管理员令牌') : t('登录 The Bridge')}</h2>
    <p>{acc.mode === 'qr' ? t('打开手机上的 The Bridge，在设置 › 账户点「扫一扫」') : acc.mode === 'register' ? t('需要邀请码；注册即登录。') + ' ' + t('服主默认只看得到你的会话标题、时间和用量；看内容要你在设置里允许。') : acc.mode === 'token' ? t('粘贴服务端的访问令牌，以管理员身份直连。') : t('登录后使用对话、工作空间与用量')}</p>
  </div>
  {#if acc.mode === 'login' && acc.accts.length}
    <DGroup label={t('这台设备上的账号')} foot={acc.acctErr}>{@render acctRows()}</DGroup>
  {/if}
  <div class="lwrap">
    {#if acc.mode === 'qr'}
      <div class="qrpane">
        <div class="qrbox" class:dim={acc.pair.status !== 'pending'}>
          {#if acc.pair.svg}{@html acc.pair.svg}{/if}
          {#if acc.pair.status !== 'pending'}
            <button class="qrov" onclick={() => acc.pairCtl?.refresh()} disabled={acc.pair.status === 'loading' || acc.pair.status === 'idle' || acc.pair.status === 'approved' || acc.pair.status === 'scanned'}>{acc.pairMsg}</button>
          {/if}
        </div>
        <DButton variant="ghost" onclick={() => { acc.mode = 'login'; acc.lgErr = ''; }}>{t('账号密码登录')}</DButton>
      </div>
    {:else}
      <form class="lform card" onsubmit={acc.submitAuth}>
        {#if acc.mode === 'token'}
          <DField bind:value={acc.lgTok} placeholder={t('访问令牌')} type="password" width="100%" />
        {:else}
          <DField bind:value={acc.lgUser} placeholder={acc.mode === 'register' ? t('账号（2–32 位字母/数字/_/-）') : tc('settings', '账号')} width="100%" />
          <DField bind:value={acc.lgPass} placeholder={acc.mode === 'register' ? t('密码（至少 8 位）') : t('密码')} type="password" width="100%" />
          {#if acc.mode === 'register'}
            <DField bind:value={acc.lgPass2} placeholder={t('确认密码')} type="password" width="100%" />
            <DField bind:value={acc.lgInvite} placeholder={t('邀请码')} width="100%" />
          {/if}
        {/if}
        {#if acc.lgErr}<p class="err">{acc.lgErr}</p>{/if}
        <button class="go" type="submit" disabled={acc.lgBusy}>{acc.lgBusy ? t('请稍候…') : acc.mode === 'register' ? t('注册') : t('登录')}</button>
      </form>
      {#if acc.mode === 'login' && extAuth.list.length}
        <div class="extl">
          {#each extAuth.list as p (p.key)}
            <button class="extb" onclick={() => startExtLogin(p.key)}>{#if p.icon}<img src={p.icon} alt="" />{/if}<span>{t('用 {name} 登录', { name: p.label })}</span></button>
          {/each}
        </div>
      {/if}
      <div class="alts">
        {#if acc.mode === 'login'}
          <button onclick={() => { acc.mode = 'qr'; acc.lgErr = ''; }}>{t('扫码登录')}</button>
          {#if me.features?.register !== false}<button onclick={() => { acc.mode = 'register'; acc.lgErr = ''; }}>{t('注册新账号')}</button>{/if}
          <button onclick={() => { acc.mode = 'token'; acc.lgErr = ''; }}>{t('用访问令牌登录')}</button>
        {:else}
          <button onclick={() => { acc.mode = 'login'; acc.lgErr = ''; }}>{t('返回登录')}</button>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  @import './kit.css';
</style>
