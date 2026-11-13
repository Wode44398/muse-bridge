<script lang="ts">
  // 审阅面板顶上的「拉取请求」卡（能力位 pr）：这个会话绑定的 GitHub PR——状态、检查项、打开链接、开关自动修复、手动跟踪 / 移出。
  // 数据在 bridge（与 Claude 的 PR 卡同一份台账、同一个后台扫描），这边经 harness 的 /api/pr 转过去，见 lib/pr.svelte.ts。
  // 只在 bridge 拉起的主机实例上出现；工作区不是 GitHub 仓库、也没绑 PR 时整张不出现（不占审阅面板的地方）。
  // 移出是两步确认（卡里展开一行）；合并 / 自动合并不在这里——那是对 GitHub 的长期授权，dimensio 暂不开放。
  import { untrack } from "svelte";
  import { app, toast } from "../../lib/state.svelte.ts";
  import { loadPr, prAction, prViewOf, watchPr } from "../../lib/pr.svelte.ts";
  import { conflicting, ghReason, pausedLabel, reviewLabel, stateLabel } from "../../lib/pr-text.ts";
  import type { PrCheck, PrRow } from "../../lib/api.ts";
  import { haptic } from "../../lib/touch.ts";
  import { collapse } from "../../lib/motion.ts";
  import { t, tr } from "../../lib/i18n.ts";
  import Icon from "../ui/Icon.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Button from "../ui/Button.svelte";
  import Switch from "../ui/Switch.svelte";
  import TextField from "../ui/TextField.svelte";
  import Mark from "../brand/Mark.svelte";

  let { sid = "" }: { sid?: string } = $props();

  // 只依赖 sid（拉取过程读写的 PR 状态不能成为 effect 的依赖）
  $effect(() => {
    const id = sid;
    return untrack(() => watchPr(id));
  });
  // 一轮刚收尾：agent 可能刚推送 / 建了 PR——跳过服务端缓存补拉一次
  let wasRunning = untrack(() => app.chat.running);
  $effect(() => {
    const r = app.chat.running;
    if (wasRunning && !r && sid) {
      const id = sid;
      untrack(() => void loadPr(id, true));
    }
    wasRunning = r;
  });

  const view = $derived(prViewOf(sid));
  const prs = $derived<PrRow[]>(view?.available ? (view.prs ?? []) : []);
  const github = $derived(Boolean(view?.available && view.git?.github));
  const show = $derived(Boolean(view?.available) && (prs.length > 0 || github));
  const ghBad = $derived(view?.gh && !view.gh.ok ? (view.gh.reason ?? "unknown") : "");
  const paused = $derived(view?.fix?.paused ?? "");

  // 交互态（换会话清空）
  let tracking = $state(false);
  let trackUrl = $state("");
  let trackErr = $state("");
  let saving = $state(false);
  let confirmUnbind = $state<string | null>(null);
  let checksOpen = $state<Record<string, boolean>>({});
  let refreshing = $state(false);
  $effect(() => {
    void sid;
    tracking = false;
    trackUrl = "";
    trackErr = "";
    confirmUnbind = null;
    checksOpen = {};
  });

  async function refresh() {
    if (!sid || refreshing) return;
    refreshing = true;
    await prAction(sid, "refresh");
    await loadPr(sid, true);
    refreshing = false;
  }

  async function track() {
    const url = trackUrl.trim();
    if (!url || saving) return;
    saving = true;
    trackErr = "";
    const r = await prAction(sid, "bind", { url });
    saving = false;
    if (!r.ok) {
      trackErr = tr(r.error) || t("没能跟踪这个拉取请求");
      return;
    }
    haptic("medium");
    tracking = false;
    trackUrl = "";
  }

  async function unbind(p: PrRow) {
    if (saving) return;
    saving = true;
    const r = await prAction(sid, "unbind", { url: p.url });
    saving = false;
    confirmUnbind = null;
    if (!r.ok) toast(t("移出失败：{error}", { error: tr(r.error) }));
    else toast(t("已从这个会话移出 #{n}", { n: p.number }));
  }

  async function setAutoFix(on: boolean) {
    if (saving) return;
    saving = true;
    const r = await prAction(sid, "monitor", { autoFix: on });
    saving = false;
    if (!r.ok) toast(t("没能切换自动修复：{error}", { error: tr(r.error) }));
  }

  // 检查条目的链接是第三方写的：只认 http(s)，别的退回 PR 的 checks 页
  const safeHref = (u: string | undefined, fallback: string) => (/^https?:\/\//i.test(String(u ?? "")) ? (u as string) : fallback);
  const BUCKET_ORDER: Record<string, number> = { fail: 0, pending: 1, pass: 2 };
  const sortedChecks = (list: PrCheck[]) => [...list].sort((a, b) => (BUCKET_ORDER[a.bucket] ?? 3) - (BUCKET_ORDER[b.bucket] ?? 3));
  const bucketLabel = (b: string) => (b === "fail" ? t("失败") : b === "pending" ? t("进行中") : b === "pass" ? t("通过") : t("已跳过"));
</script>

{#snippet checkGlyph(bucket: string)}
  {#if bucket === "fail"}
    <span class="gl bad"><Icon name="xCircle" size={14} /></span>
  {:else if bucket === "pending"}
    <span class="gl live" aria-hidden="true"><span class="dot"></span></span>
  {:else if bucket === "pass"}
    <span class="gl ok"><Icon name="checkCircle" size={14} /></span>
  {:else}
    <span class="gl"><Icon name="circle" size={14} /></span>
  {/if}
{/snippet}

{#if show}
  <section class="prc" aria-label={t("拉取请求")}>
    <header class="hd">
      <span class="ic"><Icon name="merge" size={15} /></span>
      <span class="ttl">{t("拉取请求")}</span>
      {#if refreshing}<span class="busy"><Mark size={14} live /></span>{/if}
      <IconButton icon="reload" label={t("刷新拉取请求")} size={28} iconSize={14} onclick={refresh} disabled={refreshing} />
    </header>

    {#if ghBad && github}
      <p class="note warn">{ghReason(ghBad)}</p>
    {/if}

    {#each prs as p (p.url)}
      {@const open = !!checksOpen[p.url]}
      {@const c = p.checks}
      <div class="pr">
        <div class="row1">
          <span class="num">#{p.number}</span>
          <span class="title" title={p.title}>{p.title || p.repo}</span>
          <a class="ext" href={p.url} target="_blank" rel="noopener noreferrer" title={t("在 GitHub 打开")} aria-label={t("在 GitHub 打开")}>
            <Icon name="external" size={15} />
          </a>
        </div>
        <div class="row2">
          <span class="st st-{p.state}">{stateLabel(p.state)}</span>
          {#if p.head}<span class="br" title="{p.head} → {p.base}">{p.head} → {p.base}</span>{/if}
          {#if reviewLabel(p.reviewDecision)}<span class="rv">{reviewLabel(p.reviewDecision)}</span>{/if}
          {#if conflicting(p)}<span class="cf">{t("有合并冲突")}</span>{/if}
        </div>

        {#if p.error}
          <p class="note">{p.error === "not_found" ? t("找不到这个拉取请求") : ghReason(p.error)}</p>
        {:else if c && c.total > 0}
          <button class="checks" aria-expanded={open} onclick={() => (checksOpen = { ...checksOpen, [p.url]: !open })}>
            <span class="chev" class:down={open}><Icon name="chevronR" size={13} stroke={1.9} /></span>
            <span class="clabel">{t("检查")}</span>
            <span class="counts">
              {#if c.failing}<em class="bad">{t("{n} 失败", { n: c.failing })}</em>{/if}
              {#if c.pending}<em class="pend">{t("{n} 进行中", { n: c.pending })}</em>{/if}
              {#if c.passing}<em>{t("{n} 通过", { n: c.passing })}</em>{/if}
            </span>
          </button>
          {#if open}
            <ul class="clist" in:collapse out:collapse>
              {#each sortedChecks(p.checkList) as k, i (k.name + i)}
                <li>
                  {@render checkGlyph(k.bucket)}
                  <span class="cname" title={k.workflow ? `${k.workflow} · ${k.name}` : k.name}>{k.name}</span>
                  <span class="hx-sr">{bucketLabel(k.bucket)}</span>
                  <a class="ext sm" href={safeHref(k.url, p.url + "/checks")} target="_blank" rel="noopener noreferrer" aria-label={t("查看检查详情")}>
                    <Icon name="external" size={13} />
                  </a>
                </li>
              {/each}
            </ul>
          {/if}
        {:else if c}
          <p class="note">{t("还没有检查")}</p>
        {/if}

        {#if p.state === "open" || p.state === "draft"}
          <div class="fixrow">
            <div class="fx-t">
              <span class="fx-l">{t("自动修复")}</span>
              <span class="fx-d">
                {#if p.autoFix && paused}{pausedLabel(paused)}{:else}{t("CI 失败、合并冲突或有新评审意见时叫醒这个会话去修")}{/if}
              </span>
            </div>
            <Switch checked={p.autoFix && !paused} disabled={saving} label={t("自动修复")} onchange={(v) => setAutoFix(v)} />
          </div>
        {/if}

        <div class="acts">
          {#if confirmUnbind === p.url}
            <span class="ask">{t("从这个会话移出这个拉取请求？之后不再显示它的检查，也不再自动修复")}</span>
            <Button size="sm" variant="ghost" disabled={saving} onclick={() => (confirmUnbind = null)}>{t("取消")}</Button>
            <Button size="sm" variant="danger" loading={saving} onclick={() => unbind(p)}>{t("移出")}</Button>
          {:else}
            <Button size="sm" variant="ghost" icon="close" onclick={() => (confirmUnbind = p.url)}>{t("从会话移出")}</Button>
          {/if}
        </div>
      </div>
    {/each}

    {#if !prs.length}
      {#if tracking}
        <div class="track" in:collapse out:collapse>
          <TextField
            size="sm"
            mono
            autofocus
            bind:value={trackUrl}
            placeholder="https://github.com/owner/repo/pull/123"
            label={t("拉取请求链接")}
            enterkeyhint="done"
            onkeydown={(e: KeyboardEvent) => {
              if (e.key === "Enter" && !e.isComposing) {
                e.preventDefault();
                void track();
              }
            }}
          />
          {#if trackErr}<p class="note warn">{trackErr}</p>{/if}
          <div class="acts">
            <Button size="sm" variant="ghost" disabled={saving} onclick={() => ((tracking = false), (trackErr = ""))}>{t("取消")}</Button>
            <Button size="sm" variant="accent" loading={saving} disabled={!trackUrl.trim()} onclick={track}>{t("跟踪")}</Button>
          </div>
        </div>
      {:else}
        <div class="none">
          <span class="nt">{t("这个会话还没有绑定拉取请求。让 dimensio 建一个，或跟踪已有的")}</span>
          <Button size="sm" variant="secondary" icon="link" onclick={() => (tracking = true)}>{t("跟踪拉取请求")}</Button>
        </div>
      {/if}
    {/if}
  </section>
{/if}

<style>
  .prc {
    flex: none;
    margin: 4px 2px 10px;
    padding: 6px 10px 10px;
    border-radius: var(--r-md);
    background: var(--surface);
    box-shadow:
      0 0 0 1px var(--border),
      inset 0 1px 0 var(--sheen);
  }
  .hd {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 30px;
  }
  .ic {
    display: inline-flex;
    color: var(--text3);
  }
  .ttl {
    flex: 1;
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text2);
  }
  .busy {
    display: inline-flex;
    color: var(--text3);
  }
  .note {
    margin: 2px 0 6px;
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--text3);
  }
  .note.warn {
    color: var(--warn);
  }
  .pr + .pr {
    margin-top: 8px;
    padding-top: 8px;
    border-top: 1px solid var(--border);
  }
  .row1 {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .num {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--fs-md);
    color: var(--text2);
    font-variant-numeric: tabular-nums;
  }
  .title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: var(--fs-base);
    font-weight: 500;
    color: var(--text);
  }
  .ext {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--r-sm);
    color: var(--text3);
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .ext.sm {
    width: 24px;
    height: 24px;
  }
  @media (hover: hover) {
    .ext:hover {
      background: var(--surface2);
      color: var(--text);
    }
  }
  .ext:active {
    background: var(--surface3);
  }
  .row2 {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    margin: 2px 0 6px;
    font-size: var(--fs-sm);
    color: var(--text3);
  }
  .st {
    padding: 1px 8px;
    border-radius: var(--r-pill);
    background: var(--surface2);
    color: var(--text2);
  }
  .st:global(.st-merged) {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .br {
    min-width: 0;
    max-width: 100%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-family: var(--font-mono);
  }
  .cf {
    color: var(--warn);
  }
  .checks {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    padding: 4px 6px 4px 2px;
    border-radius: var(--r-sm);
    font-size: var(--fs-sm);
    color: var(--text2);
    text-align: left;
  }
  @media (hover: hover) {
    .checks:hover {
      background: color-mix(in srgb, var(--text) 4%, transparent);
    }
  }
  .checks:active {
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .chev {
    display: inline-flex;
    color: var(--text3);
    transition: transform var(--t-spring) var(--spring);
  }
  .chev.down {
    transform: rotate(90deg);
  }
  .clabel {
    flex: none;
  }
  .counts {
    display: inline-flex;
    gap: 8px;
    margin-left: auto;
    font-variant-numeric: tabular-nums;
  }
  .counts em {
    font-style: normal;
  }
  .counts .bad,
  .gl.bad {
    color: var(--err);
  }
  .counts .pend {
    color: var(--text);
  }
  .gl {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    color: var(--text3);
  }
  .gl.ok {
    color: var(--ok);
  }
  .gl.live .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--live);
  }
  .clist {
    list-style: none;
    margin: 0 0 4px;
    padding: 0 0 0 20px;
  }
  .clist li {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 28px;
    font-size: var(--fs-sm);
    color: var(--text2);
  }
  .cname {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .fixrow {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 4px;
    padding: 8px 0 2px;
    border-top: 1px solid var(--border);
  }
  .fx-t {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .fx-l {
    font-size: var(--fs-md);
    color: var(--text);
  }
  .fx-d {
    font-size: var(--fs-xs);
    line-height: 1.45;
    color: var(--text3);
  }
  .acts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    margin-top: 6px;
  }
  .ask {
    flex: 1 1 100%;
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--text2);
  }
  .none {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding: 2px 0;
  }
  .nt {
    flex: 1 1 200px;
    font-size: var(--fs-sm);
    line-height: 1.5;
    color: var(--text3);
  }
  .track {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding-top: 2px;
  }
</style>
