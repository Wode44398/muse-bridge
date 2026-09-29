<script>
  // 全 app 唯一一层「跟手的那一份」。挂在 App 根部（不在任何带 transform 的容器里），
  // 所以 position:fixed 恒以视口为准——工作空间页整页拖、工作台侧栏里拖、拖着走去 Claude
  // 会话页，画的都是这同一张卡片，不会随宿主换坐标系。
  // pointer-events:none 是硬要求：命中判定走 elementFromPoint，卡片挡在手指底下就永远只命中它自己。
  //
  // 三段动画（iOS 同款）：起拖从原位「抬起来」（--ox/--oy 是原位中心相对手指的偏移）；
  // 落进落点＝缩进它的中心；取消＝飞回原位。后两段靠 phase 切类 + left/top/transform 过渡，
  // 拖着的时候不挂 left/top 过渡（否则跟手有拖影）。
  import { drag, dndToast } from '../lib/dragdrop.svelte.js';
  import { tr } from '../lib/i18n.js';

  const BASE = import.meta.env.BASE_URL;
</script>

{#if drag.on}
  <div class="dnd-layer" aria-hidden="true">
    <div class="dnd-card" class:over={!!drag.overKey && !drag.phase} class:drop={drag.phase === 'drop'} class:cancel={drag.phase === 'cancel'}
      style="left:{drag.x}px; top:{drag.y}px; --ox:{drag.ox}px; --oy:{drag.oy}px">
      {#if drag.count > 2}<span class="dnd-under u2"></span>{/if}
      {#if drag.count > 1}<span class="dnd-under u1"></span>{/if}
      <span class="dnd-ic">
        {#if drag.thumb}
          <img src={drag.thumb} alt="" draggable="false" />
        {:else if drag.isDir}
          <img src="{BASE}assets/icons/workspace.png" alt="" draggable="false" />
        {:else if drag.iconHtml}
          {@html drag.iconHtml}
        {:else}
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"><path d="M6 3.5h7l5 5V20a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M13 3.5v5h5"/></svg>
        {/if}
      </span>
      <span class="dnd-nm">{drag.name}</span>
      {#if drag.count > 1}<span class="dnd-n">{drag.count}</span>{/if}
      {#if drag.overKey && !drag.phase}
        <span class="dnd-badge" class:send={drag.effect === 'send'} class:copy={drag.effect === 'copy'}>
          {#if drag.effect === 'send'}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M6 11l6-6 6 6"/></svg>
          {:else if drag.effect === 'copy'}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"><path d="M12 5.5v13M5.5 12h13"/></svg>
          {:else}
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 7l5 5-5 5"/></svg>
          {/if}
        </span>
      {/if}
      {#if drag.springKey && !drag.phase}
        <!-- 弹簧倒计时：一圈画满＝这个文件夹要打开了 -->
        <svg class="dnd-spring" viewBox="0 0 24 24" style="--spring-ms:{drag.springMs}ms"><circle cx="12" cy="12" r="9.5" /></svg>
      {/if}
    </div>
    {#if drag.overLabel && !drag.phase}
      <div class="dnd-hint" style="left:{drag.x}px; top:{drag.y}px">{drag.overLabel}</div>
    {/if}
  </div>
{/if}

<!-- 落地反馈：结局常常发生在拖源已经卸载的页面上，只能由本层端出来 -->
{#if dndToast.msg}
  <div class="dnd-toast" aria-live="polite">{tr(dndToast.msg)}</div>
{/if}

<style>
  .dnd-layer { position: fixed; inset: 0; z-index: 4000; pointer-events: none; }

  /* 卡片刻意做成「浅色实体」而不是跟随主题：它要同时压在浅色的工作空间页和深色的 Claude
     会话页上都读得出来，跟主题走反而两头不讨好。 */
  .dnd-card {
    position: absolute; transform: translate(-50%, calc(-50% - 22px)) scale(1);
    display: flex; align-items: center; gap: 8px; max-width: 62vw;
    padding: 7px 12px 7px 8px; border-radius: 13px;
    background: rgba(255, 255, 255, .94); color: #1d1d1f;
    box-shadow: 0 10px 30px rgba(0, 0, 0, .28), 0 1px 0 rgba(255, 255, 255, .7) inset;
    backdrop-filter: blur(14px) saturate(150%); -webkit-backdrop-filter: blur(14px) saturate(150%);
    animation: dndLift .24s cubic-bezier(.2, .9, .3, 1.25);
    transition: transform .12s ease, box-shadow .12s ease;
    will-change: left, top;
  }
  .dnd-card.over { transform: translate(-50%, calc(-50% - 22px)) scale(1.045); box-shadow: 0 14px 38px rgba(0, 0, 0, .34); }
  /* 从原位抬起来：--ox/--oy 把卡片先摆回原位中心，再弹到手指上方 */
  @keyframes dndLift {
    from { transform: translate(calc(-50% + var(--ox, 0px)), calc(-50% + var(--oy, 0px))) scale(.86); opacity: .55; box-shadow: 0 2px 6px rgba(0, 0, 0, .12); }
  }
  /* 落进落点：缩进去、淡掉；取消：飞回原位。left/top 只在这两段挂过渡。 */
  .dnd-card.drop, .dnd-card.cancel { animation: none; transition: left .22s cubic-bezier(.3, .7, .2, 1), top .22s cubic-bezier(.3, .7, .2, 1), transform .22s cubic-bezier(.3, .7, .2, 1), opacity .2s ease .04s; }
  .dnd-card.drop { transform: translate(-50%, -50%) scale(.22); opacity: 0; }
  .dnd-card.cancel { transform: translate(-50%, -50%) scale(.72); opacity: 0; }

  /* 叠放：后面再垫两张，像 iOS 一样歪着露个角 */
  .dnd-under { position: absolute; inset: 0; border-radius: 13px; background: rgba(255, 255, 255, .88); box-shadow: 0 6px 20px rgba(0, 0, 0, .18); z-index: -1; }
  .dnd-under.u1 { transform: translate(5px, 6px) rotate(3deg); }
  .dnd-under.u2 { transform: translate(-4px, 11px) rotate(-4deg); opacity: .85; }

  .dnd-ic { width: 26px; height: 26px; flex: none; display: flex; align-items: center; justify-content: center; color: #007aff; }
  .dnd-ic img { width: 100%; height: 100%; object-fit: cover; border-radius: 5px; }
  .dnd-ic :global(svg) { width: 100%; height: 100%; }
  .dnd-nm { font: 500 13.5px/1.2 -apple-system, 'Segoe UI', 'Microsoft YaHei UI', sans-serif; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .dnd-n { flex: none; min-width: 19px; height: 19px; padding: 0 5px; border-radius: 10px; background: #ff383c; color: #fff;
    font: 700 11.5px/19px -apple-system, sans-serif; text-align: center; }
  .dnd-badge { position: absolute; right: -7px; bottom: -7px; width: 21px; height: 21px; border-radius: 50%;
    display: grid; place-items: center; background: #0088ff; color: #fff; box-shadow: 0 2px 7px rgba(0, 0, 0, .3); }
  .dnd-badge.send { background: #c96442; }
  .dnd-badge.copy { background: #34c759; }
  .dnd-badge svg { width: 12px; height: 12px; }

  /* 弹簧倒计时环：stroke-dashoffset 从整圈走到 0，时长与 SPRING_MS 同步 */
  .dnd-spring { position: absolute; left: -9px; top: -9px; width: 22px; height: 22px; transform: rotate(-90deg); }
  .dnd-spring circle { fill: rgba(255, 255, 255, .95); stroke: #0088ff; stroke-width: 2.6; stroke-linecap: round;
    stroke-dasharray: 59.7; stroke-dashoffset: 59.7; animation: dndSpring var(--spring-ms, 650ms) linear forwards; }
  @keyframes dndSpring { to { stroke-dashoffset: 0; } }

  .dnd-hint {
    position: absolute; transform: translate(-50%, 16px); max-width: 70vw;
    padding: 4px 11px; border-radius: 20px; background: rgba(20, 20, 22, .82); color: #fff;
    font: 500 11.5px/1.5 -apple-system, 'Segoe UI', 'Microsoft YaHei UI', sans-serif;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    animation: dndHint .16s ease;
  }
  @keyframes dndHint { from { opacity: 0; transform: translate(-50%, 22px); } }

  .dnd-toast {
    position: fixed; left: 50%; bottom: calc(var(--sab, 0px) + 92px); transform: translateX(-50%);
    z-index: 4001; pointer-events: none; max-width: 82vw;
    padding: 9px 16px; border-radius: 22px; background: rgba(20, 20, 22, .88); color: #fff;
    font: 500 13px/1.4 -apple-system, 'Segoe UI', 'Microsoft YaHei UI', sans-serif;
    box-shadow: 0 8px 26px rgba(0, 0, 0, .3); text-align: center;
    animation: dndToastIn .2s cubic-bezier(.2, .9, .3, 1.2);
  }
  @keyframes dndToastIn { from { opacity: 0; transform: translate(-50%, 10px); } }
</style>
