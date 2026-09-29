<script>
  // 设置 · 关于：界面由服务器直接提供，刷新页面即是服务器上的版本，这里没有「下载 / 安装」这一步。
  import { t } from '../../lib/i18n.js';
</script>

<div class="hero" data-sid="about">
  <img class="logo" src="{import.meta.env.BASE_URL}icons/icon-192.png" alt="" />
  <div class="hero-tx">
    <div class="hero-name">Muse Bridge</div>
    <div class="hero-ver">{t('网页版 · 界面由服务器直接提供，刷新页面即是最新')}</div>
  </div>
</div>

<p class="about">{t('在浏览器里使用 Claude Code 与 dimensio：多用户登录、按人授权、工作空间文件管理与服务端控制台。')}</p>

<style>
  .hero { display: flex; align-items: center; gap: 14px; margin: 0 0 20px; }
  .logo { width: 52px; height: 52px; border-radius: 12px; flex: none; box-shadow: 0 0 0 1px var(--st-line); }
  .hero-tx { min-width: 0; display: flex; flex-direction: column; gap: 3px; }
  .hero-name { font-family: var(--serif-stack); font-size: 20px; line-height: 26px; color: var(--text); }
  .hero-ver { font-size: 13px; color: var(--st-muted); }
  .about { margin: 0; font-size: 14px; line-height: 22px; color: var(--st-text2); }
  :global(.stg.compact) .hero { margin: 4px 4px 18px; }
  :global(.stg.compact) .about { margin: 0 4px; }
</style>
