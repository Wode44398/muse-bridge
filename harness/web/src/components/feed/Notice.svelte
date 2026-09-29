<script lang="ts">
  // 提示条：居中一行小字，两侧是带端点的细线——尺寸线母题（一根线 + 靠字那端一个小圆点），CSS 画，不用字符。
  // 「已停止」「上下文已压缩」「对话退回到这里 · 工作区文件没有回退」这类时间线上的刻度。
  import { tr } from "../../lib/i18n.ts";

  let { text }: { text: string } = $props();
</script>

<div class="notice" role="note">
  <span class="rule l" aria-hidden="true"></span>
  <span class="t">{tr(text)}</span>
  <span class="rule r" aria-hidden="true"></span>
</div>

<style>
  .notice {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 2px 0;
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--text3);
  }
  .t {
    min-width: 0;
    text-align: center;
  }
  .rule {
    flex: 0 1 112px;
    min-width: 18px;
    height: 5px;
  }
  .rule.l {
    background:
      radial-gradient(circle, var(--border2) 0 2px, transparent 2.6px) right center / 5px 5px no-repeat,
      linear-gradient(var(--border2), var(--border2)) left center / calc(100% - 5px) 1px no-repeat;
  }
  .rule.r {
    background:
      radial-gradient(circle, var(--border2) 0 2px, transparent 2.6px) left center / 5px 5px no-repeat,
      linear-gradient(var(--border2), var(--border2)) right center / calc(100% - 5px) 1px no-repeat;
  }
</style>
