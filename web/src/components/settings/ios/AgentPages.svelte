<script>
  // 设置 › Agent 分组的各页（iOS 外壳）：Claude 页与它推入的子页（单选项、折叠组、号池里的一个账号、思考动画、调用策略的空位），
  // dimensio 页与它的子页，其它 agent 的开关页，Media Studio，模型中心，额度与注册。状态在外壳创建的控制器里（./ctx.js），这里只画页面。
  import { useSettings, svgOf } from './ctx.js';
  import { CL_CHOICE, CL_GROUP } from './claude.svelte.js';
  import { DISPATCH_PAGES } from './dispatch.svelte.js';
  import { AG_AUTH_HINT, agStatus, studioStatus } from '../../../lib/settings/common.js';
  import ClaudeCliStatus from '../../ClaudeCliStatus.svelte';
  import ClaudeLogo from '../../ClaudeLogo.svelte';
  import ClaudeResets from '../../ClaudeResets.svelte';
  import ClaudeSpriteMark from '../../ClaudeSpriteMark.svelte';
  import ClaudeWorkingMark from '../../ClaudeWorkingMark.svelte';
  import Sym from '../../ios27/Sym.svelte';
  import Toggle from '../../ios27/Toggle.svelte';
  import { ACCESS, FEED_DESC, MODES, accessLocked, dimReady, extOk as dmExtOk, ds, errOf, exportDiag, feed, hasCap, loadDimensio, mcpLine, memLine, memoryOk, openInDimensio, prefChanged, prefDesc, prefGroupLabel, prefGroups, prefItems, prefLabel, prefOptions, prefValueLabel, removeRule, rulesOf, sessionTitle, setAccess, setFeedDetail, setMode, setPref, skillLine, versionLine } from '../../../lib/dimensioSettings.svelte.js';
  import { S as CS, changed, label as csLabel, options as csOptions, resetVal, setVal, val, valueLabel, visible } from '../../../lib/claudeSettingsView.js';
  import { accLabel, activateAccount, agentById, ags, apiKeyNote, hhmm, loadUsage, moveAccount, planPill, poolResetAt, poolResetIn, resetsLeft, routeLogSub, routeLogTitle, routeStrategies, routerStrategy, runningOn, savePolicy, setRouter, smartRouting, usageTone, whyText } from '../../../lib/agentSettings.svelte.js';
  import { cs } from '../../../lib/claudeSettings.svelte.js';
  import { hubSummaryText } from '../../../lib/modelHub.svelte.js';
  import { loadPage, resolvedPage } from '../../../modules/pages.js';
  import { bodies, loadHubHome } from '../../../lib/settings/bodies.svelte.js';
  import { me, pluginOn, prefs, savePrefs } from '../../../lib/state.svelte.js';
  import { t, tc, tr } from '../../../lib/i18n.js';
  import { swap } from '../../../lib/arrive.js';

  let { pid } = $props();
  const S = useSettings();
  const { ag, agy, cl, dm, dp, gen, nav, pol, pool, st } = S;
</script>
{#snippet chev()}<Sym name="chevron.right" weight={600} size={13} class="chev" />{/snippet}
{#snippet check()}<Sym name="checkmark" weight={600} size={15} class="ck" />{/snippet}
{#snippet gfoot(text)}<p class="gfoot">{text}</p>{/snippet}
{#snippet ghead(text)}<h2 class="ghead">{text}</h2>{/snippet}

<!-- ─────────────── Agent 页 ─────────────── -->
<!-- 开关 + 认证状态（管理员）：每个 agent 页最上面那一组 -->
{#snippet agSwitch(id)}
  {@const a = agentById(id)}
  <div class="hero">
    <span class="hero-mark">{#if ag.markSrc(id)}<img src={ag.markSrc(id)} alt="" draggable="false" />{/if}</span>
    <div class="hero-name">{nav.titleOf('ag-' + id)}</div>
    {#if a && agStatus(a)}<div class="hero-sub" class:warn={a.runnable && a.switch && !a.authed}>{agStatus(a)}</div>{/if}
  </div>
  {#if a}
    <div class="ig">
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('启用 {name}', { name: a.label })}</span>
          <Toggle checked={a.switch && a.runnable} disabled={!a.runnable || ags.agentBusy === a.id} onchange={() => ag.toggleAgent(a)} label={t('启用 {name}', { name: a.label })} /></span>
      </div>
    </div>
    {#if a.runnable && a.switch && !a.authed && AG_AUTH_HINT[id]}{@render gfoot(AG_AUTH_HINT[id]())}{/if}
  {/if}
{/snippet}

{#snippet agErr()}{#if ags.err}<p class="gfoot err">{ags.err}</p>{/if}{/snippet}

{#snippet meter(name, b, na, free = false)}
  <div class="u">
    <div class="u-top"><span class="u-l">{name}</span><span class="u-v" class:hot={b && usageTone(b) === 'red'}>{b ? t('{pct}% 已用', { pct: b.pct }) : free ? t('无限制') : '—'}</span></div>
    <span class="bar-u">{#if b}<i style:width="{Math.min(100, b.pct)}%" class:hot={usageTone(b) === 'red'} class:warm={usageTone(b) === 'amber'}></i>{/if}</span>
    {#if b}<span class="u-r">{b.status === 'rejected' ? t('已达上限') + ' · ' : ''}{poolResetIn(b.resetsAt)}</span>{:else if na}<span class="u-r">{na}</span>{/if}
  </div>
{/snippet}

{#snippet pClaude()}
  {@render agSwitch('claude')}
  <ClaudeCliStatus />
  {#if ags.poolOk}
    <div class="ghead-row">
      {@render ghead(t('订阅号池'))}
      <button class="gh-ico" class:busy={ags.usageBusy} type="button" onclick={() => loadUsage(true)} disabled={ags.usageBusy} aria-label={ags.usageBusy ? t('刷新中…') : t('刷新用量')}>{@html svgOf('refresh', 1.8)}</button>
    </div>
    <div class="ig">
      {#each ags.accounts as a (a.id)}
        {@const u = ags.usage[a.id]}
        <button class="r acct-r" type="button" onclick={() => nav.push('acct:' + a.id)}>
          <span class="r-main">
            <span class="r-tx">
              <span class="acct-name">{accLabel(a.label)}
                {#if planPill(u?.plan)}<span class="pill">{planPill(u.plan)}</span>{/if}
                <!-- 智能分派下没有「全局在用的号」：标这个号上在跑几个任务 -->
                {#if smartRouting()}{#if runningOn(a.id)}<span class="cur">{t('在跑 {n} 个任务', { n: runningOn(a.id) })}</span>{/if}{:else if a.active}<span class="cur">{t('使用中')}</span>{/if}
                {#if ags.resetsOk && resetsLeft(ags.resets[a.id]) > 0}<span class="pill">{t('重置卡 {n}', { n: resetsLeft(ags.resets[a.id]) })}</span>{/if}
              </span>
              <span class="mini">
                {#if !u && ags.usageBusy}
                  <!-- 用量还在路上：先按到齐后的样子占好三格（同样的行高），回来只是数字填进去，整组不会被撑高一截 -->
                  {#each [t('5 小时'), t('每周'), 'Fable'] as name (name)}
                    <span class="mini-m pend" aria-hidden="true"><span class="mini-h">{name}<b>—</b></span><span class="mini-bar"><i style:width="0%"></i></span><span class="mini-r">&nbsp;</span></span>
                  {/each}
                {:else if !u}<span class="mini-na">{a.hasToken ? '…' + (a.tokenTail || '') : t('用本机登录态（~/.claude）')}</span>
                {:else if u.error && !u.five_hour && !u.seven_day}<span class="mini-na err">{tr(u.error)}</span>
                {:else}
                  {#each [['five_hour', t('5 小时')], ['seven_day', t('每周')], ['fable', 'Fable']] as [k, name] (k)}
                    {@const b = u[k]}
                    {@const free = !b && k === 'five_hour' && u.no_five_hour}
                    <span class="mini-m"><span class="mini-h">{name}<b class={b ? usageTone(b) : ''}>{b ? b.pct + '%' : free ? t('无限制') : '—'}</b></span><span class="mini-bar"><i class={b ? usageTone(b) : ''} style:width="{b ? Math.min(100, b.pct) : 0}%"></i></span><span class="mini-r">{b ? poolResetAt(b.resetsAt) : ''}</span></span>
                  {/each}
                {/if}
              </span>
            </span>
            {@render chev()}
          </span>
        </button>
      {/each}
      <button class="r add" type="button" onclick={pool.openAddAcct}>
        <span class="r-main"><span class="r-tx accent">{t('添加账号')}</span></span>
      </button>
    </div>
    {#if apiKeyNote()}{@render gfoot(apiKeyNote())}{/if}
    <!-- 服务端标 source:'last-use' 时，用量是各号上次使用时的，说一句免得以为是实时的 -->
    {#if Object.values(ags.usage || {}).some((u) => u?.source === 'last-use')}{@render gfoot(t('闲置的号显示它上次使用时的额度；还没用过的号要用过一次才有数据。'))}{/if}
    {@render agErr()}

  {/if}

  <!-- 自定义 API（模型服务）归设置根页的「模型中心」一页管（模型中心 v2），这里不再放入口 -->

  <!-- 撞上限额时：按身份的「限额重置后自动继续」+ 号池智能路由（管理员）；号池最常看，限额相关三件事聚在它后面 -->
  {@render ghead(t('撞上限额时'))}
  <div class="ig">
    {@render cToggle('autoContinueOnLimit')}
    {#if ags.poolOk}
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('额度用尽自动换号')}{#if ags.accounts.length < 2}<span class="r-sub">{t('号池里至少要有两个账号才用得上')}</span>{/if}</span>
          <Toggle checked={pool.routerOn} disabled={!ags.router || ags.routerBusy} onchange={() => setRouter({ enabled: !pool.routerOn })} label={t('额度用尽自动换号')} /></span>
      </div>
      {#if pool.routerOn}
        <!-- 分派方式：三选一，行内打勾（同系统设置里的单选组） -->
        {#each routeStrategies() as o (o.value)}
          <button class="r ind" type="button" disabled={ags.routerBusy} onclick={() => { if (routerStrategy() !== o.value) setRouter({ strategy: o.value }); }}>
            <span class="r-main"><span class="r-tx">{o.label}<span class="r-sub">{o.desc}</span></span>{#if routerStrategy() === o.value}{@render check()}{/if}</span>
          </button>
        {/each}
        <div class="r ind">
          <span class="r-main"><span class="r-tx">{t('会话中无缝换号')}<span class="r-sub">{smartRouting() ? t('任务跑到一半、所在的号快用满或撞墙时，在两步之间把它换到别的号，对话不中断') : t('快用满时在两步之间换号，进行中的对话不中断')}</span></span>
            <Toggle checked={!!ags.router.settings.seamless} disabled={ags.routerBusy} onchange={() => setRouter({ seamless: !ags.router.settings.seamless })} label={t('会话中无缝换号')} /></span>
        </div>
      {/if}
    {/if}
  </div>
  {#if ags.poolOk && pool.routerOn && ags.router.log?.length}
    {@render ghead(smartRouting() ? t('最近的分派') : t('最近的自动切换'))}
    <div class="ig">
      {#each ags.router.log as l, i (l.at + ':' + i)}
        {#if l.kind}
          <div class="r"><span class="r-main"><span class="r-tx">{routeLogTitle(l)}<span class="r-sub">{routeLogSub(l, (rid, fb) => accLabel(pool.acctById(rid)?.label || fb))}</span></span><span class="r-d num">{hhmm(l.at)}</span></span></div>
        {:else}
          <div class="r"><span class="r-main"><span class="r-tx">{accLabel(pool.acctById(l.from)?.label || l.fromLabel)} → {accLabel(pool.acctById(l.to)?.label || l.toLabel)}<span class="r-sub">{whyText(l.reason)}</span></span><span class="r-d num">{hhmm(l.at)}</span></span></div>
        {/if}
      {/each}
    </div>
  {/if}

  <!-- 服务意外重启时：上一条命没跑完的轮，服务恢复后自动接着做（src/runtime/restart-resume.mjs） -->
  {@render ghead(t('服务意外重启时'))}
  <div class="ig">
    {@render cToggle('autoResumeOnRestart')}
  </div>

  <!-- 新会话默认：会话里可以单独改（输入框的模式菜单 / 加号菜单的输出风格），改的只是那个会话 -->
  {@render ghead(t('新会话默认'))}
  <div class="ig">
    {@render cPush('permissionMode', 'cl-perm')}
    {@render cPush('outputStyle', 'cl-style')}
    {#if cs.shell}
      <div class="r">
        <span class="r-main"><span class="r-tx"><span class="r-lbl">{t('用工作树')}{@render devPill()}</span></span>
          <Toggle checked={prefs.worktree} onchange={() => { prefs.worktree = !prefs.worktree; savePrefs(); }} label={t('用工作树')} /></span>
      </div>
    {/if}
  </div>

  {@render ghead(t('对话'))}
  <div class="ig">
    {@render cToggle('promptSuggestions')}
    {@render cToggle('inlineVisualizations')}
    {@render cToggle('enableWorkflows')}
    {#if dp.dpShown}
      <!-- 子 agent 调用策略：与「动态工作流」同级（普通子 agent 那个范围不靠它）。一行两块命中区——行按钮（标题 + 状态副标题）的命中区
           铺满整行、点了推入子页；开关那一块压在它上面，四周留一圈不响应的边，按偏了既不进子页也不拨开关。
           关着时这一行不置灰：照样能点进去看 -->
      <div class="r dpr" role="group" aria-label={t('子 agent 调用策略')}>
        <span class="r-main">
          <button class="dpr-go" type="button" onclick={() => nav.push('cl-dispatch')}>
            <span class="r-tx">{t('子 agent 调用策略')}<span class="r-sub" class:err={!!dp.dpRowErr}>{#if dp.dpRowErr || dp.dpSub}{dp.dpRowErr || dp.dpSub}{:else}&nbsp;{/if}</span></span>
          </button>
          <!-- 策略读到了才摆开关（位置先占着）：不然它会先以「关」露面、再滑到「开」 -->
          <span class="dpr-sw">{#if dp.dp?.policy}<Toggle checked={!!dp.dp.policy.enabled} disabled={dp.dp.canEdit === false} onchange={dp.toggleDispatch} label={t('按策略调用')} />{/if}</span>
          {@render chev()}
        </span>
      </div>
    {/if}
    {@render cToggle('switchModelsOnFlag')}
    {@render cToggle('planClearContext')}
    {@render cPush('questionTimeout', 'cl-qto')}
    {@render cPush('replyLanguage', 'cl-lang')}
    {@render cPush('cacheExpiry', 'cl-cache')}
    {#if changed('compactFrac')}
      <button class="r" type="button" onclick={() => resetVal('compactFrac')}>
        <span class="r-main"><span class="r-tx"><span class="r-lbl">{csLabel('compactFrac')}{@render cDot('compactFrac')}</span></span><span class="r-d num">{valueLabel('compactFrac')}</span><span class="r-d accent">{t('恢复默认')}</span></span>
      </button>
    {/if}
    <button class="r" type="button" onclick={() => nav.push('thinkmark')}>
      <span class="r-main"><span class="r-tx"><span class="r-lbl">{t('思考动画')}{@render devPill()}</span></span><span class="r-d">{cl.markLabel}</span>{@render chev()}</span>
    </button>
  </div>

  {#if visible('newSessionPolicy') || visible('crossSessionInbound')}
    {@render ghead(t('会话协作'))}
    <div class="ig">
      {@render cPush('newSessionPolicy', 'cl-newsess')}
      {@render cPush('crossSessionInbound', 'cl-inbound')}
    </div>
  {/if}

  <!-- 项目对话（运行档位 › 项目：协调者只派活、讨论串去做，src/runtime/project-mode.mjs） -->
  {#if visible('projectAskFirst')}
    {@render ghead(t('项目对话'))}
    <div class="ig">
      {@render cToggle('projectAskFirst')}
      {@render cPush('projectMaxLive', 'cl-pmax')}
      {@render cPush('projectDailyThreads', 'cl-pdaily')}
      {@render cPush('projectThreadModel', 'cl-pmodel')}
      {@render cPush('projectThreadEffort', 'cl-peffort')}
    </div>
  {/if}

  <!-- 不常改的整组折成推入行 -->
  <div class="ig">
    {#if cs.shell}
      <button class="r" type="button" onclick={() => nav.push('cl-git')}>
        <span class="r-main"><span class="r-tx"><span class="r-lbl">{t('Git 与拉取请求')}{#if cl.GIT_KEYS.some(changed)}{@render cDot('')}{/if}</span></span>{@render chev()}</span>
      </button>
    {/if}
    <button class="r" type="button" onclick={() => nav.push('cl-sessions')}>
      <span class="r-main"><span class="r-tx"><span class="r-lbl">{t('会话管理')}</span></span><span class="r-d">{val('autoArchiveDays') ? valueLabel('autoArchiveDays') : ''}</span>{@render chev()}</span>
    </button>
    <button class="r" type="button" onclick={() => nav.push('cl-notify')}>
      <span class="r-main"><span class="r-tx"><span class="r-lbl">{t('通知')}{@render devPill()}</span></span><span class="r-d">{gen.notifyOn ? '' : tc('开关', '关闭')}</span>{@render chev()}</span>
    </button>
    {#if cs.admin}
      <!-- 这一组眼下只有保持唤醒两项：服务端说这台机器做不到（非 Windows）时整组入口不出 -->
      {#if visible('keepAwake')}
        <button class="r" type="button" onclick={() => nav.push('cl-host')}>
          <span class="r-main"><span class="r-tx">{t('这台电脑')}</span><span class="r-d">{val('keepAwake') ? t('保持唤醒') : ''}</span>{@render chev()}</span>
        </button>
      {/if}
      <button class="r" type="button" onclick={() => nav.push('cl-ext')}>
        <span class="r-main"><span class="r-tx">{t('扩展与记忆')}</span>{@render chev()}</span>
      </button>
    {/if}
  </div>

  {#if cs.admin}
    <!-- 安全：危险项置底；绕过权限打开前走确认框 -->
    {@render ghead(t('安全'))}
    <div class="ig">
      {@render cToggle('allowBypass')}
      {@render cToggle('allowAutoMode')}
    </div>
    <!-- 调试（改进 harness 用，v558 起注册表就有、外壳漏渲染）：只给主机管理员 -->
    {#if visible('debugMode')}
      {@render ghead(t('调试'))}
      <div class="ig">
        {@render cToggle('debugMode')}
      </div>
      {@render gfoot(t(CS.debugMode.desc))}
    {/if}
  {/if}
  {#if cl.clErr}<p class="gfoot err">{cl.clErr}</p>{/if}
{/snippet}

<!-- Claude 设置的行零件：标签旁「已改过默认值」小点、本机项「这台设备」胶囊、开关行、推入行（行尾当前值） -->
{#snippet cDot(key)}{#if !key || changed(key)}<span class="chg" role="img" aria-label={t('已改过默认值')} title={t('已改过默认值')}></span>{/if}{/snippet}
{#snippet devPill()}<span class="pill dev">{t('这台设备')}</span>{/snippet}
{#snippet cToggle(key)}
  {#if visible(key)}
    <div class="r" class:ind={!!CS[key].dependsOn}>
      <span class="r-main"><span class="r-tx"><span class="r-lbl">{csLabel(key)}{@render cDot(key)}{#if CS[key].scope === 'device'}{@render devPill()}{/if}</span></span>
        <Toggle checked={!!val(key)} disabled={CS[key].scope === 'device' && !gen.notifyOn} onchange={() => cl.toggleCs(key)} label={csLabel(key)} /></span>
    </div>
  {/if}
{/snippet}
{#snippet cPush(key, pid)}
  {#if visible(key)}
    <button class="r" type="button" onclick={() => nav.push(pid)}>
      <span class="r-main"><span class="r-tx"><span class="r-lbl">{csLabel(key)}{@render cDot(key)}</span></span><span class="r-d">{valueLabel(key)}</span>{@render chev()}</span>
    </button>
  {/if}
{/snippet}

<!-- 子 agent 调用策略（推入页 'cl-dispatch'）：大标题与返回钮归外壳。页面里只有一个空位——正文（懒加载的
     claude/dispatch/DispatchPolicy）挂在外壳面板里两种布局的分支之外（.dp-host），由脚本里 dpHost / nav.dpSlot 那段挪进来：
     单栏 / 双栏切换时页面整组重挂，正文不跟着重挂 -->
{#snippet pDispatch()}
  <div class="dp-slot" bind:this={nav.dpSlot}></div>
{/snippet}

<!-- 单选子页（权限模式 / 输出风格 / 提问超时 / 回复语言 / …）：每项一行说明，选中打勾；改过才出「恢复默认」 -->
{#snippet pChoice(key)}
  <div class="ig">
    {#each csOptions(key) as o (o.value)}
      <button class="r" type="button" disabled={o.disabled} onclick={() => setVal(key, o.value)}>
        <span class="r-main"><span class="r-tx">{o.label}{#if o.note}<span class="r-sub">{o.note}</span>{:else if o.desc}<span class="r-sub">{o.desc}</span>{/if}</span>{#if String(val(key)).toLowerCase() === String(o.value).toLowerCase()}{@render check()}{/if}</span>
      </button>
    {/each}
  </div>
  {#if changed(key)}
    <div class="ig"><button class="r" type="button" onclick={() => resetVal(key)}><span class="r-main center"><span class="r-tx accent">{t('恢复默认')}</span></span></button></div>
  {/if}
  {#if cl.clErr}<p class="gfoot err">{cl.clErr}</p>{/if}
{/snippet}

<!-- 推入组页：Git 与拉取请求 / 会话管理 / 通知 / 这台电脑 / 扩展与记忆 -->
{#snippet pClGroup(pid)}
  {#if pid === 'cl-git'}
    <div class="ig">
      <button class="r" type="button" onclick={cl.openPrefix}>
        <span class="r-main"><span class="r-tx"><span class="r-lbl">{csLabel('branchPrefix')}{@render cDot('branchPrefix')}</span></span><span class="r-d">{valueLabel('branchPrefix')}</span>{@render chev()}</span>
      </button>
      {@render cPush('worktreeBaseRef', 'cl-base')}
      {@render cToggle('autoFixPullRequests')}
      {@render cToggle('autoArchiveOnPrClose')}
      {@render cPush('attribution', 'cl-attrib')}
    </div>
  {:else if pid === 'cl-sessions'}
    <div class="ig">
      {@render cPush('autoArchiveDays', 'cl-archive')}
      {@render cPush('quickRetention', 'cl-quick')}
      {@render cToggle('followDesktopArchive')}
    </div>
  {:else if pid === 'cl-notify'}
    <div class="ig">
      {@render cToggle('notifyPermission')}
      {@render cToggle('notifyQuestion')}
      {@render cToggle('notifyTaskComplete')}
      {@render cToggle('notifyError')}
    </div>
    {#if !gen.notifyOn}{@render gfoot(t('通知总开关在「通用」里关着'))}{:else}{@render gfoot(t('声音、振动和横幅在「通用 › 通知」里设置'))}{/if}
  {:else if pid === 'cl-host'}
    <div class="ig">
      {@render cToggle('keepAwake')}
      {@render cToggle('keepAwakeOnBattery')}
    </div>
  {:else if pid === 'cl-ext'}
    <div class="ig">
      <!-- 扩展中心探针没过（服务端没开扩展）就只剩定时任务 -->
      {#if S.ext.ok}
        <button class="r" type="button" onclick={() => nav.openExtType('skill')}><span class="r-main"><span class="r-tx">{t('技能')}</span>{@render chev()}</span></button>
        {#if !S.ext.member}
        <button class="r" type="button" onclick={() => nav.openExtType('connector')}><span class="r-main"><span class="r-tx">{t('连接器')}</span>{@render chev()}</span></button>
        <button class="r" type="button" onclick={() => nav.openExtType('plugin')}><span class="r-main"><span class="r-tx">{t('插件')}</span>{@render chev()}</span></button>
        {/if}
      {/if}
      {#if pluginOn('routines')}<button class="r" type="button" onclick={nav.openRoutinesPage}><span class="r-main"><span class="r-tx">{t('定时任务')}</span>{@render chev()}</span></button>{/if}
    </div>
  {/if}
  {#if cl.clErr}<p class="gfoot err">{cl.clErr}</p>{/if}
{/snippet}

{#snippet pAcct(id)}
  {@const a = pool.acctById(id)}
  {#if a}
    {@const u = ags.usage[a.id]}
    {@const idx = ags.accounts.indexOf(a)}
    <div class="hero">
      <span class="av big" aria-hidden="true">{(accLabel(a.label) || '?').trim().charAt(0).toUpperCase()}</span>
      <div class="hero-name">{accLabel(a.label)}</div>
      <div class="hero-sub">{smartRouting() ? (runningOn(a.id) ? t('在跑 {n} 个任务', { n: runningOn(a.id) }) : t('空闲')) : a.active ? t('当前在用') : t('待用')}{planPill(u?.plan) ? ' · ' + planPill(u.plan) : ''}</div>
    </div>
    {@render ghead(t('用量'))}
    <div class="ig usage">
      {#if u?.error && !u.five_hour && !u.seven_day}
        <span class="u-r err">{tr(u.error)}</span>
      {:else}
        {@render meter(t('5 小时'), u?.five_hour, u?.no_five_hour ? t('这个号没有 5 小时限额') : '', !!u?.no_five_hour)}
        {@render meter(t('每周'), u?.seven_day, '')}
        {@render meter('Fable', u?.fable, u?.plan === 'pro' ? t('Pro 无此额度') : '')}
      {/if}
    </div>
    <!-- 重置卡：服务端有这项能力才出现（见 ClaudeResets.svelte） -->
    {#if ags.resetsOk}
      {@render ghead(t('重置卡'))}
      <div class="ig"><ClaudeResets account={a} skin="ios" /></div>
    {/if}
    <div class="ig">
      {#if !a.active && !smartRouting()}
        <button class="r" type="button" onclick={() => activateAccount(a)}><span class="r-main"><span class="r-tx accent">{t('切到此号')}</span></span></button>
      {/if}
      <button class="r" type="button" onclick={() => pool.openEditAcct(a)}><span class="r-main"><span class="r-tx">{t('编辑账号')}</span>{@render chev()}</span></button>
      {#if ags.accounts.length > 1}
        <!-- 顺序：一行两枚小钮（原来是「上移」「下移」两整行） -->
        <div class="r">
          <span class="r-main"><span class="r-tx">{t('顺序')}</span><span class="r-d num">{idx + 1} / {ags.accounts.length}</span>
            <span class="steps">
              <button type="button" disabled={idx <= 0} onclick={() => moveAccount(a, -1)} aria-label={t('上移')}>{@html svgOf('up', 1.8)}</button>
              <button type="button" disabled={idx >= ags.accounts.length - 1} onclick={() => moveAccount(a, 1)} aria-label={t('下移')}>{@html svgOf('down', 1.8)}</button>
            </span>
          </span>
        </div>
      {/if}
    </div>
    {@render agErr()}
    {#if ags.accounts.length > 1}
      <div class="ig">
        <button class="r" type="button" onclick={() => (pool.acctDel = a)}><span class="r-main center"><span class="r-tx red">{t('删除账号')}</span></span></button>
      </div>
    {/if}
  {/if}
{/snippet}

<!-- dimensio 页：子 agent 调度 / 权限与安全 / 工作空间 / 记忆 / 偏好注册表各组 / 诊断 / 版本（数据面 lib/dimensioSettings.svelte.js） -->
{#snippet dmErr(tag)}{#if errOf(tag)}<p class="gfoot err">{errOf(tag)}</p>{/if}{/snippet}
{#snippet pDimensio()}
  {#if !dm.dimEnabled}
    <!-- 开关关着 / 跑不起来：原因已在头图下 -->
  {:else if ds.phase === 'down'}
    {@render ghead(t('dimensio 的设置暂时读不到'))}
    <div class="ig">
      <div class="r"><span class="r-main"><span class="r-tx">{ds.why}</span></span></div>
      <button class="r" type="button" onclick={() => loadDimensio()}><span class="r-main center"><span class="r-tx accent">{t('重试')}</span></span></button>
    </div>
  {:else if !dimReady()}
    {@render gfoot(t('读取中…'))}
  {:else}
    <!-- 有上次的快照时进页就是这一支、不播；只有第一次用（先是「读取中…」）整页到了才原地淡入。下面没有别的内容可推，用不着 grow -->
    <div class="dm-body" in:swap>
    <!-- 子 agent 调用策略（dimensio 那份）：同 Claude 页「对话」组里那一行——行按钮铺满整行、点了推入 'dm-dispatch'；开关压在上面 -->
    {@render ghead(t('子 agent 调度'))}
    <div class="ig">
      <div class="r dpr" role="group" aria-label={t('子 agent 调用策略')}>
        <span class="r-main">
          <button class="dpr-go" type="button" onclick={() => nav.push('dm-dispatch')}>
            <span class="r-tx">{t('子 agent 调用策略')}<span class="r-sub" class:err={!!dp.ddpRowErr}>{#if dp.ddpRowErr || dp.ddpSub}{dp.ddpRowErr || dp.ddpSub}{:else}&nbsp;{/if}</span></span>
          </button>
          <!-- 策略读到了才摆开关（位置先占着）：不然它会先以「关」露面、再滑到「开」 -->
          <span class="dpr-sw">{#if dp.ddp?.policy}<Toggle checked={!!dp.ddp.policy.enabled} disabled={dp.ddp.canEdit === false} onchange={dp.toggleDimDispatch} label={t('按策略调用')} />{/if}</span>
          {@render chev()}
        </span>
      </div>
    </div>
    {@render gfoot(t('派子 agent 时按难度选模型与思考深度：默认 dimensio 单独一套，也可以改成跟随 Claude 的调用策略。'))}

    {@render ghead(t('权限与安全'))}
    <div class="ig">
      <button class="r" type="button" onclick={() => nav.push('dm:mode')}>
        <span class="r-main"><span class="r-tx">{t('默认运行档位')}</span><span class="r-d">{MODES().find((m) => m.value === ds.config.permissionMode)?.label || ds.config.permissionMode}</span>{@render chev()}</span>
      </button>
      {#if accessLocked()}
        <div class="r"><span class="r-main"><span class="r-tx">{t('访问范围')}<span class="r-sub">{t('这台服务器把访问范围锁定了，改不了。')}</span></span><span class="r-d">{ACCESS().find((m) => m.value === ds.config.access)?.label || ds.config.access}</span></span></div>
      {:else}
        <button class="r" type="button" onclick={() => nav.push('dm:access')}>
          <span class="r-main"><span class="r-tx">{t('访问范围')}</span><span class="r-d">{ACCESS().find((m) => m.value === ds.config.access)?.label || ds.config.access}</span>{@render chev()}</span>
        </button>
      {/if}
      <button class="r" type="button" onclick={() => { dm.dmRule = ''; nav.push('dm:allow'); }}>
        <span class="r-main"><span class="r-tx">{t('总是允许')}</span><span class="r-d num">{rulesOf('allow').length || ''}</span>{@render chev()}</span>
      </button>
      <button class="r" type="button" onclick={() => { dm.dmRule = ''; nav.push('dm:ask'); }}>
        <span class="r-main"><span class="r-tx">{t('每次问我')}</span><span class="r-d num">{rulesOf('ask').length || ''}</span>{@render chev()}</span>
      </button>
      <button class="r" type="button" onclick={() => { dm.dmRule = ''; nav.push('dm:deny'); }}>
        <span class="r-main"><span class="r-tx">{t('从不允许')}</span><span class="r-d num">{rulesOf('deny').length || ''}</span>{@render chev()}</span>
      </button>
    </div>
    {@render gfoot(t('新会话的默认；单个对话随时可在输入框的档位胶囊里切，对当前会话立刻生效。'))}

    {@render ghead(t('工作空间'))}
    <div class="ig">
      <button class="r" type="button" onclick={dm.openWsEdit}>
        <span class="r-main"><span class="r-tx"><span class="dm-path">{ds.config.workspace}</span></span>{@render chev()}</span>
      </button>
    </div>
    {@render dmErr('workspace')}
    {@render gfoot(t('新对话从这个文件夹开始，已经开着的对话不受影响。'))}

    {#snippet dmPrefRow(p)}
      {#if p.type === 'bool'}
        <div class="r">
          <span class="r-main"><span class="r-tx"><span class="r-lbl">{prefLabel(p)}{#if prefChanged(p)}{@render cDot('')}{/if}</span>{#if prefDesc(p)}<span class="r-sub">{prefDesc(p)}</span>{/if}</span>
            <Toggle checked={!!p.value} onchange={() => setPref(p.key, !p.value)} label={prefLabel(p)} /></span>
        </div>
      {:else}
        <button class="r" type="button" onclick={() => (p.type === 'enum' ? nav.push('dp:' + p.key) : dm.openPrefEdit(p))}>
          <span class="r-main"><span class="r-tx"><span class="r-lbl">{prefLabel(p)}{#if prefChanged(p)}{@render cDot('')}{/if}</span>{#if prefDesc(p)}<span class="r-sub">{prefDesc(p)}</span>{/if}</span>
            <span class="r-d">{p.type === 'text' ? '' : prefValueLabel(p)}</span>{@render chev()}</span>
        </button>
      {/if}
    {/snippet}

    {#if memoryOk()}
      {@render ghead(t('记忆'))}
      <div class="ig">
        <button class="r" type="button" onclick={() => openInDimensio('memory')}>
          <span class="r-main"><span class="r-tx">{t('记忆管理')}<span class="r-sub">{memLine()}</span></span>{#if ds.mem?.waiting}<span class="pill">{t('{n} 条待处理', { n: ds.mem.waiting })}</span>{/if}{@render chev()}</span>
        </button>
        {#each prefItems('memory') as p (p.key)}{@render dmPrefRow(p)}{/each}
      </div>
      {#each prefItems('memory') as p (p.key)}{@render dmErr('pref:' + p.key)}{/each}
    {/if}

    {#if dmExtOk()}
      {@render ghead(t('连接器与技能'))}
      <div class="ig">
        {#if me.kind === 'admin' && ds.mcp !== null}
          <button class="r" type="button" onclick={() => nav.openExtType('connector')}>
            <span class="r-main"><span class="r-tx">{t('MCP 连接器')}<span class="r-sub">{mcpLine()}</span></span>{@render chev()}</span>
          </button>
        {/if}
        {#if ds.skills !== null}
          <button class="r" type="button" onclick={() => nav.openExtType('skill')}>
            <span class="r-main"><span class="r-tx">{t('技能')}<span class="r-sub">{skillLine()}</span></span>{@render chev()}</span>
          </button>
        {/if}
      </div>
      {@render gfoot(t('在「扩展」里给 dimensio 勾选或添加；改了新对话生效。'))}
    {/if}

    {#each prefGroups() as g (g.id)}
      {@render ghead(prefGroupLabel(g))}
      <div class="ig">
        {#if g.id === 'chat'}
          <div class="r">
            <span class="r-main"><span class="r-tx"><span class="r-lbl">{t('显示全部工作过程')}</span><span class="r-sub">{FEED_DESC()}</span></span>
              <Toggle checked={feed.detail} onchange={() => setFeedDetail(!feed.detail)} label={t('显示全部工作过程')} /></span>
          </div>
        {/if}
        {#each prefItems(g.id) as p (p.key)}{@render dmPrefRow(p)}{/each}
      </div>
      {#each prefItems(g.id) as p (p.key)}{@render dmErr('pref:' + p.key)}{/each}
    {/each}

    {#if hasCap('diagnostics') && ds.sessions.length}
      {@render ghead(t('诊断'))}
      <div class="ig">
        <button class="r" type="button" onclick={() => nav.push('dm:diag')}>
          <span class="r-main"><span class="r-tx">{t('导出诊断包')}</span>{@render chev()}</span>
        </button>
      </div>
      {@render gfoot(t('卡住了、变慢了、报错了，导出这个包发给维护的人：里面是这一轮的事件记录、服务输出、体检结果与版本信息，不含对话正文和任何 key。'))}
    {/if}

    <p class="gfoot dm-ver">{versionLine()}</p>
    </div>
  {/if}
{/snippet}

<!-- dimensio 的单选 / 规则 / 诊断子页 -->
{#snippet dmChoice(opts, cur, pick, tag)}
  <div class="ig">
    {#each opts as o (o.value)}
      <button class="r" type="button" disabled={ds.busy === tag} onclick={() => pick(o.value)}>
        <span class="r-main"><span class="r-tx">{o.label}{#if o.desc}<span class="r-sub">{o.desc}</span>{/if}</span>{#if o.value === cur}{@render check()}{/if}</span>
      </button>
    {/each}
  </div>
  {@render dmErr(tag)}
{/snippet}
{#snippet pDmSub(sub)}
  {#if !dimReady()}
    {@render gfoot(ds.phase === 'down' ? ds.why : t('读取中…'))}
  {:else if sub === 'mode'}{@render dmChoice(MODES(), ds.config.permissionMode, setMode, 'mode')}
  {:else if sub === 'access'}{@render dmChoice(ACCESS(), ds.config.access, setAccess, 'access')}
  {:else if sub === 'allow' || sub === 'ask' || sub === 'deny'}
    {#if rulesOf(sub).length}
      <div class="ig">
        {#each rulesOf(sub) as r (r)}
          <div class="r"><span class="r-main"><span class="r-tx dm-rule">{r}</span>
            <span class="dv-minis"><button type="button" class="red" disabled={ds.busy === 'rules:' + sub} onclick={() => removeRule(sub, r)} aria-label={t('删除规则 {rule}', { rule: r })}>{t('删除')}</button></span></span></div>
        {/each}
      </div>
    {/if}
    {@render ghead(t('添加规则'))}
    <div class="ig">
      <div class="r"><span class="r-main"><input class="dv-in" bind:value={dm.dmRule} placeholder={sub === 'allow' ? t('添加规则，如 Bash(npm test:*)') : sub === 'ask' ? t('添加规则，如 Bash(git push:*)') : t('添加规则，如 Bash(rm -rf:*)')}
        autocapitalize="off" autocorrect="off" spellcheck="false" onkeydown={(e) => { if (e.key === 'Enter' && !e.isComposing) dm.addDmRule(sub); }} /></span></div>
      <button class="r" type="button" disabled={!dm.dmRule.trim() || ds.busy === 'rules:' + sub} onclick={() => dm.addDmRule(sub)}><span class="r-main center"><span class="r-tx accent">{t('添加')}</span></span></button>
    </div>
    {@render dmErr('rules:' + sub)}
    {#if sub === 'allow'}{@render gfoot(t('命中的调用不再弹卡：高危复核、撤不回操作的确认和「每次问我」都放行；「从不允许」与只读 / 先出计划档照样优先。'))}{/if}
    {@render gfoot(t('规则匹配命令或路径的前缀，是防误操作的软闸，不是安全沙箱。保存后所有会话下一次调用就按新规则判，重启也不丢。'))}
  {:else if sub === 'diag'}
    <div class="ig">
      {#each ds.sessions as x (x.id)}
        <button class="r" type="button" disabled={ds.busy === 'diag'} onclick={() => exportDiag(x.id)}>
          <span class="r-main"><span class="r-tx">{sessionTitle(x)}</span><span class="r-d accent">{t('导出')}</span></span>
        </button>
      {/each}
    </div>
    {#if errOf('diag')}{@render dmErr('diag')}{:else if ds.diagMsg}{@render gfoot(ds.diagMsg)}{:else}{@render gfoot(t('卡住了、变慢了、报错了，导出这个包发给维护的人：里面是这一轮的事件记录、服务输出、体检结果与版本信息，不含对话正文和任何 key。'))}{/if}
  {/if}
{/snippet}
{#snippet pDpChoice(key)}
  {@const p = ds.prefs?.items?.find((x) => x.key === key)}
  {#if p}
    {@render dmChoice(prefOptions(p), p.value, (v) => setPref(p.key, v), 'pref:' + p.key)}
    {#if prefDesc(p)}{@render gfoot(prefDesc(p))}{/if}
    {#if prefChanged(p)}
      <div class="ig"><button class="r" type="button" onclick={() => setPref(p.key, null)}><span class="r-main center"><span class="r-tx accent">{t('恢复默认')}</span></span></button></div>
    {/if}
  {/if}
{/snippet}

{#snippet pAgent(id)}
  {@render agSwitch(id)}
  {#if id === 'dimensio'}{@render pDimensio()}
  {:else if id === 'agy' && agentById('agy')}{@render pAgy('ag-agy')}
  {:else if id === 'codex'}{@render pCodex('ag-codex')}
  {:else if !agentById(id)}{@render gfoot(t('只有管理员能改这里'))}{/if}
{/snippet}

<!-- Codex：'ag-codex' 与 'cx:*' 子页，正文归 codex 扩展（懒加载）。成员（agentById 为空）也进得来：正文只给他看自己的默认档与已归档的对话 -->
<!-- 扩展的设置正文是懒加载的：代码已经取到（设置页挂上时空闲预取过，见 lib/settings/warm）就同帧直接挂，
     页面推进来第一帧就是完整的；还没取到才经 {#await} 等 -->
{#snippet codexBody(m, pageId)}
  {@const a = agentById('codex')}
  {@const CodexBody = m.default}
  <CodexBody pid={pageId} enabled={!a || Boolean(a.switch && a.runnable)} push={S.codex.cxPush} pop={() => nav.pop()} openExt={(type) => nav.openExtType(type)} onModal={(v) => { S.codex.cxModal = Boolean(v); }} />
{/snippet}
{#snippet pCodex(pageId)}
  {#if resolvedPage.codexIosSettings}{@render codexBody(resolvedPage.codexIosSettings, pageId)}
  {:else}
    {#await loadPage.codexIosSettings() then m}{@render codexBody(m, pageId)}
    {:catch}
      {@render gfoot(t('Codex 设置没加载出来：这台服务器可能没装 Codex 扩展。'))}
    {/await}
  {/if}
{/snippet}

{#snippet agyBody(m, pageId)}
  {@const a = agentById('agy')}
  {@const AgyBody = m.default}
  <AgyBody pid={pageId} enabled={Boolean(a && a.switch && a.runnable)} push={agy.agyPush} pop={() => nav.pop()} onModal={(v) => { agy.agyModal = Boolean(v); }} />
{/snippet}
{#snippet pAgy(pageId)}
  {#if resolvedPage.agyIosSettings}{@render agyBody(resolvedPage.agyIosSettings, pageId)}
  {:else}
    {#await loadPage.agyIosSettings() then m}{@render agyBody(m, pageId)}
    {:catch}
      {@render gfoot(t('Antigravity 设置没加载出来：这台服务器可能没装 Antigravity 扩展。'))}
    {/await}
  {/if}
{/snippet}

<!-- ─────────────── Media Studio 页（2026-11-04 接替 Gemini 页）───────────────
     头图 + 管理员的启用开关在外壳里画（同 agent 页），正文是懒加载的 studio 扩展组件：每一层页（'studio' 与 'st:*' 子页）各挂一份。 -->
{#snippet pStudio(pid)}
  {#if pid === 'studio'}
    {@const a = agentById('studio')}
    <div class="hero">
      <span class="hero-mark">{#if ag.markSrc('studio')}<img src={ag.markSrc('studio')} alt="" draggable="false" />{/if}</span>
      <div class="hero-name">Media Studio</div>
      {#if studioStatus(a)}<div class="hero-sub">{studioStatus(a)}</div>{/if}
    </div>
    {#if a}
      <div class="ig">
        <div class="r">
          <span class="r-main"><span class="r-tx">{t('启用 {name}', { name: 'Media Studio' })}</span>
            <Toggle checked={a.switch && a.runnable} disabled={!a.runnable || ags.agentBusy === a.id} onchange={() => ag.toggleAgent(a)} label={t('启用 {name}', { name: 'Media Studio' })} /></span>
        </div>
      </div>
      {@render agErr()}
    {/if}
  {/if}
  {#if resolvedPage.studioSettings}{@render studioBody(resolvedPage.studioSettings, pid)}
  {:else}
    {#await loadPage.studioSettings() then m}{@render studioBody(m, pid)}
    {:catch}
      {@render gfoot(t('Media Studio 的设置没加载出来：这台服务器可能没装 Media Studio 扩展。'))}
    {/await}
  {/if}
{/snippet}
{#snippet studioBody(m, pid)}
  {@const StudioBody = m.default}
  <StudioBody shell="ios" dark={S.dark} page={pid} push={st.stPush} agentIds={ag.studioIds.length ? ag.studioIds : null} onModal={(v) => { if (pid === 'studio') st.stModal = v; }} />
{/snippet}

<!-- 模型中心：头图（枢纽图标 + 名字 + 一行状态）归外壳，正文是 modelhub/HubHome 的 ios 版（懒加载，没打开设置的人不下这块代码）。
     状态只在拿到时写；正文自己管空态、加载与出错 -->
{#snippet pModelHub()}
  {@const sum = hubSummaryText()}
  <div class="hero">
    <span class="hero-mark hub" aria-hidden="true">{@html svgOf('modelhub', 1.4)}</span>
    <div class="hero-name">{t('模型中心')}</div>
    {#if sum}<div class="hero-sub">{sum}</div>{/if}
  </div>
  {#if bodies.hubHome}
    {@const HubHome = bodies.hubHome}
    <HubHome shell="ios" />
  {:else}
    {#await loadHubHome()}{:catch}
      {@render gfoot(t('模型中心没加载出来：关掉设置再打开试试。'))}
    {/await}
  {/if}
{/snippet}

{#snippet pPolicy()}
  {#if ags.policy}
    <div class="ig">
      <div class="r">
        <span class="r-main"><span class="r-tx">{t('凭邀请码注册')}</span>
          <Toggle checked={ags.policy.register} onchange={() => savePolicy({ register: !ags.policy.register })} label={t('凭邀请码注册')} /></span>
      </div>
    </div>
    {@render ghead(t('注册用户的默认额度'))}
    <div class="ig">
      {#each pol.POLICY_FIELDS as f (f.k)}
        <button class="r" type="button" onclick={() => pol.openNum(f)}>
          <span class="r-main"><span class="r-tx">{f.label()}</span><span class="r-d num">{pol.policyVal(f.k) ? pol.policyVal(f.k) + ' ' + f.unit() : t('不限')}</span>{@render chev()}</span>
        </button>
      {/each}
      <button class="r" type="button" onclick={pol.openTz}>
        <span class="r-main"><span class="r-tx">{t('「每天」按哪个时区换日')}</span><span class="r-d">{ags.policy.timezone}</span>{@render chev()}</span>
      </button>
    </div>
    {@render agErr()}
    {@render gfoot(t('只算 Claude，管理员不受限。'))}
  {/if}
{/snippet}

{#snippet pThinkMark()}
  <div class="ig">
    {#each cl.MARKS as mk (mk.value)}
      <button class="r" type="button" onclick={() => cl.setMark(mk.value)}>
        <span class="r-main">
          <span class="mk-prev">{#if mk.value === 'clay'}<ClaudeWorkingMark activity="think" size={22} standalone />{:else if mk.value === 'sprite'}<ClaudeSpriteMark phase="pending" box={22} />{:else}<ClaudeLogo anim="thinking" size={22} />{/if}</span>
          <span class="r-tx">{mk.label()}</span>{#if prefs.claudeMark === mk.value}{@render check()}{/if}
        </span>
      </button>
    {/each}
  </div>
{/snippet}
{#if pid === 'thinkmark'}{@render pThinkMark()}
{:else if pid === 'model-hub'}{@render pModelHub()}
{:else if pid === 'policy'}{@render pPolicy()}
{:else if pid === 'studio' || pid.startsWith('st:')}{@render pStudio(pid)}
{:else if pid.startsWith('agy:')}{@render pAgy(pid)}
{:else if pid.startsWith('cx:')}{@render pCodex(pid)}
{:else if pid === 'ag-claude'}{@render pClaude()}
{:else if DISPATCH_PAGES.includes(pid)}{@render pDispatch()}
{:else if pid.startsWith('ag-')}{@render pAgent(pid.slice(3))}
{:else if pid.startsWith('dm:')}{@render pDmSub(pid.slice(3))}
{:else if pid.startsWith('dp:')}{@render pDpChoice(pid.slice(3))}
{:else if pid.startsWith('acct:')}{@render pAcct(pid.slice(5))}
{:else if CL_CHOICE[pid]}{@render pChoice(CL_CHOICE[pid])}
{:else if CL_GROUP[pid]}{@render pClGroup(pid)}
{/if}

<style>
  @import './kit.css';
</style>
