<script>
  // 应用级改名框（lib/renamePrompt.js 的 askRename 挂到 document.body）：层级压过全屏查看器（.vw-root 300）
  // 与工作空间页面里自己的弹层，所以查看器溢出菜单 / F2 的「重命名」不必先关查看器。
  // 两种外观与 DialogHost 同口径：触屏 → iOS 27 玻璃警告框 + 文本框；鼠标 → 墨与象牙扁平卡片。
  // 打开时选中主名（不含扩展名，同 Finder / iOS 文件），回车确认、Esc / 系统返回取消；
  // 名字没变按取消处理；含斜杠（正反都算）当场提示，不交给服务端报错。
  // 期间捕获全部按键（不阻止默认输入），底下查看器的 F2 / Delete / 方向键 / 空格不会被触发。
  import { onMount, setContext, untrack } from 'svelte';
  import Alert from './ios27/Alert.svelte';
  import TextField from './ios27/TextField.svelte';
  import './ios27/ink.css';
  import { pushBackLayer } from '../lib/nav.js';
  import { pressable } from '../lib/motion.js';
  import { t } from '../lib/i18n.js';

  let { name = '', title = '', touch = false, dark = true, isDir = false, onDone } = $props();

  let value = $state(untrack(() => name));   // 只取打开时的旧名作初值，之后由输入框接管
  let error = $state('');
  let closing = $state(false);
  let rootEl = $state(null);
  setContext('ios27', { get dark() { return dark; }, ink: true });

  const heading = $derived(title || t('重命名'));
  let settled = false;
  function finish(result) {
    if (settled) return;
    settled = true;
    closing = true;
    // 退场动画（--mo-quick）播完再卸载；减弱动效时 CSS 动画被压成 0，等待也随之很短
    const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => onDone?.(result), reduce ? 0 : 200);
  }
  function confirm() {
    const next = String(value || '').trim();
    if (!next || next === name) { finish(null); return; }
    if (/[\\/]/.test(next)) { error = t('名称里不能有斜杠'); return; }
    finish(next);
  }

  // 选中主名：文件夹全选；文件选到最后一个点之前（「.bashrc」这种点开头的整段选中）
  function selectStem() {
    const input = rootEl?.querySelector('input');
    if (!input) return;
    try {
      input.focus({ preventScroll: true });
      const dot = isDir ? -1 : value.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : value.length);
    } catch {}
  }

  onMount(() => {
    // TextField 自己在 280ms 时聚焦；这里稍晚一点再选中主名，两者不打架
    const timer = setTimeout(selectStem, touch ? 320 : 30);
    const onKey = (e) => {
      if (settled) return;
      e.stopImmediatePropagation();
      if (e.key === 'Escape') { e.preventDefault(); finish(null); }
      else if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); confirm(); }
    };
    const onUp = (e) => { if (!settled) e.stopImmediatePropagation(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onUp, true);
    const popBack = pushBackLayer(() => finish(null));
    return () => {
      clearTimeout(timer);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onUp, true);
      popBack();
    };
  });
</script>

<div class="rp-root i27ink" class:dark class:closing bind:this={rootEl} role="presentation" data-rename-prompt>
  {#if touch}
    <Alert title={heading} {error} {closing} onclose={() => finish(null)}
      actions={[{ label: t('确定'), role: 'default', onclick: confirm }, { label: t('取消'), role: 'cancel', onclick: () => finish(null) }]}>
      <TextField bind:value oninput={() => (error = '')} autocapitalize="off" autocorrect="off" spellcheck="false" autofocus />
    </Alert>
  {:else}
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <div class="rp-scrim ov-scrim" class:closing onclick={() => finish(null)}></div>
    <div class="rp-card ov-panel" class:closing role="dialog" aria-modal="true" aria-label={heading}>
      <div class="rp-title">{heading}</div>
      <input class="rp-input" bind:value oninput={() => (error = '')} autocapitalize="off" autocorrect="off" spellcheck="false" aria-label={heading} />
      {#if error}<div class="rp-err">{error}</div>{/if}
      <div class="rp-acts">
        <button type="button" class="rp-btn" use:pressable onclick={() => finish(null)}>{t('取消')}</button>
        <button type="button" class="rp-btn primary" use:pressable onclick={confirm}>{t('确定')}</button>
      </div>
    </div>
  {/if}
</div>

<style>
  /* 令牌同 DialogHost 的「墨与象牙」；层级 3400：压过查看器 300、菜单 1000，低于全局对话框 3500（改名撞名时的提示要在它上面） */
  .rp-root {
    --rp-surface: #fcfbf8; --rp-text: #1d1b18; --rp-muted: rgba(29, 27, 24, .5);
    --rp-line: rgba(29, 27, 24, .1); --rp-field: rgba(29, 27, 24, .045); --rp-seg: rgba(29, 27, 24, .06);
    --rp-sel: rgba(29, 27, 24, .08); --rp-primary: #1d1b18; --rp-primary-ink: #f6f3ec; --rp-red: #c4473b;
    --rp-shadow: 0 24px 70px rgba(24, 21, 17, .2), 0 2px 8px rgba(24, 21, 17, .08);
    position: fixed; inset: 0; z-index: 3400;
    display: grid; place-items: center; padding: 24px;
    font-family: var(--sans, system-ui, sans-serif); color: var(--rp-text);
    -webkit-tap-highlight-color: transparent;
  }
  .rp-root.dark {
    --rp-surface: #1a1917; --rp-text: #f1ece2; --rp-muted: rgba(241, 236, 226, .5);
    --rp-line: rgba(241, 236, 226, .1); --rp-field: rgba(241, 236, 226, .06); --rp-seg: rgba(241, 236, 226, .07);
    --rp-sel: rgba(241, 236, 226, .1); --rp-primary: #ebe5d8; --rp-primary-ink: #151412; --rp-red: #e2725f;
    --rp-shadow: 0 24px 70px rgba(0, 0, 0, .45), 0 2px 8px rgba(0, 0, 0, .25);
  }
  .rp-root.closing { pointer-events: none; }
  /* 玻璃框自己是 fixed 根（z 90），在本层的层叠上下文里照样居中 */
  .rp-scrim { position: absolute; inset: 0; background: rgba(0, 0, 0, .42); }
  .rp-card {
    position: relative; width: min(380px, 100%); box-sizing: border-box;
    padding: 20px 22px 18px; display: flex; flex-direction: column; gap: 12px;
    background: var(--rp-surface); border: 1px solid var(--rp-line); border-radius: 16px; box-shadow: var(--rp-shadow);
  }
  .rp-title { font-size: 15px; line-height: 22px; font-weight: 600; }
  .rp-input {
    height: 34px; padding: 0 10px; border: 1px solid var(--rp-line); border-radius: 8px; outline: none;
    background: var(--rp-field); color: var(--rp-text); font: inherit; font-size: 14px;
  }
  .rp-input:focus { border-color: color-mix(in srgb, var(--rp-text) 40%, transparent); }
  .rp-err { margin-top: -4px; font-size: 12.5px; line-height: 18px; color: var(--rp-red); }
  .rp-acts { display: flex; justify-content: flex-end; gap: 8px; margin-top: 4px; }
  .rp-btn {
    min-width: 76px; height: 32px; padding: 0 16px; border: 0; border-radius: 9px; cursor: pointer;
    font: inherit; font-size: 14px; font-weight: 500; color: var(--rp-text); background: var(--rp-seg);
    transform: scale(var(--press-s, 1));
    transition: background-color var(--mo-micro) var(--ea-fade), opacity var(--mo-micro) var(--ea-fade);
  }
  .rp-btn:hover { background: var(--rp-sel); }
  .rp-btn.primary { color: var(--rp-primary-ink); background: var(--rp-primary); }
  .rp-btn.primary:hover { opacity: .9; }
  .rp-btn:focus-visible { outline: 2px solid color-mix(in srgb, var(--rp-text) 55%, transparent); outline-offset: 2px; }
</style>
