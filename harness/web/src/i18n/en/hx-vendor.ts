// 「模型服务」自定义服务编辑器（components/shell/vendor/*、VendorSheet、ModelMenu、Composer 胶囊）的英文。
// 和 bridge 的 Claude 外接编辑器同名的键沿用 web/src/i18n/en/claude-providers.js 的译法（两边字典嵌进 bridge 时合成一份）。
export default {
  // ── 编辑器外壳 ──
  "模型服务::连接": "Connection",
  "型号 · {n}": "Models · {n}",
  "编辑分区": "Editor section",
  "正在读取…": "Loading…",
  "OpenAI / Anthropic / Gemini 接口": "OpenAI / Anthropic / Gemini APIs",
  "先填接口地址": "Enter a base URL first",
  "先填 API Key": "Enter an API key first",
  "至少启用一个对话型号": "Turn on at least one chat model",
  "有改动没保存": "Unsaved changes",
  "已保存，但测试默认型号失败：{e}": "Saved, but testing the default model failed: {e}",

  // ── 连接 ──
  "备注": "Note",
  "接口协议": "API protocol",
  "兼容 Anthropic Messages 的接口（…/anthropic、中转的 Claude 接口）：思考按 thinking / output_config 写":
    "Anthropic Messages–compatible APIs (…/anthropic, Claude relays): thinking goes into thinking / output_config",
  "Gemini 原生接口（generateContent）：思考写在 generationConfig.thinkingConfig": "Native Gemini API (generateContent): thinking goes into generationConfig.thinkingConfig",
  "兼容 OpenAI Chat Completions 的接口：中转站、OpenRouter、自己部署的 vLLM / Ollama……":
    "OpenAI Chat Completions–compatible APIs: relays, OpenRouter, your own vLLM / Ollama…",
  "换了协议：{names} 的思考档位是按原协议写的（手动设的或探测出来的），不会自动换。建议展开这些型号点「探测能力」，或在档位里用「一键填入」重设。":
    "Protocol changed: the thinking tiers of {names} were written for the old protocol (set by hand or found by probing) and won’t change automatically. Expand those models and tap “Probe capabilities”, or reset the tiers with a preset.",
  "知道了": "Got it",
  "实际请求 {url}": "Requests go to {url}",
  "这个站的 …/v1 只有 OpenAI 兼容接口，按 Anthropic 协议请求会 404（每条消息都报错）。":
    "This site’s …/v1 is OpenAI-compatible only; Anthropic-protocol requests will get a 404 (every message fails).",
  "有的服务 …/v1 下只有 OpenAI 兼容接口（按 Anthropic 协议请求会 404）；中转站的 …/v1 多半两种都有。不确定就点「检测连接」。":
    "Some services offer only an OpenAI-compatible API under …/v1 (Anthropic-protocol requests get a 404); most relays serve both there. If you’re not sure, tap “Check connection”.",
  "以 /anthropic 结尾的多半是 Anthropic 兼容地址，按 OpenAI 协议请求会 404。": "URLs ending in /anthropic are usually Anthropic-compatible; OpenAI-protocol requests will get a 404.",
  "这个地址和协议对不上：Google 的 …/v1beta 是 Gemini 原生接口，…/v1beta/openai 才是 OpenAI 兼容接口。":
    "This URL doesn’t match the protocol: Google’s …/v1beta is the native Gemini API; …/v1beta/openai is the OpenAI-compatible one.",
  "改用 {p} 协议": "Switch to {p}",
  "改成 {url}": "Change to {url}",
  "检测连接": "Check connection",
  "用这把 Key 在这个地址和同站的兄弟地址上，各种协议各真打一次，看哪个组合能通":
    "Sends one real request per protocol to this URL and its sibling URLs on the same host with this key, to see which combination works",
  "当前配置能通": "The current settings work",
  "当前配置不通；建议改成": "The current settings don’t work; suggested:",
  "一键应用": "Apply",
  "没有找到能通的组合：检查地址、Key 和网络": "No working combination found — check the URL, key and network",
  "地址和协议是对的，但型号「{model}」这里没有：在「型号」里换一个或刷新型号": "The URL and protocol are right, but model “{model}” isn’t available here: pick another one or refresh the models",
  "地址和协议是对的，但 Key 被拒：检查 Key 和鉴权方式": "The URL and protocol are right, but the key was rejected: check the key and authentication",
  "每个组合的结果": "Results for each combination",
  "用这个": "Use this",
  "更换": "Replace",
  "这个服务不需要 Key": "This service doesn’t need a key",
  "鉴权方式": "Authentication",
  "不需要": "None",
  "更多设置": "More settings",
  "请求头": "Request headers",
  "中转站要的额外请求头（鉴权头由 dimensio 自己管）": "Extra headers a relay needs (dimensio manages the auth header itself)",
  "请求头名": "Header name",
  "值": "Value",
  "添加请求头": "Add header",
  "输出上限字段": "Max tokens field",
  "OpenAI 自家的推理模型要用 max_completion_tokens": "OpenAI’s own reasoning models need max_completion_tokens",
  "回传思考内容": "Send back reasoning",
  "工具续轮把上一轮的思考原文带回去（reasoning_content）；标了「不发参数也会思考」的型号总会回传":
    "Sends the previous turn’s reasoning back on tool follow-ups (reasoning_content); models marked “Thinks without being asked” always do",
  "提示缓存": "Prompt caching",
  "服务支持 Anthropic 式 cache_control 才开；第三方多半不认，有的直接报错":
    "Turn on only if the service supports Anthropic-style cache_control; most third parties don’t, and some reject it",

  // ── 型号 ──
  "★ 是这家的默认型号（第一次切过来用它、测试也用它）。能力前面带「≈」的是猜的，展开型号可以「探测能力」真打一次核实。":
    "★ marks this provider’s default model (used when you first switch to it, and for tests). Capabilities marked “≈” are guesses; expand a model and tap “Probe capabilities” to check with a real request.",
  "刷新型号": "Refresh models",
  "从服务拉取": "Fetch from service",
  "端点上的型号都已经添加过了": "All models on the endpoint have already been added",
  "搜索型号": "Search models",
  "接口列出了 {n} 个新型号": { one: "The endpoint lists 1 new model", other: "The endpoint lists {n} new models" },
  "全选": "Select all",
  "语音识别 / 合成、向量这类：默认不勾，加进来也不进模型菜单": "Speech recognition / synthesis, embeddings and the like: unchecked by default, and kept out of the model menu even if added",
  "非对话": "Non-chat",
  "视觉": "Vision",
  "思考": "Thinking",
  "添加 {n} 个": "Add {n}",
  "接口一共列出 {total} 个型号，这里只列了前 {n} 个；没列出来的可以在下面手动添加型号 ID。":
    "The endpoint lists {total} models; only the first {n} are shown here. Add any others by model ID below.",
  "一个服务最多 {max} 个型号：已有 {have} 个，这次最多再加 {left} 个，请少勾一些。":
    "A provider can have up to {max} models: {have} already added, so you can add at most {left} more. Select fewer.",
  "一个服务最多 {max} 个型号：先删掉一些再加。": "A provider can have up to {max} models. Remove some before adding more.",
  "「{model}」的思考档位有问题：展开这个型号看看": "The thinking tiers of “{model}” have a problem: expand the model to see",
  "还没有型号。先填好连接再「从服务拉取」，或在下面手动添加型号 ID；也可以直接保存，服务端会自己拉。":
    "No models yet. Fill in the connection and tap “Fetch from service”, add a model ID by hand below, or just save and the server will fetch them.",
  "型号 ID": "Model ID",
  "型号 ID，比如 deepseek-chat": "Model ID, e.g. deepseek-chat",
  "手动添加": "Add",
  "启用": "Enable",
  "语音识别 / 合成、向量这类：不进模型菜单": "Speech, embeddings and the like: kept out of the model menu",
  "上下文窗口": "Context window",
  "不发参数也会思考": "Thinks without being asked",
  "自带思考": "Always thinks",
  "设为默认型号": "Set as default model",
  "展开": "Expand",
  "显示名": "Display name",
  "输出上限": "Max output",
  "支持图片": "Accepts images",
  "截图和附件原样发给这个型号": "Screenshots and attachments are sent to this model as-is",
  "图片换成文字说明，或交给辅助视觉模型": "Images are replaced with a note or handed to the helper vision model",
  "支持视频": "Accepts video",
  "视频附件原样发给这个型号": "Video attachments are sent to this model as-is",
  "视频附件不直接发给这个型号": "Video attachments aren’t sent to this model directly",
  "支持音频": "Accepts audio",
  "音频附件原样发给这个型号": "Audio attachments are sent to this model as-is",
  "音频附件不直接发给这个型号": "Audio attachments aren’t sent to this model directly",
  "对话模型": "Chat model",
  "出现在模型菜单里": "Appears in the model menu",
  "探测能力": "Probe capabilities",
  "真打几次（各一两句话）：读输出上限、看图、默认会不会思考、每一档端点认不认":
    "Sends a few tiny real requests: reads the max output, checks image input, whether it thinks by default, and whether each tier is accepted",
  "已应用": "Applied",
  "应用到这个型号": "Apply to this model",
  "移除这个型号": "Remove this model",
  "档位 {id}：认，思考了": "Tier {id}: accepted, thought",
  "档位 {id}：认，没思考": "Tier {id}: accepted, didn’t think",
  "档位 {id}：认": "Tier {id}: accepted",
  "档位 {id}：不认（{e}）": "Tier {id}: rejected ({e})",

  // ── 思考档位 ──
  "思考方式": "Thinking style",
  "不思考": "None",
  "预算": "Budget",
  "自适应": "Adaptive",
  "档位": "Tiers",
  "Anthropic 式 thinking.budget_tokens：发送值写预算 token 数，留空按 16000 的基准换算；关闭档不开思考":
    "Anthropic-style thinking.budget_tokens: the value is the budget in tokens; leave it empty to scale from a 16000 base; an off tier doesn’t turn thinking on",
  "thinking.type = adaptive：发送值写 output_config.effort（如 high），留空只开自适应":
    "thinking.type = adaptive: the value goes into output_config.effort (e.g. high); leave it empty to only turn on adaptive thinking",
  "每档的发送值写进写入字段；值是 JSON 对象且字段留空时，整个并进请求体":
    "Each tier’s value goes into the target field; when the value is a JSON object and the field is empty, it’s merged into the request body",
  "不发思考参数；自带思考的模型照样会想。输入框里不显示思考深度。": "Sends no thinking parameter; models that always think still will. No thinking level is shown in the composer.",
  "档名": "Name",
  "发送值": "Value sent",
  "留空 = 不发": "Empty = send nothing",
  "上移": "Move up",
  "第 {n} 档": "Tier {n}",
  "加一档": "Add a tier",
  "一键填入": "Presets",
  "写入字段": "Target field",
  "首次选中用哪档": "Tier when first picked",
  "按默认规则": "Default rule",
  "小米、Kimi、GLM-5.3 这类：工具续轮回传思考原文（reasoning_content）；输入框胶囊在关不掉时写「模型自带思考」":
    "Like Xiaomi, Kimi and GLM-5.3: reasoning is sent back on tool follow-ups (reasoning_content), and the composer pill shows “Model always thinks” when it can’t be turned off",
  "dimensio 只有 7 级思考档（关闭档以外最多 6 档）：{ids} 放不进去，模型菜单里选不到。删掉几档，或把档位 ID 改成 off / minimal / low / medium / high / xhigh / max。":
    "dimensio has only 7 thinking levels (at most 6 besides off): {ids} don’t fit and can’t be picked in the model menu. Remove some tiers, or change their IDs to off / minimal / low / medium / high / xhigh / max.",

  // ── 测试 ──
  "用编辑中的配置测试（还没保存）。": "Tests use the settings being edited (not saved yet).",
  "真发一句「只回复 OK」，看通不通、多快、有没有思考。": "Sends “reply only OK” for real to see whether it works, how fast, and whether it thinks.",
  "测试用的型号": "Model to test",
  "发送测试": "Send test",
  "连通": "Connected",
  "含思考": "With thinking",
  "输入 {i} · 输出 {o}": "In {i} · Out {o}",
  "（回复为空）": "(Empty reply)",

  // ── 模型菜单 / 胶囊 ──
  "会思考": "Thinks",
  "没有匹配的型号": "No matching models",
  "模型自带思考": "Model always thinks",

  // ── 共用模块（src/model-knowledge）回的运行时文案（tr() 整句翻译）──
  "默认": "Default",
  "OpenAI 三档": "OpenAI three tiers",
  "Anthropic 五档": "Anthropic five tiers",
  "开 / 关": "On / off",
  "通了": "Works",
  "接口在，模型名不对": "Endpoint exists, wrong model name",
  "接口在，Key 被拒": "Endpoint exists, key rejected",
  "这里没有接口": "No endpoint here",
  "报错": "Error",
  "连不上": "Unreachable",
  "端点返回的": "Reported by the endpoint",
  "探测出来的": "Found by probing",
  "手动填的": "Entered manually",
  "内置型号表里的（未经这个端点证实）": "From the built-in model table (not confirmed by this endpoint)",
  "按型号名猜的": "Guessed from the model name",
  "不知道，用的默认值": "Unknown — using the default",
  "档位 ID「{id}」不合法（小写字母数字与 _ -，最长 24）": "Tier ID “{id}” is invalid (lowercase letters, digits, _ and -, up to 24)",
  "档位「{id}」重复了": "Tier “{id}” is duplicated",
  "档位最多 {n} 个": "Up to {n} tiers",
  "写入字段「{f}」不合法（点分路径，如 reasoning_effort）": "Target field “{f}” is invalid (use a dotted path such as reasoning_effort)",
  // 多用户：管理员共享给成员
  "已共享": "Shared",
  "共享给成员": "Share with members",
  "这台服务器上的成员也能用这个服务，用量记在这把 Key 上；他们看不到地址和 Key，也改不了":
    "Members on this server can use this provider too, billed to this key. They can’t see or change the address or key.",
};
