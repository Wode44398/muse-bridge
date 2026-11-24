<!-- Claude 页·舞台：空态落地页（问候 + 用量卡 + 输入框）/ 对话态（转录滚动区 + 悬浮输入栏与其上方各横条 + 会话信息面板）。 -->
<script>
  // Claude 聊天分页（从 App.svelte 抽出，原样保留已实测通过的流式/工具/历史/明暗主题/
  // AskUserQuestion/gen_media/动态工作流/侧边栏等）。顶层启动加载与路由现在归 App.svelte。
  import { fade, fly } from 'svelte/transition';
  import { sendComposer, receiveComposer, softDrop } from '../../../lib/transitions.js';
  import Composer from '../../Composer.svelte';
  import WorkspaceChips from '../../WorkspaceChips.svelte';
  import Thread from '../../Thread.svelte';
  import ClaudeLogo from '../../ClaudeLogo.svelte';
  import RefusalBand from '../RefusalBand.svelte';
  import PermissionCard from '../PermissionCard.svelte';   // 逐次工具审批卡（输入框上方停靠）
  import QueueBar from '../QueueBar.svelte';
  import PeerHoldBand from '../PeerHoldBand.svelte';
  import McpAuthBand from '../McpAuthBand.svelte';
  import LandingTexture from '../LandingTexture.svelte';
  import SessionRail from '../SessionRail.svelte';
  import CodeStatsCard from '../CodeStatsCard.svelte';
  import { me, ui, session, settings } from '../../../lib/state.svelte.js';
  import { switchPageTheme } from '../../../lib/homeTheme.js';
  import { mountDrag } from '../../../lib/capsule.js';
  import { IS_CSNAP } from '../../../lib/csnap.js';
  import { t, tc } from '../../../lib/i18n.js';
  import ArchivedBand from '../ArchivedBand.svelte';
  // 新对话入口 + 临时对话（原「快照」）按时间回收（S1-6，2026-10-22）
  import TempChatBand from '../TempChatBand.svelte';
  import { usePage } from '../../../lib/claudePage/context.js';
  import { touchGuard } from '../../../lib/selection.js';

  const pc = usePage();
  const { saveCurQuick, onScroll, onWheel, onTouchStart, onTouchEnd, keepCurQuick } = pc;

  // 官方 /code 落地页问候（cc43287c9 nz，What’s up next, {name}?）
  const greetName = $derived(me.user ? t('{name}，接下来做什么？', { name: me.user }) : t('接下来做什么？'));
</script>
<div class="stage">
{#if ui.view === 'greeting'}
  <!-- 空态 = Claude 桌面端 /code 落地页：左上问候 + 用量卡（claude/CodeStatsCard），输入框沉到底部——
       位置、外边距与聊天态 .composer-wrap/.composer-inner 完全一致（只挪位置、样式不动），
       发出第一条时 crossfade 两端几何相同，输入框原地不跳。 -->
  <main class="hero">
    <!-- 官方 Code 空态的字符风背景（LandingTextureLayer 移植）：只在空会话里，离开空态随 .hero 一起卸载 -->
    {#if !IS_CSNAP}<LandingTexture />{/if}
    <div class="hero-scroll">
      <div class="hero-col">
        <div class="greeting">
          <span class="logo-fly" use:mountDrag={{ config: () => ({ kind: 'new', model: settings.model, effort: settings.effort }) }} in:fade={{ duration: 420, delay: 80 }} out:fly={{ x: -80, y: -22, duration: 320, easing: softDrop }}><ClaudeLogo anim="static" size={24} interactive onpress={switchPageTheme} /></span>
          <h1 in:fly={{ y: 22, duration: 480, delay: 130 }} out:fade={{ duration: 150 }}>{greetName}</h1>
        </div>
        {#if !IS_CSNAP}
          <div class="hero-stats" in:fly={{ y: 24, duration: 520, delay: 170 }} out:fade={{ duration: 120 }}><CodeStatsCard /></div>
        {/if}
      </div>
    </div>
    <div class="hero-foot">
      <!-- 归属状态栏（目录/分支/worktree）：刻意放在 crossfade 元素【外面】——
           .hero-composer 与 .composer-inner 是同一 key 的形变两端，塞进去会让两端盒子
           内容不等、形变歪掉。故两处都做成输入框的前置兄弟。 -->
      {#if pc.showChips}
        <div class="hero-chips" in:fly={{ y: 30, duration: 540, delay: 190 }} out:fade={{ duration: 120 }}><WorkspaceChips name={pc.dockName} armable={!session.id} /></div>
      {:else if pc.curQuick}
        <!-- 只有文件的那种（orphanBlank）已经在倒计时，也能直接存为工作空间；全新的空白临时对话只说规矩 -->
        <div class="hero-chips" in:fly={{ y: 30, duration: 540, delay: 190 }} out:fade={{ duration: 120 }}><TempChatBand days={pc.curQuickDays} policy={pc.quickPol} canSave={pc.orphanBlank} busy={pc.quickBusy} onSave={saveCurQuick} /></div>
      {/if}
      <div class="hero-composer" in:fly={{ y: 30, duration: 540, delay: 210 }} out:sendComposer={{ key: 'composer' }}><Composer /></div>
    </div>
  </main>
{:else}
  <!-- 首尾两条渐隐带 = claude.ai /code 转录滚动区原件（app.css .scroll-fade-strip-*）：sticky + 负 margin
       不占位，不改 scrollHeight，onScroll/atBottom 的粘底判定不受影响；尺寸与底带钉位见下方 .scroll 规则。 -->
  <div class="scroll" bind:this={pc.scrollEl} use:touchGuard onscroll={onScroll} onwheel={onWheel} ontouchstart={onTouchStart} ontouchend={onTouchEnd} ontouchcancel={onTouchEnd}>
    <div class="scroll-fade-strip-top" aria-hidden="true"></div>
    <Thread />
    <div class="scroll-fade-strip-bottom" aria-hidden="true"></div>
  </div>
  <div class="composer-wrap" bind:this={pc.composerWrapEl}>
    {#if pc.showChips}
      <!-- foot = 滚到底才显形。直接复用 atBottom（粘底判定）作单一真相：它同时决定「新内容
           要不要跟着滚」，两件事本就是同一个「人在不在底部」。另立紧阈值反而会在正文
           延后加载撑高后卡在离底几十像素、芯片打不开。class: 指令写法编译器认得，样式不会被剪。 -->
      <div class="chips-slot" class:foot={pc.atBottom}><WorkspaceChips name={pc.dockName} /></div>
    {:else if pc.curQuick}
      <div class="chips-slot" class:foot={pc.atBottom}><TempChatBand days={pc.curQuickDays} policy={pc.quickPol} canSave={!!session.id && !pc.curQuickWarn} busy={pc.quickBusy} onSave={saveCurQuick} /></div>
    {/if}
    <!-- 临时对话快到清理的时候（S1-6）：同 aux band 槽位，不受「滚到底才显形」约束 -->
    {#if pc.curQuickWarn}<div class="band-slot"><TempChatBand mode="warn" days={pc.curQuickDays} canSave busy={pc.quickBusy} onSave={saveCurQuick} onKeep={keepCurQuick} /></div>{/if}
    <!-- 安全栅门回退横条（官方 /code 输入框上方 aux band：Switched to X · Why? · Edit prompt and retry）：
         与归属芯片同层、同宽同轴，同样放在 crossfade 元素（.composer-inner）【外面】（理由同上：
         形变两端盒子内容必须相等）。芯片规矩一并适用——底必须不透明 + 上缘渐隐罩（正文从悬浮
         输入栏底下穿过）；但它不受「滚到底才显形」约束：这是一条要人处理的通知，不是装饰。
         高度随内容进 .composer-wrap 的 ResizeObserver 量进 --composer-h，滚动区底衬自动加高。 -->
    <div class="band-slot"><RefusalBand sessionId={session.id} /></div>
    <!-- 逐次工具审批卡（官方 dock 形态）：同槽位规矩，没卡时整槽收起 -->
    {#if !IS_CSNAP}<div class="band-slot"><PermissionCard sessionId={session.id} /></div>{/if}
    <!-- 排队消息栏（官方 QueuedMessageBar：输入框正上方，与提示条同层）：同样放在 crossfade 元素外面 -->
    {#if !IS_CSNAP}<div class="band-slot"><QueueBar /></div>{/if}
    <!-- 「此会话已归档」横条（官方同款）：同层、同理放在 crossfade 元素外面 -->
    {#if !IS_CSNAP}<div class="band-slot"><ArchivedBand sessionId={session.id} /></div>{/if}
    <!-- 其它 Claude 会话（Desktop / 终端）发来、等你确认的消息（session-peers.mjs，设置「暂存等我确认」） -->
    {#if !IS_CSNAP}<div class="band-slot"><PeerHoldBand /></div>{/if}
    <!-- 这一轮报了 needs-auth 的远程连接器：一键授权（lib/mcpAuth.svelte.js） -->
    {#if !IS_CSNAP}<div class="band-slot"><McpAuthBand sessionId={session.id} /></div>{/if}
    <div class="composer-inner" bind:this={pc.composerInnerEl} in:receiveComposer={{ key: 'composer' }} out:sendComposer={{ key: 'composer' }}><Composer placeholder={tc('claude', '发消息…')} /></div>
  </div>
  <!-- 会话信息面板（官方 Session rail）：停靠在舞台右侧 / 窄时弹层，开关在右上角工具条第一颗 -->
  {#if !IS_CSNAP}<SessionRail name={pc.dockName} path={pc.dockWs} />{/if}
{/if}
</div>

<style>
  .stage { flex: 1; position: relative; min-height: 0; display: flex; flex-direction: column; }
  /* 空态（官方 /code 落地页）：上半区可滚（问候 + 用量卡），底部是输入框。
     edge-to-edge 后页面顶到物理屏顶，顶距要再加状态栏高度（--sat）。 */
  .hero { position: absolute; inset: 0; display: flex; flex-direction: column; }
  .hero > .hero-scroll, .hero > .hero-foot { position: relative; z-index: 1; }
  .hero-scroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch;
    padding: calc(clamp(60px, 11vh, 112px) + var(--sat)) 16px 24px; }
  /* 与输入框卡片同一根轴（760 列、左缘对齐）：问候和卡片贴列左缘，官方同款 */
  .hero-col { max-width: 760px; margin: 0 auto; display: flex; flex-direction: column; align-items: flex-start; gap: 24px; }
  /* 官方问候（cc43287c9 nz）：22px 星芒 + text-title 22/28、常规字重（wght 360）、主文字色 */
  .greeting { display: flex; align-items: center; gap: 8px; }
  .logo-fly { display: inline-flex; flex: none; }
  .greeting h1 { font-family: var(--sans); font-weight: 400; font-size: 22px; line-height: 28px; color: var(--text); margin: 0; }
  .hero-stats { width: 100%; max-width: 480px; background: var(--bg); border-radius: 8px; }   /* 卡片自身是 5% 半透明底：垫一层页面底色，背后的字符风不透上来（观感与原来一样） */
  /* 底部输入区 = 聊天态 .composer-wrap 的几何（6/8/安全区 内边距、760 居中），只是放在文档流里不悬浮 */
  .hero-foot { flex: none; padding: 6px 8px max(10px, var(--sab)); }
  .hero-composer { max-width: 760px; margin: 0 auto; }
  /* 归属状态栏两处的对齐槽：与输入框卡片同宽同轴（.composer-wrap 整层 pointer-events:none，
     故聊天态这一槽要自己把事件收回来，否则芯片点不动）。 */
  .hero-chips { max-width: 760px; margin: 0 auto; }
  /* 聊天态的归属芯片只在【滚到底】时显形：不动布局，只淡入 + 6px 上浮。
     高度恒占着（--composer-h 不变），所以显隐不会改滚动区内边距、不会在底部抖一下。
     transform 常驻（收起态也写 translateY(0) 而非 none）——保证 .chips-slot 始终是层叠
     上下文，::before 那层渐隐罩的绘制顺序不会在过渡中途翻。
     双向过渡：位移走 --ea-std，透明度走 --ea-fade（运动令牌见 app.css）。 */
  .chips-slot {
    position: relative; max-width: 760px; margin: 0 auto;
    opacity: 0; transform: translateY(6px); pointer-events: none;
    transition: opacity var(--mo-quick) var(--ea-fade), transform var(--mo-quick) var(--ea-std);
  }
  .chips-slot.foot { opacity: 1; transform: translateY(0); pointer-events: auto; }
  /* 芯片是几条窄胶囊，挡不住整行正文——正文从悬浮输入栏下方穿过时，会有残字从芯片旁边
     露出来。补一层向上渐隐到页底色的薄罩把正文先化掉（官方在芯片行与输入框之间也垫了
     一层同作用的 pointer-events:none 元素）。z-index:-1 只退到 .composer-wrap 这个
     层叠上下文的底，仍盖在滚动区之上。 */
  .chips-slot::before {
    content: ''; position: absolute; left: -8px; right: -8px; top: -26px; bottom: -4px;
    /* 渐隐段用绝对长度收在芯片【上方】：到芯片顶边（距罩顶 26px）就已经是纯 --bg，
       芯片那一带整条实心，正文残字不会再从胶囊缝里冒出来。 */
    background: linear-gradient(to bottom, transparent 0, var(--bg) 26px);
    pointer-events: none; z-index: -1;
  }
  /* 回退横条的槽：RefusalBand 没东西可显时自己什么都不渲染 → 槽随之 display:none（不占那 6px
     堆叠间距、::before 罩也不留在输入卡上方）。底必须不透明——横条本身只有 4% 的底色（官方 --t1），
     不垫页底色就会透出从输入栏底下穿过的残字；同芯片再补一层向上渐隐的薄罩，最下 6px 实心，
     正好盖住与归属芯片之间的堆叠间距。z-index:-1 退到 .composer-wrap 这个层叠上下文的底、仍盖着滚动区。 */
  .band-slot { position: relative; max-width: 760px; margin: 0 auto; pointer-events: auto;
    background: var(--bg); border-radius: 10px; }
  .band-slot:not(:has(:global(*))) { display: none; }
  .chips-slot + .band-slot { margin-top: 6px; }
  .band-slot::before { content: ''; position: absolute; left: -8px; right: -8px; top: -26px; bottom: 0;
    background: linear-gradient(to bottom, transparent 0, var(--bg) 20px); pointer-events: none; z-index: -1; }

  /* 滚动区吃满整个 stage；底部留出卡片高度（+8px 呼吸），最后一条消息能滚到卡片上方 */
  /* overflow-x 必须显式 hidden：只写 overflow-y:auto 时 CSS 会把另一根轴算成 auto，
     于是任何一处超宽内容（宽表格、长公式、宽卡片）都能把【整条会话】变成可左右拖的画布。
     超宽内容各自在自己身上横滚（见 Thread 里 pre / table 的规则），这里只做兜底闸。 */
  .scroll { flex: 1; overflow-y: auto; overflow-x: hidden; -webkit-overflow-scrolling: touch; padding-bottom: calc(var(--composer-h, 84px) + 8px); }
  /* 官方 /code 转录渐隐尺寸：顶带 32px、底带 48px（桌面原值）。底带要钉在输入卡片上沿——官方是
     scroller 高 100%+On、strip bottom:On；这里等价物是 .scroll 的 padding-bottom（= 卡片高 + 8），而
     Chromium 的 sticky 约束框已经扣掉滚动容器自身的 padding（实测 bottom 写成卡片高会离卡片再高一个
     卡片高，2026-09-11 无头 Edge 量出 244 = 2×122），所以底带 bottom:0 就正好落在卡片上沿；滚到底时
     带子的静态位置也在这条线上，钉住与不钉住无缝衔接。
     手机端官方那两档占屏太宽（32/48 在 6 寸屏上吃掉近一行正文），收到 18/28；断点与 layout.svelte.js 的
     compact(<700) 同源。 */
  /* 顶带桌面端加长并下移（维护者 09-23）：32 → 52px，头上先垫 --sf-lead 12px 实色再开始官方那段梯度，
     渐隐起点等于整体下移 12px、渐隐段本身 40px（原 32）。不用 top 偏移去「挪」——那样带子上方会漏出一条
     正文。实色头正好把标题栏带（WCO 40px 拖拽区）的上半截衬成一块干净底，拖拽区看得出来。 */
  .scroll { --sf-top: 52px; --sf-lead: 12px; --sf-bottom: 48px; --scroll-fade-color: var(--bg); }
  .scroll > .scroll-fade-strip-top { --scroll-fade-size: var(--sf-top);
    background: linear-gradient(to bottom,
      var(--scroll-fade-color) var(--sf-lead),
      color-mix(in srgb, var(--scroll-fade-color) 85%, transparent) calc(var(--sf-lead) + (100% - var(--sf-lead)) * .13),
      color-mix(in srgb, var(--scroll-fade-color) 50%, transparent) calc(var(--sf-lead) + (100% - var(--sf-lead)) * .40),
      color-mix(in srgb, var(--scroll-fade-color) 15%, transparent) calc(var(--sf-lead) + (100% - var(--sf-lead)) * .70),
      transparent); }
  /* 底带钉到【卡片】上沿而不是底衬边缘：底衬 = 整个 wrap 高（含透明的芯片槽），卡片顶到 wrap 底只有
     --composer-card-top，差值用负 bottom 补回去（sticky 负偏移合法）。没量到时两者相等 → bottom:0。 */
  /* 再减 10px：底衬比卡片高出的 8px「呼吸」留白本来落在带子和卡片之间，那一条正文完全没被盖——
     手机上（带子只 28px）就是一道亮缝（维护者 09-11 第三张截图）。带子下沿压到卡片上沿下方 2px，
     被卡片（z-index 更高）盖住，实底与卡片无缝相接。 */
  .scroll > .scroll-fade-strip-bottom { --scroll-fade-size: var(--sf-bottom); bottom: calc(var(--composer-card-top, var(--composer-h, 84px)) - var(--composer-h, 84px) - 10px); }
  @media (max-width: 599px), (max-width: 699px) and (max-device-aspect-ratio: 699/1000) { .scroll { --sf-top: 18px; --sf-lead: 0px; --sf-bottom: 28px; } }
  /* 桌面壳 WCO：Electron 在窗口内沿留 5px 拉伸热区（系统层命中、先于页面），工作台收起时正文滚动区
     贴着窗口右沿，官方款原生滚动条（槽 10px、拇指离右沿 ~3px）有一半拇指落进热区、一按变成拖窗口。
     原生滚动条画在边框内侧，右边垫 4px 透明边框整条推进来，拇指离窗口右沿 ≥7px。--sb-w 量的是
     offsetWidth-clientWidth，自动算上这 4px，输入栏照旧让开滚动条列。 */
  :global(html[data-wco="1"]) .scroll, :global(html[data-wco="1"]) .hero-scroll { border-right: 4px solid transparent; }
  /* 输入栏卡片：绝对定位悬浮在正文之上，无实心背景/隔层——正文向上滚时从卡片下方穿过 */
  .composer-wrap { position: absolute; left: 0; right: var(--sb-w, 0px); bottom: 0; z-index: 5;
    padding: 6px 8px max(10px, var(--sab)); background: transparent; pointer-events: none; }
  /* 卡片【下方】那段底部留白（手机手势条安全区可达 30–40px）是透明的：正文从卡片底边和屏幕底之间
     透出来（维护者 09-11 截图第二处）。垫一层页底色，再往上盖住卡片下半段（卡片圆角外的缝也一并封住）；
     z-index:-1 退到 .composer-wrap 这个层叠上下文的底，仍在滚动区之上。 */
  .composer-wrap::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0;
    height: calc(max(10px, var(--sab)) + 28px); background: var(--bg); pointer-events: none; z-index: -1; }
  .composer-inner { max-width: 760px; margin: 0 auto; pointer-events: auto; }


</style>
