<script>
  // 设置 · 安卓 app。app 是个 WebView 壳（源码在 android/），界面就是这个网页，随服务器更新；
  // apk 随每个版本的安装包一起装到服务器上（/download/MuseBridge.apk），也挂在 GitHub Release 上。
  //   在 app 里打开设置：显示 app 版本、「更换服务器地址」（交给原生面板），服务器上的 apk 更新时给下载。
  //   在安卓浏览器里：下载 + 「在 app 里打开」（intent 把当前地址带进 app，没装就落到下载）。
  //   在电脑上：二维码，手机扫了直接下载。
  import { api } from '../../lib/api.js';
  import { qrSvg } from '../../lib/pair.js';
  import SSection from './SSection.svelte';
  import SRow from './SRow.svelte';
  import SButton from './SButton.svelte';
  import { t } from '../../lib/i18n.js';

  const GITHUB_RELEASES = 'https://github.com/Wode44398/muse-bridge/releases/latest';
  const app = typeof window !== 'undefined' ? window.MuseBridgeApp : null;
  const ua = navigator.userAgent || '';
  const android = /Android/i.test(ua);
  const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);

  let info = $state(null);      // /api/app/android
  let qr = $state('');
  api.get('/api/app/android').then((r) => { info = r; }).catch(() => { info = { available: false }; });

  const appVer = (() => { try { return app ? String(app.versionName() || '') : ''; } catch { return ''; } })();
  const appCode = (() => { try { return app ? Number(app.versionCode()) || 0 : 0; } catch { return 0; } })();

  // 服务器上的包（新装的 Muse 一定有）优先；从源码跑的没有，就用 GitHub 的
  const apkUrl = $derived(info?.available ? new URL(info.url, location.origin).href : (info?.github || ''));
  const meta = $derived.by(() => {
    if (!info?.available) return t('从 GitHub 下载最新版');
    const kb = Math.max(1, Math.round((info.size || 0) / 1024));
    return info.versionName ? t('版本 {v} · {kb} KB', { v: info.versionName, kb }) : `${kb} KB`;
  });
  const hasUpdate = $derived(!!app && !!info?.available && info.versionCode > appCode && appCode > 0);

  // 电脑上：生成下载地址的二维码
  $effect(() => {
    if (app || android || ios || !apkUrl) return;
    let dead = false;
    qrSvg(apkUrl).then((s) => { if (!dead) qr = s; }).catch(() => {});
    return () => { dead = true; };
  });

  function download() { if (apkUrl) location.href = apkUrl; }
  function openGithub() { window.open(GITHUB_RELEASES, '_blank', 'noopener'); }
  // 安卓 Chrome 认 intent:// ——装了 app 就把当前地址带进去，没装就照 fallback 去下载
  function openInApp() {
    const fb = apkUrl ? `S.browser_fallback_url=${encodeURIComponent(apkUrl)};` : '';
    location.href = `intent://open?server=${encodeURIComponent(location.origin)}#Intent;scheme=musebridge;package=com.musebridge.app;${fb}end`;
  }
  function changeServer() { try { app?.changeServer(); } catch {} }
</script>

{#if app}
  <SSection title={t('这台手机')}>
    <SRow label={t('安卓 app')} desc={t('界面由服务器提供，服务器更新后这里自动就是新版')} sid="android-app">
      {#snippet trailing()}<span class="val">{appVer || '—'}</span>{/snippet}
    </SRow>
    <SRow label={t('服务器地址')} desc={t('临时地址变了，或者想连另一台 Muse，在这里换')} sid="android-server">
      {#snippet trailing()}<SButton onclick={changeServer}>{t('更换')}</SButton>{/snippet}
    </SRow>
    {#if hasUpdate}
      <SRow label={t('app 有新版本')} desc={meta} sid="android-update">
        {#snippet trailing()}<SButton variant="primary" onclick={download}>{t('下载')}</SButton>{/snippet}
      </SRow>
    {/if}
  </SSection>
{:else}
  <SSection title={t('安卓 app')}
    foot={t('app 只是把这个网页装进一个独立窗口：从桌面图标直接打开、记住服务器地址，临时地址变了可以在 app 里直接换。界面和网页版完全一样，随服务器自动更新。')}>
    <SRow label={t('下载 apk')} desc={meta} sid="android-download">
      {#snippet trailing()}<SButton variant="primary" disabled={!info} onclick={download}>{t('下载')}</SButton>{/snippet}
    </SRow>
    {#if android}
      <SRow label={t('在 app 里打开')} desc={t('装好之后点这里，app 会自动填好现在这个地址')} sid="android-open">
        {#snippet trailing()}<SButton onclick={openInApp}>{t('打开')}</SButton>{/snippet}
      </SRow>
    {/if}
    <SRow label={t('GitHub 发布页')} desc={t('每个版本的 apk 也都挂在这里')} sid="android-github">
      {#snippet trailing()}<SButton onclick={openGithub}>{t('打开')}</SButton>{/snippet}
    </SRow>
  </SSection>

  {#if qr}
    <SSection title={t('用手机扫码下载')}>
      <div class="qr-row st-row">
        <div class="qr" aria-label={t('下载二维码')}>{@html qr}</div>
        <p class="qr-tx">{t('用安卓手机的相机或浏览器扫这个码，直接下载安装包。装好打开后，把这个网页的地址粘进去即可。')}</p>
      </div>
    </SSection>
  {/if}

  <SSection title={t('安装提示')}>
    <ol class="steps">
      <li>{t('下载后点通知栏里的安装包。手机提示「禁止安装未知来源应用」时，按提示允许浏览器安装应用。')}</li>
      <li>{t('第一次打开会问服务器地址：粘贴 Muse 给你的网址，或回到这一页点「在 app 里打开」。')}</li>
      <li>{t('用访问令牌或账号登录一次，之后打开 app 就直接进来。')}</li>
    </ol>
    {#if ios}<p class="note">{t('目前只有安卓版。iPhone 上可以用 Safari 的「分享 → 添加到主屏幕」，效果相近。')}</p>{/if}
  </SSection>
{/if}

<style>
  .val { font-size: 14px; color: var(--st-text2); white-space: nowrap; font-variant-numeric: tabular-nums; }
  .qr-row { display: flex; align-items: center; gap: 20px; padding: 12px 0; }
  .qr { flex: none; width: 132px; height: 132px; padding: 10px; border-radius: 12px; background: #fff;
    box-shadow: 0 0 0 1px var(--st-line); box-sizing: border-box; }
  .qr :global(svg) { display: block; width: 100%; height: 100%; }
  .qr-tx { margin: 0; font-size: 14px; line-height: 21px; color: var(--st-muted); }
  .steps { margin: 0; padding: 12px 0 12px 20px; display: flex; flex-direction: column; gap: 8px;
    font-size: 14px; line-height: 21px; color: var(--st-text2); }
  .note { margin: 0 0 12px; font-size: 13px; line-height: 19px; color: var(--st-muted); }
  :global(.stg.compact) .qr-row { gap: 14px; }
</style>
