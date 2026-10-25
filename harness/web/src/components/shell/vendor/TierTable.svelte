<script lang="ts">
  // 单个型号的「思考方式 + 档位表」编辑（ProviderEditor 的型号展开区里用）。和 bridge 的 Claude 外接 ThinkingTiers 同一套规则
  // （src/model-knowledge/editor.mjs：方式 / 预设 / 发送值解析 / 校验），用 dimensio 自己的组件重写。
  //   thinking      none 不发思考参数 / budget 思考预算 / adaptive 自适应（这两种只有 Anthropic 协议有）/ effort 档位
  //   efforts       [{ id, name, value }]：value 为空 = 这一档什么都不发；文字 / 数字 / true·false = 写进写入字段；
  //                 JSON 对象 = 字段留空时整个并进请求体（如 {"thinking":{"type":"disabled"}}）
  //   effortDefault 首次选这个型号时用哪档（'' = 按 dimensio 的规则；没有关闭档时会多出一个「默认」= 什么都不发）
  // 输入框里的思考深度就列这些档（服务端映射成 off / low / … / max 七级，档名不同的照档名显示）。
  import type { CustomModel, CustomProtocol, CustomTier } from "../../../lib/api.ts";
  import { fmtTierValue, MAX_TIERS, modesFor, parseTierValue, presetsFor, slotsLost, startTiers, TIER_ID_RE, tierProblem } from "../../../lib/model-knowledge.ts";
  import Segmented from "../../ui/Segmented.svelte";
  import Switch from "../../ui/Switch.svelte";
  import Icon from "../../ui/Icon.svelte";
  import { t, tc, tr } from "../../../lib/i18n.ts";

  let { model = $bindable(), protocol }: { model: CustomModel; protocol: CustomProtocol } = $props();

  const MODE_LABEL: Record<string, () => string> = {
    none: () => t("不思考"),
    budget: () => t("预算"),
    adaptive: () => t("自适应"),
    effort: () => t("档位"),
  };
  const modes = $derived(modesFor(protocol).map((m) => ({ value: m as string, label: MODE_LABEL[m]() })));
  const presets = $derived(presetsFor(protocol));
  const hint = $derived(
    model.thinking === "budget"
      ? t("Anthropic 式 thinking.budget_tokens：发送值写预算 token 数，留空按 16000 的基准换算；关闭档不开思考")
      : model.thinking === "adaptive"
        ? t("thinking.type = adaptive：发送值写 output_config.effort（如 high），留空只开自适应")
        : model.thinking === "effort"
          ? t("每档的发送值写进写入字段；值是 JSON 对象且字段留空时，整个并进请求体")
          : t("不发思考参数；自带思考的模型照样会想。输入框里不显示思考深度。"),
  );
  // 档名是数据：开关式的「关闭 / 开启」照开关的值翻译
  const nameText = (name: string) => (name === "开启" ? tc("开关", "开启") : name === "关闭" ? tc("开关", "关闭") : name); // i18n-ignore（左边比对数据）
  // 写回时反过来：输入框里显示的是翻译后的「On / Off」，用户动了别处、这两个字没动，数据里仍存「开启 / 关闭」（不然一碰就被改成英文）
  const nameData = (shown: string) => (shown === tc("开关", "开启") ? "开启" : shown === tc("开关", "关闭") ? "关闭" : shown); // i18n-ignore（右边是数据）
  const touch = () => {
    if (model.source?.thinking !== "user") model.source = { ...(model.source ?? {}), thinking: "user" };
  };
  function setMode(v: string) {
    model.thinking = v as CustomModel["thinking"];
    model.efforts = startTiers(v, protocol, model.efforts) as CustomTier[];
    if (v !== "effort") model.effortField = "";
    if (!model.efforts.some((x) => x.id === model.effortDefault)) model.effortDefault = "";
    touch();
  }
  function applyPreset(k: string) {
    const p = presets.find((x) => x.k === k);
    if (!p) return;
    model.thinking = p.set.thinking;
    model.effortField = p.set.effortField;
    model.efforts = JSON.parse(JSON.stringify(p.set.efforts));
    if (!model.efforts.some((x) => x.id === model.effortDefault)) model.effortDefault = "";
    touch();
  }
  function addTier() {
    if (model.efforts.length >= MAX_TIERS) return;
    let n = model.efforts.length + 1;
    while (model.efforts.some((x) => x.id === "t" + n)) n++;
    model.efforts = [...model.efforts, { id: "t" + n, name: t("第 {n} 档", { n }), value: null }];
    touch();
  }
  function removeTier(i: number) {
    const id = model.efforts[i].id;
    model.efforts = model.efforts.filter((_, j) => j !== i);
    if (model.effortDefault === id) model.effortDefault = "";
    touch();
  }
  function move(i: number, d: number) {
    const j = i + d;
    if (j < 0 || j >= model.efforts.length) return;
    const a = [...model.efforts];
    [a[i], a[j]] = [a[j], a[i]];
    model.efforts = a;
    touch();
  }
  const problem = $derived(tierProblem(model));
  // 共用模块回的是「措辞键 + 参数」：填好参数后按整句模式翻译
  const problemText = $derived(problem ? tr(problem.key.replace(/\{(\w+)\}/g, (_m: string, k: string) => String(problem.params[k] ?? ""))) : "");
  // dimensio 只有七级思考档：自由命名的档放不进空槽时（关闭档以外最多 6 档）照实说，不再静默丢掉
  const lost = $derived(problem ? [] : slotsLost(model));
</script>

<div class="tt">
  <div class="fld">
    <span class="fl">{t("思考方式")}</span>
    <Segmented size="sm" options={modes} value={model.thinking} onchange={setMode} label={t("思考方式")} />
    <span class="fh">{hint}</span>
  </div>

  {#if model.thinking !== "none"}
    <div class="tiers">
      <div class="thead"><span>{t("档名")}</span><span>ID</span><span>{t("发送值")}</span><span></span></div>
      {#each model.efforts as row, i (i)}
        <div class="trow" class:bad={!TIER_ID_RE.test(row.id || "")}>
          <input class="in" maxlength="24" placeholder={t("档名")} value={nameText(row.name)} oninput={(e) => { row.name = nameData(e.currentTarget.value); touch(); }} aria-label={t("档名")} />
          <input class="in mono" maxlength="24" placeholder="id" bind:value={row.id} oninput={touch} aria-label="ID" />
          <input
            class="in mono"
            placeholder={t("留空 = 不发")}
            value={fmtTierValue(row.value)}
            onchange={(e) => { row.value = parseTierValue(e.currentTarget.value); touch(); }}
            aria-label={t("发送值")}
          />
          <span class="ops">
            <button type="button" class="ib" disabled={i === 0} aria-label={t("上移")} onclick={() => move(i, -1)}>↑</button>
            <button type="button" class="ib" aria-label={t("删除")} onclick={() => removeTier(i)}><Icon name="close" size={13} /></button>
          </span>
        </div>
      {/each}
      <div class="tfoot">
        {#if model.efforts.length < MAX_TIERS}<button type="button" class="lnk" onclick={addTier}>＋ {t("加一档")}</button>{/if}
        <span class="presets">
          {t("一键填入")}
          {#each presets as p (p.k)}<button type="button" class="chip" onclick={() => applyPreset(p.k)}>{tr(p.label)}</button>{/each}
        </span>
      </div>
    </div>

    <div class="row2">
      {#if model.thinking === "effort"}
        <label class="fld">
          <span class="fl">{t("写入字段")}</span>
          <input class="in mono" placeholder={protocol === "openai" ? "reasoning_effort" : protocol === "gemini" ? "generationConfig.thinkingConfig.thinkingLevel" : "output_config.effort"} bind:value={model.effortField} oninput={touch} />
        </label>
      {/if}
      <label class="fld">
        <span class="fl">{t("首次选中用哪档")}</span>
        <select class="in" bind:value={model.effortDefault}>
          <option value="">{t("按默认规则")}</option>
          {#each model.efforts as x (x.id)}<option value={x.id}>{nameText(x.name) || x.id}</option>{/each}
        </select>
      </label>
    </div>
  {/if}

  <div class="always">
    <span class="at">
      <span class="lt">{t("不发参数也会思考")}</span>
      <span class="fh">{t("小米、Kimi、GLM-5.3 这类：工具续轮回传思考原文（reasoning_content）；输入框胶囊在关不掉时写「模型自带思考」")}</span>
    </span>
    <Switch checked={model.alwaysThinks} label={t("不发参数也会思考")} onchange={(v) => { model.alwaysThinks = v; touch(); }} />
  </div>
  {#if problemText}<p class="err" role="alert">{problemText}</p>
  {:else if lost.length}<p class="err" role="alert">{t("dimensio 只有 7 级思考档（关闭档以外最多 6 档）：{ids} 放不进去，模型菜单里选不到。删掉几档，或把档位 ID 改成 off / minimal / low / medium / high / xhigh / max。", { ids: lost.join("、") })}</p>{/if}
</div>

<style>
  .tt {
    display: flex;
    flex-direction: column;
    gap: 12px;
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
  .fh {
    font-size: var(--fs-xs);
    line-height: 1.5;
    color: var(--text3);
  }
  .in {
    height: 32px;
    min-width: 0;
    padding: 0 10px;
    border: 0;
    border-radius: 9px;
    /* 型号展开区本身是 surface2 的面：输入框用更亮一层的 surface + 细描边，和同区的上下文 / 输出上限一个样 */
    background: var(--surface);
    color: var(--text);
    font-size: var(--fs-sm);
    outline: none;
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .in:focus {
    background: var(--surface);
    box-shadow:
      inset 0 0 0 1px var(--accent),
      0 0 0 3px var(--accent-soft);
  }
  .mono {
    font-family: var(--font-mono);
  }
  .tiers {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .thead,
  .trow {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 0.8fr) minmax(0, 1.6fr) auto;
    gap: 6px;
    align-items: center;
  }
  .thead {
    padding: 0 2px;
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  .trow.bad .in:nth-child(2) {
    box-shadow: inset 0 0 0 1px var(--err);
  }
  .ops {
    display: inline-flex;
    gap: 2px;
  }
  .ib {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: var(--r-sm);
    color: var(--text3);
    font-size: var(--fs-sm);
  }
  @media (hover: hover) {
    .ib:hover:not(:disabled) {
      background: var(--surface2);
      color: var(--text);
    }
    .chip:hover {
      background: var(--surface3);
      color: var(--text);
    }
  }
  .ib:disabled {
    opacity: 0.35;
  }
  .tfoot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding-top: 2px;
  }
  .lnk {
    font-size: var(--fs-sm);
    color: var(--accent);
  }
  .presets {
    display: inline-flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    font-size: var(--fs-xs);
    color: var(--text3);
  }
  .chip {
    padding: 3px 9px;
    border-radius: var(--r-pill);
    background: var(--surface);
    color: var(--text2);
    font-size: var(--fs-xs);
  }
  .row2 {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: 10px;
  }
  select.in {
    appearance: auto;
  }
  .always {
    display: flex;
    align-items: center;
    gap: 12px;
  }
  .at {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }
  .lt {
    font-size: var(--fs-sm);
    color: var(--text);
  }
  .err {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--err);
  }
</style>
