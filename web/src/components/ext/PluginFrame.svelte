<script>
  // 插件页面的宿主（网页 / 桌面壳）：把插件 web/ 下的页面装进一个【不透明源】的 iframe——sandbox 不给 allow-same-origin，
  // 服务端还给插件页面加了 CSP sandbox 头（routes/plugins.mjs）。所以页面读不到主页面的 DOM、localStorage 里的令牌和 cookie，
  // 桌面壳的 BridgeDesktop 只进主帧、它也摸不到。原则：插件的信任止于服务器边界，碰不到使用者设备上的东西。
  //
  // 页面经 /plugins/_sdk/bridge-plugin.js 和这里对话（postMessage，{ bp: 1, type, … }）：
  //   hello → 回 init（主题、颜色变量、语言、平台）     resize → 撑高（只在嵌入模式）
  //   fetch → 宿主带自己的登录态代发，只放行 /api/plugin/<本插件>/ 下的路径     toast / confirm / open / back
  // 宿主往页面推：theme（切主题）、event（插件 ctx.bus.toPage 推的，以及 _status 状态块更新）。
  // 手机 App 不走这里：主 WebView 的原生桥注入所有帧，iframe 挡不住，改由原生另起干净 WebView（lib/pluginPanels openPluginStandalone）。
  import { onMount } from 'svelte';
  import { apiUrl } from '../../lib/server.js';
  import { authHeaders } from '../../lib/api.js';
  import { busOn } from '../../lib/bus.js';
  import { isEn, t } from '../../lib/i18n.js';
  import { showToast } from '../../lib/toast.svelte.js';
  import { uiConfirm } from '../../lib/dialogs.js';
  import { currentTheme, hostPlatform } from '../../lib/pluginPanels.svelte.js';

  // mode: 'embed'（嵌在插件详情里，高度跟内容走）| 'panel'（占满所在区域）
  let { id, page, mode = 'embed', onBack = null, minHeight = 120 } = $props();

  let frame = $state(null);
  let height = $state(0);
  let failed = $state(false);

  const MAX_BODY = 20 * 1024 * 1024;
  const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
  // 转发给接口的请求头只留无害的几个（凭据由宿主自己加）
  const PASS_HEADERS = /^(content-type|accept|x-[a-z0-9-]+)$/i;

  const src = $derived(apiUrl('/plugins/' + id + '/' + page) + '#' + new URLSearchParams({ theme: currentTheme(), mode, lang: isEn() ? 'en' : 'zh', platform: hostPlatform() }).toString());

  function themeVars() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n) => cs.getPropertyValue(n).trim();
    return {
      bg: v('--bg'), card: v('--card'), text: v('--text'), muted: v('--muted'), line: v('--divider'), hover: v('--hover'),
      accent: v('--st-accent'), brand: v('--coral'), ok: v('--ok'), warn: v('--warn'), crit: v('--crit'), field: v('--st-field'),
      radius: '12px',
    };
  }
  const post = (msg, transfer) => { try { frame?.contentWindow?.postMessage({ bp: 1, ...msg }, '*', transfer || []); } catch {} };
  const reply = (rid, value, error, transfer) => post({ type: 'reply', id: rid, value, ...(error ? { error } : {}) }, transfer);

  function cleanPath(p) {
    const s = String(p || '').replace(/^\/+/, '');
    if (!s && s !== '') return null;
    if (/^[a-z]+:/i.test(s) || s.includes('\\') || s.split(/[?#]/)[0].split('/').some((x) => x === '..' || x === '.')) return null;
    return s;
  }

  async function doFetch(m) {
    const rel = cleanPath(m.path);
    const method = String(m.method || 'GET').toUpperCase();
    if (rel == null || !METHODS.has(method)) return reply(m.id, null, t('请求不合法'));
    const body = m.body;
    if (body && (body.byteLength || body.length || 0) > MAX_BODY) return reply(m.id, null, t('请求体太大'));
    const headers = {};
    for (const [k, val] of Object.entries(m.headers || {})) if (PASS_HEADERS.test(k)) headers[k] = String(val);
    try {
      const res = await fetch(apiUrl('/api/plugin/' + id + '/' + rel), {
        method, headers: authHeaders(headers), body: method === 'GET' ? undefined : (body ?? undefined), credentials: 'same-origin',
      });
      const buf = await res.arrayBuffer();
      const h = {};
      for (const k of ['content-type', 'content-disposition', 'cache-control']) { const x = res.headers.get(k); if (x) h[k] = x; }
      reply(m.id, { status: res.status, headers: h, body: buf }, null, [buf]);
    } catch (e) {
      reply(m.id, null, String(e?.message || e || t('网络错误')));
    }
  }

  async function onMessage(e) {
    if (!frame || e.source !== frame.contentWindow) return;
    const m = e.data;
    if (!m || m.bp !== 1) return;
    switch (m.type) {
      case 'hello':
        failed = false;
        post({ type: 'init', theme: currentTheme(), vars: themeVars(), lang: isEn() ? 'en' : 'zh', platform: hostPlatform(), mode, user: null });
        break;
      case 'resize':
        if (mode === 'embed') height = Math.max(minHeight, Math.min(4000, Number(m.height) || minHeight));
        break;
      case 'fetch': doFetch(m); break;
      case 'toast': showToast(String(m.text || '').slice(0, 300), m.error ? 'err' : 'ok'); break;
      case 'confirm': {
        const ok = await uiConfirm(String(m.title || '').slice(0, 200) || t('确定吗？'), { detail: String(m.desc || '').slice(0, 500), okLabel: String(m.yes || '').slice(0, 20) || t('确定'), type: m.danger ? 'warning' : 'question' });
        reply(m.id, !!ok);
        break;
      }
      case 'open':
        if (/^https?:\/\//i.test(String(m.url || ''))) window.open(String(m.url), '_blank', 'noopener');
        break;
      case 'back': onBack?.(); break;
    }
  }

  onMount(() => {
    window.addEventListener('message', onMessage);
    const offBus = busOn((ev) => {
      if (ev?.type === 'plugin.event' && ev.plugin === id) post({ type: 'event', event: ev.event, payload: ev.payload });
      else if (ev?.type === 'plugins.status' && ev.id === id) post({ type: 'event', event: '_status', payload: ev.panelStatus });
    });
    const mo = new MutationObserver(() => post({ type: 'theme', theme: currentTheme(), vars: themeVars() }));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { window.removeEventListener('message', onMessage); offBus(); mo.disconnect(); };
  });
</script>

<div class="pf" class:panel={mode === 'panel'} style:height={mode === 'embed' ? Math.max(minHeight, height) + 'px' : null}>
  {#if failed}
    <p class="pf-err">{t('插件页面没加载出来')}</p>
  {/if}
  <!-- 不给 allow-same-origin：页面是不透明源 -->
  <iframe
    bind:this={frame}
    {src}
    title={id}
    sandbox="allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals"
    referrerpolicy="no-referrer"
    onerror={() => (failed = true)}
  ></iframe>
</div>

<style>
  .pf { position: relative; width: 100%; }
  .pf.panel { height: 100%; min-height: 360px; }
  iframe { display: block; width: 100%; height: 100%; border: 0; background: transparent; color-scheme: normal; }
  .pf-err { position: absolute; inset: 0; display: grid; place-items: center; margin: 0; color: var(--muted); font-size: 13px; }
</style>
