<script>
  import { uiAlert } from '../lib/dialogs.js';
  import { dragOut } from '../lib/dragOut.js';
  import { mediaDragSrc } from '../lib/vertexMedia.svelte.js';
  // 视频生成（Veo / Omni）—— vmx UI。四模块同一套流程：画布（结果 + 历史）在上，输入岛钉底，
  // 参数 = 输入岛上方的摘要 chips → 参数 sheet（桌面 ≥1080 改右栏常驻）。
  // 任务类型不再让人先选：看喂了哪些图自动定——没图=文生、首帧=图生、首帧+尾帧=首尾插值、参考图=参考图生成。
  // 「＋」先问这张图当什么（首帧 / 尾帧 / 参考图，按模型能力与互斥关系置灰），再选来源（工作空间 / 手机）。
  import { onMount } from 'svelte';
  import { vertex as vs, caps } from '../lib/state.svelte.js';
  import { vmedia, genVideo, mediaUrl, loadHistory, delMedia } from '../lib/vertexMedia.svelte.js';
  import { openPreview, cloudFileUrl } from '../lib/preview.svelte.js';
  import { api } from '../lib/api.js';
  import { fileDrop, pasteFiles, isImageFile } from '../lib/dropPaste.js';
  import { icon, glyph, fmtT, MODEL_DESC, ASPECT_SHP } from '../lib/neoUi.js';
  import NeoSheet from './neo/NeoSheet.svelte';
  import NeoModelSheet from './neo/NeoModelSheet.svelte';
  import NeoSourceSheet from './neo/NeoSourceSheet.svelte';
  import NeoWorkspacePicker from './neo/NeoWorkspacePicker.svelte';
  import NeoDock from './neo/NeoDock.svelte';
  import { t, tc, tr } from '../lib/i18n.js';

  const s = $derived(vmedia.video);
  const cap = $derived(caps.data?.veo || {});
  const model = $derived(vs.videoModel || cap.defaults?.model || '');
  const modelName = $derived(tr((cap.models || []).find((m) => m.id === model)?.name || model || '—'));
  const aspects = $derived(cap.aspects || []);
  const aspectName = $derived(tr((aspects.find((a) => a.id === vs.videoAspect) || {}).name || vs.videoAspect));
  // 时长按模型给档（Omni 3–10 逐秒 / Veo 4·6·8），不再全家共用一张 4/6/8。
  const durSup = $derived(cap.durSupport?.[model] || [4, 6, 8]);
  const durations = $derived((cap.durations || []).filter((d) => durSup.includes(d.id)));
  const resSup = $derived(cap.resSupport?.[model] || ['720p', '1080p']);
  const resolutions = $derived((cap.resolutions || []).filter((r) => resSup.includes(r.id)));
  const resName = $derived(tr((resolutions.find((r) => r.id === vs.videoResolution) || {}).name || vs.videoResolution));
  const imgCap = $derived(cap.imgCaps?.[model] || { last: false, ref: 0 });
  // Omni 原生带音轨没有开关（caps.audioFixed）——隐藏「声音」卡。
  const audioFixed = $derived((cap.audioFixed || []).includes(model));
  // Veo 专属参数（负面提示词/提示词增强/画质）：Omni 的 response_format 不认这些键。
  const veoOnly = $derived((cap.veoOnly || []).includes(model));
  const qualities = $derived(cap.qualities || []);
  const taskSup = $derived(cap.taskSupport?.[model] || ['t2v', 'i2v']);
  const canLast = $derived(!!imgCap.last && taskSup.includes('interp'));
  const maxRef = $derived(taskSup.includes('ref') ? (imgCap.ref || 0) : 0);

  onMount(() => loadHistory('video'));
  // 切模型后把选项落回该模型合法的档（分辨率取最高档、时长取最近档）。
  $effect(() => { if (resSup.length && !resSup.includes(vs.videoResolution)) vs.videoResolution = resSup[resSup.length - 1]; });
  $effect(() => {
    if (!durSup.length || durSup.includes(vs.videoDuration)) return;
    vs.videoDuration = durSup.reduce((b, x) => (Math.abs(x - vs.videoDuration) < Math.abs(b - vs.videoDuration) ? x : b), durSup[0]);
  });

  let field = $state(), hasText = $state(false);
  let modelSheet = $state(false), paramsSheet = $state(false);

  // —— 素材：首帧 / 尾帧 / 参考图（参考图与首尾帧互斥——Veo 两条路，不能混着喂）——
  let frameFirst = $state(null), frameLast = $state(null), refImages = $state([]);
  let fileInput = $state(), pickTarget = 'first';   // 'first' | 'last' | 'ref'
  // 任务 = 素材决定；同步写回 vs.videoTask（genVideo / 后端按它丢弃与任务无关的图）
  const task = $derived(refImages.length ? 'ref' : frameLast ? 'interp' : frameFirst ? 'i2v' : 't2v');
  const taskName = $derived(tr(((cap.tasks || []).find((x) => x.id === task) || {}).name || ''));
  $effect(() => { if (vs.videoTask !== task) vs.videoTask = task; });

  const fileToB64 = (f) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1] || ''); r.onerror = rej; r.readAsDataURL(f); });
  const revoke = (o) => { if (o?.url && o.url.startsWith('blob:')) { try { URL.revokeObjectURL(o.url); } catch {} } };
  // 换到不支持的模型：收掉这个模型用不上的素材（Omni 没有尾帧 / 参考图）
  $effect(() => { if (!canLast && frameLast) { revoke(frameLast); frameLast = null; } });
  $effect(() => { if (refImages.length > maxRef) { refImages.slice(maxRef).forEach(revoke); refImages = refImages.slice(0, maxRef); } });

  function clearSlot(slot) {
    if (slot === 'first') { revoke(frameFirst); frameFirst = null; }
    else if (slot === 'last') { revoke(frameLast); frameLast = null; }
  }
  function removeRef(i) { revoke(refImages[i]); refImages = refImages.filter((_, j) => j !== i); }
  function swapFrames() { const a = frameFirst; frameFirst = frameLast; frameLast = a; }

  // 这张图能当什么（按模型能力 + 互斥），给角色 sheet 用
  const roleOk = $derived({
    first: !refImages.length,
    last: canLast && !refImages.length,
    ref: maxRef > 0 && !frameFirst && !frameLast && refImages.length < maxRef,
  });
  const onlyFirst = $derived(!canLast && maxRef === 0);
  let rolePick = $state(null);   // null | { file?: File, url?: string } —— 打开「把图片用作」sheet
  function openPlus() {
    // 这个模型只吃首帧（Omni）：不用问，直接去选图
    if (onlyFirst) { pickTarget = 'first'; vs.matMenu = true; return; }
    rolePick = {};
  }
  function chooseRole(slot) {
    const f = rolePick?.file;
    closeRole();
    if (f) { uploadToSlot(f, slot); return; }
    pickTarget = slot; vs.matMenu = true;
  }
  function closeRole() { if (rolePick?.url) { try { URL.revokeObjectURL(rolePick.url); } catch {} } rolePick = null; }
  function attachWorkspace() { vs.matMenu = false; vs.matPicker = true; }
  function attachDevice() { vs.matMenu = false; fileInput && fileInput.click(); }
  function putSlot(slot, obj) {
    if (slot === 'first') { clearSlot('first'); frameFirst = obj; return frameFirst; }
    if (slot === 'last') { clearSlot('last'); frameLast = obj; return frameLast; }
    if (refImages.length >= maxRef) return null;
    refImages = [...refImages, obj];
    return refImages[refImages.length - 1];
  }
  const dropLive = (slot, live) => { if (slot === 'ref') { const i = refImages.indexOf(live); if (i >= 0) removeRef(i); } else clearSlot(slot); };

  async function uploadToSlot(f, slot) {
    if (f.size > 7_000_000) { uiAlert(t('图片超过 7MB（Vertex 附件上限）')); return; }
    const live = putSlot(slot, { path: null, name: f.name, url: URL.createObjectURL(f), pending: true });
    if (!live) return;
    try { const r = await api.upload(f.name, await fileToB64(f)); live.path = r.path; live.pending = false; }
    catch { dropLive(slot, live); uiAlert(t('上传失败：{name}', { name: f.name })); }
  }
  async function onPickImg(e) { const f = (e.target.files || [])[0]; e.target.value = ''; if (f) uploadToSlot(f, pickTarget); }
  async function pickWorkspaceImg(rel, name) {
    vs.matPicker = false;
    const slot = pickTarget;
    const live = putSlot(slot, { path: null, name, url: cloudFileUrl(rel), pending: true });
    if (!live) return;
    try { const r = await api.fileToUpload(rel); live.path = r.path; live.pending = false; }
    catch { dropLive(slot, live); uiAlert(t('载入素材失败')); }
  }

  // —— 桌面拖入 / 粘贴：还没有素材 → 直接当首帧（最常见）；已有素材 → 问用作哪一格 ——
  let dragOver = $state(false);
  function onDesktopImg(files) {
    const f = files.find(isImageFile); if (!f) return;
    if (onlyFirst || (!frameFirst && !frameLast && !refImages.length)) { uploadToSlot(f, 'first'); return; }
    closeRole();
    rolePick = { file: f, url: URL.createObjectURL(f) };
  }

  const anyPending = $derived(frameFirst?.pending || frameLast?.pending || refImages.some((r) => r.pending));
  const hasMaterial = $derived(!!(frameFirst || frameLast || refImages.length));
  // 缺什么就在输入岛下面说一句——按钮只管能不能点，不再把理由写在按钮上
  const hint = $derived(
    frameLast && !frameFirst ? t('首尾插值还差首帧')
      : refImages.length && !hasText ? t('参考图生成需要文字描述')
        : '',
  );
  const blocked = $derived(!!hint || anyPending || (task === 't2v' && !hasText));
  function gen() {
    const txt = (field?.textContent || '').trim();
    if (blocked || s.busy) return;
    genVideo(txt, {
      first: frameFirst?.path || null,
      last: frameLast?.path || null,
      refs: refImages.map((r) => r.path).filter(Boolean),
    });
    revoke(frameFirst); revoke(frameLast); refImages.forEach(revoke);
    frameFirst = null; frameLast = null; refImages = [];
    if (field) field.textContent = '';
    hasText = false;
  }

  // 全屏播放器（画廊=历史视频；当前结果不在历史里则并入）
  function openVideoFull(id, prompt) {
    const list = (s.history || []).map((h) => ({ origin: 'vertex', id: h.id, name: h.prompt || tr(h.title) || tc('名词', '生成视频'), kind: 'video' }));
    let idx = list.findIndex((x) => x.id === id);
    if (idx < 0) { list.unshift({ origin: 'vertex', id, name: prompt || tc('名词', '生成视频'), kind: 'video' }); idx = 0; }
    openPreview(list, idx);
  }

  // 助手预填 / 工作空间「发送给 AI · 视频」
  $effect(() => { const d = vs.videoDraft; if (d && field) { field.textContent = d; hasText = true; vs.videoDraft = ''; } });
  $effect(() => {
    const a = vs.videoSrcDraft; if (!a) return;
    const slot = a.slot || 'first';
    const obj = { path: a.path, name: a.name, url: a.url, pending: false };
    if (slot === 'last') { clearSlot('last'); frameLast = obj; }
    else if (slot === 'ref') { clearSlot('first'); clearSlot('last'); if (refImages.length < maxRef) refImages = [...refImages, obj]; }
    else { refImages.forEach(revoke); refImages = []; clearSlot('first'); frameFirst = obj; }
    vs.videoSrcDraft = null;
  });
</script>

{#snippet paramsBody()}
  <div class="p-card"><div class="p-lab">{t('比例')}</div>
    <div class="seg">
      {#each aspects as a (a.id)}
        <button class="seg-b" class:on={vs.videoAspect === a.id} onclick={() => (vs.videoAspect = a.id)}>
          {#if ASPECT_SHP[a.id]}<span class="shp {ASPECT_SHP[a.id]}"></span>{:else}<span class="ic">{@html icon('spark', 17)}</span>{/if}{tr(a.name)}
        </button>
      {/each}
    </div>
  </div>
  <div class="p-card"><div class="p-lab">{t('时长')} <i>{t('{a}–{b} 秒', { a: durSup[0], b: durSup[durSup.length - 1] })}</i></div>
    <div class="seg seg-num">
      {#each durations as d (d.id)}
        <button class="seg-b" class:on={vs.videoDuration === d.id} onclick={() => (vs.videoDuration = d.id)}>{tr(d.name)}</button>
      {/each}
    </div>
  </div>
  <div class="p-card"><div class="p-lab">{t('分辨率')} <i>{modelName}</i></div>
    <div class="seg">
      {#each resolutions as r (r.id)}
        <button class="seg-b" class:on={vs.videoResolution === r.id} onclick={() => (vs.videoResolution = r.id)}>{tr(r.name)}</button>
      {/each}
    </div>
  </div>
  {#if !audioFixed}
    <div class="p-card"><div class="p-lab">{t('声音')}</div>
      <button class="tgl" class:on={vs.videoAudio} onclick={() => (vs.videoAudio = !vs.videoAudio)}>
        <span class="tgl-tx">{t('生成音频')}<small>{t('为视频配上环境声与音效')}</small></span>
        <span class="tgl-knob ic">{@html icon('vol', 21)}</span>
      </button>
    </div>
  {/if}
  {#if veoOnly}
    <div class="p-card"><div class="p-lab">{t('负面提示词')} <i>{t('可选')}</i></div>
      <input class="p-input" placeholder={t('不想出现的内容，例如：字幕、水印、人脸')} bind:value={vs.videoNeg} />
    </div>
    <div class="p-card"><div class="p-lab">{t('画质')}</div>
      <div class="seg">
        {#each qualities as q (q.id)}
          <button class="seg-b" class:on={(vs.videoQuality || '') === q.id} onclick={() => (vs.videoQuality = q.id)}>{tr(q.name)}</button>
        {/each}
      </div>
    </div>
    <div class="p-card"><div class="p-lab">{t('提示词')}</div>
      <button class="tgl" class:on={vs.videoEnhance} onclick={() => (vs.videoEnhance = !vs.videoEnhance)}>
        <span class="tgl-tx">{t('自动增强')}<small>{t('Veo 先把描述改写得更具体再生成')}</small></span>
        <span class="tgl-knob ic">{@html icon('spark', 21)}</span>
      </button>
    </div>
  {/if}
{/snippet}

{#snippet thumb(obj, label, onx, xLabel)}
  <div class="dock-att" class:pending={obj.pending}>
    <img src={obj.url} alt={obj.name || ''} />
    <span class="att-lab">{label}</span>
    {#if obj.pending}<span class="slot-spin"></span>{/if}
    <button class="slot-x ic" aria-label={xLabel} onclick={onx}>{@html icon('close', 12)}</button>
  </div>
{/snippet}

<div class="vmx m-video" class:dark={vs.theme === 'dark'}
  use:fileDrop={{ onEnter: () => (dragOver = true), onLeave: () => (dragOver = false), onDrop: onDesktopImg }}
  use:pasteFiles={{ onFiles: onDesktopImg, filter: isImageFile }}>

  <header class="hero">
    <div class="hero-head">
      <span class="hero-glyph ic">{@html glyph('video')}</span>
      <div class="hero-tt"><h2>{t('视频')}</h2><p>{t('Veo · 文字与图片生成视频')}</p></div>
    </div>
    <button class="model-pill" onclick={() => (modelSheet = true)}>
      <span class="mp-name">{modelName}</span><span class="ic">{@html icon('down', 20)}</span>
    </button>
  </header>

  <div class="mod-body">
    <div class="studio">
      <div class="st-rail">
        <button class="rail-model" onclick={() => (modelSheet = true)}>
          <b>{modelName}</b><small>{model}</small>
          <p>{tr(MODEL_DESC[model] || '')}</p>
          <span class="rm-chev ic">{@html icon('down', 20)}</span>
        </button>
        <div class="sec-tt">{t('设置')}</div>
        <div class="p-grid">{@render paramsBody()}</div>
      </div>

      <div class="st-composer st-sticky">
        <NeoDock bind:field bind:hasText busy={s.busy} disabled={blocked} {hint}
          placeholder={task === 'ref' ? t('描述画面，参考图只带主体与风格…') : hasMaterial ? t('描述运动 / 镜头（可选）…') : t('描述画面与运动…')}
          sendLabel={t('生成')} onsend={gen} onplus={openPlus} plusLabel={t('添加图片')}>
          {#snippet chips()}
            <button class="psum lead" onclick={() => (paramsSheet = true)}><span class="ic">{@html icon('spark', 18)}</span>{t('设置')}</button>
            <button class="psum" onclick={() => (paramsSheet = true)}>{#if ASPECT_SHP[vs.videoAspect]}<span class="shp {ASPECT_SHP[vs.videoAspect]}"></span>{/if}{aspectName}</button>
            <button class="psum" onclick={() => (paramsSheet = true)}>{t('{n} 秒', { n: vs.videoDuration })}</button>
            <button class="psum" onclick={() => (paramsSheet = true)}>{resName}</button>
            {#if !audioFixed}<button class="psum" class:on={vs.videoAudio} onclick={() => (paramsSheet = true)}>{vs.videoAudio ? t('有声') : t('无声')}</button>{/if}
          {/snippet}
          {#snippet atts()}
            {#if hasMaterial}
              <div class="dock-atts">
                {#if frameFirst || frameLast}
                  {#if frameFirst}{@render thumb(frameFirst, t('首帧'), () => clearSlot('first'), t('移除首帧'))}
                  {:else}<button class="dock-att ghost" onclick={() => { pickTarget = 'first'; vs.matMenu = true; }}><span class="ic">{@html icon('plus', 20)}</span><span class="att-lab">{t('首帧')}</span></button>{/if}
                  {#if canLast}
                    <button class="att-swap ic" aria-label={t('互换首尾帧')} onclick={swapFrames}>{@html icon('swap', 18)}</button>
                    {#if frameLast}{@render thumb(frameLast, t('尾帧'), () => clearSlot('last'), t('移除尾帧'))}
                    {:else}<button class="dock-att ghost" onclick={() => { pickTarget = 'last'; vs.matMenu = true; }}><span class="ic">{@html icon('plus', 20)}</span><span class="att-lab">{t('尾帧')}</span></button>{/if}
                  {/if}
                {/if}
                {#each refImages as r, i (r.url)}
                  {@render thumb(r, t('参考 {n}', { n: i + 1 }), () => removeRef(i), t('移除参考图'))}
                {/each}
                {#if refImages.length && refImages.length < maxRef}
                  <button class="dock-att ghost" aria-label={t('添加参考图')} onclick={() => { pickTarget = 'ref'; vs.matMenu = true; }}><span class="ic">{@html icon('plus', 20)}</span></button>
                {/if}
                <span class="att-mode">{taskName}</span>
              </div>
            {/if}
          {/snippet}
        </NeoDock>
      </div>

      <div class="st-canvas">
        <div>
          {#if s.busy}
            <div class="busy-hero">
              <span class="busy-glyph ic">{@html glyph('video')}</span>
              <div class="busy-time">{fmtT(s.elapsed)}</div>
              <div class="busy-hint">{t('{model} 生成中 · 约需 1–2 分钟', { model: modelName })}</div>
            </div>
          {:else if s.error}
            <div class="err-card"><span class="ic">{@html icon('warn', 24)}</span><span>{tr(s.error)}</span></div>
          {:else if s.result}
            <div class="sec-tt" style="padding-top:0">{t('本次生成')}</div>
            <div class="res-card">
              <div class="res-media" role="button" tabindex="0" use:dragOut={() => mediaDragSrc(s.result.id, s.result.prompt)} onclick={() => openVideoFull(s.result.id, s.result.prompt)}
                onkeydown={(e) => { if (e.key === 'Enter') openVideoFull(s.result.id, s.result.prompt); }}>
                <img src={mediaUrl(s.result.id, 'thumb')} alt="" onerror={(e) => (e.currentTarget.style.opacity = '0')} />
                <span class="res-play ic">{@html icon('play', 34)}</span>
              </div>
              <div class="res-cap"><b>{s.result.prompt || tc('名词', '生成视频')}</b></div>
            </div>
          {:else}
            <div class="empty-hero" class:compact={s.history.length > 0}>
              <span class="empty-glyph ic">{@html glyph('video')}</span>
              <h3>{t('从一句话到一段影像')}</h3>
              <p>{onlyFirst ? t('描述画面与运动，也可以加一张首帧图') : t('描述画面与运动；点「＋」加首帧、尾帧或参考图，模式会自动切换')}</p>
            </div>
          {/if}
        </div>
        {#if s.history.length}
          <div>
            <div class="sec-tt">{t('历史视频')}</div>
            <div class="hist-grid">
              {#each s.history as h (h.id)}
                <div class="hist-thumb" role="button" tabindex="0" use:dragOut={() => mediaDragSrc(h.id, h.title || h.prompt || '')} onclick={(e) => { if (!e.target.closest('.hist-x')) openVideoFull(h.id, h.title || h.prompt || ''); }}
                  onkeydown={(e) => { if (e.key === 'Enter') openVideoFull(h.id, h.title || h.prompt || ''); }}>
                  <img src={mediaUrl(h.id, 'thumb')} alt="" loading="lazy" onerror={(e) => (e.currentTarget.style.opacity = '0')} />
                  <span class="hist-play ic">{@html icon('play', 19)}</span>
                  <button class="hist-x ic" aria-label={t('删除')} onclick={(e) => { e.stopPropagation(); delMedia('video', h.id); }}>{@html icon('close', 14)}</button>
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>

  {#if dragOver}
    <div class="drop-ov" aria-hidden="true">
      <span class="ic">{@html icon('img', 34)}</span>
      {t('松开以添加图片')}
      <small>{t('可选作首帧 / 尾帧 / 参考图')}</small>
    </div>
  {/if}

  {#if rolePick}
    <NeoSheet title={t('把图片用作')} sub={t('模式会跟着自动切换')} onclose={closeRole}>
      {#if rolePick.url}<img src={rolePick.url} alt="" class="role-prev" />{/if}
      <button class="sh-opt" disabled={!roleOk.first} onclick={() => chooseRole('first')}>
        <span class="sh-opt-ic ic">{@html icon('img', 24)}</span>
        <span class="sh-opt-tx"><b>{frameFirst ? t('替换首帧') : t('首帧')}</b><small>{roleOk.first ? t('视频从这张图开始 · 图生视频') : t('已有参考图时不能用首尾帧')}</small></span>
      </button>
      {#if canLast}
        <button class="sh-opt" disabled={!roleOk.last} onclick={() => chooseRole('last')}>
          <span class="sh-opt-ic ic">{@html icon('img', 24)}</span>
          <span class="sh-opt-tx"><b>{frameLast ? t('替换尾帧') : t('尾帧')}</b><small>{roleOk.last ? t('视频到这张图结束 · 和首帧一起做首尾插值') : t('已有参考图时不能用首尾帧')}</small></span>
        </button>
      {/if}
      {#if maxRef > 0}
        <button class="sh-opt" disabled={!roleOk.ref} onclick={() => chooseRole('ref')}>
          <span class="sh-opt-ic ic">{@html icon('layers', 24)}</span>
          <span class="sh-opt-tx"><b>{refImages.length ? t('参考图（{n}/{max}）', { n: refImages.length, max: maxRef }) : t('参考图')}</b><small>{frameFirst || frameLast ? t('已有首尾帧时不能用参考图') : refImages.length >= maxRef ? t('最多 {n} 张参考图', { n: maxRef }) : t('带入主体 / 风格 · 需要文字描述')}</small></span>
        </button>
      {/if}
    </NeoSheet>
  {/if}

  {#if modelSheet}
    <NeoModelSheet sub="Veo / Omni" models={cap.models || []} current={model} onpick={(id) => (vs.videoModel = id)} onclose={() => (modelSheet = false)} />
  {/if}
  {#if paramsSheet}
    <NeoSheet title={t('视频设置')} sub={modelName} onclose={() => (paramsSheet = false)}>
      {@render paramsBody()}
    </NeoSheet>
  {/if}
  {#if vs.matMenu}
    <NeoSourceSheet onWorkspace={attachWorkspace} onDevice={attachDevice} onclose={() => (vs.matMenu = false)} />
  {/if}
  {#if vs.matPicker}
    <NeoWorkspacePicker onPick={pickWorkspaceImg} onclose={() => (vs.matPicker = false)} />
  {/if}
  <input type="file" hidden accept="image/png,image/jpeg,image/webp" bind:this={fileInput} onchange={onPickImg} />
</div>
