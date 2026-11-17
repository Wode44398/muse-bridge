<script>
  // 工作空间（手机 FilesPanel）传输面板（从顶栏传输环长出来的玻璃面板）里的内容。
  // P 是外壳（FilesPanel.svelte）交出来的状态与动作视图；样式里的配色令牌由外壳 .ws-root 给。
  import Sym from '../../ios27/Sym.svelte';
  import { t } from '../../../lib/i18n.js';
  import { clearFinishedDownloads, openDownload, retryDownload } from '../../../lib/downloads.svelte.js';
  import { clearFinishedUploads, retryUpload } from '../../../lib/uploads.svelte.js';
  import { kindOf } from '../../../lib/files/common.js';
  import { fileGlyph, iconColor, pctOf, xferDetail, xferState } from './panelLook.js';

  const { P } = $props();
</script>

      <div class="tp-head"><h3>{t('传输')}</h3>{#if P.xfers.some((x) => x.status !== 'up')}<button onclick={() => { P.tasks = P.tasks.filter((x) => x.status === 'up'); clearFinishedUploads(); clearFinishedDownloads(); }}>{t('清除已完成')}</button>{/if}</div>
      {#if !P.xfers.length}
        <div class="tp-empty">{t('暂无传输任务')}</div>
      {:else}
        <div class="tp-list">
          {#each P.xfers as task (task.id)}
            <div class="task">
              <span class="ticon" style="background:{task.status === 'error' ? 'var(--red)' : task.status === 'done' ? 'var(--green)' : task.status === 'cancelled' ? '#aeaeb2' : iconColor(task.name)}">{@html fileGlyph(task.kind || kindOf(task.name))}</span>
              <span class="tmeta">
                <span class="r1"><span class="nm">{task.name}</span><span class="spd" class:err={task.status === 'error'}>{xferState(task)}</span></span>
                <span class="track"><span class="fillb" class:up={task.status !== 'error' && task.status !== 'cancelled'} class:off={task.status === 'cancelled'} style="width:{task.status === 'done' ? 100 : pctOf(task)}%"></span></span>
                <span class="r2" class:err={task.status === 'error'}>{xferDetail(task) || ' '}</span>
              </span>
              {#if task.status === 'up'}
                <button class="tp-x" aria-label={task.up ? t('取消上传') : t('取消下载')} onclick={() => P.cancelTask(task)}><Sym name="xmark.circle.fill" weight={400} size={22} /></button>
              {:else if task.dl && task.native && task.status === 'done'}
                <!-- 下好的文件在手机「下载」文件夹里：点「打开」交给系统选 app 打开 -->
                <button class="tp-open" onclick={() => { if (!openDownload(task.id)) P.toast(t('无法打开这个文件')); }}>{t('打开')}</button>
              {:else if task.status === 'error' && task.retry}
                <button class="tp-open" onclick={() => (task.up ? retryUpload(task.id) : retryDownload(task.id))}>{t('重试')}</button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}

<style>
  /* —— 传输面板（kit Popover 里的内容）—— */
  .tp-head { display: flex; align-items: center; justify-content: space-between; padding: 18px 22px 8px; }
  .tp-head h3 { margin: 0; font-size: 17px; line-height: 22px; font-weight: 600; letter-spacing: -.43px; }
  .tp-head button { border: none; background: none; color: var(--blue); font: inherit; font-size: 15px; padding: 4px 2px; cursor: pointer; }
  .tp-empty { padding: 14px 22px 24px; color: var(--label2); font-size: 15px; text-align: center; }
  .tp-list { max-height: 50vh; overflow-y: auto; padding-bottom: 10px; }
  .task { display: flex; align-items: center; gap: 12px; padding: 9px 18px 9px 22px; }
  .task .ticon { flex: 0 0 30px; height: 30px; border-radius: 7.5px; display: flex; align-items: center; justify-content: center; }
  .task .ticon :global(svg) { width: 18px; height: 18px; }
  .task .tmeta { flex: 1; min-width: 0; }
  .task .r1 { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
  .task .nm { font-size: 15px; line-height: 20px; font-weight: 500; letter-spacing: -.23px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .task .spd { font-size: 13px; color: var(--label2); font-variant-numeric: tabular-nums; white-space: nowrap; }
  .task .spd.err, .task .r2.err { color: var(--red); }
  .task .r2 { display: block; margin-top: 5px; font-size: 12px; line-height: 16px; color: var(--label2); font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .task .track { display: block; margin-top: 6px; height: 4px; border-radius: 2px; background: var(--fill); overflow: hidden; }
  .task .fillb { display: block; height: 100%; border-radius: 2px; background: var(--blue); transition: width .3s linear; }
  .task .fillb.up { background: var(--green); }
  .task .fillb.off { background: var(--label3); }
  .task .tp-x { flex: none; border: none; background: none; color: var(--label3); display: flex; align-items: center; justify-content: center; padding: 2px; cursor: pointer; }
  /* 下好的「打开」、失败的「重试」：iOS 列表里那种浅底胶囊小按钮 */
  .task .tp-open { flex: none; border: none; background: var(--fill); color: var(--blue); font: inherit; font-size: 15px; line-height: 20px; font-weight: 600; letter-spacing: -.23px; padding: 4px 13px; border-radius: 999px; cursor: pointer; -webkit-tap-highlight-color: transparent; }
  .task .tp-open:active { background: var(--press); }

</style>
