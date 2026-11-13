<script>
  // 模型中心 › 本机图像模型（2026-11-13 统一入口）：Media Studio 的内置媒体服务（dialect 'local'），不用地址和 Key。
  // 数据仍存在 Studio，这里经 POST /api/model-hub/builtin 改启停、共享给成员、哪些模型打开。
  // 挂在 HubOverlays 的浮层外框里（标题栏、关闭、未保存确认归外框）；令牌（--st-* / --pm-*）由外框定义。版式照 HubVertex。
  import SToggle from '../settings/SToggle.svelte';
  import BuiltinModels from './BuiltinModels.svelte';
  import { hubPost } from '../../lib/modelHub.svelte.js';
  import { cp, loadProviders, canUseCustomApi } from '../../lib/claudeProviders.svelte.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { t } from '../../lib/i18n.js';

  let { builtin, onClose, dirtyOut = $bindable(false) } = $props();

  // 打开时取一次快照：保存后总览重拉，这张面板随即关掉
  const b0 = builtin;
  if (!cp.ok && canUseCustomApi()) loadProviders();
  let enabled = $state(b0.enabled !== false);
  let shared = $state(b0.shared === true);
  let on = $state(Object.fromEntries((b0.models || []).map((m) => [m.id, m.enabled !== false])));
  let saving = $state(false);
  let err = $state('');

  const snap = () => JSON.stringify({ enabled, shared, on });
  const base = snap();
  $effect(() => { dirtyOut = snap() !== base; });

  async function save() {
    if (saving) return;
    saving = true; err = '';
    try {
      await hubPost('builtin', { id: b0.id, enabled, models: on, ...(cp.canShare ? { shared } : {}) });
      dirtyOut = false; showToast(t('已保存')); onClose?.();
    } catch (e) { err = e.message || t('没保存上'); }
    saving = false;
  }
</script>

<div class="body">
  <p class="hint">{t('在这台服务器上本地生成图像，不用地址和 Key。打开的模型会出现在 Media Studio 里。')}</p>
  <div class="togs">
    <label class="tog">
      <span class="tog-l">{t('启用')}</span>
      <SToggle checked={enabled} onchange={(v) => (enabled = v)} label={t('启用 {name}', { name: b0.name })} />
    </label>
    {#if cp.canShare}
      <label class="tog">
        <span class="tog-l">{t('共享给成员')}</span>
        <SToggle checked={shared} onchange={(v) => (shared = v)} label={t('共享给成员')} />
      </label>
    {/if}
  </div>
  <BuiltinModels models={b0.models || []} bind:on />
</div>

<footer class="bar">
  {#if err}<span class="err">{err}</span>{/if}
  <span class="sp"></span>
  <button type="button" class="btn primary" class:busy={saving} disabled={saving || !dirtyOut} onclick={save}>{saving ? t('保存中…') : t('保存')}</button>
</footer>

<style>
  .body { flex: 1; min-height: 0; overflow-y: auto; padding: 22px 28px 28px; display: flex; flex-direction: column; gap: 22px; }
  .hint { margin: 0 2px; font-size: 12.5px; line-height: 1.5; color: var(--st-muted); }
  .togs { display: flex; flex-wrap: wrap; gap: 8px 28px; }
  .tog { align-self: flex-start; display: flex; align-items: center; gap: 12px; min-height: 36px; cursor: pointer; }
  .tog-l { font-size: 13.5px; color: var(--text); user-select: none; -webkit-user-select: none; }
  .bar { flex: none; display: flex; align-items: center; gap: 10px; padding: 12px 20px calc(12px + var(--sab, 0px)); border-top: 1px solid var(--st-hair); }
  .sp { flex: 1; }
  .err { flex: 1 1 auto; min-width: 0; font-size: 13px; color: var(--pm-red); }
  .err + .sp { display: none; }
  .btn { display: inline-flex; align-items: center; justify-content: center; min-width: 76px; height: 34px; padding: 0 16px; border: 0; border-radius: 10px;
    background: var(--st-seg); color: var(--text); font: inherit; font-size: 14px; font-weight: 500; white-space: nowrap; cursor: pointer;
    transition: transform var(--mo-tap, 90ms) var(--ea-std, ease), background-color var(--mo-micro, 140ms) var(--ea-fade, ease), opacity var(--mo-micro, 140ms) var(--ea-fade, ease); }
  .btn.primary { background: var(--st-primary); color: var(--st-primary-ink); }
  @media (hover: hover) { .btn.primary:hover:not(:disabled) { opacity: .88; } }
  .btn.primary:disabled { background: var(--st-seg); color: var(--st-muted); cursor: default; }
  .btn.primary.busy:disabled { background: var(--st-primary); color: var(--st-primary-ink); opacity: .72; }
  .btn:focus-visible { outline: none; box-shadow: 0 0 0 2px var(--st-surface), 0 0 0 4px color-mix(in srgb, var(--text) 55%, transparent); }
  .btn:active:not(:disabled) { transform: scale(.96); }
  @media (max-width: 699px) {
    .body { padding: 10px 16px 24px; gap: 20px; }
    .hint { margin: 0 4px; }
    .togs { flex-direction: column; gap: 4px; }
    .tog { align-self: stretch; justify-content: space-between; min-height: 44px; padding: 0 4px; cursor: default; }
    .tog-l { font-size: 15px; }
    .btn { height: 44px; border-radius: 14px; font-size: 15px; }
    .bar .btn { flex: 1; }
  }
  @media (prefers-reduced-motion: reduce) { .btn { transition: none; } .btn:active:not(:disabled) { transform: none; } }
</style>
