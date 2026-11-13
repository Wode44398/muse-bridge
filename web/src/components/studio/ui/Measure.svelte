<script>
  // 量度条（dimensio components/ui/Measure.svelte 同款）：一根细线，走过的一段加粗着色，末端停一粒点。
  // tone：accent = 墨（默认）· live = 朱（正在发生：生成进度）。value 缺省（null）= 不知道进度：一小段在线上来回走。
  let { value = null, tone = 'accent', label = '' } = $props();
  const known = $derived(value != null && Number.isFinite(Number(value)) && Number(value) > 0);
  const v = $derived(known ? Math.max(0, Math.min(1, Number(value))) : 0);
</script>

<div class="ms {tone}" class:indet={!known} style="--v:{v}"
  role={label ? 'progressbar' : undefined} aria-label={label || undefined}
  aria-valuemin={label && known ? 0 : undefined} aria-valuemax={label && known ? 100 : undefined} aria-valuenow={label && known ? Math.round(v * 100) : undefined}>
  <span class="ms-rail"></span><span class="ms-fill"></span><span class="ms-head" class:on={v > 0}></span>
</div>
