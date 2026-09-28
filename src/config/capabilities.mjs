// Single source of truth for Claude model enums, defaults, per-model capability maps,
// and display labels. Both the backend and the frontend (web/, imported at compile
// time and injected as window.__CAPS__) consume from this one module. The
// /api/capabilities endpoint exposes the same JSON for debugging or other consumers.
// dimensio keeps its own provider catalog in harness/server/catalog.ts.
//
// When you add a new model / change a default / discover a per-model quirk, edit
// HERE — everything else just imports.

export const CAPABILITIES = {
  claude: {
    models: [
      // Fable 5.1 (2026-09-01，SDK 0.3.257 / 内核 2.1.257 首次收录，官方 /model 默认
      // Fable 档)。同价位接棒 Fable 5（$10/$50，cache read 降到 $0.25/M），长程 agent
      // 编码/文档表格/多步检索/视觉更强；思考恒开、effort 五档（probe 实测 max 通过）。
      // 发布当天 probe（modelUsage.contextWindow）：**裸 id 直接 1M**（不像 Fable 5/
      // Opus 5 要 [1m] 后缀才 1M），[1m] 兄弟档也接受同样 1M；maxOutputTokens 64k。
      // fast mode 不支持（注 settings.fastMode 后 fast_mode_state 仍 off，对照 Opus 5
      // 同时刻 on），故不进 fast 表。三条 API 级差异（forced tool_choice 400、思考块
      // 绑定产出模型、编辑历史使思考块失效）全在 SDK 内核里处理，bridge 不感知。
      { id: 'claude-fable-5-1', name: 'Fable 5.1' },
      // Opus 5.5（2026-09-22，SDK 0.3.280 / 内核 2.1.280 首次收录，官方 /model 的 Opus 档默认）。
      // 比 Opus 5 更便宜（$4/$20，cache read $0.20/M），知识截止 2026-06，maxOutputTokens 128k。
      // 发布当天 probe（bridge 激活账号真打，modelUsage.contextWindow）：**裸 id 直接 1M**（同
      // Fable 5.1，不进 oneM 表），[1m] 兄弟档也是 1M；effort 五档（max 实测通过）；**不传 effort 时
      // API 默认 medium**（Opus 5 是 high）——见下 effortDefaults；fast mode 支持（fast_mode_state=on）。
      // 安全栅门回退：bio/frontier_llm → Opus 5、cyber → Opus 4.8（CLI 内置表），走现有 onModelNotice。
      { id: 'claude-opus-5-5', name: 'Opus 5.5' },
      // Fable 5 (Mythos-class, 2026-06-09). Probe-verified on SDK 0.3.150 (bundled
      // CLI 2.1.150): runs fine despite docs saying "picker needs CLI 2.1.170+" —
      // that gate is interactive-only. Like Opus 4.8, the bare id gets a 200k
      // window at the SDK layer; 1M requires the explicit [1m] suffix (verified
      // via modelUsage.contextWindow). All five effort levels accepted.
      // Note: Fable 5 系有安全分类器（cyber/bio）。SDK 宿主【默认自动切换】（switchModelsOnFlag
      // 默认 true，CLI 2.1.257 实读 + 09-02 探针）：被标记的请求会切到回退模型重试（cyber→Opus 4.8、
      // bio→Opus 5），并下发 system/model_refusal_fallback 帧——bridge 渲染成提示卡、撤回半截正文、
      // 把会话模型切过去（claude.mjs onModelNotice）；表外类别才以 model_refusal_no_fallback + 拒答
      // 结束本轮。旧注释「headless 路径无自动回退」是 SDK 0.3.150 时代的 probe 结论，已过时。
      // 2026-07-12 起 1M 上下文默认开启：picker 只列裸 id，凡在 oneM 表里的模型，
      // 后端跑 query 时一律静默换成 [1m] 兄弟档（见 claude.mjs to1M）。选项里不再
      // 出现 “xx 1M”；旧客户端发来的 [1m] id 仍被白名单接受（见下 CLAUDE_MODELS）。
      { id: 'claude-fable-5', name: 'Fable 5' },
      // Opus 5 (2026-07-24). Claude 5 家族第四员——定位「日常主力」：接近 Fable 5
      // 智力、半价（$5/$25），复杂 agent 编码与企业工作首选，知识截止 2026-05。
      // adaptive thinking（无 extended），effort 五档，API 默认 high。发布当天
      // probe 验证（SDK 0.3.150，modelUsage.contextWindow）：裸 id 200k，[1m]
      // 兄弟档 1M——与 Fable 5 / Opus 4.8 同款行为。
      { id: 'claude-opus-5', name: 'Opus 5' },
      { id: 'claude-opus-4-8', name: 'Opus 4.8' },
      { id: 'claude-opus-4-7', name: 'Opus 4.7' },
      // Sonnet 5.5（2026-09-28，SDK 0.3.280 / 内核 2.1.280 已认，无需升 SDK）。发布当天 probe（bridge
      // 激活账号真打）：**裸 id 200k、[1m] 兄弟档 1M**（同 Sonnet 5，进 oneM 表）；effort 五档，max 实测通过；
      // **不传 effort 时默认 high**（Stop hook 实测，不进 effortDefaults）；fast 注 settings 后仍 off → 不进 fast 表。
      { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5' },
      // Sonnet 5 (2026-06-30). Anthropic's new flagship Sonnet — most agentic
      // Sonnet yet, and the new default for Claude Free/Pro. 128k out, adaptive
      // thinking (no extended), all five efforts; effort defaults high on the
      // API/CLI. Intro pricing $2/$10 per MTok through 2026-08-31, then $3/$15.
      // Dateless pinned snapshot id (alias == id). Probe-verified on this SDK
      // (0.3.150) via modelUsage.contextWindow: bare id gets a 200k window, the
      // [1m] suffix gets the full 1M — same as Fable 5 / Opus 4.8.
      { id: 'claude-sonnet-5', name: 'Sonnet 5' },
      { id: 'claude-sonnet-4-6', name: 'Sonnet 4.6' },
      { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5' },
      { id: 'claude-opus-4-6', name: 'Opus 4.6 Legacy' },
    ],
    // 支持 [1m] 兄弟档的裸 id（probe 验证过 contextWindow=1M 的那几个）。Sonnet 4.6 /
    // Haiku 4.5 / Opus 4.6 没有 [1m] 档，保持 200k。Fable 5.1 / Opus 5.5 裸 id 本身就是 1M（见上），
    // 不必进这张表——to1M 原样放行即可。
    oneM: ['claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-5-5', 'claude-sonnet-5'],
    // fast mode 支持的模型（官方口径 Opus 5.5/5/4.8/4.7；SDK 0.3.220 起 settings.fastMode
    // 可点亮，2026-07-30 probe 实测 fast_mode_state=on，Opus 5.5 于 09-22 实测 on）。前端模型菜单
    // 据此显隐 ⚡ 开关，后端 runClaudeChat 据此决定是否注入 settings。
    fast: ['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7'],
    // 「没选 effort」时实际跑的档位（bridge 不传 effort，由 CLI 按内置模型目录 default_effort 取；
    // 09-22 探针 Stop hook 实测 Opus 5.5=medium、Opus 4.7=xhigh）。表外一律 high。前端芯片/拉条的
    // 默认高亮读它，否则选 Opus 5.5 不动 effort 会恒显「已选 High，实际 Medium」。注意 admin 会话
    // 读 ~/.claude/settings.json，其 modelSettings.<id>.effortLevel（桌面端 /effort 按模型存）会盖过它。
    effortDefaults: { 'claude-opus-5-5': 'medium', 'claude-opus-4-7': 'xhigh' },
    efforts: [
      { id: 'low', name: 'Low' },
      { id: 'medium', name: 'Medium' },
      { id: 'high', name: 'High' },
      // 显示名叫「Extra」而不是官方的「Extra high」：档名要直接印在输入栏芯片上，
      // 窄屏（折叠屏分屏、桌面小窗）最长的这一档是把整行挤爆的元凶。id 不动。
      { id: 'xhigh', name: 'Extra' },
      { id: 'max', name: 'Max' },
      // Ultracode（2026-09-02）：官方 /code 页的末档 = xhigh + 常驻动态工作流编排（Workflow 工具）。
      // 【不是】SDK effort 的合法取值（TS 只列五档）——后端经 claudeEffortOptions 翻译成
      // effort:'xhigh' + settings {ultracode:true, enableWorkflows:true}；实况由 result 后 getSettings()
      // 的 applied.ultracode 定（Stop hook 只能回 xhigh）。放末尾 = EffortPanel 的紫色 accent 位。
      { id: 'ultracode', name: 'Ultracode' },
    ],
    // 「没主动选模型」这一档的唯一真相。前端芯片/picker 高亮读它，后端 MODEL 也回落到它
    // （config.json 的 model 若留空就走这里）。2026-07-25 前这两边各写各的字面量，导致
    // 芯片显示 Opus 5、实际却按 config.json 跑 Opus 4.8——加新模型时只改这一行。
    // 2026-09-22 起 Opus 5.5（CLI 2.1.280 的 opus 别名同日切到它）。
    defaults: { model: 'claude-opus-5-5' },
  },
};

const ids = (list) => list.map((x) => x.id);
const idSet = (list) => new Set(ids(list));

// 白名单 = picker 里的裸 id + 1M 兄弟档 id（旧客户端/收藏的会话可能还发 [1m]，别 400）。
export const CLAUDE_MODELS = new Set([
  ...ids(CAPABILITIES.claude.models),
  ...CAPABILITIES.claude.oneM.map((id) => id + '[1m]'),
]);
export const CLAUDE_EFFORTS = idSet(CAPABILITIES.claude.efforts);
export const ULTRACODE = 'ultracode';
// effort 档位 → SDK query 选项。ultracode 翻译成 xhigh + settings（调用方把 settings 与 fastMode 合并后
// JSON.stringify 成一份 settings 字面量；enableWorkflows 显式开是因为 Pro 计划默认关）；其余档位原样；空 → {}。
export function claudeEffortOptions(effort) {
  if (!effort) return {};
  if (effort === ULTRACODE) return { effort: 'xhigh', settings: { ultracode: true, enableWorkflows: true } };
  return { effort };
}
// 未指定模型时的默认（config/index.mjs 的 MODEL 与前端芯片共用同一个值）。
export const CLAUDE_MODEL_DEFAULT = CAPABILITIES.claude.defaults.model;
// 1M 归一：支持 1M 的裸 id → [1m] 兄弟档；已带 [1m] 或不支持的原样返回。
const ONE_M = new Set(CAPABILITIES.claude.oneM);
export const to1M = (model) => (model && ONE_M.has(model) ? model + '[1m]' : model);
// fast mode 支持判定（按裸 id；默认模型也算——未指定模型时 fall 到 defaults.model）。
const FAST_SET = new Set(CAPABILITIES.claude.fast);
export const claudeSupportsFast = (model) => FAST_SET.has(String(model || CAPABILITIES.claude.defaults.model).replace(/\[1m\]$/, ''));
// 不传 effort 时该模型实际跑的档位（按裸 id；未指定模型按 defaults.model）。前端传入 caps 数据以跟随后端。
export const claudeDefaultEffort = (model, caps = CAPABILITIES) => {
  const c = (caps && caps.claude) || CAPABILITIES.claude;
  const id = String(model || c.defaults.model).replace(/\[1m\]$/, '');
  return (c.effortDefaults || {})[id] || 'high';
};
