<script>
  // 音色（ParamSpec type=voice）：GET /api/studio/voices?key=<provider>/<model> 拉列表；拉不到（服务没给列表）时
  // 退化成一个文本框，直接写音色 id。列表是两列文字行（名字 + 一行描述），选中行尾墨色勾。
  import { onMount } from 'svelte';
  import { t, tr } from '../../lib/i18n.js';
  import { studioApi } from '../../modules/studio/api.js';
  import { icon } from '../../modules/studio/icons.js';
  import Layer from './ui/Layer.svelte';
  import Measure from './ui/Measure.svelte';

  let { modelKey, current = '', anchor = null, onpick, onclose } = $props();
  let voices = $state(null), err = $state(''), custom = $state(initialCustom());
  function initialCustom() { return current || ''; }
  const cache = (globalThis.__studioVoices ||= new Map());
  onMount(async () => {
    if (cache.has(modelKey)) { voices = cache.get(modelKey); return; }
    try { const r = await studioApi.voices(modelKey); voices = r?.voices || []; cache.set(modelKey, voices); }
    catch { voices = []; err = t('拉不到这个模型的音色列表'); }
  });
</script>

<Layer title={t('选择音色')} {anchor} width={420} dialog={!anchor} {onclose}>
  {#if voices === null}
    <div class="op-empty"><Measure tone="live" /></div>
  {:else if voices.length}
    <div class="vp-grid">
      {#each voices as v (v.id)}
        <button class="op" class:on={v.id === current} onclick={() => { onpick?.(v.id); onclose?.(); }}>
          <span class="op-tx"><b><span>{tr(v.label || v.id)}</span></b>{#if v.note}<small>{tr(v.note)}</small>{/if}</span>
          <span class="op-ck">{@html icon('check')}</span>
        </button>
      {/each}
    </div>
  {:else}
    <div class="op-empty">
      {#if err}<p>{err}</p>{/if}
      <input class="pl-in mono" bind:value={custom} placeholder={t('音色 id')} aria-label={t('音色 id')} />
      <button class="op-go" disabled={!custom.trim()} onclick={() => { onpick?.(custom.trim()); onclose?.(); }}>{t('用这个音色')}</button>
    </div>
  {/if}
</Layer>
