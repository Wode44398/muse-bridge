<script lang="ts" module>
  // 规则在本地是带 id 的条目（服务端的旧配置里可能有重复的规则，按文本做键会撞）；存的时候只取文本。
  export interface RuleItem {
    id: number;
    text: string;
  }
  let rid = 0;
  export const toItems = (list: readonly string[] | undefined): RuleItem[] => (list ?? []).map((text) => ({ id: ++rid, text }));
  // 一行一条：去空白、丢空行（和以前多行文本框的存法一致）
  export const splitRules = (v: string): string[] =>
    v
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
</script>

<script lang="ts">
  // 权限规则的一张表（「每次问我」或「从不允许」）：一条一行、等宽、可删；最后一行是「添加规则」。
  // 只改本地草稿，按「保存」才写回（服务端校验，错误原文走提示）。一次粘贴多行 = 拆成多条。
  import { collapse } from "../../lib/motion.ts";
  import { haptic } from "../../lib/touch.ts";
  import Group from "../ui/Group.svelte";
  import Icon from "../ui/Icon.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Button from "../ui/Button.svelte";
  import { t } from "../../lib/i18n.ts";

  let {
    title,
    footnote,
    items = $bindable([]),
    pending = $bindable(""),
    placeholder,
    label,
  }: {
    title: string;
    footnote?: string;
    items?: RuleItem[];
    pending?: string;
    placeholder: string;
    label: string;
  } = $props();

  // 触屏上行内的小按钮放大一档（点按目标别太小）
  const coarse = matchMedia("(pointer: coarse)").matches;
  const btn: "sm" | "md" = coarse ? "md" : "sm";

  function add() {
    const lines = splitRules(pending);
    if (!lines.length) return;
    const have = new Set(items.map((r) => r.text));
    const fresh = lines.filter((x) => (have.has(x) ? false : (have.add(x), true)));
    if (fresh.length) items = [...items, ...toItems(fresh)];
    pending = "";
    haptic("light");
  }
  function remove(id: number) {
    items = items.filter((r) => r.id !== id);
    haptic("light");
  }
  function onKey(e: KeyboardEvent) {
    if (e.key !== "Enter" || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    add();
  }
  // 单行输入框会把粘贴进来的换行吃掉（几条规则连成一串）：多行粘贴自己接住，一行一条加进表里
  function onPaste(e: ClipboardEvent) {
    const text = e.clipboardData?.getData("text") ?? "";
    if (!/[\r\n]/.test(text.trim())) return;
    e.preventDefault();
    pending = `${pending}\n${text}`;
    add();
  }
</script>

<Group {title} {footnote}>
  {#each items as r (r.id)}
    <div class="rule" transition:collapse>
      <div class="rin">
        <code class="rt">{r.text}</code>
        <span class="del"><IconButton icon="close" size={coarse ? 36 : 30} iconSize={15} label={t("删除规则 {rule}", { rule: r.text })} title={t("删除")} onclick={() => remove(r.id)} /></span>
      </div>
    </div>
  {/each}
  <div class="add">
    <span class="plus"><Icon name="plus" size={16} /></span>
    <input
      bind:value={pending}
      {placeholder}
      aria-label={label}
      autocomplete="off"
      autocapitalize="off"
      spellcheck="false"
      enterkeyhint="done"
      onkeydown={onKey}
      onpaste={onPaste}
    />
    <Button size={btn} variant="secondary" disabled={!pending.trim()} onclick={add}>{t("添加")}</Button>
  </div>
</Group>

<style>
  .rin {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 6px 6px 6px 14px;
  }
  .rt {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-md);
    line-height: 1.5;
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .del {
    display: inline-flex;
    flex: none;
  }
  /* 桌面：删除钮悬停才浮现（只动透明度，占位不变；键盘聚焦时照常可见）；触屏常显 */
  @media (hover: hover) and (pointer: fine) {
    .del {
      opacity: 0;
      transition: opacity var(--t-fast) var(--ease);
    }
    .rule:hover .del,
    .del:focus-within {
      opacity: 1;
    }
  }

  .add {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 46px;
    padding: 6px 7px 6px 12px;
    transition: background-color var(--t-fast) var(--ease);
  }
  .add:focus-within {
    background: var(--surface);
  }
  .plus {
    display: inline-flex;
    flex: none;
    color: var(--text3);
  }
  .add input {
    flex: 1;
    min-width: 0;
    height: 32px;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--fs-md);
  }
  .add input::placeholder {
    font-family: var(--font-ui);
    color: var(--text3);
  }
</style>
