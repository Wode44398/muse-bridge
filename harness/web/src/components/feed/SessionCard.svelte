<script lang="ts">
  // 会话消息卡（会话协作，lib/session-family.ts 解析信封）：时间线上一条 harness 片段换成卡片——
  //  · message：别的会话（父 / 子 / 兄弟，或 bridge 里的 Claude 会话）发来的话；brief = 父会话派来的任务（背景 + 任务两段）
  //  · event：子会话汇报，每个子会话一行：状态点 + 标题（点开那个会话）+ 汇报开头
  // 头部的会话名可点：dimensio 的会话在这里打开，Claude 的交给 bridge（嵌在 bridge 里时）。
  import Icon from "../ui/Icon.svelte";
  import { renderMarkdown } from "../../lib/markdown.ts";
  import { briefSections, parseSessionText, type FamilyAgent, type SessionPart } from "../../lib/session-family.ts";
  import { family, openFamilySession } from "../../lib/session-family.svelte.ts";
  import { t } from "../../lib/i18n.ts";

  let { text }: { text: string } = $props();

  const parsed = $derived(parseSessionText(text));
  const LONG = 600;
  let open = $state<Record<string, boolean>>({});

  const REL: Record<string, string> = { parent: t("父会话"), child: t("子会话"), sibling: t("兄弟会话"), linked: t("相关会话") };
  const STATUS: Record<string, string> = { done: t("这一轮已结束"), failed: t("这一轮出错了"), stopped: t("被停下") };
  const rel = (r: string) => REL[r] ?? REL.linked;
  const nameOf = (id: string, title: string, name: string, fallback: string) => title || family.links[id]?.title || name || fallback;
  const head = (p: Extract<SessionPart, { kind: "message" }>) => (p.brief ? t("{rel}派来的任务", { rel: rel(p.relation) }) : t("来自{rel}", { rel: rel(p.relation) }));
  const go = (id: string, agent: FamilyAgent) => void openFamilySession(id, agent);
  // 任务说明的小标题是服务端按中文拼的（【背景】/【任务】），按原文对照显示
  const LABEL: Record<string, string> = { "背景": t("背景"), "任务": t("任务") }; // i18n-ignore：键与服务端拼的小标题匹配
</script>

{#each parsed.parts as part, i (i)}
  <div class="smc">
    {#if part.kind === "message"}
      {@const long = part.body.length > LONG}
      <div class="head">
        <span class="ic" aria-hidden="true"><Icon name={part.brief ? "branch" : "message"} size={15} /></span>
        <span class="kind">{head(part)}</span>
        <button class="from" disabled={!part.from} title={t("打开这个会话")} onclick={() => go(part.from, part.agent)}>
          {nameOf(part.from, part.title, part.name, t("另一个会话"))}
        </button>
        {#if part.agent === "claude"}<span class="tag">Claude</span>{/if}
      </div>
      <div class="body md sel-text" class:clamp={long && !open[i]}>
        {#if part.brief}
          {#each briefSections(part.body) as s, k (k)}
            {#if s.label}<div class="label">{LABEL[s.label] ?? s.label}</div>{/if}
            {@html renderMarkdown(s.text)}
          {/each}
        {:else}
          {@html renderMarkdown(part.body)}
        {/if}
      </div>
      {#if long}<button class="more" onclick={() => (open[i] = !open[i])}>{open[i] ? t("收起") : t("展开全部")}</button>{/if}
    {:else}
      <div class="head">
        <span class="ic" aria-hidden="true"><Icon name="branch" size={15} /></span>
        <span class="kind">{part.notes.length > 1 ? t("{n} 个子会话的汇报", { n: part.notes.length }) : t("子会话的汇报")}</span>
      </div>
      <div class="notes">
        {#each part.notes as n, k (n.from + k)}
          {@const key = `${i}:${k}`}
          <div class="note">
            <div class="note-head">
              <span class="dot {n.status}" aria-hidden="true"></span>
              <button class="from" disabled={!n.from} title={t("打开这个会话")} onclick={() => go(n.from, n.agent)}>
                {nameOf(n.from, n.title, n.name, t("子会话"))}
              </button>
              {#if n.agent === "claude"}<span class="tag">Claude</span>{/if}
              <span class="st">{STATUS[n.status] ?? STATUS.done}</span>
            </div>
            {#if n.text}
              <div class="note-text md sel-text" class:clamp={!open[key] && n.text.length > 160}>{@html renderMarkdown(n.text)}</div>
              {#if n.text.length > 160}<button class="more" onclick={() => (open[key] = !open[key])}>{open[key] ? t("收起") : t("展开全部")}</button>{/if}
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
{/each}
{#if parsed.rest}
  <div class="rest md sel-text">{@html renderMarkdown(parsed.rest)}</div>
{/if}

<style>
  .smc {
    box-sizing: border-box;
    width: min(560px, 100%);
    padding: 10px 14px 12px;
    background: var(--surface);
    border-radius: 14px;
    box-shadow: 0 0 0 1px var(--border), inset 0 1px 0 var(--sheen);
  }
  .smc + .smc,
  .smc + .rest {
    margin-top: 8px;
  }
  .head,
  .note-head {
    display: flex;
    align-items: center;
    gap: 7px;
    min-width: 0;
    font-size: var(--fs-sm);
    line-height: var(--lh-ui);
    color: var(--text3);
  }
  .ic {
    display: inline-flex;
    flex: none;
    color: var(--text2);
  }
  .kind {
    flex: none;
  }
  .from {
    min-width: 0;
    overflow: hidden;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    font-weight: 500;
    color: var(--text);
    text-align: left;
    white-space: nowrap;
    text-overflow: ellipsis;
    cursor: pointer;
  }
  .from:disabled {
    cursor: default;
  }
  @media (hover: hover) {
    .from:not(:disabled):hover {
      text-decoration: underline;
      text-underline-offset: 3px;
    }
    .more:hover {
      color: var(--text2);
    }
  }
  .tag {
    flex: none;
    padding: 0 6px;
    border-radius: var(--r-pill);
    background: var(--surface2);
    font-size: var(--fs-xs);
    color: var(--text2);
  }
  .body {
    margin-top: 6px;
    font-size: var(--fs-base);
    color: var(--text);
  }
  .clamp {
    max-height: 9.5em;
    overflow: hidden;
    -webkit-mask-image: linear-gradient(black 70%, transparent);
    mask-image: linear-gradient(black 70%, transparent);
  }
  .label {
    margin: 6px 0 2px;
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  .label:first-child {
    margin-top: 0;
  }
  .more {
    margin-top: 4px;
    padding: 0;
    border: 0;
    background: none;
    font: inherit;
    font-size: var(--fs-sm);
    color: var(--text3);
    cursor: pointer;
  }
  .notes {
    display: flex;
    flex-direction: column;
    gap: 9px;
    margin-top: 8px;
  }
  .note + .note {
    padding-top: 9px;
    border-top: 1px solid var(--border);
  }
  .note-head {
    font-size: var(--fs-md);
  }
  .dot {
    flex: none;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--text3);
  }
  /* 成功是默认，不上色；出错用 --err（DESIGN.md §0.3） */
  .dot:global(.failed) {
    background: var(--err);
  }
  .st {
    flex: none;
    font-size: var(--fs-sm);
    color: var(--text3);
  }
  .note-text {
    margin-top: 4px;
    font-size: var(--fs-md);
    color: var(--text);
  }
  .note-text.clamp {
    max-height: 4.6em;
  }
  .rest {
    margin-top: 8px;
  }
</style>
