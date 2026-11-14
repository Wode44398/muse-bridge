<script>
  // 查看器内的 toast 出口（外框根里一份）：胶囊 13px、内距 8×16、圆角 999；媒体是半透明实底（不加 blur，
  // 压在视频上的 backdrop-filter 每帧都要重算），文档用 --md-toast-bg。位置在底栏上沿往上 12px（--vw-bottom）。
  // 进场纯 CSS 动画；退场挂 .leaving 播完再从列表摘掉（不用 Svelte transition：后台页 RAF 不跑会卡住）。
  // 全局 showToast（lib/toast.svelte.js）另走 App 根的 <Toast />，层级已提到查看器之上，两边都看得见。
  let { list = [] } = $props();
</script>

<div class="vw-toasts" aria-live="polite">
  {#each list as it (it.id)}
    <div class="vw-pill vw-toast" class:err={it.kind === 'err'} class:leaving={it.leaving} role="status">
      <span>{it.text}</span>
      {#if it.action}<button type="button" class="vw-toast-act" onclick={() => { it.action.onClick?.(); it.close?.(); }}>{it.action.label}</button>{/if}
    </div>
  {/each}
</div>
