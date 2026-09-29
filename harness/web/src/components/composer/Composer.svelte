<script lang="ts">
  // 输入框：一张浮起的卡，与对话列同宽同中线，钉在底部（离底 14px + 安全区；手机软键盘弹起时贴住键盘上沿）。
  //  · 卡里从上到下：回应卡片的说明 / 目标模式的选项 · 附件芯片 · 文本域 · 底行
  //  · 底行：左 = ＋附件 · 档位胶囊（运行档位 / 访问范围 / 离开 / 目标，09-26 把目标并进来）；
  //    右 = 型号胶囊（厂商小标 + 型号 + 思考档）· 发送键
  //  · 卡的高度随内容平滑生长（smoothHeight；内容贴底——长高时从上沿露出来，底行和发送键原地不动）
  //  · 菜单（型号 / 档位 / 本机）渲染在卡外（G3）；斜杠面板从卡的上沿浮出、与卡同宽
  //  · 粘贴 / 拖放挂在 window 上（不用先点输入框），只在目标位于本应用 .hxroot 内时接管（嵌入 bridge 时不截胡宿主的输入框）
  //
  // 草稿跟着会话走（chat.draft，N42 / U4；分屏时两格各是各的）。停着一张卡时，草稿【开始写的那一刻】它就停着，发送就回应它
  //（权限卡 = 拒绝并附上这段话、提问 = 作答、计划 = 退回并附意见，N43）；之后才停进来的卡不算。敲键盘的时刻记给停靠区
  //（正在打字就先不停新卡）。
  import { onMount, untrack } from "svelte";
  import {
    accessMode,
    addSessionRef,
    app,
    awayMode,
    builtinBlocked,
    canRefSessions,
    goalAvailable,
    loadCommands,
    modelsOf,
    permissionMode,
    readRoots,
    runBuiltin,
    send,
    slashCommands,
    toggleGoalDraft,
  } from "../../lib/state.svelte.ts";
  import { completion, paletteItems, parseBuiltin, slashQuery, type Builtin, type PaletteItem } from "../../lib/slash.ts";
  import { pendingCards, replyHint, replyPlaceholder, replyTarget } from "../../lib/card-dock.ts";
  import { attachUp, dropEntries, pasteEntries, uploadEntries } from "../../lib/attach.svelte.ts";
  import type { IconName } from "../../lib/icons.ts";
  import { haptic } from "../../lib/touch.ts";
  import { fade, smoothHeight } from "../../lib/motion.ts";
  import { dnd, dropTarget, type DragPayload } from "../../lib/dnd.svelte.ts";
  import { modeChip } from "../../lib/mode-chip.ts";
  import { usePane } from "../../lib/pane.ts";
  import { t, tr } from "../../lib/i18n.ts";
  import Icon from "../ui/Icon.svelte";
  import Chip from "../ui/Chip.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Button from "../ui/Button.svelte";
  import VendorLogo from "../brand/VendorLogo.svelte";
  import AttachChips from "./AttachChips.svelte";
  import GoalOptions from "./GoalOptions.svelte";
  import SendButton from "./SendButton.svelte";
  import SlashPalette from "./SlashPalette.svelte";
  import DropOverlay from "./DropOverlay.svelte";
  import ModelMenu from "./ModelMenu.svelte";
  import ModeMenu from "./ModeMenu.svelte";

  // 分屏：这一格的会话（没分屏 = app.chat）。显示一律认它；动作走 state 里的函数（作用于 app.chat）——点进这一格、焦点
  // 落进这一格时它先成为 app.chat（ChatPane 捕获阶段挪焦点），所以两者此刻是同一个
  const pane = usePane();
  let ta: HTMLTextAreaElement | undefined = $state();
  let card: HTMLDivElement | undefined = $state();
  const paletteId = `hx-slash-${Math.random().toString(36).slice(2, 8)}`;

  // ── 环境 ────────────────────────────────────────────────────────────────────────────────
  // 触屏：回车是换行、发送靠按钮（Q3：接上 / 拔掉键盘时跟着变，不再只在挂载时算一次）。
  // compact：卡片窄（手机、或宽屏开着工作区）时底行只留图标。kb：手机软键盘弹起——卡贴住键盘上沿，不再垫底部安全区。
  const coarseMq = matchMedia("(pointer: coarse)");
  let coarse = $state(coarseMq.matches);
  let compact = $state(false);
  let kb = $state(false);
  onMount(() => {
    const onCoarse = (e: MediaQueryListEvent) => (coarse = e.matches);
    coarseMq.addEventListener("change", onCoarse);
    const ro = new ResizeObserver(() => {
      if (card) compact = card.clientWidth < 520;
    });
    if (card) ro.observe(card);
    // 软键盘：同一个物理朝向下见过的最大可视高度，比它矮了一截就当键盘弹着（resizes-content 下布局已经让出了键盘的位置）
    const vv = window.visualViewport;
    const tallest: Record<string, number> = {};
    const onViewport = () => {
      if (!vv) return;
      const key = screen.orientation?.type ?? "any";
      tallest[key] = Math.max(tallest[key] ?? 0, vv.height);
      kb = coarse && tallest[key] - vv.height > 120;
    };
    onViewport();
    vv?.addEventListener("resize", onViewport);
    return () => {
      coarseMq.removeEventListener("change", onCoarse);
      ro.disconnect();
      vv?.removeEventListener("resize", onViewport);
    };
  });

  // 没有调用方（首页示例已去掉，不要加回），留着无害
  export function fill(text: string) {
    pane.chat.draft = text;
    ta?.focus();
  }

  // M3：退回来的话（没送达 / 插话被退回 / 撤回 / 卡片没送达 / 改写）接进输入框，已经在打的字留在前面，接完清掉。
  // 只依赖 app.refill——读草稿走 untrack，免得 effect 读写同一个 $state 自己触发自己（G2）。
  $effect(() => {
    const back = app.refill;
    if (back == null) return;
    app.refill = null;
    untrack(() => {
      app.chat.draft = app.chat.draft.trim() ? `${app.chat.draft}\n${back}` : back; // 退回的话属于有焦点的那一格
    });
  });

  // ── 草稿与回应对象（P10 / N43）──────────────────────────────────────────────────────────
  const hasText = $derived(Boolean(pane.chat.draft.trim()));
  function onInput(e: Event) {
    const c = pane.chat;
    c.lastInputAt = Date.now(); // 停靠区：正在打字就先不停新卡
    const value = (e.currentTarget as HTMLTextAreaElement).value;
    if (!value.trim()) c.draftTarget = undefined; // 草稿清空 → 忘掉
    else if (c.draftTarget === undefined) c.draftTarget = c.dockedCardId; // 草稿开始写的这一刻停着谁（可能没有）
  }
  const pendingNow = $derived(pendingCards(pane.chat.timeline, pane.chat.running));
  const dockedCard = $derived(pendingNow.find((x) => x.id === pane.chat.dockedCardId) ?? null);
  const target = $derived(hasText ? replyTarget(pane.chat.draftTarget, pane.chat.dockedCardId, pendingNow) : null);
  const targetIcon = $derived<IconName>(target?.kind === "permission" ? "shield" : target?.kind === "ask" ? "question" : "todo");
  function asSteer() {
    haptic("light");
    pane.chat.draftTarget = null;
    ta?.focus();
  }

  // O7（K64）：目标模式——开着时发出去的这条就是目标（运行中、回应卡片时不给开）。开关在档位菜单里
  const goalOk = $derived(goalAvailable() && !pane.chat.running && !target);
  const goalOn = $derived(goalOk && Boolean(pane.chat.goalDraft?.on));
  function toggleGoal() {
    toggleGoalDraft();
    haptic("light");
  }

  // 运行中也能发：发送 = 插话（附件不能插话——注入点只吃文字，运行中只看有没有字）
  const canSend = $derived(pane.chat.running ? hasText : hasText || pane.chat.attachments.length > 0 || pane.chat.refs.length > 0);
  const sendKind = $derived<"send" | "steer" | "reply">(target ? "reply" : pane.chat.running ? "steer" : "send");

  const placeholder = $derived(
    dockedCard && !hasText
      ? replyPlaceholder(dockedCard)
      : goalOn
        ? t("写下要达成的目标——没达成会自动一轮轮接着做")
        : pane.chat.running
          ? t("运行中——可以插话纠偏，它会在下一步读到")
          : app.config
            ? t("描述要做的事")
            : t("连接中…"),
  );

  // ── 底行胶囊的内容 ───────────────────────────────────────────────────────────────────────
  // 全局配置跟着有焦点的那一格；分屏里没焦点的那一格显示它自己的快照（新对话没有快照，照旧按全局）
  const shownCfg = $derived(pane.focused || !pane.chat.cfg ? app.config : { ...app.config, ...pane.chat.cfg });
  const models = $derived(app.info ? modelsOf(shownCfg?.provider) : []);
  const curModel = $derived(models.find((m: any) => m.id === shownCfg?.model));
  const modelLabel = $derived<string>(tr(curModel?.label ?? shownCfg?.model ?? "…")); // 型号名来自服务端 catalog（个别带中文注）
  const thinking = $derived<string>(shownCfg?.thinking ?? "off");
  // effortLabels 是服务端 catalog 的数据（开关式档位写「开启」），这里只拿来比对
  const thinkingLabel = $derived(curModel?.effortLabels?.[thinking] === "开启" /* i18n-ignore */ ? t("思考") : thinking);
  const modelAria = $derived(
    thinking !== "off" ? t("模型：{model}，思考：{effort}", { model: modelLabel, effort: thinkingLabel }) : t("模型：{model}", { model: modelLabel }),
  );
  const vid = $derived(shownCfg?.provider ?? "anthropic");

  // 档位胶囊：非默认（只读 / 计划、仅工作空间、离开、本会话放行了工作区外的目录、这条是目标）才写出来、亮墨色（lib/mode-chip.ts）
  const access = $derived(accessMode(pane.chat));
  const chipState = $derived(
    modeChip({
      mode: permissionMode(pane.chat),
      access,
      roots: access === "workspace" ? readRoots(pane.chat).length : 0,
      away: awayMode(pane.chat),
      goal: goalOn,
    }),
  );
  const modeText = $derived(chipState.text);
  const modeAlt = $derived(chipState.alt);

  // ── 菜单（锚点 = 点开它的那颗胶囊；再点一次收起）─────────────────────────────────────────
  let modelAnchor = $state<HTMLElement | null>(null);
  let modeAnchor = $state<HTMLElement | null>(null);
  function toggleModel(e: MouseEvent) {
    haptic("light");
    modelAnchor = modelAnchor ? null : (e.currentTarget as HTMLElement);
  }
  function toggleMode(e: MouseEvent) {
    haptic("light");
    modeAnchor = modeAnchor ? null : (e.currentTarget as HTMLElement);
  }
  function openAttach() {
    haptic("light");
    app.sheet = "attach";
  }

  // ── 斜杠面板（E3 / G7）：聚焦、以 / 开头还没敲空格时出现；回应卡片时不出；Esc 关掉的那一截草稿不再弹 ─────────
  let focused = $state(false);
  let slashSel = $state(0);
  let slashClosedFor = $state<string | null>(null);
  const slashQ = $derived(target ? null : slashQuery(pane.chat.draft));
  const slashOpen = $derived(slashQ !== null && focused && slashClosedFor !== pane.chat.draft);
  const slashItems = $derived(
    slashOpen
      ? paletteItems(slashQ ?? "", slashCommands.list?.skills ?? [], slashCommands.list?.packages ?? [], { disabled: builtinBlocked })
      : [],
  );
  $effect(() => {
    if (slashOpen) untrack(() => void loadCommands()); // 打开时取技能清单（一分钟内不重取）
  });
  $effect(() => {
    void slashQ;
    slashSel = 0; // 候选变了就回到第一项
  });
  function closeSlash() {
    slashClosedFor = pane.chat.draft;
  }

  async function runSlashBuiltin(b: Builtin, args: string) {
    const chat = pane.chat;
    const idle = !chat.running;
    if (!(await runBuiltin(b, args))) return; // 用不了（已提示为什么）：话留在输入框里
    // Q1：/goal 目标 发出去时撞上并发上限，send() 只弹提示、没起这一轮——话留着（目标开关已经开了），不清
    if (b.id === "goal" && args && idle && !chat.running) return;
    chat.draft = "";
    chat.draftTarget = undefined;
  }
  function pickSlash(item: PaletteItem) {
    // 不带参数的内置命令：选中即执行；其余补成「/名字 」接着写
    if (item.kind === "builtin" && !item.builtin.argHint) {
      void runSlashBuiltin(item.builtin, "");
      return;
    }
    pane.chat.draft = completion(item);
    ta?.focus();
  }

  // ── 发送（U1：Enter 与点按同一条路，发出后冷却 800ms，连点 / 连按只发一次）─────────────────────
  let cooling = $state(false);
  let coolTimer = 0;
  function submit() {
    if (!canSend || cooling) return;
    const chat = pane.chat;
    const text = chat.draft;
    // E3：内置命令（/new、/compact、/handoff、/goal 目标）是界面动作，不发给模型；/技能名 照常发出、由服务端展开
    const builtin = !target && !chat.attachments.length ? parseBuiltin(text) : null;
    if (builtin) {
      void runSlashBuiltin(builtin.builtin, builtin.args);
      return;
    }
    const to = target?.id ?? null;
    const keepTarget = chat.draftTarget;
    const wasRunning = chat.running;
    const queued = chat.pendingSteers.length;
    chat.draft = "";
    chat.draftTarget = undefined;
    cooling = true;
    clearTimeout(coolTimer);
    coolTimer = window.setTimeout(() => (cooling = false), 800);
    haptic("light");
    void send(text, to);
    // Q1：send() 有两种情况会原样退回、只弹一句提示——同时在跑的已经有 3 个；这一轮的会话还没建立就插话。
    // 以前草稿已经清了，这段话就丢了。不在这里照抄它的判断：发出之后同步核对——空闲时应当已经起了一轮，
    // 运行中应当已经进了待送达托盘；都没有就把话放回来（回应卡片那条路没送达时 send() 自己会放回来）。
    const took = to !== null || (wasRunning ? chat.pendingSteers.length > queued : chat.running);
    if (!took) {
      chat.draft = text;
      chat.draftTarget = keepTarget;
    }
  }

  function onKey(e: KeyboardEvent) {
    // Q2：输入法组字中的回车 / 方向键不算——Safari 提交组字的那一下回车 isComposing 是 false，但 keyCode 是 229
    const composing = e.isComposing || e.keyCode === 229;
    if (slashOpen && slashItems.length && !composing) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const n = slashItems.length;
        slashSel = (slashSel + (e.key === "ArrowDown" ? 1 : n - 1)) % n;
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        pickSlash(slashItems[Math.min(slashSel, slashItems.length - 1)]);
        return;
      }
    }
    // （Esc 一般先被浮层栈接走、关掉面板；这里兜底）
    if (slashOpen && e.key === "Escape") {
      e.preventDefault();
      closeSlash();
      return;
    }
    // 桌面：回车发送、Shift+回车换行；触屏：回车就是换行
    if (e.key === "Enter" && !e.shiftKey && !coarse && !composing) {
      e.preventDefault();
      submit();
    }
  }

  // ── 粘贴 / 拖放 → 附件（G4 / G5）────────────────────────────────────────────────────────
  // 监听挂 window；输入框看不见（被 keep-alive 藏起来）时不接管；目标不在本应用里（嵌入 bridge 时宿主的输入框）不截胡。
  function visible(): boolean {
    return Boolean(ta && ta.isConnected && ta.getBoundingClientRect().width > 0);
  }
  function inScope(el: EventTarget | null): boolean {
    if (!el || el === document.body || el === document.documentElement) return true;
    const root = ta?.closest(".hxroot");
    return Boolean(root && el instanceof Node && root.contains(el));
  }
  function onPaste(e: ClipboardEvent) {
    if (!pane.focused || !app.features.files || !visible()) return; // 分屏：只有有焦点的那一格接（附件进 app.chat）
    const entries = pasteEntries(e);
    if (!entries.length) return; // 纯文字照常粘贴
    if (!inScope(e.target)) return;
    e.preventDefault(); // 有文件时不往输入框里贴路径文字
    void uploadEntries(entries);
  }
  let dragOver = $state(false);
  let dragDepth = 0;
  const hasFiles = (e: DragEvent) => Boolean(e.dataTransfer && Array.from(e.dataTransfer.types).includes("Files"));
  function onDragEnter(e: DragEvent) {
    if (!pane.focused || !app.features.files || !hasFiles(e) || !visible() || !inScope(e.target)) return;
    e.preventDefault();
    dragDepth++;
    dragOver = true;
  }
  function onDragOver(e: DragEvent) {
    if (!dragOver) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
  }
  function onDragLeave(e: DragEvent) {
    if (!dragOver || !inScope(e.target)) return; // 进出成对：进来时没算的那个元素，出去时也不减
    if (--dragDepth <= 0) {
      dragDepth = 0;
      dragOver = false;
    }
  }
  function onDragEnd() {
    dragDepth = 0;
    dragOver = false;
  }
  async function onDrop(e: DragEvent) {
    const eligible = dragOver || (pane.focused && app.features.files && hasFiles(e) && visible() && inScope(e.target));
    onDragEnd();
    if (!eligible || !e.dataTransfer) return;
    e.preventDefault(); // 不然浏览器直接导航去打开这个文件
    // dropEntries 必须在 drop 的同步阶段调用（它先一口气取完 entry，再异步遍历；文件夹最多收 300 个）
    const entries = await dropEntries(e.dataTransfer);
    void uploadEntries(entries);
  }

  // ── 把侧栏的会话块拖进来 = 引用那个对话（服务端能力位 "session-refs"；自己不能引用自己）───────────────
  const refDropKey = `ref-${paletteId}`;
  const refDropOk = (p: DragPayload) => p.kind === "session" && canRefSessions() && p.id !== pane.chat.id;
  function onRefDrop(p: DragPayload) {
    if (addSessionRef(pane.chat, { id: p.id, title: p.title, ...(p.provider ? { provider: p.provider } : {}) })) {
      haptic("light");
      ta?.focus({ preventScroll: true });
    }
  }
  const refOver = $derived(dnd.on && dnd.overKey === refDropKey);
  const refCandidate = $derived(dnd.on && dnd.kind === "session" && canRefSessions() && dnd.id !== pane.chat.id);

  // ── 动作 ──────────────────────────────────────────────────────────────────────────────
  // G8：旧 WebView 没有 field-sizing: content → JS 自增高兜底（程序化清空 / 填入也要重排；新内核直接跳过）
  function autosize(node: HTMLTextAreaElement, _value: string) {
    const native = typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");
    if (native) return {};
    const fit = () => {
      node.style.height = "auto";
      node.style.height = `${node.scrollHeight}px`; // CSS 的 max-height 负责封顶，超出后内部滚动
    };
    node.addEventListener("input", fit);
    requestAnimationFrame(fit);
    return {
      update() {
        requestAnimationFrame(fit);
      },
      destroy() {
        node.removeEventListener("input", fit);
      },
    };
  }
  // 点在卡片的空白处（底行中间、边距）= 点输入框
  function padFocus(node: HTMLElement) {
    const down = (e: PointerEvent) => {
      const hit = e.target as Element | null;
      if (!hit || hit.closest("button, a, input, textarea, select, label, [role='option']")) return;
      e.preventDefault();
      ta?.focus();
    };
    node.addEventListener("pointerdown", down);
    return {
      destroy() {
        node.removeEventListener("pointerdown", down);
      },
    };
  }
</script>

<svelte:window onpaste={onPaste} ondragenter={onDragEnter} ondragover={onDragOver} ondragleave={onDragLeave} ondragend={onDragEnd} ondrop={onDrop} />

{#snippet modeLabel()}{modeText}{/snippet}
{#snippet vendorMark()}<VendorLogo skin={vid} size={15} />{/snippet}
{#snippet modelText()}
  <span class="mlab">
    <span class="mname">{modelLabel}</span>
    {#if thinking !== "off"}<span class="mdot" aria-hidden="true">·</span><span class="meff">{thinkingLabel}</span>{/if}
  </span>
{/snippet}

<div class="composer" class:kb>
  <div class="anchor">
    {#if slashOpen}
      <SlashPalette id={paletteId} items={slashItems} selected={slashSel} onpick={pickSlash} onhover={(i) => (slashSel = i)} onclose={closeSlash} />
    {/if}

    <div
      class="card"
      class:focus={focused}
      class:refable={refCandidate}
      class:refover={refOver}
      bind:this={card}
      use:smoothHeight
      use:dropTarget={{ key: refDropKey, accept: refDropOk, label: t("引用这个对话"), drop: onRefDrop }}
    >
      <div class="inner" use:padFocus>
        {#if target}
          <!-- P10（N43）：这段话发出去就回应上面那张卡；不想这样就改回插话 -->
          <div class="reply" in:fade={{ duration: 160 }} out:fade={{ duration: 120 }}>
            <span class="ric"><Icon name={targetIcon} size={15} /></span>
            <span class="rtext">{replyHint(target)}</span>
            <Button size="sm" variant="ghost" onclick={asSteer}>{t("改为插话")}</Button>
          </div>
        {:else if goalOn && pane.chat.goalDraft}
          <div in:fade={{ duration: 160 }} out:fade={{ duration: 120 }}><GoalOptions /></div>
        {/if}

        {#if pane.chat.attachments.length || pane.chat.refs.length || (pane.focused && attachUp.active)}
          <div in:fade={{ duration: 160 }} out:fade={{ duration: 120 }}><AttachChips /></div>
        {/if}

        <textarea
          bind:this={ta}
          bind:value={pane.chat.draft}
          use:autosize={pane.chat.draft}
          rows="1"
          {placeholder}
          aria-label={t("输入消息")}
          aria-autocomplete="list"
          aria-controls={slashOpen ? paletteId : undefined}
          aria-activedescendant={slashOpen && slashItems.length ? `${paletteId}-${slashSel}` : undefined}
          enterkeyhint={coarse ? "enter" : "send"}
          onkeydown={onKey}
          oninput={onInput}
          onfocus={() => (focused = true)}
          onblur={() => (focused = false)}
        ></textarea>

        <div class="bar">
          <div class="lead">
            {#if app.features.files}
              <span class="ctl"><IconButton icon="plus" label={t("添加文件")} size={32} iconSize={18} onclick={openAttach} /></span>
            {/if}
            <span class="ctl">
              <Chip
                icon={chipState.icon}
                tone={modeAlt ? "accent" : "plain"}
                chevron
                open={Boolean(modeAnchor)}
                label={t("档位：{mode}", { mode: modeText })}
                title={t("运行档位（自主执行 / 只读 / 先出计划）、访问范围（整机 / 仅工作空间）、离开模式与目标模式")}
                children={compact ? undefined : modeLabel}
                onclick={toggleMode}
              />
            </span>
          </div>
          <div class="tail">
            {#if app.config}
              <!-- 型号胶囊也是换厂商的入口（菜单最后一项；顶栏已经没有厂商按钮） -->
              <span class="ctl mwrap">
                <Chip
                  leading={vendorMark}
                  children={modelText}
                  chevron
                  open={Boolean(modelAnchor)}
                  label={modelAria}
                  title={t("模型与思考深度")}
                  onclick={toggleModel}
                />
              </span>
            {/if}
            <SendButton
              kind={sendKind}
              disabled={!canSend || cooling}
              label={target ? t("回应卡片") : pane.chat.running ? t("插话") : t("发送")}
              title={target ? replyHint(target) : pane.chat.running ? t("插话：它会在下一步读到这条") : undefined}
              onclick={submit}
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

{#if dragOver}
  <DropOverlay />
{/if}

<!-- G3：菜单不渲染在卡片里（Popover 自己也会挪到 .hxroot 下） -->
{#if modelAnchor}
  <ModelMenu anchor={modelAnchor} onclose={() => (modelAnchor = null)} />
{/if}
{#if modeAnchor}
  <ModeMenu anchor={modeAnchor} onclose={() => (modeAnchor = null)} goal={goalOk ? { on: goalOn, toggle: toggleGoal } : null} />
{/if}

<style>
  .composer {
    position: relative;
    z-index: 2;
    flex: none;
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
    padding: 0 20px calc(14px + var(--sab, 0px));
  }
  .composer.kb {
    padding-bottom: 8px;
  }
  .anchor {
    position: relative;
  }

  /* 卡：浮起的一张纸——更白的纸色、一圈细线、上沿一道高光（纸的厚度）、暖墨投影。
     聚焦时细线与投影各深一档，不加粗框。内容贴底（smoothHeight 动的是卡的高度） */
  .card {
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    border-radius: 22px;
    background: var(--surface);
    box-shadow:
      inset 0 1px 0 var(--sheen),
      0 0 0 1px var(--border),
      var(--shadow-1);
    transition: box-shadow var(--t-med) var(--ease);
  }
  .card.focus {
    box-shadow:
      inset 0 1px 0 var(--sheen),
      0 0 0 1px var(--border2),
      var(--shadow-2);
  }
  /* 侧栏正拎着一个会话：卡的细线深一档（这里能放）；拖到卡上方：墨色描边 + 一层淡墨（松手就引用） */
  .card.refable {
    box-shadow:
      inset 0 1px 0 var(--sheen),
      0 0 0 1px var(--border2),
      var(--shadow-1);
  }
  .card.refover {
    background: linear-gradient(var(--accent-soft), var(--accent-soft)), var(--surface);
    box-shadow:
      inset 0 1px 0 var(--sheen),
      0 0 0 1.5px var(--accent),
      var(--shadow-2);
  }
  .inner {
    flex: none;
    min-width: 0;
    padding: 8px 8px 8px 10px;
  }

  /* 回应卡片的说明 */
  .reply {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 0 0 4px 6px;
    font-size: var(--fs-sm);
    line-height: var(--lh-ui);
    color: var(--accent);
  }
  .ric {
    display: inline-flex;
    flex: none;
  }
  .rtext {
    flex: 1;
    min-width: 0;
  }

  textarea {
    display: block;
    width: 100%;
    margin: 0;
    padding: 6px;
    border: 0;
    outline: 0;
    resize: none;
    background: none;
    color: var(--text);
    caret-color: var(--live);
    font-family: inherit;
    font-size: var(--fs-body);
    line-height: 1.6;
    field-sizing: content;
    min-height: calc(1.6em + 12px);
    max-height: min(calc(8 * 1.6em + 12px), 38vh);
    max-height: min(calc(8 * 1.6em + 12px), 38dvh);
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  textarea::placeholder {
    color: var(--text3);
  }
  textarea:focus-visible {
    outline: none;
  }

  /* 底行 */
  .bar {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 36px;
    padding-top: 2px;
  }
  .lead {
    display: flex;
    align-items: center;
    gap: 2px;
    flex: none;
    min-width: 0;
  }
  .tail {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 6px;
    flex: 1 1 auto;
    min-width: 0;
  }
  .ctl {
    display: inline-flex;
    flex: none;
    min-width: 0;
  }
  /* 型号胶囊是底行唯一会让的：地方不够时型号名先省略（档位、目标这些状态优先） */
  .mwrap {
    flex: 0 1 auto;
  }
  .mwrap > :global(button) {
    min-width: 0;
  }
  .mlab {
    display: flex;
    align-items: baseline;
    min-width: 0;
  }
  .mname {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .mdot {
    flex: none;
    margin: 0 5px;
    color: var(--text3);
  }
  .meff {
    flex: none;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    font-weight: 400;
    color: var(--text3);
  }
  /* 触屏：底行控件看着 30–32，点得到 40+（伪元素外扩触控区，不改外观） */
  @media (pointer: coarse) {
    .ctl > :global(button) {
      position: relative;
    }
    .ctl > :global(button)::after {
      content: "";
      position: absolute;
      inset: -5px -2px;
    }
  }

  @media (max-width: 699px) {
    .composer {
      padding-left: 12px;
      padding-right: 12px;
    }
  }
</style>
