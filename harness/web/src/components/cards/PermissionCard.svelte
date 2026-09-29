<script lang="ts">
  // 权限卡：某条规则（如 ask: Bash(git push:*)）把这次调用交给你裁决——「要不要让它做这件事」。
  // （AskCard 是 agent 问「你想要哪个方案」，两回事。）
  //  · 停靠态（未裁决且这一轮在跑）：先一句人话说为什么问（P11），再摆执行事实（ApprovalPreview 展开）；
  //    允许一次 / 本会话都允许 / 拒绝 / 拒绝并停止（P6：拒绝与停下由服务端一步做完，不给模型换条路再试的空窗）。
  //    P5：「本会话都允许」会记下哪条规则，点之前照原样摆出来；Bash 有稳定前缀时可以改成「按前缀」记
  //    （高危命令、解释器入口没有这个选项，只能一字不差地记）；客户端只送 scope，不送规则原文。
  //    S12：控制面文件只给「允许一次」。
  //  · 回执：结论 + 在哪台设备上定的 + 拒绝时附的话（N43：输入框里的话落到卡上）；执行事实收起。
  // 乐观落定 / 失效回滚 / 拒绝并停止先断流再送，都在 state.svelte.ts 的 decidePermission 里。
  import { onDestroy, untrack } from "svelte";
  import { decidePermission, type PermissionItem } from "../../lib/state.svelte.ts";
  import { decidedElsewhere } from "../../lib/client-id.ts";
  import { clockOf } from "../../lib/deadline.ts";
  import { haptic } from "../../lib/touch.ts";
  import Button from "../ui/Button.svelte";
  import Segmented from "../ui/Segmented.svelte";
  import ApprovalPreview from "./ApprovalPreview.svelte";
  import CardShell from "./CardShell.svelte";
  import { cardWindowMs, scopeDrafts } from "./card-kit.ts";
  import { usePane } from "../../lib/pane.ts";
  import { t, tc, tr } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let { item }: { item: PermissionItem } = $props();

  const interactive = $derived(!item.decided && !item.cancelled && pane.chat.running);
  const where = $derived(item.decided ? decidedElsewhere(item.by) : "");

  // 记下哪种规则：这一条（原文）/ 按前缀。选择挂在条目上（Q12：没送达、重新停进来时还在）
  const hasPrefix = $derived((item.prefixRules?.length ?? 0) > 0);
  let scope = $state<"exact" | "prefix">(untrack(() => scopeDrafts.get(item) ?? "exact"));
  $effect(() => void scopeDrafts.set(item, scope));
  const pendingRules = $derived(scope === "prefix" && hasPrefix ? (item.prefixRules ?? []) : (item.sessionRules ?? []));
  const recorded = $derived(item.scope === "prefix" ? (item.prefixRules ?? []) : (item.sessionRules ?? []));
  // Q4：以前 sessionRules 为空时连「按前缀」一起藏了；有前缀规则就照样给选
  const showRemember = $derived(!item.noSession && (pendingRules.length > 0 || hasPrefix));

  const label = $derived(
    item.decided === "deny"
      ? t("已拒绝")
      : item.decided === "deny_stop"
        ? t("已拒绝并停止")
        : item.decided === "session"
          ? item.scope === "prefix"
            ? tc("dimensio", "本会话按前缀允许")
            : tc("dimensio", "本会话都允许")
          : item.decided === "once"
            ? t("已允许一次")
            : item.cancelled
              ? item.cancelReason === "timeout"
                ? t("超时没人批，已按拒绝处理")
                : t("没等到裁决，这一轮已结束")
              : interactive
                ? t("需要你批准")
                : t("未裁决"),
  );

  // 触屏上按钮用大一号（触控目标 ≥ 40）；桌面紧凑
  const coarse = matchMedia("(pointer: coarse)").matches;
  const big: "md" | "lg" = coarse ? "lg" : "md";
  const small: "sm" | "md" = coarse ? "md" : "sm";

  function decide(d: "once" | "session" | "deny") {
    if (!interactive) return;
    void decidePermission(item.id, d, d === "session" && scope === "prefix" && hasPrefix ? "prefix" : undefined);
  }

  // 拒绝并停止 = 这一轮整个停下（可能连着一个跑了很久的工作流）：先点一下只是上膛，3 秒内再点才算（DESIGN 危险操作两步）。
  // 上膛只在本端，服务端收到的仍是一步做完的 deny_stop。
  let stopArmed = $state(false);
  let armTimer = 0;
  function denyStop() {
    if (!interactive) return;
    if (!stopArmed) {
      stopArmed = true;
      haptic("light");
      clearTimeout(armTimer);
      armTimer = window.setTimeout(() => (stopArmed = false), 3000);
      return;
    }
    clearTimeout(armTimer);
    stopArmed = false;
    void decidePermission(item.id, "deny_stop");
  }
  onDestroy(() => clearTimeout(armTimer));
</script>

{#snippet ruleChip()}
  {#if item.rule}<span class="rule" title={t("命中的规则")}>{tr(item.rule)}</span>{/if}
{/snippet}

{#snippet actions()}
  {#if item.noSession}
    <p class="hint">{item.why ? t("每次都要你点头，不能「本会话都允许」") : t("这是控制面文件（指令 / 运行配置 / 会话记录），每次改都要你点头，不能「本会话都允许」")}</p>
  {/if}
  {#if showRemember}
    <div class="remember">
      <div class="rm-head">
        <span>{t("「本会话都允许」会记下")}</span>
        {#if hasPrefix}
          <Segmented
            size="sm"
            label={t("记下的规则")}
            options={[
              { value: "exact", label: t("这一条") },
              { value: "prefix", label: t("按前缀") },
            ]}
            value={scope}
            onchange={(v) => {
              haptic("light");
              scope = v;
            }}
          />
        {/if}
      </div>
      {#if pendingRules.length}
        <div class="rules">
          {#each pendingRules as r, i (i)}<code title={r}>{r}</code>{/each}
        </div>
      {/if}
    </div>
  {/if}
  <!-- 拒绝一组在左、允许一组在右；窄屏放不下一行时，允许那组整组折到下一行、靠右（最顺手的位置） -->
  <div class="acts">
    <span class="grp">
      <Button variant="ghost" size={big} onclick={() => decide("deny")}>{t("拒绝")}</Button>
      <Button
        variant={stopArmed ? "danger-solid" : "danger"}
        size={small}
        title={stopArmed ? t("再点一次：拒绝这一步，并停下这一轮") : t("拒绝这一步，并停下这一轮")}
        onclick={denyStop}>{stopArmed ? t("再点一次停止") : t("拒绝并停止")}</Button
      >
    </span>
    <span class="grp yes">
      {#if !item.noSession}
        <Button variant="secondary" size={big} onclick={() => decide("session")}>{t("本会话都允许")}</Button>
      {/if}
      <Button variant="accent" size={big} onclick={() => decide("once")}>{t("允许一次")}</Button>
    </span>
  </div>
{/snippet}

<CardShell
  id={item.id}
  icon="shield"
  title={label}
  {where}
  sub={interactive && item.deadlineAt ? t("{time} 前没人批，就按拒绝处理", { time: clockOf(item.deadlineAt) }) : ""}
  live={interactive}
  deadlineAt={interactive ? item.deadlineAt : undefined}
  windowMs={cardWindowMs("permission", false)}
  aside={!interactive && item.rule ? ruleChip : undefined}
  footer={interactive ? actions : undefined}
>
  <!-- P11（ZCode C1）：为什么问你——说人话 -->
  {#if item.why}<p class="why" class:quiet={!interactive}>{tr(item.why)}</p>{/if}

  {#if interactive}
    <div class="facts">
      <span class="tool">{item.tool}</span>
      {@render ruleChip()}
    </div>
  {:else if !item.preview}
    <div class="facts"><span class="tool">{item.tool}</span></div>
  {/if}
  <!-- 有执行事实时主体就在里面，不重复摆 -->
  {#if item.subject && !item.preview}<pre class="subject">{item.subject}</pre>{/if}
  {#if item.preview}<ApprovalPreview preview={item.preview} open={interactive} />{/if}

  {#if !interactive}
    {#if item.note}<p class="note">{t("附言：{note}", { note: item.note })}</p>{/if}
    {#if item.decided === "session" && recorded.length}
      <div class="rules done">
        {#each recorded as r, i (i)}<code title={r}>{r}</code>{/each}
      </div>
    {/if}
  {/if}
</CardShell>

<style>
  p {
    margin: 0;
  }
  /* 为什么问你：卡片里最先读到的一句 */
  .why {
    font-size: var(--fs-base);
    line-height: 1.6;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .why.quiet {
    font-size: var(--fs-md);
    line-height: var(--lh-ui);
    color: var(--text2);
  }
  .facts {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }
  .tool {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text2);
  }
  .rule {
    display: inline-block;
    min-width: 0;
    max-width: 100%;
    padding: 1px 7px;
    border-radius: var(--r-xs);
    background: var(--surface2);
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 18px;
    color: var(--text3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .facts .rule {
    margin-left: auto;
  }
  .subject {
    margin: 0;
    padding: 8px 12px;
    max-height: 192px;
    overflow: auto;
    overscroll-behavior: contain;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.6;
    color: var(--text);
    background: var(--code-bg);
    border-radius: 10px;
  }
  .note {
    color: var(--text2);
    line-height: var(--lh-ui);
    overflow-wrap: anywhere;
  }

  /* 底栏 */
  .hint {
    font-size: var(--fs-sm);
    line-height: var(--lh-ui);
    color: var(--text3);
  }
  .remember {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .rm-head {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 10px;
    font-size: var(--fs-sm);
    color: var(--text2);
  }
  .rules {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
  }
  .rules code {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.55;
    color: var(--text2);
    overflow-wrap: anywhere;
  }
  .rules.done code {
    color: var(--text3);
  }
  .acts {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .grp {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .grp.yes {
    justify-content: flex-end;
    margin-inline-start: auto;
  }
</style>
