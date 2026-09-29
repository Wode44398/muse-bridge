<script lang="ts">
  // 回滚到检查点：每条用户消息之前服务端都自动拍一张（文件 + 对话）；agent 删文件、丢 git 改动之前另拍「轮内快照」
  // （只回文件）。时间线最新在上；点一张就地展开「回滚会撤销什么」——改了哪些文件、各增删多少行，逐行改动可再展开。
  // 预览就是确认：普通回滚不再另弹对话框。对话之外改过的文件（手改的、别的对话改的）服务端会拦下（409 external），
  // 列给人看，确认了才带 force 再发。回滚前服务端先把现场拍成新检查点——回滚本身也撤得回来。
  // 成功之后的顺序不能乱：关面板 → 丢掉本地实例 → 重新打开（openSession 认得这个孤儿指针，照常重拉）→ 提示。
  import { untrack } from "svelte";
  import { app, evictChat, openSession, toast } from "../../lib/state.svelte.ts";
  import { checkpointDiff, listCheckpoints, rollback } from "../../lib/api.ts";
  import { haptic } from "../../lib/touch.ts";
  import { collapse, fade, rise, smoothHeight } from "../../lib/motion.ts";
  import { isEn, locale, t, tr } from "../../lib/i18n.ts";
  import Sheet from "../ui/Sheet.svelte";
  import Button from "../ui/Button.svelte";
  import Icon from "../ui/Icon.svelte";
  import Empty from "../ui/Empty.svelte";
  import Mark from "../brand/Mark.svelte";
  import { diffHtml, parseCheckpointDiff } from "./diff-text.ts";

  let { onclose }: { onclose: () => void } = $props();

  interface Checkpoint {
    n: number;
    at: number;
    label: string;
    kind?: string; // "files" = 轮内快照，只回文件
    hash?: string;
    tree?: string;
    endTree?: string;
    run?: string;
    msgs?: number;
  }

  const EXTERNAL_SHOWN = 12;

  let cps = $state<Checkpoint[]>([]);
  let loading = $state(true);
  let loadError = $state("");
  // 点一张先取改动预览（那一行上写着「加载改动预览…」），取到了再展开——展开的高度一次量准
  let previewing = $state<number | null>(null);
  let picked = $state<Checkpoint | null>(null);
  let diff = $state("");
  let diffError = $state("");
  let showPatch = $state(false);
  let rolling = $state(false);
  // P9（K22）：服务端拦下的「对话之外改过的文件」——列给人看，确认后才带 force 回滚
  let external = $state<string[] | null>(null);
  let listSeq = 0;
  let diffSeq = 0;
  const btn: "sm" | "md" = matchMedia("(pointer: coarse)").matches ? "md" : "sm";

  const summary = $derived(diff && !diffError ? parseCheckpointDiff(diff) : null);

  function loadList() {
    const id = app.chat.id;
    const my = ++listSeq;
    picked = null;
    previewing = null;
    external = null;
    diffSeq++;
    if (!id) {
      // 没有会话就没有检查点（以前会一直停在「加载中…」）
      cps = [];
      loading = false;
      return;
    }
    loading = true;
    loadError = "";
    listCheckpoints(id).then(
      (list) => {
        if (my !== listSeq) return;
        cps = [...(Array.isArray(list) ? list : [])].reverse(); // 最新在前
        loading = false;
      },
      (e: any) => {
        if (my !== listSeq) return;
        loadError = String(e?.message ?? e);
        loading = false;
      },
    );
  }
  // 面板开着时换了会话：跟着换
  $effect(() => {
    void app.chat.id;
    untrack(loadList);
  });

  async function toggle(cp: Checkpoint) {
    if (picked?.n === cp.n) {
      picked = null;
      external = null;
      return;
    }
    const id = app.chat.id;
    if (!id || rolling) return;
    haptic("light");
    const my = ++diffSeq;
    previewing = cp.n;
    let d = "";
    let err = "";
    try {
      d = await checkpointDiff(id, cp.n);
    } catch (e: any) {
      err = t("diff 加载失败：{reason}", { reason: tr(String(e?.message ?? e)) });
    }
    if (my !== diffSeq) return;
    previewing = null;
    diff = d;
    diffError = err;
    showPatch = false;
    external = null;
    picked = cp;
  }

  async function doRollback(force = false) {
    if (!picked || !app.chat.id) return;
    rolling = true;
    haptic("medium");
    try {
      const r = await rollback(app.chat.id, picked.n, force);
      if (r.ok) {
        const sid = app.chat.id;
        onclose();
        evictChat(sid); // 服务端已经重置了这个会话：丢掉本地缓存的实例，强制重拉
        await openSession(sid);
        toast(t("已回滚"));
      } else if (r.code === "external" && r.external?.length) {
        external = r.external;
        haptic("light");
      } else {
        toast(r.code === "running" ? t("有会话正在运行，无法回滚") : t("回滚失败：{reason}", { reason: tr(String(r.error)) }));
      }
    } catch (e: any) {
      toast(t("回滚失败：{reason}", { reason: tr(String(e?.message ?? e)) }));
    }
    rolling = false;
  }

  const pad = (n: number) => String(n).padStart(2, "0");
  // 中文「9/28 15:04」；英文按界面语言（Sep 28, 3:04 PM）
  const fmtTime = (ts: number) => {
    const d = new Date(ts);
    if (isEn()) return new Intl.DateTimeFormat(locale(), { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(d);
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  // 服务端自己拍的现场（回滚前 / 改写前 / 撤销文件前）：拆成一枚小标签 + 括号里那句说明（两段都是服务端的中文，显示时走 tr）
  const special = (label: string): { tag: string; rest: string } | null => {
    const m = /^(.{1,8}前现场)（(.+)）$/.exec(label ?? "");
    return m ? { tag: m[1], rest: m[2] } : null;
  };
  // 一行的说明：服务端现场的括号说明 / 轮内快照的标签（服务端写的「执行 … 之前」）/ 服务端自动起的轮（整句套全角括号：
  // 「（服务重启后自动续跑）」「（目标第 N 轮）」）走 tr；普通检查点的标签是用户消息，原样
  const serverMade = (label: string) => /^（[^（）]+）$/.test(label);
  const labelOf = (cp: Checkpoint, sp: { rest: string } | null) =>
    sp ? tr(sp.rest) : cp.label && (cp.kind === "files" || serverMade(cp.label)) ? tr(cp.label) : cp.label || t("（会话开始）");
</script>

<Sheet title={t("回滚到检查点")} {onclose} size="lg">
  {#if loading && !cps.length}
    <p class="state"><Mark size={16} live /><span>{t("加载中…")}</span></p>
  {:else if loadError && !cps.length}
    <div class="state err" role="alert">
      <span>{t("加载失败：{reason}", { reason: tr(loadError) })}</span>
      <Button size={btn} variant="ghost" icon="reload" onclick={loadList}>{t("重试")}</Button>
    </div>
  {:else if !cps.length}
    <Empty icon="history" title={t("这个会话还没有检查点")} compact />
  {:else}
    <ol class="tl">
      {#each cps as cp, i (cp.n)}
        {@const sp = special(cp.label)}
        {@const open = picked?.n === cp.n}
        <li class="cp" class:open class:files={cp.kind === "files"} in:rise|global={{ y: 6, delay: Math.min(i, 12) * 30 }}>
          <button class="head" aria-expanded={open} onclick={() => toggle(cp)}>
            <span class="node" aria-hidden="true"></span>
            <span class="main">
              <span class="label">
                {#if sp}<span class="tag">{tr(sp.tag)}</span>{/if}
                {#if cp.kind === "files"}<span class="tag">{t("轮内快照 · 只回文件")}</span>{/if}
                <span class="lt">{labelOf(cp, sp)}</span>
              </span>
              <span class="when">
                <span>{fmtTime(cp.at)}</span><span class="n">#{cp.n}</span>
                {#if previewing === cp.n}<span class="hx-shimmer">{t("加载改动预览…")}</span>{/if}
              </span>
            </span>
            <span class="chev" aria-hidden="true">
              {#if previewing === cp.n}<Mark size={16} live />{:else}<Icon name="chevronD" size={16} />{/if}
            </span>
          </button>

          {#if open}
            <!-- 展开之后内容再变（逐行改动、外部改动的确认）也是平滑生长 -->
            <div class="pv-wrap" transition:collapse>
              <div use:smoothHeight>
                <div class="pv">
                  {#if diffError}
                    <p class="line err">{diffError}</p>
                  {:else if summary?.empty}
                    <p class="line">{t("这之后没有改过文件")}</p>
                  {:else if summary && summary.files.length}
                    <div class="sum">
                      <span>{t("{n} 个文件", { n: summary.files.length })}</span>
                      <span class="num"><span class="add">+{summary.add}</span> <span class="del">−{summary.del}</span></span>
                    </div>
                    <ul class="files">
                      {#each summary.files as f}
                        <li>
                          <span class="fp" title={f.path}><bdi>{f.path}</bdi></span>
                          <span class="num">
                            {#if f.bin}<span class="bin">{t("二进制")}</span>
                            {:else if f.changed !== undefined}±{f.changed}
                            {:else}<span class="add">+{f.add}</span> <span class="del">−{f.del}</span>{/if}
                          </span>
                        </li>
                      {/each}
                    </ul>
                    <button class="more" aria-expanded={showPatch} onclick={() => (showPatch = !showPatch)}>
                      <Icon name="fileDiff" size={15} />
                      <span>{t("逐行改动")}</span>
                      <span class="chev-s" class:up={showPatch}><Icon name="chevronD" size={14} /></span>
                    </button>
                    {#if showPatch}
                      <div class="diffbox" in:fade={{ duration: 160 }}>
                        <pre class="diff">{@html diffHtml(diff)}</pre>
                      </div>
                    {/if}
                  {:else if summary}
                    <!-- 认不出文件清单的输出：原样给看 -->
                    <div class="diffbox">
                      <pre class="diff">{@html diffHtml(diff)}</pre>
                    </div>
                  {/if}

                  {#if external}
                    <div class="ext" role="alert" in:rise={{ y: 4 }}>
                      <p class="ext-head"><Icon name="shield" size={16} /><span>{t("有 {n} 个文件不是这个对话改的", { n: external.length })}</span></p>
                      <p class="ext-why">{t("手改的、别的对话改的都算。回滚会把它们一起还原，这些改动会被覆盖；回滚前的现场仍会先存成检查点，覆盖了也能再回滚回来。")}</p>
                      <ul class="ext-list">
                        {#each external.slice(0, EXTERNAL_SHOWN) as p}
                          <li><bdi>{p}</bdi></li>
                        {/each}
                      </ul>
                      {#if external.length > EXTERNAL_SHOWN}
                        <p class="ext-more">{t("…还有 {n} 个", { n: external.length - EXTERNAL_SHOWN })}</p>
                      {/if}
                      <div class="ext-acts">
                        <Button variant="ghost" disabled={rolling} onclick={() => (external = null)}>{t("先不回滚")}</Button>
                        <Button variant="danger" icon="undo" loading={rolling} onclick={() => doRollback(true)}>
                          {rolling ? t("回滚中…") : t("仍然回滚（覆盖这些外部改动）")}
                        </Button>
                      </div>
                    </div>
                  {:else}
                    <div class="go">
                      <Button variant="primary" icon="undo" full loading={rolling} onclick={() => doRollback()}>
                        {rolling ? t("回滚中…") : cp.kind === "files" ? t("把文件回滚到这里（对话不动）") : t("回滚到这里")}
                      </Button>
                    </div>
                  {/if}
                </div>
              </div>
            </div>
          {/if}
        </li>
      {/each}
    </ol>
    <p class="foot">
      {t("回到发出这条消息之前的状态——工作空间文件与对话一起还原，之后仍可再「前滚」回来。「轮内快照」是 agent 删文件、丢弃 git 改动之前自动拍的，回到那里只还原文件、对话不动。对话之外改过的文件会先列出来，确认了才覆盖。")}
    </p>
  {/if}
</Sheet>

<style>
  .state {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    margin: 0;
    padding: 36px 16px;
    font-size: var(--fs-md);
    color: var(--text3);
    text-align: center;
  }
  .state.err {
    flex-direction: column;
    color: var(--err);
    overflow-wrap: anywhere;
  }

  /* 时间线：左边一根细线把各个检查点串起来（尺寸线的母题：线 + 点） */
  .tl {
    margin: 0 0 6px;
    padding: 0;
    list-style: none;
  }
  .cp {
    position: relative;
    border-radius: 14px;
    transition: background-color var(--t-med) var(--ease);
  }
  .cp::before {
    content: "";
    position: absolute;
    z-index: 1;
    left: 18px;
    top: 0;
    bottom: 0;
    width: 1px;
    background: var(--border2);
  }
  .cp:first-child::before {
    top: 21px;
  }
  .cp:last-child::before {
    bottom: auto;
    height: 21px;
  }
  .cp:only-child::before {
    display: none;
  }
  .cp.open {
    background: var(--surface2);
  }
  .head {
    position: relative;
    display: flex;
    align-items: flex-start;
    gap: 10px;
    width: 100%;
    padding: 11px 12px 11px 36px;
    border-radius: 14px;
    text-align: left;
    color: var(--text);
    transition: background-color var(--t-fast) var(--ease);
  }
  @media (hover: hover) {
    .cp:not(.open) .head:hover {
      background: color-mix(in srgb, var(--text) 4%, transparent);
    }
  }
  .cp:not(.open) .head:active {
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .node {
    position: absolute;
    z-index: 2;
    left: 14px;
    top: 17px;
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: var(--text3);
    box-shadow: 0 0 0 3px var(--surface);
    transition:
      background-color var(--t-med) var(--ease),
      box-shadow var(--t-med) var(--ease);
  }
  .files .node {
    background: var(--surface);
    box-shadow:
      inset 0 0 0 1.5px var(--text3),
      0 0 0 3px var(--surface);
  }
  .open .node {
    background: var(--accent);
    box-shadow: 0 0 0 3px var(--surface2);
  }
  .main {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .label {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 4px 6px;
    min-width: 0;
    font-size: var(--fs-base);
    line-height: 1.45;
  }
  .lt {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1 1 60%;
  }
  .open .lt {
    white-space: normal;
    overflow-wrap: anywhere;
  }
  .tag {
    display: inline-flex;
    align-items: center;
    flex: none;
    height: 20px;
    padding: 0 8px;
    border-radius: var(--r-pill);
    font-size: var(--fs-xs);
    font-weight: 500;
    color: var(--text2);
    background: color-mix(in srgb, var(--text) 7%, transparent);
  }
  .when {
    display: flex;
    gap: 8px;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text3);
    font-variant-numeric: tabular-nums;
  }
  .n {
    opacity: 0.75;
  }
  .when .hx-shimmer {
    font-family: var(--font-ui);
  }
  .chev {
    display: inline-flex;
    flex: none;
    margin-top: 2px;
    color: var(--text3);
    transition: transform var(--t-med) var(--ease-out);
  }
  .open .chev {
    transform: rotate(180deg);
  }

  /* 展开的预览 */
  .pv {
    padding: 0 14px 14px 36px;
  }
  .line {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 2px 0 12px;
    font-size: var(--fs-md);
    color: var(--text3);
  }
  .line.err {
    color: var(--err);
    overflow-wrap: anywhere;
  }
  .sum {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    margin: 2px 0 6px;
    font-size: var(--fs-sm);
    color: var(--text2);
  }
  .num {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    font-variant-numeric: tabular-nums;
    color: var(--text3);
    text-align: right;
  }
  .add {
    color: var(--ok);
  }
  .del {
    color: var(--err);
  }
  .bin {
    font-family: var(--font-ui);
    font-size: var(--fs-xs);
  }
  .files {
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 30vh;
    overflow-y: auto;
    overscroll-behavior: contain;
    border-radius: 10px;
    background: var(--surface);
  }
  .files li {
    display: flex;
    align-items: center;
    gap: 12px;
    min-height: 34px;
    padding: 6px 10px;
  }
  .files li + li {
    box-shadow: 0 -1px 0 var(--border);
  }
  .fp {
    flex: 1;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--text);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    /* 长路径先露尾巴 */
    direction: rtl;
    text-align: left;
  }
  .more {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    margin: 8px 0 0 -8px;
    padding: 0 8px;
    border-radius: 9px;
    font-size: var(--fs-md);
    color: var(--text2);
    transition: background-color var(--t-fast) var(--ease);
  }
  @media (hover: hover) {
    .more:hover {
      background: color-mix(in srgb, var(--text) 6%, transparent);
    }
  }
  .chev-s {
    display: inline-flex;
    color: var(--text3);
    transition: transform var(--t-med) var(--ease-out);
  }
  .chev-s.up {
    transform: rotate(180deg);
  }
  .diffbox {
    margin-top: 6px;
    border-radius: 10px;
    background: var(--code-bg);
    max-height: 46vh;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .diff {
    margin: 0;
    padding: 10px 12px;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.6;
    white-space: pre;
    min-width: 100%;
    width: max-content;
    color: var(--text2);
  }
  /* 补丁是 {@html} 进来的：作用域样式要写 :global，否则类名会被编译器当成没用到剪掉 */
  .diff :global(.da) {
    color: var(--ok);
    background: color-mix(in srgb, var(--ok) 9%, transparent);
    display: inline-block;
    width: 100%;
  }
  .diff :global(.dr) {
    color: var(--err);
    background: color-mix(in srgb, var(--err) 8%, transparent);
    display: inline-block;
    width: 100%;
  }
  .diff :global(.dh) {
    color: var(--accent);
  }
  .diff :global(.dm) {
    color: var(--text3);
  }

  .go {
    margin-top: 14px;
  }

  /* P9（K22）：对话之外改过的文件——要你拍板（warn），确认才覆盖 */
  .ext {
    margin-top: 14px;
    padding: 12px 14px;
    border-radius: 12px;
    background: color-mix(in srgb, var(--warn) 11%, transparent);
  }
  .ext-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
    font-size: var(--fs-base);
    font-weight: 500;
    color: var(--warn);
  }
  .ext-why {
    margin: 6px 0 10px;
    font-size: var(--fs-md);
    line-height: 1.6;
    color: var(--text2);
  }
  .ext-list {
    margin: 0;
    padding: 0;
    list-style: none;
    max-height: 22vh;
    overflow: auto;
    overscroll-behavior: contain;
  }
  .ext-list li {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    line-height: 1.65;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .ext-more {
    margin: 4px 0 0;
    font-size: var(--fs-sm);
    color: var(--text3);
  }
  .ext-acts {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }

  .foot {
    margin: 14px 4px 0;
    font-size: var(--fs-sm);
    line-height: 1.6;
    color: var(--text3);
  }
  @media (prefers-reduced-motion: reduce) {
    .chev,
    .chev-s {
      transition: none;
    }
  }
</style>
