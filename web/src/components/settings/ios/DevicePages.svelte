<script>
  // 设置 › Agent 接入、手机操控、设备（单台设备、新的端口转发）（iOS 外壳）。状态在外壳创建的控制器里（./ctx.js），这里只画页面。
  import { useSettings } from './ctx.js';
  import Sym from '../../ios27/Sym.svelte';
  import Toggle from '../../ios27/Toggle.svelte';
  import { agentKeys, dismissFresh } from '../../../lib/agentKeys.svelte.js';
  import { deviceStatusLine, devices, forwardShareUrl, forwards, setThisComputerMode, stopThisComputer, thisComputer } from '../../../lib/devices.svelte.js';
  import { me } from '../../../lib/state.svelte.js';
  import { t, tr } from '../../../lib/i18n.js';

  let { pid } = $props();
  const S = useSettings();
  const { ak, dev, phone } = S;
</script>
{#snippet chev()}<Sym name="chevron.right" weight={600} size={13} class="chev" />{/snippet}
{#snippet check()}<Sym name="checkmark" weight={600} size={15} class="ck" />{/snippet}
{#snippet gfoot(text)}<p class="gfoot">{text}</p>{/snippet}
{#snippet ghead(text)}<h2 class="ghead">{text}</h2>{/snippet}

{#snippet pAgentApi()}
  <p class="gfoot ak-intro">{t('让别的 agent（Claude Code、Codex、脚本等）直接调用这台 bridge：读项目手册、给 Claude 派活、管文件和定时任务，不用开浏览器模拟点击。')}</p>
  {#if agentKeys.err}<p class="gfoot dv-err">{agentKeys.err}</p>{:else if ak.akNote}<p class="gfoot">{ak.akNote}</p>{/if}

  {#if agentKeys.fresh}
    {@render ghead(t('新密钥：{name}', { name: agentKeys.fresh.label }))}
    <div class="ig ak-fresh">
      <div class="r"><span class="r-main"><code class="ak-key">{agentKeys.fresh.key}</code></span></div>
      <button class="r" type="button" onclick={() => ak.akCopy(agentKeys.fresh.prompt || agentKeys.fresh.key, t('已复制给 agent 的说明'))}><span class="r-main center"><span class="r-tx accent">{t('复制给 agent 的说明')}</span></span></button>
      <button class="r" type="button" onclick={() => ak.akCopy(agentKeys.fresh.key, t('密钥已复制'))}><span class="r-main center"><span class="r-tx accent">{t('复制密钥')}</span></span></button>
      <button class="r" type="button" onclick={dismissFresh}><span class="r-main center"><span class="r-tx">{t('我已保存好')}</span></span></button>
    </div>
    <p class="gfoot ak-warn">{t('关掉之后就再也看不到这把密钥了。丢了就吊销它，再生成一把新的。')}</p>
  {/if}

  {@render ghead(t('地址'))}
  <div class="ig">
    <div class="r">
      <span class="r-main">
        <span class="r-tx">{t('Agent 入口')}<span class="r-sub dv-url">{agentKeys.agentUrl || (agentKeys.loaded ? '—' : t('正在读取…'))}</span></span>
        {#if agentKeys.agentUrl}<span class="dv-minis"><button type="button" onclick={() => ak.akCopy(agentKeys.agentUrl)}>{t('复制')}</button></span>{/if}
      </span>
    </div>
    <div class="r">
      <span class="r-main">
        <span class="r-tx">{t('项目手册')}<span class="r-sub dv-url">{agentKeys.manualUrl || '—'}</span></span>
        {#if agentKeys.manualUrl}
          <span class="dv-minis">
            <button type="button" onclick={() => window.open(agentKeys.manualUrl, '_blank', 'noopener')}>{t('打开')}</button>
            <button type="button" onclick={() => ak.akCopy(agentKeys.manualUrl)}>{t('复制')}</button>
          </span>
        {/if}
      </span>
    </div>
  </div>

  {@render ghead(t('生成密钥'))}
  <div class="ig">
    <div class="r"><span class="r-main"><input class="dv-in" bind:value={ak.akLabel} placeholder={t('例如「家里的 Codex」')} onkeydown={(e) => { if (e.key === 'Enter') ak.akCreate(); }} /></span></div>
    <button class="r" type="button" disabled={!ak.akLabel.trim() || agentKeys.busy === 'create'} onclick={ak.akCreate}><span class="r-main center"><span class="r-tx accent">{t('生成')}</span></span></button>
  </div>
  {@render gfoot(t('给每个 agent 单独一把，名字写清是谁在用，方便以后吊销。'))}

  {@render ghead(t('密钥'))}
  <div class="ig">
    {#if !agentKeys.keys.length}
      <div class="r"><span class="r-main"><span class="r-tx">{agentKeys.loaded ? t('还没有密钥') : t('正在读取…')}{#if agentKeys.loaded}<span class="r-sub">{t('生成一把，交给要接入的 agent')}</span>{/if}</span></span></div>
    {/if}
    {#each agentKeys.keys as k (k.id)}
      <div class="r">
        <span class="r-main">
          <span class="r-tx">{k.label || k.id}<span class="r-sub">{ak.akMeta(k)}</span></span>
          <span class="dv-minis">
            {#if ak.akAsk === k.id}
              <button type="button" onclick={() => (ak.akAsk = '')}>{t('取消')}</button>
              <button type="button" class="red" disabled={agentKeys.busy === 'revoke:' + k.id} onclick={() => ak.akRevoke(k.id)}>{t('确认吊销')}</button>
            {:else}
              <button type="button" class="red" onclick={() => (ak.akAsk = k.id)}>{t('吊销')}</button>
            {/if}
          </span>
        </span>
      </div>
    {/each}
  </div>
  {@render gfoot(t('密钥等同你的登录：拿到它的 agent 能做你能做的一切。每把 90 天后过期。') + ' ' + (me.kind === 'user' ? t('改密码会让你的全部密钥立即失效。') : t('换访问令牌会让全部密钥立即失效。')))}
{/snippet}

{#snippet statusTail(ok)}
  {#if ok}<Sym name="checkmark.circle.fill" weight={400} size={20} class="okmark" />{:else}{@render chev()}{/if}
{/snippet}

{#snippet pPhone()}
  <div class="ig">
    <div class="r">
      <span class="r-main"><span class="r-tx">{t('允许 Claude 操控这台手机')}</span><Toggle checked={phone.phoneCtrlOn} onchange={phone.togglePhoneCtrl} label={t('手机操控')} /></span>
    </div>
  </div>
  {#if phone.phoneCtrlOn}
    {@render ghead(t('权限'))}
    <div class="ig">
      <button class="r" type="button" onclick={phone.grantAccessibility} aria-label={t('授予无障碍权限')}>
        <span class="r-main"><span class="r-tx">{t('无障碍权限')}</span>{#if !phone.accOn}<span class="r-d warn">{t('未开启')}</span>{/if}{@render statusTail(phone.accOn)}</span>
      </button>
      <button class="r" type="button" onclick={phone.grantBattery} aria-label={t('保持后台运行')}>
        <span class="r-main"><span class="r-tx">{t('保持后台运行')}</span>{#if !phone.batteryOk}<span class="r-d warn">{t('未开启')}</span>{/if}{@render statusTail(phone.batteryOk)}</span>
      </button>
      <button class="r" type="button" onclick={phone.openAppDetails} aria-label={t('自启动与后台')}>
        <span class="r-main"><span class="r-tx">{t('自启动 / 后台活动')}</span>{@render chev()}</span>
      </button>
      <button class="r" type="button" onclick={phone.onImeRow} aria-label={t('Bridge 输入法')}>
        <span class="r-main"><span class="r-tx">{t('Bridge 输入法')}</span>{#if !phone.imeEnabled}<span class="r-d warn">{t('未开启')}</span>{/if}{@render statusTail(phone.imeEnabled)}</span>
      </button>
    </div>
  {/if}
  {#if phone.hasFloatShell}
    {@render ghead(t('悬浮外壳'))}
    <div class="ig">
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('悬浮外壳 · Agent 模式')}</span><Toggle checked={phone.floatShellOn} onchange={phone.toggleFloatShell} label={t('悬浮外壳')} /></span>
      </div>
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('挖孔定位诊断')}</span><Toggle checked={phone.cutoutDbgOn} onchange={phone.toggleCutoutDbg} label={t('挖孔定位诊断')} /></span>
      </div>
      <button class="r" type="button" onclick={phone.startCutoutCal}>
        <span class="r-main"><span class="r-tx">{t('校准挖孔位置')}</span>{@render chev()}</span>
      </button>
    </div>
  {/if}
{/snippet}

{#snippet dvMsg()}
  {#if dev.dvErr}<p class="gfoot dv-err">{dev.dvErr}</p>{:else if dev.dvNote}<p class="gfoot">{dev.dvNote}</p>{/if}
{/snippet}

{#snippet pDevices()}
  {@render dvMsg()}
  {#if thisComputer.supported}
    {@render ghead(t('这台电脑'))}
    <div class="ig">
      {#each dev.DV_TIERS as o (o.value)}
        <button class="r" type="button" onclick={() => setThisComputerMode(o.value)}>
          <span class="r-main"><span class="r-tx">{o.label}<span class="r-sub">{o.sub}</span></span>{#if thisComputer.mode === o.value}{@render check()}{/if}</span>
        </button>
      {/each}
    </div>
    {@render gfoot(dev.dvThisFoot)}
    {#if thisComputer.active}
      <div class="ig">
        <button class="r" type="button" onclick={stopThisComputer}>
          <span class="r-main center"><span class="r-tx red">{t('立即停止本轮操作')}<span class="r-sub">{tr(thisComputer.source) || 'agent'} · {tr(thisComputer.lastAction || '')}</span></span></span>
        </button>
      </div>
    {/if}
  {/if}

  {@render ghead(t('我的设备'))}
  <div class="ig">
    {#if !devices.list.length}
      <div class="r"><span class="r-main"><span class="r-tx">{devices.loaded ? t('还没有设备') : t('正在读取…')}</span></span></div>
    {/if}
    {#each devices.list as d (d.id)}
      <button class="r" type="button" onclick={() => dev.openDevice(d)}>
        <span class="r-main">
          <span class="r-tx"><span class="r-lbl">{d.name}{#if d.id === dev.myDeviceId}<span class="pill">{t('这台')}</span>{/if}</span><span class="r-sub">{deviceStatusLine(d, t)}</span></span>
          {@render chev()}
        </span>
      </button>
    {/each}
  </div>
  {@render gfoot(t('在电脑上装 bridge 桌面客户端并用同一个账号登录，它就会出现在这里。'))}

  {@render ghead(t('端口转发'))}
  <div class="ig">
    {#if forwards.err}
      <div class="r"><span class="r-main"><span class="r-tx">{t('端口转发')}<span class="r-sub err">{forwards.err}</span></span></span></div>
    {/if}
    {#each forwards.list as f (f.token)}
      <div class="r">
        <span class="r-main">
          <span class="r-tx">{(f.label ? f.label + ' · ' : '') + t('端口 {port}', { port: f.port })}<span class="r-sub dv-url">{(f.deviceName ? f.deviceName + ' · ' : '') + forwardShareUrl(f)}</span></span>
          <span class="dv-minis">
            <button type="button" onclick={() => window.open(forwardShareUrl(f), '_blank', 'noopener')}>{t('打开')}</button>
            <button type="button" onclick={() => dev.copyDv(forwardShareUrl(f))}>{t('复制')}</button>
            <button type="button" class="red" disabled={dev.dvBusy === 'fwd:' + f.token} onclick={() => dev.dropFwdDv(f)}>{t('删除')}</button>
          </span>
        </span>
      </div>
    {/each}
    {#if dev.dvFwdChoices.length}
      <button class="r" type="button" onclick={dev.openFwdNew}><span class="r-main"><span class="r-tx accent">{t('新的转发…')}</span></span></button>
    {:else}
      <div class="r"><span class="r-main"><span class="r-tx">{t('没有能转发端口的电脑')}<span class="r-sub">{t('需要新版桌面客户端在线')}</span></span></span></div>
    {/if}
  </div>
  {@render gfoot(t('把电脑上的本机端口（dev server、本机模型接口）接到服务器：手机上也能打开，Claude 也能用。持有地址的人都能访问，不用了就删掉。'))}

{/snippet}

{#snippet pDevice(id)}
  {@const d = devices.list.find((x) => x.id === id)}
  {#if d}
    <div class="hero">
      <div class="hero-name">{d.name}</div>
      <div class="hero-sub">{deviceStatusLine(d, t)}</div>
    </div>
    {@render dvMsg()}
    {@render ghead(t('名字'))}
    <div class="ig">
      <div class="r">
        <span class="r-main">
          <input class="dv-in" bind:value={dev.dvName} />
          <span class="dv-minis"><button type="button" disabled={dev.dvBusy === 'name' || !dev.dvName.trim() || dev.dvName.trim() === d.name} onclick={() => dev.renameDv(d)}>{t('保存')}</button></span>
        </span>
      </div>
    </div>
    <div class="ig">
      {#if d.client?.os || d.platform}<div class="r"><span class="r-main"><span class="r-tx">{t('系统')}</span><span class="r-d">{d.client?.os || d.platform}</span></span></div>{/if}
      {#if d.hostname}<div class="r"><span class="r-main"><span class="r-tx">{t('主机名')}</span><span class="r-d">{d.hostname}</span></span></div>{/if}
      {#if d.client?.version}<div class="r"><span class="r-main"><span class="r-tx">{t('客户端版本')}</span><span class="r-d num">{d.client.version}</span></span></div>{/if}
      <div class="r"><span class="r-main"><span class="r-tx">{t('类型')}</span><span class="r-d">{d.kind === 'legacy' ? t('老客户端') : t('桌面客户端')}</span></span></div>
      {#if d.sameMachine}<div class="r"><span class="r-main"><span class="r-tx">{t('与服务器是同一台')}</span></span></div>{/if}
    </div>
    <div class="ig">
      {#if d.online}
        <button class="r" type="button" disabled={dev.dvBusy === 'stop'} onclick={() => dev.stopDv(d)}><span class="r-main center"><span class="r-tx">{t('断开')}</span></span></button>
      {/if}
      {#if !d.revoked}
        <button class="r" type="button" disabled={dev.dvBusy === 'revoke'} onclick={() => dev.revokeDv(d)}><span class="r-main center"><span class="r-tx red">{t('吊销')}</span></span></button>
      {:else}
        <button class="r" type="button" disabled={dev.dvBusy === 'delete'} onclick={() => dev.deleteDv(d)}><span class="r-main center"><span class="r-tx red">{t('删除')}</span></span></button>
      {/if}
    </div>
    {@render gfoot(t('吊销后那台电脑立刻断开，要重新登录才能再连。'))}
  {:else}
    {@render gfoot(t('这台设备已不在'))}
  {/if}
{/snippet}

{#snippet pFwdNew()}
  {@render dvMsg()}
  {@render ghead(t('哪台电脑'))}
  <div class="ig">
    {#each dev.dvFwdChoices as o (o.value)}
      <button class="r" type="button" onclick={() => (dev.dvFwdDevice = o.value)}><span class="r-main"><span class="r-tx">{o.label}</span>{#if dev.dvFwdDevice === o.value}{@render check()}{/if}</span></button>
    {/each}
  </div>
  {@render ghead(t('本机端口'))}
  <div class="ig">
    <div class="r"><span class="r-main"><input class="dv-in" bind:value={dev.dvFwdPort} inputmode="numeric" placeholder="5173" /></span></div>
    <div class="r"><span class="r-main"><input class="dv-in" bind:value={dev.dvFwdLabel} placeholder={t('备注（可选）')} /></span></div>
  </div>
  <div class="ig">
    <button class="r" type="button" disabled={dev.dvBusy === 'fwd' || !dev.dvFwdPort} onclick={dev.addFwdDv}><span class="r-main center"><span class="r-tx accent">{t('接通')}</span></span></button>
  </div>
  {@render gfoot(t('只转那台电脑的 127.0.0.1。WebSocket（热更新）暂不转，页面照常能用。'))}
{/snippet}
{#if pid === 'agentapi'}{@render pAgentApi()}
{:else if pid === 'phone'}{@render pPhone()}
{:else if pid === 'devices'}{@render pDevices()}
{:else if pid === 'fwd-new'}{@render pFwdNew()}
{:else if pid.startsWith('device:')}{@render pDevice(pid.slice(7))}
{/if}

<style>
  @import './kit.css';
</style>
