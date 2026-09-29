<script lang="ts">
  // O7（K64）：目标模式的选项（输入框里、文本上方）——验证命令由 harness 自己跑，过了才算达成；最多跑几轮。
  // 选项挂在会话的 goalDraft 上（切会话不串），发出去就收起；被拒收时 send() 会还回来。
  import Icon from "../ui/Icon.svelte";
  import TextField from "../ui/TextField.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  // Q5：轮数以前只有 HTML 的 min / max，清空之后会把空值发出去——离开输入框时收回 1–50 的整数（空 / 非数字回到默认 10）
  function clampRounds() {
    const d = pane.chat.goalDraft;
    if (!d) return;
    const raw: unknown = d.maxRounds;
    const n = raw === null || raw === undefined || raw === "" ? NaN : Math.round(Number(raw));
    d.maxRounds = Number.isFinite(n) ? Math.min(50, Math.max(1, n)) : 10;
  }
</script>

{#if pane.chat.goalDraft}
  {@const d = pane.chat.goalDraft}
  <!-- 「最多 N 轮」整句一个键（按轮数取单复数），输入框插在 {n} 处 -->
  {@const roundsParts = t("最多 {n} 轮", { count: d.maxRounds }).split("{n}")}
  <div class="goal">
    <p class="hint"><Icon name="target" size={14} /><span>{t("目标模式：没达成会自动一轮轮接着做")}</span></p>
    <div class="fields">
      <div class="verify">
        <TextField size="sm" mono label={t("验证命令")} placeholder={t("验证命令（可选，如 npm test）")} bind:value={d.verify} />
      </div>
      <label class="rounds">
        <span>{roundsParts[0].trim()}</span>
        <input type="number" min="1" max="50" inputmode="numeric" bind:value={d.maxRounds} onchange={clampRounds} />
        {#if roundsParts[1]?.trim()}<span>{roundsParts[1].trim()}</span>{/if}
      </label>
    </div>
  </div>
{/if}

<style>
  .goal {
    padding: 4px 4px 10px;
  }
  .hint {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 8px;
    font-size: var(--fs-sm);
    line-height: var(--lh-ui);
    color: var(--accent);
  }
  .fields {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
  }
  .verify {
    flex: 1 1 220px;
    min-width: 0;
  }
  .rounds {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: none;
    font-size: var(--fs-sm);
    color: var(--text2);
  }
  .rounds input {
    width: 52px;
    height: 32px;
    padding: 0 6px;
    border: 0;
    border-radius: 9px;
    background: var(--surface2);
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--fs-md);
    font-variant-numeric: tabular-nums;
    text-align: center;
    appearance: textfield;
    -moz-appearance: textfield;
    transition:
      box-shadow var(--t-fast) var(--ease),
      background-color var(--t-fast) var(--ease);
  }
  .rounds input::-webkit-inner-spin-button,
  .rounds input::-webkit-outer-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }
  .rounds input:focus {
    outline: none;
    background: var(--surface);
    box-shadow:
      inset 0 0 0 1px var(--accent),
      0 0 0 3px var(--accent-soft);
  }
</style>
