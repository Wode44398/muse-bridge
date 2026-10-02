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

  // 过程多于这么多步、且点开时已经跑完：默认收着（先看结果），点开再看
  const STEPS_FOLD = 8;
</script>

<script lang="ts">
  // 子 agent 面板：工作区「任务」里压在列表之上的那一页（结构照 bridge Claude 分页的 Agent 转录面板 = 官方 /code 页侧栏 DH，
  // 样子是 dimensio 自己的）。从上到下：
  //   概览 —— 状态（记号 + 词，在跑 = 微光）/「子 agent · 档位 · 模型」/ 四格读数：用时 · tokens · 工具调用 · 回合
  //   提示词 —— 派给它的原话：超过 8 行收着（底部渐隐、点开放全），带字数与复制
  //   过程 —— 一步一行（状态格 + 图标 + 动词 + 参数 + 结果）；点开时已跑完且多于 8 步就先收着
  //   正在写 —— 在跑时这一回合正在流的正文
  //   改动的文件 —— coder 档改过 / 新建的文件，可跳去「审阅」
  //   结果 —— 结构化结果（JSON）/ 答复（markdown）/ 出错与没做完的原因
  //   末行 —— 在跑时的此刻一步（标志在转）；读转录 / 没有明细的提示
  //
  // 数据：直播时就是时间线上的 AgentRun（subagent_* 事件实时写）；历史里 Agent 工具的 run 从 tool_result.meta 重建。
  // 工作流里的 agent 只有摘要——明细在工作流日志里，这里按需拉，拉到的留在组件本地，不回写时间线。
  // 跟随：在跑、且本来就停在底部时，新的一步进来继续贴底；在读上面的提示词 / 旧步骤时不打扰。
  import { tick, untrack } from "svelte";
  import { toolMeta } from "../../lib/icons.ts";
  import { renderMarkdown } from "../../lib/markdown.ts";
  import { handleCopyClick } from "../../lib/copy-click.ts";
  import { app, setDockTool, toast, type AgentRun, type AgentStep, type ToolItem } from "../../lib/state.svelte.ts";
  import { STATUS_LABEL, agentDotState, fmtTokens, modelShort, runElapsed, type TaskStatus } from "../../lib/tasks.ts";
  import { collapse } from "../../lib/motion.ts";
  import { haptic } from "../../lib/touch.ts";
  import { t, tc, tr } from "../../lib/i18n.ts";
  import Icon from "../ui/Icon.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Mark from "../brand/Mark.svelte";
  import StatusGlyph, { type Glyph } from "./StatusGlyph.svelte";

  let {
    run,
    tool,
    running = false,
    scroller,
  }: { run: AgentRun; tool: ToolItem; running?: boolean; scroller?: HTMLElement } = $props();

  const coarse = matchMedia("(pointer: coarse)").matches; // 触屏：复制钮放大到能按准

  // —— 工作流 agent 的明细（按需拉）——
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
  const stepFails = $derived(steps.filter((s) => s.status === "fail" || s.status === "denied").length);
  const text = $derived(run.text || d?.text || "");
  const result = $derived(run.result !== undefined ? run.result : d?.result);
  const resultText = $derived(result === undefined ? "" : JSON.stringify(result, null, 2));
  const error = $derived(run.error || d?.error || "");
  const edited = $derived<string[]>(run.editedFiles ?? (Array.isArray(d?.editedFiles) ? d.editedFiles : []));
  const status = $derived<TaskStatus>(
    running ? "running" : run.status === "ok" ? "completed" : run.status === "running" || /abort/i.test(error) ? "stopped" : "failed",
  );

  // —— 概览 ——
  let now = $state(Date.now());
  $effect(() => {
    if (!running) return;
    now = Date.now();
    const id = setInterval(() => {
      if (!document.hidden) now = Date.now();
    }, 1000);
    return () => clearInterval(id);
  });
  const suspended = $derived(running && !!run.suspendedUntil && now < run.suspendedUntil);
  const stalled = $derived(running && !suspended && agentDotState(run, { now }) === "stalled");
  const glyph = $derived<Glyph>(
    suspended || stalled ? "stalled" : running ? "running" : status === "completed" ? "done" : status === "failed" ? "failed" : "stopped",
  );
  const statusWord = $derived(suspended ? t("限流挂起") : stalled ? t("久无动静") : STATUS_LABEL[status]);
  const calls = $derived(run.toolCalls ?? d?.toolCalls ?? steps.length);
  const turns = $derived(run.turns || Number(d?.turns ?? 0));
  const stats = $derived([
    { k: t("用时"), v: runElapsed(run, running, now) },
    { k: "tokens", v: fmtTokens(run.tokens || (d ? Number(d.inputTokens ?? 0) + Number(d.outputTokens ?? 0) : 0)) },
    { k: t("工具调用"), v: calls ? String(calls) : "" },
    { k: t("回合"), v: turns ? String(turns) : "" },
  ]);
  // 没做完的原因（服务端的 stopReason：回合预算用尽 / 被限流到截止 / provider 出错 / 没交结构化结果）——只在失败时补一句人话
  const STOP_WORD: Record<string, string> = {
    budget_exhausted: t("回合用尽，没做完"),
    rate_limited: t("一直被限流，没等到恢复"),
    provider_error: t("模型服务出错"),
    no_result: t("没交出结构化结果"),
  };
  const stopNote = $derived(status === "failed" && run.stopReason ? (STOP_WORD[run.stopReason] ?? "") : "");

  // —— 提示词：超过 8 行收着 ——
  let promptOpen = $state(false);
  let promptEl = $state<HTMLElement>();
  let promptOverflow = $state(false);
  $effect(() => {
    void prompt;
    const el = promptEl;
    const opened = promptOpen;
    if (!el) return;
    const measure = () => {
      promptOverflow = opened || el.scrollHeight > el.clientHeight + 2;
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });
  let copied = $state("");
  let copyTimer = 0;
  function copy(what: string, value: string) {
    if (!value) return;
    haptic("light");
    void navigator.clipboard?.writeText(value).then(
      () => {
        copied = what;
        clearTimeout(copyTimer);
        copyTimer = window.setTimeout(() => (copied = ""), 1400);
      },
      () => toast(t("复制失败")),
    );
  }
  $effect(() => () => clearTimeout(copyTimer));

  // —— 过程：点开时在跑 = 一直展开（跑完也不在眼前合上）；点开时已跑完且步数多 = 先收着 ——
  const openedLive = untrack(() => running);
  let stepsUser = $state<boolean | null>(null);
  const stepsOpen = $derived(stepsUser ?? (openedLive || steps.length <= STEPS_FOLD));
  const liveStep = $derived(running && steps.length ? steps[steps.length - 1] : null);

  // 改动的文件：只露最后三段，全路径在悬停提示里
  const shortPath = (p: string) => {
    const segs = p.split(/[\\/]+/).filter(Boolean);
    return segs.length > 3 ? `…/${segs.slice(-3).join("/")}` : segs.join("/");
  };

  // —— 跟随：在跑、且本来就贴着底，新内容进来继续贴底 ——
  let stick = false;
  $effect.pre(() => {
    void steps.length;
    void text;
    const sc = scroller;
    stick = !!sc && sc.scrollHeight - sc.scrollTop - sc.clientHeight < 48;
  });
  $effect(() => {
    void steps.length;
    void text;
    if (!untrack(() => running) || !stick) return;
    void tick().then(() => {
      const sc = scroller;
      if (sc) sc.scrollTop = sc.scrollHeight;
    });
  });

  // 答复里代码块的「复制」（markdown 产出的 data-copy 按钮）
  function copyDelegate(node: HTMLElement) {
    node.addEventListener("click", handleCopyClick);
    return { destroy: () => node.removeEventListener("click", handleCopyClick) };
  }
</script>

<div class="ap">
  <!-- 概览 -->
  <header class="ov">
    <div class="st">
      <StatusGlyph kind={glyph} label={statusWord} />
      <span class="st-w" class:hx-shimmer={running && !suspended && !stalled} class:bad={status === "failed"} class:warn={suspended || stalled}>{statusWord}</span>
      {#if stopNote}<span class="st-n">{stopNote}</span>{/if}
    </div>
    <p class="who">
      <!-- 分隔符写成表达式：{#if} 块里的前导空格会被 Svelte 吞掉 -->
      <span>{tool.workflow ? t("工作流 agent") : t("子 agent")}</span>{#if run.phase}<span>{run.phase}</span>{/if}<span class="tier" class:coder={run.tier === "coder"}>{run.tier}</span>{#if model}<span class="mono" title={model}>{modelShort(model)}</span>{/if}{#if run.cached}<span>{t("来自日志")}</span>{/if}
    </p>
    {#if suspended && run.suspendReason}<p class="hint">{tr(run.suspendReason)}</p>{/if}
    <dl class="stats">
      {#each stats as s (s.k)}
        <div class="stat">
          <dd class:nil={!s.v}>{s.v || "—"}</dd>
          <dt>{s.k}</dt>
        </div>
      {/each}
    </dl>
  </header>

  {#if prompt}
    <section class="sec">
      <div class="sh">
        <span class="sh-t">{t("提示词")}</span>
        <span class="sh-n">{t("{n} 字", { n: prompt.length })}</span>
        <span class="sh-a">
          <IconButton icon={copied === "prompt" ? "check" : "copy"} label={copied === "prompt" ? t("已复制") : t("复制提示词")} size={coarse ? 36 : 28} onclick={() => copy("prompt", prompt)} />
        </span>
      </div>
      <div class="prompt" class:clamp={!promptOpen} class:fadeout={!promptOpen && promptOverflow} bind:this={promptEl}>{prompt}</div>
      {#if promptOverflow}
        <button class="more" aria-expanded={promptOpen} onclick={() => (promptOpen = !promptOpen)}>
          <span class="chev" class:down={promptOpen}><Icon name="chevronR" size={12} stroke={1.9} /></span>
          <span>{promptOpen ? t("收起") : t("展开完整提示词")}</span>
        </button>
      {/if}
    </section>
  {/if}

  {#if steps.length}
    <section class="sec">
      <button class="sh fold" aria-expanded={stepsOpen} onclick={() => (stepsUser = !stepsOpen)}>
        <span class="chev" class:down={stepsOpen}><Icon name="chevronR" size={12} stroke={1.9} /></span>
        <span class="sh-t">{t("过程")}</span>
        <span class="sh-n">{t("{n} 步", { n: steps.length })}</span>
        {#if stepFails}<span class="sh-n bad">{t("{n} 失败", { n: stepFails })}</span>{/if}
      </button>
      {#if stepsOpen}
        <div in:collapse out:collapse>
          <ol class="steps">
            {#each steps as s (s.id)}
              {@const m = toolMeta(s.name)}
              <li class="step">
                <span class="sq" class:ok={s.status === "ok"} class:bad={s.status === "fail" || s.status === "denied"} class:run={s.status === "running" && running}></span>
                <span class="sic"><Icon name={m.icon} size={13} /></span>
                <span class="verb">{m.verb}</span>
                <span class="arg">{s.arg}</span>
                {#if s.summary}<span class="sum" class:bad={s.status === "fail" || s.status === "denied"} title={tr(s.summary)}>{tr(s.summary)}</span>{/if}
              </li>
            {/each}
          </ol>
        </div>
      {/if}
    </section>
  {/if}

  {#if running && text}
    <section class="sec">
      <div class="sh"><span class="sh-t">{t("正在写")}</span></div>
      <div class="md answer" use:copyDelegate>{@html renderMarkdown(text)}</div>
    </section>
  {/if}

  {#if edited.length}
    <section class="sec">
      <div class="sh">
        <span class="sh-t">{t("改动的文件")}</span>
        <span class="sh-n">{edited.length}</span>
        <span class="sh-a"><button class="link" onclick={() => setDockTool("review")}>{t("去审阅")}</button></span>
      </div>
      <ul class="files">
        {#each edited as p (p)}
          <li title={p}><span class="fic"><Icon name="fileDiff" size={13} /></span><span class="fp">{shortPath(p)}</span></li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if resultText}
    <section class="sec">
      <div class="sh">
        <span class="sh-t">{t("结构化结果")}</span>
        <span class="sh-a">
          <IconButton icon={copied === "result" ? "check" : "copy"} label={copied === "result" ? t("已复制") : t("复制结果")} size={coarse ? 36 : 28} onclick={() => copy("result", resultText)} />
        </span>
      </div>
      <pre class="code">{resultText}</pre>
    </section>
  {/if}
  {#if !running && text}
    <section class="sec">
      <div class="sh"><span class="sh-t">{resultText ? tc("dimensio", "说明") : t("答复")}</span></div>
      <div class="md answer" use:copyDelegate>{@html renderMarkdown(text)}</div>
    </section>
  {/if}
  {#if error}
    <div class="errbox" class:soft={status === "stopped"}>
      <span class="eh">{status === "stopped" ? t("已停止") : t("错误")}</span>
      <span class="eb">{tr(error)}</span>
    </div>
  {/if}

  {#if running}
    <!-- 过程展开着时，最后一行那一步自己在呼吸，不再重复一遍；收着 / 还没动手时才摆这一行 -->
    {#if !liveStep}
      <div class="live"><Mark size={14} live /><span class="lv hx-shimmer">{t("启动中…")}</span></div>
    {:else if !stepsOpen}
      <div class="live">
        <Mark size={14} live />
        <span class="lv hx-shimmer">{t("第 {n} 步 · {x}", { n: steps.length, x: toolMeta(liveStep.name).verb })}</span>
        {#if liveStep.arg}<span class="arg">{liveStep.arg}</span>{/if}
      </div>
    {/if}
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
</div>

<style>
  .ap {
    display: flex;
    flex-direction: column;
    gap: 18px;
    min-width: 0;
    overflow-wrap: anywhere;
    container-type: inline-size;
  }
  .bad {
    color: var(--err);
  }
  .mono {
    font-family: var(--font-mono);
  }

  /* —— 概览 —— */
  .ov {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .st {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
    color: var(--text);
  }
  .st-w {
    font-size: var(--fs-lg);
    font-weight: 600;
    line-height: 24px;
  }
  .st-w.warn {
    color: var(--warn);
  }
  .st-n {
    min-width: 0;
    font-size: var(--fs-sm);
    color: var(--text3);
  }
  .who {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    margin: 0;
    font-size: var(--fs-sm);
    line-height: 18px;
    color: var(--text3);
  }
  .who > span + span::before {
    content: "·";
    margin: 0 6px;
    color: var(--text3);
  }
  .who .mono,
  .who .tier.coder {
    color: var(--text2);
  }
  .hint {
    margin: 0;
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--warn);
  }
  /* 四格读数：数字在上（等宽）、名目在下，格与格之间一根细线——尺寸线的读数 */
  .stats {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    margin: 8px 0 0;
    padding: 10px 0;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
  }
  .stat {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    padding: 0 10px;
  }
  .stat:first-child {
    padding-left: 2px;
  }
  .stat + .stat {
    border-left: 1px solid var(--border);
  }
  .stat dd {
    margin: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    font-weight: 500;
    line-height: 20px;
    font-variant-numeric: tabular-nums;
    color: var(--text);
  }
  .stat dd.nil {
    color: var(--text3);
    font-weight: 400;
  }
  .stat dt {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--fs-xs);
    line-height: 15px;
    color: var(--text3);
  }

  /* —— 分节 —— */
  .sec {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .sh {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 28px;
    min-width: 0;
    text-align: left;
  }
  .sh.fold {
    align-self: flex-start;
    gap: 6px;
    margin-left: -6px;
    padding: 0 8px 0 4px;
    border-radius: var(--r-xs);
    transition: background-color var(--t-fast) var(--ease);
  }
  .sh-t {
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text2);
  }
  .sh-n {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
    color: var(--text3);
  }
  .sh-n.bad {
    color: var(--err);
  }
  .sh-a {
    display: inline-flex;
    margin-left: auto;
  }
  .chev {
    flex: none;
    display: inline-flex;
    color: var(--text3);
    transition: transform var(--t-med) var(--ease-out);
  }
  .chev.down {
    transform: rotate(90deg);
  }
  .link {
    height: 28px;
    padding: 0 8px;
    border-radius: var(--r-xs);
    font-size: var(--fs-sm);
    color: var(--text2);
    text-decoration: underline;
    text-decoration-color: var(--border2);
    text-underline-offset: 3px;
    transition: background-color var(--t-fast) var(--ease);
  }

  /* 提示词：一块安静的凹面，收着时 8 行、底部渐隐 */
  .prompt {
    padding: 10px 12px;
    border-radius: var(--r-md);
    background: var(--surface2);
    font-size: var(--fs-md);
    line-height: 1.6;
    color: var(--text);
    white-space: pre-wrap;
    user-select: text;
  }
  .prompt.clamp {
    max-height: calc(1.6em * 8 + 20px);
    overflow: hidden;
  }
  .prompt.fadeout {
    -webkit-mask-image: linear-gradient(to bottom, black 58%, transparent);
    mask-image: linear-gradient(to bottom, black 58%, transparent);
  }
  .more {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    align-self: flex-start;
    height: 26px;
    margin-left: -4px;
    padding: 0 8px 0 4px;
    border-radius: var(--r-xs);
    font-size: var(--fs-sm);
    color: var(--text3);
    transition: background-color var(--t-fast) var(--ease);
  }

  /* 过程：一步一行 */
  .steps {
    list-style: none;
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0 0 0 2px;
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
  .sum.bad {
    color: color-mix(in srgb, var(--err) 85%, var(--text3));
  }

  /* 改动的文件 */
  .files {
    list-style: none;
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0 0 0 2px;
  }
  .files li {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 24px;
    min-width: 0;
  }
  .fic {
    flex: none;
    display: inline-flex;
    color: var(--text3);
  }
  .fp {
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text2);
    user-select: text;
  }

  /* 结果 */
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
  .errbox {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 8px 10px 9px;
    border-radius: var(--r-sm);
    background: color-mix(in srgb, var(--err) 9%, transparent);
  }
  .errbox.soft {
    background: var(--surface2);
  }
  .eh {
    font-size: var(--fs-xs);
    color: var(--err);
  }
  .errbox.soft .eh {
    color: var(--text3);
  }
  .eb {
    max-height: 160px;
    overflow-y: auto;
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--text2);
    white-space: pre-wrap;
    user-select: text;
  }

  .live,
  .note {
    display: flex;
    align-items: center;
    gap: 9px;
    min-width: 0;
    font-size: var(--fs-md);
    color: var(--text3);
  }
  .live {
    color: var(--text2);
  }
  .lv {
    flex: none;
    white-space: nowrap;
  }

  .sh.fold:active,
  .more:active,
  .link:active {
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  @media (hover: hover) {
    .sh.fold:hover,
    .more:hover,
    .link:hover {
      background: color-mix(in srgb, var(--text) 4%, transparent);
    }
  }
  /* 触屏：开关与链接放大到能按准 */
  @media (pointer: coarse) {
    .sh.fold,
    .more,
    .link {
      height: 36px;
    }
    .step {
      min-height: 30px;
    }
  }
  /* 面板很窄（手机竖屏的工作区层、桌面拖到最窄）：读数两行两格 */
  @container (max-width: 300px) {
    .stats {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      row-gap: 10px;
    }
    .stat:nth-child(odd) {
      padding-left: 2px;
      border-left: 0;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .sq.run {
      animation: none;
    }
  }
</style>
