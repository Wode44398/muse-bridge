<script>
  // 键位录制器：点一下进入录制态，直接按出想要的组合键即写入。
  // Esc 取消、Backspace/Delete 关掉这一条。
  //
  // 主键一律从 e.code 推（而不是 e.key）：e.key 会被输入法、键盘布局、以及 Shift
  // 本身改写（按 Shift+2 得到的是 '@' 而不是 '2'），拿它当键名会存进一个按不出来的键。
  import '../tokens.css';
  import { t } from '../../lib/i18n.js';

  let { accelerator = '', placeholder = t('未设置'), onrecord } = $props();

  let recording = $state(false);
  let btn;

  const CODE_MAP = {
    Space: 'Space', Enter: 'Return', NumpadEnter: 'Return', Tab: 'Tab',
    Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']',
    Backslash: '\\', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/',
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert',
  };

  function mainKey(e) {
    const code = e.code || '';
    if (/^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/.test(code)) return '';   // 只按了修饰键，继续等
    if (/^Key[A-Z]$/.test(code)) return code.slice(3);
    if (/^Digit[0-9]$/.test(code)) return code.slice(5);
    if (/^Numpad[0-9]$/.test(code)) return 'num' + code.slice(6);
    if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code;
    return CODE_MAP[code] || '';
  }

  function onKeydown(e) {
    e.preventDefault();
    // 必须掐断传播：设置页在 window 上听 Esc 关闭自己，录制里按 Esc 会连设置页一起关掉。
    // 挂在【捕获阶段的 document】上才拦得住 —— 两个都挂 window 时 stopPropagation 管不着
    // 同一目标上的其它监听器，谁先注册谁先跑。
    e.stopPropagation();
    if (e.code === 'Escape') { recording = false; return; }
    if (e.code === 'Backspace' || e.code === 'Delete') { recording = false; onrecord?.(''); return; }
    const key = mainKey(e);
    if (!key) return;
    const mods = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    recording = false;
    onrecord?.([...mods, key].join('+'));
  }

  $effect(() => {
    if (!recording) return;
    document.addEventListener('keydown', onKeydown, true);
    return () => document.removeEventListener('keydown', onKeydown, true);
  });

  // Electron accelerator → 键帽文字。
  const PRETTY = { CommandOrControl: 'Ctrl', Command: 'Cmd', Control: 'Ctrl', Super: 'Win', Return: 'Enter', Plus: '+' };
  const caps = $derived(
    accelerator ? accelerator.split('+').filter(Boolean).map((p) => PRETTY[p] || p) : []
  );
</script>

<button
  bind:this={btn}
  class="rec"
  class:on={recording}
  onclick={() => { recording = !recording; }}
  onblur={() => { recording = false; }}
  title={recording ? t('直接按下组合键；Esc 取消，Backspace 关掉') : t('点击改键')}
>
  {#if recording}
    <span class="tip">{t('按下组合键…')}</span>
  {:else if caps.length}
    {#each caps as cap, i}{#if i}<span class="sep">+</span>{/if}<kbd>{cap}</kbd>{/each}
  {:else}
    <span class="tip off">{placeholder}</span>
  {/if}
</button>

<style>
  .rec {
    display: inline-flex; align-items: center; gap: 3px;
    min-width: 120px; min-height: 26px; justify-content: center;
    padding: 3px 8px; border-radius: var(--dsk-r-sm);
    background: var(--dsk-hover);
    box-shadow: 0 0 0 1px transparent;
    font-family: var(--dsk-font); color: var(--dsk-ink);
    transition: background-color var(--dsk-t-fast) var(--dsk-ease), box-shadow var(--dsk-t-fast) var(--dsk-ease);
  }
  .rec:hover { background: var(--dsk-active); }
  .rec.on {
    background: transparent;
    box-shadow: 0 0 0 1.5px var(--dsk-accent);
  }
  kbd {
    font: inherit; font-size: var(--dsk-fs-sm); line-height: 1.6;
    padding: 0 5px; border-radius: 5px;
    background: var(--dsk-panel-strong);
    box-shadow: 0 0 0 1px var(--dsk-line-strong);
  }
  .sep { font-size: 11px; color: var(--dsk-ink-3); }
  .tip { font-size: var(--dsk-fs-sm); color: var(--dsk-accent); }
  .tip.off { color: var(--dsk-ink-3); }
</style>
