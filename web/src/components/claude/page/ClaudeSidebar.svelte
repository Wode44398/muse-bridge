<!-- Claude 页·侧栏正文（常驻列与手机抽屉共用一份）：入口行、临时对话区、收藏、项目组、已归档视图、账户卡、行菜单（会话行尾 ⋮；项目行只认右键 / 长按）。 -->
<script>
  import ClaudeCodeWordmark from '../ClaudeCodeWordmark.svelte';
  import { ui, session, pluginOn } from '../../../lib/state.svelte.js';
  import { updateInfo } from '../../../lib/updateStore.svelte.js';
  import { pendingNew } from '../../../lib/chat.svelte.js';
  import { isStarred, titleFor } from '../../../lib/library.svelte.js';
  import { marquee } from '../../../lib/marquee.js';
  import { pointer } from '../../../lib/layout.svelte.js';
  import { drag, dropZone } from '../../../lib/dragdrop.svelte.js';
  import { IS_CSNAP } from '../../../lib/csnap.js';
  import { t, tc, tr } from '../../../lib/i18n.js';
  import { arch, loadArchived, openArchivedView, closeArchivedView } from '../../../lib/sessionArchive.svelte.js';
  import { relTime } from '../../../lib/format.js';
  import { pluginUi, uiIcon } from '../../../lib/pluginUi.svelte.js';   // 插件的会话动作（ctx.ui.sessionAction）
  // 插件的工作区外观（ctx.ui.workspaceDecor / workspaceAction）：画法在 ../workspace/，这里只接入
  import { decorFor, sessionMark, workspaceMenuItems, runWorkspaceAction } from '../../../lib/pluginUi.svelte.js';
  import ClaudeSpark from '../workspace/ClaudeSpark.svelte';
  import AgentTile from '../workspace/AgentTile.svelte';
  import DecorTile from '../workspace/DecorTile.svelte';
  import PeerSessions from '../workspace/PeerSessions.svelte';
  import WorkspaceIcon from '../workspace/WorkspaceIcon.svelte';
  import { noteLine, agentName } from '../workspace/decor.js';
  import { appKey as appKeyOf, appIconUrl } from '../../../lib/pluginApps.svelte.js';
  import { appTagOf } from '../../../lib/claudePage/sessionAppTag.js';
  import { usePage } from '../../../lib/claudePage/context.js';

  const pc = usePage();
  const runWsAction = (wa, p) => { closeMenu(); if (p?.path) runWorkspaceAction('claude', { plugin: wa.plugin, id: wa.id, path: p.path, projectId: p.id }); };
  const { onSessDragStart, onSideDragEnd, onRowDragOver, onRowDragLeave, onRowDrop, sessHoldDown, sessHoldMove, sessHoldUp, rowCtx, sessionDrop, pickSession, isQuickSession, quickWarnDays, openMenu, closeDrawer, openArchived, projName, onProjDragStart, projHoldDown, projHoldMove, projHoldUp, newInProject, toggleFold, serverRest, pendIn, showMore, showLess, slideOut, newChat, NEW_KBD, openSearch, IS_MAC, openProjectModal, newQuick, openRoutines, openOrphan, showMoreQuick, openBin, projListZone, onProjDragOver, onProjDragLeave, onProjDrop, toggleUserMenu, closeMenu, menuSession, saveQuick, keepQuick, doStar, doRename, doArchive, runSessionAction, doDelete, doUnarchive, doRenameProject, menuProject, doArchiveProject, doDeleteProject, openSideApp } = pc;
</script>
{#snippet convRow(s, indent, deco = false)}
    {@const kn = pc.kidCount.get(s.id) || 0}
    {@const by = sessionMark('claude', s.id)?.by}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="d-row" class:cur={s.id === pc.curId} class:alt={!!pc.altId && s.id === pc.altId} class:indent class:child={pc.childIds.has(s.id)} class:fam={!!kn} class:folded={!!kn && !!pc.famFolded[s.id]} class:dnd-on={drag.overKey === 'chat:claude:' + s.id || pc.rowHover === s.id}
      class:lifted={pc.liftedId === s.id} draggable={pc.mouseDnd ? 'true' : 'false'} ondragstart={(e) => onSessDragStart(e, s)} ondragend={onSideDragEnd}
      ondragover={(e) => onRowDragOver(e, s)} ondragleave={(e) => onRowDragLeave(e, s)} ondrop={(e) => onRowDrop(e, s)}
      onpointerdown={(e) => sessHoldDown(e, s)} onpointermove={sessHoldMove} onpointerup={sessHoldUp} onpointercancel={sessHoldUp}
      oncontextmenu={(e) => rowCtx(e, 'session', s.id)}>
      <!-- 落点挂在按钮上而不是外层 div：它本来就是可交互元素，省掉一条 a11y 例外 -->
      <button class="d-recent" use:dropZone={sessionDrop(s)} onclick={() => pickSession(s)}>
        <!-- 待回答（提问 / 审批卡）压过「在跑」：等人的那一轮本来就还在跑，不压过去这个点永远亮不出来（官方 Needs your input） -->
        <!-- 共用项目块里状态挪到行尾（行首那一格留给「谁开的」小方块），在跑的画官方星芒 -->
        {#if (s.thinking || s.pending) && !deco}<span class="d-dot {s.pending ? 'ask' : 'work'}"></span>{/if}
        {#if by && by !== 'claude'}<span class="d-by" title={t('{agent} 开的会话', { agent: agentName(by) })}><AgentTile agent={by} size={15} /></span>{/if}
        <!-- 项目对话：标题前一枚项目字形（协调者带两条讨论串）；讨论串在等你时行尾一个红点 -->
        {#if s.shape === 'project'}<svg class="d-pj" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" aria-label={t('项目对话')}><circle cx="8" cy="3.9" r="1.85"/><circle cx="3.9" cy="12.1" r="1.85"/><circle cx="12.1" cy="12.1" r="1.85"/><path d="M7 5.5 4.9 10.4M9 5.5l2.1 4.9"/></svg>{/if}
        <span class="d-title" use:marquee><span class="d-scroll">{tr(titleFor(s.id, s.title)) || t('（无标题）')}</span></span>
        {#if s.app}
          {@const appTag = appTagOf(s)}
          {#if appTag}<span class="d-apptag" title={t('由插件应用「{app}」开的对话', { app: appTag })}>{appTag}</span>{/if}
        {/if}
        {#if pc.projectWaiting.has(s.id)}<span class="d-pwait" title={t('有讨论串在等你')} aria-label={t('有讨论串在等你')}></span>{/if}
        <!-- 临时对话快到清理时：行尾一枚「剩 n 天」——话写全，别让人读成「n 天前」（触屏没有悬停提示；悬停时让位给 ⋮） -->
        {#if isQuickSession(s)}
          {@const qd = quickWarnDays(s.projectId)}
          {#if qd != null}<span class="d-exp" title={t('{n} 天后清理', { n: qd })}>{qd ? t('剩 {n} 天', { n: qd }) : t('今天清理')}</span>{/if}
        {/if}
        {#if deco && s.pending}<span class="d-dot ask d-end"></span>
        {:else if deco && s.thinking}<span class="d-spark" aria-label={t('正在工作')}><ClaudeSpark size={15} think /></span>{/if}
      </button>
      <!-- 名下有子会话 / 讨论串：行尾一枚折叠钮（收起时带上条数，常显；展开时同 ⋮ 悬停才浮现） -->
      {#if kn}
        {@const fo = !!pc.famFolded[s.id]}
        <button class="d-kids" class:closed={fo} aria-expanded={!fo} title={fo ? t('展开子会话（{n}）', { n: kn }) : t('收起子会话')}
          aria-label={fo ? t('展开子会话（{n}）', { n: kn }) : t('收起子会话')} onclick={(e) => pc.toggleFamily(e, s.id)}>
          {#if fo}<span class="d-kn">{kn}</span>{/if}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </button>
      {/if}
      <button class="d-more" aria-label={t('更多')} onclick={(e) => openMenu(e, 'session', s.id)}><span class="ic">&#xe062;</span></button>
    </div>
  {/snippet}

  <!-- 新会话的占位行：发送那一刻就有，id 回来换成真行（见 pendingNew）。还没有 id，点它只收抽屉 -->
  {#snippet pendRow(p, indent)}
    <div class="d-row" class:cur={p.key === pendingNew.mine && !session.id} class:indent>
      <button class="d-recent" onclick={closeDrawer}>
        <span class="d-dot work"></span>
        <span class="d-title"><span class="d-scroll">{p.title || t('（无标题）')}</span></span>
      </button>
    </div>
  {/snippet}

  {#snippet archRow(s)}
    <!-- 已归档视图的一行：标题 + 所在项目 · 归档时间（跨项目平铺，得看得出是哪个项目的） -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="d-row arch" class:cur={s.id === pc.curId} oncontextmenu={(e) => rowCtx(e, 'archived', s.id)}>
      <button class="d-recent" onclick={() => openArchived(s)}>
        <span class="d-two">
          <span class="d-title">{tr(titleFor(s.id, s.title)) || t('（无标题）')}</span>
          <span class="d-sub">{#if projName(s.projectId)}{projName(s.projectId)}{' · '}{/if}{relTime(s.archivedAt || s.mtime)}</span>
        </span>
      </button>
      <button class="d-more" aria-label={t('更多')} onclick={(e) => openMenu(e, 'archived', s.id)}><span class="ic">&#xe062;</span></button>
    </div>
  {/snippet}

  {#snippet projRow(p, i)}
    {@const dc = decorFor('claude', p.path)}
    {@const nl = dc ? noteLine(dc) : ''}
    <!-- 插件给了外观：项目自成一块（极淡底 + 1px 细描边），名字下一行插件给的 note（不给就不写），右端对方的连接器方块（点了去哪由插件的 open 定），块内多一组对方的会话 -->
    <div class="d-pblock" class:ins={pc.insShown === i} class:deco={!!dc?.panel}>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="d-row proj" class:co={!!dc} class:two={!!nl} title={p.path || ''} class:lifted={pc.liftedId === p.id}
      draggable={pc.mouseDnd ? 'true' : 'false'} ondragstart={(e) => onProjDragStart(e, p)} ondragend={onSideDragEnd}
      onpointerdown={(e) => projHoldDown(e, p)} onpointermove={projHoldMove} onpointerup={projHoldUp} onpointercancel={projHoldUp}
      oncontextmenu={(e) => rowCtx(e, 'project', p.id)}>
      <button class="d-recent" onclick={() => newInProject(p)}>
        <span class="d-bub"><span class="ic pj">&#xe0c9;</span></span>
        {#if nl}
          <span class="d-two"><span class="d-title">{tr(p.name)}</span>{#key nl}<span class="d-sub d-note">{nl}</span>{/key}</span>
        {:else}
          <span class="d-title">{tr(p.name)}</span>
        {/if}
      </button>
      {#if (pc.grouped.get(p.id) || []).length || (dc?.peerSessions || []).some((g) => g.items.length)}
        <button class="d-more d-fold" class:closed={!!pc.collapsed[p.id]} aria-label={pc.collapsed[p.id] ? t('展开会话') : t('收起会话')} onclick={(e) => toggleFold(e, p.id)}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>
        </button>
      {/if}
      <!-- 项目行不放 ⋮（11-24 维护者：插件的连接器方块进来后尾巴挤不下、压住名字）：菜单只从右键 / 触屏长按原地松手出（见 rowCtx、projHoldDown） -->
      {#if dc}<DecorTile item={dc} />{/if}
    </div>
    {#if !pc.collapsed[p.id] && !pc.projDragging}
      {@const pg = pc.paged.get(p.id)}
      {@const more = (pg?.rest || 0) + serverRest(p.id)}
      {#each pendIn(p.id) as pn (pn.key)}{@render pendRow(pn, true)}{/each}
      {#each pg?.rows || [] as s (s.id)}{@render convRow(s, true, !!dc)}{/each}
      {#if more}
        <!-- 剩余数 = 本地还没放出来的 + 服务端还没拿到的（老会话翻页，见 loadOlder） -->
        <button class="d-pager" disabled={!!pc.olderBusy[p.id]} onclick={() => showMore(p.id)}>{pc.olderBusy[p.id] ? t('加载中…') : t('显示更多（{n}）', { n: more })}</button>
      {:else if pc.shown[p.id]}
        <button class="d-pager" onclick={() => showLess(p.id)}>{t('收起')}</button>
      {/if}
      {#if dc}<PeerSessions item={dc} path={p.path} onopen={closeDrawer} />{/if}
    {/if}
    </div>
  {/snippet}


  <!-- 左上角标题 = claude.ai /code 原件「Claude Code」SVG 字标（14px 高、text-primary），不是文字 -->
  <div class="brand"><ClaudeCodeWordmark /></div>
  {#if !pc.single}<button class="d-item" onclick={slideOut}><span class="ic d-lead w7">&#xe08a;</span>{t('主页')}</button>{/if}
  <!-- 新对话（官方侧栏第一行 New session；S1-6）：落在当前项目，在临时对话里就落到最近用过的真实项目。
       图标是自绘的「方框 + 笔」，不走图标字体 -->
  {#if !IS_CSNAP}
    <button class="d-item" onclick={newChat}>
      <span class="d-lead svg" aria-hidden="true">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M7.25 3H4.5A1.5 1.5 0 0 0 3 4.5v7A1.5 1.5 0 0 0 4.5 13h7a1.5 1.5 0 0 0 1.5-1.5V8.75"/><path d="M11.75 2.6a1.25 1.25 0 0 1 1.77 1.77L8.6 9.3l-2.35.6.6-2.35z"/></svg>
      </span>{tc('claude', '新对话')}{#if pointer.fine}<span class="d-kbd" aria-hidden="true">{NEW_KBD}</span>{/if}</button>
  {/if}
  <!-- 搜索会话（官方侧栏顶部的 Search，Ctrl+K）：标题 / 曾用名 / 全文，覆盖所有项目、临时对话与已归档会话 -->
  {#if !IS_CSNAP && pc.who}
    <button class="d-item" onclick={openSearch}><span class="ic d-lead">&#xe0d3;</span>{t('搜索')}{#if pointer.fine}<span class="d-kbd" aria-hidden="true">{IS_MAC ? '⌘K' : 'Ctrl K'}</span>{/if}</button>
  {/if}
  <button class="d-item" onclick={openProjectModal}><span class="ic d-lead w7">&#xe001;</span>{t('新建项目')}</button>
  <!-- 新建临时对话（原「新建快照」）：虚线气泡＝不进任何项目、放久了会清理 -->
  <button class="d-item" disabled={!pc.quickProj || pc.quickBusy} onclick={newQuick}>
    <span class="d-lead svg" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 3h7A2.5 2.5 0 0 1 14 5.5v3.5a2.5 2.5 0 0 1-2.5 2.5H8l-3 2.25V11.5h-.5A2.5 2.5 0 0 1 2 9V5.5A2.5 2.5 0 0 1 4.5 3Z" stroke-dasharray="2 1.7"/></svg>
    </span>{t('新建临时对话')}</button>
  {#if pluginOn('routines')}<button class="d-item" onclick={openRoutines}>
    <span class="d-lead ck" aria-hidden="true">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="8" cy="8" r="5.5"/><line class="hh" x1="8" y1="8" x2="10" y2="9"/><line class="mh" x1="8" y1="8" x2="8" y2="5.5"/>
      </svg>
    </span>{t('定时触发')}</button>{/if}
  {#if pc.sideApps.length}
    <!-- 应用：插件固定到 Claude 侧栏的应用，图标 + 名字；一个都没有整组不出 -->
    <div class="d-sec">{tc('插件', '应用')}</div>
    {#each pc.sideApps as a (a.key || appKeyOf(a))}
      {@const k = a.key || appKeyOf(a)}
      {@const src = appIconUrl(a, ui.theme === 'light')}
      <button class="d-item" class:cur={pc.sideApp === k} onclick={() => openSideApp(a)}>
        <span class="d-lead d-app" aria-hidden="true">{#if src && !pc.sideIconBad[k]}<img src={src} alt="" draggable="false" onerror={() => (pc.sideIconBad = { ...pc.sideIconBad, [k]: true })} />{:else}{@html uiIcon(a.icon?.name)}{/if}</span>
        <span class="d-app-t">{a.title || a.id}</span></button>
    {/each}
  {/if}
  {#if arch.view}
    <!-- 已归档视图（官方 Sessions 页的 Archived 标签 / 侧栏 Status=Archived）：抽屉内整页切换，平铺、按归档时间倒序，
         每行能打开看、取消归档、删除；底部「显示更多」走服务端分页。宽屏常驻侧栏与手机抽屉同一份。 -->
    <div class="d-arch-head">
      <button class="d-back" aria-label={t('返回')} onclick={closeArchivedView}><span class="ic">&#xe00c;</span></button>
      <span class="d-arch-t">{t('已归档')}</span>
      {#if arch.total}<span class="d-count">{arch.total}</span>{/if}
    </div>
    <div class="d-list">
      {#each arch.rows as s (s.id)}{@render archRow(s)}{/each}
      {#if !arch.rows.length}<div class="d-empty">{arch.loading ? t('加载中…') : t('还没有归档的会话。')}</div>{/if}
      {#if arch.more}
        <button class="d-pager flat" disabled={arch.loading} onclick={() => loadArchived(true)}>{arch.loading ? t('加载中…') : t('显示更多')}</button>
      {/if}
    </div>
  {:else}
  <!-- 临时对话区（原「快照」，S1-6）：全部还留着的临时对话，最近的在上；30 天没动才清理，先进回收站 -->
  {#if pc.quickProj && (pc.quickSessions.length || pc.quickBlank || pc.quickBin || pc.quickOrphRows.length || pc.pendQuick.length)}
    <div class="d-sec">{tc('临时对话区', '临时对话')}</div>
    <div class="d-list">
      {#each pc.pendQuick as pn (pn.key)}{@render pendRow(pn, false)}{/each}
      {#if pc.quickBlank && !pendingNew.mine && !pc.quickOrphRows.some((o) => o.id === session.projectId)}
        <div class="d-row cur"><button class="d-recent" onclick={closeDrawer}><span class="d-title">{t('新的临时对话')}</span></button></div>
      {/if}
      {#each pc.quickRows.rows as s (s.id)}{@render convRow(s, false)}{/each}
      <!-- 只有文件、没有对话的临时对话（删光了对话 / 老版本留下的）：点开在那只桶里开空白对话，工作台里看得见文件 -->
      {#each pc.quickRows.orph as o (o.id)}
        {@const od = quickWarnDays(o.id)}
        <div class="d-row" class:cur={pc.quickBlank && session.projectId === o.id}>
          <button class="d-recent" onclick={() => openOrphan(o.id)}>
            <span class="d-title">{t('{n} 个文件，还没有对话', { n: o.items || 0 })}</span>
            {#if od != null}<span class="d-exp" title={t('{n} 天后清理', { n: od })}>{od ? t('剩 {n} 天', { n: od }) : t('今天清理')}</span>{/if}
          </button>
        </div>
      {/each}
      {#if pc.quickRows.rest}
        <button class="d-pager flat" disabled={pc.quickOlderBusy} onclick={showMoreQuick}>{pc.quickOlderBusy ? t('加载中…') : t('显示更多（{n}）', { n: pc.quickRows.rest })}</button>
      {:else if pc.shownQuick}
        <button class="d-pager flat" onclick={() => (pc.shownQuick = 0)}>{t('收起')}</button>
      {/if}
      {#if pc.quickBin}
        <button class="d-pager flat" onclick={openBin}>{t('回收站（{n}）', { n: pc.quickBin })}</button>
      {/if}
    </div>
  {/if}
  {#if pc.starred.length}
    <div class="d-sec">{tc('名词', '收藏')}</div>
    <div class="d-list">{#each pc.starred as s (s.id)}{@render convRow(s, false)}{/each}</div>
  {/if}
  <div class="d-sec">{tc('claude', '项目')}</div>
  <!-- 项目列表整张是排序落点：鼠标走 HTML5 dragover/drop，手指走长按拿起（use:dropZone） -->
  <div class="d-list d-projs" class:reordering={pc.projDragging} class:ins-end={pc.insShown >= 0 && pc.insShown === pc.realProjects.length}
    role="list" use:dropZone={projListZone} ondragover={onProjDragOver} ondragleave={onProjDragLeave} ondrop={onProjDrop}>
    {#each pc.realProjects as p, i (p.id)}{@render projRow(p, i)}{/each}
    {#if !pc.realProjects.length}<div class="d-empty">{pc.who ? t('加载中…') : t('登录后显示')}</div>{/if}
  </div>
  <!-- 「已归档（n）」入口：项目列表最底下一行，点进去是已归档视图（没有归档过的会话就不出现） -->
  {#if arch.count && !IS_CSNAP}
    <button class="d-item d-arch-ent" onclick={openArchivedView}><span class="ic d-lead">&#xe008;</span>{t('已归档')}<span class="d-count">{arch.count}</span></button>
  {/if}
  {/if}
  <div class="d-spacer"></div>
  <!-- 账户卡：贴底不随列表滚走（sticky）。单 agent 模式下设置 / 账户 / 关于与更新都从这里进；
       常规模式菜单里多一项「主页」 -->
  <div class="d-foot">
    <button class="d-me" class:open={!!pc.umAnchor} onclick={toggleUserMenu} aria-haspopup="menu" aria-expanded={!!pc.umAnchor}
      title={t('设置与账户')}>
      <span class="av">{pc.meInitial}</span>
      <span class="d-me-n">{pc.meName}{#if pc.meRole}<span class="d-me-r">{` · ${pc.meRole}`}</span>{/if}</span>
      {#if pc.single && updateInfo.available}<span class="d-me-dot" title={t('有新版本')}></span>{/if}
      <span class="d-me-chev" aria-hidden="true">&#xe027;</span>
    </button>
  </div>

  {#if pc.menuFor}
    <button class="rowmenu-bd" aria-label={t('关闭')} onclick={closeMenu}></button>
    <div class="rowmenu" style={pc.menuStyle}>
      {#if pc.menuFor.kind === 'session'}
        {@const mq = menuSession()}
        {#if isQuickSession(mq)}
          <!-- 临时对话：收藏 / 归档对它没意义（不进收藏区、不归档），换成「存为工作空间」；快到清理时多一项「继续保留」 -->
          <button disabled={pc.quickBusy} onclick={() => saveQuick(mq.projectId, mq)}><span class="ic mi">&#xe0c9;</span>{t('存为工作空间')}</button>
          {#if quickWarnDays(mq.projectId) != null}
            <button disabled={pc.quickBusy} onclick={() => keepQuick(mq.projectId)}><span class="ic mi">&#xe03b;</span>{t('继续保留')}</button>
          {/if}
        {:else}
          <button onclick={() => doStar(pc.menuFor.id)}><span class="ic mi">&#xe0bd;</span>{isStarred(pc.menuFor.id) ? t('取消收藏') : t('收藏')}</button>
        {/if}
        <button onclick={() => doRename(menuSession())}><span class="ic mi">&#xe064;</span>{t('重命名')}</button>
        {#if !isQuickSession(mq)}
          <!-- 归档（官方 remove 组）：在工作 / 在等回答的会话不能归档（官方同款） -->
          {@const ms = menuSession()}
          <button disabled={!!(ms && (ms.thinking || ms.pending))} title={ms && (ms.thinking || ms.pending) ? t('正在工作的会话不能归档') : undefined}
            onclick={() => doArchive(ms)}><span class="ic mi">&#xe008;</span>{t('归档')}</button>
        {/if}
        {#if !IS_CSNAP && pluginUi.sessionActions.length}
          <!-- 插件的会话动作（ctx.ui.sessionAction）：交给插件的 handler，带上会话 id 与标题 -->
          <div class="rowmenu-sep" role="presentation"></div>
          {#each pluginUi.sessionActions as pa (pa.plugin + '/' + pa.id)}
            <button title={pa.pluginName} onclick={() => runSessionAction(pa, mq)}><span class="ic plg-ic" aria-hidden="true">{@html uiIcon(pa.icon)}</span><span class="plg-lab">{pa.label}</span></button>
          {/each}
          <div class="rowmenu-sep" role="presentation"></div>
        {/if}
        <button class="danger" onclick={() => (pc.delConfirm ? doDelete(pc.menuFor.id) : (pc.delConfirm = true))}><span class="ic mi">&#xe101;</span>{pc.delConfirm ? tc('claude', '确认删除') : t('删除')}</button>
      {:else if pc.menuFor.kind === 'archived'}
        <button onclick={() => doUnarchive(pc.menuFor.id)}><span class="ic mi">&#xe008;</span>{t('取消归档')}</button>
        <button class="danger" onclick={() => (pc.delConfirm ? doDelete(pc.menuFor.id) : (pc.delConfirm = true))}><span class="ic mi">&#xe101;</span>{pc.delConfirm ? tc('claude', '确认删除') : t('删除')}</button>
      {:else}
        <button onclick={() => doRenameProject(menuProject())}><span class="ic mi">&#xe064;</span>{t('重命名')}</button>
        <!-- 归档全部会话（官方分组菜单的 Archive all）：组里有会话才出 -->
        {#if (pc.grouped.get(pc.menuFor.id) || []).length || pc.projCounts[pc.menuFor.id]}
          <button onclick={() => doArchiveProject(menuProject())}><span class="ic mi">&#xe008;</span>{t('归档全部会话')}</button>
        {/if}
        {@const mp = menuProject()}
        {@const wsItems = !IS_CSNAP && mp?.path ? workspaceMenuItems('claude', { path: mp.path }) : []}
        {#if wsItems.length}
          <!-- 插件的文件夹菜单项（ctx.ui.workspaceAction）：确认框由 ClaudeWorkspaceDialog 画 -->
          <div class="rowmenu-sep" role="presentation"></div>
          {#each wsItems as wa (wa.plugin + '/' + wa.id)}
            <button class:danger={wa.danger} title={wa.pluginName} onclick={() => runWsAction(wa, mp)}><span class="ic plg-ic" aria-hidden="true"><WorkspaceIcon name={wa.icon} /></span><span class="plg-lab">{tr(wa.label)}</span></button>
          {/each}
          <div class="rowmenu-sep" role="presentation"></div>
        {/if}
        <!-- 默认工作空间只能改名，不能删（服务端也拦） -->
        {#if !menuProject()?.def}
          <button class="danger" onclick={() => (pc.delConfirm ? doDeleteProject(pc.menuFor.id) : (pc.delConfirm = true))}><span class="ic mi">&#xe101;</span>{pc.delConfirm ? tc('claude', '确认删除') : t('删除项目')}</button>
        {/if}
      {/if}
    </div>
  {/if}

<style>
  /* 字标行：官方标题栏里字标垂直居中、高 14px；这里给 44px 行高（与原 21px 衬线文字的占位持平），
     下留 2px 让字标视觉上略高于几何中线。颜色 = 官方 text-primary。 */
  /* 吸顶（11-08）：侧栏展开时开关（SidebarToggle）就坐在这一行右端，列表滚上去这一行不能跟着走。
     负 margin + 等量 padding 把行盒向上、向两侧撑满侧栏内边距（字标位置不变），吸顶后底色盖住从下面
     滚过的行；top 写负的顶内边距——Chromium 的 sticky 约束框扣掉了滚动容器自己的 padding（同 .d-foot）。 */
  .brand { position: sticky; top: calc(-1 * max(10px, var(--sat))); z-index: 3;
    display: flex; align-items: center; flex: none; height: calc(44px + max(10px, var(--sat)));
    margin: calc(-1 * max(10px, var(--sat))) -8px 0; padding: max(10px, var(--sat)) 18px 2px;
    background: var(--bg); transition: background-color .25s ease; color: var(--text); }
  /* 行下沿一条 12px 渐隐：列表滚上来时从字标行底下柔和地化掉、不是一刀切。只在【已经滚动】时浮现
     （侧栏自己的 scroll() 时间线，滚满 24px 到全显）——没滚时它会压淡「主页」那行的悬停底上沿。
     不支持滚动驱动动画的环境保持透明＝原来的硬边。 */
  .brand::after { content: ''; position: absolute; left: 0; right: 0; top: 100%; height: 12px; pointer-events: none;
    background: linear-gradient(to bottom, var(--bg), color-mix(in srgb, var(--bg) 0%, transparent)); opacity: 0; }
  @supports (animation-timeline: scroll()) {
    .brand::after { animation: brandFade linear both; animation-timeline: scroll(nearest block); animation-range: 0 24px; }
  }
  @keyframes brandFade { to { opacity: 1; } }
  /* 桌面壳 WCO：字标行整行划进窗口拖拽区（维护者 09-23：顶部可拖范围太窄、不明显）。DesktopChrome 那条
     全局 `html[data-wco] .brand{no-drag}` 是给主页可点的 BrandTitle 打的洞，这里的字标只是一枚 img，
     不可点——作用域类多一级优先级压过它。字标行（drawer 顶 10 + 44 = 54px）比 40px 标题栏带更深，
     左上角那一块从窗口顶到「主页」上沿都能拖。 */
  :global(html[data-wco="1"]) .brand { -webkit-app-region: drag; user-select: none; }
  /* flex:none 必须写：.drawer 是溢出的 flex 列，min-height:auto 会把这行压到内容高（实测 16px），字标贴到「主页」上 */
  /* —— claude.ai 同款侧栏（实测规格：行高 32/圆角 8/字号 14/悬停 rgba .06、
     图标 Anthropicons 可变字重：导航 20px/430、New·主页 16px/700、⋮ 16px/530、气泡 e037）—— */
  .d-item { width: 100%; display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 8px; font-size: 14px; color: var(--serif); text-align: left; transition: background-color .12s ease, color .12s ease; }
  .d-item:active { background: var(--hover); color: var(--text); }
  .d-item:disabled { color: var(--muted); }
  .d-lead { width: 22px; text-align: center; font-size: 20px; font-weight: 430; color: var(--serif); flex: none; }
  .d-lead.w7 { font-size: 16px; font-weight: 700; }
  /* 定时触发 = claude.ai 侧栏 Scheduled 同款钟（连悬停动效一并取回，2026-08-14 实测源码规格）：
     16 视口 / 1px 描边 / 圆头圆角，表盘 r5.5，时针 (8,8)→(10,9)、分针 (8,8)→(8,5.5)；
     悬停两针以 8 8 为轴转动 —— 时针 +30°（走一格），分针 +390°（整圈再 30°，与时针同步落位），
     0.6s cubic-bezier(.3,.9,.4,1)；表盘不动。触屏无 hover，:active 走同一套。 */
  .d-lead.ck { display: flex; align-items: center; justify-content: center; }
  .d-lead.ck svg { width: 16px; height: 16px; }
  /* 新对话 / 新建临时对话：自绘 16px 描边图标（与定时触发的钟同一套尺寸） */
  .d-lead.svg { display: flex; align-items: center; justify-content: center; }
  .d-lead.svg svg { width: 16px; height: 16px; }
  /* 侧栏应用：图片图标按 16px 圆角小方块放（同字形图标的视觉大小），内置字形是 svg */
  .d-lead.d-app { display: flex; align-items: center; justify-content: center; }
  .d-lead.d-app img { width: 18px; height: 18px; object-fit: contain; border-radius: 4px; }
  .d-lead.d-app :global(svg) { width: 16px; height: 16px; }
  .d-app-t { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .d-item.cur { background: var(--hover); color: var(--text); }
  /* 临时对话快到清理：行尾一枚「n 天」，悬停时让位给 ⋮ */
  .d-exp { flex: none; margin-left: auto; padding: 0 4px 0 6px; font-size: 12px; color: var(--warn); font-variant-numeric: tabular-nums; transition: opacity .12s ease; }
  @media (hover: hover) { .d-row:hover .d-exp, .d-row:focus-within .d-exp { opacity: 0; } }
  /* 项目对话：标题前的项目字形（跟标题同色、略淡）；讨论串在等你：行尾琥珀点（同侧栏「等人」那枚的颜色），悬停时让位给 ⋮ */
  .d-pj { flex: none; width: 15px; height: 15px; margin-right: -2px; color: var(--muted); }
  .d-row.cur .d-pj { color: var(--text); }
  .d-pwait { flex: none; width: 7px; height: 7px; margin: 0 6px 0 auto; border-radius: 50%; background: var(--warn); transition: opacity .12s ease; }
  @media (hover: hover) { .d-row:hover .d-pwait, .d-row:focus-within .d-pwait { opacity: 0; } }
  /* 插件应用开的对话：行尾一枚应用名小标签（淡底、不抢标题），悬停时让位给 ⋮；后面还有等你点 / 剩 n 天时紧挨着排。
     类名别和「应用」组的图标框 .d-lead.d-app 共用，否则这里的淡底、内边距和 margin auto 会落到图标框上 */
  .d-apptag { flex: none; max-width: 42%; margin: 0 4px 0 auto; padding: 0 6px; height: 18px; line-height: 18px; border-radius: 5px;
    font-size: 11px; color: var(--muted); background: color-mix(in srgb, var(--text) 8%, transparent); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; transition: opacity .12s ease; }
  .d-apptag ~ .d-pwait, .d-apptag ~ .d-exp { margin-left: 2px; }
  @media (hover: hover) { .d-row:hover .d-apptag, .d-row:focus-within .d-apptag { opacity: 0; } }

  .d-lead.ck line { transform-box: view-box; transform-origin: 8px 8px;
    transition: rotate .6s cubic-bezier(.3, .9, .4, 1); }
  .d-item:active .ck .hh { rotate: 30deg; }
  .d-item:active .ck .mh { rotate: 390deg; }
  .d-sec { display: flex; align-items: center; justify-content: space-between; color: var(--muted); font-size: 12px; padding: 14px 4px 4px 10px; }
  .d-list { display: flex; flex-direction: column; }
  .d-row { position: relative; display: flex; align-items: center; border-radius: 8px; margin-bottom: .5px; transition: background-color .12s ease; }
  /* 拎着文件悬在某条会话上：这条亮起来，松手＝切过去并挂进它的输入栏 */
  .d-row.dnd-on { background: color-mix(in srgb, var(--coral) 22%, transparent); box-shadow: inset 0 0 0 1.5px var(--coral); }
  .d-row.cur { background: var(--hover-strong); }
  .d-row.cur .d-title { color: var(--text); }
  /* 分屏里另一格正开着的会话：浅一档的底 + 左侧一道细线，看得出「它也在屏上」 */
  .d-row.alt { background: var(--hover); box-shadow: inset 2px 0 0 color-mix(in srgb, var(--coral) 55%, transparent); }
  .d-row.alt .d-title { color: var(--text); }
  /* 被拎起来的那一行留在原处淡着（拖拽图/幽灵才是「手里那份」） */
  .d-row.lifted { opacity: .38; }
  .d-row[draggable="true"] { -webkit-user-drag: element; }
  /* 项目排序：拖项目时会话行整体收起（只剩一行行项目），插入线画在目标块上沿 / 列表末尾 */
  .d-pblock { position: relative; }
  .d-projs { position: relative; }
  .d-projs.reordering { padding-bottom: 18px; }
  .d-pblock.ins::before, .d-projs.ins-end::after { content: ''; position: absolute; left: 6px; right: 6px; height: 2px; border-radius: 2px;
    background: var(--coral); pointer-events: none; z-index: 2; }
  .d-pblock.ins::before { top: -1px; }
  /* 插件外观（工作区插槽）：项目自成一块。外扩 2px 再内衬 2px，块里每一行的几何和没外观时一样；
     底和描边 200ms 淡进（ease-out），没有彩边、不发光 */
  .d-pblock { border-radius: 10px; box-shadow: inset 0 0 0 1px transparent;
    transition: background-color 200ms cubic-bezier(.165, .84, .44, 1), box-shadow 200ms cubic-bezier(.165, .84, .44, 1); }
  .d-pblock.deco { background: var(--cc-box); box-shadow: inset 0 0 0 1px var(--cc-box-bd); margin: 2px -2px 6px; padding: 3px 2px 4px; }
  .d-pblock.deco + .d-pblock.deco { margin-top: 0; }
  /* 两行的项目行：图标、折叠钮、方块都对齐第一行（名字）；小字那一行从名字下面一直铺到块的右缘（压在尾按钮下面，
     不跟它们抢宽度——手机上折叠钮常显，小字挤在它左边会只剩半句）。
     折叠钮和普通项目行一样待在排版流里（桌面悬停才浮现，位置常留）：名字照常在它前面截断，不会再被压住。
     原来它和 ⋮ 悬浮在名字上、只靠两行时的渐隐让位，单行名字（插件不给小字）就被盖住了——11-24 去掉 ⋮ 时一起改回来 */
  .d-row.proj.co { align-items: flex-start; }
  .d-row.proj.co .d-recent { align-items: flex-start; }
  .d-row.proj.co.two .d-recent { padding-top: 7px; padding-bottom: 25px; }
  .d-row.proj.co .d-title { font-weight: 500; color: var(--text); }
  .d-row.proj.co .d-note { position: absolute; left: 36px; right: 10px; top: 28px; pointer-events: none; }
  .d-row.proj.co > .d-more, .d-row.proj.co > :global(.dtile) { margin-top: 3px; }
  .d-note { animation: dNoteIn 200ms cubic-bezier(.165, .84, .44, 1) both; }
  @keyframes dNoteIn { from { opacity: 0; transform: translateY(3px); } }
  /* 「谁开的」小方块：缩进带里正对项目图标那一列（同 .d-dot 的位置），收藏区没有缩进带就内联在标题前 */
  .d-by { flex: none; display: inline-flex; line-height: 0; margin-right: -2px; }
  .d-row.indent .d-by { position: absolute; left: -21.5px; top: 50%; transform: translateY(-50%); margin: 0; }
  .d-row.indent.child .d-by { left: -39.5px; }
  /* 共用块里的状态在行尾：在跑 = 官方星芒，等你 = 琥珀点；悬停时让位给 ⋮ */
  .d-spark { flex: none; display: inline-flex; margin: 0 6px 0 auto; color: var(--coral); transition: opacity .12s ease; }
  .d-row.indent .d-dot.d-end { position: static; transform: none; margin: 0 10px 0 auto; transition: opacity .12s ease; }
  .d-apptag ~ .d-spark, .d-pwait ~ .d-spark, .d-exp ~ .d-spark, .d-apptag ~ .d-dot.d-end { margin-left: 2px; }
  @media (hover: hover) { .d-row:hover .d-spark, .d-row:focus-within .d-spark, .d-row:hover .d-end, .d-row:focus-within .d-end { opacity: 0; } }
  @media (prefers-reduced-motion: reduce) { .d-note { animation: none; } .d-pblock { transition: none; } }
  .d-projs.ins-end::after { bottom: 16px; }
  /* 会话缩进到项目标题文字正下方（项目行 8 padding + 20 图标 + 8 gap = 36 − 本行 8 padding） */
  .d-row.indent { margin-left: 28px; }
  /* 子会话（官方 Desktop 子会话树）：再缩 18px，左侧一根细竖线对齐父行标题起点（28+8=36px）；
     相邻子行的竖线首尾相接成一条（行间 .5px 缝用 -1px 盖住）。 */
  .d-row.indent.child { margin-left: 46px; }
  /* 收藏区的子行（根被收藏、一家子跟过来）：那里没有 28px 缩进带，只缩 18px，竖线同样对齐父行标题起点（8px） */
  .d-row.child:not(.indent) { margin-left: 18px; }
  .d-row.child::before { content: ''; position: absolute; left: -10px; top: -1px; bottom: -1px; width: 1px; background: var(--divider); pointer-events: none; }
  .d-recent { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; padding: 8px 2px 8px 8px; border-radius: 8px; text-align: left; color: var(--serif); font-size: 14px; }
  .d-recent:active { background: var(--hover); }
  .d-bub { position: relative; width: 20px; height: 20px; flex: none; display: flex; align-items: center; justify-content: center; }
  /* 项目图标 = claude.ai 同款动态字形：Anthropicons 的 ANIM 变体轴（0→100 盒盖展开），
     悬停/按下经已注册的 --ca-anim（app.css @property）过渡驱动，回弹曲线与官网一致。 */
  .d-bub .pj { font-size: 18px; color: var(--serif);
    font-variation-settings: "ANIM" var(--ca-anim, 0), "ANM2" 0, "opsz" 20, "wght" 433;
    transition: --ca-anim .3s cubic-bezier(.34, 1.3, .64, 1); }
  .d-row.proj:active .pj { --ca-anim: 100; }
  .d-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  /* —— 会话标题跑马灯（官方实测规格，配 lib/marquee.js；data-* 运行时属性须 :global 保住
     scoped 规则不被编译器剪掉）——
     溢出（data-ov）：右缘渐隐 85%→99% 替代省略号；
     悬停行：两端渐隐，右侧 44→20px 为 ⋮ 留位，左侧 12px 只在开滚（data-run）后出现；
     开滚：内层 translateX(-溢出-44) 匀速 50px/s（--mq-x/--mq-dur 由 action 算好），
     离开行 data-run 摘除 → transition 失效瞬时弹回（官方无回程动画）。 */
  .d-scroll { display: inline-block; white-space: nowrap; vertical-align: top; }
  .d-title:global([data-ov]) { text-overflow: clip;
    mask-image: linear-gradient(to right, #000 85%, transparent 99%);
    -webkit-mask-image: linear-gradient(to right, #000 85%, transparent 99%); }
  .d-title:global([data-run]) .d-scroll { transform: translateX(calc(-1 * var(--mq-x, 0px)));
    transition: transform var(--mq-dur, 0s) linear; }
  .d-more { width: 28px; height: 28px; margin-right: 2px; border-radius: 6px; display: flex; align-items: center; justify-content: center; color: var(--muted); flex: none; transition: color .12s ease, opacity .12s ease; }
  .d-more:active { background: var(--hover-strong); }
  .d-more .ic { font-size: 16px; font-weight: 530; }
  /* 项目折叠 chevron：展开=▾ 收起=▸（旋转过渡）；桌面沿用「悬停才浮现」，但收起态常显（不然看不出折了） */
  .d-fold svg { width: 15px; height: 15px; transition: transform .16s ease; }
  .d-fold.closed svg { transform: rotate(-90deg); }
  /* 子会话折叠钮：比 ⋮ 窄一档的胶囊，收起时 chevron 转成 ▸、前面带名下条数 */
  .d-kids { flex: none; height: 24px; min-width: 24px; padding: 0 4px; margin-right: 2px; border-radius: 6px; display: inline-flex; align-items: center; justify-content: center; gap: 1px;
    color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; transition: color .12s ease, opacity .12s ease, right .12s ease; }
  .d-kids:active { background: var(--hover-strong); }
  .d-kids svg { width: 14px; height: 14px; transition: transform .16s ease; }
  .d-kids.closed svg { transform: rotate(-90deg); }
  .d-kn { line-height: 1; }
  /* 指针环境（桌面）：行悬停浮出底色，⋮ 平时隐身、行悬停/键盘聚焦才浮现，悬停 ⋮ 文字提亮，
     项目图标盒盖展开（ANIM 轴 0→100）——与 claude.ai 同款 */
  @media (hover: hover) {
    .d-item:hover { background: var(--hover); color: var(--text); }
    .d-item:hover .ck .hh { rotate: 30deg; }
    .d-item:hover .ck .mh { rotate: 390deg; }
    /* 底色只认键盘聚焦（:focus-visible）：鼠标点过的按钮会一直留着焦点，用 :focus-within 时
       上一次点的那行一直浅浅亮着，和选中行同时亮两条，像高亮错了位（11-19 录屏） */
    .d-row:hover, .d-row:has(:focus-visible) { background: var(--hover); }
    /* 当前会话悬停时仍是选中那一档：上面那条排在 .cur 之后会盖掉它，刚点开、指针还停在上面的那行就退成浅一档 */
    .d-row.cur:hover, .d-row.cur:has(:focus-visible) { background: var(--hover-strong); }
    .d-row:hover .d-title, .d-row:has(:focus-visible) .d-title { color: var(--text); }
    .d-row.proj:hover .pj { --ca-anim: 100; }
    .d-more { opacity: 0; pointer-events: none; }
    .d-row:hover .d-more, .d-row:focus-within .d-more { opacity: 1; pointer-events: auto; }
    .d-more:hover { color: var(--text); }
    .d-fold.closed { opacity: 1; pointer-events: auto; }   /* 折叠着的组：chevron 常显，不然看不出折了 */
    /* 官方同款：会话行 ⋮ 改绝对定位悬浮在行尾（不占排版位）——标题非悬停时吃满整行，
       悬停时由跑马灯的 mask 在右侧 44→20px 挖出渐隐区给按钮让位。项目行只有折叠钮，留在排版流里。 */
    .d-row:not(.proj) .d-more { position: absolute; right: 2px; top: 50%; transform: translateY(-50%); margin-right: 0; }
    .d-row:hover .d-title:global([data-ov]), .d-row:focus-within .d-title:global([data-ov]) {
      mask-image: linear-gradient(to right, transparent, #000 var(--mq-lf, 0px), #000 calc(100% - 44px), transparent calc(100% - 20px));
      -webkit-mask-image: linear-gradient(to right, transparent, #000 var(--mq-lf, 0px), #000 calc(100% - 44px), transparent calc(100% - 20px));
    }
    .d-title:global([data-run]) { --mq-lf: 12px; }   /* 左缘渐隐只在开滚后出现（官方行为） */
    /* 子会话折叠钮：同 ⋮ 一样绝对定位悬浮、不占排版位。展开着＝悬停才浮现，贴在 ⋮ 左边；
       收起着＝常显（不然看不出折了），平时贴行尾、悬停时让出 ⋮ 的位子往左挪。
       标题让位：收起的行常年给它留 36px；悬停时跑马灯的渐隐区相应加宽（--mq-fade 同步给 lib/marquee.js 算滚动终点）。 */
    .d-kids { position: absolute; top: 50%; transform: translateY(-50%); right: 30px; margin-right: 0; opacity: 0; pointer-events: none; }
    .d-row:hover .d-kids, .d-row:focus-within .d-kids, .d-kids.closed { opacity: 1; pointer-events: auto; }
    .d-kids.closed { right: 2px; }
    .d-row:hover .d-kids.closed, .d-row:focus-within .d-kids.closed { right: 30px; }
    .d-kids:hover { color: var(--text); }
    .d-row.folded .d-recent { padding-right: 36px; }
    .d-row.fam .d-title { --mq-fade: 72px; }
    .d-row.folded .d-title { --mq-fade: 48px; }
    .d-row.fam:hover .d-title:global([data-ov]), .d-row.fam:focus-within .d-title:global([data-ov]) {
      mask-image: linear-gradient(to right, transparent, #000 var(--mq-lf, 0px), #000 calc(100% - var(--mq-fade)), transparent calc(100% - var(--mq-fade) + 24px));
      -webkit-mask-image: linear-gradient(to right, transparent, #000 var(--mq-lf, 0px), #000 calc(100% - var(--mq-fade)), transparent calc(100% - var(--mq-fade) + 24px));
    }
  }
  .rowmenu-bd { position: fixed; inset: 0; z-index: 55; }
  .rowmenu { position: fixed; z-index: 56; min-width: 176px; max-width: 260px; max-height: 292px; overflow-y: auto; padding: 5px; background: var(--q-card); border-radius: 12px; box-shadow: var(--q-shadow); animation: rmPop .14s ease; }
  @keyframes rmPop { from { opacity: 0; transform: scale(.96); } to { opacity: 1; transform: none; } }
  .rowmenu button { width: 100%; display: flex; align-items: center; gap: 10px; padding: 7px 10px; border-radius: 8px; font-size: 14px; color: var(--text); text-align: left; transition: background-color .12s ease; }
  .rowmenu button:active { background: var(--hover); }
  @media (hover: hover) { .rowmenu button:hover { background: var(--hover); } }
  .rowmenu button.danger { color: var(--crit); }
  /* 插件的会话动作：图标是插件给的名字（lib/pluginIcons），与字形图标同占 20px 宽 */
  .rowmenu .plg-ic { width: 20px; height: 18px; flex: none; display: flex; align-items: center; justify-content: center; }
  .rowmenu .plg-ic :global(svg) { width: 17px; height: 17px; }
  .rowmenu .plg-lab { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .rowmenu-sep { height: 1px; margin: 4px 6px; background: var(--divider); }
  .rowmenu button:disabled { opacity: .45; pointer-events: none; }
  .mi { width: 20px; text-align: center; font-size: 18px; font-weight: 450; flex: none; }
  /* 会话行不再有图标 → 状态点占「左侧空位」：项目行有 20px 图标、会话行那一列是空的。
     缩进的会话行把点绝对定位进 28px 缩进带里（正对项目图标列中心），既不吃标题宽度、
     也不会在开跑/跑完时把标题推来推去；收藏区的会话行没有缩进带，就内联在标题前。 */
  .d-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; }
  .d-row.indent .d-dot { position: absolute; left: -14px; top: 50%; transform: translateY(-50%); }
  .d-row.indent.child .d-dot { left: -32px; }   /* 子行多缩了 18px，点仍落在项目图标那一列 */
  .d-dot.work { background: var(--coral); animation: pulse 1.2s ease-in-out infinite; }
  .d-dot.ask { background: var(--warn); animation: blink 1s steps(2) infinite; }
  @keyframes pulse { 50% { opacity: .4; } }
  @keyframes blink { 50% { opacity: 0; } }

  .d-empty { color: var(--muted); font-size: 13px; padding: 10px 11px; }
  /* 组内「显示更多 / 收起」：与会话行同缩进、同行高，次级色小一号，看得出不是一条会话 */
  .d-pager { display: block; width: calc(100% - 28px); margin-left: 28px; padding: 7px 8px; border-radius: 8px; text-align: left;
    color: var(--muted); font-size: 13px; transition: background-color .12s ease, color .12s ease; }
  .d-pager:active { background: var(--hover); }
  @media (hover: hover) { .d-pager:hover { background: var(--hover); color: var(--text); } }
  .d-spacer { flex: 1; min-height: 10px; }
  .d-pager:disabled { opacity: .6; pointer-events: none; }
  /* 搜索行右侧的快捷键提示（官方 df-search-field-keys：平时隐身、悬停才出） */
  .d-kbd { margin-left: auto; padding-left: 8px; font-size: 11.5px; color: var(--muted); font-family: Consolas, 'Cascadia Mono', Menlo, monospace; opacity: 0; transition: opacity .12s ease; }
  @media (hover: hover) { .d-item:hover .d-kbd, .d-item:focus-visible .d-kbd { opacity: 1; } }
  /* 已归档：入口行（项目列表最底下）与视图头（← 已归档 n） */
  .d-count { margin-left: auto; padding-left: 8px; font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .d-arch-ent { margin-top: 6px; }
  .d-arch-head { display: flex; align-items: center; gap: 4px; padding: 12px 4px 6px 2px; color: var(--text); font-size: 14px; font-weight: 560; }
  .d-arch-head .d-count { font-weight: 400; padding-right: 8px; }
  .d-back { width: 30px; height: 30px; display: inline-flex; align-items: center; justify-content: center; border-radius: 8px; color: var(--serif); flex: none; }
  .d-back .ic { font-size: 18px; }
  .d-back:active { background: var(--hover-strong); }
  @media (hover: hover) { .d-back:hover { background: var(--hover); color: var(--text); } }
  .d-two { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .d-sub { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; color: var(--muted); }
  .d-pager.flat { width: 100%; margin-left: 0; }

  /* —— 底部账户卡（claude.ai 左下角用户行实测：按钮 32px 圆角 8、头像 24px 圆、
     名字 14px 次级色、名字后一枚 ⌄；手机上加高到 44px 好按）。贴底：列表长了也不被滚走 —— */
  .d-foot { position: sticky; bottom: -10px; z-index: 2; flex: none; margin: 0 -8px -10px; padding: 8px 8px max(10px, var(--sab));
    background: var(--bg); transition: background-color .25s ease; }
  .d-me { width: 100%; height: 36px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 4px; border: 0; border-radius: 8px;
    background: none; color: var(--serif); font: inherit; font-size: 14px; text-align: left; cursor: pointer; transition: background-color .12s ease, color .12s ease; }
  .d-me.open { background: var(--hover-strong); color: var(--text); }
  .d-me:active { background: var(--hover); }
  @media (hover: hover) { .d-me:hover { background: var(--hover); color: var(--text); } }
  .d-me .av { width: 26px; height: 26px; border-radius: 50%; flex: none; display: flex; align-items: center; justify-content: center;
    background: var(--avatar-bg); color: var(--text); font-size: 12px; font-weight: 560; }
  .d-me-n { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
  .d-me-r { color: var(--muted); }
  .d-me-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--st-accent); }
  .d-me-chev { flex: none; font-family: var(--icons); font-size: 16px; line-height: 1; color: var(--muted); transition: transform .15s ease; }
  .d-me.open .d-me-chev { transform: rotate(180deg); }
  @media (pointer: coarse) { .d-me { height: 44px; } .d-me .av { width: 30px; height: 30px; font-size: 13px; } }
</style>
