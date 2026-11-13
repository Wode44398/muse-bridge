<script lang="ts">
  // 顶栏右上角那颗按钮：上下文用量环 + 运行设置的入口（维护者 11-07：档位、访问范围、离开、目标、电脑、本机模型全部
  // 离开输入框，聚进它点开的上下文面板）。所以它恒在（以前只在吃进了上下文之后才出现）。
  //  · 环：>82% 转警示色；前缀缓存大概冷了就褪成灰（30 秒对一次钟）；新对话只有一圈底轨
  //  · 非默认（只读 / 计划 / 全权、仅工作空间、离开、目标）时环旁边写出摘要、亮墨色——以前输入框上档位胶囊的职责；
  //    窄屏只留图标
  //  · 用的是本机模型时右上角压一颗状态点（就绪绿 / 加载中朱色呼吸 / 没跑空心圈），以前本机胶囊的职责
  // 常驻同步也搬到这里（面板关着也得做）：切会话拉设备列表、新对话选的电脑在会话建立后补写；本机模型的状态轮询。
  // 本机控制面板（LocalAiMenu）锚在这颗按钮上：面板里点「本机模型」、或宿主（bridge 设置页）点名要看某一台时打开。
  import { untrack } from "svelte";
  import { app, cacheColdMinutes, permissionMode } from "../../lib/state.svelte.ts";
  import { dev, devicesSupported, loadDevices, setSessionDevice } from "../../lib/devices.svelte.ts";
  import { lai, localAiMismatch, localAiState, refreshLocalAi, setLocalEngine } from "../../lib/localai.svelte.ts";
  import { engineOfModel } from "../../lib/api.ts";
  import { isLocalProvider, runChip } from "../../lib/run-settings.ts";
  import { haptic } from "../../lib/touch.ts";
  import { pop } from "../../lib/motion.ts";
  import Icon from "../ui/Icon.svelte";
  import ContextPanel from "../sheets/ContextPanel.svelte";
  import LocalAiMenu from "../composer/LocalAiMenu.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t } from "../../lib/i18n.ts";

  let { wide = true }: { wide?: boolean } = $props();
  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  // ── 用量环 ──────────────────────────────────────────────────────────────────────────────
  const used = $derived(pane.chat.ctx.used);
  const limit = $derived(pane.chat.ctx.limit);
  const ctxPct = $derived(limit ? Math.min(100, (used / limit) * 100) : 0);
  let nowTick = $state(Date.now());
  $effect(() => {
    const timer = setInterval(() => (nowTick = Date.now()), 30_000);
    return () => clearInterval(timer);
  });
  const ctxCold = $derived(cacheColdMinutes(nowTick, pane.chat) !== null);
  const k = (n: number) => `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k`;
  const R = 7.25;
  const C = 2 * Math.PI * R;

  // ── 运行设置摘要 ─────────────────────────────────────────────────────────────────────────
  // 摘要沿用 mode-chip 的写法；自主是默认，按钮上不再写「自主 ·」打头
  const chip = $derived(runChip(pane.chat));
  const summary = $derived(permissionMode(pane.chat) === "auto" ? chip.text.split(" · ").slice(1).join(" · ") : chip.text);
  const isLocal = $derived(isLocalProvider(pane.chat));
  const laiPhase = $derived(localAiState());
  const laiClash = $derived(localAiMismatch() !== null);

  const ctxTitle = $derived(
    ctxPct > 0
      ? ctxCold
        ? t("上下文 {used} / {limit}（{pct}%），缓存大概已经冷了", { used: k(used), limit: k(limit), pct: Math.round(ctxPct) })
        : t("上下文 {used} / {limit}（{pct}%）", { used: k(used), limit: k(limit), pct: Math.round(ctxPct) })
      : t("运行设置：工作档位、工作权限与运行环境"),
  );
  const aria = $derived(
    (ctxPct > 0 ? t("上下文用量 {pct}%", { pct: Math.round(ctxPct) }) + " · " : "") +
      (chip.alt ? t("运行设置：{mode}", { mode: chip.text }) : t("运行设置")),
  );

  let btn: HTMLButtonElement | undefined = $state();
  let open = $state(false);
  let localOpen = $state(false);
  function toggle() {
    haptic("light");
    localOpen = false;
    open = !open;
  }
  // 面板里点「本机模型」：面板收起，本机控制面板接着从同一颗按钮弹出（弹层里不叠弹层）
  function openLocal() {
    open = false;
    localOpen = true;
  }

  // ── 常驻同步：电脑 ───────────────────────────────────────────────────────────────────────
  const sid = $derived(pane.chat.id ?? "");
  const supported = $derived(devicesSupported());
  // 只跟着会话 id 走（loadDevices 会写 dev.links，不隔开的话 effect 依赖上自己写的状态）
  $effect(() => {
    const s = sid;
    if (supported) untrack(() => void loadDevices(s));
  });
  // 新对话的草稿：会话一有 id 就写上去（分屏时只让有焦点的那一格写，草稿只有一份）
  $effect(() => {
    const s = sid;
    if (!s || !supported || !pane.focused) return;
    untrack(() => {
      const draft = dev.draft;
      if (!draft) return;
      dev.draft = "";
      void setSessionDevice(s, draft).catch(() => {});
    });
  });

  // ── 常驻同步：本机模型 ───────────────────────────────────────────────────────────────────
  // 两台引擎：状态点报的是当前型号那一台（Strata 125B 或 Qwen 27B）；控制面板开着时用户可能切去看另一台，不抢
  // Strata 按会话的型号问变体：在跑的不是它时状态按「变体不符」报（发出去会被拒，见 server/localai.ts）
  const localModel = $derived(pane.chat.cfg?.model ?? app.config?.model);
  const engine = $derived(engineOfModel(localModel));
  $effect(() => {
    if (isLocal && !lai.open) setLocalEngine(engine, localModel ?? ""); // 总是按会话定：没有型号也要把上个会话的变体清掉
  });
  // 轮询：平时 20 秒一拍保持状态点鲜活；控制面板开着或正在加载收紧到 2 秒
  $effect(() => {
    if (!isLocal) return;
    void refreshLocalAi();
    const iv = setInterval(() => void refreshLocalAi(), lai.open || laiPhase === "starting" ? 2000 : 20000);
    return () => clearInterval(iv);
  });
  // 宿主（bridge 设置页「本机模型」）点名要看某一台：有焦点的那格接住，从这颗按钮弹出控制面板
  $effect(() => {
    const req = app.localMenuReq;
    if (!req || !pane.focused || !btn) return;
    untrack(() => {
      app.localMenuReq = null;
      lai.open = true; // 先占住「面板开着」：上面那条见面板关着会把引擎拨回当前型号那一台
      setLocalEngine(req);
      open = false;
      localOpen = true;
    });
  });
</script>

{#if app.config}
  <button
    bind:this={btn}
    class="rb"
    class:alt={chip.alt}
    class:hot={ctxPct > 82}
    class:cold={ctxCold}
    class:open={open || localOpen}
    onclick={toggle}
    title={ctxTitle}
    aria-label={aria}
    aria-expanded={open}
    in:pop
  >
    <span class="ring">
      <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true">
        <circle class="trk" cx="9" cy="9" r={R} />
        {#if ctxPct > 0}<circle class="arc" cx="9" cy="9" r={R} stroke-dasharray="{(C * ctxPct) / 100} {C}" />{/if}
      </svg>
      {#if isLocal}
        <span class="ldot" class:on={laiPhase === "on" && !laiClash} class:starting={laiPhase === "starting" && !laiClash} class:clash={laiClash} aria-hidden="true"></span>
      {/if}
    </span>
    {#if chip.alt}
      <span class="sum" in:pop={{ from: 0.8 }}>
        <Icon name={chip.icon} size={14} />
        {#if wide && summary}<span class="sumt">{summary}</span>{/if}
      </span>
    {/if}
  </button>
{/if}

{#if open && btn}
  <ContextPanel anchor={btn} onclose={() => (open = false)} onlocal={openLocal} />
{/if}
{#if localOpen && btn}
  <LocalAiMenu anchor={btn} onclose={() => (localOpen = false)} />
{/if}

<style>
  .rb {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 32px;
    height: 32px;
    padding: 0 7px;
    border-radius: 10px;
    color: var(--text2);
    transition: background-color var(--t-fast) var(--ease);
  }
  .rb.open {
    background: var(--surface2);
  }
  @media (hover: hover) {
    .rb:hover {
      background: var(--surface2);
    }
  }
  .rb:active {
    background: var(--surface3);
  }

  .ring {
    position: relative;
    display: inline-flex;
    flex: none;
  }
  .ring svg {
    transform: rotate(-90deg);
  }
  .trk {
    fill: none;
    stroke: var(--border2);
    stroke-width: 2;
  }
  .arc {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2;
    stroke-linecap: round;
    transition:
      stroke-dasharray var(--t-slow) var(--ease-out),
      stroke var(--t-med) var(--ease);
  }
  .hot .arc {
    stroke: var(--warn);
  }
  .cold .arc {
    stroke: var(--text3);
  }

  /* 非默认设置的摘要：墨色字（与以前档位胶囊亮起时同一个意思），不另加底色 */
  .sum {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    color: var(--accent);
  }
  .sumt {
    max-width: 14em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: var(--fs-sm);
    font-weight: 500;
  }

  /* 本机模型状态点：压在环的右上角 */
  .ldot {
    position: absolute;
    top: -2px;
    right: -3px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--bg);
    box-shadow: inset 0 0 0 1.5px var(--text3);
  }
  .ldot.on {
    background: var(--ok);
    box-shadow: 0 0 0 2px var(--bg);
  }
  .ldot.clash {
    background: var(--warn);
    box-shadow: 0 0 0 2px var(--bg);
  }
  .ldot.starting {
    background: var(--live);
    box-shadow: 0 0 0 2px var(--bg);
    animation: rb-breathe 1.4s var(--ease-in-out) infinite;
  }
  @keyframes rb-breathe {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ldot.starting {
      animation: none;
    }
  }
</style>
