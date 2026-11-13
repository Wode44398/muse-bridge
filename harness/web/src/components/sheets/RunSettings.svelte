<script lang="ts">
  // 上下文面板里的运行设置（维护者 11-07：这些设置全部离开输入框，聚到右上角的上下文面板里）。三段：
  //  · 工作档位：自主 / 只读 / 计划 / 全权（全权只给管理员——租户实例 accessLocked 时不列），下面两个开关：
  //    目标模式（这条消息当目标；运行中、正在回应卡片时没有）、离开模式（会话建立后才有）
  //  · 工作权限：整机 / 仅工作空间（整机是默认，维护者 09-26）；本会话放行的工作区外只读目录列在下面、可收回。
  //    全权档本身就是整机 + 跳过密钥守卫，这一段让开；老后端没有 access 字段、租户实例被锁定时也不出现
  //  · 运行环境：这个会话连哪台电脑（点开就地展开候选）、本机模型服务（点了交给顶栏按钮打开本机面板）
  // 每一项对【当前会话】当场生效（运行中也算数，「只读」就是给正在跑的 agent 拉手刹），同时写成新对话的默认；
  // 失败由 state 回滚并提示。和以前的档位菜单不同，选了不关面板——一次能把几项都调好。
  import {
    accessMode,
    app,
    awayMode,
    dropReadRoot,
    permissionMode,
    readRoots,
    setAccessMode,
    setAwayMode,
    setPermissionMode,
    toggleGoalDraft,
    type AccessMode,
    type RunPermissionMode,
  } from "../../lib/state.svelte.ts";
  import { dev, devicesSupported, effectiveDevice, loadDevices, setSessionDevice, type DeviceRow } from "../../lib/devices.svelte.ts";
  import { localAiState, localAiStateText } from "../../lib/localai.svelte.ts";
  import { goalState, isLocalProvider } from "../../lib/run-settings.ts";
  import { MODE_LABEL } from "../../lib/mode-chip.ts";
  import { haptic } from "../../lib/touch.ts";
  import { collapse } from "../../lib/motion.ts";
  import Segmented from "../ui/Segmented.svelte";
  import Switch from "../ui/Switch.svelte";
  import Icon from "../ui/Icon.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import MenuItem from "../ui/MenuItem.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t } from "../../lib/i18n.ts";

  let { onlocal, onclose }: { onlocal: () => void; onclose: () => void } = $props();

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  // ── 工作档位 ─────────────────────────────────────────────────────────────────────────────
  const NOTE: Record<RunPermissionMode, string> = {
    auto: t("直接执行。规则可把个别高危调用改成每次问我。"),
    "read-only": t("只放行读取类工具，写文件与执行命令一律拒绝。"),
    plan: t("只读研究 → 提交计划 → 你批准后当场转自主并开工。"),
    bypass: t("所有工具调用直接执行、不弹卡，整机可读写，连密钥守卫都关掉。谨慎使用。"),
  };
  const current = $derived(permissionMode(pane.chat));
  // 全权档（bypass）仅管理员可用：多用户服务端的租户实例（accessLocked）里连这一档都不列出来
  const canBypass = $derived(!app.config?.accessLocked);
  const modeOpts = $derived(
    (["auto", "read-only", "plan", "bypass"] as RunPermissionMode[])
      .filter((m) => m !== "bypass" || canBypass)
      .map((m) => ({ value: m, label: MODE_LABEL[m] })),
  );
  function pickMode(m: RunPermissionMode) {
    haptic("light");
    void setPermissionMode(m);
  }

  const goal = $derived(goalState(pane.chat));
  function setGoal(on: boolean) {
    if (on === goal.on) return;
    toggleGoalDraft();
    // 开了之后输入框上方出目标选项（验证命令、轮数），面板让开、回去写目标
    if (on) onclose();
  }
  // P3：离开模式是会话级的——会话建立（发出第一条消息）后才有得切
  const hasSession = $derived(Boolean(pane.chat.id));
  const away = $derived(awayMode(pane.chat));

  // ── 工作权限 ─────────────────────────────────────────────────────────────────────────────
  const SCOPES: { value: AccessMode; label: string; icon: "monitor" | "folder"; note: string }[] = [
    { value: "full", icon: "monitor", label: t("整机可访问"), note: t("可用绝对路径读写工作空间以外的文件（密钥文件始终封锁）。") },
    { value: "workspace", icon: "folder", label: t("仅工作空间"), note: t("路径一越界就拦下，防误操作。") },
  ];
  const scope = $derived(accessMode(pane.chat));
  const hasScope = $derived(app.config?.access !== undefined && !app.config?.accessLocked && current !== "bypass");
  // P13：本会话在权限卡上放行的工作区外只读目录（仅工作空间时才有意义）
  const roots = $derived(readRoots(pane.chat));
  function pickScope(s: AccessMode) {
    haptic("light");
    void setAccessMode(s);
  }
  function dropRoot(dir: string) {
    haptic("light");
    void dropReadRoot(dir);
  }

  // ── 运行环境：电脑 ───────────────────────────────────────────────────────────────────────
  // 同步（切会话拉列表、新对话的草稿在会话建立后补写）由顶栏按钮常驻做；这里只负责看和改
  const sid = $derived(pane.chat.id ?? "");
  const showDevices = $derived(devicesSupported() && dev.available && dev.enabled && dev.list.length > 0);
  const cur = $derived(effectiveDevice(sid));
  const selected = $derived(sid ? (dev.links[sid] ?? "") : dev.draft);
  const devText = $derived(
    cur.kind === "none" ? t("不连电脑") : cur.kind === "missing" ? t("设备已不在") : cur.device ? cur.device.name || t("电脑") : t("选电脑"),
  );
  const devTone = $derived(
    cur.kind === "linked" || (cur.kind === "auto" && cur.device) ? ((cur as { device: DeviceRow }).device.online ? "on" : "off") : "idle",
  );
  let devOpen = $state(false);
  let devErr = $state("");
  function toggleDevices() {
    haptic("light");
    devErr = "";
    devOpen = !devOpen;
    if (devOpen) void loadDevices(sid, true);
  }
  async function chooseDevice(link: string) {
    haptic("light");
    devErr = "";
    if (!sid) {
      dev.draft = link;
      devOpen = false;
      return;
    }
    try {
      await setSessionDevice(sid, link);
      devOpen = false;
    } catch (e) {
      devErr = (e as Error).message || String(e);
    }
  }
  const tierText = (d: DeviceRow) => {
    const tier = d.client?.tier ?? "";
    if (!d.online) return d.lastOnlineAt ? t("离线") : t("还没连上过");
    if (tier === "control") return t("在线 · 可操作");
    if (tier === "observe") return t("在线 · 只看，动手前问你");
    if (tier === "off") return t("在线 · 已关闭 agent 操作");
    if (tier === "workspace") return t("在线 · 老客户端");
    return t("在线");
  };

  // ── 运行环境：本机模型 ───────────────────────────────────────────────────────────────────
  const isLocal = $derived(isLocalProvider(pane.chat));
  const laiPhase = $derived(localAiState());
  const laiText = $derived(localAiStateText());
</script>

<div class="rs">
  <section>
    <h4>{t("工作档位")}</h4>
    <Segmented full size="sm" options={modeOpts} value={current} onchange={pickMode} label={t("工作档位")} />
    <p class="note" class:warn={current === "bypass"}>{NOTE[current]}</p>
    {#if goal.ok}
      <div class="line">
        <span class="lic"><Icon name="target" size={17} /></span>
        <span class="ltx">
          <span class="lt">{t("目标模式")}</span>
          <span class="ls">
            {goal.on
              ? t("开着：这条消息就是目标，没达成会自动一轮轮接着做；输入框上方可以给验证命令、定轮数。")
              : t("这条消息当作目标：没达成就自动一轮轮接着做（可以给一条验证命令，过了才算达成）。")}
          </span>
        </span>
        <Switch checked={goal.on} onchange={setGoal} label={t("目标模式")} />
      </div>
    {/if}
    {#if hasSession}
      <div class="line">
        <span class="lic"><Icon name="eyeOff" size={17} /></span>
        <span class="ltx">
          <span class="lt">{t("离开模式")}</span>
          <span class="ls">
            {away
              ? app.config?.awayDecision === "approve"
                ? t("开着：提问按合理默认继续并写明假设，要批准的调用直接放行，计划直接批准开工。发新消息自动关。")
                : t("开着：提问按合理默认继续并写明假设，要批准的调用直接拒，计划留着等你。发新消息自动关。")
              : t("出门前打开：这一轮不会卡在没人点的卡片上。")}
          </span>
        </span>
        <Switch checked={away} onchange={(v) => void setAwayMode(v)} label={t("离开模式")} />
      </div>
    {/if}
  </section>

  {#if hasScope}
    <section>
      <h4>{t("工作权限")}</h4>
      <Segmented full size="sm" options={SCOPES.map(({ value, label, icon }) => ({ value, label, icon }))} value={scope} onchange={pickScope} label={t("工作权限")} />
      <p class="note">{SCOPES.find((s) => s.value === scope)?.note}</p>
      {#if scope === "workspace" && roots.length}
        <!-- P13（X18）：越界读时在权限卡上点「本会话都允许」记下的目录；× 收回 -->
        <div class="roots" transition:collapse>
          <p class="roots-t">{t("本会话还能读这些工作区外的目录（只读）")}</p>
          {#each roots as d (d)}
            <div class="root" transition:collapse>
              <span class="path" title={d}>{d}</span>
              <IconButton icon="close" size={28} iconSize={13} label={t("不再允许读这个目录")} title={t("不再允许读")} onclick={() => dropRoot(d)} />
            </div>
          {/each}
        </div>
      {/if}
    </section>
  {/if}

  {#if showDevices || isLocal}
    <section>
      <h4>{t("运行环境")}</h4>
      {#if showDevices}
        <button class="line click" aria-expanded={devOpen} title={t("这个会话连着你哪台电脑：dimensio 经它看屏幕、在你允许时操作")} onclick={toggleDevices}>
          <span class="lic dev">
            <Icon name="laptop" size={17} />
            {#if devTone !== "idle"}<span class="dot" class:on={devTone === "on"}></span>{/if}
          </span>
          <span class="ltx">
            <span class="lt">{t("电脑")}</span>
            <span class="ls">{devText}</span>
          </span>
          <span class="chev" class:open={devOpen}><Icon name="chevronD" size={16} /></span>
        </button>
        {#if devOpen}
          <div class="devs" transition:collapse role="group" aria-label={t("这个会话连哪台电脑")}>
            <MenuItem icon="sparkles" label={t("自动")} description={t("只有一台在线时就用它")} checked={selected === ""} onclick={() => chooseDevice("")} />
            {#each dev.list as d (d.id)}
              <MenuItem
                icon={d.sameMachine ? "monitor" : "laptop"}
                label={d.sameMachine ? t("{name}（就是服务器）", { name: d.name }) : d.name}
                description={tierText(d)}
                checked={selected === d.id}
                onclick={() => chooseDevice(d.id)}
              />
            {/each}
            <MenuItem icon="xCircle" label={t("不连电脑")} description={t("这个会话不操作任何电脑")} checked={selected === "none"} onclick={() => chooseDevice("none")} />
            {#if devErr}<p class="err">{devErr}</p>{/if}
          </div>
        {/if}
      {/if}
      {#if isLocal}
        <button class="line click" title={t("本机模型服务状态（点开展开控制面板）")} onclick={onlocal}>
          <span class="lic"><span class="ldot" class:on={laiPhase === "on"} class:starting={laiPhase === "starting"}></span></span>
          <span class="ltx">
            <span class="lt">{t("本机模型")}</span>
            <span class="ls" class:hx-shimmer={laiPhase === "starting"}>{laiText}</span>
          </span>
          <span class="chev"><Icon name="chevronR" size={16} /></span>
        </button>
      {/if}
    </section>
  {/if}

  {#if pane.chat.running}
    <p class="live">{t("运行中也算数：下一步工具调用就按新档位 / 范围判定。")}</p>
  {/if}
</div>

<style>
  .rs {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  section {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  section + section {
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }
  h4 {
    margin: 0;
    font-size: var(--fs-sm);
    font-weight: 500;
    color: var(--text3);
  }
  .note {
    margin: 0;
    font-size: var(--fs-xs);
    line-height: 1.6;
    color: var(--text3);
  }
  .note.warn {
    color: var(--warn);
  }

  /* 一行设置：图标 · 标题 / 说明 · 右侧开关或箭头（可点的行整行是按钮） */
  .line {
    display: flex;
    align-items: center;
    gap: 10px;
    min-height: 44px;
    margin: 0 -6px;
    width: calc(100% + 12px);
    padding: 6px;
    border-radius: 10px;
    text-align: left;
    color: var(--text);
  }
  .click {
    transition: background-color var(--t-fast) var(--ease);
  }
  @media (hover: hover) {
    .click:hover {
      background: var(--surface2);
    }
  }
  .click:active {
    background: var(--surface3);
  }
  .lic {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 20px;
    color: var(--text2);
  }
  .ltx {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .lt {
    font-size: var(--fs-base);
    line-height: 1.35;
  }
  .ls {
    font-size: var(--fs-xs);
    line-height: 1.5;
    color: var(--text3);
    overflow-wrap: anywhere;
  }
  .chev {
    display: inline-flex;
    flex: none;
    color: var(--text3);
    transition: transform var(--t-med) var(--ease);
  }
  .chev.open {
    transform: rotate(180deg);
  }

  /* 电脑：状态点压在图标右下角（连着的那台在线 = 绿，离线 = 空心圈，不连电脑 = 不画） */
  .dot {
    position: absolute;
    right: 0;
    bottom: -1px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--surface);
    box-shadow: inset 0 0 0 1.5px var(--text3);
  }
  .dot.on {
    background: var(--ok);
    box-shadow: 0 0 0 2px var(--surface);
  }
  .devs {
    margin: -4px 0 0 24px;
  }
  .err {
    margin: 4px 10px 6px;
    font-size: var(--fs-xs);
    line-height: var(--lh-ui);
    color: var(--err);
  }

  /* 本机模型：就绪 = 绿、加载中 = 朱色呼吸、没跑 = 空心圈（与以前输入框上那颗胶囊同一套） */
  .ldot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    box-shadow: inset 0 0 0 1.5px var(--text3);
  }
  .ldot.on {
    background: var(--ok);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 18%, transparent);
  }
  .ldot.starting {
    background: var(--live);
    box-shadow: none;
    animation: rs-breathe 1.4s var(--ease-in-out) infinite;
  }
  @keyframes rs-breathe {
    50% {
      opacity: 0.35;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ldot.starting {
      animation: none;
    }
  }

  .roots {
    padding: 0 0 2px;
  }
  .roots-t {
    margin: 0 0 4px;
    font-size: var(--fs-xs);
    line-height: var(--lh-ui);
    color: var(--text3);
  }
  .root {
    display: flex;
    align-items: center;
    gap: 4px;
    min-width: 0;
  }
  .path {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text2);
  }
  @media (pointer: coarse) {
    .root > :global(button)::after {
      content: "";
      position: absolute;
      inset: -6px;
    }
  }
  .live {
    margin: 0;
    font-size: var(--fs-xs);
    line-height: var(--lh-ui);
    color: var(--text3);
  }
</style>
