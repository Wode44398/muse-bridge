<script>
  // 音乐生成（Lyria）—— vmx UI。和另外三个模块同一套流程：画布（本次生成 + 历史）在上，提示词在钉底的输入岛里。
  // 灵感 chips 放在空态里点一下填进输入框；负面提示只有 lyria-002 认，收进设置（移动端 sheet / 桌面右栏）。
  import { onMount } from 'svelte';
  import { mediaDragSrc } from '../lib/vertexMedia.svelte.js';
  import { vertex as vs, caps } from '../lib/state.svelte.js';
  import { vmedia, genMusic, mediaUrl, loadHistory, delMedia } from '../lib/vertexMedia.svelte.js';
  import { icon, glyph, fmtT, MODEL_DESC, MUSIC_IDEAS } from '../lib/neoUi.js';
  import NeoSheet from './neo/NeoSheet.svelte';
  import NeoModelSheet from './neo/NeoModelSheet.svelte';
  import NeoPlayer from './neo/NeoPlayer.svelte';
  import NeoDock from './neo/NeoDock.svelte';
  import { t, tr } from '../lib/i18n.js';

  const s = $derived(vmedia.music);
  const cap = $derived(caps.data?.music || {});
  const model = $derived(vs.musicModel || cap.defaults?.model || '');
  const modelName = $derived(tr((cap.models || []).find((m) => m.id === model)?.name || model || '—'));
  // 负面提示词只有 lyria-002 那条 Vertex :predict 通道吃；lyria-3 走 generateContent，
  // 驱动层根本不看这个字段——摆着只会让人填了以为生效。
  const negSup = $derived((cap.negSupport || []).includes(model));
  const negOn = $derived(negSup && !!(vs.musicNeg || '').trim());

  onMount(() => loadHistory('music'));
  let field = $state(), hasText = $state(false);
  let modelSheet = $state(false), paramsSheet = $state(false);
  function useIdea(idea) { if (field) { field.textContent = idea; hasText = true; field.focus(); } }
  function gen() {
    const txt = (field?.textContent || '').trim();
    if (!txt || s.busy) return;
    genMusic(txt, negSup ? vs.musicNeg : '');
  }
  const seedOf = (x) => { let h = 9; for (const c of String(x)) h = Math.imul(h ^ c.charCodeAt(0), 387420489); return (h ^ (h >>> 9)) >>> 0; };
  $effect(() => { const d = vs.musicDraft; if (d && field) { field.textContent = d; hasText = true; vs.musicDraft = ''; } });
</script>

{#snippet paramsBody()}
  {#if negSup}
    <div class="p-card"><div class="p-lab">{t('负面提示')} <i>{t('可选')}</i></div>
      <input class="p-input" placeholder={t('想排除的元素，例如：人声、鼓点')} bind:value={vs.musicNeg} />
    </div>
  {:else}
    <div class="p-note">{t('{model} 没有额外参数：直接在下方描述风格、乐器、情绪和节奏即可。', { model: modelName })}</div>
  {/if}
{/snippet}

<div class="vmx m-music" class:dark={vs.theme === 'dark'}>
  <header class="hero">
    <div class="hero-head">
      <span class="hero-glyph ic">{@html glyph('music')}</span>
      <div class="hero-tt"><h2>{t('音乐')}</h2><p>{t('Lyria · 文字生成配乐')}</p></div>
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
        <NeoDock bind:field bind:hasText busy={s.busy} disabled={!hasText}
          placeholder={t('描述音乐风格、乐器、情绪…')} sendLabel={t('生成音乐')} onsend={gen}
          chips={negSup ? musicChips : null}>
        </NeoDock>
      </div>

      <div class="st-canvas">
        <div>
          {#if s.busy}
            <div class="busy-hero">
              <span class="busy-glyph ic">{@html glyph('music')}</span>
              <div class="busy-time">{fmtT(s.elapsed)}</div>
              <div class="busy-hint">{t('Lyria 谱曲中 · 约需 1–2 分钟')}</div>
            </div>
          {:else if s.error}
            <div class="err-card"><span class="ic">{@html icon('warn', 24)}</span><span>{tr(s.error)}</span></div>
          {:else if s.result}
            <div class="sec-tt" style="padding-top:0">{t('本次生成')}</div>
            <div class="hist-card">
              <div class="hist-card-tt"><b>{s.result.prompt}</b></div>
              <NeoPlayer src={mediaUrl(s.result.id)} wave seed={seedOf(s.result.id)} dragSrc={mediaDragSrc(s.result.id, s.result.prompt)} />
            </div>
          {:else}
            <div class="empty-hero" class:compact={s.history.length > 0}>
              <span class="empty-glyph ic">{@html glyph('music')}</span>
              <h3>{t('一句话，一支曲')}</h3>
              <p>{t('描述风格、乐器与情绪，Lyria 为你谱一段配乐')}</p>
            </div>
            <div class="idea-wrap">
              <div class="idea-tt">{t('试试这些')}</div>
              <div class="idea-row">
                {#each MUSIC_IDEAS as idea (idea)}
                  <button class="idea" onclick={() => useIdea(tr(idea))}>{tr(idea)}</button>
                {/each}
              </div>
            </div>
          {/if}
        </div>
        {#if s.history.length}
          <div>
            <div class="sec-tt">{t('历史音乐')}</div>
            <div class="hist-list">
              {#each s.history as h (h.id)}
                <div class="hist-card">
                  <div class="hist-card-tt">
                    <b>{h.prompt || tr(h.title) || t('音乐')}</b>
                    <button class="hist-x ic" aria-label={t('删除')} onclick={() => delMedia('music', h.id)}>{@html icon('close', 14)}</button>
                  </div>
                  <NeoPlayer src={mediaUrl(h.id)} sm wave seed={seedOf(h.id)} dragSrc={mediaDragSrc(h.id, h.prompt || h.title || '')} />
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>

  {#if modelSheet}
    <NeoModelSheet sub="Lyria" models={cap.models || []} current={model} onpick={(id) => (vs.musicModel = id)} onclose={() => (modelSheet = false)} />
  {/if}
  {#if paramsSheet}
    <NeoSheet title={t('音乐设置')} sub={modelName} onclose={() => (paramsSheet = false)}>
      {@render paramsBody()}
    </NeoSheet>
  {/if}
</div>

{#snippet musicChips()}
  <button class="psum lead" onclick={() => (paramsSheet = true)}><span class="ic">{@html icon('spark', 18)}</span>{t('设置')}</button>
  {#if negOn}<button class="psum" onclick={() => (paramsSheet = true)}>{t('排除：{x}', { x: vs.musicNeg.trim() })}</button>{/if}
{/snippet}
