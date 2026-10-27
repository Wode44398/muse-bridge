<script>
  // 桌面壳 frameless+WCO 时的窗口 chrome 层：
  //   ① 顶部整宽拖拽区（-webkit-app-region:drag，Chromium 按几何并集计算，
  //      与 z-index/pointer-events 无关；顶带内的交互元素必须逐个打 no-drag 洞）；
  //   ② 窗控按钮配色随页面/主题同步（主页深壁纸→白 glyph、浅→深 glyph）；
  //   ③ html[data-wco] 标记：全局 CSS 据此给顶带内既有元素（品牌标/登录 pill）
  //      打免拖标记与避让。
  // 非 WCO 环境（网页/安卓/旧壳/系统边框）：active=false，整组件零渲染零副作用。
  import { ui } from '../../lib/state.svelte.js';
  import { isNativeDesktop } from '../../lib/nativeDesktop.js';
  import { wcoActive, wcoHeight, setOverlayColors } from './wco.svelte.js';

  const active = wcoActive();

  // 桌面通用快捷键：Ctrl/⌘+, 开关设置（任何分页都生效；焦点在输入框里不抢，
  // 编辑器类组件可能自己绑了这个组合）。手机/网页没有 BridgeDesktop，整段不挂。
  function onAppKey(e) {
    if (!isNativeDesktop()) return;
    if (e.key !== ',' || !(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    e.preventDefault();
    ui.settingsOpen = !ui.settingsOpen;
  }
  const h = $derived(wcoHeight());   // geometrychange 驱动（早期 rect 可能还是 0）

  $effect(() => {
    if (!active) return;
    document.documentElement.dataset.wco = '1';
    return () => { delete document.documentElement.dataset.wco; };
  });

  // 窗控 glyph 颜色：主页跟壁纸方案（A=flux 深色壁纸→白；B=风景浅→深），
  // 其余页面跟明暗主题。底色恒透明——按钮条悬浮在页面之上，不压一条色带。
  // 同时把窗口 backgroundColor 交给壳：拖边改窗口大小时新露出的那一条由它填，
  // 壳里写死的浅色在暗色主题下每次缩放都闪一道白边。
  // 分页自报的 chrome 配色优先（ui.pageChrome，dimensio 分页有独立明暗档）：
  // 否则 glyph 按 bridge 主题刷，dimensio 浅底 + bridge 深色主题时三颗窗控钮是白的，
  // 落在白底上根本看不见。
  $effect(() => {
    if (!active) return;
    const page = ui.screen !== 'home' ? ui.pageChrome : null;
    const dark = page ? page.dark : ui.screen === 'home' ? ui.glassMode !== 'B' : ui.theme === 'dark';
    let bg = dark ? '#1f1f1e' : '#f8f8f6';
    try {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
      if (/^#[0-9a-f]{6}$/i.test(v)) bg = v;
    } catch {}
    if (page?.bg) bg = page.bg;
    if (ui.screen === 'home') bg = dark ? '#0a0a0a' : '#f8f8f6';   // 主页底是壁纸，跟 --bg 无关
    setOverlayColors({ color: '#00000000', symbolColor: dark ? '#ffffff' : '#1f1f1e', bg });
  });
</script>

<svelte:window onkeydown={onAppKey} />

{#if active}
  <div class="drag" style:height="{h}px" aria-hidden="true"></div>
{/if}

<style>
  .drag {
    position: fixed; top: 0; left: 0; right: 0; z-index: 5;
    -webkit-app-region: drag; pointer-events: none;
  }
  /* 顶带内既有交互元素的免拖洞（属性门控：data-wco 只在 WCO 壳里出现，
     手机/网页永不匹配，规则零成本）。 */
  :global(html[data-wco="1"] .brand),
  :global(html[data-wco="1"] .plabel),
  :global(html[data-wco="1"] .card),
  :global(html[data-wco="1"] .card-bd) {
    -webkit-app-region: no-drag;
  }
</style>
