<script lang="ts">
  // 多行输入框：随内容长高（到 maxRows 为止再内部滚动），高度变化平滑。外观同 TextField。
  // 回车默认换行；需要「回车提交」的地方自己在 onkeydown 里判断（记得输入法组字：e.isComposing || e.keyCode === 229）。
  let {
    value = $bindable(""),
    placeholder = "",
    rows = 3,
    maxRows = 10,
    mono = false,
    tone = "fill",
    disabled = false,
    autofocus = false,
    maxlength,
    label,
    onkeydown,
    oninput,
    el = $bindable(),
  }: {
    value?: string;
    placeholder?: string;
    rows?: number;
    maxRows?: number;
    mono?: boolean;
    tone?: "fill" | "surface";
    disabled?: boolean;
    autofocus?: boolean;
    maxlength?: number;
    label?: string;
    onkeydown?: (e: KeyboardEvent) => void;
    oninput?: (e: Event) => void;
    el?: HTMLTextAreaElement;
  } = $props();

  // 量内容高度：先收成 auto 再读 scrollHeight，钳在 rows..maxRows 行之间
  // 参数是 value 本身：外部改了值（清空、回填）时 update 会重量一次
  function fit(node: HTMLTextAreaElement, _value?: string) {
    const measure = () => {
      const cs = getComputedStyle(node);
      const line = parseFloat(cs.lineHeight) || 22;
      const pad = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      node.style.height = "auto";
      const h = Math.min(Math.max(node.scrollHeight, rows * line + pad), maxRows * line + pad);
      node.style.height = `${h}px`;
      node.style.overflowY = node.scrollHeight > h + 1 ? "auto" : "hidden";
    };
    measure();
    if (autofocus) requestAnimationFrame(() => node.focus());
    node.addEventListener("input", measure);
    return {
      update: measure,
      destroy() {
        node.removeEventListener("input", measure);
      },
    };
  }
</script>

<textarea
  bind:this={el}
  bind:value
  class="ta {tone}"
  class:mono
  {placeholder}
  {disabled}
  {maxlength}
  {rows}
  aria-label={label ?? placeholder}
  spellcheck="false"
  use:fit={value}
  {onkeydown}
  {oninput}
></textarea>

<style>
  .ta {
    display: block;
    width: 100%;
    padding: 9px 12px;
    border: 0;
    border-radius: 12px;
    background: var(--surface2);
    color: var(--text);
    font: inherit;
    font-size: var(--fs-base);
    line-height: 1.6;
    resize: none;
    outline: 0;
    box-shadow: inset 0 0 0 1px transparent;
    transition:
      box-shadow var(--t-fast) var(--ease),
      background-color var(--t-fast) var(--ease),
      height var(--t-med) var(--ease-out);
  }
  .ta.surface {
    background: var(--surface);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .ta:focus {
    background: var(--surface);
    box-shadow:
      inset 0 0 0 1px var(--accent),
      0 0 0 3px var(--accent-soft);
  }
  .ta::placeholder {
    color: var(--text3);
  }
  .mono {
    font-family: var(--font-mono);
    font-size: var(--fs-md);
  }
  .ta:disabled {
    opacity: 0.5;
  }
</style>
