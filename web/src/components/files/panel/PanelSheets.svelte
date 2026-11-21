<script>
  // 工作空间（手机 FilesPanel）的表单页与警告框：兜底预览、重命名 / 新建、分享链接、压缩、发送给 AI、移动到 / 复制到、显示简介。
  // P 是外壳（FilesPanel.svelte）交出来的状态与动作视图；样式里的配色令牌由外壳 .ws-root 给。
  import Sym from '../../ios27/Sym.svelte';
  import Sheet from '../../ios27/Sheet.svelte';
  import Alert from '../../ios27/Alert.svelte';
  import TextField from '../../ios27/TextField.svelte';
  import Toggle from '../../ios27/Toggle.svelte';
  import Segmented from '../../ios27/Segmented.svelte';
  // 平滑圆角遮罩、文件夹图标：原版资源
  import wsIcon from '../../../visuals/assets/icons/workspace.png';
  import { t, tc, tr } from '../../../lib/i18n.js';
  import { relTime } from '../../../lib/format.js';
  import { AI_NAMES, COMPRESS_FORMATS, COMPRESS_LEVELS, SHARE_TTLS } from '../../../lib/files-business.js';
  import { fmtSize, kindOf } from '../../../lib/files/common.js';
  import { AI_IC, G, STUDIO_TILE, fileIcon, fmtFull, locGlyph, locLabel, typeLabel } from './panelLook.js';

  const { P } = $props();
</script>

  <!-- 文件预览（只给接不住的类型兜底：压缩包等）：kit 表单页 -->
  {#if P.preview}
    <Sheet title={P.preview.name} closeLabel={t('关闭')} onclose={() => (P.preview = null)}>
      <div class="pv-body">
        {#if P.preview.loading}<div class="pv-loading">{t('加载中…')}</div>
        {:else if P.preview.kind === 'img'}<img src={P.preview.url} alt={P.preview.name} />
        {:else if P.preview.kind === 'text'}<pre>{P.preview.text}</pre>
        {:else}
          <div class="pv-other">
            <div class="big">{@html fileIcon(P.preview.name)}</div>
            <p>{t('该类型暂不支持内嵌预览')}</p>
            {#if !P.isLocal && !P.desktopExtra && kindOf(P.preview.name) === 'zip' && !P.readonly}<button class="k-btn prom" disabled={P.extracting} onclick={() => { const n = P.preview.name; P.preview = null; P.doExtract({ name: n }); }}>{P.extracting ? t('解压中…') : t('解压到当前文件夹')}</button>{/if}
            {#if P.desktopNative}<button class="k-btn prom" onclick={() => { const it = { name: P.preview.name, rel: P.preview.rel }; P.preview = null; P.doDesktopOpen(it); }}>{t('用默认应用打开')}</button>{/if}
            {#if !P.isLocal}<button class="k-btn" onclick={() => P.download(P.preview.rel)}>{P.desktopNative ? t('另存为…') : t('下载文件')}</button>{/if}
          </div>
        {/if}
      </div>
    </Sheet>
  {/if}

  <!-- 重命名 / 新建文件夹：kit 警告框 + 文本框（同设置页「服务器地址」） -->
  {#if P.renameTarget}
    <Alert title={t('重命名')} onclose={() => (P.renameTarget = null)}
      actions={[{ label: t('确定'), role: 'default', onclick: P.doRename }, { label: t('取消'), role: 'cancel', onclick: () => (P.renameTarget = null) }]}>
      <TextField bind:value={P.renameTarget.value} onkeydown={(e) => e.key === 'Enter' && P.doRename()} autocapitalize="off" autocorrect="off" spellcheck="false" autofocus />
    </Alert>
  {/if}
  {#if P.mdOpen}
    <Alert title={t('新建 Markdown 文件')} onclose={() => (P.mdOpen = null)}
      actions={[{ label: t('创建'), role: 'default', onclick: P.doNewMd }, { label: t('取消'), role: 'cancel', onclick: () => (P.mdOpen = null) }]}>
      <TextField bind:value={P.mdOpen.value} placeholder={t('文件名')} onkeydown={(e) => e.key === 'Enter' && P.doNewMd()} autocapitalize="off" autocorrect="off" spellcheck="false" autofocus />
    </Alert>
  {/if}
  {#if P.mkOpen}
    <Alert title={t('新建文件夹')} onclose={() => (P.mkOpen = null)}
      actions={[{ label: t('创建'), role: 'default', onclick: P.doMkdir }, { label: t('取消'), role: 'cancel', onclick: () => (P.mkOpen = null) }]}>
      <TextField bind:value={P.mkOpen.value} placeholder={t('文件夹名称')} onkeydown={(e) => e.key === 'Enter' && P.doMkdir()} autocapitalize="off" autocorrect="off" spellcheck="false" autofocus />
    </Alert>
  {/if}

  <!-- 分享链接：设置（密码开关 + 过期时间）→ 结果（链接 + 复制）。kit 表单页 + 分组卡 + 开关 + 分段 -->
  {#if P.shareDlg}
    {#if !P.shareDlg.result}
      <Sheet title={tc('files', '分享链接')} closeLabel={t('取消')} confirmLabel={P.shareDlg.busy ? t('创建中…') : t('创建链接')}
        confirmDisabled={P.shareDlg.busy} onclose={() => { if (!P.shareDlg?.busy) P.shareDlg = null; }} onconfirm={P.doShareLink}>
        <p class="k-cap">{#if P.shareDlg.item.isDir}<span class="k-cap-ic">{@html G.folder}</span>{/if}{P.shareDlg.item.name}</p>
        <div class="k-card">
          <div class="k-row">
            <span class="k-tx">{t('启用分享密码')}</span>
            <Toggle checked={P.shareDlg.pwOn} onchange={() => (P.shareDlg.pwOn = !P.shareDlg.pwOn)} label={t('启用分享密码')} />
          </div>
        </div>
        {#if P.shareDlg.pwOn}
          <div class="k-gap"><TextField bind:value={P.shareDlg.password} placeholder={t('设置分享密码')} maxlength="64" onkeydown={(e) => e.key === 'Enter' && P.doShareLink()} autocapitalize="off" autocorrect="off" spellcheck="false" /></div>
        {/if}
        <h4 class="k-head">{t('过期时间')}</h4>
        <Segmented options={SHARE_TTLS.map((x) => ({ value: x.h, label: tr(x.lb) }))} value={P.shareDlg.ttl} onchange={(v) => (P.shareDlg.ttl = v)} label={t('过期时间')} />
        <div class="pk-foot">
          <button class="k-btn prom wide" disabled={P.shareDlg.busy} onclick={P.doShareLink}>{P.shareDlg.busy ? t('创建中…') : t('创建链接')}</button>
        </div>
      </Sheet>
    {:else}
      <Sheet title={t('链接已创建')} closeLabel={t('完成')} confirmLabel={t('复制链接')} onclose={() => (P.shareDlg = null)} onconfirm={P.copyShare}>
        <p class="k-cap">{#if P.shareDlg.item.isDir}<span class="k-cap-ic">{@html G.folder}</span>{/if}{P.shareDlg.item.name}</p>
        <button class="k-card k-url" onclick={P.copyShare}>{P.shareDlg.result.url}</button>
        <p class="k-foot">
          {t('{time} 过期', { time: P.fmtExpire(P.shareDlg.result.expiresAt) })}
          {#if P.shareDlg.result.pw}<br />{t('访问密码')} <b class="sel-text">{P.shareDlg.result.pw}</b>{t('（复制时一并带上）')}{/if}
        </p>
        <div class="pk-foot">
          <button class="k-btn prom wide" onclick={P.copyShare}>{t('复制链接')}</button>
        </div>
      </Sheet>
    {/if}
  {/if}

  <!-- 压缩选项：名称 + 格式 + 级别（kit 表单页）。压缩期间可直接关掉，服务端照常压完 -->
  {#if P.zipDlg}
    <Sheet title={t('压缩')} closeLabel={P.zipDlg.busy ? t('后台继续') : t('取消')} confirmLabel={P.zipDlg.busy ? t('正在压缩…') : t('压缩')}
      confirmDisabled={P.zipDlg.busy || !P.zipDlg.name.trim()} onclose={P.closeZipDlg} onconfirm={P.runZipDlg}>
      <p class="k-cap">{#if P.zipDlg.isDir}<span class="k-cap-ic">{@html G.folder}</span>{/if}{P.zipDlg.sub}</p>
      <h4 class="k-head">{t('存档名称')}</h4>
      <div class="k-gap zp-name">
        <TextField bind:value={P.zipDlg.name} placeholder={t('存档名称')} disabled={P.zipDlg.busy} onkeydown={(e) => e.key === 'Enter' && P.runZipDlg()} autocapitalize="off" autocorrect="off" spellcheck="false" />
        <span class="zp-ext">{COMPRESS_FORMATS.find((f) => f.value === P.zipDlg.format)?.ext}</span>
      </div>
      <h4 class="k-head">{t('格式')}</h4>
      <Segmented options={COMPRESS_FORMATS.filter((f) => P.zipDlg.formats.includes(f.value)).map((f) => ({ value: f.value, label: f.label }))}
        value={P.zipDlg.format} disabled={P.zipDlg.busy} onchange={(v) => (P.zipDlg.format = v)} label={t('格式')} />
      <h4 class="k-head zp-gap">{t('压缩级别')}</h4>
      <Segmented options={COMPRESS_LEVELS.map((x) => ({ value: x.value, label: tr(x.lb) }))}
        value={P.zipDlg.level} disabled={P.zipDlg.busy} onchange={(v) => (P.zipDlg.level = v)} label={t('压缩级别')} />
      <p class="k-foot">{P.zipDlg.note || t('存档放在同一个文件夹里，重名自动编号')}</p>
    </Sheet>
  {/if}


  <!-- 「发送给 AI」目标选择：kit 表单页 + 分组列表；子层（Media Studio / 视频素材位 / 选择对话）左钮换成返回 -->
  {#snippet aiOpt(onclick, bg, icon, img, label, sub, chev)}
    <button class="k-row k-btnrow" {onclick}>
      <span class="k-tile" style:background={bg || null}>{#if img}<img src={img} alt="" />{:else}{@html icon}{/if}</span>
      <span class="k-tx">{label}<small>{sub}</small></span>
      {#if chev}<Sym name="chevron.right" weight={600} size={15} class="k-chev" />{/if}
    </button>
  {/snippet}
  {#if P.ai.item}
    <Sheet closeLabel={t('取消')} backLabel={t('返回')}
      title={P.ai.view === 'root' ? t('发送「{name}」给', { name: P.ai.item.name })
        : P.ai.view === 'studio' ? t('发送「{name}」到 Media Studio', { name: P.ai.item.name })
        : P.ai.view === 'video' ? t('视频 · 这张图用作')
        : t('发送到 {name} · 选择对话', { name: AI_NAMES[P.ai.chat?.target] || '' })}
      onback={P.ai.view === 'root' ? null : P.ai.view === 'chat' ? P.ai.chatBack : P.ai.view === 'video' ? () => (P.ai.view = 'studio') : () => (P.ai.view = 'root')}
      onclose={() => { P.ai.item = null; P.ai.view = 'root'; }}>
      {#if P.ai.view === 'root'}
        <div class="k-card">
          {#if P.ai.caps.claude}{@render aiOpt(() => P.ai.pick('claude'), '#d97757', AI_IC.claude, '', 'Claude', t('当附件向 Claude 提问'), true)}{/if}
          {#if P.ai.caps.agy}{@render aiOpt(() => P.ai.pick('agy'), '#101829', '', P.BASE + 'assets/icons/antigravity.svg', 'Antigravity', t('当附件向 Antigravity 提问'), true)}{/if}
          {#if P.ai.caps.studio}{@render aiOpt(() => (P.ai.view = 'studio'), STUDIO_TILE, '', P.BASE + 'assets/icons/studio-light.svg', 'Media Studio', t('生成图像 / 视频 / 配音 / 音乐'), true)}{/if}
        </div>
      {:else if P.ai.view === 'studio'}
        {#if P.ai.caps.video || P.ai.caps.image || P.ai.caps.audio || P.ai.caps.music}
          <div class="k-card">
            {#if P.ai.caps.video}{@render aiOpt(() => (P.ai.caps.mode === 'image' ? (P.ai.view = 'video') : P.ai.pick('video')), 'var(--i-indigo)', AI_IC.video, '', t('视频'), P.ai.caps.mode === 'image' ? t('选首帧 / 尾帧 / 参考图') : t('作为提示词'), P.ai.caps.mode === 'image')}{/if}
            {#if P.ai.caps.image}{@render aiOpt(() => P.ai.pick('image'), 'var(--i-blue)', AI_IC.image, '', t('图像'), P.ai.caps.mode === 'image' ? t('作为改图素材') : t('作为提示词'), false)}{/if}
            {#if P.ai.caps.audio}{@render aiOpt(() => P.ai.pick('audio'), 'var(--i-pink)', AI_IC.audio, '', t('配音'), t('作为朗读文本'), false)}{/if}
            {#if P.ai.caps.music}{@render aiOpt(() => P.ai.pick('music'), 'var(--i-orange)', AI_IC.music, '', t('音乐'), t('作为描述'), false)}{/if}
          </div>
        {/if}
      {:else if P.ai.view === 'video'}
        <div class="k-card">
          {@render aiOpt(() => P.ai.pickVideoSlot('first'), 'var(--i-indigo)', AI_IC.first, '', t('首帧素材'), t('视频从这张图开始'), false)}
          {@render aiOpt(() => P.ai.pickVideoSlot('last'), 'var(--i-indigo)', AI_IC.last, '', t('尾帧素材'), t('视频结束于这张图'), false)}
          {@render aiOpt(() => P.ai.pickVideoSlot('ref'), 'var(--i-indigo)', AI_IC.ref, '', t('参考图'), t('带入主体 / 风格'), false)}
        </div>
      {:else if P.ai.view === 'chat' && P.ai.chat}
        <label class="k-search"><Sym name="magnifyingglass" weight={500} size={17} /><input type="search" placeholder={t('搜索对话')} bind:value={P.ai.chat.q} /></label>
        <div class="k-card">
          {@render aiOpt(() => P.ai.pickChat('new'), 'var(--i-green)', AI_IC.plus, '', t('新对话'), t('开一个新对话，附件挂进输入栏'), false)}
        </div>
        <div class="k-card">
          {#each P.ai.filtered as s (s.id)}
            <button class="k-row k-btnrow k-chat" onclick={() => P.ai.pickChat(s.id)}>
              {#if P.ai.chat.target === 'claude' || P.ai.chat.target === 'agy'}<span class="ai-chat-dot {s.thinking ? 'work' : s.pending ? 'ask' : ''}"></span>{/if}
              <span class="k-tx k-one">{P.ai.chatTitle(s)}</span>
              {#if s.id === P.ai.cur}<span class="ai-chat-cur">{t('当前')}</span>{/if}
              {#if s.mtime}<span class="k-val">{relTime(s.mtime)}</span>{/if}
            </button>
          {:else}
            <div class="k-row k-empty">{P.ai.chat.loading ? t('加载中…') : P.ai.chat.q ? t('没有匹配的对话') : t('还没有历史对话')}</div>
          {/each}
        </div>
      {/if}
    </Sheet>
  {/if}

  <!-- 移动到 / 复制到 目录选择器：kit 表单页；✓ 与底部大按钮是同一件事——放到当前浏览的这一层 -->
  {#if P.picker}
    <Sheet title={P.picker.mode === 'move' ? t('移动 {n} 项到…', { n: P.picker.names.length }) : t('复制 {n} 项到…', { n: P.picker.names.length })}
      closeLabel={t('取消')} confirmLabel={P.pickerBtnLabel} confirmDisabled={P.isLocal && P.multiRoot && !P.picker.path}
      onclose={() => (P.picker = null)} onconfirm={P.pickerConfirm}>
      <div class="pk-crumb">
        <button class:cur={!P.picker.path} onclick={() => P.pickerLoad('')}>{P.isLocal ? t('本地') : (P.picker.rootLabel || t('工作空间'))}</button>
        {#each P.picker.path.split('/').filter(Boolean) as s, i}<span class="pb-sep">›</span><button class:cur={i === P.picker.path.split('/').filter(Boolean).length - 1} onclick={() => P.pickerCrumb(i)}>{P.segLabel(s, i)}</button>{/each}
      </div>
      {#if P.showCloudLocs && !P.picker.path}
        <!-- 目标也可以在别的电脑位置：跨根的移动/复制由服务端一次做完 -->
        <div class="desktop-locations cloud-locs pk-locs">
          {#each P.cloudLocs as loc (loc.id)}
            <button class="desktop-location" class:on={P.locRoot(loc) === P.picker.root} onclick={() => P.pickerSetLoc(loc)}>
              <span class="dl-svg">{@html locGlyph(loc)}</span><span>{loc.id === 'ws' ? t('工作空间') : locLabel(loc)}</span>
            </button>
          {/each}
        </div>
      {/if}
      {#if P.picker.loading}<div class="pk-empty">{t('加载中…')}</div>
      {:else if !P.picker.items.length}<div class="pk-empty">{t('这里没有子文件夹')}<br /><small>{P.isLocal && P.multiRoot && !P.picker.path ? t('还没有已授权的本地位置') : t('可直接放到当前位置')}</small></div>
      {:else}
        <div class="k-card">
          {#each P.picker.items as f (f.name)}
            <button class="k-row k-btnrow" onclick={() => P.pickerEnter(f.name)}>
              <img class="pk-fico" src={wsIcon} alt="" />
              <span class="k-tx k-one">{f.label || f.name}</span>
              <Sym name="chevron.right" weight={600} size={15} class="k-chev" />
            </button>
          {/each}
        </div>
      {/if}
      <div class="pk-foot">
        <button class="k-btn prom wide" disabled={P.isLocal && P.multiRoot && !P.picker.path} onclick={P.pickerConfirm}>{P.pickerBtnLabel}</button>
      </div>
    </Sheet>
  {/if}

  <!-- 显示简介：kit 表单页 + 分组卡（左标签右值） -->
  {#if P.infoItem}
    <Sheet title={t('显示简介')} closeLabel={t('完成')} onclose={() => (P.infoItem = null)}>
      <div class="info-top">
        {#if P.infoItem.isDir}<img class="info-ico" src={wsIcon} alt="" />{:else}<span class="info-ico file">{@html fileIcon(P.infoItem.name)}</span>{/if}
        <div class="info-name">{P.infoItem.name}</div>
      </div>
      <div class="k-card">
        <div class="k-row"><span class="k-tx">{t('种类')}</span><span class="k-val">{typeLabel(P.infoItem)}</span></div>
        <div class="k-row"><span class="k-tx">{t('大小')}</span><span class="k-val">{P.infoItem.isDir ? t('文件夹') : fmtSize(P.infoItem.size)}</span></div>
        <div class="k-row"><span class="k-tx">{t('修改时间')}</span><span class="k-val">{fmtFull(P.infoItem.mtime)}</span></div>
        <div class="k-row top"><span class="k-tx">{t('位置')}</span><span class="k-val wrap selectable">{P.infoLocation}</span></div>
        {#if P.infoItem.loading}<div class="k-row"><span class="k-tx">{t('Windows 属性')}</span><span class="k-val">{t('读取中…')}</span></div>{/if}
        {#if P.infoItem.absolutePath}<div class="k-row top"><span class="k-tx">{t('完整路径')}</span><span class="k-val wrap selectable">{P.infoItem.absolutePath}</span></div>{/if}
        {#if P.infoItem.linkType}<div class="k-row top"><span class="k-tx">{t('链接')}</span><span class="k-val wrap selectable">{P.infoItem.linkType}{P.infoItem.linkTarget ? ` → ${P.infoItem.linkTarget}` : ''}</span></div>{/if}
        {#if P.infoItem.absolutePath}<div class="k-row"><span class="k-tx">{t('访问')}</span><span class="k-val">{P.infoItem.readable ? t('可读') : t('不可读')} · {P.infoItem.writable ? t('可写') : t('只读')}{P.infoItem.longPath ? ' · ' + t('长路径') : ''}</span></div>{/if}
        {#if P.infoItem.inspectError}<div class="k-row top"><span class="k-tx">{t('Windows 属性')}</span><span class="k-val wrap">{P.infoItem.inspectError}</span></div>{/if}
      </div>
      {#if P.infoItem.acl}<h4 class="k-head">ACL</h4><pre class="k-acl">{P.infoItem.acl}</pre>{/if}
    </Sheet>
  {/if}

<style>
  .desktop-location { flex: none; min-height: 32px; display: inline-flex; align-items: center; gap: 6px; padding: 0 14px; border: 0; border-radius: 999px;
    font: inherit; font-size: 15px; line-height: 20px; font-weight: 500; letter-spacing: -.23px; color: var(--blue); background: var(--fill3); cursor: pointer;
    -webkit-tap-highlight-color: transparent; transition: transform .16s cubic-bezier(.2,0,0,1); }
  .desktop-location:active { transform: scale(.96); }
  .desktop-location.on { background: var(--blue); color: #fff; }
  .desktop-locations { display: flex; gap: 8px; overflow-x: auto; padding: 0 20px 4px; scrollbar-width: none; }
  .desktop-locations::-webkit-scrollbar { display: none; }
  .desktop-location { max-width: 220px; white-space: nowrap; }
  .desktop-location > span:last-child { overflow: hidden; text-overflow: ellipsis; }
  .cloud-locs { padding-bottom: 6px; }
  .dl-svg { display: inline-flex; width: 17px; height: 17px; flex: none; }
  .dl-svg :global(svg) { width: 17px; height: 17px; }
  .pk-locs { flex: none; padding: 0 0 12px; }
  .pb-sep { flex: none; color: var(--label3); font-size: 15px; }
  /* —— kit 表单页里的内容件（Sheet 正文）：分组卡、行、标题、脚注、按钮 —— */
  .k-card { display: block; width: 100%; margin: 0 0 16px; background: var(--card); border-radius: 26px; -webkit-mask-box-image: var(--sq) 42 / 42px; overflow: hidden; border: 0; padding: 0; font: inherit; color: inherit; text-align: left; }
  .k-row { position: relative; display: flex; align-items: center; gap: 12px; width: 100%; min-height: 52px; padding: 11px 16px; border: 0; background: none; font: inherit; color: inherit; text-align: left; }
  .k-row.top { align-items: flex-start; }
  .k-row + .k-row::before { content: ''; position: absolute; left: 16px; right: 16px; top: 0; height: 1px; background: var(--sep); }
  .k-btnrow { cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .k-btnrow:active { background: var(--press); }
  .k-tx { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; font-size: 17px; line-height: 22px; letter-spacing: -.43px; }
  .k-tx small { font-size: 15px; line-height: 20px; letter-spacing: -.23px; color: var(--label2); }
  .k-tx small:lang(en) { white-space: normal; }
  .k-one { display: block; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .k-val { flex: none; max-width: 60%; font-size: 17px; line-height: 22px; letter-spacing: -.43px; color: var(--label2); text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .k-val.wrap { flex: 1; max-width: none; white-space: normal; word-break: break-all; }
  .k-val.selectable { user-select: text; }
  .k-row :global(.k-chev) { color: var(--label3); flex: none; }
  /* 彩色圆角方块（同设置页 IconTile：30×30、圆角 7.5） */
  .k-tile { flex: none; width: 30px; height: 30px; border-radius: 7.5px; display: flex; align-items: center; justify-content: center; background: var(--fill3); overflow: hidden; }
  .k-tile img { width: 22px; height: 22px; object-fit: contain; }
  .k-tile :global(svg) { width: 19px; height: 19px; }
  .k-head { margin: 4px 0 8px; padding: 0 16px; font-size: 17px; line-height: 22px; font-weight: 600; color: var(--label2); }
  .k-cap { margin: 0 0 14px; padding: 0 16px; display: flex; align-items: center; gap: 6px; justify-content: center; font-size: 15px; line-height: 20px; color: var(--label2); word-break: break-all; text-align: center; }
  .k-cap-ic { display: inline-flex; width: 17px; height: 17px; flex: none; }
  .k-cap-ic :global(svg) { width: 17px; height: 17px; }
  .k-foot { margin: 0 0 16px; padding: 8px 16px 0; font-size: 13px; line-height: 18px; color: var(--label2); text-align: center; }
  .k-foot b { color: var(--label); }
  .k-gap { margin: -6px 0 16px; }
  .zp-name { display: flex; align-items: center; gap: 8px; }
  .zp-name > :global(:first-child) { flex: 1; min-width: 0; }
  .zp-ext { flex: none; font-size: 15px; color: var(--label2); }
  .zp-gap { margin-top: 18px; }
  .k-url { padding: 14px 16px; font-size: 15px; line-height: 20px; color: var(--blue); word-break: break-all; cursor: pointer; }
  .k-acl { margin: 0 0 16px; padding: 12px 14px; max-height: 140px; overflow: auto; border-radius: 18px; background: var(--card); color: var(--label2); user-select: text; white-space: pre-wrap; word-break: break-all; font: 12px/1.4 ui-monospace, Consolas, monospace; }
  .k-empty { justify-content: center; color: var(--label2); font-size: 15px; }
  .k-chat { gap: 10px; }
  /* 搜索框：kit「_Search」——Fills 底、圆角 胶囊、放大镜 + 17pt 占位字 */
  .k-search { display: flex; align-items: center; gap: 6px; height: 44px; margin: 0 0 14px; padding: 0 14px; border-radius: 22px; background: var(--field); color: var(--label2); }
  .k-search input { flex: 1; min-width: 0; border: none; background: none; outline: none; font: inherit; font-size: 17px; letter-spacing: -.43px; color: var(--label); }
  .k-search input::placeholder { color: var(--label3); }
  /* kit 大按钮（Button - Liquid Glass - Text / Large）：50 高胶囊、17 Semibold；Prominent＝蓝底白字，否则 Fills 底蓝字 */
  .k-btn { height: 50px; padding: 0 26px; border: none; border-radius: 25px; background: var(--field); color: var(--blue); font: inherit; font-size: 17px; font-weight: 600; letter-spacing: -.43px; cursor: pointer;
    -webkit-tap-highlight-color: transparent; transition: transform 160ms cubic-bezier(.2,0,0,1), filter 160ms linear; }
  .k-btn.prom { background: var(--blue); color: #fff; }
  .k-btn.wide { width: 100%; }
  .k-btn:active:not(:disabled) { transform: scale(.97); filter: brightness(.94); }
  .k-btn:disabled { opacity: .45; cursor: default; }

  /* 文件预览（Sheet 正文） */
  .pv-body { display: flex; min-height: 0; }
  .pv-body img { width: 100%; height: auto; object-fit: contain; border-radius: 18px; }
  .pv-body pre { flex: 1; margin: 0; padding: 14px 16px; border-radius: 18px; background: var(--card); font: 13px/1.6 ui-monospace, 'SF Mono', Menlo, monospace; white-space: pre-wrap; word-break: break-word; color: var(--ink); user-select: text; }
  .pv-loading { flex: 1; display: flex; align-items: center; justify-content: center; padding: 60px; color: var(--label2); }
  .pv-other { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; padding: 30px 8px 16px; }
  .pv-other .big { display: flex; }
  .pv-other .big :global(svg) { width: 62px; height: 76px; filter: drop-shadow(0 2px 6px rgba(0,0,0,.1)); }
  .pv-other p { margin: 0; color: var(--label2); font-size: 15px; }

  /* 移动到 / 复制到（Sheet 正文） */
  .pk-crumb { display: flex; align-items: center; flex-wrap: wrap; gap: 4px; padding: 0 16px 12px; }
  .pk-crumb button { background: none; border: none; padding: 0; font: inherit; font-size: 15px; line-height: 20px; color: var(--blue); cursor: pointer; }
  .pk-crumb button.cur { color: var(--label); font-weight: 600; }
  .pk-fico { width: 30px; height: 26px; object-fit: contain; flex: none; }
  .pk-empty { padding: 36px 16px 30px; text-align: center; color: var(--label2); font-size: 15px; line-height: 22px; }
  .pk-empty small { color: var(--label3); font-size: 13px; }
  /* 底部的大按钮钉在表单页正文底：目录再长也不用划到底才点得到 */
  .pk-foot { position: sticky; bottom: 0; margin: 0 -16px; padding: 10px 16px 2px; background: linear-gradient(to top, color-mix(in srgb, var(--bg) 70%, transparent) 60%, transparent); }

  /* 显示简介（Sheet 正文） */
  .info-top { display: flex; flex-direction: column; align-items: center; gap: 10px; padding: 0 0 18px; }
  .info-ico { width: 64px; height: 56px; object-fit: contain; }
  .info-ico.file :global(svg) { width: 50px; height: 62px; }
  .info-name { font-size: 17px; line-height: 22px; font-weight: 600; text-align: center; word-break: break-all; padding: 0 12px; }

  /* 「选择对话」里的状态点与「当前」徽标 */
  .ai-chat-dot { width: 7px; height: 7px; border-radius: 50%; flex: none; background: var(--label3); }
  .ai-chat-dot.work { background: #d97757; animation: aidot 1.2s ease-in-out infinite; }
  .ai-chat-dot.ask { background: var(--orange); animation: aidot 1.2s ease-in-out infinite; }
  @keyframes aidot { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
  .ai-chat-cur { font-size: 12px; line-height: 16px; color: var(--label2); background: var(--fill3); border-radius: 6px; padding: 2px 7px; flex: none; }
</style>
