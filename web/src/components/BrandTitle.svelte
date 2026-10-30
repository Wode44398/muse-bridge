<script>
  // 持久的「THE BRIDGE」品牌标题——全程只此一个，不重复。封面态（预载等加载 / 主题转场回中）
  // 时居中；预载方块放大 or 转场 expand 时启程移到左上角，之后稳定留在左上（主页可见；
  // claude/其它分页及入场转场时隐藏）。「THE」对齐用 transform 平滑过渡，不靠 align-items 瞬切。
  import { onMount } from 'svelte';
  import { ui } from '../lib/state.svelte.js';
  import { switchHomeTheme } from '../lib/homeTheme.js';
  import { t } from '../lib/i18n.js';
  import { brandWords } from '../lib/distro.js';
  import { arrival } from '../lib/serverSwitch.js';
  import { canSwitchServers } from '../lib/serverProfiles.js';
  // 两行字随发行版品牌走（本体「THE / BRIDGE」，Muse Bridge 是「MUSE / BRIDGE」）
  const [W1, W2] = brandWords();

  let mounted = $state(false);
  let theEl, bridgeEl, rootEl, shiftEm = $state(0);
  // 标题居中＝预载封面驻留（等加载）；预载一进 expand 即启程回左上原位。
  // （主题换场不再把标题请回中央：新版换场从标题这一点铺开，标题就是波的源头，留在原位。）
  const atCenter = $derived(!ui.booted && ui.preloadPhase === 'cover');
  const atCornerPos = $derived(mounted && !atCenter);  // 标题在左上（THE 左对齐）还是 中央（THE 居中）
  // 标题颜色 = 当前主题色：flux(A)=白 / 风景(B)=黑。封面态也对：A 黑方块→白字、B 白方块→黑字。
  // 换场时新旧两种颜色分别在新旧快照里，由转场本身过渡，这里不必提前变色。
  const titleColor = $derived(ui.glassMode === 'B' ? '#0a0a0a' : '#ffffff');
  // 入场转场期间标题随主页一起留在主页快照里退后，不必单独隐藏。
  // 切换服务器的转场里，标题由转场封面里的那一份接手（lib/serverSwitch.js）
  const visible = $derived(mounted && (!ui.booted || ui.screen === 'home') && !ui.settingsOpen && !ui.serverSwitching);
  // 长按标题 = 切换服务器（手机 App 的多服务器档案）；长按触发后吞掉随之而来的那次点击，不换壁纸
  let lpTimer = 0, lpFired = false, lpX = 0, lpY = 0;
  function lpDown(e) {
    lpFired = false;
    if (!canSwitchServers() || !ui.booted) return;
    lpX = e.clientX; lpY = e.clientY;
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => { lpFired = true; try { navigator.vibrate?.(12); } catch {} ui.serverSwitcherOpen = true; }, 480);
  }
  const lpCancel = () => clearTimeout(lpTimer);
  const lpMove = (e) => { if (Math.hypot(e.clientX - lpX, e.clientY - lpY) > 10) clearTimeout(lpTimer); };
  const toggle = () => { if (lpFired) { lpFired = false; return; } switchHomeTheme(rootEl); };

  // 「THE」居中位移量：用一个隐藏的「居中态」探针(26px / letter-spacing .2em) 测 THE、BRIDGE 宽度算得，
  // 而不是用当前 DOM(主页是左上态 14px / .14em)——后者字号、字距比例都不同，测出的值有偏差(iOS 字体渲染下
  // 尤其明显，会让标题平移没到位/过头)。探针独立于当前态，主页/封面/转场任何时候测都得到稳定准确的位移。
  function measure() {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;font-family:var(--serif-stack);font-weight:300;font-size:26px;letter-spacing:.2em;';
    const a = document.createElement('span'); a.textContent = W1;
    const b = document.createElement('span'); b.textContent = W2;
    probe.append(a, b); document.body.appendChild(probe);
    shiftEm = (b.offsetWidth - a.offsetWidth) / 2 / 26;   // /26 → em；transform 用 shiftEm*26 还原成居中态像素
    probe.remove();
  }
  onMount(() => {
    requestAnimationFrame(() => { mounted = true; measure(); });
    [40, 150, 400, 900].forEach((ms) => setTimeout(measure, ms));      // 多量几次，确保 shiftEm 早早就位
    if (document.fonts?.ready) document.fonts.ready.then(measure);    // 衬线字体加载后再精量一次
  });
</script>

<div class="brand" class:corner={atCornerPos} class:show={visible} class:tappable={visible} class:arrive={!!arrival} bind:this={rootEl}
     style:color={titleColor}
     onclick={toggle}
     onpointerdown={lpDown} onpointerup={lpCancel} onpointercancel={lpCancel} onpointerleave={lpCancel} onpointermove={lpMove}
     oncontextmenu={(e) => { if (canSwitchServers()) e.preventDefault(); }}
     onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
     role="button" tabindex="0" aria-label={t('切换壁纸主题')}
     title={t('点击切换壁纸 / 玻璃方案')}>
  <span class="l1" bind:this={theEl} style:transform="translateX({atCornerPos ? 0 : shiftEm * 26}px)">{W1}</span><span bind:this={bridgeEl}>{W2}</span>
</div>

<style>
  .brand {
    position: fixed; z-index: 210; pointer-events: none; color: #fff; opacity: 0;
    font-family: var(--serif-stack); font-weight: 300; display: flex; flex-direction: column;
    top: 50%; left: 50%; transform: translate(-50%, -50%); align-items: flex-start;
    font-size: 26px; line-height: 1.16; letter-spacing: .2em; gap: 1px; padding-left: .2em;
    text-shadow: 0 1px 10px rgba(0,0,0,.5);
    /* 归位飞行与预载方块展开【同时长同曲线】才读作一个动作（此前 .82s vs 现在的方块
       420ms，标题会孤零零地继续飞半秒）。全部走运动令牌。 */
    transition: top var(--mo-page) var(--ea-decel), left var(--mo-page) var(--ea-decel),
                transform var(--mo-page) var(--ea-decel), font-size var(--mo-page) var(--ea-decel),
                letter-spacing var(--mo-page) var(--ea-decel), gap var(--mo-page) var(--ea-decel),
                padding-left var(--mo-page) var(--ea-decel),
                opacity var(--mo-base) var(--ea-fade), color var(--mo-hero) var(--ea-fade);
  }
  .brand.show { opacity: 1; }
  /* 切换服务器重载来的：新品牌在封面方块中央逐行显影（接上一页旧品牌的化开，见 lib/serverSwitch.js） */
  .brand.arrive > span { animation: brand-arrive 620ms cubic-bezier(.05,.7,.1,1) both; }
  .brand.arrive > span + span { animation-delay: 90ms; }
  @keyframes brand-arrive { from { opacity: 0; translate: 0 .5em; filter: blur(7px); } to { opacity: 1; translate: 0 0; filter: blur(0); } }
  .brand.tappable { pointer-events: auto; cursor: pointer; }
  /* 桌面：可点的标题得有悬停反馈，否则鼠标划过完全看不出这里能按（手机没鼠标所以一直没做）。
     注意别在这里写 transition —— .brand 那条长 transition 是「居中→左上」的飞入动画，
     被同等或更高特异性的规则整条替换掉飞入就变瞬移了。 */
  @media (hover: hover) {
    .brand.tappable.corner:hover { text-shadow: 0 1px 14px rgba(255,255,255,.5), 0 1px 10px rgba(0,0,0,.5); }
  }
  /* 「THE」左对齐↔居中用 transform 平滑过渡（替代 align-items 瞬切），与标题移动/缩放同步 */
  .l1 { display: inline-block; transition: transform var(--mo-page) var(--ea-decel); }
  .brand.corner {
    top: max(16px, var(--sat)); left: 18px; transform: none;
    font-size: 14px; letter-spacing: .14em; gap: 0; padding-left: 0;
  }
</style>
