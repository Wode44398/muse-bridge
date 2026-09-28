<script lang="ts">
  // 模型服务：八家平铺，当前那家带一枚青色小勾。点一家 = 切过去（会话绑定创建时的厂商：切家就是开新对话，
  // 旧的留在历史里，在跑的转入后台继续）；同一家就是收起。切换只换厂商与身份标识，界面不换装；
  // 成功后空态标志重演一遍入场（dimensio-pulse）。这里不设 API Key——缺 Key 的提示在首屏与设置里。
  import { app, modelsOf, switchVendor, vendorId } from "../../lib/state.svelte.ts";
  import { VENDOR_ORDER, VENDORS } from "../../lib/theme.ts";
  import { press, rise } from "../../lib/motion.ts";
  import Sheet from "../ui/Sheet.svelte";
  import Icon from "../ui/Icon.svelte";
  import Mark from "../brand/Mark.svelte";
  import VendorLogo from "../brand/VendorLogo.svelte";

  let { onclose }: { onclose: () => void } = $props();

  const cur = $derived(vendorId());
  let pending = $state<string | null>(null); // 正在切过去的那一家（服务端写配置那一下）

  async function pick(id: string) {
    if (pending) return;
    if (id !== cur) pending = id;
    try {
      await switchVendor(id); // 成功会自己收起浮层；失败给提示、浮层留着
    } finally {
      pending = null;
    }
  }
</script>

<Sheet title="模型服务" {onclose} size="md">
  <div class="tiles">
    {#each VENDOR_ORDER as id, i (id)}
      {@const v = VENDORS[id]}
      {@const n = modelsOf(id).length}
      <button
        class="tile"
        class:cur={id === cur}
        aria-current={id === cur ? "true" : undefined}
        disabled={Boolean(pending) && pending !== id}
        use:press={{ scale: 0.97 }}
        in:rise|global={{ y: 8, delay: 40 + i * 35 }}
        onclick={() => pick(id)}
      >
        <span class="logo">
          {#if pending === id}<Mark size={28} live />{:else}<VendorLogo skin={id} size={28} />{/if}
        </span>
        <span class="name">{v.name}</span>
        <span class="co">{v.company}</span>
        {#if n}<span class="models"><span class="num">{n}</span> 个模型</span>{/if}
        {#if id === cur}
          <span class="check" aria-hidden="true"><Icon name="check" size={15} stroke={2.2} /></span>
          <span class="hx-sr">当前</span>
        {/if}
      </button>
    {/each}
  </div>
  <p class="note">
    {app.chat.running ? "当前任务转入后台继续跑；切换后开启新对话" : "切换后开启新对话，历史会话保留各自的服务归属"}
  </p>
</Sheet>

<style>
  .tiles {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }
  @media (min-width: 700px) {
    .tiles {
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }
  }
  .tile {
    position: relative;
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
  /* 当前那家：一圈细细的青色内描边 + 右上角的勾 */
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
  .models {
    margin-top: 8px;
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  .models .num {
    font-family: var(--font-mono);
    font-variant-numeric: tabular-nums;
  }
  .check {
    position: absolute;
    top: 11px;
    right: 11px;
    display: inline-flex;
    color: var(--accent);
  }
  .note {
    margin: 16px 4px 2px;
    font-size: var(--fs-sm);
    line-height: 1.55;
    color: var(--text3);
    text-align: center;
  }
</style>
