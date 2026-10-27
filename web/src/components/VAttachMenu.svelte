<script>
  // 「+」素材来源菜单：工作空间 / 手机存储（Gemini 设计语言，底部动作单，g-* 变量自适应明暗）。
  import { t } from '../lib/i18n.js';
  let { onWorkspace, onDevice, onClose } = $props();
</script>

<div class="am-mask" onclick={onClose} role="presentation">
  <div class="am-sheet" onclick={(e) => e.stopPropagation()} role="presentation">
    <button class="am-opt" onclick={onWorkspace}>
      <span class="am-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h3.6l2 2.4h7.4A2.5 2.5 0 0 1 21 9.9v6.6a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 16.5v-9Z"/></svg></span>
      <span class="am-lb">{t('工作空间')}<small>{t('从云端文件里选图片')}</small></span>
    </button>
    <button class="am-opt" onclick={onDevice}>
      <span class="am-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="6.5" y="2.5" width="11" height="19" rx="2.6"/><path d="M10.5 18.5h3"/></svg></span>
      <span class="am-lb">{t('手机存储')}<small>{t('从手机相册 / 文件选')}</small></span>
    </button>
    <button class="am-cancel" onclick={onClose}>{t('取消')}</button>
  </div>
</div>

<style>
  .am-mask { position: fixed; inset: 0; z-index: 72; background: rgba(0,0,0,.4); display: flex; align-items: flex-end; justify-content: center; animation: amfade .2s; }
  @keyframes amfade { from { opacity: 0; } to { opacity: 1; } }
  .am-sheet { width: 100%; max-width: 480px; background: var(--g-bright); border-radius: 22px 22px 0 0; padding: 12px 12px max(12px, var(--sab)); box-shadow: 0 -10px 40px rgba(0,0,0,.25); animation: amup .26s cubic-bezier(.22,1,.36,1); }
  @keyframes amup { from { transform: translateY(100%); } to { transform: none; } }
  .am-opt { width: 100%; display: flex; align-items: center; gap: 14px; padding: 12px; border-radius: 14px; color: var(--g-on); text-align: left; }
  .am-opt:active { background: var(--g-hover); }
  .am-ic { width: 42px; height: 42px; border-radius: 12px; background: var(--g-dim); display: flex; align-items: center; justify-content: center; flex: none; color: var(--g-on); }
  .am-ic svg { width: 23px; height: 23px; }
  .am-lb { display: flex; flex-direction: column; gap: 2px; font-size: 16px; font-weight: 500; }
  .am-lb small { font-size: 12.5px; color: var(--g-on-variant); font-weight: 400; }
  .am-cancel { width: 100%; margin-top: 6px; padding: 13px; border-radius: 14px; font-size: 16px; font-weight: 600; color: var(--g-on); background: var(--g-dim); }
  .am-cancel:active { filter: brightness(.96); }
</style>
