<script lang="ts">
  // AskUserQuestion：agent 抛出的选择题。
  //  · 停靠态（这一轮在跑且没答）：单选 = 圆点，多选 = 方勾，选中青色、弹一下；「其他…」那一行原地变成输入框写自定义
  //    答案（单选里与选项互斥，多选里并存）。几道题时分步：一次一题，单选点完自动去下一道没答的，底部小点指示进度、
  //    点小点可回看；全部答了才能提交。答题过程中卡片不变高（几道题叠在同一格、「其他」原地展开）——停靠区贴底往上长，
  //    卡片一变高顶上就会被裁一下。桌面上焦点不在输入框里时，数字键 1–9 直接选当前这道题的选项。
  //    任一台连着的设备（含镜像）都能答；在输入框里直接写一段话 = 每道题都以它作「其他」答案（Composer / send）。
  //  · 回执（答了 / 历史 / 这一轮已结束）：每题一行问题 + 选了什么（没选的淡掉），自定义答案原样摆；
  //    没人答的写明 agent 按什么继续了；别的设备答的写「在X上」。
  // 乐观落定 / 失效（别的设备先答了、超时）/ 回滚都在 state.svelte.ts 的 answerAsk 里。
  import { onDestroy, tick, untrack } from "svelte";
  import { answerAsk, permissionMode, type AskItem, type AskQuestion } from "../../lib/state.svelte.ts";
  import { decidedElsewhere } from "../../lib/client-id.ts";
  import { clockOf } from "../../lib/deadline.ts";
  import { layerCount } from "../../lib/layers.ts";
  import { fade } from "../../lib/motion.ts";
  import { haptic } from "../../lib/touch.ts";
  import Button from "../ui/Button.svelte";
  import Icon from "../ui/Icon.svelte";
  import TextField from "../ui/TextField.svelte";
  import CardShell from "./CardShell.svelte";
  import { askDrafts, cardWindowMs } from "./card-kit.ts";
  import { usePane } from "../../lib/pane.ts";
  import { t, tr } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let { item }: { item: AskItem } = $props();

  // 交互条件：没答 且 这一轮还在跑（历史 / 停止后自动变回执）
  const interactive = $derived(!item.answered && pane.chat.running);

  // ── 本地编辑态（Q12：挂在条目上——没送达、重新停进来时选了一半的还在）──
  const saved = untrack(() => askDrafts.get(item));
  let sel = $state<Record<string, string[]>>(saved?.sel ?? {});
  let customText = $state<Record<string, string>>(saved?.customText ?? {});
  let customOpen = $state<Record<string, boolean>>(saved?.customOpen ?? {});
  let step = $state(saved?.step ?? 0);
  $effect(() => void askDrafts.set(item, $state.snapshot({ sel, customText, customOpen, step })));

  const n = $derived(item.questions.length);
  const cur = $derived(Math.min(step, Math.max(0, n - 1)));
  const q = $derived<AskQuestion | undefined>(item.questions[cur]);

  const isSel = (qq: AskQuestion, label: string) => (interactive ? (sel[qq.id] ?? []) : (item.selected[qq.id] ?? [])).includes(label);
  const done = (qq: AskQuestion) => (sel[qq.id]?.length ?? 0) > 0 || Boolean(customOpen[qq.id] && (customText[qq.id] ?? "").trim());
  const canSubmit = $derived(item.questions.every(done));

  // ── 分步 ──
  let focusFor = $state<string | null>(null); // 刚点开「其他」的那道题：它的输入框挂上就聚焦（别的时候不抢焦点）
  let advanceTimer = 0;
  function go(i: number) {
    clearTimeout(advanceTimer);
    if (i < 0 || i >= n || i === cur) return;
    // 焦点在离开的那道题里（「其他」里回车、键盘选了单选项后自动翻题）：它马上变 inert，焦点跟到新题的第一个选项
    const hadFocus = Boolean(box?.contains(document.activeElement));
    focusFor = null;
    step = i;
    if (hadFocus) void tick().then(() => box?.querySelector<HTMLElement>(".q.cur button.opt")?.focus({ preventScroll: true }));
  }
  // 从 from 往后找下一道还没答的（到头绕回来）；都答了返回 -1
  function nextOpen(from: number): number {
    for (let k = 1; k < n; k++) {
      const i = (from + k) % n;
      if (!done(item.questions[i])) return i;
    }
    return -1;
  }

  function pick(qq: AskQuestion, label: string) {
    if (!interactive) return;
    haptic("light");
    if (qq.multiSelect) {
      const set = new Set(sel[qq.id] ?? []);
      if (set.has(label)) set.delete(label);
      else set.add(label);
      sel[qq.id] = [...set];
      return;
    }
    sel[qq.id] = [label];
    customOpen[qq.id] = false; // 单选：点了正式选项就收起「其他」
    // 单选点完这一题：停一拍（看得见选中的那一下）再去下一道没答的
    if (n > 1) {
      clearTimeout(advanceTimer);
      const from = cur;
      advanceTimer = window.setTimeout(() => {
        const next = nextOpen(from);
        if (next >= 0 && interactive) go(next);
      }, 320);
    }
  }

  function toggleOther(qq: AskQuestion) {
    if (!interactive) return;
    haptic("light");
    clearTimeout(advanceTimer);
    const open = !customOpen[qq.id];
    const hadFocus = Boolean(box?.contains(document.activeElement));
    if (open && customText[qq.id] == null) customText[qq.id] = "";
    customOpen[qq.id] = open;
    if (open && !qq.multiSelect) sel[qq.id] = []; // 单选：其他与选项互斥
    focusFor = open ? qq.id : null;
    // 收起：输入框那一行换回按钮，焦点落回「其他…」（键盘操作不丢焦点）
    if (!open && hadFocus) void tick().then(() => box?.querySelector<HTMLElement>(".q.cur button.opt.other")?.focus({ preventScroll: true }));
  }

  function submit() {
    if (!canSubmit || !interactive) return;
    clearTimeout(advanceTimer);
    const answers = item.questions.map((qq) => {
      const labels = [...(sel[qq.id] ?? [])];
      const custom = (customText[qq.id] ?? "").trim();
      if (customOpen[qq.id] && custom) {
        return qq.multiSelect ? { selected: [...labels, custom], custom: true } : { selected: [custom], custom: true };
      }
      return { selected: labels, custom: false };
    });
    void answerAsk(item.id, answers);
  }

  // 「其他」里回车：能提交就提交；否则这题写好了就去下一道没答的。Q2：输入法组字中的回车不算
  function onOtherKey(e: KeyboardEvent, qq: AskQuestion) {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
    e.preventDefault();
    if (canSubmit) {
      submit();
      return;
    }
    if (done(qq)) {
      const next = nextOpen(cur);
      if (next >= 0) go(next);
    }
  }

  // ── 桌面数字键：1–9 = 当前这道题的第几个选项（选项数 + 1 = 其他）──
  // 只在焦点不在任何输入控件里、上面没盖着菜单 / 面板、卡片看得见（bridge 里保活隐藏的实例不算）时生效
  let box: HTMLElement | undefined = $state();
  function onKey(e: KeyboardEvent) {
    if (!interactive || e.defaultPrevented || e.repeat || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
    if (!/^[1-9]$/.test(e.key)) return;
    const tgt = e.target as HTMLElement | null;
    if (tgt?.closest?.("input, textarea, select, [contenteditable]:not([contenteditable='false'])")) return;
    if (layerCount() > 0 || !box?.isConnected || !box.getClientRects().length) return;
    const qq = q;
    if (!qq) return;
    const k = Number(e.key) - 1;
    if (k < qq.options.length) pick(qq, qq.options[k].label);
    else if (k === qq.options.length) toggleOther(qq);
    else return;
    e.preventDefault();
  }
  $effect(() => {
    if (!interactive) return;
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });
  onDestroy(() => clearTimeout(advanceTimer));

  // ── 回执 ──
  // 所选里对不上任何选项的 = 自定义答案
  const customChips = (qq: AskQuestion) => (item.selected[qq.id] ?? []).filter((v) => !qq.options.some((o) => o.label === v));
  // 落定了却一道都没选 = 没人答（取消 / 超时 / 预算跳过）
  const unanswered = $derived(item.answered && item.questions.every((qq) => (item.selected[qq.id] ?? []).length === 0));
  const resolved = $derived(item.answered && !unanswered);
  const where = $derived(resolved ? decidedElsewhere(item.by) : "");
  const title = $derived(interactive ? t("需要你确认") : resolved ? t("已回答") : item.expired ? t("超时未答") : t("未回答"));

  const coarse = matchMedia("(pointer: coarse)").matches;
  const big: "md" | "lg" = coarse ? "lg" : "md";
</script>

{#snippet actions()}
  <div class="nav">
    {#if n > 1}
      <div class="dots" role="group" aria-label={t("题目")}>
        {#each item.questions as qq, i (qq.id)}
          <button
            type="button"
            class="dot"
            class:on={i === cur}
            class:done={done(qq)}
            aria-label={done(qq) ? t("第 {i} 题（已答）", { i: i + 1 }) : t("第 {i} 题", { i: i + 1 })}
            aria-current={i === cur ? "step" : undefined}
            onclick={() => go(i)}><span></span></button
          >
        {/each}
      </div>
    {/if}
    <span class="sp"></span>
    <!-- 最后一题时变灰而不消失：底栏不重排，卡片不变高 -->
    {#if n > 1}
      <Button variant="ghost" size={big} iconRight="chevronR" disabled={cur >= n - 1} onclick={() => go(cur + 1)}>{t("下一题")}</Button>
    {/if}
    <Button variant="primary" size={big} iconRight="send" disabled={!canSubmit} onclick={submit}>{t("提交")}</Button>
  </div>
{/snippet}

<CardShell
  id={item.id}
  icon="question"
  {title}
  {where}
  sub={interactive && item.deadlineAt ? t("{time} 前没人答，agent 就按合理假设继续", { time: clockOf(item.deadlineAt) }) : ""}
  live={interactive}
  deadlineAt={interactive ? item.deadlineAt : undefined}
  windowMs={cardWindowMs("ask", permissionMode(pane.chat) === "plan")}
  footer={interactive ? actions : undefined}
>
  {#if interactive}
    <!-- 几道题叠在同一格里：格子高 = 最高的那道题，换题只动透明度与位移，卡片不变高
         （停靠区的外框贴底往上长，卡片一变高顶上就会被裁一下）。不是当前这道的 inert：点不到、读屏也跳过 -->
    <div class="qstack" bind:this={box}>
      {#each item.questions as qq, qi (qq.id)}
        <div class="q" class:cur={qi === cur} class:before={qi < cur} inert={qi !== cur}>
          {#if qq.header || qq.multiSelect}
            <div class="q-top">
              {#if qq.header}<span class="q-hdr">{tr(qq.header)}</span>{/if}
              {#if qq.multiSelect}<span class="q-multi">{t("可多选")}</span>{/if}
            </div>
          {/if}
          {#if qq.question}<p class="q-text">{qq.question}</p>{/if}
          <div class="opts" role={qq.multiSelect ? "group" : "radiogroup"} aria-label={qq.question || tr(qq.header) || t("选项")}>
            {#each qq.options as o, i (i)}
              {@const on = isSel(qq, o.label)}
              <button
                type="button"
                class="opt"
                class:sel={on}
                role={qq.multiSelect ? "checkbox" : "radio"}
                aria-checked={on}
                onclick={() => pick(qq, o.label)}
              >
                <span class="mark" class:multi={qq.multiSelect}>
                  <span class="fill">{#if qq.multiSelect}<Icon name="check" size={12} stroke={2.6} />{/if}</span>
                </span>
                <span class="ob">
                  <span class="ol">{o.label}</span>
                  {#if o.description}<span class="od">{o.description}</span>{/if}
                </span>
                {#if i < 9}<span class="kbd" aria-hidden="true">{i + 1}</span>{/if}
              </button>
            {/each}
            <!-- 「其他」：点开后这一行原地变成输入框（行高不变） -->
            {#if customOpen[qq.id] && customText[qq.id] != null}
              <div class="opt other sel open">
                <button
                  type="button"
                  class="markbtn"
                  role={qq.multiSelect ? "checkbox" : "radio"}
                  aria-checked="true"
                  aria-label={t("其他（点一下收起）")}
                  onclick={() => toggleOther(qq)}
                >
                  <span class="mark" class:multi={qq.multiSelect}>
                    <span class="fill">{#if qq.multiSelect}<Icon name="check" size={12} stroke={2.6} />{/if}</span>
                  </span>
                </button>
                <span class="other-in" in:fade={{ duration: 140 }}>
                  <TextField
                    size="sm"
                    bind:value={customText[qq.id]}
                    placeholder={t("输入你的回答，回车提交")}
                    autofocus={focusFor === qq.id}
                    enterkeyhint="send"
                    onkeydown={(e) => onOtherKey(e, qq)}
                  />
                </span>
              </div>
            {:else}
              <button
                type="button"
                class="opt other"
                role={qq.multiSelect ? "checkbox" : "radio"}
                aria-checked="false"
                onclick={() => toggleOther(qq)}
              >
                <span class="mark" class:multi={qq.multiSelect}><span class="fill"></span></span>
                <span class="ob"><span class="ol">{t("其他…")}</span></span>
                {#if qq.options.length < 9}<span class="kbd" aria-hidden="true">{qq.options.length + 1}</span>{/if}
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {:else}
    {#each item.questions as qq (qq.id)}
      <div class="rq">
        <p class="rq-q">{#if qq.header}<span class="rq-h">{tr(qq.header)}</span>{/if}{qq.question}</p>
        {#if qq.options.length}
          <div class="picks">
            {#each qq.options as o, i (i)}
              {@const on = (item.selected[qq.id] ?? []).includes(o.label)}
              <span class="pick" class:on>
                {#if on}<Icon name="check" size={12} stroke={2.2} />{/if}{o.label}
              </span>
            {/each}
          </div>
        {/if}
        {#each customChips(qq) as c, i (i)}<p class="custom">{c}</p>{/each}
      </div>
    {/each}
    {#if unanswered}
      <p class="skipped">
        {item.expired ? t("超时没人答，agent 已按合理假设继续，并会在答复里写明假设。") : t("此问题未作答，agent 已按自身判断继续。")}
      </p>
    {/if}
  {/if}
</CardShell>

<style>
  p {
    margin: 0;
  }

  /* ── 停靠态：几道题叠在同一格 ──
     换题：离开的那道淡出、往来的方向让开；新的一道从另一侧滑进来、稍晚一点淡入（只动透明度与位移） */
  .qstack {
    display: grid;
    min-width: 0;
  }
  .q {
    grid-area: 1 / 1;
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
    padding-bottom: 2px;
    opacity: 0;
    visibility: hidden;
    transform: translateX(18px);
    transition:
      opacity 160ms var(--ease-in),
      transform var(--t-spring-soft, 420ms) var(--spring-soft, var(--ease-out)),
      visibility 0s linear 160ms;
  }
  .q.before {
    transform: translateX(-18px);
  }
  .q.cur {
    opacity: 1;
    visibility: visible;
    transform: none;
    transition:
      opacity 240ms var(--ease-out) 60ms,
      transform var(--t-spring-soft, 420ms) var(--spring-soft, var(--ease-out)),
      visibility 0s;
  }
  .q-top {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .q-hdr {
    padding: 1px 8px;
    border-radius: var(--r-xs);
    background: var(--surface2);
    font-size: var(--fs-xs);
    line-height: 18px;
    letter-spacing: 0.04em;
    color: var(--text2);
  }
  .q-multi {
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  .q-text {
    font-size: var(--fs-body);
    font-weight: 500;
    line-height: 1.5;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  /* 选项行的底色比文字栏宽出一截（往两边各让 10px，选择标记仍与题目文字对齐） */
  .opts {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0 -10px;
  }
  .opt {
    display: flex;
    align-items: flex-start;
    gap: 11px;
    width: 100%;
    min-height: 44px;
    padding: 11px 10px;
    border-radius: var(--r-md);
    text-align: left;
    color: var(--text);
    transition: background-color var(--t-fast) var(--ease);
  }
  .opt:active {
    background: var(--surface3);
  }
  .opt.sel {
    background: var(--accent-soft);
  }
  @media (hover: hover) {
    .opt:hover {
      background: var(--surface2);
    }
    .opt.sel:hover {
      background: color-mix(in srgb, var(--accent) 16%, transparent);
    }
  }
  /* 卡片正文是滚动容器，外扩的焦点框会被裁：改成内描边 */
  .opt:focus-visible,
  .markbtn:focus-visible {
    outline: none;
    box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent) 60%, transparent);
  }
  /* 「其他」展开：这一行原地变成输入框，行高不变（44） */
  .opt.open {
    align-items: center;
    padding-top: 6px;
    padding-bottom: 6px;
  }
  .markbtn {
    flex: none;
    display: grid;
    place-items: center;
    width: 30px;
    height: 32px;
    margin: 0 -6px;
    border-radius: var(--r-sm);
  }
  .open .mark {
    margin-top: 0;
  }
  .other-in {
    flex: 1;
    min-width: 0;
  }

  /* 选择标记：单选 = 圆点，多选 = 方勾；选中青色、弹一下 */
  .mark {
    flex: none;
    display: grid;
    place-items: center;
    width: 18px;
    height: 18px;
    margin-top: 1px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.5px var(--border2);
    transition: box-shadow var(--t-fast) var(--ease);
  }
  .mark.multi {
    border-radius: 5px;
  }
  .fill {
    display: grid;
    place-items: center;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    color: var(--on-accent);
    transform: scale(0);
    transition: transform 120ms var(--ease-in);
  }
  .multi .fill {
    width: 18px;
    height: 18px;
    border-radius: 5px;
  }
  .sel .mark {
    box-shadow: inset 0 0 0 1.5px var(--accent);
  }
  .sel .fill {
    transform: scale(1);
    animation: mark-pop var(--t-spring-pop, 560ms) var(--spring-pop, cubic-bezier(0.34, 1.5, 0.5, 1)) both;
  }
  @keyframes mark-pop {
    from {
      transform: scale(0.3);
    }
    to {
      transform: scale(1);
    }
  }

  .ob {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    flex: 1;
  }
  .ol {
    font-size: var(--fs-base);
    font-weight: 500;
    line-height: 20px;
    overflow-wrap: anywhere;
  }
  .od {
    font-size: var(--fs-sm);
    line-height: var(--lh-ui);
    color: var(--text3);
    overflow-wrap: anywhere;
  }
  .other .ol {
    color: var(--text2);
  }
  /* 桌面：选项右侧的数字键提示 */
  .kbd {
    display: none;
  }
  @media (pointer: fine) {
    .kbd {
      display: inline-block;
      flex: none;
      align-self: center;
      min-width: 18px;
      height: 18px;
      padding: 0 4px;
      border-radius: 5px;
      box-shadow: inset 0 0 0 1px var(--border2);
      font-family: var(--font-mono);
      font-size: var(--fs-xs);
      line-height: 18px;
      text-align: center;
      color: var(--text3);
    }
  }
  /* ── 底栏：进度小点 + 下一题 + 提交 ── */
  .nav {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .sp {
    flex: 1;
  }
  .dots {
    display: flex;
    align-items: center;
    margin-left: -7px;
  }
  .dot {
    display: grid;
    place-items: center;
    width: 22px;
    height: 32px;
    transition: opacity var(--t-fast) var(--ease);
  }
  .dot:active {
    opacity: 0.55;
  }
  .dot span {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--border2);
    transition:
      transform var(--t-spring, 500ms) var(--spring, var(--ease-out)),
      background-color var(--t-med) var(--ease);
  }
  .dot.done span {
    background: var(--text3);
  }
  .dot.on span {
    background: var(--accent);
    transform: scaleX(2.4);
  }
  @media (pointer: coarse) {
    .dot {
      width: 28px;
      height: 40px;
    }
  }

  /* ── 回执 ── */
  .rq {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .rq + .rq {
    padding-top: 2px;
  }
  .rq-q {
    color: var(--text2);
    line-height: var(--lh-ui);
    overflow-wrap: anywhere;
  }
  .rq-h {
    margin-right: 6px;
    font-size: var(--fs-xs);
    letter-spacing: 0.04em;
    color: var(--text3);
  }
  .picks {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .pick {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    padding: 2px 8px;
    border-radius: 7px;
    font-size: var(--fs-sm);
    line-height: 18px;
    color: var(--text3);
    overflow-wrap: anywhere;
  }
  .pick.on {
    color: var(--text);
    background: var(--surface);
    box-shadow: 0 0 0 1px var(--border);
  }
  .custom {
    align-self: flex-start;
    max-width: 100%;
    padding: 5px 10px;
    border-radius: 10px;
    background: var(--surface);
    box-shadow: 0 0 0 1px var(--border);
    color: var(--text);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .skipped {
    font-size: var(--fs-sm);
    line-height: var(--lh-ui);
    color: var(--text3);
  }

  @media (prefers-reduced-motion: reduce) {
    .sel .fill {
      animation: none;
    }
    .q,
    .q.before,
    .q.cur {
      transform: none;
    }
  }
</style>
