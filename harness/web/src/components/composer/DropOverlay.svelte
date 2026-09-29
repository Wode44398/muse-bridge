<script lang="ts">
  // 拖文件进窗口时的提示层：整屏、不接指针（drop 由 Composer 挂在 window 上的监听接住）。
  // 挪到 .hxroot 下渲染：三栏各自是层叠上下文，留在对话栏里的 fixed 会被工作区栏盖住；也不挂 body——嵌入 bridge 时
  // 主题令牌只在 .hxroot 上。不用 backdrop-filter（同屏多层时上层会静默失效）。
  import { fade, pop } from "../../lib/motion.ts";
  import Icon from "../ui/Icon.svelte";
  import { t } from "../../lib/i18n.ts";

  function portal(node: HTMLElement) {
    const root = node.closest(".hxroot") ?? document.querySelector(".hxroot");
    if (root && node.parentElement !== root) root.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }
</script>

<div class="drop" use:portal aria-hidden="true" transition:fade|global={{ duration: 160 }}>
  <div class="card" in:pop|global={{ from: 0.95 }}>
    <span class="ic"><Icon name="upload" size={26} stroke={1.6} /></span>
    <span class="t">{t("松开，添加为附件")}</span>
    <span class="s">{t("存进这个对话的附件目录（不进项目仓库）· 图片原生发给多模态模型")}</span>
  </div>
</div>

<style>
  .drop {
    position: fixed;
    inset: 0;
    z-index: 85;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    pointer-events: none;
    background: color-mix(in srgb, var(--bg) 72%, transparent);
  }
  .card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    max-width: 420px;
    padding: 26px 32px 24px;
    border-radius: 20px;
    background: var(--surface);
    box-shadow:
      0 0 0 1px var(--border),
      var(--shadow-3);
    text-align: center;
  }
  .ic {
    display: inline-flex;
    margin-bottom: 4px;
    color: var(--accent);
  }
  .t {
    font-size: var(--fs-lg);
    font-weight: 600;
    color: var(--text);
  }
  .s {
    font-size: var(--fs-sm);
    line-height: var(--lh-ui);
    color: var(--text3);
  }
</style>
