<script lang="ts">
  // 工具行：量线上一个节点 + 动词 + 参数摘要（mono，单行省略）；第二行只说结果；运行中的前台 Bash 在下面摆实时尾行；
  // 点开 = 用 collapse 长出详情面板（参数 / 执行事实 / 输出）。
  //
  // Agent / Workflow 行对齐 bridge Claude 分页（= 官方 /code 页）：不做行内展开，点开进右侧工作区的「任务」视图
  //（工作流 → 详细卡；Agent → 直接压上子 agent 转录）。运行中且不在工具组里时整行换成卡片：工作流 = 紧凑卡（agent 点阵），
  // 子 agent 还没开始动 = 任务卡；其余时刻是带实况摘要（模型 · 当前步骤 · 步数 / 阶段 · 完成数 / agent 数 · tok · 时长）的工具行。
  //
  // 「在跑」只在这一轮真的还在跑时成立：停止之后（或断流收尾）还挂着 running 的行没等到结果，按「被打断」画成灰叉，
  // 不再转 / 不再亮卡片、不再摆尾行（spec-A ⚠10 同源）。
  import { openTaskDetail, toast, type ToolItem } from "../../lib/state.svelte.ts";
  import * as api from "../../lib/api.ts";
  import { toolMeta } from "../../lib/icons.ts";
  import { toolPreview } from "../../lib/tool-preview.ts";
  import { STATUS_LABEL, fmtDur, fmtTokens, modelShort, toolTaskKind, toolTaskStatus, toolTaskTitle, type TaskStatus } from "../../lib/tasks.ts";
  import { collapse } from "../../lib/motion.ts";
  import Button from "../ui/Button.svelte";
  import ApprovalPreview from "../cards/ApprovalPreview.svelte";
  import RailRow from "./RailRow.svelte";
  import ToolNode, { type NodeTone } from "./ToolNode.svelte";
  import WorkflowCard from "./WorkflowCard.svelte";
  import AgentTaskCard from "./AgentTaskCard.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t, tr } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let {
    item,
    inGroup = false,
    up = false,
    down = false,
  }: { item: ToolItem; inGroup?: boolean; up?: boolean; down?: boolean } = $props();

  const meta = $derived(toolMeta(item.name));
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
  const card = $derived.by(() => {
    if (!kind || inGroup || tstatus !== "running") return "";
    if (kind === "workflow") return "workflow";
    return item.agent?.steps.length ? "" : "agent";
  });
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

  function onHead() {
    if (kind) openTaskDetail(item.id, kind === "agent" ? item.agent?.id : undefined);
    else item.open = !item.open;
  }

  function argPreview(a: any): string {
    if (!a || typeof a !== "object") return "";
    if (a.command) return String(a.command);
    if (a.path) return String(a.path);
    if (a.file_path) return String(a.file_path);
    if (a.pattern) return String(a.pattern);
    if (a.url) return String(a.url);
    if (a.query) return String(a.query);
    if (a.prompt) return String(a.prompt);
    if (a.todos) return t("{n} 项", { n: a.todos.length });
    // 计划：摆第一条不是标题的正文（整份计划在卡片里）；提问：摆第一个问题
    if (typeof a.plan === "string") {
      const line = a.plan.split("\n").map((s: string) => s.trim()).find((s: string) => s && !s.startsWith("#")) ?? "";
      return line.replace(/[`*_]/g, "");
    }
    if (Array.isArray(a.questions)) {
      const q = String(a.questions[0]?.question ?? "");
      return a.questions.length > 1 ? t("{q} 等 {n} 个问题", { q, n: a.questions.length }) : q;
    }
    if (a.action) return [a.action, a.serviceId ?? a.name ?? ""].filter(Boolean).join(" ");
    // E2：MCP 网关（McpDescribe / McpCall）——连接器.工具 + 参数
    if (typeof a.server === "string") {
      const args = a.arguments && typeof a.arguments === "object" ? JSON.stringify(a.arguments) : "";
      return `${[a.server, a.tool].filter(Boolean).join(".")}${args && args !== "{}" ? ` ${args.slice(0, 80)}` : ""}`;
    }
    const s = JSON.stringify(a);
    return s === "{}" ? "" : s.slice(0, 100);
  }
</script>

{#if card}
  <RailRow {up} {down} nodeY="22px">
    {#snippet node()}<ToolNode tone="running" />{/snippet}
    <div class="cardwrap">
      {#if card === "workflow"}<WorkflowCard {item} />{:else}<AgentTaskCard {item} />{/if}
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

    {#if !kind && live && item.progress}
      <div class="livewrap" transition:collapse>
        <div class="live">
          {#if item.progress.tail}<div class="tailbox"><pre class="tail">{item.progress.tail}</pre></div>{/if}
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
            <pre class="code">{JSON.stringify(item.args, null, 2)}</pre>
          {/if}
          {#if item.output}
            <div class="sec after">{t("结果")}</div>
            <pre class="code out">{shownOutput}</pre>
          {:else if item.status === "running"}
            <div class="sec after dim">{t("运行中…")}</div>
          {/if}
        </div>
      </div>
    {/if}
  </RailRow>
{/if}

<style>
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
</style>
