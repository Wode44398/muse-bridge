<script module>
  // 多实例时 gradient id 不能撞，模块级自增序号。
  let _seq = 0;
</script>

<script>
  // Gemini 官方四角星 logo —— 与主页 vertex 入口图标 assets/icons/gemini.svg 完全一致：
  // 同 path、同四色（蓝底 #3186FF + 绿/红/黄 多色光晕渐变）。矢量，放大不糊。
  // 转场十字星、问候页星标、模型行星标、头像都用它 → 与主页图标无缝统一。
  let { size = 64, glow = false } = $props();
  const PATH = 'M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z';
  const uid = 'gsp' + (++_seq);
</script>

<svg class="g-sparkle" class:glow viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
  <defs>
    <linearGradient id="{uid}-0" gradientUnits="userSpaceOnUse" x1="7" x2="11" y1="15.5" y2="12"><stop stop-color="#08B962" /><stop offset="1" stop-color="#08B962" stop-opacity="0" /></linearGradient>
    <linearGradient id="{uid}-1" gradientUnits="userSpaceOnUse" x1="8" x2="11.5" y1="5.5" y2="11"><stop stop-color="#F94543" /><stop offset="1" stop-color="#F94543" stop-opacity="0" /></linearGradient>
    <linearGradient id="{uid}-2" gradientUnits="userSpaceOnUse" x1="3.5" x2="17.5" y1="13.5" y2="12"><stop stop-color="#FABC12" /><stop offset=".46" stop-color="#FABC12" stop-opacity="0" /></linearGradient>
  </defs>
  <path d={PATH} fill="#3186FF" />
  <path d={PATH} fill="url(#{uid}-0)" />
  <path d={PATH} fill="url(#{uid}-1)" />
  <path d={PATH} fill="url(#{uid}-2)" />
</svg>

<style>
  .g-sparkle { display: block; }
  .g-sparkle.glow { filter: drop-shadow(0 2px 13px rgba(49, 134, 255, .3)); }
</style>
