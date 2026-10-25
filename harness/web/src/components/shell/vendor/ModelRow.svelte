<script lang="ts">
  // 服务里的一个型号：一行（启用开关、名字、能力徽章、★ 默认、展开），展开后改能力、思考档位、探测能力、移除。
  // 能力前面带「≈」的是猜的（内置型号表 / 按名字 / 兜底值），悬停看来源；「探测能力」真打几次核实，点「应用」写进来，来源记为探测。
  // 版式与交互对齐 bridge 的 Claude 外接编辑器（web/src/components/claude/providers/ProviderEditor.svelte 的型号区）。
  import type { CustomModel, CustomProbe, CustomProtocol } from "../../../lib/api.ts";
  import { applyProbe, capsBadges, SOURCE_TEXT } from "../../../lib/model-knowledge.ts";
  import Switch from "../../ui/Switch.svelte";
  import Button from "../../ui/Button.svelte";
  import TierTable from "./TierTable.svelte";
  import { collapse } from "../../../lib/motion.ts";
  import { t, tr } from "../../../lib/i18n.ts";

  let {
    model = $bindable(),
    protocol,
    isDefault,
    open = false,
    canProbe,
    ontoggle,
    ondefault,
    onremove,
    ondemote,
    probe,
  }: {
    model: CustomModel;
    protocol: CustomProtocol;
    isDefault: boolean;
    open?: boolean;
    canProbe: boolean;
    ontoggle: () => void;
    ondefault: () => void;
    onremove: () => void;
    ondemote: () => void; // 关掉或改成非对话：★ 让位
    probe: (m: CustomModel) => Promise<CustomProbe>;
  } = $props();

  const b = $derived(capsBadges(model));
  const srcTitle = (k: "contextWindow" | "maxOutput" | "vision" | "thinking") => {
    const s = model.source?.[k];
    return s && SOURCE_TEXT[s] ? tr(SOURCE_TEXT[s]) : "";
  };
  const markUser = (k: "contextWindow" | "maxOutput" | "vision") => {
    model.source = { ...(model.source ?? {}), [k]: "user" };
  };
  const approx = (k: "contextWindow" | "maxOutput" | "vision") => ["table", "guess", "default"].includes(model.source?.[k] ?? "");

  let probing = $state(false);
  let result = $state<(CustomProbe & { applied?: boolean }) | null>(null);
  async function runProbe() {
    if (probing) return;
    probing = true;
    try {
      result = await probe($state.snapshot(model) as CustomModel);
    } catch (e: any) {
      result = { model: model.id, notes: [], error: String(e?.message ?? e) };
    } finally {
      probing = false;
    }
  }
  function apply() {
    if (!result || result.error) return;
    const next = applyProbe(model as any, result as any) as unknown as CustomModel;
    Object.assign(model, next);
    if (model.kind === "other") ondemote();
    result = { ...result, applied: true };
  }
  function setEnabled(v: boolean) {
    model.enabled = v;
    if (!v) ondemote();
  }
  function setChat(v: boolean) {
    model.kind = v ? "chat" : "other";
    if (!v) ondemote();
  }
  const tierText = (x: { id: string; ok: boolean; thinking: boolean | null; error: string; status: number }) =>
    x.ok
      ? x.thinking === true
        ? t("档位 {id}：认，思考了", { id: x.id })
        : x.thinking === false
          ? t("档位 {id}：认，没思考", { id: x.id })
          : t("档位 {id}：认", { id: x.id })
      : t("档位 {id}：不认（{e}）", { id: x.id, e: x.error || String(x.status) });
</script>

<div class="mrow" class:off={!model.enabled} class:open>
  <div class="mhead">
    <Switch checked={model.enabled} label={t("启用")} onchange={setEnabled} />
    <button type="button" class="mname" onclick={ontoggle}>
      <span class="ml">{model.label || model.id}</span>
      {#if model.label && model.label !== model.id}<span class="mid">{model.id}</span>{/if}
    </button>
    <span class="badges">
      {#if b.other}<span class="badge warn" title={t("语音识别 / 合成、向量这类：不进模型菜单")}>{t("非对话")}</span>{/if}
      <span class="badge" title={t("上下文窗口") + (srcTitle("contextWindow") ? " · " + srcTitle("contextWindow") : "")}>{b.ctxApprox ? "≈" : ""}{b.ctx}</span>
      {#if !b.other && b.think === "tiers"}<span class="badge acc" title={model.efforts.map((x) => x.name).join(" / ")}>{t("思考")}</span>
      {:else if !b.other && b.think === "always"}<span class="badge acc" title={t("不发参数也会思考")}>{t("自带思考")}</span>{/if}
      {#if b.vision}<span class="badge" title={srcTitle("vision")}>{b.visionApprox ? "≈" : ""}{t("视觉")}</span>{/if}
    </span>
    <button
      type="button"
      class="pin"
      class:on={isDefault}
      disabled={model.kind === "other" || !model.enabled}
      title={t("设为默认型号")}
      aria-label={t("设为默认型号")}
      aria-pressed={isDefault}
      onclick={ondefault}
    >
      <svg viewBox="0 0 20 20" fill={isDefault ? "currentColor" : "none"} stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"><path d="m10 2.8 2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L2.8 8.1l5-.7z" /></svg>
    </button>
    <button type="button" class="chev" aria-label={open ? t("收起") : t("展开")} aria-expanded={open} onclick={ontoggle}>
      <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m7 8 3 3 3-3" /></svg>
    </button>
  </div>

  {#if open}
    <div class="mbody" transition:collapse>
      <div class="f3">
        <label class="fld">
          <span class="fl">{t("显示名")}</span>
          <input class="in" maxlength="80" bind:value={model.label} />
        </label>
        <label class="fld">
          <span class="fl">{t("上下文窗口")}{#if approx("contextWindow")}<span class="src" title={srcTitle("contextWindow")}>≈</span>{/if}</span>
          <input class="in mono" type="number" min="1024" step="1024" bind:value={model.contextWindow} oninput={() => markUser("contextWindow")} />
        </label>
        <label class="fld">
          <span class="fl">{t("输出上限")}{#if approx("maxOutput")}<span class="src" title={srcTitle("maxOutput")}>≈</span>{/if}</span>
          <input class="in mono" type="number" min="256" step="256" bind:value={model.maxOutput} oninput={() => markUser("maxOutput")} />
        </label>
      </div>
      <div class="sw">
        <span class="swt">
          <span class="lt">{t("支持图片")}{#if approx("vision")}<span class="src" title={srcTitle("vision")}>≈</span>{/if}</span>
          <span class="fh">{model.vision ? t("截图和附件原样发给这个型号") : t("图片换成文字说明，或交给辅助视觉模型")}</span>
        </span>
        <Switch checked={model.vision} label={t("支持图片")} onchange={(v) => { model.vision = v; markUser("vision"); }} />
      </div>
      <!-- 视频 / 音频：型号表认得的会自动打开；经中转时中转未必收（比如不认 input_audio 回 400），在这里关掉就不再原样发 -->
      <div class="sw">
        <span class="swt">
          <span class="lt">{t("支持视频")}</span>
          <span class="fh">{model.video ? t("视频附件原样发给这个型号") : t("视频附件不直接发给这个型号")}</span>
        </span>
        <Switch checked={model.video} label={t("支持视频")} onchange={(v) => (model.video = v)} />
      </div>
      <div class="sw">
        <span class="swt">
          <span class="lt">{t("支持音频")}</span>
          <span class="fh">{model.audio ? t("音频附件原样发给这个型号") : t("音频附件不直接发给这个型号")}</span>
        </span>
        <Switch checked={model.audio} label={t("支持音频")} onchange={(v) => (model.audio = v)} />
      </div>
      <div class="sw">
        <span class="swt">
          <span class="lt">{t("对话模型")}</span>
          <span class="fh">{model.kind === "other" ? t("语音识别 / 合成、向量这类：不进模型菜单") : t("出现在模型菜单里")}</span>
        </span>
        <Switch checked={model.kind !== "other"} label={t("对话模型")} onchange={setChat} />
      </div>

      <TierTable bind:model {protocol} />

      <div class="probe">
        <Button size="sm" variant="secondary" loading={probing} disabled={!canProbe} onclick={runProbe}>{t("探测能力")}</Button>
        <span class="fh">{t("真打几次（各一两句话）：读输出上限、看图、默认会不会思考、每一档端点认不认")}</span>
      </div>
      {#if result}
        <div class="pres" class:bad={Boolean(result.error)} transition:collapse>
          {#if result.error}
            <p class="lerr">{tr(result.error)}</p>
          {:else}
            <ul>
              {#each result.notes as n, i (i)}<li>{tr(n)}</li>{/each}
              {#each result.tiers ?? [] as x (x.id)}<li class:no={!x.ok}>{tierText(x)}</li>{/each}
            </ul>
            <Button size="sm" variant="primary" disabled={result.applied} onclick={apply}>{result.applied ? t("已应用") : t("应用到这个型号")}</Button>
          {/if}
        </div>
      {/if}
      <div class="mfoot"><Button size="sm" variant="danger" icon="trash" onclick={onremove}>{t("移除这个型号")}</Button></div>
    </div>
  {/if}
</div>

<style>
  .mrow {
    border-radius: 12px;
    background: var(--surface2);
    transition: background-color var(--t-fast) var(--ease);
  }
  .mrow.off .ml {
    color: var(--text3);
  }
  .mhead {
    display: flex;
    align-items: center;
    gap: 8px;
    min-height: 44px;
    padding: 4px 6px 4px 10px;
  }
  .mname {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    flex: 1;
    min-width: 0;
    text-align: left;
    color: var(--text);
  }
  .ml,
  .mid {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ml {
    font-size: var(--fs-base);
  }
  .mid {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  .badges {
    display: inline-flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 4px;
  }
  .badge {
    padding: 1px 7px;
    border-radius: var(--r-pill);
    background: var(--surface);
    color: var(--text2);
    font-size: var(--fs-xs);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .badge.acc {
    color: var(--accent);
    background: var(--accent-soft);
  }
  .badge.warn {
    color: color-mix(in srgb, var(--warn) 85%, var(--text));
    background: color-mix(in srgb, var(--warn) 14%, transparent);
  }
  .pin,
  .chev {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 30px;
    border-radius: var(--r-sm);
    color: var(--text3);
  }
  .pin svg,
  .chev svg {
    width: 17px;
    height: 17px;
  }
  .pin.on {
    color: var(--accent);
  }
  .pin:disabled {
    opacity: 0.3;
  }
  @media (hover: hover) {
    .pin:hover:not(:disabled),
    .chev:hover {
      background: var(--surface3);
      color: var(--text);
    }
  }
  .chev svg {
    transition: transform var(--t-fast) var(--ease);
  }
  .open .chev svg {
    transform: rotate(180deg);
  }
  .mbody {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 6px 12px 12px;
    border-top: 1px solid var(--border);
  }
  .f3 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 10px;
    padding-top: 8px;
  }
  .fld {
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 0;
  }
  .fl {
    font-size: var(--fs-sm);
    color: var(--text2);
  }
  .src {
    margin-left: 4px;
    color: var(--text3);
    cursor: help;
  }
  .in {
    height: 32px;
    min-width: 0;
    padding: 0 10px;
    border: 0;
    border-radius: 9px;
    background: var(--surface);
    color: var(--text);
    font-size: var(--fs-sm);
    outline: none;
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .in:focus {
    box-shadow:
      inset 0 0 0 1px var(--accent),
      0 0 0 3px var(--accent-soft);
  }
  .mono {
    font-family: var(--font-mono);
  }
  .sw {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .swt {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }
  .lt {
    font-size: var(--fs-sm);
  }
  .fh {
    font-size: var(--fs-xs);
    line-height: 1.5;
    color: var(--text3);
  }
  .probe {
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }
  .pres {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
    padding: 10px 12px;
    border-radius: 10px;
    background: var(--surface);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .pres ul {
    margin: 0;
    padding-left: 18px;
    font-size: var(--fs-sm);
    line-height: 1.6;
    color: var(--text2);
  }
  .pres li.no {
    color: var(--err);
  }
  .pres.bad {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--err) 50%, transparent);
  }
  .lerr {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--err);
    overflow-wrap: anywhere;
  }
  .mfoot {
    display: flex;
    justify-content: flex-end;
  }
</style>
