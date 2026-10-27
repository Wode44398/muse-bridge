<script>
  // antigravity / vertex / 工作空间 三个分页在新前端尚未重做的占位页。
  // 本轮主页四入口把 claude 接通；其余三个先落到这里，后续单独重做。
  import { ui } from '../lib/state.svelte.js';
  import { closePage } from '../lib/pageMorph.js';
  import { t } from '../lib/i18n.js';
  let { name } = $props();
  const NAMES = { antigravity: 'Antigravity', vertex: 'Vertex', files: t('工作空间') };
</script>

<div class="cs">
  <div class="cs-inner">
    <h2>{NAMES[name] || name}</h2>
    <p>{t('该分页正在重做中')}</p>
    <button onclick={() => closePage(ui.screen)}>{t('返回主页')}</button>
  </div>
</div>

<style>
  /* 占位分页此前是硬切（零动效），在一堆有转场的分页里格外显旧。给它全站统一的
     整页入场：底色先到位、内容带位移落定（--ea-decel 入场曲线）。 */
  .cs { position: fixed; inset: 0; background: var(--bg); display: flex; align-items: center; justify-content: center; z-index: 1;
        animation: cs-bg var(--mo-quick) var(--ea-fade) both; }
  @keyframes cs-bg { from { opacity: 0; } }
  .cs-inner { text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 24px;
              animation: cs-in var(--mo-base) var(--ea-decel) both; }
  @keyframes cs-in { from { opacity: 0; transform: translateY(12px) scale(.98); } }
  .cs-inner h2 { font-family: var(--serif-stack); font-weight: 400; font-size: 26px; color: var(--text); }
  .cs-inner p { color: var(--muted); font-size: 14px; }
  .cs-inner button { margin-top: 10px; padding: 11px 22px; border-radius: 22px; background: var(--card); color: var(--text); box-shadow: var(--card-shadow); font-size: 15px; }
  .cs-inner button { transition: transform var(--mo-tap) var(--ea-out), background var(--mo-micro) var(--ea-fade); }
  .cs-inner button:active { background: var(--hover); transform: scale(.96); }
</style>
