<script>
  // 工作空间（手机 FilesPanel）滚动区里路径条以下的正文：本地 / 这台电脑的位置主页、位置栏、最近、文件夹、文件、空态。
  // P 是外壳（FilesPanel.svelte）交出来的状态与动作视图；样式里的配色令牌由外壳 .ws-root 给。
  import Sym from '../../ios27/Sym.svelte';
  // 平滑圆角遮罩、文件夹图标：原版资源
  import wsIcon from '../../../visuals/assets/icons/workspace.png';
  import { t, tc, tr } from '../../../lib/i18n.js';
  import { extBadge, nameHtml, typeIconSvg } from '../../../lib/fileGrid.js';
  import { canAllFiles } from '../../../lib/localfs.js';
  import { drag, dropZone, isDragging } from '../../../lib/dragdrop.svelte.js';
  import { fmtSize, kindOf } from '../../../lib/files/common.js';
  import { FOLDER_GLYPH, PC_GLYPH, fileIcon, fmtTime, rootIcon } from './panelLook.js';
  // 最近 / 文件夹 / 文件 / 空态各包一层 in:swap：页面推进来时已有列表（内存缓存或上次的快照）就跟着页面一起出、不播；
  // 页面挂好以后列表才到（全新安装、没进过的子目录）才淡入接住，不是一帧之内整屏蹦出来。
  // 包一层而不是挂在分组里的元素上：过渡是局部的，网格在内层 {#if 显示方式} 里，外层块晚到时它不会播
  import { swap } from '../../../lib/arrive.js';

  const { P } = $props();
</script>

{#snippet hidToggle()}
  <button class="hid-tg" onclick={P.toggleHidden}>{P.showHidden ? t('收起隐藏项') : t('显示隐藏项')}<small>{P.hidTotal}</small></button>
{/snippet}
    {#if P.isLocal && !P.localPicked}
      <!-- 本地工作空间未授权：引导用户用系统选择器选一个手机文件夹 -->
      <div class="local-intro">
        <img class="li-icon" src={wsIcon} alt="" />
        <h3>{t('本地工作空间')}</h3>
        {#if P.localAvail}
          <p>{t('选择手机里的一个文件夹设为本地工作空间，')}<br />{t('在这里浏览预览它的文件。')}</p>
          <button class="li-pick" disabled={P.localPicking} onclick={P.doPickLocal}>{P.localPicking ? t('请在系统选择器中选择…') : t('选择手机文件夹')}</button>
          {#if canAllFiles()}
            <button class="li-pick alt" disabled={P.localPicking} onclick={P.doPickAll}>{t('授权整个手机存储')}</button>
            <p class="li-hint">{t('「整个手机」一次授权后可访问全部用户文件（除各 App 私有数据区，那是系统保护的）。需在系统设置里打开「所有文件访问」开关。')}</p>
          {/if}
        {:else}
          <p>{t('本地工作空间用于浏览手机本地文件，')}<br />{t('需要在手机 App 内使用。')}</p>
        {/if}
      </div>
    {:else if P.atHome}
      <!-- 本地位置主页：每个已授权文件夹一行（可进入/管理），底部「添加文件夹」 -->
      <div class="sechead"><h2>{t('本地位置')}</h2></div>
      <div class="filecard loc-list">
        {#each P.roots as r (r.id)}
          <div class="frow" role="button" tabindex="0" onclick={() => P.load(r.id)}
            onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && P.load(r.id)}>
            <span class="loc-ic">{@html rootIcon(r.mode)}</span>
            <span class="meta"><span class="nm">{r.name}</span><span class="fsub">{r.mode === 'all' ? t('整机存储') : t('手机文件夹')}</span></span>
            <button class="dots" aria-label={t('管理')} onclick={(e) => { e.stopPropagation(); P.rootMenu = P.rootMenu ? null : { root: r, anchor: e.currentTarget }; }}><Sym name="ellipsis.circle" weight={400} size={20} /></button>
          </div>
        {/each}
      </div>
      <div class="filecard">
        <button class="frow loc-add" disabled={P.localPicking} onclick={(e) => P.openAddLoc(e.currentTarget.querySelector('.loc-ic'))}>
          <span class="loc-ic"><Sym name="plus.circle.fill" weight={400} size={24} /></span>
          <span class="meta"><span class="nm">{t('添加文件夹')}</span></span>
        </button>
      </div>
      <p class="loc-note">{t('这些是你授权 The Bridge 访问的手机文件夹，可随时增删。Claude 的手机文件工具也在这些位置内活动。')}</p>
    {:else if P.pcLocal && P.pcHome}
      <!-- 这台电脑的位置主页（同上面手机「本地位置」）：服务器在别处，这里列的是本机授权过的文件夹，
           点进去在本机浏览、预览，字节不经过服务器 -->
      <div class="sechead"><h2>{tc('files', '位置')}</h2></div>
      {#if P.desktopLocations.length}
        <div class="filecard loc-list">
          {#each P.desktopLocations as loc (loc.id)}
            <div class="frow" role="button" tabindex="0" onclick={() => P.selectDesktopLocation(loc.id)}
              onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && P.selectDesktopLocation(loc.id)}>
              <span class="loc-ic">{@html loc.id === 'primary' ? PC_GLYPH : FOLDER_GLYPH}</span>
              <span class="meta"><span class="nm">{tr(loc.name)}</span><span class="fsub">{P.pcLocAbs[loc.id] || (loc.id === 'primary' ? t('默认文件夹') : t('电脑文件夹'))}</span></span>
              <button class="dots" aria-label={t('管理')} onclick={(e) => { e.stopPropagation(); P.pcLocMenu = P.pcLocMenu ? null : { loc, anchor: e.currentTarget }; }}><Sym name="ellipsis.circle" weight={400} size={20} /></button>
            </div>
          {/each}
        </div>
      {/if}
      <div class="filecard">
        <button class="frow loc-add" onclick={P.addDesktopLocation}>
          <span class="loc-ic"><Sym name="plus.circle.fill" weight={400} size={24} /></span>
          <span class="meta"><span class="nm">{t('添加文件夹')}</span></span>
        </button>
      </div>
      <p class="loc-note">{t('这些是这台电脑上你授权 The Bridge 访问的文件夹：在本机直接浏览、预览，文件不经过服务器。可随时增删。')}</p>
    {:else}

    {#if P.wsPick && P.pickerLocations.length > 1}
      <!-- 位置栏：文件管理器本身锁在身份工作空间根（admin=vault），可真实项目一大半在库外
           （claude-bridge / agent trading / Dimensio Projects…）。这一条把可达范围补回整机，
           授权边界仍由服务端 authorizeProjectPath 判——Pro 只会拿到自己那一条，这行不出现。 -->
      <div class="sechead"><h2>{tc('files', '位置')}</h2></div>
      <div class="desktop-locations">
        {#each P.pickerLocations as loc (loc.id)}
          <button class="desktop-location" class:on={loc.id === P.pickerLocationId} onclick={() => P.onPickLocation?.(loc)}>
            <span class="dl-icon">📁</span><span>{tr(loc.name)}</span>
          </button>
        {/each}
      </div>
    {/if}


    {#if P.desktopNative && !P.pcLocal && !P.path && !P.query && P.desktopLocations.length}
      <div class="sechead"><h2>{tc('files', '位置')}</h2></div>
      <div class="desktop-locations">
        {#each P.desktopLocations as loc (loc.id)}
          <div class="desktop-location" class:on={loc.id === P.desktopLocationId} role="button" tabindex="0"
            onclick={() => P.selectDesktopLocation(loc.id)}
            onkeydown={(e) => (e.key === 'Enter' || e.key === ' ') && P.selectDesktopLocation(loc.id)}>
            <span class="dl-icon">📁</span><span>{tr(loc.name)}</span>
            {#if loc.removable}<button class="dl-remove" aria-label={t('移除位置')} onclick={(e) => { e.stopPropagation(); P.removeDesktopLocation(loc); }}>×</button>{/if}
          </div>
        {/each}
        <button class="desktop-location add" onclick={P.addDesktopLocation}><span class="dl-icon">＋</span><span>{t('添加位置')}</span></button>
      </div>
    {/if}

    {#if P.listMeta.truncated && !P.q && !P.isLocal && !P.desktopNative && P.items.length}
      <!-- 上千项的目录服务端只给前 1500 项（文件夹排在前面）：放在顶上明说——放底部要先划过 1500 项才看得见——
           并把人引到能找全的搜索上（截断时搜索改问服务端，见 srvMatches） -->
      <div class="trunc-note">{t('这里一共 {total} 项，只列出了前 {shown} 项（文件夹排在前面），其余的可以', { total: P.listMeta.total, shown: P.items.length })}<button onclick={P.openSearch}>{t('按名字搜索')}</button>{t('。')}</div>
    {/if}

    {#if P.recents.length}
    <div class="arr" in:swap>
      <div class="sechead"><h2>{t('最近')}</h2></div>
      <div class="recents">
        {#each P.recents as it (it.name)}
          <button class="rcard" class:dnd-lift={P.liftRels.has(P.itemRel(it))} class:dnd-arm={P.armRel === P.itemRel(it)} draggable={P.dragOutOn ? 'true' : undefined} ondragstart={(e) => P.rowDragStart(e, it)}
            onpointerdown={(e) => P.pressDown(e, it)} onpointermove={P.pressMove} onpointerup={P.pressUp} onpointercancel={P.pressUp}
            onclick={() => (isDragging() ? P.stackToDrag(it) : P.openFile(it))} oncontextmenu={(e) => P.onCtxMenu(e, it)}>
            <!-- 彩色渐变底只属于「真要铺一张图」的格子：图片文件万一取不到缩略图、
                 回落成 32×32 系统图标时，别在渐变底上摆一个小灰纸片。 -->
            <span class="thumb" data-rel={P.itemRel(it)} class:img={kindOf(it.name) === 'img' && !P.iconThumb(it)} style={kindOf(it.name) === 'img' && !P.iconThumb(it) ? 'background:linear-gradient(135deg,#ffd29d,#ff8db1)' : ''}>
              {#if kindOf(it.name) !== 'img' && !P.iconThumb(it)}<span class="ic">{@html fileIcon(it.name)}</span>{/if}
              {#if P.iconThumb(it)}
                <!-- 系统类型图标：占位 SVG 直接让位（图标底是透明的，叠着会露出下面那张纸），
                     dataUrl 本就在内存里，不用 .ok 淡入那套。 -->
                <img class="ricon" src={it.nativeThumb} alt="" draggable="false" />
              {:else if P.thumbable(it)}
                <img class="rthumb" src={P.thumbSrc(it)} alt="" loading="lazy" decoding="async" draggable="false"
                  data-cloud={P.isLocal ? undefined : '1'} onload={P.thumbOk} onerror={P.thumbErr} />
                {#if kindOf(it.name) === 'mov'}<span class="rplay"><svg viewBox="0 0 24 24"><path d="M8.4 5.8v12.4L19 12z" /></svg></span>{/if}
              {/if}
            </span>
            <span class="nm">{it.name}</span>
            <span class="mt">{fmtTime(it.mtime)}</span>
          </button>
        {/each}
      </div>
    </div>
    {/if}

    {#if P.showFolders.length}
    <div class="arr" in:swap>
      <div class="sechead" class:has-act={P.hidSwitch}><h2>{tc('files', '文件夹')}</h2>{#if P.hidSwitch}{@render hidToggle()}{/if}</div>
      {#if P.viewMode !== 'list'}
      <div class="cgrid" class:big={P.viewMode === 'large'}>
        {#each P.showFolders as f (f.rel || f.name)}
          <button class="cell dir" class:sel={P.selected.has(f.name)} class:dropin={P.dropOn === f.name || drag.overKey === 'ws-dir:' + P.itemRel(f)} draggable={P.dragOutOn ? 'true' : undefined} ondragstart={(e) => P.rowDragStart(e, f)}
            class:dnd-lift={P.liftRels.has(P.itemRel(f))} class:dnd-arm={P.armRel === P.itemRel(f)} class:dnd-spring={drag.springKey === 'ws-dir:' + P.itemRel(f)}
            use:dropZone={P.folderZone(f)}
            ondragover={(e) => P.dragOverFolder(e, f.name)} ondrop={P.onDropUpload}
            onpointerdown={(e) => P.pressDown(e, f)} onpointermove={P.pressMove} onpointerup={P.pressUp} onpointercancel={P.pressUp}
            onclick={() => P.enterDir(f)} oncontextmenu={(e) => P.onCtxMenu(e, f)}>
            <span class="tile">
              <img class="fold" src={wsIcon} alt="" draggable="false" />
              {#if P.selecting}<span class="selc" class:on={P.selected.has(f.name)}>{#if P.selected.has(f.name)}<Sym name="checkmark.circle.fill" weight={400} size={22} />{/if}</span>{/if}
            </span>
            <span class="nm">{@html nameHtml(f.name)}</span>
            <span class="sub">{P.cellSub(f)}</span>
          </button>
        {/each}
      </div>
      {:else}
      <div class="foldergrid">
        {#each P.showFolders as f (f.rel || f.name)}
          <button class="folder" class:sel={P.selected.has(f.name)} class:dropin={P.dropOn === f.name || drag.overKey === 'ws-dir:' + P.itemRel(f)} draggable={P.dragOutOn ? 'true' : undefined} ondragstart={(e) => P.rowDragStart(e, f)}
            class:wp-lift={P.wsPick && P.pkDrag?.abs === P.pkAbs(P.itemRel(f))} class:dnd-lift={P.liftRels.has(P.itemRel(f))} class:dnd-arm={P.armRel === P.itemRel(f)}
            class:dnd-spring={drag.springKey === 'ws-dir:' + P.itemRel(f)}
            use:dropZone={P.folderZone(f)}
            ondragover={(e) => P.dragOverFolder(e, f.name)} ondrop={P.onDropUpload}
            onpointerdown={(e) => P.pressDown(e, f)} onpointermove={P.pressMove} onpointerup={P.pressUp} onpointercancel={P.pressUp}
            onclick={() => P.enterDir(f)} oncontextmenu={(e) => P.onCtxMenu(e, f)}>
            {#if P.selecting}<span class="selc" class:on={P.selected.has(f.name)}>{#if P.selected.has(f.name)}<Sym name="checkmark.circle.fill" weight={400} size={22} />{/if}</span>{/if}
            <img class="ficon" src={wsIcon} alt="" draggable="false" />
            <span class="nm">{f.name}</span>
          </button>
        {/each}
      </div>
      {/if}
    </div>
    {/if}

    {#if P.showFiles.length}
    <div class="arr" in:swap>
      <div class="sechead" class:has-act={P.hidSwitch && !P.showFolders.length}><h2>{tc('files', '文件')}</h2>{#if P.hidSwitch && !P.showFolders.length}{@render hidToggle()}{/if}</div>
      {#if P.viewMode !== 'list'}
      <div class="cgrid" class:big={P.viewMode === 'large'}>
        {#each P.showFiles as f (f.rel || f.name)}
          <div class="cell" class:sel={P.selected.has(f.name)} class:flash={P.flashRel === P.itemRel(f)} class:dnd-lift={P.liftRels.has(P.itemRel(f))} class:dnd-arm={P.armRel === P.itemRel(f)} role="button" tabindex="0" draggable={P.dragOutOn ? 'true' : undefined} ondragstart={(e) => P.rowDragStart(e, f)}
            onpointerdown={(e) => P.pressDown(e, f)} onpointermove={P.pressMove} onpointerup={P.pressUp} onpointercancel={P.pressUp}
            onclick={() => (isDragging() ? P.stackToDrag(f) : P.openFile(f))} oncontextmenu={(e) => P.onCtxMenu(e, f)}
            onkeydown={(e) => { if (e.key === 'Enter') P.openFile(f); }}>
            <span class="tile" class:th={P.isMedia(f) && !P.iconThumb(f)} data-rel={P.itemRel(f)}>
              {#if P.iconThumb(f)}
                <img class="ricon" src={f.nativeThumb} alt="" draggable="false" />
              {:else}
                <span class="ti">{@html typeIconSvg(f.name)}{#if extBadge(f.name)}<b>{extBadge(f.name)}</b>{/if}</span>
                {#if P.cellThumbable(f)}
                  <img class="cthumb" class:doc={!P.isMedia(f)} src={P.cellSrc(f)} alt="" loading="lazy" decoding="async" draggable="false"
                    data-cloud={P.isLocal ? undefined : '1'} onload={P.thumbOk} onerror={P.cellErr} />
                {/if}
              {/if}
              {#if P.durOf(f)}<span class="dur">{P.durOf(f)}</span>{:else if kindOf(f.name) === 'mov'}<span class="cplay"><svg viewBox="0 0 24 24"><path d="M8.4 5.8v12.4L19 12z" /></svg></span>{/if}
              {#if P.selecting}<span class="selc" class:on={P.selected.has(f.name)}>{#if P.selected.has(f.name)}<Sym name="checkmark.circle.fill" weight={400} size={22} />{/if}</span>{/if}
            </span>
            <span class="nm">{@html nameHtml(f.name)}</span>
            <span class="sub">{P.cellSub(f)}</span>
          </div>
        {/each}
      </div>
      {:else}
      <div class="filecard">
        {#each P.showFiles as f (f.rel || f.name)}
          <div class="frow" class:sel={P.selected.has(f.name)} class:flash={P.flashRel === P.itemRel(f)} class:wp-flat={P.wsPick} class:dnd-lift={P.liftRels.has(P.itemRel(f))} class:dnd-arm={P.armRel === P.itemRel(f)} role="button" tabindex="0" draggable={P.dragOutOn ? 'true' : undefined} ondragstart={(e) => P.rowDragStart(e, f)}
            onpointerdown={(e) => P.pressDown(e, f)} onpointermove={P.pressMove} onpointerup={P.pressUp} onpointercancel={P.pressUp}
            onclick={() => (isDragging() ? P.stackToDrag(f) : P.openFile(f))} oncontextmenu={(e) => P.onCtxMenu(e, f)}>
            {#if P.selecting}<span class="selc" class:on={P.selected.has(f.name)}>{#if P.selected.has(f.name)}<Sym name="checkmark.circle.fill" weight={400} size={22} />{/if}</span>{/if}
            <span class="ficon-sm" data-rel={P.itemRel(f)}>
              {@html fileIcon(f.name)}
              {#if P.thumbable(f)}
                <img class="fthumb" src={P.thumbSrc(f)} alt="" loading="lazy" decoding="async" draggable="false"
                  data-cloud={P.isLocal ? undefined : '1'} onload={P.thumbOk} onerror={P.thumbErr} />
                {#if kindOf(f.name) === 'mov'}<span class="fplay"><svg viewBox="0 0 24 24"><path d="M8.4 5.8v12.4L19 12z" /></svg></span>{/if}
              {/if}
            </span>
            <span class="meta"><span class="nm">{f.name}</span><span class="fsub">{f.parent ? `${f.parent} · ` : ''}{fmtTime(f.mtime)} · {fmtSize(f.size)}{P.durOf(f) ? ` · ${P.durOf(f)}` : ''}{f.linkType ? ` · ${f.linkType === 'external-link' ? t('外部链接（只读）') : t('链接')}` : ''}</span></span>
            {#if !P.wsPick}
              <button class="dots" aria-label={t('更多')} onclick={(e) => { e.stopPropagation(); P.openDots(e, f); }}><Sym name="ellipsis.circle" weight={400} size={20} /></button>
            {/if}
          </div>
        {/each}
      </div>
      {/if}
    </div>
    {/if}

    {#if P.isEmpty}
      <!-- 打不开（没权限/不存在/断网）与「真的是空的」分开说：整机浏览时前者很常见 -->
      <div class="empty" in:swap><div class="big">{P.query ? '🔍' : P.loadErr ? (/权限|permission/i.test(P.loadErr) ? '🔒' : '⚠️') : '📂'}</div>{P.query ? t('未找到相关文件') : P.loadErr || t('这个文件夹是空的')}</div>
    {/if}
    {/if}

<style>
  .folder.dropin { background: var(--blue-soft); box-shadow: inset 0 0 0 2px var(--blue); border-radius: 18px; }
  /* —— 全域拖拽的三处视觉：被拎走的原位 / 悬停在某一级面包屑 / 悬停在当前目录空白处 ——
     幽灵卡片由 DragLayer 画（全局唯一一层），这里只负责「源」和「落点」的状态。 */
  .dnd-lift { opacity: .34; transition: opacity .12s ease; }
  /* 按住还没到门槛：整个长按期间慢慢压下去，松手/挪开即弹回（iOS 拿起前的那一下「压」） */
  .dnd-arm, .folder.dnd-arm:active { transform: scale(.955); transition: transform .42s cubic-bezier(.25, .7, .3, 1); }
  .frow.dnd-arm { background: var(--fill3); }
  /* 弹簧倒计时：格子轻轻起伏两下，配合幽灵上的进度环，说明「再停一会儿就进去了」 */
  .folder.dnd-spring { animation: dndSpringPulse .65s ease-in-out; }
  @keyframes dndSpringPulse { 35% { transform: scale(1.07); } 70% { transform: scale(1.02); } 100% { transform: scale(1.07); } }
  /* 分组标题右侧的「隐藏项」开关：15pt 蓝字 + 次级色计数 */
  .sechead.has-act { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
  .hid-tg { flex: none; border: 0; padding: 0; background: none; font: inherit; font-size: 15px; line-height: 20px; letter-spacing: -.23px; color: var(--blue); cursor: pointer; }
  .hid-tg:active { opacity: .55; }
  .hid-tg small { margin-left: 4px; font-size: 13px; color: var(--label2); font-variant-numeric: tabular-nums; }

  .desktop-location { flex: none; min-height: 32px; display: inline-flex; align-items: center; gap: 6px; padding: 0 14px; border: 0; border-radius: 999px;
    font: inherit; font-size: 15px; line-height: 20px; font-weight: 500; letter-spacing: -.23px; color: var(--blue); background: var(--fill3); cursor: pointer;
    -webkit-tap-highlight-color: transparent; transition: transform .16s cubic-bezier(.2,0,0,1); }
  .desktop-location:active { transform: scale(.96); }
  .desktop-location.on { background: var(--blue); color: #fff; }
  .desktop-locations { display: flex; gap: 8px; overflow-x: auto; padding: 0 20px 4px; scrollbar-width: none; }
  .desktop-locations::-webkit-scrollbar { display: none; }
  .desktop-location { max-width: 220px; white-space: nowrap; }
  .desktop-location > span:last-child { overflow: hidden; text-overflow: ellipsis; }
  .dl-icon { font-size: 15px; }
  .dl-remove { display: grid; place-items: center; width: 18px; height: 18px; margin-left: 2px; padding: 0; border: 0; border-radius: 50%; background: rgba(255,255,255,.28); color: inherit; font-size: 15px; line-height: 1; }
  .desktop-location:not(.on) .dl-remove { background: var(--fill); color: var(--label2); }
  .trunc-note { margin: 6px 20px 0; padding: 10px 14px; border-radius: 18px; background: var(--fill3); font-size: 13px; line-height: 18px; color: var(--label2); }
  .trunc-note button { background: none; border: none; padding: 0 2px; font: inherit; font-weight: 600; color: var(--blue); }
  /* 正在被拖走的那一份：原位淡下去，注意力跟着幽灵走 */
  .wp-lift { opacity: .34; }
  /* 选择器里的文件只是「认路用」的参照物，不可点开——去掉一切可交互暗示 */
  .wp-flat { opacity: .55; cursor: default; }
  .wp-flat:active { background: none; }
  /* 分组标题：kit「Header / Type=Prominent」20/25 Semibold、字距 −0.45，左内距 16（卡片左缘 + 正文对齐） */
  .sechead { padding: 18px 20px 8px; }
  .sechead h2 { margin: 0; font-size: 20px; line-height: 25px; font-weight: 600; letter-spacing: -.45px; }

  /* 最近：图标与文字都左对齐（同左缘），卡片收窄、间距收紧 */
  .recents { display: flex; gap: 12px; overflow-x: auto; padding: 4px 20px 8px; scrollbar-width: none; }
  .recents::-webkit-scrollbar { display: none; }
  .rcard { flex: 0 0 78px; min-width: 0; background: none; border: none; padding: 0; text-align: left; cursor: pointer; color: inherit; }
  .rcard .thumb { position: relative; width: 78px; height: 66px; border-radius: 14px; overflow: hidden; display: flex; align-items: center; justify-content: flex-start; }
  .rcard .thumb.img { box-shadow: 0 0 0 .5px rgba(60,60,67,.12), 0 2px 8px rgba(0,0,0,.06); background-size: cover; background-position: center; }
  .rcard .thumb .ic { display: flex; }
  .rcard .thumb .ic :global(svg) { width: 54px; height: 64px; filter: drop-shadow(0 2px 6px rgba(0,0,0,.14)); }
  /* 系统类型图标：占位 SVG 的同一个左对齐槽位里 contain，最多放大到 48px。
     绝不能像媒体缩略图那样 absolute+cover 铺满整块 78×66——Windows 只给得出 32×32，
     铺满＝放大 2.44 倍再纵向裁掉 12px（纸的上下沿和折角全被切没，还糊）。 */
  .rcard .thumb .ricon { width: 54px; height: 100%; padding: 9px 3px; box-sizing: border-box; object-fit: contain; }
  /* 最近卡片缩略图：叠在渐变底/类型图标上层，加载完成才淡入（加载前它们就是占位缓冲）。
     .ok 由 onload 运行时挂上，必须 :global 否则被 Svelte 当未使用选择器剪掉。 */
  .rthumb { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .3s ease; }
  .rthumb:global(.ok) { opacity: 1; }
  .rcard .nm { display: block; max-width: 78px; margin-top: 6px; font-size: 13px; line-height: 16px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .rcard .mt { display: block; font-size: 12px; line-height: 15px; color: var(--label2); }

  /* 文件夹格子按【容器】宽度分列（容器＝上面的 .scroll）：侧栏 300px 仍是 3 列，整页跑在折叠屏展开态才铺到 4–5 列。 */
  .foldergrid { display: grid; grid-template-columns: repeat(3, 1fr); row-gap: 14px; padding: 6px 14px 0; }
  @container (min-width: 620px) { .foldergrid { grid-template-columns: repeat(4, 1fr); } }
  @container (min-width: 900px) { .foldergrid { grid-template-columns: repeat(5, 1fr); } }
  .folder { position: relative; min-width: 0; display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 8px 4px 6px; border-radius: 18px; background: none; border: none; cursor: pointer; color: inherit;
    transition: transform .22s cubic-bezier(.32,.72,0,1), background .2s; }
  .folder:active { transform: scale(.94); }
  .folder.sel { background: var(--blue-soft); }
  .folder .ficon { width: 84px; height: 74px; flex: none; object-fit: contain; filter: drop-shadow(0 4px 7px rgba(40,120,200,.26)); }
  .folder .nm { width: 100%; font-size: 13px; line-height: 18px; font-weight: 500; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  /* 图标 / 大图标视图：方格以缩略图为主（cover 裁切、圆角、发丝描边），名称最多两行居中，副行小字。
     按容器分列：手机 3 / 2 列，折叠屏展开、平板逐档加列。content-visibility 让几千项的相册滚动时只排可见的那几屏。 */
  .cgrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 16px 10px; padding: 6px 16px 0; }
  .cgrid.big { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 18px 12px; }   /* 大图标别叫 .lg：全局 .lg 是液态玻璃（淡底 + 边光 + 高光），撞名会在网格后面铺一块白板 */
  @container (min-width: 560px) { .cgrid { grid-template-columns: repeat(4, minmax(0, 1fr)); } .cgrid.big { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
  @container (min-width: 760px) { .cgrid { grid-template-columns: repeat(5, minmax(0, 1fr)); } .cgrid.big { grid-template-columns: repeat(4, minmax(0, 1fr)); } }
  @container (min-width: 980px) { .cgrid { grid-template-columns: repeat(6, minmax(0, 1fr)); } .cgrid.big { grid-template-columns: repeat(5, minmax(0, 1fr)); } }
  .cell { position: relative; min-width: 0; display: flex; flex-direction: column; align-items: stretch; gap: 0; padding: 0; border: 0; background: none; font: inherit; color: inherit; text-align: center; cursor: pointer;
    -webkit-tap-highlight-color: transparent; content-visibility: auto; contain-intrinsic-size: auto 150px; }
  .cgrid.big .cell { contain-intrinsic-size: auto 214px; }
  .tile { position: relative; display: block; aspect-ratio: 1; border-radius: 12px; overflow: hidden; background: var(--fill3);
    transition: transform var(--mo-tap) var(--ea-accel), box-shadow var(--mo-micro) var(--ea-std); }
  .cgrid.big .tile { border-radius: 14px; }
  .tile::after { content: ''; position: absolute; inset: 0; border-radius: inherit; box-shadow: inset 0 0 0 .5px rgba(0,0,0,.1); pointer-events: none; }
  :global(.ws-root.ios-dark) .tile::after { box-shadow: inset 0 0 0 .5px rgba(255,255,255,.12); }
  .cell:active .tile { transform: scale(.96); }
  .cell.dir .tile { background: none; }
  .cell.dir .tile::after { content: none; }
  .tile .fold { position: absolute; inset: 0; margin: auto; width: 78%; height: 78%; object-fit: contain; filter: drop-shadow(0 4px 7px rgba(40,120,200,.22)); }
  .ti { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; color: var(--label2); }
  .ti :global(svg) { width: 34px; height: 34px; }
  .cgrid.big .ti :global(svg) { width: 46px; height: 46px; }
  .ti b { font-size: 10px; line-height: 12px; font-weight: 600; letter-spacing: .4px; color: var(--label3); }
  .tile.th .ti { visibility: hidden; }
  .tile.th:global(.bad) .ti { visibility: visible; }
  .cthumb { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity var(--mo-quick) var(--ea-fade); }
  .cthumb.doc { object-position: top; background: #fff; }
  .cthumb:global(.ok) { opacity: 1; }
  .tile .ricon { position: absolute; inset: 0; margin: auto; width: 40%; height: 40%; object-fit: contain; }
  /* 视频：右下角时长胶囊（实色半透明，不在画面上叠毛玻璃）；时长还没算出来时先给居中播放角标 */
  .dur { position: absolute; right: 5px; bottom: 5px; padding: 1px 5px; border-radius: 6px; background: rgba(0,0,0,.5); color: #fff;
    font-size: 11px; line-height: 15px; font-weight: 600; font-variant-numeric: tabular-nums; pointer-events: none; }
  .cplay { position: absolute; right: 6px; bottom: 6px; width: 20px; height: 20px; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: rgba(0,0,0,.45); pointer-events: none; }
  .cplay svg { width: 60%; height: 60%; fill: #fff; margin-left: 6%; }
  .cell .nm { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; overflow: hidden; margin-top: 6px; padding: 0 2px;
    font-size: 13px; line-height: 16px; font-weight: 500; overflow-wrap: anywhere; }
  .cell .sub { display: block; min-height: 15px; font-size: 12px; line-height: 15px; color: var(--label2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-variant-numeric: tabular-nums; }
  .cell .selc { position: absolute; top: 6px; left: 6px; width: 22px; height: 22px; background: rgba(0,0,0,.18); }
  .cell .selc:not(.on) { box-shadow: inset 0 0 0 1.5px #fff, 0 1px 3px rgba(0,0,0,.25); }
  .cell .selc.on { background: #fff; }
  /* 选中 / 回位高亮的描边画在格子里面（::after 盖在缩略图上）：.cell 带 content-visibility，隐含 paint containment，
     画在格子外面的 box-shadow 会被裁得只剩底边一截蓝条 */
  .cell.sel .tile::after, .cell.flash .tile::after { content: ''; }
  .cell.sel .tile::after { box-shadow: inset 0 0 0 2.5px var(--blue); }
  .cell.dir.sel .tile { background: var(--blue-soft); }
  .cell.dropin .tile { background: var(--blue-soft); box-shadow: inset 0 0 0 2px var(--blue); }
  .cell.dnd-spring .tile { animation: dndSpringPulse .65s ease-in-out; }
  /* 关掉查看器后：刚才看的那一格 / 那一行短暂亮一下（只动 opacity 与 box-shadow） */
  .cell.flash .tile::after { animation: cellFlash 1.3s var(--ea-fade) both; }
  .frow.flash { animation: rowFlash 1.3s var(--ea-fade) both; }
  @keyframes cellFlash { 0%, 55% { box-shadow: inset 0 0 0 3px var(--blue); } 100% { box-shadow: inset 0 0 0 3px transparent; } }
  @keyframes rowFlash { 0%, 55% { background: var(--blue-soft); } 100% { background: transparent; } }
  @media (prefers-reduced-motion: reduce) {
    .cell.flash .tile::after { animation: none; box-shadow: inset 0 0 0 3px var(--blue); }
    .frow.flash { animation: none; background: var(--blue-soft); }
    .cell:active .tile { transform: none; }
  }

  /* 多选圈：kit 列表的选择标记——未选 Labels/Tertiary 空心圈，选中 checkmark.circle.fill 蓝 */
  .selc { display: flex; align-items: center; justify-content: center; border-radius: 50%; color: var(--blue); }
  .selc:not(.on) { box-shadow: inset 0 0 0 1.5px var(--label3); }
  .folder .selc { position: absolute; top: 6px; left: 14px; width: 22px; height: 22px; background: var(--paper); box-shadow: 0 0 0 2px var(--paper); }
  .folder .selc:not(.on) { box-shadow: inset 0 0 0 1.5px var(--label3), 0 0 0 2px var(--paper); }
  .frow .selc { flex: 0 0 22px; width: 22px; height: 22px; }

  /* 文件 / 位置列表：kit 分组卡（Grouped Table View：圆角 26、Figma 平滑 60%——9 宫遮罩还原；左右内缩 20）。
     行＝kit「Row」带副标题：正文 17/22、副文 15/20 Labels/Secondary，分隔线 1pt 从正文起到右内边距止 */
  .filecard { margin: 6px 20px 0; background: var(--card); border-radius: 26px; -webkit-mask-box-image: var(--sq) 42 / 42px; overflow: hidden; }
  .frow { position: relative; display: flex; align-items: center; gap: 12px; width: 100%; min-height: 60px; padding: 0 6px 0 14px; cursor: pointer; transition: background .15s;
    border: 0; background: none; font: inherit; color: inherit; text-align: left; }
  .frow:active { background: var(--press); }
  .frow.sel { background: var(--blue-soft); }
  .frow + .frow::before { content: ''; position: absolute; top: 0; left: 60px; right: 16px; height: 1px; background: var(--sep); }
  .ficon-sm { position: relative; flex: 0 0 34px; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; }
  .ficon-sm :global(svg) { width: 28px; height: 35px; filter: drop-shadow(0 1px 2px rgba(0,0,0,.06)); }
  /* 文件行缩略图：盖在类型图标上层，加载完成才淡入；失败保持透明露出图标 */
  .fthumb { position: absolute; inset: 0; width: 34px; height: 34px; object-fit: cover; border-radius: 7px;
    box-shadow: 0 0 0 .5px var(--sep); background: var(--paper); opacity: 0; transition: opacity .25s ease; }
  .fthumb:global(.ok) { opacity: 1; }
  /* 视频播放角标：跟随各自缩略图淡入（缩略没出来时不遮类型图标） */
  .fplay, .rplay { position: absolute; inset: 0; margin: auto; display: flex; align-items: center; justify-content: center;
    background: rgba(20,20,24,.45); border-radius: 50%; opacity: 0; transition: opacity .25s ease; pointer-events: none; }
  .fplay { width: 16px; height: 16px; }
  .rplay { width: 24px; height: 24px; }
  .fplay svg, .rplay svg { width: 60%; height: 60%; fill: #fff; filter: none; margin-left: 6%; }
  .fthumb:global(.ok) + .fplay, .rthumb:global(.ok) + .rplay { opacity: 1; }
  .frow .meta { flex: 1; min-width: 0; padding: 9px 0; }
  .frow .meta .nm { display: block; font-size: 17px; line-height: 22px; letter-spacing: -.43px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .frow .meta .fsub { display: block; font-size: 15px; line-height: 20px; letter-spacing: -.23px; color: var(--label2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .frow .dots { flex: 0 0 44px; height: 44px; border: none; background: none; display: flex; align-items: center; justify-content: center; color: var(--blue); border-radius: 50%; padding: 0; }
  .frow .dots:active { background: var(--fill); }

  .empty { padding: 60px 20px; text-align: center; color: var(--label2); font-size: 17px; line-height: 22px; }
  .empty .big { font-size: 44px; margin-bottom: 12px; opacity: .6; }

  /* 本地工作空间未授权引导：kit 大按钮（Button - Liquid Glass - Text / Large：50 高胶囊、17 Semibold；Prominent 蓝底白字） */
  .local-intro { padding: 56px 28px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px; }
  .li-icon { width: 88px; height: 74px; object-fit: contain; filter: drop-shadow(0 6px 11px rgba(40,120,200,.3)); }
  .local-intro h3 { margin: 4px 0 0; font-size: 22px; line-height: 28px; font-weight: 700; letter-spacing: -.26px; }
  .local-intro p { margin: 0; font-size: 17px; line-height: 22px; color: var(--label2); }
  .li-pick { margin-top: 10px; min-width: 220px; height: 50px; padding: 0 28px; border: none; border-radius: 25px; background: var(--blue); color: #fff; font: inherit; font-size: 17px; font-weight: 600; letter-spacing: -.43px; }
  .li-pick:active:not(:disabled) { transform: scale(.97); }
  .li-pick:disabled { opacity: .55; }
  .li-pick.alt { margin-top: 0; background: var(--field); color: var(--blue); }
  .li-hint { font-size: 13px; line-height: 18px; color: var(--label2); max-width: 300px; }

  /* —— 本地位置主页 —— */
  .loc-list { margin-top: 2px; }
  .loc-ic { flex: 0 0 34px; width: 34px; height: 34px; display: flex; align-items: center; justify-content: center; color: var(--green); }
  .loc-ic :global(svg) { width: 30px; height: 30px; filter: drop-shadow(0 1px 2px rgba(0,0,0,.06)); }
  .loc-ic :global(svg.sym) { width: auto; height: auto; filter: none; }
  .frow.loc-add { margin: 0; min-height: 52px; }
  .frow.loc-add .nm { color: var(--blue); }
  .frow.loc-add:disabled { opacity: .55; }
  .loc-note { margin: 0; padding: 8px 36px 22px; font-size: 13px; line-height: 18px; color: var(--label2); }

</style>
