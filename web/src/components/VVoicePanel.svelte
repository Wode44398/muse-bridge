<script>
  // 语音合成（Gemini TTS）—— vmx UI。和另外三个模块同一套流程：画布（本次合成 + 历史）在上，
  // 朗读文本在钉底的输入岛里（长文：回车换行，Ctrl/⌘+Enter 或点发送合成）。
  // 移动端：输入岛上方 chips = 音色（点开音色 sheet）/ 风格 / 多人对白（点开设置 sheet）；
  // 桌面 ≥1080：右栏常驻风格、说话人与音色网格。
  import { onMount } from 'svelte';
  import { mediaDragSrc } from '../lib/vertexMedia.svelte.js';
  import { vertex as vs, caps } from '../lib/state.svelte.js';
  import { vmedia, genTTS, mediaUrl, loadHistory, delMedia } from '../lib/vertexMedia.svelte.js';
  import { icon, glyph, fmtT, MODEL_DESC } from '../lib/neoUi.js';
  import NeoSheet from './neo/NeoSheet.svelte';
  import NeoModelSheet from './neo/NeoModelSheet.svelte';
  import NeoPlayer from './neo/NeoPlayer.svelte';
  import NeoDock from './neo/NeoDock.svelte';
  import { t, tr } from '../lib/i18n.js';

  const s = $derived(vmedia.voice);
  const cap = $derived(caps.data?.tts || {});
  const model = $derived(vs.voiceModel || cap.defaults?.model || '');
  const modelName = $derived(tr((cap.models || []).find((m) => m.id === model)?.name || model || '—'));
  // caps 的音色 name 形如「Kore · 沉稳」→ 拆成名字 + 特质两行（英文界面先整名、再特质各 tr 一次）
  const voices = $derived((cap.voices || []).map((v) => {
    const [nm, trait] = String(tr(v.name || v.id)).split('·').map((x) => x.trim());
    return { id: v.id, nm: nm || v.id, trait: tr(trait || '') };
  }));
  const styles = $derived(cap.styles || []);
  const styleName = $derived(tr((styles.find((x) => x.id === (vs.voiceStyle || '')) || {}).name || ''));
  const maxSpk = $derived(cap.maxSpeakers || 2);
  const MULTI_PH = t('主持人：今天聊点什么？\n嘉宾：聊聊 Gemini。');
  // 多人对白：正文用「名字：台词」分行，speakerVoiceConfigs 的名字要和正文对上。
  // 开着多人时，音色网格给「当前正在编辑的说话人」挑音色。
  let editSpk = $state(0);
  const multi = $derived(!!vs.voiceMulti);
  const spk = $derived(vs.voiceSpeakers || []);
  const soloVoice = $derived(vs.voice || cap.defaults?.voice || '');
  const curVoice = $derived(multi ? (spk[editSpk]?.voice || '') : soloVoice);
  const traitOf = (id) => voices.find((v) => v.id === id)?.trait || '';
  function pickVoice(id) { if (multi) { if (spk[editSpk]) spk[editSpk].voice = id; } else vs.voice = id; }
  const spkReady = $derived(!multi || spk.filter((x) => x && x.speaker && x.voice).length >= 2);
  const spkLabel = (i) => spk[i]?.speaker || t('说话人 {n}', { n: i + 1 });

  onMount(() => loadHistory('voice'));
  let field = $state(), hasText = $state(false);
  let modelSheet = $state(false), paramsSheet = $state(false), voiceSheet = $state(false);
  function openVoices(i) { if (i != null) editSpk = i; voiceSheet = true; }
  function gen() {
    const txt = (field?.textContent || '').trim();
    if (!txt || !spkReady || s.busy) return;
    genTTS(txt);
  }
  $effect(() => { const d = vs.voiceDraft; if (d && field) { field.textContent = d; hasText = true; vs.voiceDraft = ''; } });
</script>

{#snippet voiceGrid(after)}
  <div class="voice-grid">
    {#each voices as v (v.id)}
      <button class="voice-card" class:on={curVoice === v.id} onclick={() => { pickVoice(v.id); after?.(); }}>
        <span class="voice-ava">{v.nm[0]}</span>
        <span class="voice-tx"><b>{v.nm}</b><small>{v.trait}</small></span>
      </button>
    {/each}
  </div>
{/snippet}

{#snippet paramsBody(inSheet)}
  <div class="p-card"><div class="p-lab">{t('风格')}</div>
    <div class="seg seg-grid2">
      {#each styles as st (st.id)}
        <button class="seg-b" class:on={(vs.voiceStyle || '') === st.id} onclick={() => (vs.voiceStyle = st.id)}>{tr(st.name)}</button>
      {/each}
    </div>
  </div>
  <div class="p-card"><div class="p-lab">{t('说话人')}</div>
    <button class="tgl" class:on={multi} onclick={() => (vs.voiceMulti = !multi)}>
      <span class="tgl-tx">{t('多人对白')}<small>{t('最多 {n} 人，正文按「名字：台词」分行', { n: maxSpk })}</small></span>
      <span class="tgl-knob ic">{@html icon('spark', 21)}</span>
    </button>
    {#if multi}
      <div class="spk-rows">
        {#each spk.slice(0, maxSpk) as sp, i (i)}
          <div class="spk-row" class:on={!inSheet && editSpk === i}>
            <input class="p-input spk-name" placeholder={t('说话人 {n}', { n: i + 1 })} bind:value={sp.speaker} />
            <button class="spk-voice" onclick={() => (inSheet ? openVoices(i) : (editSpk = i))}>{sp.voice || t('选音色')}</button>
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

<div class="vmx m-voice" class:dark={vs.theme === 'dark'}>
  <header class="hero">
    <div class="hero-head">
      <span class="hero-glyph ic">{@html glyph('voice')}</span>
      <div class="hero-tt"><h2>{t('语音')}</h2><p>{t('Gemini TTS · 文本朗读合成')}</p></div>
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
        <div class="p-grid">{@render paramsBody(false)}</div>
        <div class="sec-tt">{t('音色')} <small>{multi ? t('为「{name}」选', { name: spkLabel(editSpk) }) : t('当前：{voice}', { voice: curVoice })}</small></div>
        {@render voiceGrid(null)}
      </div>

      <div class="st-composer st-sticky">
        <NeoDock bind:field bind:hasText busy={s.busy} disabled={!hasText || !spkReady} tall enterSends={false}
          hint={spkReady ? '' : t('两位说话人都要填名字和音色')}
          placeholder={multi ? MULTI_PH : t('输入要朗读的文本…')} sendLabel={t('合成语音')} onsend={gen}>
          {#snippet chips()}
            <button class="psum lead" onclick={() => (paramsSheet = true)}><span class="ic">{@html icon('spark', 18)}</span>{t('设置')}</button>
            {#if multi}
              {#each spk.slice(0, maxSpk) as sp, i (i)}
                <button class="psum" onclick={() => openVoices(i)}><span class="psum-ava">{(sp.voice || '?')[0]}</span>{spkLabel(i)} · {sp.voice || t('选音色')}</button>
              {/each}
            {:else}
              <button class="psum" onclick={() => openVoices(null)}><span class="psum-ava">{soloVoice[0] || '?'}</span>{soloVoice}{#if traitOf(soloVoice)}<small>{traitOf(soloVoice)}</small>{/if}</button>
            {/if}
            {#if vs.voiceStyle}<button class="psum" onclick={() => (paramsSheet = true)}>{styleName}</button>{/if}
          {/snippet}
        </NeoDock>
      </div>

      <div class="st-canvas">
        <div>
          {#if s.busy}
            <div class="busy-hero">
              <span class="busy-glyph ic">{@html glyph('voice')}</span>
              <div class="busy-time">{fmtT(s.elapsed)}</div>
              <div class="busy-hint">{t('Gemini TTS 合成中')}</div>
            </div>
          {:else if s.error}
            <div class="err-card"><span class="ic">{@html icon('warn', 24)}</span><span>{tr(s.error)}</span></div>
          {:else if s.result}
            <div class="sec-tt" style="padding-top:0">{t('本次合成')}</div>
            <div class="hist-card">
              <div class="hist-card-tt"><b>{s.result.prompt}</b></div>
              <NeoPlayer src={mediaUrl(s.result.id)} dragSrc={mediaDragSrc(s.result.id, s.result.prompt)} />
              <div class="hist-meta">{multi ? t('多人对白') : t('音色 {voice}', { voice: soloVoice })} · {modelName}</div>
            </div>
          {:else}
            <div class="empty-hero" class:compact={s.history.length > 0}>
              <span class="empty-glyph ic">{@html glyph('voice')}</span>
              <h3>{t('把文字念给你听')}</h3>
              <p>{t('在下方输入文本，点音色换一种声音')}</p>
            </div>
          {/if}
        </div>
        {#if s.history.length}
          <div>
            <div class="sec-tt">{t('历史语音')}</div>
            <div class="hist-list">
              {#each s.history as h (h.id)}
                <div class="hist-card">
                  <div class="hist-card-tt">
                    <b>{h.prompt || tr(h.title) || t('语音')}</b>
                    <button class="hist-x ic" aria-label={t('删除')} onclick={() => delMedia('voice', h.id)}>{@html icon('close', 14)}</button>
                  </div>
                  <NeoPlayer src={mediaUrl(h.id)} sm dragSrc={mediaDragSrc(h.id, h.prompt || h.title || '')} />
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>

  {#if modelSheet}
    <NeoModelSheet sub="Gemini TTS" models={cap.models || []} current={model} onpick={(id) => (vs.voiceModel = id)} onclose={() => (modelSheet = false)} />
  {/if}
  {#if paramsSheet}
    <NeoSheet title={t('语音设置')} sub={modelName} onclose={() => (paramsSheet = false)}>
      {@render paramsBody(true)}
    </NeoSheet>
  {/if}
  {#if voiceSheet}
    <NeoSheet title={t('选择音色')} sub={multi ? t('为「{name}」选', { name: spkLabel(editSpk) }) : ''} onclose={() => (voiceSheet = false)}>
      {@render voiceGrid(() => (voiceSheet = false))}
    </NeoSheet>
  {/if}
</div>
