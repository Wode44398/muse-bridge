<script lang="ts">
  // 模型服务：各家平铺，后面跟着模型中心里添加的服务，最后一张是虚线的「＋」空卡。当前那家带一枚小勾。
  // 点一家 = 切过去（会话绑定创建时的厂商：切家就是开新对话，旧的留在历史里，在跑的转入后台继续）；同一家就是收起。
  // 切换只换厂商与身份标识，界面不换装；成功后空态标志重演一遍入场（dimensio-pulse）。
  //
  // 服务只在宿主（bridge）的模型中心里添加和改：「＋」卡开它的添加页，卡片上的铅笔开它对应的服务；
  // dimensio 自己早年加的老服务，铅笔交给模型中心搬过去（宿主那边先确认）。这张面板只管切换、不出表单。
  // 宿主没有模型中心可开（独立运行、多用户服务端的成员）时，「＋」卡和铅笔都不出现，已有的服务照常能切。
  // 多用户服务端：管理员共享给成员的服务，成员那边副标题是「管理员共享」，只能用。
  import { onMount } from "svelte";
  import {
    app,
    vendorChoices,
    modelsOf,
    hasHostModelHub,
    openHostModelHub,
    switchVendor,
    vendorId,
    vendorInfo,
    vendorSwitchNote,
    type VendorView,
  } from "../../lib/state.svelte.ts";
  import { press, rise } from "../../lib/motion.ts";
  import Sheet from "../ui/Sheet.svelte";
  import Icon from "../ui/Icon.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Mark from "../brand/Mark.svelte";
  import VendorLogo from "../brand/VendorLogo.svelte";
  import { t } from "../../lib/i18n.ts";

  let { onclose }: { onclose: () => void } = $props();

  const cur = $derived(vendorId());
  let pending = $state<string | null>(null); // 正在切过去的那一家（服务端写配置那一下）

  // 自带适配的几家（宿主模型中心接管时只列它给了 Key 的）+ 模型中心 / 自定义服务：与型号菜单的服务页同一份
  const all = $derived(vendorChoices());
  const builtins = $derived(all.filter((v) => !v.custom));
  const customs = $derived(all.filter((v) => v.custom));

  async function pick(id: string) {
    if (pending) return;
    if (id !== cur) pending = id;
    try {
      await switchVendor(id); // 成功会自己收起浮层；失败给提示、浮层留着
    } finally {
      pending = null;
    }
  }

  let hubLink = $state(false);
  onMount(() => {
    hubLink = hasHostModelHub();
    // 宿主早年用来「直接打开某个 dimensio 自己的服务」的请求：服务改在模型中心里配之后作废，收到就清掉
    app.vendorEditReq = null;
  });
  function addService() {
    if (openHostModelHub("add")) onclose();
  }
  // 铅笔：模型中心提供的卡 → 它在模型中心里的那个服务；dimensio 自己的老服务 → 交给模型中心（宿主那边先确认）
  function editCard(v: VendorView) {
    const proto = String((app.info?.catalog as any[] | undefined)?.find((p) => p.id === v.id)?.custom?.protocol ?? "");
    if (openHostModelHub(v.hub ? { service: v.hub } : { legacy: v.id, name: v.name, proto })) onclose();
  }
  function openHub() {
    if (openHostModelHub()) onclose();
  }
</script>

<Sheet title={t("模型服务")} {onclose} size="md">
  <div class="tiles">
    {#each builtins as v, i (v.id)}
      {@render tile(v.id, v.name, v.company, i, false)}
    {/each}
    {#each customs as v, j (v.id)}
      {@render tile(v.id, v.name, v.company, builtins.length + j, true)}
    {/each}
    {#if hubLink}
      <button
        class="tile add"
        disabled={Boolean(pending)}
        use:press={{ scale: 0.97 }}
        in:rise|global={{ y: 8, delay: 40 + (builtins.length + customs.length) * 35 }}
        onclick={addService}
      >
        <span class="plus" aria-hidden="true"><Icon name="plus" size={20} stroke={1.8} /></span>
        <span class="add-t">{t("添加服务")}</span>
        <span class="add-s">{t("模型中心")}</span>
      </button>
    {/if}
  </div>
  <p class="note">
    {vendorSwitchNote(app.chat)}
  </p>
  {#if hubLink}
    <p class="hub"><button type="button" class="hublink" onclick={openHub}>{t("在模型中心管理全部模型服务")}</button></p>
  {/if}
</Sheet>

{#snippet tile(id: string, title: string, sub: string, i: number, custom: boolean)}
  {@const n = modelsOf(id).length}
  {@const info = vendorInfo(id)}
  {@const view = custom || info.hub ? info : null}
  <!-- 「N 个模型」整句一个键（英文语序照样放得下），数字仍单独一段等宽：按 {n} 切成前后两截 -->
  {@const nModels = t("{n} 个模型", { count: n }).split("{n}")}
  <div class="cell" in:rise|global={{ y: 8, delay: 40 + i * 35 }}>
    <button
      class="tile"
      class:cur={id === cur}
      aria-current={id === cur ? "true" : undefined}
      disabled={Boolean(pending) && pending !== id}
      use:press={{ scale: 0.97 }}
      onclick={() => pick(id)}
    >
      <span class="logo">
        {#if pending === id}<Mark size={28} live />{:else}<VendorLogo skin={id} size={28} />{/if}
      </span>
      <span class="name">{title}</span>
      <span class="co" class:mono={custom && !view?.managed && !view?.hub}>{sub}</span>
      {#if n}<span class="models">{nModels[0]}<span class="num">{n}</span>{nModels[1] ?? ""}{#if view?.shared}<span class="shared">{" · "}{t("已共享")}</span>{/if}</span>{/if}
      {#if id === cur}
        <span class="check" aria-hidden="true"><Icon name="check" size={15} stroke={2.2} /></span>
        <span class="hx-sr">{t("当前")}</span>
      {/if}
    </button>
    <!-- 铅笔：模型中心提供的卡、dimensio 早年自己加的服务都跳模型中心去改；别的插件给的、管理员共享的只能用 -->
    {#if hubLink && view && (Boolean(view.hub) || (view.custom && !view.managed))}
      <span class="edit">
        <IconButton icon="edit" label={t("在模型中心里改「{name}」", { name: title })} size={30} iconSize={15} onclick={() => editCard(view)} />
      </span>
    {/if}
  </div>
{/snippet}

<style>
  .tiles {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    grid-auto-rows: 1fr; /* 「＋」卡独占一行时也和别的卡一样高 */
    gap: 10px;
  }
  @media (min-width: 700px), (min-width: 600px) and (min-device-aspect-ratio: 7/10) {
    .tiles {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
  .cell {
    position: relative;
    display: flex;
    min-width: 0;
  }
  .tile {
    position: relative;
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    min-width: 0;
    padding: 14px 14px 12px;
    border-radius: 14px;
    background: var(--surface2);
    text-align: left;
    color: var(--text);
    transition:
      background-color var(--t-fast) var(--ease),
      box-shadow var(--t-med) var(--ease),
      opacity var(--t-fast) var(--ease);
  }
  /* 当前那家：一圈细细的墨色内描边 + 右上角的勾 */
  .tile.cur {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 72%, transparent);
  }
  @media (hover: hover) {
    .tile:hover:not(:disabled) {
      background: var(--surface3);
    }
  }
  .tile:disabled {
    opacity: 0.5;
  }
  .logo {
    display: inline-flex;
    margin-bottom: 10px;
  }
  .name {
    max-width: 100%;
    font-size: var(--fs-base);
    font-weight: 500;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .co {
    max-width: 100%;
    font-size: var(--fs-sm);
    color: var(--text3);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  /* 自定义服务的副标题是主机名 */
  .co.mono {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    line-height: 17px;
  }
  .models {
    margin-top: 8px;
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  .models .num {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  .models .shared {
    color: var(--text2);
  }
  .check {
    position: absolute;
    top: 11px;
    right: 11px;
    display: inline-flex;
    color: var(--accent);
  }
  /* 自定义卡的编辑钮：右下角，和「N 个模型」同一行。触屏常显；精确指针悬停才浮现（占位不变） */
  .edit {
    position: absolute;
    right: 6px;
    bottom: 5px;
    color: var(--text3);
  }
  @media (hover: hover) {
    .edit {
      opacity: 0;
      transition: opacity var(--t-fast) var(--ease);
    }
    .cell:hover .edit,
    .edit:focus-within {
      opacity: 1;
    }
  }

  /* 「＋」空卡：没有底色，只有一圈虚线——还没有东西的格子 */
  .tile.add {
    align-items: center;
    justify-content: center;
    gap: 3px;
    background: transparent;
    box-shadow: inset 0 0 0 1px transparent;
    outline: 1.5px dashed var(--border2);
    outline-offset: -1.5px;
    text-align: center;
    color: var(--text2);
  }
  @media (hover: hover) {
    .tile.add:hover:not(:disabled) {
      background: var(--surface2);
      color: var(--text);
    }
  }
  .plus {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    height: 34px;
    margin-bottom: 6px;
    border-radius: var(--r-pill);
    background: var(--surface2);
    color: var(--text);
  }
  .add-t {
    font-size: var(--fs-md);
    font-weight: 500;
  }
  .add-s {
    font-size: var(--fs-xs);
    color: var(--text3);
  }

  /* 面板尺寸类叫 md，会被正文 markdown 的全局 .hxroot .md p（0,2,1）清掉段落外边距——这里用兄弟选择器压过它 */
  .tiles + .note {
    margin: 16px 4px 2px;
    font-size: var(--fs-sm);
    line-height: 1.55;
    color: var(--text3);
    text-align: center;
  }

  .hub {
    margin: 6px 4px 2px;
    text-align: center;
  }
  .hublink {
    padding: 6px 10px;
    border: 0;
    border-radius: 8px;
    background: transparent;
    color: var(--text2);
    font: inherit;
    font-size: var(--fs-sm);
    text-decoration: underline;
    text-decoration-color: var(--border2);
    text-underline-offset: 3px;
    cursor: pointer;
  }
  @media (hover: hover) {
    .hublink:hover {
      background: var(--accent-soft);
      color: var(--text);
    }
  }
</style>
