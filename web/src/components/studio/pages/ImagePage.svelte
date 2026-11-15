<script>
  // 图像：对话式续改。一条续改链＝一个 thread：每一轮是「一句话 → 出图」，支持多轮的方言由后端按 thread
  // 重建上下文，不支持的用上一张出图当参考图（§3.3）。画布（v3 §9.2）是 dimensio 对话流的语法：
  // 提示词气泡（surface2、圆角 18、靠右）→ 作品直接落在纸上（圆角 12、细线、浮起投影），下面一行 mono 元信息 + 操作；
  // 进行中是与目标比例同形的纸框 + 慢慢掠过的高光，中间一粒朱点 + mono 计时，底部朱色量度条。
  import { t, tc, tr } from '../../../lib/i18n.js';
  import { openPreview, vertexAssetItem as vxItem } from '../../../lib/preview.svelte.js';
  import { dragOut, canDragOut } from '../../../lib/dragOut.js';
  import { studio, mediaSrc, assetDragSrc, openAsset, currentModel, valuesOf, retryJob } from '../../../modules/studio/media.svelte.js';
  import { assetDrag } from '../../../modules/studio/assetDrag.js';
  import { parseSize } from '../../../modules/studio/size.js';
  import CreateFrame from '../CreateFrame.svelte';
  import Empty from '../ui/Empty.svelte';
  import Img from '../ui/Img.svelte';
  import ErrCard from '../ui/ErrCard.svelte';
  import ArtFoot from '../ui/ArtFoot.svelte';
  import BusyFrame from '../ui/BusyFrame.svelte';

  let { active = false, sideOpen = false, wide = false } = $props();

  const v = $derived(studio.views.image);
  const recent = $derived(studio.assets.filter((a) => a.kind === 'image').slice(0, 12));
  const model = $derived(currentModel('image'));
  const jobOf = (id) => studio.jobs.find((j) => j.id === id);
  // 「接着改」只在画布上真有一张图时说（第一张还在生成 / 失败时不说）
  const placeholder = $derived(v.turns.some((x) => x.assets?.length) ? t('接着改') : studio.drafts.image.inputs.some((x) => x.role === 'edit') ? t('怎么改这张图') : t('描述画面'));
  const rounds = $derived(v.turns.filter((x) => x.assets?.length).length);
  // 进行中那一轮的占位框按目标比例画（比例参数是 16:9 这类值时；否则 4:3）
  const ratio = $derived.by(() => {
    const vals = valuesOf('image', model);
    for (const k of Object.keys(vals)) { const m = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(String(vals[k] || '')); if (m) return `${m[1]} / ${m[2]}`; }
    // 自由尺寸的模型没有比例参数：进行中的占位框按尺寸值的宽高（比例 × 档位格点出来的、预设、自定义都是宽高）
    for (const s of model?.params || []) { if (s.type === 'size') { const d = parseSize(vals[s.key]); if (d) return `${d.width} / ${d.height}`; } }
    return '4 / 3';
  });

  function openTurnImage(id) {
    // 提示词单独传（信息面板显示），下载名由查看器按「提示词前 40 字 + 存盘扩展名」生成；没有提示词才用类型名
    const imgs = v.turns.flatMap((x) => (x.assets || []).map((a) => vxItem(a, x.prompt || a.prompt, tc('名词', '生成图像'), 'image')));
    openPreview(imgs, Math.max(0, imgs.findIndex((x) => x.id === id)));
  }
  let canvasEl = $state();
  function toEnd() {
    const sc = canvasEl?.closest('.cf-scroll');
    if (sc && sc.scrollHeight > sc.clientHeight) sc.scrollTop = sc.scrollHeight;
  }
  $effect(() => {
    const n = v.turns.length, last = v.turns[n - 1]?.state;
    if (!n) return;
    last;
    requestAnimationFrame(toEnd);
  });
  // 新图解码完才有高度：最后一轮的图加载完再贴一次底
  const lastAssetId = $derived(v.turns.at(-1)?.assets?.at(-1)?.id || '');
  const nativeOut = canDragOut();
</script>

{#snippet canvas()}
  <div class="ic-canvas" bind:this={canvasEl}>
    {#if !v.turns.length}
      {#if sideOpen || !recent.length}<Empty page="image" />{/if}
      {#if !sideOpen && recent.length}
        <div class="cv-recent">
          <div class="cv-grid">
            {#each recent as a (a.id)}
              <div class="cv-thumb" role="button" tabindex="0" use:assetDrag={{ asset: a }} onclick={() => openAsset(a)} onkeydown={(e) => { if (e.key === 'Enter') openAsset(a); }}>
                <Img src={mediaSrc(a, 'thumb')} alt="" loading="lazy" decoding="async" draggable="false" />
              </div>
            {/each}
          </div>
        </div>
      {/if}
    {:else}
      <!-- 「新的一张」在外壳顶栏右侧（和任务 / 参数 / 设置并排），滚到哪都点得到；这里只留轮数 -->
      {#if rounds > 1}<div class="ch-head"><span class="mono">{t('续改 {n} 轮', { n: rounds })}</span></div>{/if}
      <div class="ch-list">
        {#each v.turns as turn, i (i)}
          {#if turn.prompt || turn.srcUrl}
            <div class="ch-user"><div class="ch-bubble sel-text">{#if turn.srcUrl}<span class="ch-srcw"><Img class="ch-src" src={turn.srcUrl} alt="" /></span>{/if}<span>{turn.prompt}</span></div></div>
          {/if}
          {#if turn.assets?.length}
            <!-- 一次出多张（张数 > 1）：并排成格，不再一张一张往下摞 -->
            <div class="ch-out" class:multi={turn.assets.length > 1} class:many={turn.assets.length > 4}>
            {#each turn.assets as a (a.id)}
              <figure class="art">
                <div class="ch-img" data-asset={a.id} role="button" tabindex="0" aria-label={turn.prompt || tc('名词', '生成图像')}
                  use:dragOut={() => (nativeOut ? assetDragSrc(a) : null)}
                  onclick={() => openTurnImage(a.id)} onkeydown={(e) => { if (e.key === 'Enter') openTurnImage(a.id); }}>
                  <Img src={mediaSrc(a, 'preview')} alt={turn.prompt} label decoding="async" draggable={nativeOut} width={a.w || undefined} height={a.h || undefined}
                    onload={() => { if (a.id === lastAssetId) toEnd(); }} />
                </div>
                <ArtFoot asset={a} job={turn.jobId ? jobOf(turn.jobId) : null} />
              </figure>
              {#if a.text}<div class="ch-txt sel-text">{tr(a.text)}</div>{/if}
            {/each}
            </div>
          {:else if turn.state === 'queued' || turn.state === 'running'}
            <BusyFrame job={jobOf(turn.jobId)} state={turn.state} {ratio} modelLabel={model?.label || ''} />
          {:else if turn.state === 'error'}
            {@const fj = jobOf(turn.jobId)}
            <ErrCard error={turn.error} page="image" prompt={turn.prompt} onretry={fj ? () => retryJob(fj) : null} />
          {:else if turn.state === 'canceled'}
            <div class="cv-err soft"><span>{t('已取消')}</span></div>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<CreateFrame page="image" {active} {wide} title={t('图像')} {placeholder} sendLabel={t('生成')} {canvas} />
