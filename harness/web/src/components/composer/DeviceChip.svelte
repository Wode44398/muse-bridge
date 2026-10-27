<script lang="ts">
  // 「电脑」胶囊（输入框左下，档位胶囊旁边；Claude 输入框下方那颗设备芯片的 dimensio 版）：这个会话连着你哪台电脑。
  // dimensio 跑在服务端，连上的那台电脑经 Device* 工具让它看屏幕、在你允许时操作、跑命令、读写文件。
  //   · 进行中的会话：改选立刻生效；新对话：选的是草稿，第一条消息发出、会话有了 id 就补写上去。
  //   · 没有 devices 能力位、没接上 bridge 设备通道、一台设备都没登记时整颗不出现。
  // 圆点：连着的那台在线 = 绿，离线 = 空心圈；不连电脑 = 不画圆点。compact = 窄屏只留图标与圆点。
  import { untrack } from "svelte";
  import { dev, devicesSupported, effectiveDevice, loadDevices, setSessionDevice, type DeviceRow } from "../../lib/devices.svelte.ts";
  import { haptic } from "../../lib/touch.ts";
  import Chip from "../ui/Chip.svelte";
  import Icon from "../ui/Icon.svelte";
  import Popover from "../ui/Popover.svelte";
  import MenuItem from "../ui/MenuItem.svelte";
  import MenuLabel from "../ui/MenuLabel.svelte";
  import MenuSep from "../ui/MenuSep.svelte";
  import { usePane } from "../../lib/pane.ts";
  import { t } from "../../lib/i18n.ts";

  const pane = usePane(); // 分屏：这一格的会话（没分屏 = app.chat）

  let { compact = false }: { compact?: boolean } = $props();

  let anchor = $state<HTMLElement | null>(null);
  let err = $state("");

  const sid = $derived(pane.chat.id ?? "");
  const supported = $derived(devicesSupported());

  // 只跟着会话 id 走（loadDevices 会写 dev.links，不隔开的话 effect 依赖上自己写的状态）
  $effect(() => {
    const s = sid;
    if (supported) untrack(() => void loadDevices(s));
  });
  // 新对话的草稿：会话一有 id 就写上去
  $effect(() => {
    const s = sid;
    if (!s || !supported) return;
    untrack(() => {
      const draft = dev.draft;
      if (!draft) return;
      dev.draft = "";
      void setSessionDevice(s, draft).catch(() => {});
    });
  });

  const show = $derived(supported && dev.available && dev.enabled && dev.list.length > 0);
  const cur = $derived(effectiveDevice(sid));
  const selected = $derived(sid ? (dev.links[sid] ?? "") : dev.draft);
  const text = $derived(
    cur.kind === "none"
      ? t("不连电脑")
      : cur.kind === "missing"
        ? t("设备已不在")
        : cur.device
          ? cur.device.name || t("电脑")
          : t("选电脑"),
  );
  const tone = $derived(cur.kind === "linked" || (cur.kind === "auto" && cur.device) ? ((cur as { device: DeviceRow }).device.online ? "on" : "off") : "idle");

  function toggle(e: MouseEvent) {
    haptic("light");
    err = "";
    if (anchor) {
      anchor = null;
      return;
    }
    anchor = e.currentTarget as HTMLElement;
    void loadDevices(sid, true);
  }
  async function choose(link: string) {
    haptic("light");
    err = "";
    if (!sid) {
      dev.draft = link;
      anchor = null;
      return;
    }
    try {
      await setSessionDevice(sid, link);
      anchor = null;
    } catch (e) {
      err = (e as Error).message || String(e);
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
</script>

{#snippet lead()}
  <span class="lead" aria-hidden="true">
    <Icon name="laptop" size={15} />
    {#if tone !== "idle"}<span class="dot" class:on={tone === "on"}></span>{/if}
  </span>
{/snippet}
{#snippet label()}
  <span class="name">{text}</span>
{/snippet}

{#if show}
  <Chip
    leading={lead}
    children={compact ? undefined : label}
    chevron
    open={Boolean(anchor)}
    label={t("电脑：{name}", { name: text })}
    title={t("这个会话连着你哪台电脑：dimensio 经它看屏幕、在你允许时操作")}
    onclick={toggle}
  />
{/if}

{#if anchor}
  <Popover {anchor} onclose={() => (anchor = null)} minWidth={264} maxWidth={340} label={t("这个会话连哪台电脑")}>
    <MenuLabel text={t("这个会话连哪台电脑")} />
    <MenuItem
      icon="sparkles"
      label={t("自动")}
      description={t("只有一台在线时就用它")}
      checked={selected === ""}
      onclick={() => choose("")}
    />
    {#each dev.list as d (d.id)}
      <MenuItem
        icon={d.sameMachine ? "monitor" : "laptop"}
        label={d.sameMachine ? t("{name}（就是服务器）", { name: d.name }) : d.name}
        description={tierText(d)}
        checked={selected === d.id}
        onclick={() => choose(d.id)}
      />
    {/each}
    <MenuSep />
    <MenuItem icon="xCircle" label={t("不连电脑")} description={t("这个会话不操作任何电脑")} checked={selected === "none"} onclick={() => choose("none")} />
    {#if err}
      <p class="err">{err}</p>
    {/if}
  </Popover>
{/if}

<style>
  .lead {
    position: relative;
    display: inline-flex;
  }
  /* 状态点压在图标右下角 */
  .dot {
    position: absolute;
    right: -2px;
    bottom: -1px;
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--surface, var(--bg));
    box-shadow: inset 0 0 0 1.5px var(--text3);
    transition:
      background-color var(--t-med) var(--ease),
      box-shadow var(--t-med) var(--ease);
  }
  .dot.on {
    background: var(--ok);
    box-shadow: 0 0 0 2px var(--surface, var(--bg));
  }
  .name {
    max-width: 10em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .err {
    margin: 4px 10px 6px;
    font-size: var(--fs-xs);
    line-height: var(--lh-ui);
    color: var(--err);
  }
</style>
