// 代码块「复制」按钮的事件委托（feed 容器上挂一次）。从 markdown.ts 挪出来：那边是纯函数（服务端测试也直接导入它），
// 这里要碰 DOM 与剪贴板。
import { t } from "./i18n.ts";

export function handleCopyClick(e: Event): boolean {
  const btn = (e.target as HTMLElement)?.closest?.("[data-copy]") as HTMLElement | null;
  if (!btn) return false;
  const pre = btn.closest(".cb")?.querySelector("pre code");
  if (pre?.textContent != null) {
    navigator.clipboard?.writeText(pre.textContent).then(() => {
      btn.textContent = t("已复制");
      setTimeout(() => (btn.textContent = t("复制")), 1400);
    });
  }
  return true;
}
