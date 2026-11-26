<script>
  // 桌面客户端的标题栏（只在 data-layout=wco 时显示，见 theme.css）：整条是窗口拖拽区，按钮不拖。
  // 左边：显示 / 隐藏侧栏，‹ › 在看过的线程之间来回（到头的那一边按不动）。右边让给系统窗口按钮（--wco-right）。
  import { t } from '../../lib/i18n.js';
  import { codex, goHistory } from '../../lib/codex/store.svelte.js';
  import { closePop } from '../../lib/codex/ui.svelte.js';
  import { historyEnds } from '../../lib/codex/chrome/logic.js';
  import Icon from './Icon.svelte';

  const ends = $derived(historyEnds(codex.history, codex.histAt));

  function go(step) {
    closePop();
    goHistory(step);
  }
</script>

<div class="cx-title">
  <button class="ibtn" title={t('显示 / 隐藏侧栏（Ctrl+B）')} aria-label={t('显示 / 隐藏侧栏')} aria-pressed={codex.sideOpen}
    onclick={() => { closePop(); codex.sideOpen = !codex.sideOpen; }}><Icon name="side" /></button>
  <button class="ibtn" title={t('上一个线程')} aria-label={t('上一个线程')} disabled={!ends.back} onclick={() => go(-1)}><Icon name="back" /></button>
  <button class="ibtn" title={t('下一个线程')} aria-label={t('下一个线程')} disabled={!ends.fwd} onclick={() => go(1)}><Icon name="fwd" /></button>
</div>
