<script lang="ts">
  // 模型服务：八家平铺，后面跟着用户自己加的自定义服务，最后一张是虚线的「＋」空卡。当前那家带一枚小勾。
  // 点一家 = 切过去（会话绑定创建时的厂商：切家就是开新对话，旧的留在历史里，在跑的转入后台继续）；同一家就是收起。
  // 切换只换厂商与身份标识，界面不换装；成功后空态标志重演一遍入场（dimensio-pulse）。
  //
  // 「＋」卡 = 自定义服务（OpenAI 兼容接口）：面板里下钻一层表单（‹ 回到网格），备注 + 接口地址 + API Key。
  // 保存时服务端先打一次 GET {地址}/models，拿型号清单、顺带验地址与 key；接口列不出型号时表单多出一栏手填模型 ID。
  // 自定义卡右下角的铅笔进同一张表单（编辑 / 删除，删除两步确认）。内置几家的 API Key 仍在设置里填。
  import { tick } from "svelte";
  import * as api from "../../lib/api.ts";
  import {
    app,
    canAddCustomVendor,
    customVendors,
    modelsOf,
    newChat,
    reloadMeta,
    switchVendor,
    toast,
    vendorId,
    type VendorView,
  } from "../../lib/state.svelte.ts";
  import { VENDOR_ORDER, VENDORS } from "../../lib/theme.ts";
  import { collapse, press, rise } from "../../lib/motion.ts";
  import { haptic } from "../../lib/touch.ts";
  import Sheet from "../ui/Sheet.svelte";
  import Icon from "../ui/Icon.svelte";
  import IconButton from "../ui/IconButton.svelte";
  import Button from "../ui/Button.svelte";
  import TextField from "../ui/TextField.svelte";
  import Mark from "../brand/Mark.svelte";
  import VendorLogo from "../brand/VendorLogo.svelte";
  import Section from "../sheets/Section.svelte";
  import { t, tc, tr } from "../../lib/i18n.ts";

  let { onclose }: { onclose: () => void } = $props();

  const cur = $derived(vendorId());
  let pending = $state<string | null>(null); // 正在切过去的那一家（服务端写配置那一下）

  const builtins = $derived(VENDOR_ORDER.map((id) => ({ id, name: VENDORS[id].name, company: VENDORS[id].company })));
  const customs = $derived(customVendors());
  const canAdd = $derived(canAddCustomVendor());

  async function pick(id: string) {
    if (pending) return;
    if (id !== cur) pending = id;
    try {
      await switchVendor(id); // 成功会自己收起浮层；失败给提示、浮层留着
    } finally {
      pending = null;
    }
  }

  // ── 表单（新增 / 编辑） ──────────────────────────────────────────────────
  let editing = $state<VendorView | null>(null);
  let formOpen = $state(false);
  let name = $state("");
  let baseUrl = $state("");
  let apiKey = $state("");
  let model = $state("");
  let needsModel = $state(false); // 接口没列出型号：多出一栏手填模型 ID
  let error = $state("");
  let saving = $state(false);
  let confirmDelete = $state(false);
  let deleting = $state(false);
  let nameEl: HTMLInputElement | undefined = $state();
  let urlEl: HTMLInputElement | undefined = $state();
  let keyEl: HTMLInputElement | undefined = $state();

  function openForm(v: VendorView | null) {
    editing = v;
    const spec = v ? (app.info?.catalog as any[] | undefined)?.find((p) => p.id === v.id) : null;
    name = v?.name ?? "";
    baseUrl = spec?.baseUrl ?? "";
    apiKey = "";
    model = "";
    needsModel = false;
    error = "";
    confirmDelete = false;
    formOpen = true;
    haptic("light");
    void tick().then(() => {
      if (!v) nameEl?.focus({ preventScroll: true });
    });
  }
  function back() {
    if (saving || deleting) return;
    formOpen = false;
  }

  const canSave = $derived(Boolean(baseUrl.trim()) && (Boolean(editing) || Boolean(apiKey.trim())) && (!needsModel || Boolean(model.trim())));

  async function save() {
    if (!canSave || saving) return;
    saving = true;
    error = "";
    const form: api.CustomProviderForm = { name: name.trim(), baseUrl: baseUrl.trim(), apiKey: apiKey.trim() || undefined, model: model.trim() || undefined };
    try {
      const r = editing ? await api.updateCustomProvider(editing.id, form) : await api.addCustomProvider(form);
      await reloadMeta();
      haptic("medium");
      const label = name.trim() || t("自定义服务");
      // r.warning = 模型清单没探到、用的是手填的模型 ID（错误原文刚才已经显示过，不再复述）
      toast(
        r.warning
          ? editing
            ? t("已保存「{name}」· 用手填的模型 {model}", { name: label, model: model.trim() })
            : t("已添加「{name}」· 用手填的模型 {model}", { name: label, model: model.trim() })
          : editing
            ? t("已保存「{name}」", { name: label })
            : t("已添加「{name}」· {n} 个模型", { name: label, n: r.models }),
      );
      formOpen = false;
    } catch (e: any) {
      error = e?.message ?? String(e);
      if (e?.body?.needsModel) needsModel = true;
    } finally {
      saving = false;
    }
  }

  async function remove() {
    if (!editing || deleting) return;
    if (!confirmDelete) {
      confirmDelete = true;
      haptic("light");
      return;
    }
    deleting = true;
    const wasCur = editing.id === cur;
    const label = editing.name;
    try {
      await api.deleteCustomProvider(editing.id);
      await reloadMeta();
      if (wasCur) newChat(); // 正在用的那家被删了：服务端已退回默认厂商，这边开一个新对话跟上
      haptic("medium");
      toast(t("已删除「{name}」", { name: label }));
      formOpen = false;
    } catch (e: any) {
      error = e?.message ?? String(e);
    } finally {
      deleting = false;
      confirmDelete = false;
    }
  }

  // 回车：前两栏跳到下一栏，最后一栏提交（输入法组字中的回车不算）
  const onKey = (next?: () => HTMLInputElement | undefined) => (e: KeyboardEvent) => {
    if (e.key !== "Enter" || e.isComposing) return;
    e.preventDefault();
    const el = next?.();
    if (el) el.focus();
    else void save();
  };
</script>

<Sheet
  title={formOpen ? (editing ? t("编辑自定义服务") : t("添加自定义服务")) : t("模型服务")}
  {onclose}
  onback={formOpen ? back : undefined}
  backLabel={t("回到模型服务")}
  footer={formOpen ? formFooter : undefined}
  size="md"
>
  {#if formOpen}
    <div class="form" in:rise={{ y: 8 }}>
      <p class="lede">{t("兼容 OpenAI Chat Completions 的接口都能接：中转站、OpenRouter、自己部署的 vLLM / Ollama……")}</p>

      <Section title={tc("dimensio", "备注")}>
        <TextField bind:value={name} bind:el={nameEl} label={tc("dimensio", "备注")} placeholder={t("比如：公司网关")} maxlength={40} enterkeyhint="next" onkeydown={onKey(() => urlEl)} />
      </Section>

      <Section title={t("接口地址")} footnote={t("填到 /v1 这一级；贴完整的 …/chat/completions 也行，会自动收好。")}>
        <TextField bind:value={baseUrl} bind:el={urlEl} type="url" mono label={t("接口地址")} placeholder="https://api.example.com/v1" enterkeyhint="next" onkeydown={onKey(() => keyEl)} />
      </Section>

      <Section title={t("API Key")} footnote={t("加密存在服务端，不回传浏览器。")}>
        <TextField
          bind:value={apiKey}
          bind:el={keyEl}
          type="password"
          mono
          label={t("API Key")}
          placeholder={editing ? t("••••••••（留空保持不变）") : "sk-…"}
          enterkeyhint="done"
          onkeydown={onKey()}
        />
      </Section>

      {#if needsModel}
        <div transition:collapse>
          <Section title={t("模型 ID")} footnote={t("这个接口没列出模型清单，手填一个模型 ID 也能用。")}>
            <TextField bind:value={model} mono label={t("模型 ID")} placeholder={t("比如 gpt-4o-mini")} autofocus enterkeyhint="done" onkeydown={onKey()} />
          </Section>
        </div>
      {/if}

      {#if error}
        <p class="err" role="alert" transition:collapse>{tr(error)}</p>
      {/if}
    </div>
  {:else}
    <div class="tiles">
      {#each builtins as v, i (v.id)}
        {@render tile(v.id, v.name, v.company, i, false)}
      {/each}
      {#each customs as v, j (v.id)}
        {@render tile(v.id, v.name, v.company, builtins.length + j, true)}
      {/each}
      {#if canAdd}
        <button
          class="tile add"
          disabled={Boolean(pending)}
          use:press={{ scale: 0.97 }}
          in:rise|global={{ y: 8, delay: 40 + (builtins.length + customs.length) * 35 }}
          onclick={() => openForm(null)}
        >
          <span class="plus" aria-hidden="true"><Icon name="plus" size={20} stroke={1.8} /></span>
          <span class="add-t">{t("添加自定义服务")}</span>
          <span class="add-s">{t("OpenAI 兼容接口")}</span>
        </button>
      {/if}
    </div>
    <p class="note">
      {app.chat.running ? t("当前任务转入后台继续跑；切换后开启新对话") : t("切换后开启新对话，历史会话保留各自的服务归属")}
    </p>
  {/if}
</Sheet>

{#snippet formFooter()}
  {#if editing}
    <span class="del">
      <Button variant={confirmDelete ? "danger-solid" : "danger"} icon="trash" loading={deleting} onclick={remove}>
        {confirmDelete ? tc("dimensio", "确认删除") : t("删除")}
      </Button>
    </span>
  {/if}
  <Button variant="ghost" onclick={back} disabled={saving || deleting}>{t("取消")}</Button>
  <Button variant="primary" loading={saving} disabled={!canSave || deleting} onclick={save}>
    {saving ? t("正在连接…") : editing ? t("保存") : t("连接并添加")}
  </Button>
{/snippet}

{#snippet tile(id: string, title: string, sub: string, i: number, custom: boolean)}
  {@const n = modelsOf(id).length}
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
      <span class="co" class:mono={custom}>{sub}</span>
      {#if n}<span class="models">{nModels[0]}<span class="num">{n}</span>{nModels[1] ?? ""}</span>{/if}
      {#if id === cur}
        <span class="check" aria-hidden="true"><Icon name="check" size={15} stroke={2.2} /></span>
        <span class="hx-sr">{t("当前")}</span>
      {/if}
    </button>
    {#if custom}
      <span class="edit">
        <IconButton icon="edit" label={t("编辑「{name}」", { name: title })} size={30} iconSize={15} onclick={() => openForm({ id, name: title, company: sub, custom: true })} />
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
  @media (min-width: 700px) {
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

  /* ── 表单 ── */
  .form {
    padding-top: 2px;
  }
  .form .lede {
    margin: 0 4px 18px;
    font-size: var(--fs-md);
    line-height: 1.6;
    color: var(--text2);
  }
  /* Section 的脚注同样被 .hxroot .md p 清了外边距，这里补回它自己的 8px / 4px */
  .form :global(p.foot) {
    margin: 8px 4px 0;
  }
  .form .err {
    margin: -8px 4px 4px;
    font-size: var(--fs-sm);
    line-height: 1.55;
    color: var(--err);
    overflow-wrap: anywhere;
  }
  .del {
    margin-right: auto;
  }
</style>
