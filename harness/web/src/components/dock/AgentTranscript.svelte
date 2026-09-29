<script module lang="ts">
  import * as api from "../../lib/api.ts";

  // 工作流日志明细按「会话:工作流」缓存一次（同一工作流里点开别的 agent 不再拉）；失败不缓存。
  const detailCache = new Map<string, Promise<{ agents: Record<string, any> }>>();
  function loadDetail(sessionId: string, wfId: string) {
    const key = `${sessionId}:${wfId}`;
    let p = detailCache.get(key);
    if (!p) {
      p = api.workflowDetail(sessionId, wfId);
      detailCache.set(key, p);
      p.catch(() => detailCache.delete(key));
    }
    return p;
  }
</script>

<script lang="ts">
  // 子 agent 转录视图（bridge Claude 分页 AgentTranscript = 官方 /code 页侧栏 DH 的 dimensio 版）：
  // 模型行 / prompt 气泡 / 工具步骤 / 结构化结果 / 答复正文（markdown）/ 运行中实况 / 底部状态行
  //「子 agent · 已完成 · tok · 工具调用 · 时长」。
  //
  // 数据：直播时就是时间线上的 AgentRun（subagent_* 事件实时写）；历史里 Agent 工具的 run 从 tool_result.meta 重建。
  // 工作流里的 agent 只有摘要——明细在工作流日志里，这里按需拉，拉到的留在组件本地，不回写时间线。
  import { toolMeta } from "../../lib/icons.ts";
  import { renderMarkdown } from "../../lib/markdown.ts";
  import { handleCopyClick } from "../../lib/copy-click.ts";
  import { app, type AgentRun, type AgentStep, type ToolItem } from "../../lib/state.svelte.ts";
  import { STATUS_LABEL, fmtTokens, modelShort, runElapsed, type TaskStatus } from "../../lib/tasks.ts";
  import { t, tc, tr } from "../../lib/i18n.ts";
  import Icon from "../ui/Icon.svelte";
  import Mark from "../brand/Mark.svelte";

  let { run, tool, running = false }: { run: AgentRun; tool: ToolItem; running?: boolean } = $props();

  const wfId = $derived(tool.workflow?.id ?? "");
  const sessionId = $derived(app.chat.id ?? "");
  const needFetch = $derived(!running && Boolean(wfId) && Boolean(sessionId) && !run.steps.length && !run.text && run.result === undefined);
  let detail = $state<{ state: "idle" | "loading" | "ok" | "none" | "error"; data?: any }>({ state: "idle" });
  $effect(() => {
    if (!needFetch) return;
    const agentId = run.id;
    let dead = false;
    detail = { state: "loading" };
    loadDetail(sessionId, wfId).then(
      (d) => {
        if (dead) return;
        const a = d?.agents?.[agentId];
        detail = a ? { state: "ok", data: a } : { state: "none" };
      },
      (e) => {
        if (!dead) detail = { state: e?.status === 404 ? "none" : "error" };
      },
    );
    return () => {
      dead = true;
    };
  });
  const d = $derived(needFetch && detail.state === "ok" ? detail.data : null);

  const prompt = $derived(run.prompt || d?.prompt || (tool.agent === run && typeof tool.args?.prompt === "string" ? tool.args.prompt : ""));
  const model = $derived(run.model || d?.model || "");
  const steps = $derived<AgentStep[]>(
    run.steps.length
      ? run.steps
      : (Array.isArray(d?.trail) ? d.trail : []).map((s: any, i: number) => ({
          id: `t${i}`,
          name: String(s?.name ?? ""),
          arg: String(s?.arg ?? ""),
          status: s?.ok ? "ok" : "fail",
          summary: String(s?.summary ?? ""),
        })),
  );
  const text = $derived(run.text || d?.text || "");
  const result = $derived(run.result !== undefined ? run.result : d?.result);
  const resultText = $derived(result === undefined ? "" : JSON.stringify(result, null, 2));
  const error = $derived(run.error || d?.error || "");
  const status = $derived<TaskStatus>(
    running ? "running" : run.status === "ok" ? "completed" : run.status === "running" || /abort/i.test(error) ? "stopped" : "failed",
  );

  let now = $state(Date.now());
  $effect(() => {
    if (!running) return;
    now = Date.now();
    const id = setInterval(() => {
      if (!document.hidden) now = Date.now();
    }, 1000);
    return () => clearInterval(id);
  });
  const statusLine = $derived.by(() => {
    const parts = [t("子 agent"), STATUS_LABEL[status]];
    const tk = fmtTokens(run.tokens || (d ? Number(d.inputTokens ?? 0) + Number(d.outputTokens ?? 0) : 0));
    if (tk) parts.push(`${tk} tok`);
    const calls = run.toolCalls ?? d?.toolCalls ?? steps.length;
    if (calls) parts.push(t("{n} 次工具调用", { n: calls }));
    const el = runElapsed(run, running, now);
    if (el) parts.push(el);
    return parts.join(" · ");
  });
  const liveStep = $derived(running && steps.length ? steps[steps.length - 1] : null);

  // 答复里代码块的「复制」（markdown 产出的 data-copy 按钮；Feed 之外这里也要接上，以前点了没反应）
  function copyDelegate(node: HTMLElement) {
    node.addEventListener("click", handleCopyClick);
    return { destroy: () => node.removeEventListener("click", handleCopyClick) };
  }
</script>

<div class="tr">
  {#if model}
    <p class="model">
      <!-- 分隔符写成表达式：{#if} 块里的前导空格会被 Svelte 吞掉 -->
      {t("模型")} <span class="mono t2" title={model}>{modelShort(model)}</span>{run.tier ? ` · ${run.tier}` : ""}{run.cached ? ` · ${t("来自日志")}` : ""}
    </p>
  {/if}
  {#if prompt}
    <div class="user"><div class="bubble">{prompt}</div></div>
  {/if}

  {#if steps.length}
    <div class="steps">
      {#each steps as s (s.id)}
        {@const m = toolMeta(s.name)}
        <div class="step">
          <span class="sq" class:ok={s.status === "ok"} class:bad={s.status === "fail" || s.status === "denied"} class:run={s.status === "running"}></span>
          <span class="sic"><Icon name={m.icon} size={13} /></span>
          <span class="verb">{m.verb}</span>
          <span class="arg">{s.arg}</span>
          {#if s.summary}<span class="sum" title={tr(s.summary)}>{tr(s.summary)}</span>{/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if resultText}
    <div class="sec">{t("结构化结果")}</div>
    <pre class="code">{resultText}</pre>
  {/if}
  {#if text}
    <div class="sec">{running ? t("进行中") : resultText ? tc("dimensio", "说明") : t("答复")}</div>
    <div class="md answer" use:copyDelegate>{@html renderMarkdown(text)}</div>
  {/if}
  {#if error}<p class="err">{tr(error)}</p>{/if}

  {#if running}
    <div class="live">
      <Mark size={14} live />
      <span class="hx-shimmer">{liveStep ? t("第 {n} 步 · {x}", { n: steps.length, x: toolMeta(liveStep.name).verb }) : t("启动中…")}</span>
    </div>
  {:else if needFetch && (detail.state === "loading" || detail.state === "idle")}
    <div class="note"><Mark size={14} live /><span>{t("正在读取转录…")}</span></div>
  {:else if !steps.length && !text && !resultText && !error}
    <div class="note">
      {needFetch && detail.state === "none"
        ? t("这次运行没有留下明细（旧版本的运行，或日志已清理）")
        : needFetch && detail.state === "error"
          ? t("读取转录失败")
          : t("还没有活动")}
    </div>
  {/if}

  <p class="status">{statusLine}</p>
</div>

<style>
  .tr {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .model {
    margin: 0;
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--text3);
  }
  .mono {
    font-family: var(--font-mono);
  }
  .t2 {
    color: var(--text2);
  }
  .user {
    display: flex;
    justify-content: flex-end;
  }
  /* prompt 气泡 = 对话里用户消息的样子 */
  .bubble {
    max-width: 92%;
    max-height: 260px;
    overflow: auto;
    padding: 9px 14px;
    border-radius: 18px;
    background: var(--user-bubble);
    color: var(--on-user-bubble);
    font-size: var(--fs-md);
    line-height: 1.6;
    white-space: pre-wrap;
  }

  .steps {
    display: flex;
    flex-direction: column;
    padding: 4px 0;
  }
  .step {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 26px;
    min-width: 0;
    font-size: var(--fs-sm);
  }
  .sq {
    flex: none;
    width: 6px;
    height: 6px;
    border-radius: 1.5px;
    background: var(--border2);
  }
  .sq.ok {
    background: color-mix(in srgb, var(--text) 30%, transparent);
  }
  .sq.bad {
    background: var(--err);
  }
  .sq.run {
    background: var(--live);
    animation: hx-breathe 1.2s var(--ease-in-out) infinite;
  }
  .sic {
    flex: none;
    display: inline-flex;
    color: var(--text3);
  }
  .verb {
    flex: none;
    color: var(--text);
  }
  .arg {
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  .sum {
    flex: 0 1 auto;
    max-width: 40%;
    margin-left: auto;
    padding-left: 8px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--fs-xs);
    color: var(--text3);
  }

  .sec {
    margin-bottom: -6px;
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  .code {
    margin: 0;
    max-height: 320px;
    overflow: auto;
    padding: 10px 12px;
    border-radius: var(--r-md);
    background: var(--code-bg);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.55;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
  }
  .answer {
    min-width: 0;
    font-size: var(--fs-base);
    color: var(--text);
    user-select: text;
  }
  .err {
    margin: 0;
    font-size: var(--fs-md);
    line-height: 1.6;
    color: var(--err);
    white-space: pre-wrap;
  }
  .live,
  .note {
    display: flex;
    align-items: center;
    gap: 9px;
    font-size: var(--fs-md);
    color: var(--text3);
  }
  .live {
    color: var(--text2);
  }
  .status {
    margin: 6px 0 0;
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--text3);
    font-variant-numeric: tabular-nums;
  }

  @media (prefers-reduced-motion: reduce) {
    .sq.run {
      animation: none;
    }
  }
</style>
