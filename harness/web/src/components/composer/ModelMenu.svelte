<script lang="ts">
  // 型号菜单（输入框右下的型号胶囊呼出）：从胶囊里长出来的一张面板（ui/MorphPanel：iOS 下拉按钮的展开 / 收起）。两页：
  //  · 型号页：顶上「模型」+ 当前服务胶囊（厂商标 + 名称 + ›）；型号列表（单选，名称 + 一行能力摘要，当前那个右侧墨色勾；
  //    多了（> 8）出搜索框，id 带 vendor/ 前缀的按前缀分组；放不下自己滚，下面的思考深度不跟着滚走）；思考深度（iOS 带刻度的
  //    液态玻璃滑块，档名用官方原文；只有开 / 关两档的型号换成开关）；Fast mode（型号支持才露出，iOS 液态玻璃开关）。
  //  · 服务页：点服务胶囊，同一块面板原地变成服务列表（iOS 子菜单那样：内容横着换页、面板跟着长高 / 缩短，不另开浮层）。
  //    点一家＝切过去，切好回到型号页列它的型号；底下是「添加服务」和「在模型中心管理」（宿主的模型中心能开时才有）。
  // 选型号 / 选档位不关菜单（可以先挑型号再挑档位）；两者都只写全局配置（POST /api/config，后发的赢），本机先上屏。
  import type { Component } from "svelte";
  import { onMount, tick, untrack } from "svelte";
  import {
    app,
    findModel,
    hasHostModelHub,
    modelEfforts,
    modelsOf,
    modelSupportsFast,
    openHostModelHub,
    providerModels,
    setEffort,
    setFast,
    setModel,
    switchVendor,
    vendorChoices,
    vendorId,
    vendorInfo,
    vendorSwitchNote,
  } from "../../lib/state.svelte.ts";
  import { haptic } from "../../lib/touch.ts";
  import { usePane } from "../../lib/pane.ts";
  import { reducedMotion } from "../../lib/motion.ts";
  import MorphPanel from "../ui/MorphPanel.svelte";
  import Icon from "../ui/Icon.svelte";
  import Mark from "../brand/Mark.svelte";
  import VendorLogo from "../brand/VendorLogo.svelte";
  import TextField from "../ui/TextField.svelte";
  import DepthTrack from "./DepthTrack.svelte";
  // @ts-ignore —— bridge 的 JS 组件、没有类型声明；下面按用到的参数收窄
  import ToggleRaw from "../../../../../web/src/components/ios27/Toggle.svelte";
  import { fmtTokens } from "../../lib/model-knowledge.ts";
  import { t, tc, tr } from "../../lib/i18n.ts";

  const Toggle = ToggleRaw as unknown as Component<{ checked: boolean; label: string; onchange: () => void }>;
  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let { open, anchor, onclose }: { open: boolean; anchor: HTMLElement | null; onclose: () => void } = $props();

  const models = $derived(app.info ? providerModels() : []);
  const efforts = $derived(app.info ? modelEfforts() : []);
  const cur = $derived(findModel(models, app.config?.model));
  const effortLabels = $derived<Record<string, string>>(cur?.effortLabels ?? {});
  // effortLabels 来自服务端 catalog：开关式档位写「关闭 / 开启」——那是开关的值（Off / On），不能走 tr() 的普通键（关闭 = Close）
  function effortText(label: string): string {
    if (label === "开启") return tc("开关", "开启"); // i18n-ignore（左边比对服务端数据）
    if (label === "关闭") return tc("开关", "关闭"); // i18n-ignore（左边比对服务端数据）
    return tr(label);
  }
  const effortOptions = $derived(efforts.map((lv) => ({ value: lv, label: effortLabels[lv] !== undefined ? effortText(effortLabels[lv]) : lv })));
  const effort = $derived(app.config?.thinking ?? "off");
  // 只有「关 / 开」两档：一个开关比两格拉条更直白
  const toggleOnly = $derived(efforts.length === 2 && efforts.includes("off"));
  const onLevel = $derived(efforts.find((e) => e !== "off") ?? "");
  const vid = $derived(vendorId());
  // fast mode（参照 bridge 本体 Claude 分页）：只有支持的型号才露出开关；开关状态粘性——切去不支持的型号不清除，
  // 只是不显示、服务端也不发，切回来照旧开着。
  const fastOk = $derived(modelSupportsFast(app.config?.provider, app.config?.model));
  const fastOn = $derived(app.config?.fast === true);
  const vendorName = $derived(vendorInfo(vid).name);

  // 型号多了才有搜索；按 id 的 vendor/ 前缀分组（不带前缀的归在一起、排最前）
  let q = $state("");
  const searchable = $derived(models.length > 8);
  const shown = $derived(
    !q.trim() ? models : models.filter((m: any) => `${m.id} ${m.label ?? ""}`.toLowerCase().includes(q.trim().toLowerCase())),
  );
  const groups = $derived.by(() => {
    const out: { key: string; items: any[] }[] = [];
    for (const m of shown) {
      const key = typeof m.group === "string" ? m.group : "";
      let g = out.find((x) => x.key === key);
      if (!g) out.push((g = { key, items: [] }));
      g.items.push(m);
    }
    return out.sort((a, b) => (a.key ? 1 : 0) - (b.key ? 1 : 0));
  });
  // 去掉 vendor/ 前缀的显示名（分组标题已经写了是哪家）
  const shortLabel = (m: any) => {
    const label = String(m.label ?? m.id);
    return m.group && label.startsWith(m.group + "/") ? label.slice(m.group.length + 1) : label;
  };
  // 没有说明文字的型号（自定义服务的）：能力摘要
  function capsLine(m: any): string | undefined {
    if (m.note) return tr(m.note);
    const parts: string[] = [];
    if (m.ctx) parts.push(fmtTokens(m.ctx));
    if (m.image) parts.push(t("视觉"));
    if (m.alwaysThinks || (Array.isArray(m.efforts) && m.efforts.some((e: string) => e !== "off"))) parts.push(t("会思考"));
    return parts.length ? parts.join(" · ") : undefined;
  }

  function pickModel(id: string) {
    haptic("light");
    void setModel(id);
  }
  function pickEffort(lv: string) {
    void setEffort(lv);
  }

  // ── 两页：型号 / 服务 ──
  let page = $state<"models" | "vendors">("models");
  let dir = $state(1); // 换页方向：去服务页从右边进，回型号页从左边进
  let panel: { refit: () => void; rect: () => { x: number; y: number; w: number; h: number; r: number } | null; vanish: (ms?: number) => void } | undefined = $state();
  let pending = $state<string | null>(null); // 正在切过去的那一家
  function go(to: "models" | "vendors") {
    if (to === page) return;
    haptic("light");
    dir = to === "vendors" ? 1 : -1;
    page = to;
  }
  // 换页、型号表变长变短、思考深度 / Fast 这几段出现或消失：面板按新内容平滑改尺寸
  $effect(() => {
    void page;
    void shown.length;
    void efforts.length;
    void fastOk;
    if (!open) return;
    void tick().then(() => panel?.refit());
  });

  const choices = $derived(app.info ? vendorChoices() : []);
  let hubLink = $state(false);
  onMount(() => {
    hubLink = hasHostModelHub();
  });
  async function pickVendor(id: string) {
    if (pending) return;
    if (id === vid) return go("models");
    pending = id;
    try {
      await switchVendor(id); // 失败自己会提示；成功后型号页的列表换成新那家的
    } finally {
      pending = null;
    }
    if (vendorId() === id) go("models");
  }
  // 添加服务：模型中心的添加窗口从这块面板原地长出来（宿主按 from 做容器变形），面板在窗口盖上来的同时淡掉、再收起
  function addService() {
    haptic("light");
    const from = panel?.rect() ?? null;
    if (!openHostModelHub("add", from ? { from } : undefined)) return;
    if (from) panel?.vanish();
    onclose();
  }
  function openHub() {
    haptic("light");
    if (openHostModelHub()) onclose();
  }
  const nModels = (id: string) => {
    const n = modelsOf(id).length;
    return t("{n} 个模型", { count: n }).replace("{n}", String(n));
  };

  // 换页：新的一页从换页方向那边滑进来、淡入（只动 transform / opacity；旧的一页直接让位，面板尺寸由 refit 接着变）
  function pageIn(_node: Element) {
    if (reducedMotion()) return { duration: 0 };
    const d = dir;
    return {
      duration: 280,
      css: (k: number) => {
        const e = 1 - Math.pow(1 - k, 3);
        return `transform: translateX(${((1 - e) * 22 * d).toFixed(2)}px); opacity: ${Math.min(1, k * 1.6).toFixed(3)}`;
      },
    };
  }

  // 打开时：回到型号页；电脑上把焦点放到当前型号上（方向键接着走）；列表滚到当前型号；搜索词清空
  let listEl: HTMLDivElement | undefined = $state();
  // 内容要等面板长到一定程度才显形（之前是 visibility:hidden，焦点放不进去），所以焦点隔几十毫秒试一次、放进去为止
  $effect(() => {
    if (!open) return;
    let timer = 0;
    untrack(() => {
      q = "";
      page = "models";
      const on = () => listEl?.querySelector<HTMLElement>(".mrow.on") ?? listEl?.querySelector<HTMLElement>(".mrow") ?? null;
      requestAnimationFrame(() => {
        const row = on();
        if (row && listEl) listEl.scrollTop = Math.max(0, row.offsetTop - listEl.clientHeight / 2 + row.offsetHeight / 2);
      });
      if (!matchMedia("(pointer: fine)").matches) return;
      let tries = 0;
      const tryFocus = () => {
        const row = on();
        row?.focus({ preventScroll: true });
        if ((!row || document.activeElement !== row) && ++tries < 16) timer = window.setTimeout(tryFocus, 40);
      };
      timer = window.setTimeout(tryFocus, 60);
    });
    return () => clearTimeout(timer);
  });
  // 换到服务页：电脑上焦点放到当前那家
  $effect(() => {
    if (page !== "vendors" || !open) return;
    void tick().then(() => {
      const row = listEl?.querySelector<HTMLElement>(".mrow.on") ?? listEl?.querySelector<HTMLElement>(".mrow");
      if (row && listEl) listEl.scrollTop = Math.max(0, row.offsetTop - listEl.clientHeight / 2 + row.offsetHeight / 2);
      if (matchMedia("(pointer: fine)").matches) row?.focus({ preventScroll: true });
    });
  });
  function listKey(e: KeyboardEvent) {
    if (e.key === "ArrowLeft" && page === "vendors") {
      e.preventDefault();
      return go("models");
    }
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp" && e.key !== "Home" && e.key !== "End") return;
    const rows = [...(listEl?.querySelectorAll<HTMLElement>(".mrow") ?? [])];
    if (!rows.length) return;
    e.preventDefault();
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : e.key === "ArrowDown" ? (i + 1) % rows.length : (i - 1 + rows.length) % rows.length;
    rows[next]?.focus();
  }
</script>

<MorphPanel bind:this={panel} {open} {anchor} {onclose} width={312} label={t("模型与思考深度")}>
  <div class="menu">
    {#key page}
      <div class="page" in:pageIn>
        {#if page === "models"}
          <div class="hd">
            <span class="hd-t">{t("模型")}</span>
            <button type="button" class="vend" onclick={() => go("vendors")} title={t("切换模型服务…")} aria-label={t("切换模型服务…")}>
              <VendorLogo skin={vid} size={16} />
              <span class="vend-n">{vendorName}</span>
              <Icon name="chevronR" size={13} stroke={2} />
            </button>
          </div>

          {#if searchable}
            <div class="search"><TextField bind:value={q} size="sm" icon="search" label={t("搜索型号")} placeholder={t("搜索型号")} /></div>
          {/if}

          {#if models.length}
            <!-- svelte-ignore a11y_interactive_supports_focus -->
            <div class="list" class:fixed={searchable} bind:this={listEl} role="listbox" aria-label={t("模型")} onkeydown={listKey}>
              {#each groups as g (g.key)}
                {#if g.key}<div class="grp">{g.key}</div>{/if}
                {#each g.items as m (m.id)}
                  {@const on = m === cur}
                  {@const caps = capsLine(m)}
                  <button type="button" class="mrow" class:on role="option" aria-selected={on} onclick={() => pickModel(m.id)}>
                    <span class="mtx">
                      <span class="mn">{tr(shortLabel(m))}</span>
                      {#if caps}<span class="mc">{caps}</span>{/if}
                    </span>
                    <span class="ck" aria-hidden="true">{#if on}<Icon name="check" size={16} stroke={2.2} />{/if}</span>
                  </button>
                {/each}
              {:else}
                <p class="none">{t("没有匹配的型号")}</p>
              {/each}
            </div>
          {/if}

          {#if efforts.length > 1}
            <div class="sec">
              {#if toggleOnly}
                <div class="row">
                  <span class="row-t">{t("思考")}</span>
                  <Toggle checked={effort !== "off"} label={t("思考")} onchange={() => pickEffort(effort !== "off" ? "off" : onLevel)} />
                </div>
              {:else}
                <div class="sec-h">
                  <span>{t("思考深度")}</span>
                </div>
                <DepthTrack options={effortOptions} value={effort} onchange={pickEffort} />
              {/if}
            </div>
          {/if}

          {#if fastOk}
            <div class="sec">
              <div class="row">
                <span class="row-body">
                  <span class="row-t">Fast mode</span>
                  <span class="row-d">{t("输出更快，按更高单价计费")}</span>
                </span>
                <Toggle checked={fastOn} label="Fast mode" onchange={() => void setFast(!fastOn)} />
              </div>
            </div>
          {/if}
        {:else}
          <div class="hd vhd">
            <button type="button" class="back" onclick={() => go("models")} aria-label={t("回到型号")} title={t("回到型号")}>
              <Icon name="chevronL" size={16} stroke={2} />
            </button>
            <span class="hd-t2">{t("模型服务")}</span>
          </div>
          <!-- svelte-ignore a11y_interactive_supports_focus -->
          <div class="list" bind:this={listEl} role="listbox" aria-label={t("模型服务")} onkeydown={listKey}>
            {#each choices as v (v.id)}
              {@const on = v.id === vid}
              <button
                type="button"
                class="mrow vrow"
                class:on
                role="option"
                aria-selected={on}
                disabled={Boolean(pending) && pending !== v.id}
                onclick={() => pickVendor(v.id)}
              >
                <span class="vlg">{#if pending === v.id}<Mark size={20} live />{:else}<VendorLogo skin={v.id} size={20} />{/if}</span>
                <span class="mtx">
                  <span class="mn">{v.name}</span>
                  <span class="mc">{v.company}{modelsOf(v.id).length ? " · " + nModels(v.id) : ""}</span>
                </span>
                <span class="ck" aria-hidden="true">{#if on}<Icon name="check" size={16} stroke={2.2} />{/if}</span>
              </button>
            {/each}
            {#if hubLink}
              <button type="button" class="mrow vrow add" onclick={addService}>
                <span class="vlg plus"><Icon name="plus" size={16} stroke={2} /></span>
                <span class="mtx">
                  <span class="mn">{t("添加服务")}</span>
                  <span class="mc">{t("模型中心")}</span>
                </span>
                <span class="ck" aria-hidden="true"><Icon name="external" size={14} stroke={2} /></span>
              </button>
            {/if}
          </div>
          <p class="vnote">{vendorSwitchNote(pane.chat)}</p>
          {#if hubLink}
            <button type="button" class="hublink" onclick={openHub}>{t("在模型中心管理全部模型服务")}</button>
          {/if}
        {/if}
      </div>
    {/key}
  </div>
</MorphPanel>

<style>
  /* 面板内容：竖向三段，列表段放不下时自己滚（面板高度由 MorphMenu 量自然高、夹进视口） */
  .menu {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: 6px 6px 8px;
    box-sizing: border-box;
    color: var(--text);
  }
  /* 内容不另加缩放：面板的形变与内容淡入都由 MorphMenu 同一根弹簧逐帧给。以前这里还挂了一条 0.94→1 的 CSS 弹簧，
     时间线与面板不同步、尾段过冲到 1.002，叠上面板最后那一下回位，展开后看着抖一下 */

  /* 一页：与 .menu 同一套竖向排版（列表段放不下时自己滚） */
  .page {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }
  /* 服务页的顶行：‹ + 标题 */
  .hd.vhd {
    justify-content: flex-start;
    gap: 2px;
    padding-left: 2px;
  }
  .back {
    display: inline-grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: var(--r-pill);
    color: var(--text2);
    transition: background-color var(--t-fast) var(--ease);
  }
  .back:active {
    background: color-mix(in srgb, var(--text) 10%, transparent);
  }
  @media (hover: hover) {
    .back:hover {
      background: color-mix(in srgb, var(--text) 7%, transparent);
      color: var(--text);
    }
  }
  .hd-t2 {
    font-size: var(--fs-base);
    font-weight: 600;
    color: var(--text);
  }
  .vrow {
    gap: 12px;
  }
  .vrow:disabled {
    opacity: 0.5;
  }
  /* 服务的品牌标垫一块淡底（各家标的留白不一样，垫上底才齐） */
  .vlg {
    flex: none;
    display: inline-grid;
    place-items: center;
    width: 30px;
    height: 30px;
    border-radius: 9px;
    background: color-mix(in srgb, var(--text) 5%, transparent);
  }
  .vlg.plus {
    color: var(--text2);
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--border2);
  }
  .add .ck {
    color: var(--text3);
  }
  .vnote {
    flex: none;
    margin: 8px 10px 0;
    font-size: var(--fs-xs);
    line-height: 1.5;
    color: var(--text3);
  }
  .hublink {
    flex: none;
    align-self: flex-start;
    margin: 4px 4px 0;
    padding: 4px 6px;
    border-radius: 6px;
    font-size: var(--fs-sm);
    color: var(--text2);
    text-decoration: underline;
    text-decoration-color: var(--border2);
    text-underline-offset: 3px;
  }
  @media (hover: hover) {
    .hublink:hover {
      color: var(--text);
      background: var(--accent-soft);
    }
  }
  .hd {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 4px 6px 10px;
  }
  .hd-t {
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text3);
  }
  /* 当前服务：厂商标 + 名称 + ›，一颗轻胶囊 */
  .vend {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 8px 0 7px;
    border-radius: var(--r-pill);
    color: var(--text2);
    font-size: var(--fs-md);
    font-weight: 500;
    background: color-mix(in srgb, var(--text) 5%, transparent);
    transition:
      background-color var(--t-fast) var(--ease),
      color var(--t-fast) var(--ease);
  }
  .vend :global(svg:last-child) {
    color: var(--text3);
  }
  .vend:active {
    background: color-mix(in srgb, var(--text) 10%, transparent);
  }
  @media (hover: hover) {
    .vend:hover {
      background: color-mix(in srgb, var(--text) 8%, transparent);
      color: var(--text);
    }
  }
  .vend-n {
    max-width: 140px;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }

  .search {
    flex: none;
    padding: 0 4px 6px;
  }

  .list {
    flex: 0 1 auto;
    min-height: 0;
    max-height: min(400px, 52dvh);
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-width: thin;
  }
  /* 有搜索框时列表定高：输入过滤时面板不缩成一截空玻璃 */
  .list.fixed {
    height: min(360px, 46dvh);
  }
  .grp {
    padding: 10px 10px 3px;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  .mrow {
    position: relative;
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    border-radius: 10px;
    text-align: left;
    color: var(--text);
    transition: background-color var(--t-fast) var(--ease);
  }
  .mrow:active {
    background: color-mix(in srgb, var(--text) 8%, transparent);
  }
  .mrow:focus-visible {
    outline: none;
    background: color-mix(in srgb, var(--text) 6%, transparent);
  }
  @media (hover: hover) {
    .mrow:hover {
      background: color-mix(in srgb, var(--text) 5%, transparent);
    }
  }
  .mtx {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .mn {
    font-size: var(--fs-base);
    line-height: 1.35;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .mrow.on .mn {
    font-weight: 600;
  }
  .mc {
    font-size: var(--fs-sm);
    line-height: 1.35;
    color: var(--text3);
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .ck {
    flex: none;
    width: 16px;
    display: inline-flex;
    color: var(--accent);
  }
  .none {
    margin: 6px 10px 10px;
    font-size: var(--fs-sm);
    color: var(--text3);
  }

  /* 下面几段：一根细线隔开（不跨到面板边，与行内边距对齐） */
  .sec {
    flex: none;
    margin-top: 6px;
    padding: 10px 10px 0;
    border-top: 1px solid var(--border);
  }
  .sec + .sec {
    margin-top: 8px;
  }
  .sec-h {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 2px;
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text3);
  }
  .row {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 32px;
    padding-bottom: 2px;
  }
  .row-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .row > .row-t {
    flex: 1;
  }
  .row-t {
    font-size: var(--fs-base);
    color: var(--text);
    line-height: 1.35;
  }
  .row-d {
    font-size: var(--fs-sm);
    color: var(--text3);
    line-height: 1.35;
  }

  /* 触屏：行高到 44、字号跟 iOS 菜单走大一号 */
  @media (pointer: coarse) {
    .menu {
      padding: 8px 8px 10px;
    }
    .mrow {
      min-height: 48px;
      padding: 9px 12px;
      border-radius: 14px;
    }
    .mn {
      font-size: var(--fs-body);
    }
    .vend {
      height: 32px;
    }
  }
</style>
