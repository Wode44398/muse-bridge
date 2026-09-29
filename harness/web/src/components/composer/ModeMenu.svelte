<script lang="ts">
  // 档位菜单（输入框左下的档位胶囊呼出）：运行档位、目标模式（这条消息当目标；09-26 把输入框上单独那颗「目标」并进来——
  // 运行中、回应卡片时没有这一项）、访问范围（本会话放行的工作区外只读目录列在它下面，可收回）、离开模式。
  // 以前只住在设置页、只对新对话生效（设置 → 切 → 保存 → 新对话四步）；现在对【当前会话】当场生效（运行中也算数，
  // 「只读」就是给正在跑的 agent 拉手刹），同时写成新对话的默认。点了先关菜单、胶囊乐观更新，失败回滚并提示。
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
    type AccessMode,
  } from "../../lib/state.svelte.ts";
  import type { IconName } from "../../lib/icons.ts";
  import { haptic } from "../../lib/touch.ts";
  import { collapse } from "../../lib/motion.ts";
  import Popover from "../ui/Popover.svelte";
  import MenuItem from "../ui/MenuItem.svelte";
  import MenuLabel from "../ui/MenuLabel.svelte";
  import MenuSep from "../ui/MenuSep.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let {
    anchor,
    onclose,
    goal = null,
  }: { anchor: HTMLElement; onclose: () => void; goal?: { on: boolean; toggle: () => void } | null } = $props();

  type Mode = "auto" | "read-only" | "plan";
  const MODES: { id: Mode; icon: IconName; label: string; note: string }[] = [
    { id: "auto", icon: "shield", label: t("自主执行"), note: t("直接执行。规则可把个别高危调用改成每次问我。") },
    { id: "read-only", icon: "eye", label: t("只读"), note: t("只放行读取类工具，写文件与执行命令一律拒绝。") },
    { id: "plan", icon: "todo", label: t("先出计划"), note: t("只读研究 → 提交计划 → 你批准后当场转自主并开工。") },
  ];
  // 整机是默认（09-26 的产品决定）；仅工作空间是给这个对话拉闸
  const SCOPES: { id: AccessMode; icon: IconName; label: string; note: string }[] = [
    { id: "full", icon: "monitor", label: t("整机可访问"), note: t("可用绝对路径读写工作空间以外的文件（密钥文件始终封锁）。") },
    { id: "workspace", icon: "folder", label: t("仅工作空间"), note: t("路径一越界就拦下，防误操作。") },
  ];

  const current = $derived(permissionMode(pane.chat));
  const scope = $derived(accessMode(pane.chat));
  // 老后端 config 里没有 access 字段 → 访问范围整段不显示；被锁定（多用户服务端的租户实例，恒仅工作空间）也不显示
  const hasScope = $derived(app.config?.access !== undefined && !app.config?.accessLocked);
  // P3：离开模式是会话级的——会话建立（发出第一条消息）后才有得切
  const hasSession = $derived(Boolean(pane.chat.id));
  const away = $derived(awayMode(pane.chat));
  // P13：本会话在权限卡上放行的工作区外只读目录（仅工作空间时才有意义）
  const roots = $derived(readRoots(pane.chat));

  async function pick(id: Mode) {
    haptic("light");
    onclose();
    await setPermissionMode(id);
  }
  async function pickScope(id: AccessMode) {
    haptic("light");
    onclose();
    await setAccessMode(id);
  }
  async function toggleAway() {
    haptic("light");
    onclose();
    await setAwayMode(!away);
  }
  function toggleGoal() {
    onclose(); // 开了之后输入框上方出目标选项（验证命令、轮数），菜单让开
    goal?.toggle();
  }
  function dropRoot(dir: string) {
    haptic("light");
    void dropReadRoot(dir);
  }
</script>

<Popover {anchor} {onclose} minWidth={284} maxWidth={340} label={t("运行档位、访问范围与目标")}>
  <MenuLabel text={t("运行档位")} />
  {#each MODES as m (m.id)}
    <MenuItem icon={m.icon} label={m.label} description={m.note} checked={m.id === current} onclick={() => pick(m.id)} />
  {/each}
  <!-- 目标模式紧跟运行档位：说的也是「怎么跑」（跑到达成为止）；放在最后，手机上菜单一长就得滚才看得见 -->
  {#if goal}
    <MenuSep />
    <MenuItem
      icon="target"
      label={t("目标模式")}
      description={goal.on
        ? t("开着：这条消息就是目标，没达成会自动一轮轮接着做；输入框上方可以给验证命令、定轮数。")
        : t("这条消息当作目标：没达成就自动一轮轮接着做（可以给一条验证命令，过了才算达成）。")}
      checked={goal.on}
      onclick={toggleGoal}
    />
  {/if}

  {#if hasScope}
    <MenuSep />
    <MenuLabel text={t("访问范围")} />
    {#each SCOPES as s (s.id)}
      <MenuItem icon={s.icon} label={s.label} description={s.note} checked={s.id === scope} onclick={() => pickScope(s.id)} />
    {/each}
    {#if scope === "workspace" && roots.length}
      <!-- P13（X18）：越界读时在权限卡上点「本会话都允许」记下的目录；× 收回（菜单不关） -->
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
  {/if}

  {#if hasSession}
    <MenuSep />
    <MenuItem
      icon="eyeOff"
      label={t("离开模式")}
      description={away
        ? t("开着：提问按合理默认继续并写明假设，要批准的调用直接拒，计划留着等你。发新消息自动关。")
        : t("出门前打开：这一轮不会卡在没人点的卡片上。")}
      checked={away}
      onclick={toggleAway}
    />
  {/if}

  {#if pane.chat.running}
    <MenuSep />
    <p class="live">{t("运行中也算数：下一步工具调用就按新档位 / 范围判定。")}</p>
  {/if}
</Popover>

<style>
  .roots {
    padding: 2px 4px 6px 37px;
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
    margin: 0 10px 6px;
    font-size: var(--fs-xs);
    line-height: var(--lh-ui);
    color: var(--text3);
  }
</style>
