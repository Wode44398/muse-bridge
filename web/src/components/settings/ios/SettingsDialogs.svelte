<script>
  // 设置页（iOS 外壳）的弹层：警告框与表单页（服务器地址、退出登录、改密码、Claude 账号、关最后一个 agent、绕过权限、分支前缀、
  // dimensio 的输入框与选文件夹、额度数字、反馈）。外壳在原来的位置（舞台与长按菜单之后）挂它，次序与原来一致。
  import { useSettings } from './ctx.js';
  import Alert from '../../ios27/Alert.svelte';
  import ProjectPicker from '../../ProjectPicker.svelte';
  import Segmented from '../../ios27/Segmented.svelte';
  import Sheet from '../../ios27/Sheet.svelte';
  import Sym from '../../ios27/Sym.svelte';
  import TextField from '../../ios27/TextField.svelte';
  import Toggle from '../../ios27/Toggle.svelte';
  import { PLAN_CHOICES, accLabel } from '../../../lib/agentSettings.svelte.js';
  import { ds, setWorkspace } from '../../../lib/dimensioSettings.svelte.js';
  import { t, tc } from '../../../lib/i18n.js';
  const { about, acc, ag, cl, dm, fb, pol, pool } = useSettings();
</script>

{#if about.addrOpen}
  <Alert title={t('更换服务器地址')} message={t('服务器换了地址时 App 一般会自动跟过去（在家连上同一个 Wi-Fi 时最快）；没跟上、或要改连另一台服务器时，在这里填新地址。')} error={about.addr.addrErr}
    onclose={() => { if (!about.addr.addrBusy) about.addrOpen = false; }}
    actions={[{ label: about.addr.addrBusy ? t('连接中…') : t('连接'), role: 'default', disabled: about.addr.addrBusy, onclick: about.addr.connectAddr }, { label: t('取消'), role: 'cancel', onclick: () => (about.addrOpen = false) }]}>
    <TextField bind:value={about.addr.addrInput} placeholder="https://xxxx.trycloudflare.com" inputmode="url" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus />
  </Alert>
{/if}

{#if acc.acctAsk}
  <Alert title={t('退出登录？')}
    message={t('只退出这台设备，其它设备上的登录不受影响。')}
    onclose={() => { if (!acc.acctBusy) acc.acctAsk = null; }}
    actions={[{ label: acc.acctBusy ? t('请稍候…') : t('退出登录'), role: 'destructive', disabled: acc.acctBusy, onclick: acc.acctConfirm },
      { label: t('取消'), role: 'cancel', onclick: () => { if (!acc.acctBusy) acc.acctAsk = null; } }]} />
{/if}

{#if acc.pw}
  <Sheet title={t('修改密码')} closeLabel={t('取消')} confirmLabel={t('保存')} confirmDisabled={acc.pw.busy} onclose={() => { if (!acc.pw.busy) acc.pw = null; }} onconfirm={acc.savePw}>
    <div class="pw-form">
      <TextField bind:value={acc.pw.old} type="password" placeholder={t('原密码')} autocomplete="current-password" autofocus />
      <TextField bind:value={acc.pw.next} type="password" placeholder={t('新密码（至少 8 位）')} autocomplete="new-password" />
      <TextField bind:value={acc.pw.again} type="password" placeholder={t('再输一次新密码')} autocomplete="new-password" />
      {#if acc.pw.err}<p class="fb-err">{acc.pw.err}</p>{/if}
      <p class="fb-intro">{t('改完之后，别的设备需要重新登录')}</p>
    </div>
  </Sheet>
{/if}

{#if pool.acctForm}
  <Sheet title={pool.acctForm.isNew ? t('添加 Claude 账号') : t('编辑账号')} closeLabel={t('取消')} confirmLabel={pool.acctForm.isNew ? t('添加') : t('保存')}
    confirmDisabled={pool.acctForm.busy} onclose={() => { if (!pool.acctForm.busy) pool.acctForm = null; }} onconfirm={pool.saveAcctForm}>
    <div class="pw-form">
      <TextField bind:value={pool.acctForm.label} placeholder={t('如：主号 / 备用号')} autocapitalize="off" autocorrect="off" spellcheck="false" />
      <TextField bind:value={pool.acctForm.token} type="password" autocomplete="off" autocapitalize="off" spellcheck="false"
        placeholder={pool.acctForm.isNew ? 'sk-ant-oat…' : (pool.acctForm.hasToken ? t('留空＝不改，当前 …{tail}', { tail: pool.acctForm.tokenTail || '' }) : t('留空＝用本机登录态'))} />
      <Segmented options={PLAN_CHOICES()} value={pool.acctForm.plan} onchange={(v) => { pool.acctForm.plan = v; }} size="small" label={t('套餐')} />
      <p class="fb-intro">{t('套餐：setup-token 读不到订阅档位，自动识别分不清 Pro / Max 5x / Ultra 时手动标一下。')}</p>
      {#if pool.acctForm.err}<p class="fb-err">{pool.acctForm.err}</p>{/if}
      <p class="fb-intro">{t('在目标账号登录状态下运行 claude setup-token，把返回的长期 token 粘进来。')}</p>
    </div>
  </Sheet>
{/if}

{#if pool.acctDel}
  <Alert title={t('删除账号 {name}？', { name: accLabel(pool.acctDel.label) })} message={t('只从切换列表移除；若删的是当前账号，会自动切到另一个。')}
    onclose={() => (pool.acctDel = null)}
    actions={[{ label: t('删除'), role: 'destructive', onclick: pool.confirmAcctDel }, { label: t('取消'), role: 'cancel', onclick: () => (pool.acctDel = null) }]} />
{/if}

{#if ag.agLast}
  <Alert title={t('关闭 {name}？', { name: ag.agLast.label })} message={t('这是最后一个开着的 agent，关掉后所有客户端都没有可用的分页。确定吗？')}
    onclose={() => (ag.agLast = false)}
    actions={[{ label: tc('开关', '关闭'), role: 'destructive', onclick: ag.confirmAgLast }, { label: t('取消'), role: 'cancel', onclick: () => (ag.agLast = false) }]} />
{/if}

{#if cl.bypassAsk}
  <!-- 官方「Allow bypass permissions mode」的确认语义；页面上不写解释，全在这里 -->
  <Alert title={t('允许绕过权限模式？')} message={t('跳过所有权限检查，让 Claude 不间断地干活，适合修 lint、生成样板代码这类事。让 Claude 随意执行命令有风险，可能造成数据丢失、系统损坏或数据外泄（例如提示注入攻击）。')}
    onclose={() => (cl.bypassAsk = false)}
    actions={[{ label: t('允许'), role: 'destructive', onclick: cl.confirmBypass }, { label: t('取消'), role: 'cancel', onclick: () => (cl.bypassAsk = false) }]} />
{/if}

{#if cl.prefixEdit}
  <Alert title={t('分支前缀')} message={t('新会话的工作树分支叫 {prefix}/<名字>。留空 = claude。', { prefix: cl.prefixEdit.value.trim() || 'claude' })} error={cl.prefixEdit.err}
    onclose={() => { if (!cl.prefixEdit.busy) cl.prefixEdit = null; }}
    actions={[{ label: cl.prefixEdit.busy ? t('保存中…') : t('保存'), role: 'default', disabled: cl.prefixEdit.busy, onclick: cl.savePrefix }, { label: t('取消'), role: 'cancel', onclick: () => (cl.prefixEdit = null) }]}>
    <TextField bind:value={cl.prefixEdit.value} placeholder="claude" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus />
  </Alert>
{/if}

{#if dm.dmEdit}
  <Alert title={dm.dmEdit.title} message={dm.dmEdit.message} error={dm.dmEdit.err || ''}
    onclose={() => { if (!dm.dmEdit.busy) dm.dmEdit = null; }}
    actions={[
      { label: dm.dmEdit.busy ? t('保存中…') : t('保存'), role: 'default', disabled: dm.dmEdit.busy, onclick: dm.saveDmEdit },
      ...(dm.dmEdit.kind === 'ws' ? [{ label: t('选择文件夹…'), role: 'default', disabled: dm.dmEdit.busy, onclick: dm.pickDmFolder }] : []),
      ...(dm.dmEdit.kind === 'num' || dm.dmEdit.kind === 'text' ? [{ label: t('恢复默认'), role: 'default', disabled: dm.dmEdit.busy, onclick: dm.resetDmPref }] : []),
      { label: t('取消'), role: 'cancel', onclick: () => (dm.dmEdit = null) },
    ]}>
    {#if dm.dmEdit.multiline}
      <TextField multiline rows={5} bind:value={dm.dmEdit.value} placeholder={dm.dmEdit.placeholder || ''} autofocus />
    {:else}
      <TextField bind:value={dm.dmEdit.value} type={dm.dmEdit.password ? 'password' : 'text'} placeholder={dm.dmEdit.placeholder || ''}
        inputmode={dm.dmEdit.kind === 'num' ? 'decimal' : undefined} autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" autofocus />
    {/if}
  </Alert>
{/if}

{#if dm.dmPicking}
  <ProjectPicker title={t('选择工作空间')} hint={t('把文件夹拖进底栏，它就是 dimensio 新对话的工作空间')} preferPath={ds.config?.workspace || ''}
    onPick={async (p) => { dm.dmPicking = false; if (p) await setWorkspace(p); }} onClose={() => { dm.dmPicking = false; }} />
{/if}

{#if pol.numEdit}
  <Alert title={pol.numEdit.label} message={pol.numEdit.tz ? t('IANA 时区名，例如 Asia/Shanghai、America/Los_Angeles。') : t('留空或填 0 = 不限。')} error={pol.numEdit.err || ''}
    onclose={() => { if (!pol.numEdit.busy) pol.numEdit = null; }}
    actions={[{ label: pol.numEdit.busy ? t('保存中…') : t('保存'), role: 'default', disabled: pol.numEdit.busy, onclick: pol.saveNum }, { label: t('取消'), role: 'cancel', onclick: () => (pol.numEdit = null) }]}>
    <TextField bind:value={pol.numEdit.value} placeholder={pol.numEdit.tz ? 'Asia/Shanghai' : t('不限')} inputmode={pol.numEdit.tz ? undefined : 'decimal'} autocapitalize="off" autocorrect="off" spellcheck="false" autofocus />
  </Alert>
{/if}

{#if fb.fbOpen}
  <Sheet title={fb.fbDone ? t('收到，谢谢！') : t('提交反馈')} closeLabel={t('关闭')} confirmLabel={fb.fbDone ? t('好') : t('提交')}
    confirmDisabled={fb.fbBusy} onclose={() => (fb.fbOpen = false)} onconfirm={fb.submitFeedback}>
    {#if fb.fbDone}
      <div class="fb-done">
        <Sym name="checkmark.circle.fill" weight={400} size={56} class="fb-done-ic" />
        <p>{fb.fbSentUp === 'queued' ? t('已记下，也会转给 {to}。', { to: fb.fbDest.to }) : fb.fbSentUp === 'off' ? t('已记下，服务器管理员会看到。') : t('反馈已记到开发者的库里，会看到。')}</p>
      </div>
    {:else}
      <p class="fb-intro">{fb.fbUp && fb.fbUp.mode !== 'inbox' ? t('遇到的问题、想要的功能、体验吐槽都行，可附图片/视频。') : t('遇到的问题、想要的功能、体验吐槽都行，可附图片/视频，会直接进开发者的反馈库。')}</p>
      <TextField multiline bind:value={fb.fbText} placeholder={t('写下你的反馈…')} />
      <div class="fb-atts">
        {#each fb.fbAtts as a (a)}
          <div class="fb-att">
            {#if a.kind === 'image' && a.url}<img src={a.url} alt="" />{:else}<span class="fb-att-ico">{a.kind === 'video' ? '🎬' : '📎'}</span>{/if}
            {#if a.pending}<span class="fb-att-up">{Math.round((a.progress || 0) * 100)}%</span>{/if}
            <button type="button" class="fb-att-x" onclick={() => fb.removeFbAtt(a)} aria-label={t('移除')}><Sym name="xmark.circle.fill" weight={400} size={20} /></button>
          </div>
        {/each}
        <button type="button" class="fb-add" onclick={() => fb.fbFileInput && fb.fbFileInput.click()} aria-label={t('添加图片或视频')}>
          <Sym name="photo.badge.plus" weight={400} size={24} />
        </button>
      </div>
      {#if fb.fbUp?.mode === 'push'}
        <div class="fb-up-row">
          <span class="fb-up-tx">{t('这条也发给 {to}', { to: fb.fbDest.to })}<small>{fb.fbDest.public ? t('勾选后会同时发给 {to}：带文字、所在界面、版本和系统，不带账号名和服务器地址。这是公开发布：内容任何人都能看到，请别写隐私、账号、密钥；图片不会公开发布（只记张数），视频不发。', { to: fb.fbDest.to }) : t('勾选后会同时发给 {to}：带文字、所在界面、版本和系统，不带账号名和服务器地址；图片最多 3 张，原样发出，截图里能看到的开发者也能看到；视频不发。', { to: fb.fbDest.to })}</small></span>
          <Toggle checked={fb.fbConsent} onchange={() => (fb.fbConsent = !fb.fbConsent)} label={t('这条也发给 {to}', { to: fb.fbDest.to })} />
        </div>
      {/if}
      {#if fb.fbUpNote}<p class="fb-up">{fb.fbUpNote}</p>{/if}
      {#if fb.fbInboxLine}<p class="fb-up" class:bad={!!fb.fbUp.lastPullError || fb.fbUp.reason === 'no-relay'}>{fb.fbInboxLine}</p>{/if}
      {#if fb.fbUp?.admin && fb.fbUp.mode !== 'inbox' && !fb.fbUp.reason}
        <div class="fb-up-row">
          <span class="fb-up-tx">{t('把用户反馈同时发给 {to}', { to: fb.fbDest.to })}<small>{fb.fbUpAdminSub}</small>{#if fb.fbUp.pending}<small>{t('还有 {n} 条没发出去，连上后自动补发。', { n: fb.fbUp.pending })}</small>{/if}</span>
          <Toggle checked={fb.fbUp.mode === 'push'} disabled={fb.fbUpBusy} onchange={fb.toggleFbUp} label={t('把用户反馈同时发给 {to}', { to: fb.fbDest.to })} />
        </div>
      {/if}
      {#if fb.fbErr}<p class="fb-err">{fb.fbErr}</p>{/if}
      {#if fb.fbBusy}<p class="fb-busy">{t('提交中…')}</p>{/if}
      <input bind:this={fb.fbFileInput} type="file" accept="image/*,video/*" multiple onchange={fb.onFbFiles} hidden />
    {/if}
  </Sheet>
{/if}

<style>
  @import './kit.css';
</style>
