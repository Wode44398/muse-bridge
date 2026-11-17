<!-- Claude 页·弹窗：重命名 / 存为工作空间、归档父会话的二选一、临时对话回收站。 -->
<script>
  import { titleFor } from '../../../lib/library.svelte.js';
  import { t, tc, tr } from '../../../lib/i18n.js';
  import { relTime } from '../../../lib/format.js';
  import { daysLeft } from '../../../lib/quickChat.js';
  import { usePage } from '../../../lib/claudePage/context.js';

  const pc = usePage();
  const { renameKey, renameFocus, commitRename, runArchive, focusBtn, restoreBin } = pc;
</script>
<!-- 重命名对话（替代 window.prompt——Electron 不实现 prompt，桌面壳里原来点了没反应） -->
{#if pc.renameFor}
  <button class="pm-bd" aria-label={t('关闭')} onclick={() => (pc.renameFor = null)}></button>
  <div class="pmodal rnmodal" role="dialog" aria-modal="true">
    {#if pc.renameFor.kind === 'saveQuick'}
      <div class="pm-head"><span class="ic pm-ic">&#xe0c9;</span>{t('存为工作空间')}</div>
      <input class="rn-input" bind:value={pc.renameFor.name} onkeydown={renameKey} use:renameFocus placeholder={tc('claude', '给工作空间取个名字')} maxlength="80" />
    {:else if pc.renameFor.kind === 'project'}
      <div class="pm-head"><span class="ic pm-ic">&#xe064;</span>{tc('claude', '重命名工作空间')}</div>
      <input class="rn-input" bind:value={pc.renameFor.name} onkeydown={renameKey} use:renameFocus placeholder={tc('claude', '留空恢复为文件夹名')} maxlength="80" />
    {:else}
      <div class="pm-head"><span class="ic pm-ic">&#xe064;</span>{tc('claude', '重命名对话')}</div>
      <input class="rn-input" bind:value={pc.renameFor.name} onkeydown={renameKey} use:renameFocus placeholder={tc('claude', '对话名称')} maxlength="120" />
    {/if}
    <div class="pm-actions">
      <button class="pm-cancel" onclick={() => (pc.renameFor = null)}>{t('取消')}</button>
      <button class="pm-create" onclick={commitRename}>{t('保存')}</button>
    </div>
  </div>
{/if}

<!-- 归档父会话时有子会话：只归档这一条，还是一家子全部归档（官方 Archive session? 对话框） -->
{#if pc.archAsk}
  <button class="pm-bd" aria-label={t('关闭')} onclick={() => (pc.archAsk = null)}></button>
  <div class="pmodal archmodal" role="dialog" aria-modal="true">
    <div class="pm-head"><span class="ic pm-ic">&#xe008;</span>{t('归档会话？')}</div>
    <p class="am-body">
      {pc.archAsk.title ? t('「{title}」有 {n} 个子会话。只归档此会话的话，它们会移到顶层。', { title: tr(pc.archAsk.title), n: pc.archAsk.kids.length }) : t('此会话有 {n} 个子会话。只归档此会话的话，它们会移到顶层。', { n: pc.archAsk.kids.length })}
      {#if pc.archAsk.working}{t('其中 {n} 个仍在工作，全部归档时会跳过它们。', { n: pc.archAsk.working })}{/if}
    </p>
    <div class="pm-actions am-actions">
      <button class="pm-cancel" onclick={() => (pc.archAsk = null)}>{t('取消')}</button>
      <button class="pm-cancel am-all" onclick={() => runArchive([pc.archAsk.id, ...pc.archAsk.kids])}>{t('全部归档（{n} 个会话）', { n: pc.archAsk.kids.length + 1 })}</button>
      <!-- 仅归档此会话：子会话移到顶层（服务端记下，之后它取消归档也不再挂回来——官方 detach 同款） -->
      <button class="pm-create" use:focusBtn onclick={() => runArchive([pc.archAsk.id], { detach: true })}>{t('仅归档此会话')}</button>
    </div>
  </div>
{/if}

<!-- 临时对话回收站（S1-6）：按设置清理掉的临时对话（默认 30 天没动的）整只挪在这里，再放 trashDays 天才永久删除；点「恢复」原样回到列表 -->
{#if pc.binOpen}
  <button class="pm-bd" aria-label={t('关闭')} onclick={() => (pc.binOpen = false)}></button>
  <div class="pmodal binmodal" role="dialog" aria-modal="true" aria-label={t('临时对话回收站')}>
    <div class="pm-head"><span class="ic pm-ic">&#xe101;</span>{t('临时对话回收站')}</div>
    <p class="am-body">{pc.quickPol.mode === 'never' ? t('临时对话已设为不自动清理；以前清理掉的还在这里，到时会永久删除。恢复后对话和产物原样接上。')
      : pc.quickPol.mode === 'count' ? t('临时对话超过 {n} 条时，最久没动的会移到这里，再过 {m} 天永久删除。恢复后对话和产物原样接上。', { n: pc.quickPol.max, m: pc.quickPol.trashDays })
      : t('超过 {n} 天没动的临时对话会移到这里，再过 {m} 天永久删除。恢复后对话和产物原样接上。', { n: pc.quickPol.ttlDays, m: pc.quickPol.trashDays })}</p>
    <div class="bin-list">
      {#each pc.binItems as it (it.id)}
        {@const left = daysLeft(it.purgeAt)}
        <div class="d-row bin-row">
          <span class="d-two">
            <span class="d-title">{tr(it.sessionId ? titleFor(it.sessionId, it.title) : it.title) || t('（无标题）')}</span>
            <span class="d-sub">{t('{when}移入', { when: relTime(it.recycledAt) })}{#if left != null}{' · '}{t('{n} 天后永久删除', { n: left })}{/if}{#if it.sessions > 1}{' · '}{t('{n} 段对话', { n: it.sessions })}{/if}{#if it.items}{' · '}{t('有 {n} 个文件', { n: it.items })}{/if}</span>
          </span>
          <button class="pm-cancel bin-restore" disabled={pc.binBusy} onclick={() => restoreBin(it)}>{t('恢复')}</button>
        </div>
      {/each}
      {#if !pc.binItems.length}<div class="d-empty">{pc.binLoading ? t('加载中…') : t('回收站是空的。')}</div>{/if}
    </div>
    <div class="pm-actions"><button class="pm-cancel" onclick={() => (pc.binOpen = false)}>{t('关闭')}</button></div>
  </div>
{/if}

<style>
  /* 临时对话回收站弹窗 */
  .binmodal { max-height: min(560px, calc(100vh - 80px)); }
  .bin-list { flex: 1; min-height: 0; overflow-y: auto; margin: 6px -6px 0; }
  .bin-row { gap: 8px; padding: 6px 6px 6px 10px; }
  .bin-restore { flex: none; border: 1px solid var(--divider); padding: 5px 12px; }
  @media (hover: hover) { .bin-restore:hover { background: var(--hover); color: var(--text); } }

  .d-row { position: relative; display: flex; align-items: center; border-radius: 8px; margin-bottom: .5px; transition: background-color .12s ease; }

  .d-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }

  .d-title:global([data-ov]) { text-overflow: clip;
    mask-image: linear-gradient(to right, #000 85%, transparent 99%);
    -webkit-mask-image: linear-gradient(to right, #000 85%, transparent 99%); }

  /* 指针环境（桌面）：行悬停浮出底色，⋮ 平时隐身、行悬停/键盘聚焦才浮现，悬停 ⋮ 文字提亮，
     项目图标盒盖展开（ANIM 轴 0→100）——与 claude.ai 同款 */
  @media (hover: hover) {

    .d-row:hover, .d-row:focus-within { background: var(--hover); }
    .d-row:hover .d-title, .d-row:focus-within .d-title { color: var(--text); }

    .d-row:hover .d-title:global([data-ov]), .d-row:focus-within .d-title:global([data-ov]) {
      mask-image: linear-gradient(to right, transparent, #000 var(--mq-lf, 0px), #000 calc(100% - 44px), transparent calc(100% - 20px));
      -webkit-mask-image: linear-gradient(to right, transparent, #000 var(--mq-lf, 0px), #000 calc(100% - 44px), transparent calc(100% - 20px));
    }
    .d-title:global([data-run]) { --mq-lf: 12px; }   /* 左缘渐隐只在开滚后出现（官方行为） */
  }

  @keyframes rmPop { from { opacity: 0; transform: scale(.96); } to { opacity: 1; transform: none; } }

  /* —— 弹窗（重命名对话用；新建项目的目录浏览已退役，改走 ProjectPicker） —— */
  .pm-bd { position: fixed; inset: 0; z-index: 70; background: rgba(0, 0, 0, .45); }
  .pmodal { position: fixed; z-index: 71; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: min(420px, calc(100vw - 40px)); max-height: min(560px, calc(100vh - 80px));
    display: flex; flex-direction: column; background: var(--q-card); border-radius: 16px;
    box-shadow: var(--q-shadow); padding: 16px; animation: rmPop .16s ease; }
  .pm-head { display: flex; align-items: center; gap: 8px; font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 12px; }
  .pm-ic { font-size: 18px; color: var(--serif); font-variation-settings: "opsz" 20, "wght" 433; }
  .pm-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 12px; }
  .pm-cancel { padding: 8px 14px; border-radius: 10px; color: var(--serif); }
  .pm-cancel:active { background: var(--hover); }
  .pm-create { padding: 8px 14px; border-radius: 10px; background: var(--text); color: var(--bg); font-weight: 600; }
  .pm-create:disabled { opacity: .5; }
  .rnmodal { max-height: none; }
  .archmodal { max-height: none; }
  .rn-input { width: 100%; padding: 9px 11px; border: 1px solid var(--divider); border-radius: 10px;
    background: var(--bg); color: var(--text); font-size: 14px; }
  .rn-input:focus { outline: none; border-color: var(--serif); }
  .d-empty { color: var(--muted); font-size: 13px; padding: 10px 11px; }

  .d-two { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .d-sub { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 12px; color: var(--muted); }

  /* 归档父会话的二选一对话框：三颗按钮，窄屏换行 */
  .am-body { margin: 0 0 4px; font-size: 14px; line-height: 21px; color: var(--serif); text-wrap: pretty; overflow-wrap: anywhere; }
  .am-actions { flex-wrap: wrap; }
  .am-all { border: 1px solid var(--divider); }


</style>
