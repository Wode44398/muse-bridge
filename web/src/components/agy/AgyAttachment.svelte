<script>
  // Antigravity 的附件（11-19）：输入框草稿、用户气泡、助手交付物三处共用一个件，两种画法——
  //   · 图片 / 视频 → 预览图瓦片（视频取服务端抽的那一帧，中间垫播放标）；
  //   · 其余 → 类型卡（左边一块类型字形，标题 + 「扩展名 · 大小」，右边下载或移除）。
  // 预览图依次试：本地 blob / data 地址 → 服务端缩略档（/api/agy/artifact?thumb=）→ 原图；都出不了就落回类型卡。
  import { agyArtifactUrl } from '../../lib/preview.svelte.js';
  import { dragOut } from '../../lib/dragOut.js';
  import { ATT_ICON, attLook, attMeta, clampRatio } from '../../lib/agy/attach-look.js';
  import { t } from '../../lib/i18n.js';

  const {
    att,
    sessionId = '',
    variant = 'deliv',     // deliv 助手交付物 | user 用户气泡 | draft 输入框草稿
    solo = false,          // 这一组只有它一个：预览图按原比例放大一档
    onopen = null,         // (att, el) => void；不给就不可点
    onremove = null,       // 草稿的移除
    download = '',         // 下载地址；给了才出下载键
    drag = null,           // 拖出来源（dragOut 的取值函数）
  } = $props();

  const look = $derived(attLook(att));
  const localUrl = $derived(/^(blob:|data:)/i.test(att?.url || '') ? att.url : '');
  const origUrl = $derived(att?.path ? agyArtifactUrl(sessionId, att.path, { name: att.name }) : (localUrl ? '' : (att?.url || '')));
  const thumbUrl = $derived(att?.path ? origUrl + '&thumb=' + (variant === 'draft' ? '1' : 'grid') : '');

  // 候选地址：图片 = 本地 → 缩略 → 原图；视频 = 服务端抽帧（没有路径、只有本地 blob 时用 <video> 自己定格第一帧）
  const cands = $derived.by(() => {
    if (!look.media) return [];
    const list = look.media === 'image' ? [localUrl, thumbUrl, origUrl] : [thumbUrl];
    return list.filter((u, i, arr) => u && arr.indexOf(u) === i);
  });
  const candKey = $derived(cands.join('\n'));

  let tryIdx = $state(0);
  let shown = $state(false);
  let ratio = $state(1.5);
  let videoDead = $state(false);
  let lastKey = '';
  $effect.pre(() => {
    if (candKey === lastKey) return;
    lastKey = candKey;
    tryIdx = 0;
    videoDead = false;
  });

  const imgSrc = $derived(cands[tryIdx] || '');
  const videoSrc = $derived(look.media === 'video' && !imgSrc && localUrl && !videoDead ? localUrl : '');
  const asMedia = $derived(!!look.media && !!(imgSrc || videoSrc));
  // 按原比例的只有交付物和单张；多张的用户附件与草稿一律方格裁切
  const natural = $derived(variant === 'deliv' || (variant === 'user' && solo));

  function onImgLoad(e) {
    const el = e.currentTarget;
    ratio = clampRatio(el.naturalWidth, el.naturalHeight);
    shown = true;
  }
  // 缓存里的图可能在监听挂上之前就解码完了：挂载 / 换地址后补看一眼
  let imgEl = $state(null);
  $effect(() => {
    imgSrc;
    const el = imgEl;
    if (el && el.complete && el.naturalWidth > 0) {
      ratio = clampRatio(el.naturalWidth, el.naturalHeight);
      shown = true;
    }
  });
  function onImgError() {
    shown = false;
    tryIdx += 1;
  }
  function onVideoMeta(e) {
    const el = e.currentTarget;
    ratio = clampRatio(el.videoWidth, el.videoHeight);
    shown = true;
  }

  const meta = $derived(
    att?.pending ? t('上传中…') : (att?.note || attMeta(look, { folderWord: t('文件夹'), fileWord: t('文件') }))
  );
  const openLabel = $derived(t('打开 {name}', { name: look.name }));
  const getDrag = () => (typeof drag === 'function' ? drag() : null);
</script>

{#if asMedia}
  <div
    class="aa aa-media v-{variant}"
    class:solo
    class:shown
    class:pending={att.pending}
    class:hit={!!onopen}
    style:--r={natural ? ratio : 1}
    title={variant === 'draft' ? (att.note || att.path || look.name) : null}
    use:dragOut={getDrag}
  >
    {#if videoSrc}
      <!-- svelte-ignore a11y_media_has_caption -->
      <video src={videoSrc + '#t=0.1'} muted playsinline preload="auto" onloadedmetadata={onVideoMeta} onerror={() => { videoDead = true; }}></video>
    {:else}
      <img bind:this={imgEl} src={imgSrc} alt={look.name} loading="lazy" decoding="async" draggable="false" onload={onImgLoad} onerror={onImgError} />
    {/if}
    {#if onopen}
      <button type="button" class="aa-hit" aria-label={openLabel} onclick={(e) => onopen(att, e.currentTarget)}></button>
    {/if}
    {#if look.media === 'video' && !att.pending}
      <span class="aa-play" aria-hidden="true"><span class="msr-f">play_arrow</span></span>
    {/if}
    {#if att.pending}<span class="aa-spin" aria-hidden="true"></span>{/if}
    {#if variant === 'deliv'}
      <span class="aa-cap" aria-hidden="true"><span class="aa-cap-name">{look.name}</span></span>
    {/if}
    {#if download}
      <a class="aa-dl" href={download} download={look.name} aria-label={t('下载')} title={t('下载')}><span class="msr">download</span></a>
    {/if}
    {#if onremove}
      <button type="button" class="aa-x" onclick={() => onremove(att)} aria-label={t('移除附件')}><span class="msr">close</span></button>
    {/if}
  </div>
{:else}
  <div
    class="aa aa-card v-{variant}"
    class:pending={att.pending}
    class:hit={!!onopen}
    title={att.note || att.path || look.name}
    use:dragOut={getDrag}
  >
    {#if onopen}
      <button type="button" class="aa-hit" aria-label={openLabel} onclick={(e) => onopen(att, e.currentTarget)}></button>
    {/if}
    <span class="aa-type tone-{look.tone}" aria-hidden="true">
      <span class="msr4">{ATT_ICON[look.glyph] || ATT_ICON.file}</span>
    </span>
    <span class="aa-texts">
      <span class="aa-name">{look.stem}</span>
      {#if meta}<span class="aa-meta">{meta}</span>{/if}
    </span>
    {#if att.pending}<span class="aa-spin inline" aria-hidden="true"></span>{/if}
    {#if download}
      <a class="aa-dl" href={download} download={look.name} aria-label={t('下载')} title={t('下载')}><span class="msr">download</span></a>
    {/if}
    {#if onremove}
      <button type="button" class="aa-x" onclick={() => onremove(att)} aria-label={t('移除附件')}><span class="msr">close</span></button>
    {/if}
  </div>
{/if}

<style>
  .aa {
    position: relative;
    flex: none;
    min-width: 0;
    -webkit-tap-highlight-color: transparent;
  }
  .aa-hit {
    position: absolute;
    inset: 0;
    z-index: 1;
    border-radius: inherit;
    cursor: pointer;
  }
  .aa-hit:focus-visible { outline: 2px solid var(--ag-accent); outline-offset: 2px; }

  /* ———— 预览图瓦片 ———— */
  .aa-media {
    --h: 156px;
    --play: 40px;
    --edge: color-mix(in srgb, var(--ag-on) 10%, transparent);
    width: min(100%, calc(var(--h) * var(--r, 1.5)));
    aspect-ratio: var(--r, 1.5);
    border-radius: 16px;
    overflow: hidden;
    isolation: isolate;
    background: var(--ag-surface-2);
  }
  /* 压在图上的一圈细线：深色图贴深色底时仍有边 */
  .aa-media::after {
    content: '';
    position: absolute;
    inset: 0;
    z-index: 4;
    border-radius: inherit;
    box-shadow: inset 0 0 0 1px var(--edge);
    pointer-events: none;
  }
  .aa-media.v-deliv.solo { --h: 240px; --play: 48px; }
  .aa-media.v-user { --h: 104px; --play: 30px; border-radius: 14px; }
  .aa-media.v-user.solo { --h: 180px; --play: 40px; border-radius: 16px; }
  .aa-media.v-draft { --h: 56px; --play: 20px; width: 56px; border-radius: 12px; }
  @media (max-width: 599px) {
    .aa-media.v-deliv { --h: 124px; --play: 34px; }
    .aa-media.v-deliv.solo { --h: 200px; --play: 44px; }
  }

  .aa-media img,
  .aa-media video {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    object-fit: cover;
    opacity: 0;
    transition: opacity 0.28s var(--ag-ease-std), transform 0.5s var(--ag-ease-decel);
    pointer-events: none;
  }
  .aa-media.shown img,
  .aa-media.shown video { opacity: 1; }
  /* 上传中：图上压一层暗幕托住白色转圈（明暗主题都看得清） */
  .aa-media.pending::before {
    content: '';
    position: absolute;
    inset: 0;
    z-index: 1;
    background: rgba(0, 0, 0, 0.4);
    pointer-events: none;
  }

  .aa-play {
    position: absolute;
    left: 50%;
    top: 50%;
    z-index: 2;
    width: var(--play);
    height: var(--play);
    margin: calc(var(--play) / -2) 0 0 calc(var(--play) / -2);
    border-radius: 50%;
    display: grid;
    place-items: center;
    background: rgba(0, 0, 0, 0.48);
    box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.18);
    pointer-events: none;
    transition: transform 0.3s var(--ag-ease-decel), background 0.2s;
  }
  .aa-play .msr-f { font-size: calc(var(--play) * 0.62); color: #fff; }

  /* 名字只在指到时从底部浮出；触屏没有悬停，就只留下载键 */
  .aa-cap {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    z-index: 2;
    display: flex;
    align-items: flex-end;
    height: 64px;
    padding: 0 48px 11px 13px;
    background: linear-gradient(to top, rgba(0, 0, 0, 0.66), rgba(0, 0, 0, 0.28) 55%, rgba(0, 0, 0, 0));
    opacity: 0;
    transition: opacity 0.2s var(--ag-ease-std);
    pointer-events: none;
  }
  .aa-cap-name {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12.5px;
    line-height: 16px;
    color: #fff;
  }
  .aa-media .aa-dl {
    position: absolute;
    right: 8px;
    bottom: 8px;
    z-index: 3;
    width: 30px;
    height: 30px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: #fff;
    background: rgba(0, 0, 0, 0.5);
    text-decoration: none;
    transition: opacity 0.2s var(--ag-ease-std), background 0.15s;
  }
  .aa-media .aa-dl .msr { font-size: 18px; }
  .aa-media .aa-x {
    position: absolute;
    top: 4px;
    right: 4px;
    z-index: 3;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: #fff;
    background: rgba(0, 0, 0, 0.58);
  }
  .aa-media .aa-x .msr { font-size: 14px; }
  @media (hover: hover) {
    .aa-media .aa-dl { opacity: 0; }
    .aa-media:hover .aa-dl,
    .aa-media:focus-within .aa-dl { opacity: 1; }
    .aa-media .aa-dl:hover { background: rgba(0, 0, 0, 0.74); }
    .aa-media:hover .aa-cap,
    .aa-media:focus-within .aa-cap { opacity: 1; }
    .aa-media.hit:hover img,
    .aa-media.hit:hover video { transform: scale(1.035); }
    .aa-media.hit:hover .aa-play { transform: scale(1.08); background: rgba(0, 0, 0, 0.6); }
    .aa-media .aa-x:hover { background: rgba(0, 0, 0, 0.8); }
  }

  /* ———— 类型卡 ———— */
  .aa-card {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 56px;
    min-width: 176px;
    max-width: min(100%, 300px);
    padding: 0 8px 0 10px;
    border-radius: 14px;
    background: var(--ag-surface-3);
    box-shadow: inset 0 0 0 1px var(--ag-border);
    transition: background 0.16s var(--ag-ease-std), box-shadow 0.16s var(--ag-ease-std);
  }
  .aa-card.v-user {
    height: 52px;
    background: var(--ag-bubble-bg);
    box-shadow: none;
  }
  .aa-card.v-draft {
    min-width: 0;
    max-width: 216px;
    border-radius: 12px;
    padding-right: 6px;
    background: var(--ag-surface-2);
    box-shadow: none;
  }
  .aa-card.pending .aa-type,
  .aa-card.pending .aa-name { opacity: 0.55; }
  @media (hover: hover) {
    .aa-card.hit:hover {
      background: linear-gradient(var(--ag-hover), var(--ag-hover)), var(--ag-surface-3);
      box-shadow: inset 0 0 0 1px var(--ag-border-strong);
    }
    .aa-card.v-user.hit:hover {
      background: linear-gradient(var(--ag-hover), var(--ag-hover)), var(--ag-bubble-bg);
      box-shadow: none;
    }
    .aa-card.v-draft.hit:hover {
      background: linear-gradient(var(--ag-hover), var(--ag-hover)), var(--ag-surface-2);
      box-shadow: none;
    }
  }
  .aa-card.hit:active { background: linear-gradient(var(--ag-active), var(--ag-active)), var(--ag-surface-3); }
  .aa-card.v-user.hit:active { background: linear-gradient(var(--ag-active), var(--ag-active)), var(--ag-bubble-bg); }
  .aa-card.v-draft.hit:active { background: linear-gradient(var(--ag-active), var(--ag-active)), var(--ag-surface-2); }

  .aa-type {
    flex: none;
    width: 36px;
    height: 36px;
    border-radius: 10px;
    display: grid;
    place-items: center;
  }
  .aa-type .msr4 { font-size: 20px; }
  .tone-neutral { background: var(--ag-active); color: var(--ag-on-dim); }
  .tone-blue { background: var(--ag-accent-soft); color: var(--ag-accent); }
  .tone-green { background: var(--ag-ok-bg); color: var(--ag-ok); }
  .tone-yellow { background: var(--ag-warn-bg); color: var(--ag-warn); }
  .tone-red { background: var(--ag-err-bg); color: var(--ag-err); }

  .aa-texts {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    text-align: left;
  }
  .aa-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13.5px;
    line-height: 18px;
    color: var(--ag-on);
  }
  .aa-meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 11.5px;
    line-height: 15px;
    letter-spacing: 0.02em;
    color: var(--ag-on-faint);
  }
  .aa-card .aa-dl,
  .aa-card .aa-x {
    position: relative;
    z-index: 2;
    flex: none;
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: grid;
    place-items: center;
    color: var(--ag-on-faint);
    text-decoration: none;
    transition: background 0.15s, color 0.15s;
  }
  .aa-card .aa-x { width: 26px; height: 26px; }
  .aa-card .aa-dl .msr { font-size: 18px; }
  .aa-card .aa-x .msr { font-size: 16px; }
  .aa-card .aa-dl:hover,
  .aa-card .aa-x:hover { background: var(--ag-hover); color: var(--ag-on); }

  /* ———— 上传中 ———— */
  .aa-spin {
    position: absolute;
    left: 50%;
    top: 50%;
    z-index: 2;
    width: 18px;
    height: 18px;
    margin: -9px 0 0 -9px;
    border-radius: 50%;
    border: 2px solid rgba(255, 255, 255, 0.35);
    border-top-color: #fff;
    animation: aa-spin 0.8s linear infinite;
    pointer-events: none;
  }
  .aa-spin.inline {
    position: static;
    flex: none;
    width: 14px;
    height: 14px;
    margin: 0 4px 0 0;
    border-color: var(--ag-border-strong);
    border-top-color: var(--ag-on-dim);
  }
  @keyframes aa-spin { to { transform: rotate(360deg); } }

  @media (prefers-reduced-motion: reduce) {
    .aa-media img,
    .aa-media video,
    .aa-play { transition: none; }
    .aa-media.hit:hover img,
    .aa-media.hit:hover video,
    .aa-media.hit:hover .aa-play { transform: none; }
  }
</style>
