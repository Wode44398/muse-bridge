<script lang="ts" module>
  // 页脚（在外层 Sheet 里）读写的状态：保存 / 删除进行中、能不能保存、页脚那句话
  export interface EditorCtl {
    saving: boolean;
    deleting: boolean;
    confirmDelete: boolean;
    canSave: boolean;
    msg: string;
    err: boolean;
  }
  export const newCtl = (): EditorCtl => ({ saving: false, deleting: false, confirmDelete: false, canSave: false, msg: "", err: false });
</script>

<script lang="ts">
  // 自定义服务的编辑器（「模型服务」面板「＋」卡 / 自定义卡的铅笔下钻进来；服务端要有能力位 custom-providers-v2）。
  // 和 bridge 的 Claude 外接编辑器（web/src/components/claude/providers/ProviderEditor.svelte）同一个流程、同一套规则
  // （src/model-knowledge/editor.mjs）、同一种 JSON 形状，用 dimensio 自己的组件重写：
  //   连接：备注 / 协议（OpenAI · Anthropic · Gemini）/ 地址（实时显示实际请求；地址和协议对不上时黄条 + 一键改）/ 检测连接
  //         （同站兄弟地址 × 协议真打一次，一键应用）/ API Key / 鉴权方式 / 更多（请求头、输出上限字段、回传思考、提示缓存）
  //   型号：从服务拉取（每项附能力猜测，非对话的默认不勾，「全选」跳过它们）、手动添加；每个型号可展开改能力、思考档位、探测能力；★ 默认
  //   测试：用编辑中的配置真发一句（没保存的草稿也能测）；保存后自动测一次默认型号，失败当场标红、不关表单
  import { untrack } from "svelte";
  import * as api from "../../../lib/api.ts";
  import type { CustomAuthStyle, CustomModel, CustomProtocol, CustomProviderRecord } from "../../../lib/api.ts";
  import { AUTO_THINK_SOURCES, capsBadges, DETECT_RESULT_TEXT, endpointUrl, firstChat, pickCandidates, protocolMismatch, slotsLost, tierProblem, wireModel } from "../../../lib/model-knowledge.ts";
  import Section from "../../sheets/Section.svelte";
  import Segmented from "../../ui/Segmented.svelte";
  import TextField from "../../ui/TextField.svelte";
  import Button from "../../ui/Button.svelte";
  import Switch from "../../ui/Switch.svelte";
  import Icon from "../../ui/Icon.svelte";
  import ModelRow from "./ModelRow.svelte";
  import { collapse, rise } from "../../../lib/motion.ts";
  import { t, tc, tr } from "../../../lib/i18n.ts";

  let {
    source,
    ctl = $bindable(),
    onpersisted,
    onsaved,
    ondeleted,
  }: {
    source: CustomProviderRecord | null; // null = 新建
    ctl: EditorCtl;
    // 服务端已经落盘（不管随后的自动测试过没过）：外层据此刷新目录；新建的换成「编辑这条」（页脚出「删除」、按钮写「保存」）
    onpersisted: (r: { record: CustomProviderRecord; isNew: boolean }) => void | Promise<void>;
    onsaved: (r: { name: string; models: number; warning?: string; isNew: boolean }) => void;
    ondeleted: (name: string) => void;
  } = $props();

  // promptCaching 为 null = 用户没动过开关：不提交，服务端按地址定（只有 api.anthropic.com 默认开）
  type Draft = Omit<CustomProviderRecord, "id" | "promptCaching"> & { id: string; promptCaching: boolean | null };
  const MAX_MODELS = 300; // 一个服务最多存这么多型号（同服务端 custom-providers.ts MAX_MODELS）
  const fromSource = (s: CustomProviderRecord | null): Draft => {
    const p = JSON.parse(JSON.stringify(s ?? {}));
    const protocol: CustomProtocol = p.protocol ?? "openai";
    return {
      id: p.id ?? "",
      name: p.name ?? "",
      baseUrl: p.baseUrl ?? "",
      protocol,
      authStyle: p.authStyle ?? (protocol === "anthropic" ? "x-api-key" : protocol === "gemini" ? "goog" : "bearer"),
      headers: Array.isArray(p.headers) ? p.headers : [],
      maxTokensField: p.maxTokensField ?? "max_tokens",
      promptCaching: typeof p.promptCaching === "boolean" ? p.promptCaching : null,
      replayReasoning: p.replayReasoning === true,
      models: Array.isArray(p.models) ? p.models : [],
      defaultModel: p.defaultModel ?? "",
      hasKey: p.hasKey === true,
      keyTail: p.keyTail ?? "",
    };
  };
  let draft = $state<Draft>(fromSource(untrack(() => source)));
  let baseline = $state(JSON.stringify(untrack(() => draft)));
  let keyInput = $state("");
  let changingKey = $state(!untrack(() => draft.hasKey));
  const isNew = $derived(!draft.id);
  const changed = $derived(JSON.stringify(draft) !== baseline || Boolean(keyInput.trim()));

  let tab = $state<"conn" | "models" | "test">("conn");
  const tabs = $derived([
    { value: "conn", label: tc("模型服务", "连接") },
    { value: "models", label: draft.models.length ? t("型号 · {n}", { n: draft.models.length }) : t("型号") },
    { value: "test", label: t("测试") },
  ]);

  // ── 连接 ──
  const cleanBase = $derived(draft.baseUrl.trim().replace(/\/+$/, ""));
  const endpoint = $derived(endpointUrl(draft.protocol, cleanBase));
  const mismatch = $derived(protocolMismatch(draft.protocol, cleanBase));
  // 提示缓存没动过开关时跟着地址走（同服务端 connFields：只有官方端点默认开）
  const officialHost = (b: string) => {
    try {
      return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(b) ? b : `https://${b}`).host === "api.anthropic.com";
    } catch {
      return false;
    }
  };
  const cachingShown = $derived(draft.promptCaching ?? officialHost(cleanBase));
  const PROTO_OPTS = [
    { value: "openai" as const, label: "OpenAI" },
    { value: "anthropic" as const, label: "Anthropic" },
    { value: "gemini" as const, label: "Gemini" },
  ];
  const protoHint = $derived(
    draft.protocol === "anthropic"
      ? t("兼容 Anthropic Messages 的接口（…/anthropic、中转的 Claude 接口）：思考按 thinking / output_config 写")
      : draft.protocol === "gemini"
        ? t("Gemini 原生接口（generateContent）：思考写在 generationConfig.thinkingConfig")
        : t("兼容 OpenAI Chat Completions 的接口：中转站、OpenRouter、自己部署的 vLLM / Ollama……"),
  );
  const authOpts = $derived([
    { value: "bearer" as CustomAuthStyle, label: "Bearer" },
    { value: "x-api-key" as CustomAuthStyle, label: "x-api-key" },
    { value: "goog" as CustomAuthStyle, label: "x-goog-api-key" },
    { value: "none" as CustomAuthStyle, label: t("不需要") },
  ]);
  const DEFAULT_AUTH: Record<CustomProtocol, CustomAuthStyle> = { openai: "bearer", anthropic: "x-api-key", gemini: "goog" };
  let retierNote = $state("");
  async function setProtocol(v: CustomProtocol) {
    if (v === draft.protocol) return;
    const prev = draft.protocol;
    draft.protocol = v;
    if (draft.authStyle !== "none" && draft.authStyle === DEFAULT_AUTH[prev]) draft.authStyle = DEFAULT_AUTH[v];
    // 档位写法随协议不同（小米：Anthropic 端点 thinking.type，OpenAI 端点 reasoning_effort）：自动识别出来的按新协议重算，
    // 手动设的 / 探测出来的没法凭名字重算，列出来提示
    const auto = draft.models.filter((m) => AUTO_THINK_SOURCES.includes(m.source?.thinking ?? "default"));
    const back = v === (JSON.parse(baseline) as Draft).protocol;
    const manual = back ? [] : draft.models.filter((m) => m.kind !== "other" && m.efforts.length && !AUTO_THINK_SOURCES.includes(m.source?.thinking ?? "default"));
    retierNote = manual.length ? manual.slice(0, 6).map((m) => m.label || m.id).join("、") + (manual.length > 6 ? " …" : "") : "";
    for (let i = 0; i < auto.length; i += 50) {
      let guesses: CustomModel[] = [];
      try {
        guesses = (await api.customGuess(auto.slice(i, i + 50).map((m) => m.id), v)).models;
      } catch {
        return;
      }
      if (draft.protocol !== v) return; // 等结果的工夫又切回去了：以后来的那次为准
      for (const g of guesses) {
        const m = draft.models.find((x) => x.id === g.id);
        if (!m || !AUTO_THINK_SOURCES.includes(m.source?.thinking ?? "default")) continue;
        m.thinking = g.thinking;
        m.efforts = g.efforts;
        m.effortField = g.effortField;
        m.effortDefault = g.effortDefault;
        m.alwaysThinks = m.alwaysThinks || g.alwaysThinks;
        m.source = { ...(m.source ?? {}), thinking: g.source?.thinking ?? "guess" };
      }
    }
  }
  // 草稿（拉型号 / 检测 / 探测 / 测试用）：带上编辑中的 Key；不带就用已存的
  const conn = (withModels = false): api.CustomDraft => ({
    ...(draft.id ? { id: draft.id } : {}),
    name: draft.name.trim(),
    baseUrl: draft.baseUrl.trim(),
    protocol: draft.protocol,
    authStyle: draft.authStyle,
    headers: $state.snapshot(draft.headers).filter((h) => h.name.trim()),
    maxTokensField: draft.maxTokensField,
    ...(draft.promptCaching === null ? {} : { promptCaching: draft.promptCaching }),
    replayReasoning: draft.replayReasoning,
    ...(keyInput.trim() ? { apiKey: keyInput.trim() } : {}),
    ...(withModels ? { models: ($state.snapshot(draft.models) as CustomModel[]).map(wireModel), defaultModel: draft.defaultModel } : {}),
  });

  let detecting = $state(false);
  let detect = $state<(api.CustomDetect & { error?: undefined }) | { error: string } | null>(null);
  async function runDetect() {
    if (detecting || !cleanBase) return;
    detecting = true;
    detect = null;
    try {
      detect = await api.customDetect(conn(true));
    } catch (e: any) {
      detect = { error: String(e?.message ?? e) };
    } finally {
      detecting = false;
    }
  }
  async function applySuggest(s: { protocol: CustomProtocol; baseUrl: string; authStyle?: CustomAuthStyle }) {
    draft.baseUrl = s.baseUrl;
    await setProtocol(s.protocol);
    if (s.authStyle) draft.authStyle = s.authStyle;
    detect = null;
  }
  const resultText = (r: string) => tr(DETECT_RESULT_TEXT[r] ?? r);
  const protoName = (p: string) => (p === "anthropic" ? "Anthropic" : p === "gemini" ? "Gemini" : "OpenAI");
  let moreOpen = $state(false);

  // ── 型号 ──
  let expanded = $state<Record<string, boolean>>({});
  let fetching = $state(false);
  let fetchErr = $state("");
  let candidates = $state<CustomModel[] | null>(null);
  let picked = $state<Record<string, boolean>>({});
  let candQ = $state("");
  let candCut = $state<{ total: number; listed: number } | null>(null); // 端点列得比候选上限（1000）还多：照实说
  let addId = $state("");
  let adding = $state(false);
  async function pull() {
    if (fetching || !cleanBase) return;
    fetching = true;
    fetchErr = "";
    try {
      const r = await api.customModels(conn());
      const have = new Set(draft.models.map((m) => m.id));
      candCut = r.total > r.models.length ? { total: r.total, listed: r.models.length } : null;
      candidates = r.models.filter((m) => !have.has(m.id));
      picked = pickCandidates(candidates);
      candQ = "";
      if (!candidates.length) {
        fetchErr = t("端点上的型号都已经添加过了");
        candidates = null;
      }
    } catch (e: any) {
      fetchErr = String(e?.message ?? e);
    } finally {
      fetching = false;
    }
  }
  const candShown = $derived((candidates ?? []).filter((m) => !candQ || `${m.id} ${m.label}`.toLowerCase().includes(candQ.toLowerCase())));
  const pickedN = $derived((candidates ?? []).filter((m) => picked[m.id]).length);
  // 一个服务最多存 300 个型号：勾多了就不让加、照实说（以前悄悄截掉后面的）
  const room = $derived(MAX_MODELS - draft.models.length);
  const overPick = $derived(pickedN > room);
  function toggleAll() {
    const chat = candShown.filter((m) => m.kind !== "other"); // 「全选」跳过非对话模型
    const all = chat.every((m) => picked[m.id]);
    for (const m of chat) picked[m.id] = !all;
  }
  function addPicked() {
    if (overPick) return;
    const add = (candidates ?? []).filter((m) => picked[m.id]).map((m) => ({ ...m, enabled: true }));
    draft.models = [...draft.models, ...add];
    if (!draft.models.some((m) => m.id === draft.defaultModel && m.enabled && m.kind !== "other")) draft.defaultModel = firstChat(draft.models);
    candidates = null;
    candCut = null;
  }
  async function addManual() {
    const id = addId.trim();
    if (!id || adding) return;
    if (draft.models.some((m) => m.id === id)) {
      addId = "";
      return;
    }
    if (draft.models.length >= MAX_MODELS) {
      fetchErr = t("一个服务最多 {max} 个型号：先删掉一些再加。", { max: MAX_MODELS });
      return;
    }
    adding = true;
    try {
      const [g] = (await api.customGuess([id], draft.protocol)).models;
      if (g && !draft.models.some((m) => m.id === id)) {
        draft.models = [...draft.models, { ...g, enabled: true }];
        if (!draft.defaultModel) draft.defaultModel = firstChat(draft.models);
        expanded = { ...expanded, [id]: true };
      }
      addId = "";
    } catch (e: any) {
      fetchErr = String(e?.message ?? e);
    } finally {
      adding = false;
    }
  }
  function removeModel(id: string) {
    draft.models = draft.models.filter((m) => m.id !== id);
    if (draft.defaultModel === id) draft.defaultModel = firstChat(draft.models);
  }
  function demote(id: string) {
    if (draft.defaultModel === id) draft.defaultModel = firstChat(draft.models);
  }
  const probeOne = (m: CustomModel) => api.customProbe(conn(), wireModel(m));
  const chatModels = $derived(draft.models.filter((m) => m.enabled && m.kind !== "other"));

  // ── 测试 ──
  let testModel = $state(untrack(() => draft.defaultModel));
  let testing = $state(false);
  let result = $state<api.CustomTestResult | null>(null);
  async function runTest(model?: string) {
    if (testing) return;
    testing = true;
    result = null;
    try {
      result = await api.customTest(conn(true), model || testModel || draft.defaultModel);
    } catch (e: any) {
      result = { ok: false, status: 0, ms: 0, model: model || testModel, error: String(e?.message ?? e) };
    } finally {
      testing = false;
    }
    return result;
  }
  const secs = (ms: number) => (ms >= 1000 ? (ms / 1000).toFixed(1) + "s" : ms + "ms");

  // ── 保存 / 删除（外层 Sheet 的页脚调） ──
  // 档位表不合规（ID 不合法 / 重复 / 写入字段不对），或放不进 dimensio 的七级思考档：服务端会拒，这里先拦下、指明是哪个型号
  const tierBad = $derived(draft.models.find((m) => tierProblem(m) || slotsLost(m).length));
  const invalid = $derived(
    !draft.baseUrl.trim()
      ? t("先填接口地址")
      : !draft.hasKey && !keyInput.trim() && draft.authStyle !== "none"
        ? t("先填 API Key")
        : draft.models.length && !chatModels.length
          ? t("至少启用一个对话型号")
          : tierBad
            ? t("「{model}」的思考档位有问题：展开这个型号看看", { model: tierBad.label || tierBad.id })
            : "",
  );
  let lastMsg = $state("");
  let lastErr = $state(false);
  $effect(() => {
    ctl.canSave = !invalid && (changed || isNew);
    ctl.msg = lastMsg || (changed && !isNew ? t("有改动没保存") : "") || (draft.baseUrl.trim() ? invalid : "");
    ctl.err = lastErr || Boolean(draft.baseUrl.trim() && invalid);
  });

  export async function save() {
    if (ctl.saving || invalid) return;
    ctl.saving = true;
    lastMsg = "";
    lastErr = false;
    const wasNew = isNew;
    const form: api.CustomProviderForm = {
      ...conn(draft.models.length > 0),
      ...(keyInput.trim() ? { apiKey: keyInput.trim() } : {}),
    };
    try {
      const r = wasNew ? await api.addCustomProvider(form) : await api.updateCustomProvider(draft.id, form);
      if (r.provider) {
        draft = fromSource(r.provider);
        baseline = JSON.stringify(draft);
        // 「测试」页的型号下拉：新建时打开表单那会儿还没有默认型号，保存后补上（测试失败停在测试页时不至于是空的）
        if (!draft.models.some((m) => m.id === testModel)) testModel = draft.defaultModel;
      }
      keyInput = "";
      changingKey = !draft.hasKey;
      // 已经落盘：先让外层刷新目录（网格、模型菜单），再测——测试失败只决定表单留不留，不能让目录停在旧版
      // （以前测试一失败就不刷新：新加的服务网格里看不到，用户以为没加上又加一遍，就出了两个重复的服务）
      if (r.provider) {
        try {
          await onpersisted({ record: r.provider, isNew: wasNew });
        } catch {
          /* 刷新失败不算保存失败（服务端已经存好了） */
        }
      }
      // 保存后顺手测一次默认型号：配错了当场就知道，不用等到发消息才看见报错
      const tr2 = r.provider ? await runTest(r.provider.defaultModel) : null;
      if (tr2 && !tr2.ok) {
        tab = "test";
        lastMsg = t("已保存，但测试默认型号失败：{e}", { e: tr(String(tr2.error ?? "")).slice(0, 120) });
        lastErr = true;
        return;
      }
      onsaved({ name: draft.name.trim() || t("自定义服务"), models: r.models, warning: r.warning, isNew: wasNew });
    } catch (e: any) {
      lastMsg = tr(String(e?.message ?? e));
      lastErr = true;
      // 接口列不出型号：去「型号」手动添加
      if (e?.body?.needsModel) tab = "models";
    } finally {
      ctl.saving = false;
    }
  }

  export async function remove() {
    if (!draft.id || ctl.deleting) return;
    if (!ctl.confirmDelete) {
      ctl.confirmDelete = true;
      return;
    }
    ctl.deleting = true;
    try {
      await api.deleteCustomProvider(draft.id);
      ondeleted(draft.name);
    } catch (e: any) {
      lastMsg = tr(String(e?.message ?? e));
      lastErr = true;
    } finally {
      ctl.deleting = false;
      ctl.confirmDelete = false;
    }
  }
</script>

<div class="ed" in:rise={{ y: 8 }}>
  <div class="tabs"><Segmented options={tabs} value={tab} onchange={(v) => (tab = v as typeof tab)} full label={t("编辑分区")} /></div>

  {#if tab === "conn"}
    <Section title={t("备注")}>
      <TextField bind:value={draft.name} label={t("备注")} placeholder={t("比如：公司网关")} maxlength={40} />
    </Section>

    <Section title={t("接口协议")} footnote={protoHint}>
      <Segmented options={PROTO_OPTS} value={draft.protocol} onchange={(v) => void setProtocol(v)} full label={t("接口协议")} />
    </Section>
    {#if retierNote}
      <div class="note warn" transition:collapse>
        {t("换了协议：{names} 的思考档位是按原协议写的（手动设的或探测出来的），不会自动换。建议展开这些型号点「探测能力」，或在档位里用「一键填入」重设。", { names: retierNote })}
        <span class="nb"><Button size="sm" variant="ghost" onclick={() => (retierNote = "")}>{t("知道了")}</Button></span>
      </div>
    {/if}

    <Section title={t("接口地址")} footnote={endpoint ? t("实际请求 {url}", { url: endpoint }) : t("填到 /v1 这一级；贴完整的 …/chat/completions 也行，会自动收好。")}>
      <TextField bind:value={draft.baseUrl} type="url" mono label={t("接口地址")} placeholder={draft.protocol === "anthropic" ? "https://api.example.com/anthropic" : draft.protocol === "gemini" ? "https://generativelanguage.googleapis.com/v1beta" : "https://api.example.com/v1"} />
    </Section>
    {#if mismatch && !mismatch.sure}
      <!-- 中转的 …/v1 + Anthropic：new-api / one-api 一类在 …/v1/messages 上本来就有 Anthropic 接口——只提示，不断言、不给一键改地址 -->
      <div class="note info" transition:collapse>
        <span>{t("有的服务 …/v1 下只有 OpenAI 兼容接口（按 Anthropic 协议请求会 404）；中转站的 …/v1 多半两种都有。不确定就点「检测连接」。")}</span>
      </div>
    {:else if mismatch}
      <div class="note warn" transition:collapse>
        <span>
          {#if mismatch.to === "openai"}{t("这个站的 …/v1 只有 OpenAI 兼容接口，按 Anthropic 协议请求会 404（每条消息都报错）。")}
          {:else if mismatch.to === "anthropic"}{t("以 /anthropic 结尾的多半是 Anthropic 兼容地址，按 OpenAI 协议请求会 404。")}
          {:else}{t("这个地址和协议对不上：Google 的 …/v1beta 是 Gemini 原生接口，…/v1beta/openai 才是 OpenAI 兼容接口。")}{/if}
        </span>
        <span class="nb">
          <Button size="sm" variant="secondary" onclick={() => void setProtocol(mismatch.to)}>{t("改用 {p} 协议", { p: protoName(mismatch.to) })}</Button>
          {#if mismatch.alt !== cleanBase}<Button size="sm" variant="secondary" onclick={() => (draft.baseUrl = mismatch.alt)}>{t("改成 {url}", { url: mismatch.alt.replace(/^https?:\/\//, "") })}</Button>{/if}
        </span>
      </div>
    {/if}

    <div class="detect">
      <Button size="sm" variant="secondary" icon="network" loading={detecting} disabled={!cleanBase} onclick={runDetect}>{t("检测连接")}</Button>
      <span class="fh">{t("用这把 Key 在这个地址和同站的兄弟地址上，各种协议各真打一次，看哪个组合能通")}</span>
    </div>
    {#if detect}
      <div class="dres" transition:collapse>
        {#if "error" in detect && detect.error}
          <p class="dline bad">{tr(detect.error)}</p>
        {:else if !("error" in detect && detect.error)}
          {@const d = detect as api.CustomDetect}
          {#if d.ok}<p class="dline ok">{t("当前配置能通")}{#if d.model}<span class="muted"> · {d.model}</span>{/if}</p>
          {:else if d.suggest}
            <p class="dline">
              {t("当前配置不通；建议改成")} <b>{protoName(d.suggest.protocol)}</b> · <code>{d.suggest.baseUrl}</code>
              <Button size="sm" variant="primary" onclick={() => d.suggest && void applySuggest(d.suggest)}>{t("一键应用")}</Button>
            </p>
          {:else if d.current?.result === "model"}<p class="dline bad">{t("地址和协议是对的，但型号「{model}」这里没有：在「型号」里换一个或刷新型号", { model: d.model })}</p>
          {:else if d.current?.result === "auth"}<p class="dline bad">{t("地址和协议是对的，但 Key 被拒：检查 Key 和鉴权方式")}</p>
          {:else}<p class="dline bad">{t("没有找到能通的组合：检查地址、Key 和网络")}</p>{/if}
          <details>
            <summary>{t("每个组合的结果")}</summary>
            {#each d.results as r, i (i)}
              <div class="drow">
                <span class="st" class:ok={r.result === "ok"} class:bad={r.result === "missing" || r.result === "network"}>{resultText(r.result)}</span>
                <span class="mono">{protoName(r.protocol)} · {r.url}</span>
                {#if (r.result === "ok" || r.result === "model" || r.result === "auth") && !(r.protocol === draft.protocol && r.baseUrl === cleanBase)}
                  <button type="button" class="lnk" onclick={() => void applySuggest(r)}>{t("用这个")}</button>
                {/if}
                {#if r.message && r.result !== "ok"}<span class="lerr" title={r.message}>{r.message}</span>{/if}
              </div>
            {/each}
          </details>
        {/if}
      </div>
    {/if}

    <Section title={t("API Key")} footnote={t("加密存在服务端，不回传浏览器。")}>
      {#if !changingKey && draft.hasKey}
        <div class="keyrow">
          <span class="keybox">••••••••{draft.keyTail}</span>
          <Button size="sm" variant="secondary" onclick={() => (changingKey = true)}>{t("更换")}</Button>
        </div>
      {:else}
        <TextField bind:value={keyInput} type="password" mono label={t("API Key")} placeholder={draft.authStyle === "none" ? t("这个服务不需要 Key") : draft.hasKey ? t("••••••••（留空保持不变）") : "sk-…"} />
      {/if}
    </Section>

    <Section title={t("鉴权方式")}>
      <Segmented size="sm" options={authOpts} value={draft.authStyle} onchange={(v) => (draft.authStyle = v)} full label={t("鉴权方式")} />
    </Section>

    <button type="button" class="more" aria-expanded={moreOpen} onclick={() => (moreOpen = !moreOpen)}>
      <Icon name="sliders" size={15} /> {t("更多设置")}
    </button>
    {#if moreOpen}
      <div class="morebody" transition:collapse>
        <Section title={t("请求头")} footnote={t("中转站要的额外请求头（鉴权头由 dimensio 自己管）")}>
          <div class="hdrs">
            {#each draft.headers as h, i (i)}
              <div class="hdr">
                <input class="in mono" placeholder="X-Custom-Header" bind:value={h.name} aria-label={t("请求头名")} />
                <input class="in mono" placeholder={t("值")} bind:value={h.value} aria-label={t("值")} />
                <button type="button" class="ib" aria-label={t("删除")} onclick={() => (draft.headers = draft.headers.filter((_, j) => j !== i))}><Icon name="close" size={13} /></button>
              </div>
            {/each}
            {#if draft.headers.length < 16}<button type="button" class="lnk" onclick={() => (draft.headers = [...draft.headers, { name: "", value: "" }])}>＋ {t("添加请求头")}</button>{/if}
          </div>
        </Section>
        {#if draft.protocol === "openai"}
          <Section title={t("输出上限字段")} footnote={t("OpenAI 自家的推理模型要用 max_completion_tokens")}>
            <Segmented size="sm" options={[{ value: "max_tokens", label: "max_tokens" }, { value: "max_completion_tokens", label: "max_completion_tokens" }]} value={draft.maxTokensField} onchange={(v) => (draft.maxTokensField = v as typeof draft.maxTokensField)} full label={t("输出上限字段")} />
          </Section>
          <div class="sw">
            <span class="swt"><span class="lt">{t("回传思考内容")}</span><span class="fh">{t("工具续轮把上一轮的思考原文带回去（reasoning_content）；标了「不发参数也会思考」的型号总会回传")}</span></span>
            <Switch checked={draft.replayReasoning} label={t("回传思考内容")} onchange={(v) => (draft.replayReasoning = v)} />
          </div>
        {:else if draft.protocol === "anthropic"}
          <div class="sw">
            <span class="swt"><span class="lt">{t("提示缓存")}</span><span class="fh">{t("服务支持 Anthropic 式 cache_control 才开；第三方多半不认，有的直接报错")}</span></span>
            <Switch checked={cachingShown} label={t("提示缓存")} onchange={(v) => (draft.promptCaching = v)} />
          </div>
        {/if}
      </div>
    {/if}
  {:else if tab === "models"}
    <div class="mtop">
      <p class="lead">{t("★ 是这家的默认型号（第一次切过来用它、测试也用它）。能力前面带「≈」的是猜的，展开型号可以「探测能力」真打一次核实。")}</p>
      <Button size="sm" variant="secondary" icon="reload" loading={fetching} disabled={!cleanBase} onclick={pull}>{draft.models.length ? t("刷新型号") : t("从服务拉取")}</Button>
    </div>
    {#if fetchErr}<div class="note warn" transition:collapse>{tr(fetchErr)}</div>{/if}

    {#if candidates}
      <div class="cands" transition:collapse>
        <div class="cands-top">
          {#if candidates.length > 15}<TextField bind:value={candQ} size="sm" icon="search" label={t("搜索型号")} placeholder={t("搜索型号")} />{:else}<span class="muted">{t("接口列出了 {n} 个新型号", { n: candidates.length })}</span>{/if}
          <Button size="sm" variant="ghost" onclick={toggleAll}>{t("全选")}</Button>
        </div>
        <div class="cands-list">
          {#each candShown as m (m.id)}
            {@const b = capsBadges(m)}
            <label class="cand" class:other={m.kind === "other"}>
              <input type="checkbox" bind:checked={picked[m.id]} />
              <span class="cname"><span class="mono">{m.id}</span>{#if m.label && m.label !== m.id}<span class="muted">{m.label}</span>{/if}</span>
              <span class="badges">
                {#if b.other}<span class="badge warn" title={t("语音识别 / 合成、向量这类：默认不勾，加进来也不进模型菜单")}>{t("非对话")}</span>{/if}
                {#if b.ctx}<span class="badge">{b.ctxApprox ? "≈" : ""}{b.ctx}</span>{/if}
                {#if !b.other && b.think === "tiers"}<span class="badge acc">{t("思考")}</span>{/if}
                {#if b.vision}<span class="badge">{t("视觉")}</span>{/if}
              </span>
            </label>
          {/each}
        </div>
        {#if candCut}<div class="cnote">{t("接口一共列出 {total} 个型号，这里只列了前 {n} 个；没列出来的可以在下面手动添加型号 ID。", { total: candCut.total, n: candCut.listed })}</div>{/if}
        {#if overPick}<div class="cnote bad">{t("一个服务最多 {max} 个型号：已有 {have} 个，这次最多再加 {left} 个，请少勾一些。", { max: MAX_MODELS, have: draft.models.length, left: Math.max(0, room) })}</div>{/if}
        <div class="cands-foot">
          <Button size="sm" variant="ghost" onclick={() => { candidates = null; candCut = null; }}>{t("取消")}</Button>
          <Button size="sm" variant="primary" disabled={!pickedN || overPick} onclick={addPicked}>{t("添加 {n} 个", { n: pickedN })}</Button>
        </div>
      </div>
    {/if}

    <div class="models">
      {#each draft.models as m, i (m.id)}
        <ModelRow
          bind:model={draft.models[i]}
          protocol={draft.protocol}
          isDefault={draft.defaultModel === m.id}
          open={Boolean(expanded[m.id])}
          canProbe={Boolean(cleanBase)}
          ontoggle={() => (expanded = { ...expanded, [m.id]: !expanded[m.id] })}
          ondefault={() => (draft.defaultModel = m.id)}
          onremove={() => removeModel(m.id)}
          ondemote={() => demote(m.id)}
          probe={probeOne}
        />
      {:else}
        <p class="empty">{t("还没有型号。先填好连接再「从服务拉取」，或在下面手动添加型号 ID；也可以直接保存，服务端会自己拉。")}</p>
      {/each}
    </div>
    <div class="addrow">
      <TextField bind:value={addId} mono size="sm" label={t("型号 ID")} placeholder={t("型号 ID，比如 deepseek-chat")} onkeydown={(e) => { if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); void addManual(); } }} />
      <Button size="sm" variant="secondary" loading={adding} disabled={!addId.trim()} onclick={addManual}>{t("手动添加")}</Button>
    </div>
  {:else}
    <Section title={t("测试")} footnote={changed || isNew ? t("用编辑中的配置测试（还没保存）。") : t("真发一句「只回复 OK」，看通不通、多快、有没有思考。")}>
      <div class="testbar">
        <select class="in sel" bind:value={testModel} aria-label={t("测试用的型号")}>
          {#each chatModels as m (m.id)}<option value={m.id}>{m.label || m.id}</option>{/each}
        </select>
        <Button variant="primary" loading={testing} disabled={!cleanBase || !chatModels.length} onclick={() => void runTest()}>{t("发送测试")}</Button>
      </div>
    </Section>
    {#if result}
      <div class="result" class:ok={result.ok} class:bad={!result.ok} transition:collapse>
        <div class="rhead">
          <span class="dot"></span><b>{result.ok ? t("连通") : t("失败")}</b>
          {#if result.ms}<span class="muted">{secs(result.ms)}</span>{/if}
          {#if result.status}<span class="badge">HTTP {result.status}</span>{/if}
          {#if result.thinking}<span class="badge acc">{t("含思考")}</span>{/if}
          {#if result.usage}<span class="muted">{t("输入 {i} · 输出 {o}", { i: result.usage.input, o: result.usage.output })}</span>{/if}
        </div>
        {#if result.ok}<p class="reply">{result.reply || t("（回复为空）")}</p>{:else}<pre class="errbody">{tr(String(result.error ?? ""))}</pre>{/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .ed {
    padding-top: 2px;
  }
  .tabs {
    margin: 0 0 18px;
  }
  /* Section 的脚注被 .hxroot .md p 清了外边距，这里补回它自己的 8px / 4px */
  .ed :global(p.foot) {
    margin: 8px 4px 0;
    overflow-wrap: anywhere;
  }
  .fh {
    font-size: var(--fs-xs);
    line-height: 1.5;
    color: var(--text3);
  }
  .muted {
    color: var(--text3);
  }
  .mono {
    font-family: var(--font-mono);
  }
  .note {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin: -10px 0 18px;
    padding: 10px 12px;
    border-radius: 11px;
    font-size: var(--fs-sm);
    line-height: 1.55;
  }
  .note.warn {
    background: color-mix(in srgb, var(--warn) 12%, transparent);
    color: color-mix(in srgb, var(--warn) 70%, var(--text));
  }
  .note.info {
    background: var(--surface2);
    color: var(--text2);
  }
  .nb {
    display: inline-flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .detect {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 10px;
    margin: -6px 4px 14px;
  }
  .dres {
    margin: -4px 0 18px;
    padding: 10px 12px;
    border-radius: 11px;
    background: var(--surface2);
    font-size: var(--fs-sm);
  }
  .dline {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin: 0 0 6px;
    line-height: 1.55;
  }
  .dline.ok {
    color: var(--ok);
  }
  .dline.bad {
    color: var(--err);
  }
  .dline code,
  .drow .mono {
    font-family: var(--font-mono);
    font-size: var(--fs-xs);
    overflow-wrap: anywhere;
  }
  details summary {
    cursor: pointer;
    color: var(--text3);
    font-size: var(--fs-xs);
  }
  .drow {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 6px 10px;
    padding: 5px 0;
    border-top: 1px solid var(--border);
  }
  .st {
    min-width: 6em;
    color: var(--text2);
  }
  .st.ok {
    color: var(--ok);
  }
  .st.bad {
    color: var(--text3);
  }
  .lerr {
    flex-basis: 100%;
    color: var(--text3);
    font-size: var(--fs-xs);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .lnk {
    color: var(--accent);
    font-size: var(--fs-sm);
  }
  .keyrow {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .keybox {
    flex: 1;
    height: 38px;
    padding: 0 12px;
    border-radius: 11px;
    background: var(--surface2);
    color: var(--text2);
    font-family: var(--font-mono);
    line-height: 38px;
  }
  .more {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: -6px 4px 14px;
    color: var(--text2);
    font-size: var(--fs-sm);
  }
  .more[aria-expanded="true"] {
    color: var(--text);
  }
  .in {
    height: 32px;
    min-width: 0;
    padding: 0 10px;
    border: 0;
    border-radius: 9px;
    background: var(--surface2);
    color: var(--text);
    font-size: var(--fs-sm);
    outline: none;
  }
  .in:focus {
    background: var(--surface);
    box-shadow:
      inset 0 0 0 1px var(--accent),
      0 0 0 3px var(--accent-soft);
  }
  .hdrs {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .hdr {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr) auto;
    gap: 6px;
    align-items: center;
  }
  .ib {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border-radius: var(--r-sm);
    color: var(--text3);
  }
  @media (hover: hover) {
    .ib:hover {
      background: var(--surface2);
      color: var(--text);
    }
    .cand:hover {
      background: var(--surface2);
    }
  }
  .sw {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0 4px 18px;
  }
  .swt {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }
  .lt {
    font-size: var(--fs-base);
  }
  .mtop {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin: 0 4px 14px;
  }
  .lead {
    flex: 1;
    margin: 0;
    font-size: var(--fs-sm);
    line-height: 1.6;
    color: var(--text2);
  }
  .cands {
    margin: 0 0 14px;
    padding: 10px;
    border-radius: 12px;
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .cands-top,
  .cands-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .cands-top :global(.tf) {
    flex: 1;
  }
  .cands-list {
    max-height: 320px;
    margin: 8px 0;
    overflow-y: auto;
  }
  .cnote {
    margin: 0 4px 8px;
    font-size: var(--fs-xs);
    line-height: 1.5;
    color: var(--text3);
  }
  .cnote.bad {
    color: var(--err);
  }
  .cand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 7px 4px;
    border-radius: 8px;
    cursor: pointer;
  }
  .cand.other .cname {
    color: var(--text3);
  }
  .cand input {
    accent-color: var(--accent);
  }
  .cname {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-width: 0;
    font-size: var(--fs-sm);
    overflow-wrap: anywhere;
  }
  .cname .muted {
    font-size: var(--fs-xs);
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
    background: var(--surface2);
    color: var(--text2);
    font-size: var(--fs-xs);
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
  .models {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .empty {
    margin: 0 4px;
    font-size: var(--fs-sm);
    line-height: 1.6;
    color: var(--text3);
  }
  .addrow {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 12px 0 4px;
  }
  .addrow :global(.tf) {
    flex: 1;
  }
  .testbar {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .sel {
    flex: 1;
    height: 38px;
    appearance: auto;
  }
  .result {
    padding: 10px 12px;
    border-radius: 12px;
    background: var(--surface2);
    font-size: var(--fs-sm);
  }
  .rhead {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }
  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text3);
  }
  .result.ok .dot {
    background: var(--ok);
  }
  .result.bad .dot {
    background: var(--err);
  }
  .reply {
    margin: 8px 0 0;
    color: var(--text);
  }
  .errbody {
    margin: 8px 0 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-family: var(--font-ui);
    color: var(--err);
  }
</style>
