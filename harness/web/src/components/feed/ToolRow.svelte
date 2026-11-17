<script lang="ts">
  // 工具行：量线上一个节点 + 动词 + 参数摘要（mono，单行省略）；第二行只说结果；运行中的前台 Bash 在下面摆实时尾行；
  // 点开 = 用 collapse 长出详情面板（参数 / 执行事实 / 输出）。
  //
  // compact = 精简模式（默认，设置里「显示全部工作过程」关着）：不上量线，对齐 bridge Claude 分页（= 官方 /code 页）的工具行——
  // 一行「动词 + 目标」：跑着用进行时 + 微光（650ms 防抖，快工具不闪）、做完用完成时、失败换失败句标红、被拒 / 被打断在尾巴上说；
  // 单独一行跑满 2 秒在行尾走秒（组里的各步不走，组头走）。点开是参数表 + 结果（单独一行时套一圈细线小卡；组里的直接摆），
  // 首次展开后保持挂载、只切显隐。run = 同一文件连续几次读写并成的一行（第一次是 item），行尾带行号范围，展开逐次列出。
  //
  // Agent / Workflow 行对齐 bridge Claude 分页（= 官方 /code 页）：不做行内展开，点开进右侧工作区的「任务」视图
  //（工作流 → 详细卡；Agent → 直接压上那个子 agent 的面板）。工作流不在工具组里时整行换成紧凑卡（agent 点阵），跑完也留着
  //（停在终态；官方跑完收成一行，认不出来）。子 agent 在对话流里不走这里——一批并行的 Agent 由 Feed 画成子 agent 卡
  //（AgentCard）；这里的 Agent 分支只是兜底的一行（模型 · 当前步骤 · 步数 / 次数 · 时长）。
  //
  // 「在跑」只在这一轮真的还在跑时成立：停止之后（或断流收尾）还挂着 running 的行没等到结果，按「被打断」画成灰叉，
  // 不再转 / 不再亮卡片、不再摆尾行（spec-A ⚠10 同源）。
  import { openTaskDetail, toast, type ToolItem } from "../../lib/state.svelte.ts";
  import * as api from "../../lib/api.ts";
  import { toolMeta } from "../../lib/icons.ts";
  import { toolPreview } from "../../lib/tool-preview.ts";
  import { argPreview, readRanges, toolLine, toolParams } from "../../lib/tool-summary.ts";
  import { elapsedLabel } from "../../lib/timeline-reducer.ts";
  import { liveClock } from "../../lib/live-clock.ts";
  import { morphText, reveal } from "../../lib/morph-text.ts";
  import { untrack } from "svelte";
  import { STATUS_LABEL, fmtDur, fmtTokens, modelShort, toolTaskKind, toolTaskStatus, toolTaskTitle, type TaskStatus } from "../../lib/tasks.ts";
  import { collapse } from "../../lib/motion.ts";
  import Button from "../ui/Button.svelte";
  import ApprovalPreview from "../cards/ApprovalPreview.svelte";
  import RailRow from "./RailRow.svelte";
  import ToolNode, { type NodeTone } from "./ToolNode.svelte";
  import WorkflowCard from "./WorkflowCard.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t, tr } from "../../lib/i18n.ts";
  import Icon from "../ui/Icon.svelte";
  import { isSessionTool, toolSessionTarget } from "../../lib/session-family.ts";
  import { family, openFamilySession } from "../../lib/session-family.svelte.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let {
    item,
    run,
    inGroup = false,
    compact = false,
    up = false,
    down = false,
  }: { item: ToolItem; run?: ToolItem[]; inGroup?: boolean; compact?: boolean; up?: boolean; down?: boolean } = $props();

  const meta = $derived(toolMeta(item.name));
  // 会话协作：StartSession 开出来的会话、SendMessage / ReadSession 的对象——结果行下面给一个能点的会话名
  const famRef = $derived(isSessionTool(item.name) ? toolSessionTarget(item, pane.chat.id, family) : null);
  // U8（E4）：展开后摆的执行事实（只在展开时算）
  const preview = $derived(item.open ? toolPreview(item.name, item.args) : null);
  // 第二行的结果：服务端给的是英文摘要的（待办的「todos: 1/3 done」）在这里说成中文
  const outcomeText = $derived.by(() => {
    const s = item.outcome || item.summary || "";
    const m = /^todos: (\d+)\/(\d+) done$/.exec(s);
    if (m) return t("完成 {done}/{total}", { done: m[1], total: m[2] });
    // WebFetch 不截断时的「HTTP 200 · 523 字」字面只有一个汉字，tr() 的模式匹配认不了，这里按原样拆开给整句
    const f = /^HTTP (\d+) · (\S+) 字$/.exec(s);
    return f ? t("HTTP {status} · {size} 字", { status: f[1], size: f[2] }) : tr(s);
  });
  // Bash 的结果开头会把命令再回显一遍（「$ 命令」）；上面已经摆了命令，这一行就不重复了
  const shownOutput = $derived.by(() => {
    const out = item.output ?? "";
    if (preview?.kind !== "command") return out;
    const echo = `$ ${preview.command.trim()}\n`;
    return out.startsWith(echo) ? out.slice(echo.length) : out;
  });
  const kind = $derived(toolTaskKind(item));
  // 任务终态；这一轮已经停了而它还挂着 running = 被打断
  const tstatus = $derived.by((): TaskStatus | null => {
    if (!kind) return null;
    const s = toolTaskStatus(item);
    return s === "running" && !pane.chat.running ? "stopped" : s;
  });
  const live = $derived(item.status === "running" && pane.chat.running);
  const card = $derived(kind === "workflow" && !inGroup && tstatus !== null);
  const tone = $derived.by((): NodeTone => {
    if (tstatus) return tstatus === "running" ? "running" : tstatus === "completed" ? "ok" : tstatus === "failed" ? "fail" : "stopped";
    if (item.status === "running") return live ? "running" : "stopped";
    return item.status === "ok" ? "ok" : item.status === "fail" ? "fail" : "denied";
  });
  // 节点只靠颜色说状态：给读屏补一个词（完成是默认，不说）
  const SR: Record<NodeTone, string> = { running: t("运行中"), ok: "", fail: t("失败"), denied: t("被拒绝"), stopped: t("已停止") };

  const taskSummary = $derived.by(() => {
    if (!kind || !tstatus) return "";
    const parts: string[] = [];
    if (tstatus !== "running" && tstatus !== "completed") parts.push(STATUS_LABEL[tstatus]);
    if (item.agent) {
      const a = item.agent;
      parts.push(modelShort(a.model));
      if (tstatus === "running") {
        const cur = a.steps[a.steps.length - 1];
        parts.push(cur ? `${toolMeta(cur.name).verb} · ${a.steps.length}` : t("启动中"));
      } else {
        if (a.toolCalls) parts.push(t("{n} 次调用", { n: a.toolCalls }));
        parts.push(fmtDur(a.durationMs));
      }
    } else if (item.workflow) {
      const w = item.workflow;
      if (tstatus === "running") {
        if (w.currentPhase) parts.push(w.currentPhase);
        parts.push(t("{done}/{total} agent", { done: w.agents.filter((x) => x.status !== "running").length, total: w.agents.length, n: w.agents.length }));
      } else {
        parts.push(t("{n} 个 agent", { n: w.agentCount || w.agents.length }));
        const tk = fmtTokens(w.tokens);
        if (tk) parts.push(`${tk} tok`);
        parts.push(fmtDur(w.durationMs));
      }
    } else if (tstatus === "running") {
      parts.push(kind === "workflow" ? t("等待启动") : t("启动中"));
    }
    return parts.filter(Boolean).join(" · ");
  });

  // R14（K37）：运行中的前台 Bash 跑满 10 秒后可以「转后台」——不杀，这次调用立刻交回已有输出，之后 agent 自己 poll
  let bgBusy = $state(false);
  const canBackground = $derived(!kind && live && Boolean(item.progress?.canBackground) && (item.progress?.elapsedMs ?? 0) >= 10_000);
  async function toBackground(e: MouseEvent) {
    e.stopPropagation();
    if (!pane.chat.id || bgBusy) return;
    bgBusy = true;
    const moved = await api.moveToolToBackground(pane.chat.id, item.id);
    bgBusy = false;
    // spec-A ⚠9：没转成（已经结束 / 已经转过 / 后台池满了）要说一声，别让人以为点了没反应
    if (!moved) toast(t("没转成后台——这条命令可能刚好结束了，或者后台任务已经满了"));
  }

  // ── 精简模式 ──
  const tools = $derived(run && run.length ? run : [item]);
  const line = $derived(toolLine(item.name, item.args, tr(meta.verb)));
  const anyRunning = $derived(tools.some((x) => x.status === "running"));
  const runLive = $derived(anyRunning && pane.chat.running);
  // 官方 Wh(…, 650)：进行时 ↔ 完成时稳定 650ms 才换（20ms 的读文件不闪成一帧）；首帧取当前值
  let shownLive = $state(untrack(() => runLive));
  $effect(() => {
    const v = runLive;
    if (v === shownLive) return;
    // 这一轮停了：立刻落定，不在停下的轮上多闪 650ms 微光
    if (!pane.chat.running) {
      shownLive = v;
      return;
    }
    const timer = setTimeout(() => (shownLive = v), 650);
    return () => clearTimeout(timer);
  });
  const anyFail = $derived(tools.some((x) => x.status === "fail"));
  const anyDenied = $derived(tools.some((x) => x.status === "denied"));
  const stopped = $derived(anyRunning && !pane.chat.running);
  // 被拒 / 被打断不是「做了」也不是「失败」：用工具本来的动词，状态在尾巴上说
  const verbText = $derived(shownLive ? line.running : stopped || anyDenied ? tr(meta.verb) : anyFail ? line.failed : line.done);
  const failed = $derived(!shownLive && !stopped && !anyDenied && anyFail);
  const tailWord = $derived(shownLive ? "" : stopped ? t("已停止") : anyDenied ? t("被拒绝") : "");
  const ranges = $derived(item.name === "Read" ? readRanges(tools) : "");
  // 行尾走秒：单独一行、跑满 2 秒才出现（前台 Bash 的进度更准：重连重放时本机看到的起点偏晚）
  let now = $state(Date.now());
  $effect(() => {
    if (!compact || inGroup || !runLive) return;
    now = Date.now();
    const id = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(id);
  });
  const runMs = $derived.by(() => {
    if (!compact || inGroup || !runLive) return 0;
    const cur = tools.find((x) => x.status === "running") ?? item;
    const t0 = liveClock(cur)?.t0;
    return Math.max(t0 ? now - t0 : 0, cur.progress?.elapsedMs ?? 0);
  });
  // 首次展开后保持挂载、只切显隐：展开里的状态（diff 的「看全部」、滚动位置）收起再开还在
  let mounted = $state(untrack(() => item.open));
  $effect(() => {
    if (item.open) mounted = true;
  });
  // Bash 的结果开头会把命令回显一遍：上面已经摆了命令，结果里不重复
  function outputOf(tl: ToolItem, command: string | null): string {
    const out = tl.output ?? "";
    if (command === null) return out;
    const echo = `$ ${command.trim()}\n`;
    return out.startsWith(echo) ? out.slice(echo.length) : out;
  }

  function onHead() {
    if (kind) openTaskDetail(item.id, kind === "agent" ? item.agent?.id : undefined);
    else item.open = !item.open;
  }
</script>

{#snippet detailOf(tl: ToolItem)}
  {@const pv = toolPreview(tl.name, tl.args)}
  {@const params = pv ? [] : toolParams(tl.args)}
  {#if pv}
    <ApprovalPreview preview={pv} open />
  {:else if params.length}
    <div class="params">
      {#each params as p (p.key)}
        <div class="param">
          <span class="pkey">{p.key}:</span>
          {#if p.chip}<code class="pchip">{p.value}</code>
          {:else if p.code}<span class="pcode">{#if p.prefix}<span class="ppfx">{p.prefix}</span>{/if}{p.value}</span>
          {:else}<span class="pval">{p.value}</span>{/if}
        </div>
      {/each}
    </div>
  {/if}
  {#if tl.output}
    <div class="sec" class:after={Boolean(pv) || params.length > 0}>{t("结果")}</div>
    <pre class="bout sel-text">{outputOf(tl, pv?.kind === "command" ? pv.command : null)}</pre>
  {:else if tl.status === "running" && pane.chat.running}
    <div class="sec dim" class:after={Boolean(pv) || params.length > 0}>{t("运行中…")}</div>
  {/if}
{/snippet}

{#if compact && card}
  <!-- 精简模式的工作流卡：不上量线，卡片本身照旧 -->
  <div class="bcard">{#if tstatus}<WorkflowCard {item} status={tstatus} />{/if}</div>
{:else if compact}
  <RailRow
    bare
    onclick={onHead}
    expanded={kind ? undefined : item.open}
    title={kind ? t("在任务面板中查看") : line.full}
    chev="right"
    open={!kind && item.open}
  >
    {#snippet head()}
      <span class="bverb" class:hx-shimmer={kind ? tstatus === "running" : shownLive} class:bad={failed} use:morphText={verbText}>{verbText}</span>
      {#if kind}
        <span class="bmeta">{toolTaskTitle(item)}</span>
        {#if taskSummary}<span class="btail" class:bad={tstatus === "failed"}>{taskSummary}</span>{/if}
      {:else}
        {#if line.meta}<span class="bmeta" class:mono={line.mono}>{line.meta}</span>{/if}
        {#if ranges}<span class="btail">{ranges}</span>{/if}
        {#if tailWord}<span class="btail" class:warn={anyDenied && !stopped}>{tailWord}</span>{/if}
      {/if}
      {#if SR[tone]}<span class="hx-sr">{t("（{code}）", { code: SR[tone] })}</span>{/if}
    {/snippet}
    {#snippet trail()}{#if runMs >= 2000}<span>{elapsedLabel(runMs)}</span>{/if}{/snippet}

    {#if famRef}
      <button class="famref" title={t("打开这个会话")} onclick={() => void openFamilySession(famRef.id, famRef.agent)}>
        <Icon name="link" size={12} />
        <span class="famref-t">{famRef.title || famRef.id.slice(0, 8)}</span>
        {#if famRef.agent === "claude"}<span class="famref-tag">Claude</span>{/if}
      </button>
    {/if}

    {#if !kind && mounted}
      <div class="bdetail" class:solo={!inGroup} hidden={!item.open} use:reveal={item.open}>
        {#each tools as tl, i (tl.id || i)}
          <div class="bstep" class:sep={i > 0}>{@render detailOf(tl)}</div>
        {/each}
        {#if live && item.progress}
          <div class="live blive">
            {#if item.progress.tail}<div class="tailbox"><pre class="tail sel-text">{item.progress.tail}</pre></div>{/if}
            {#if canBackground}
              <Button variant="ghost" size="sm" loading={bgBusy} onclick={toBackground}>{t("转后台")}</Button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </RailRow>
{:else if card}
  <RailRow {up} {down} nodeY="22px">
    {#snippet node()}<ToolNode {tone} />{/snippet}
    <div class="cardwrap">
      {#if tstatus}<WorkflowCard {item} status={tstatus} />{/if}
    </div>
  </RailRow>
{:else}
  <RailRow
    {up}
    {down}
    onclick={onHead}
    expanded={kind ? undefined : item.open}
    title={kind ? t("在任务面板中查看") : undefined}
    chev={kind ? "right" : "down"}
    open={!kind && item.open}
  >
    {#snippet node()}<ToolNode {tone} />{/snippet}
    {#snippet head()}
      <span class="line" class:task={Boolean(kind)}>
        <span class="verb" class:hx-shimmer={tone === "running"}>{meta.verb}</span>
        {#if kind}
          <span class="arg rich">{toolTaskTitle(item)}</span>
        {:else}
          <span class="arg">{argPreview(item.args)}</span>
        {/if}
      </span>
      {#if kind && taskSummary}
        <span class="sum" class:live={tstatus === "running"} class:bad={tstatus === "failed"}>{taskSummary}</span>
      {/if}
      {#if SR[tone]}<span class="hx-sr">{t("（{code}）", { code: SR[tone] })}</span>{/if}
    {/snippet}

    <!-- U8（kimi K36）：第二行只说结果（「退出码 0 · 12 行输出」「改了 1 处（+3 −1 行）」）——以前挤在第一行最右边，手机上被参数挤没 -->
    {#if !kind && !item.open && item.status !== "running" && outcomeText}
      <div class="outcome" class:bad={item.status === "fail"} class:warn={item.status === "denied"}>{outcomeText}</div>
    {/if}

    {#if famRef}
      <button class="famref" title={t("打开这个会话")} onclick={() => void openFamilySession(famRef.id, famRef.agent)}>
        <Icon name="link" size={12} />
        <span class="famref-t">{famRef.title || famRef.id.slice(0, 8)}</span>
        {#if famRef.agent === "claude"}<span class="famref-tag">Claude</span>{/if}
      </button>
    {/if}

    {#if !kind && live && item.progress}
      <div class="livewrap" transition:collapse>
        <div class="live">
          {#if item.progress.tail}<div class="tailbox"><pre class="tail sel-text">{item.progress.tail}</pre></div>{/if}
          {#if canBackground}
            <Button variant="ghost" size="sm" loading={bgBusy} onclick={toBackground}>{t("转后台")}</Button>
          {/if}
        </div>
      </div>
    {/if}

    {#if !kind && item.open}
      <div class="detailwrap" transition:collapse>
        <!-- U8（ZCode E4）：Edit 改前 / 改后、Write 写入内容、Bash 命令用与权限卡同一个组件摆；别的工具照旧摆参数 -->
        <div class="detail" class:bare={Boolean(preview)}>
          {#if preview}
            <ApprovalPreview {preview} open />
          {:else}
            <div class="sec">{t("参数")}</div>
            <pre class="code sel-text">{JSON.stringify(item.args, null, 2)}</pre>
          {/if}
          {#if item.output}
            <div class="sec after">{t("结果")}</div>
            <pre class="code out sel-text">{shownOutput}</pre>
          {:else if item.status === "running"}
            <div class="sec after dim">{t("运行中…")}</div>
          {/if}
        </div>
      </div>
    {/if}
  </RailRow>
{/if}

<style>
  /* 会话协作：工具行链到的会话（开出来的子会话 / 发消息的对象） */
  .famref {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    margin-top: 2px;
    padding: 1px 0;
    border: 0;
    background: none;
    font: inherit;
    font-size: var(--fs-sm);
    color: var(--text2);
    cursor: pointer;
  }
  .famref-t {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .famref-tag {
    flex: none;
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  @media (hover: hover) {
    .famref:hover .famref-t {
      text-decoration: underline;
      text-underline-offset: 3px;
    }
  }
  .line {
    display: flex;
    align-items: baseline;
    gap: 8px;
    flex: 0 1 auto;
    min-width: 0;
  }
  .line.task {
    flex: 1 1 0;
  }
  /* 字色继承头行（--text2）：不在这里写 color，免得同特异性压掉 .hx-shimmer 的透明字 */
  .verb {
    flex: none;
    font-size: var(--fs-base);
    font-weight: 500;
    white-space: nowrap;
  }
  .arg {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--text3);
  }
  .arg.rich {
    flex: 1 1 0;
    font-family: var(--font-ui);
    font-size: var(--fs-md);
    color: var(--text2);
  }
  /* 可收缩：分栏拖到很窄时（正文列 ~210px）flex:none 会把整行撑出容器 */
  .sum {
    flex: 0 0 auto;
    max-width: 38%;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-sm);
    color: var(--text3);
  }
  .sum.live {
    color: var(--text2);
  }
  .sum.bad {
    color: var(--err);
  }

  /* 运行中的卡片和下一行（通常是活动行）之间留口气 */
  .cardwrap {
    padding: 2px 0 8px;
  }

  /* U8（K36）：第二行只说结果——对齐到动词，一行放不下就省略 */
  .outcome {
    margin-top: -4px;
    padding-bottom: 3px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-md);
    line-height: 18px;
    color: var(--text3);
  }
  .outcome.bad {
    color: color-mix(in srgb, var(--err) 85%, var(--text3));
  }
  .outcome.warn {
    color: color-mix(in srgb, var(--warn) 85%, var(--text3));
  }

  /* R14：运行中的实时尾行（贴底：新行在下，旧行从上沿淡出）+「转后台」 */
  .livewrap {
    padding: 2px 0 6px;
  }
  .live {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 6px;
  }
  .tailbox {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    max-width: 100%;
    max-height: calc(7 * 1.45 * var(--fs-xs) + 14px);
    padding: 8px 10px 6px;
    overflow: hidden;
    border-radius: var(--r-sm);
    background: var(--code-bg);
    -webkit-mask-image: linear-gradient(to bottom, transparent 0, black 8px);
    mask-image: linear-gradient(to bottom, transparent 0, black 8px);
  }
  .tail {
    flex: none;
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 1.45;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--text2);
  }

  /* 展开的详情面板：一块安静的凹面 */
  .detailwrap {
    padding: 2px 0 8px;
  }
  .detail {
    min-width: 0;
    padding: 10px 12px 12px;
    border-radius: var(--r-md);
    background: var(--code-bg);
  }
  /* 执行事实（ApprovalPreview）自带代码块：外面不再套一层同色凹面（两层内边距叠起来，命令会比结果缩进一截），
     结果也各自成块，和权限卡里看到的一模一样 */
  .detail.bare {
    padding: 0;
    border-radius: 0;
    background: none;
  }
  .bare .sec.after {
    margin-top: 10px;
  }
  .bare .out {
    padding: 8px 12px;
    border-radius: 10px;
    background: var(--code-bg);
  }
  .sec {
    margin-bottom: 5px;
    font-size: var(--fs-xs);
    font-weight: 500;
    letter-spacing: 0.04em;
    color: var(--text3);
  }
  .sec.after {
    margin-top: 12px;
  }
  .sec.dim {
    margin-bottom: 0;
    font-weight: 400;
    letter-spacing: 0;
  }
  .code {
    margin: 0;
    max-height: 300px;
    overflow: auto;
    overscroll-behavior: contain;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text);
  }

  /* ── 精简模式：Claude 式单行 ── */
  .bcard {
    padding: 2px 0 6px;
  }
  /* 字色继承头行（--text2，悬停提亮）：不写 color，免得压掉 .hx-shimmer 的透明字 */
  .bverb {
    flex: none;
    white-space: nowrap;
  }
  .bverb.bad {
    color: var(--err);
  }
  /* 目标：路径 / 命令 / 搜索式用等宽、墨色（扫一眼认得出碰了哪个文件）；别的跟随行色 */
  .bmeta {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bmeta.mono {
    font-family: var(--font-mono);
    font-size: var(--fs-md);
    color: var(--text);
  }
  .btail {
    flex: none;
    white-space: nowrap;
    color: var(--text3);
  }
  .btail.bad {
    color: var(--err);
  }
  .btail.warn {
    color: color-mix(in srgb, var(--warn) 85%, var(--text3));
  }
  .bdetail[hidden] {
    display: none;
  }
  .bdetail {
    min-width: 0;
    padding: 2px 0 6px;
  }
  /* 单独一行时套一圈细线小卡（组里的步已经在组的卡里，不再套） */
  .bdetail.solo {
    margin: 2px 0 6px;
    padding: 10px 12px;
    border-radius: var(--r-sm);
    box-shadow: 0 0 0 1px var(--border);
  }
  .bstep.sep {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid var(--border);
  }
  .params {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    font-size: var(--fs-md);
    line-height: 18px;
    color: var(--text2);
  }
  .param {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .pkey {
    margin-right: 4px;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--text3);
  }
  .pchip {
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--surface2);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--text);
    word-break: break-all;
  }
  .pcode {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 17px;
    white-space: pre-wrap;
    word-break: break-all;
    color: var(--text);
  }
  .ppfx {
    user-select: none;
    color: var(--text3);
  }
  .pval {
    white-space: pre-wrap;
  }
  .bout {
    margin: 0;
    max-height: 300px;
    padding: 8px 10px;
    overflow: auto;
    overscroll-behavior: contain;
    border-radius: var(--r-xs);
    background: var(--code-bg);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text);
  }
  .blive {
    margin-top: 8px;
  }
</style>
