<script>
  import { uiAlert } from '../lib/dialogs.js';
  import { dragOut } from '../lib/dragOut.js';
  import { mediaDragSrc } from '../lib/vertexMedia.svelte.js';
  // 图像生成（Nano Banana / Imagen）—— vmx 新版 UI。
  // 对话式多轮续改；参数按模型显隐：移动=摘要 chips→参数 sheet，桌面 studio=右栏 inline（共用 snippet）。
  // 落地态（无对话）显示空态 + 历史会话网格；点会话还原整条修改链。
  import { onMount } from 'svelte';
  import { vertex as vs, caps, me } from '../lib/state.svelte.js';
  import LocalImageDeployment from './LocalImageDeployment.svelte';
  import LocalImageSettings from './LocalImageSettings.svelte';
  import { localImageError, localImageLayout } from '../lib/localImageSettings.js';
  import { vmedia, sendImageChat, mediaUrl, loadHistory, openImageChat, delImageChat } from '../lib/vertexMedia.svelte.js';
  import { openPreview, cloudFileUrl } from '../lib/preview.svelte.js';
  import { mediaImgFallback } from '../lib/server.js';
  import { api } from '../lib/api.js';
  import { fileDrop, pasteFiles, isImageFile } from '../lib/dropPaste.js';
  import { icon, glyph, fmtT, MODEL_DESC, ASPECT_SHP } from '../lib/neoUi.js';
  import NeoSheet from './neo/NeoSheet.svelte';
  import NeoModelSheet from './neo/NeoModelSheet.svelte';
  import NeoSourceSheet from './neo/NeoSourceSheet.svelte';
  import NeoWorkspacePicker from './neo/NeoWorkspacePicker.svelte';
  import NeoDock from './neo/NeoDock.svelte';
  import { t, tc, tr } from '../lib/i18n.js';

  const s = $derived(vmedia.image);
  const cap = $derived(caps.data?.image || {});
  const model = $derived(vs.imageModel || cap.defaults?.model || '');
  const modelName = $derived(tr((cap.models || []).find((m) => m.id === model)?.name || model || '—'));
  const isLocal = $derived(model === 'qwen-image-2.1-local');
  const isNano = $derived(!isLocal && !/^imagen/.test(model));
  // 带 only 的比例（4:1 / 1:8 等）只对认它的模型显示；换到别的模型时选中的比例显示 / 发出都按「自动」（后端 imgAspectFor 同一规则）
  const aspects = $derived((cap.aspects || []).filter((a) => !a.only || a.only.includes(model)));
  const curAspect = $derived(aspects.some((a) => a.id === vs.imageAspect) ? vs.imageAspect : 'auto');
  // 尺寸档按模型显隐（caps.sizeSupport；lite 只出 1K）——后端同一矩阵夹紧，这里只是不摆没用的档。
  const SIZES = $derived((cap.sizeSupport || {})[model] || ['1K', '2K', '4K']);
  const thinkLevels = $derived(cap.thinkLevels || []);
  const personGen = $derived(cap.personGen || []);
  const personGenName = $derived(tr((personGen.find((g) => g.id === vs.imagePersonGen) || {}).name || ''));
  const thinkSup = $derived((cap.thinkSupport || []).includes(model));
  const searchSup = $derived((cap.searchSupport || []).includes(model));
  const imgSearchSup = $derived((cap.imageSearchSupport || []).includes(model));
  const curSize = $derived(SIZES.includes(vs.imageSize) ? vs.imageSize : (SIZES.includes('2K') ? '2K' : SIZES[SIZES.length - 1]));
  // 2K / 4K 改走 Gemini Developer API 的模型（caps.image.devBig，Nano Banana 2.1）：那条通道不认人物生成、扣预付费额度、出 JPEG
  const devRoute = $derived((cap.devBig || []).includes(model) && (curSize === '2K' || curSize === '4K'));
  const aspectName = $derived(tr((aspects.find((a) => a.id === curAspect) || {}).name || curAspect));

  onMount(() => loadHistory('image'));
  let field = $state(), hasText = $state(false), canvasEl = $state(), bodyEl = $state();

  let modelSheet = $state(false), paramsSheet = $state(false), deploySheet = $state(false);

  // —— 源图素材（仅 Nano 吃图；Imagen 隐藏入口）——
  const canAttach = $derived(isNano || isLocal);
  let srcImages = $state([]), fileInput = $state();
  const srcImage = $derived(srcImages[0] || null);
  const sourceRatio = $derived.by(() => {
    const previous = s.turns.filter(turn => turn.imageId).at(-1);
    const selected = s.turns.flatMap(turn => turn.outputs || []).find(output => output.id === s.referenceId);
    const ref = srcImages.at(-1) || selected || previous?.outputs?.find(output => output.id === previous.imageId);
    return ref?.width && ref?.height ? ref.width / ref.height : 1;
  });
  const pendingSource = $derived(srcImages.some(image => image.pending));
  const parameterError = $derived(isLocal ? localImageError(vs) : '');
  let dragOver = $state(false);
  const fileToB64 = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(f); });
  async function uploadSrc(f) {
    if (f.size > (isLocal ? 20_000_000 : 7_000_000)) { uiAlert(isLocal ? t('参考图最多 10 张，总大小不能超过 20 MB') : t('图片超过 7MB（Vertex 附件上限）')); return; }
    if (!isLocal) clearSrc();
    if (srcImages.length >= 10 || srcImages.reduce((n, item) => n + (item.size || 0), 0) + f.size > 20_000_000) { uiAlert(t('参考图最多 10 张，总大小不能超过 20 MB')); return; }
    srcImages.push({ path: null, name: f.name, size: f.size, url: URL.createObjectURL(f), pending: true });
    const live = srcImages.at(-1);
    const probe = new Image(); probe.onload = () => { live.width = probe.naturalWidth; live.height = probe.naturalHeight; }; probe.src = live.url;
    try { const r = await api.upload(f.name, await fileToB64(f)); if (srcImages.includes(live)) { live.path = r.path; live.pending = false; } }
    catch { const index = srcImages.indexOf(live); if (index >= 0) clearSrc(index); uiAlert(t('上传失败：{name}', { name: f.name })); }
  }
  async function onPickImg(e) { const files = [...(e.target.files || [])]; e.target.value = ''; for (const f of isLocal ? files : files.slice(0, 1)) await uploadSrc(f); }
  async function onDesktopImg(files) { if (!canAttach) return; const images = files.filter(isImageFile); for (const f of isLocal ? images : images.slice(0, 1)) await uploadSrc(f); }
  function clearSrc(index) { const removed = index === undefined ? srcImages.splice(0) : srcImages.splice(index, 1); for (const image of removed) if (image.url?.startsWith('blob:')) URL.revokeObjectURL(image.url); }
  function attachWorkspace() { vs.matMenu = false; vs.matPicker = true; }
  function attachDevice() { vs.matMenu = false; fileInput && fileInput.click(); }
  async function pickWorkspaceImg(rel, name) {
    vs.matPicker = false; if (!isLocal) clearSrc();
    if (srcImages.length >= 10) { uiAlert(t('参考图最多 10 张，总大小不能超过 20 MB')); return; }
    srcImages.push({ path: null, name, url: cloudFileUrl(rel), pending: true });
    const live = srcImages.at(-1);
    const probe = new Image(); probe.onload = () => { live.width = probe.naturalWidth; live.height = probe.naturalHeight; }; probe.src = live.url;
    try { const r = await api.fileToUpload(rel); if (srcImages.includes(live)) { live.path = r.path; live.pending = false; } }
    catch { const index = srcImages.indexOf(live); if (index >= 0) clearSrc(index); uiAlert(t('载入素材失败')); }
  }

  function gen() {
    const txt = (field?.textContent || '').trim();
    if (!txt || s.busy || pendingSource || parameterError) return;
    const src = canAttach ? srcImage : null;
    field.textContent = ''; hasText = false;
    sendImageChat(txt, src?.path, src?.url, isLocal ? srcImages.map(image => image.path) : []);
    if (src) srcImages = [];
  }

  function openTurnImage(turn, imageId = turn.imageId) {
    const imgs = s.turns.filter((x) => x.imageId).flatMap((x) => (x.outputs || [{ id: x.imageId }]).map(output => ({ origin: 'vertex', id: output.id, name: x.userText || tc('名词', '生成图像'), kind: 'image' })));
    openPreview(imgs, Math.max(0, imgs.findIndex((x) => x.id === imageId)));
  }
  $effect(() => {
    const n = s.turns.length, busy = s.busy;
    if (!n && !busy) return;   // 落地态（空对话）不贴底——历史会话网格要从头看
    requestAnimationFrame(() => { if (canvasEl) canvasEl.scrollTop = canvasEl.scrollHeight; if (bodyEl) bodyEl.scrollTop = bodyEl.scrollHeight; });
  });

  // 工作空间「发送给 AI · 图片」预填
  $effect(() => { const d = vs.imageDraft; if (d && field) { field.textContent = d; hasText = true; vs.imageDraft = ''; } });
  $effect(() => { const a = vs.imageSrcDraft; if (a) { clearSrc(); srcImages = [{ path: a.path, name: a.name, url: a.url, pending: false }]; vs.imageSrcDraft = null; } });
</script>

{#snippet paramsBody()}
  {#if isLocal}
    <LocalImageSettings {aspects} {sourceRatio} />
  {:else}
  {#if isNano}
    <div class="p-card"><div class="p-lab">{t('输出格式')}</div>
      <div class="seg">
        <button class="seg-b" class:on={vs.imageFormat === 'both'} onclick={() => (vs.imageFormat = 'both')}>{t('图文')}</button>
        <button class="seg-b" class:on={vs.imageFormat === 'image'} onclick={() => (vs.imageFormat = 'image')}>{t('仅图')}</button>
      </div>
    </div>
  {/if}
  <div class="p-card"><div class="p-lab">{t('比例')}</div>
    <div class="seg seg-grid3">
      {#each aspects as a (a.id)}
        <button class="seg-b" class:on={curAspect === a.id} onclick={() => (vs.imageAspect = a.id)}>
          {#if ASPECT_SHP[a.id]}<span class="shp {ASPECT_SHP[a.id]}"></span>{:else}<span class="ic">{@html icon('spark', 17)}</span>{/if}{tr(a.name)}
        </button>
      {/each}
    </div>
  </div>
  {#if isNano || isLocal}
    <div class="p-card"><div class="p-lab">{t('分辨率')}</div>
      <div class="seg">
        {#each SIZES as z (z)}
          <button class="seg-b" class:on={curSize === z} onclick={() => (vs.imageSize = z)}>{z}</button>
        {/each}
      </div>
      {#if devRoute}<p class="p-sub">{t('2K / 4K 由 Gemini API 生成：扣预付费额度，返回 JPEG')}</p>{/if}
    </div>
  {/if}
  {#if thinkSup}
    <div class="p-card"><div class="p-lab">{tc('vertex', '思考强度')}</div>
      <div class="seg">
        {#each thinkLevels as lv (lv.id)}
          <button class="seg-b" class:on={(vs.imageThink || 'minimal') === lv.id} onclick={() => (vs.imageThink = lv.id)}>{tr(lv.name)}</button>
        {/each}
      </div>
    </div>
  {/if}
  {#if isNano}
    <div class="p-card"><div class="p-lab">Temperature</div>
      <div class="sld">
        <input type="range" min="0" max="2" step="0.05" bind:value={vs.imageTemp} />
        <span class="sld-val">{Number(vs.imageTemp).toFixed(2)}</span>
      </div>
    </div>
    <div class="p-card"><div class="p-lab">Top P</div>
      <div class="sld">
        <input type="range" min="0" max="1" step="0.01" bind:value={vs.imageTopP} />
        <span class="sld-val">{Number(vs.imageTopP).toFixed(2)}</span>
      </div>
    </div>
  {/if}
  {#if isNano && personGen.length && !devRoute}
    <div class="p-card"><div class="p-lab">{t('人物生成')}</div>
      <div class="seg seg-grid2">
        {#each personGen as g (g.id)}
          <button class="seg-b" class:on={(vs.imagePersonGen || '') === g.id} onclick={() => (vs.imagePersonGen = g.id)}>{tr(g.name)}</button>
        {/each}
      </div>
    </div>
  {/if}
  {#if searchSup || imgSearchSup}
    <div class="p-card"><div class="p-lab">{tc('vertex', '工具')}</div>
      <div style="display:flex;flex-direction:column;gap:10px">
        {#if searchSup}
          <button class="tgl" class:on={vs.imageSearch} onclick={() => (vs.imageSearch = !vs.imageSearch)}>
            <span class="tgl-tx">{t('联网搜索')}<small>Grounding with Google Search</small></span>
            <span class="tgl-knob ic">{@html icon('spark', 20)}</span>
          </button>
        {/if}
        {#if imgSearchSup}
          <button class="tgl" class:on={vs.imageImgSearch} onclick={() => (vs.imageImgSearch = !vs.imageImgSearch)}>
            <span class="tgl-tx">{t('图片搜索')}<small>Image Search</small></span>
            <span class="tgl-knob ic">{@html icon('img', 20)}</span>
          </button>
        {/if}
      </div>
    </div>
  {/if}
  {/if}
{/snippet}

<div class="vmx m-image" class:dark={vs.theme === 'dark'}
  use:fileDrop={{ onEnter: () => (dragOver = canAttach), onLeave: () => (dragOver = false), onDrop: onDesktopImg }}
  use:pasteFiles={{ onFiles: onDesktopImg, filter: isImageFile, when: () => canAttach }}>

  <header class="hero">
    <div class="hero-head">
      <span class="hero-glyph ic">{@html glyph('image')}</span>
      <div class="hero-tt"><h2>{t('图片')}</h2><p>{isLocal ? t('Qwen Image 2.1 · 本机生成与编辑') : t('Nano Banana · 对话式生成修改')}</p></div>
    </div>
    <button class="model-pill" onclick={() => (modelSheet = true)}>
      <span class="mp-name">{modelName}</span><span class="ic">{@html icon('down', 20)}</span>
    </button>
  </header>

  <div class="mod-body" bind:this={bodyEl}>
    <div class="studio">
      <div class="st-rail">
        <button class="rail-model" onclick={() => (modelSheet = true)}>
          <b>{modelName}</b><small>{model}</small>
          <p>{tr(MODEL_DESC[model] || '')}</p>
          <span class="rm-chev ic">{@html icon('down', 20)}</span>
        </button>
        <div class="sec-tt">{tc('vertex', '参数')}</div>
        {#if isLocal && me.kind === 'admin'}<button class="local-deploy-button" onclick={() => (deploySheet = true)}>{t('本机部署')}</button>{/if}
        <div class="p-grid">{@render paramsBody()}</div>
      </div>

      <div class="st-composer st-sticky">
        <NeoDock bind:field bind:hasText busy={s.busy} disabled={!hasText || pendingSource || !!parameterError} hint={parameterError}
          placeholder={s.turns.length ? t('继续修改这张图…') : (srcImage ? t('描述要怎么改这张图…') : t('描述你想要的图像…'))}
          sendLabel={t('生成')} onsend={gen} onplus={canAttach ? () => (vs.matMenu = true) : null} plusLabel={t('添加要编辑的图片')}>
          {#snippet chips()}
            <button class="psum lead" onclick={() => (paramsSheet = true)}><span class="ic">{@html icon('spark', 18)}</span>{tc('vertex', '参数')}</button>
            {#if isLocal && me.kind === 'admin'}<button class="psum" onclick={() => (deploySheet = true)}>{t('本机部署')}</button>{/if}
            <button class="psum" onclick={() => (paramsSheet = true)}>{isLocal && curSize === 'custom' ? `${vs.imageWidth} × ${vs.imageHeight}` : aspectName}</button>
            {#if isLocal}
              {#if curSize !== 'custom'}<button class="psum" onclick={() => (paramsSheet = true)}>{curSize}</button>{/if}
              <button class="psum" onclick={() => (paramsSheet = true)}>{t('{n} 步', { n: vs.imageSteps })}</button>
            {/if}
            {#if isNano}
              <button class="psum" onclick={() => (paramsSheet = true)}>{curSize}</button>
              <button class="psum" onclick={() => (paramsSheet = true)}>{vs.imageFormat === 'both' ? t('图文') : t('仅图')}</button>
              {#if thinkSup}<button class="psum" onclick={() => (paramsSheet = true)}>{t('思考 {lv}', { lv: tr((thinkLevels.find((l) => l.id === (vs.imageThink || 'minimal')) || {}).name || '') })}</button>{/if}
            {/if}
            {#if isNano && vs.imagePersonGen && !devRoute}<button class="psum" onclick={() => (paramsSheet = true)}>{personGenName}</button>{/if}
            {#if searchSup && vs.imageSearch}<button class="psum on" onclick={() => (paramsSheet = true)}>{t('联网 ✓')}</button>{/if}
          {/snippet}
          {#snippet atts()}
            {#if srcImage}
              <div class="dock-atts">
                {#each srcImages as source, index}
                <div class="dock-att" class:pending={source.pending}>
                  <img src={source.url} alt={source.name} />
                  {#if isLocal}<span class="reference-index">{index + 1}</span>{/if}
                  {#if source.pending}<span class="slot-spin"></span>{/if}
                  <button class="slot-x ic" aria-label={t('移除')} onclick={() => clearSrc(index)}>{@html icon('close', 12)}</button>
                </div>
                {/each}
              </div>
            {/if}
          {/snippet}
        </NeoDock>
      </div>

      <div class="st-canvas" bind:this={canvasEl}>
        {#if !s.turns.length && !s.busy}
          <div class="empty-hero" class:compact={s.history.length > 0}>
            <span class="empty-glyph ic">{@html glyph('image')}</span>
            <h3>{t('说出来，改出来')}</h3>
            <p>{canAttach ? t('描述画面生成，之后继续说「改成…」逐轮修改') : t('描述你想要的画面')}</p>
          </div>
          {#if s.error}<div class="err-card"><span class="ic">{@html icon('warn', 24)}</span><span>{tr(s.error)}</span></div>{/if}
          {#if s.history.length}
            <div>
              <div class="sec-tt">{t('历史会话')}</div>
              <div class="hist-grid">
                {#each s.history as h (h.id)}
                  <div class="hist-thumb" role="button" tabindex="0" use:dragOut={() => mediaDragSrc(h.coverId || h.id, h.title || h.prompt || '')} onclick={(e) => { if (!e.target.closest('.hist-x')) openImageChat(h); }}
                    onkeydown={(e) => { if (e.key === 'Enter') openImageChat(h); }}>
                    <img src={mediaUrl(h.coverId || h.id, 'thumb')} alt="" loading="lazy" onerror={mediaImgFallback} />
                    {#if h.count > 1}<span class="hist-count ic">{@html icon('layers', 13)}{h.count}</span>{/if}
                    <button class="hist-x ic" aria-label={t('删除')} onclick={(e) => { e.stopPropagation(); delImageChat(h.id); }}>{@html icon('close', 14)}</button>
                  </div>
                {/each}
              </div>
            </div>
          {/if}
        {:else}
          <div class="chat-list">
            {#each s.turns as turn, i (i)}
              <div class="chat-user"><div class="chat-user-in sel-text">{#if turn.srcUrl}<img class="chat-src" src={turn.srcUrl} alt="" />{/if}{turn.userText}</div></div>
              {#if turn.imageId}
                {#each turn.outputs || [{ id: turn.imageId }] as output}
                <div class="chat-img" role="button" tabindex="0" use:dragOut={() => mediaDragSrc(output.id, turn.userText)} onclick={() => openTurnImage(turn, output.id)}
                  onkeydown={(e) => { if (e.key === 'Enter') openTurnImage(turn, output.id); }}>
                  <img src={mediaUrl(output.id, 'preview')} alt={turn.userText} onerror={mediaImgFallback} />
                </div>
                {#if output.width}<div class="output-details"><span>{output.width} × {output.height} · {t('{n} 步', { n: output.steps })} · {t('种子 {seed}', { seed: output.seed })} · {output.seconds}s</span>{#if isLocal}<button class:chosen={s.referenceId === output.id} aria-pressed={s.referenceId === output.id} onclick={() => (s.referenceId = s.referenceId === output.id ? null : output.id)}>{s.referenceId === output.id ? t('已选为参考') : t('用作下一轮参考')}</button>{/if}</div>{/if}
                {/each}
              {:else if s.busy && i === s.turns.length - 1}
                <div class="busy-hero">
                  <span class="busy-glyph ic">{@html glyph('image')}</span>
                  <div class="busy-time">{fmtT(s.elapsed)}</div>
                  <div class="busy-hint">{t('{model} 出图中', { model: modelName })}</div>
                  {#if isLocal && s.progress}<div class="busy-hint">{s.progress}</div>{/if}
                </div>
              {/if}
            {/each}
            {#if s.error}<div class="err-card"><span class="ic">{@html icon('warn', 24)}</span><span>{tr(s.error)}</span></div>{/if}
          </div>
        {/if}
      </div>
    </div>
  </div>

  {#if dragOver}
    <div class="drop-ov" aria-hidden="true">
      <span class="ic">{@html icon('img', 34)}</span>
      {t('松开以添加要编辑的图片')}
    </div>
  {/if}

  {#if modelSheet}
    <NeoModelSheet sub="Nano Banana / Qwen Image" models={cap.models || []} current={model} onpick={(id) => { vs.imageModel = id; if (id === 'qwen-image-2.1-local') Object.assign(vs, localImageLayout()); else if (vs.imageSize === 'custom') vs.imageSize = '2K'; }} onclose={() => (modelSheet = false)} />
  {/if}
  {#if paramsSheet}
    <NeoSheet title={t('生成参数')} sub={modelName} onclose={() => (paramsSheet = false)}>
      {@render paramsBody()}
    </NeoSheet>
  {/if}
  {#if deploySheet && isLocal && me.kind === 'admin'}
    <NeoSheet title={t('本机部署')} sub="Qwen Image 2.1" onclose={() => (deploySheet = false)}>
      <LocalImageDeployment />
    </NeoSheet>
  {/if}
  {#if vs.matMenu}
    <NeoSourceSheet onWorkspace={attachWorkspace} onDevice={attachDevice} onclose={() => (vs.matMenu = false)} />
  {/if}
  {#if vs.matPicker}
    <NeoWorkspacePicker onPick={pickWorkspaceImg} onclose={() => (vs.matPicker = false)} />
  {/if}
  <input type="file" hidden accept="image/png,image/jpeg,image/webp" multiple={isLocal} bind:this={fileInput} onchange={onPickImg} />
</div>

<style>
  .local-deploy-button { width: 100%; margin-bottom: 14px; padding: 12px; border: 1px solid #8885; border-radius: 12px; color: inherit; background: transparent; font: inherit; cursor: pointer; }
  .reference-index { position: absolute; bottom: 3px; left: 4px; background: #0009; color: #fff; border-radius: 5px; padding: 2px 5px; font-size: 10px; }
  .output-details { color: var(--on3); font-size: 11px; margin: -10px 0 10px; }
  .output-details { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .output-details button { color: var(--on2); border: 1px solid var(--line); border-radius: 9px; background: transparent; padding: 7px 9px; cursor: pointer; font: inherit; }
  .output-details button.chosen { background: var(--cont); color: var(--oncont); }
  .vmx :global(.dock-atts) { overflow-x: auto; }
</style>
