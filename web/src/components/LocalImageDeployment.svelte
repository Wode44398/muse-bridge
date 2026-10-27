<script>
  import { onMount } from 'svelte';
  import { api } from '../lib/api.js';
  import { t, tr } from '../lib/i18n.js';
  let status = $state(null), error = $state(''), working = $state(false), loaded = $state(false);
  let dtype = $state('bfloat16'), offload = $state('model'), vaeTiling = $state(true), vaeTileSize = $state(256), tf32 = $state(true), cpuThreads = $state(8);
  const stateName = $derived(status?.state === 'ready' ? t('已就绪') : status?.state === 'starting' ? t('正在加载模型') : status?.state === 'busy' ? t('正在生成图片') : status?.state === 'error' ? t('启动失败') : t('未运行'));
  const locked = $derived(working || status?.state === 'busy' || status?.state === 'starting');
  const dirty = $derived(loaded && (dtype !== status?.settings?.dtype || offload !== status?.settings?.offload || vaeTiling !== status?.settings?.vaeTiling || vaeTileSize !== (status?.settings?.vaeTileSize ?? 256) || tf32 !== (status?.settings?.tf32 ?? true) || cpuThreads !== (status?.settings?.cpuThreads ?? 8)));
  function receive(next) {
    status = next;
    if (!loaded) { dtype = next.settings.dtype; offload = next.settings.offload; vaeTiling = next.settings.vaeTiling; vaeTileSize = next.settings.vaeTileSize ?? 256; tf32 = next.settings.tf32 ?? true; cpuThreads = next.settings.cpuThreads ?? 8; loaded = true; }
  }
  async function refresh() {
    try { receive(await api.get('/api/vertex/local-image/status')); }
    catch (e) { error = tr(e.body?.error || e.message); }
  }
  async function act(action) {
    working = true; error = '';
    try {
      const next = await api.post('/api/vertex/local-image/' + action, action === 'settings' ? { dtype, offload, vaeTiling, vaeTileSize, tf32, cpuThreads } : {});
      if (next.ok === false) throw new Error(next.error);
      receive(next);
    } catch (e) { error = tr(e.body?.error || e.message); }
    finally { working = false; }
  }
  onMount(() => {
    let alive = true, timer;
    async function poll() { await refresh(); if (alive) timer = setTimeout(poll, status?.state === 'starting' || status?.state === 'busy' ? 2000 : 5000); }
    poll();
    return () => { alive = false; clearTimeout(timer); };
  });
</script>

<div class="local-deployment">
  <div class="local-status"><span class="status-dot" class:ready={status?.state === 'ready'} class:loading={status?.state === 'starting' || status?.state === 'busy'}></span><b>{status ? stateName : t('正在检查部署')}</b><span>Qwen Image 2.1</span></div>
  {#if status?.gpu}<p class="muted">{status.gpu}</p>{/if}
  <div class="local-actions">
    {#if !status || status.state === 'off'}
      <button class="local-button primary" disabled={locked || !status?.installed} onclick={() => act('start')}>{t('启动模型')}</button>
    {:else}
      <button class="local-button" disabled={working || status.state === 'busy'} onclick={() => act('stop')}>{t('停止并释放显存')}</button>
    {/if}
    <span class="muted">{t('与本机对话模型共用显卡')}</span>
  </div>
  {#if status && !status.installed}<p class="error">{t('尚未安装模型或权重校验未完成')}</p>{/if}
  <div class="deploy-fields">
    <label><span>{t('计算精度')}</span><select bind:value={dtype} disabled={locked} aria-label={t('计算精度')}><option value="bfloat16">BF16</option><option value="float16">FP16</option></select></label>
    <label><span>{t('显存模式')}</span><select bind:value={offload} disabled={locked} aria-label={t('显存模式')}><option value="model">{t('均衡 · 按模型卸载')}</option><option value="sequential">{t('省显存 · 逐层卸载')}</option></select></label>
    <label class="tile"><span>{t('VAE 分块解码')}</span><input type="checkbox" bind:checked={vaeTiling} disabled={locked} /></label>
    {#if vaeTiling}<label><span>{t('VAE 分块尺寸')}</span><select bind:value={vaeTileSize} disabled={locked} aria-label={t('VAE 分块尺寸')}>{#each [256, 512, 768] as size}<option value={size}>{size} × {size}</option>{/each}</select></label><p class="muted">{t('小分块更省显存；大分块减少拼接次数，但显存峰值更高。默认 256，重叠比例为 25%。')}</p>{/if}
    <label class="tile"><span>{t('TF32 加速')}</span><input type="checkbox" bind:checked={tf32} disabled={locked} /></label>
    <p class="muted">{t('允许支持 TF32 的显卡加速 FP32 矩阵计算，不改变模型加载精度。')}</p>
    <label><span>{t('CPU 计算线程')}</span><input type="number" min="1" max="32" step="1" bind:value={cpuThreads} disabled={locked} /></label>
  </div>
  <p class="muted">{t('均衡模式适合 32GB 显卡；逐层卸载更省显存，但生成更慢。分块解码可降低大图的显存峰值。')}</p>
  <button class="local-button primary save" disabled={locked || !dirty} onclick={() => act('settings')}>{status?.state && status.state !== 'off' ? t('保存并重启模型') : t('保存部署参数')}</button>
  {#if error || status?.error}<p class="error" role="alert">{error || tr(status.error)}</p>{/if}
  {#if status}<details><summary>{t('部署位置')}</summary><p>{status.home}</p><p>{status.endpoint}</p></details>{/if}
</div>

<style>
  .local-deployment { display: grid; gap: 16px; font: inherit; color: inherit; min-width: 0; }
  .local-status { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 14px; }
  .local-status > span:last-child { margin-left: auto; opacity: .55; font-size: 12px; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; background: #8b8d91; }
  .status-dot.ready { background: #278853; } .status-dot.loading { background: #c18b22; }
  .local-actions { display: flex; flex-wrap: wrap; gap: 12px; align-items: center; }
  .local-button { font: inherit; font-size: 13px; padding: 11px 15px; min-height: 42px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 12px; background: transparent; color: inherit; cursor: pointer; }
  .primary { background: #313a33; color: #fff; border-color: transparent; }
  button:disabled { opacity: .4; cursor: default; }
  .deploy-fields { display: grid; gap: 14px; border-block: 1px solid color-mix(in srgb, currentColor 12%, transparent); padding-block: 16px; }
  label { display: grid; gap: 7px; font-size: 13px; }
  select, input[type=number] { box-sizing: border-box; width: 100%; min-width: 0; border-radius: 9px; border: 1px solid color-mix(in srgb, currentColor 18%, transparent); background: transparent; color: inherit; padding: 10px; font: inherit; }
  select option { background: var(--sur, #fff); color: var(--on, #252525); }
  .tile { display: flex; align-items: center; justify-content: space-between; min-height: 30px; }
  .tile input { width: 19px; height: 19px; accent-color: #427153; }
  p { margin: 0; } .muted { font-size: 12px; line-height: 1.7; opacity: .65; }
  .save { justify-self: start; } .error { color: #c15149; font-size: 13px; overflow-wrap: anywhere; }
  details { font-size: 12px; opacity: .6; overflow-wrap: anywhere; } details p { margin-top: 8px; }
</style>
