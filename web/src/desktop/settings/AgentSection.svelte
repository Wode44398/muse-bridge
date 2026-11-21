<script>
  // 桌面设置 › 各 agent 的分区（ag-<id>）：头图与启用开关；Claude 另有订阅号池、注册表驱动的设置行、调用策略入口；dimensio 的正文是 DimensioSection。
  // 状态在外壳创建的控制器里（./ctx.js 的 useDesk），这里只画；样式是同一套 kit.css。
  import { useDesk } from './ctx.js';
  import { AG_AUTH_HINT, agStatus } from '../../lib/settings/common.js';
  import ClaudeCliStatus from '../../components/ClaudeCliStatus.svelte';
  import DButton from '../kit/DButton.svelte';
  import DField from '../kit/DField.svelte';
  import DGroup from '../kit/DGroup.svelte';
  import DRow from '../kit/DRow.svelte';
  import DSegmented from '../kit/DSegmented.svelte';
  import DSelect from '../kit/DSelect.svelte';
  import DSwitch from '../kit/DSwitch.svelte';
  import DimensioSection from './DimensioSection.svelte';
  import { loadPage } from '../../modules/pages.js';
  import { S as CS, changed, desc as csDesc, label as csLabel, options as csOptions, resetVal, setVal, val, valueLabel, visible } from '../../lib/claudeSettingsView.js';
  import { accLabel, activateAccount, agentById, ags, apiKeyNote, hhmm, loadUsage, moveAccount, planPill, poolResetAt, poolResetIn, resetsLeft, routeLogSub, routeLogTitle, routeStrategies, routerStrategy, runningOn, setRouter, smartRouting, usageTone, whyText } from '../../lib/agentSettings.svelte.js';
  import { cs } from '../../lib/claudeSettings.svelte.js';
  import { pluginOn, prefs, savePrefs } from '../../lib/state.svelte.js';
  import { t, tr } from '../../lib/i18n.js';
  import { SI } from '../../lib/settingsIcons.js';

  const D = useDesk();
  const { ag, clp, dsp, gen } = D;
  const svgOf = (name, w = 1.6) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${SI[name] || ''}</svg>`;
  const id = $derived(D.sec.slice(3));
  const a = $derived(agentById(id));
  // 枚举项的控件：短的用分段，其余下拉（宽度照官方：一般 160，无关任务 220）
  const SEGMENTED = new Set(['worktreeBaseRef', 'attribution']);
  const SELECT_W = { newSessionPolicy: '220px', crossSessionInbound: '180px', projectThreadModel: '180px' };
  // 权限模式下拉只列这个身份此刻能选的（绕过 / 自动受「安全」组的开关管）
  const csSelectOpts = (key) => csOptions(key).filter((o) => !o.disabled).map((o) => ({ value: o.value, label: o.label }));
</script>
<!-- Claude 设置的一行（注册表驱动）：标题旁「已改过默认值」小点、本机项「这台设备」胶囊、改过时「恢复默认」、
     依赖项缩进；控件按类型出（开关 / 分段 / 下拉 / 压缩点只读值）。沿用 .drow 类，分组卡的发丝线照画 -->
{#snippet crow(key, id)}
  {#if visible(key)}
    <div class="drow cr" class:ind={!!CS[key].dependsOn} class:hl={D.fl(id)}>
      <span class="cr-tx"><span class="cr-t">{csLabel(key)}{#if changed(key)}<i class="chg" title={t('已改过默认值')}></i>{/if}{#if CS[key].scope === 'device'}<span class="pill">{t('这台设备')}</span>{/if}</span></span>
      <span class="cr-tr">
        {#if changed(key)}<button class="cr-reset" aria-label={t('将「{label}」恢复默认', { label: csLabel(key) })} onclick={() => resetVal(key)}>{t('恢复默认')}</button>{/if}
        {#if CS[key].type === 'bool'}
          <DSwitch checked={!!val(key)} disabled={CS[key].scope === 'device' && !gen.notifyOn} onchange={(v) => clp.toggleCs(key, v)} />
        {:else if key === 'compactFrac'}
          <span class="num">{valueLabel(key)}</span>
        {:else if SEGMENTED.has(key)}
          <DSegmented options={csSelectOpts(key)} value={val(key)} onchange={(v) => setVal(key, v)} />
        {:else}
          <DSelect options={csSelectOpts(key)} value={val(key)} onchange={(v) => setVal(key, v)} width={SELECT_W[key] || '160px'} />
        {/if}
      </span>
    </div>
  {/if}
{/snippet}

{#snippet meter(name, b, free = false)}
  <span class="mm"><span class="mh">{name}<b class={b ? usageTone(b) : ''}>{b ? b.pct + '%' : free ? t('无限制') : '—'}</b></span><span class="mb"><i class={b ? usageTone(b) : ''} style:width="{b ? Math.min(100, b.pct) : 0}%"></i></span><span class="mr" title={b ? poolResetIn(b.resetsAt) : ''}>{b ? poolResetAt(b.resetsAt) : ''}</span></span>
{/snippet}

<div class="hero">
  <span class="mark">{#if D.markSrc(id)}<img src={D.markSrc(id)} alt="" draggable="false" />{/if}</span>
  <h2>{D.SEC_TITLE}</h2>
  {#if a && agStatus(a)}<p class:warn={a.runnable && a.switch && !a.authed}>{agStatus(a)}</p>{/if}
</div>
{#if a}
  <DGroup foot={a.runnable && a.switch && !a.authed && AG_AUTH_HINT[id] ? AG_AUTH_HINT[id]() : ''}>
    <DRow title={t('启用 {name}', { name: tr(a.label) })} highlight={D.fl('agents')}>
      {#snippet trailing()}<DSwitch checked={a.switch && a.runnable} disabled={!a.runnable || ags.agentBusy === a.id} onchange={(v) => ag.toggleAgent(a, v)} />{/snippet}
    </DRow>
  </DGroup>
{/if}

{#if id === 'claude'}
  <ClaudeCliStatus />
  {#if ags.poolOk}
    <div class="ghd">
      <h3>{t('订阅号池')}</h3>
      <button class="ico-btn" class:busy={ags.usageBusy} onclick={() => loadUsage(true)} disabled={ags.usageBusy} title={ags.usageBusy ? t('刷新中…') : t('刷新用量')}>{@html svgOf('refresh', 1.8)}</button>
    </div>
    <!-- 服务端标 source:'last-use' 时，用量是各号上次使用时的，脚注里说一句 -->
    <DGroup foot={[apiKeyNote(), Object.values(ags.usage || {}).some((u) => u?.source === 'last-use') ? t('闲置的号显示它上次使用时的额度；还没用过的号要用过一次才有数据。') : ''].filter(Boolean).join(' ')}>
      <div class="pool" class:hl-line={D.fl('pool')}>
        {#each ags.accounts as acc, i (acc.id)}
          {@const u = ags.usage[acc.id]}
          <div class="drow prow">
            <div class="pmain">
              <div class="pname">
                <b>{accLabel(acc.label)}</b>
                {#if planPill(u?.plan)}<span class="pill">{planPill(u.plan)}</span>{/if}
                <!-- 智能分派下没有「全局在用的号」：标这个号上在跑几个任务 -->
                {#if smartRouting()}{#if runningOn(acc.id)}<span class="cur">{t('在跑 {n} 个任务', { n: runningOn(acc.id) })}</span>{/if}{:else if acc.active}<span class="cur">{t('使用中')}</span>{/if}
                <!-- 重置卡：服务端有这项能力才出现；读到有可用的卡就带上张数 -->
                {#if ags.resetsOk}
                  {@const n = resetsLeft(ags.resets[acc.id])}
                  <button class="rcchip" class:has={n > 0} onclick={() => { ag.acctResets = acc; }}>{n > 0 ? t('重置卡 {n}', { n }) : t('重置卡')}</button>
                {/if}
              </div>
              <div class="mini">
                {#if !u}<span class="mna">{ags.usageBusy ? t('读取用量…') : (acc.hasToken ? '…' + (acc.tokenTail || '') : t('用本机登录态（~/.claude）'))}</span>
                {:else if u.error && !u.five_hour && !u.seven_day}<span class="mna bad">{tr(u.error)}</span>
                {:else}
                  {@render meter(t('5 小时'), u.five_hour, !!u.no_five_hour)}
                  {@render meter(t('每周'), u.seven_day)}
                  {@render meter('Fable', u.fable)}
                {/if}
              </div>
            </div>
            <div class="pacts">
              {#if !acc.active && !smartRouting()}<DButton size="sm" onclick={() => activateAccount(acc)}>{t('切到此号')}</DButton>{/if}
              <span class="tools">
                {#if ags.accounts.length > 1}
                  <button class="ico-btn" disabled={i === 0} onclick={() => moveAccount(acc, -1)} title={t('上移')}>{@html svgOf('up', 1.8)}</button>
                  <button class="ico-btn" disabled={i === ags.accounts.length - 1} onclick={() => moveAccount(acc, 1)} title={t('下移')}>{@html svgOf('down', 1.8)}</button>
                {/if}
                <button class="ico-btn" onclick={() => ag.openEditAcct(acc)} title={t('编辑账号')}>{@html svgOf('edit', 1.7)}</button>
                {#if ags.accounts.length > 1}<button class="ico-btn danger" onclick={() => { ag.acctDel = acc; }} title={t('删除账号')}>{@html svgOf('trash', 1.7)}</button>{/if}
              </span>
            </div>
          </div>
        {/each}
        <button class="drow addrow" onclick={ag.openAddAcct}>{@html svgOf('plus', 1.8)}{t('添加账号')}</button>
      </div>
    </DGroup>
    {#if ags.err}<p class="err">{ags.err}</p>{/if}

  {/if}

  <!-- 撞上限额时：按身份的续跑默认 + 号池智能路由（管理员）；依赖项缩进紧跟主项 -->
  <DGroup label={t('撞上限额时')}>
    {@render crow('autoContinueOnLimit', 'climit')}
    {#if ags.poolOk}
      <DRow title={t('额度用尽自动换号')} sub={ags.accounts.length < 2 ? t('号池里至少要有两个账号才用得上') : ''} highlight={D.fl('router')}>
        {#snippet trailing()}<DSwitch checked={ag.routerOn} disabled={!ags.router || ags.routerBusy} onchange={(v) => setRouter({ enabled: v })} />{/snippet}
      </DRow>
      {#if ag.routerOn}
        <div class="drow cr ind">
          <span class="cr-tx"><span class="cr-t">{t('分派方式')}</span><span class="cr-s">{routeStrategies().find((o) => o.value === routerStrategy())?.desc}</span></span>
          <span class="cr-tr"><DSelect options={routeStrategies().map((o) => ({ value: o.value, label: o.label }))} value={routerStrategy()} onchange={(v) => setRouter({ strategy: v })} width="160px" /></span>
        </div>
        <div class="drow cr ind">
          <span class="cr-tx"><span class="cr-t">{t('会话中无缝换号')}</span><span class="cr-s">{smartRouting() ? t('任务跑到一半、所在的号快用满或撞墙时，在两步之间把它换到别的号，对话不中断') : t('快用满时在两步之间换号，进行中的对话不中断')}</span></span>
          <span class="cr-tr"><DSwitch checked={!!ags.router.settings.seamless} disabled={ags.routerBusy} onchange={(v) => setRouter({ seamless: v })} /></span>
        </div>
      {/if}
    {/if}
  </DGroup>
  {#if ags.poolOk && ag.routerOn && ags.router.log?.length}
    <DGroup label={smartRouting() ? t('最近的分派') : t('最近的自动切换')}>
      {#each ags.router.log as l, i (l.at + ':' + i)}
        <!-- 智能分派的记录带 kind：标题是哪个对话，说明是模型 · 去了哪个号 · 理由；老策略的记录照旧「A → B」 -->
        {#if l.kind}
          <DRow title={routeLogTitle(l)} sub={routeLogSub(l, (rid, fb) => accLabel(ag.acctById(rid)?.label || fb))}>
            {#snippet trailing()}<span class="num">{hhmm(l.at)}</span>{/snippet}
          </DRow>
        {:else}
          <DRow title="{accLabel(ag.acctById(l.from)?.label || l.fromLabel)} → {accLabel(ag.acctById(l.to)?.label || l.toLabel)}" sub={whyText(l.reason)}>
            {#snippet trailing()}<span class="num">{hhmm(l.at)}</span>{/snippet}
          </DRow>
        {/if}
      {/each}
    </DGroup>
  {/if}

  <!-- 服务意外重启时：上一条命没跑完的轮，服务恢复后自动接着做（src/runtime/restart-resume.mjs） -->
  <DGroup label={t('服务意外重启时')}>
    {@render crow('autoResumeOnRestart', 'crestart')}
  </DGroup>

  <!-- 新会话默认：会话里可以单独改（模式菜单 / 加号菜单的输出风格） -->
  <DGroup label={t('新会话默认')}>
    {@render crow('permissionMode', 'cdef-perm')}
    {@render crow('outputStyle', 'cdef-style')}
    {#if cs.shell}
      <div class="drow cr">
        <span class="cr-tx"><span class="cr-t">{t('用工作树')}<span class="pill">{t('这台设备')}</span></span></span>
        <span class="cr-tr"><DSwitch checked={prefs.worktree} onchange={(v) => { prefs.worktree = v; savePrefs(); }} /></span>
      </div>
    {/if}
  </DGroup>

  <DGroup label={t('对话')}>
    {@render crow('promptSuggestions', 'suggest')}
    {@render crow('inlineVisualizations', 'cviz')}
    {@render crow('enableWorkflows', 'cwf')}
    {#if dsp.dpShown}
      <!-- 子 agent 调用策略：与「动态工作流」同级（普通子 agent 那个范围不靠它）。一行两块命中区——行按钮（标题 + 状态副标题）
           的命中区铺满整行、点了进子页；开关那一块压在它上面，四周留一圈不响应的边，点偏了既不进子页也不拨开关。
           关着时这一行不置灰：照样能点进去看 -->
      <div class="drow cr dpr" class:hl={D.fl('cdispatch')} role="group" aria-label={t('子 agent 调用策略')}>
        <button class="dpr-go" onclick={() => D.navigate('ag-claude#dispatch')}>
          <span class="cr-t">{t('子 agent 调用策略')}</span>
          <span class="cr-s" class:bad={!!dsp.dpRowErr}>{#if dsp.dpRowErr || dsp.dpSub}{dsp.dpRowErr || dsp.dpSub}{:else}&nbsp;{/if}</span>
        </button>
        <!-- 策略读到了才摆开关（位置先占着）：不然它会先以「关」露面、再滑到「开」。{#key}：没存上时让开关弹回原位 -->
        <span class="dpr-sw">
          {#if dsp.dp?.policy}{#key dsp.dpSwKey}<DSwitch checked={!!dsp.dp.policy.enabled} disabled={dsp.dp.canEdit === false} onchange={dsp.toggleDispatch} />{/key}{/if}
        </span>
        <svg class="dpr-chev" viewBox="0 0 6 10" width="6" height="10" aria-hidden="true">
          <path d="M1 1l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </div>
    {/if}
    {@render crow('switchModelsOnFlag', 'cflag')}
    {@render crow('planClearContext', 'cplan')}
    {@render crow('questionTimeout', 'cqto')}
    {@render crow('replyLanguage', 'clang')}
    {@render crow('cacheExpiry', 'ccache')}
    {@render crow('compactFrac', 'ccompact')}
    <div class="drow cr" class:hl={D.fl('thinkmark')}>
      <span class="cr-tx"><span class="cr-t">{t('思考动画')}<span class="pill">{t('这台设备')}</span></span></span>
      <span class="cr-tr">
        <DSelect options={gen.markOpts} value={prefs.claudeMark} onchange={gen.onClaudeMark} width="170px" />
      </span>
    </div>
  </DGroup>

  {#if visible('newSessionPolicy') || visible('crossSessionInbound')}
    <DGroup label={t('会话协作')}>
      {@render crow('newSessionPolicy', 'cnewsess')}
      {@render crow('crossSessionInbound', 'cinbound')}
    </DGroup>
  {/if}

  <!-- 项目对话（运行档位 › 项目：协调者只派活、讨论串去做，src/runtime/project-mode.mjs） -->
  {#if visible('projectAskFirst')}
    <DGroup label={t('项目对话')}>
      {@render crow('projectAskFirst', 'cpask')}
      {@render crow('projectMaxLive', 'cpmax')}
      {@render crow('projectDailyThreads', 'cpdaily')}
      {@render crow('projectThreadModel', 'cpmodel')}
      {@render crow('projectThreadEffort', 'cpeffort')}
    </DGroup>
  {/if}

  {#if cs.shell}
    <DGroup label={t('Git 与拉取请求')}>
      <div class="drow cr" class:hl={D.fl('cbranch')}>
        <span class="cr-tx"><span class="cr-t">{csLabel('branchPrefix')}{#if changed('branchPrefix')}<i class="chg" title={t('已改过默认值')}></i>{/if}</span>{#if clp.prefixErr}<span class="cr-s bad">{clp.prefixErr}</span>{/if}</span>
        <span class="cr-tr">
          {#if changed('branchPrefix')}<button class="cr-reset" onclick={() => { clp.prefixErr = ''; resetVal('branchPrefix'); }}>{t('恢复默认')}</button>{/if}
          {#key cs.values.branchPrefix}<DField value={changed('branchPrefix') ? val('branchPrefix') : ''} placeholder="claude" width="220px" onchange={clp.savePrefix} />{/key}
        </span>
      </div>
      {@render crow('worktreeBaseRef', 'cwtbase')}
      {@render crow('autoFixPullRequests', 'cautofix')}
      {@render crow('autoArchiveOnPrClose', 'cprarchive')}
      {@render crow('attribution', 'cattrib')}
    </DGroup>
  {/if}

  <DGroup label={t('会话管理')}>
    {@render crow('autoArchiveDays', 'carchive')}
    {@render crow('quickRetention', 'cquick')}
    {@render crow('followDesktopArchive', 'cdesk')}
  </DGroup>

  <DGroup label={t('通知')} foot={gen.notifyOn ? '' : t('通知总开关在「通用」里关着')}>
    {@render crow('notifyPermission', 'cn-perm')}
    {@render crow('notifyQuestion', 'cn-q')}
    {@render crow('notifyTaskComplete', 'cn-done')}
    {@render crow('notifyError', 'cn-err')}
  </DGroup>

  {#if cs.admin}
    <!-- 这一组眼下只有保持唤醒两项：服务端说这台机器做不到（非 Windows）时整组不出 -->
    {#if visible('keepAwake')}
      <DGroup label={t('这台电脑')}>
        {@render crow('keepAwake', 'cawake')}
        {@render crow('keepAwakeOnBattery', 'cawake')}
      </DGroup>
    {/if}
    <DGroup label={t('扩展与记忆')}>
      {#if ag.extOk}
        <DRow title={t('技能')} onclick={() => D.openExtType('skill')} />
        {#if !ag.extMember}
          <DRow title={t('连接器')} onclick={() => D.openExtType('connector')} />
          <DRow title={t('插件')} onclick={() => D.openExtType('plugin')} />
        {/if}
      {/if}
      {#if pluginOn('routines')}<DRow title={t('定时任务')} onclick={D.openRoutinesPage} />{/if}
    </DGroup>
    <!-- 安全：危险项置底；打开「绕过」走确认框（{#key} 让取消后开关弹回原位） -->
    <DGroup label={t('安全')}>
      {#key clp.bypassAsk}{@render crow('allowBypass', 'cbypass')}{/key}
      {@render crow('allowAutoMode', 'cauto')}
    </DGroup>
    <!-- 调试（改进 harness 用，v558 起注册表就有、外壳漏渲染）：只给主机管理员，说明放组脚 -->
    {#if visible('debugMode')}
      <DGroup label={t('调试')} foot={csDesc('debugMode')}>
        {@render crow('debugMode', 'cdebug')}
      </DGroup>
    {/if}
  {/if}
  {#if clp.clErr}<p class="err">{clp.clErr}</p>{/if}
{/if}

{#if id === 'dimensio'}
  <!-- 管理员：开关关着 / 这台机器跑不起来时不去打 harness（原因在头图下）；成员能看到这一分区就是有权限 -->
  <DimensioSection fl={D.fl} enabled={!a || (a.switch && a.runnable)} openExt={D.openExtType} openDispatch={() => D.navigate('ag-dimensio#dispatch')} />
{/if}

{#if id === 'agy' && a}
  {#await loadPage.agyDeskSettings() then m}
    <m.default fl={D.fl} enabled={Boolean(a.switch && a.runnable)} />
  {:catch}
    <p class="note">{t('Antigravity 设置没加载出来：这台服务器可能没装 Antigravity 扩展。')}</p>
  {/await}
{/if}

{#if !a && id !== 'claude' && id !== 'dimensio'}<p class="note">{t('只有管理员能改这里')}</p>{/if}

<style>
  @import './kit.css';
</style>
