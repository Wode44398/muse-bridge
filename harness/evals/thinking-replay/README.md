# 思考参数与历史思考回传体检（2026-11-17）

模型中心里每条 OpenAI 协议线路 × 主要型号，测两件事：

1. **回传**：工具循环里（同一条用户请求下：先思考 → 调工具 → 拿到结果接着答），把上一步的思考按哪种写法放回 assistant 消息，模型才真的用得上。
2. **参数**：百炼（DashScope）这个服务里托管的别家型号（Kimi、GLM、DeepSeek）认哪些思考参数。

## 测法

`loop-replay.py`：第一步让模型**只在思考里**想一个六位数、正文不写，先调 `roll_dice`；第二步把它**自己第一步的思考**按五种写法放回去，带上工具结果，让它说出那个数。第一步思考里有六位数、正文与工具参数里没有，才算有效样本；同一个第一步分给五种写法，写法之间可比。两个指标：

- **吃进**：第二步的 `prompt_tokens` 比「不回传」多出 15 以上 = 上游真把回传的思考放进了上下文（客观，不受模型「随机数」撞车影响）；
- **命中**：第二步答出的数在第一步思考里出现过。

GPT-6 / Gemini / Muse 在 OpenRouter 上只给加密推理（`reasoning_details` 里的 `reasoning.encrypted`），看不到原文，只看「吃进」。

`CROSS=1` 跑跨用户消息版（工具结果后再插一轮 assistant 正文和新的用户追问），看上一条用户消息之前的思考会不会被服务端丢掉。父会话早先用「注入一段假思考」的测法，Qwen4 在工具循环里一律 0/4——模型不信那段不是自己写的思考，测法有偏差，结论以这里为准。

用法（Key 从 `plugin-providers.json` 读、不打印；共用服务走本机网关地址，不用 Key）：

```
python -I loop-replay.py <plugin-providers.json> out.jsonl 4            # 每格第一步 4 次
EXTRA_CELLS=cells2.json CROSS=1 python -I loop-replay.py <…> cross.jsonl 3
python summarize.py out.jsonl
python -I dashscope-params.py <plugin-providers.json> ds.jsonl 2
```

## 结果：工具循环里的回传

| 线路 | 型号 | 有效 | 不回传 | reasoning_content | reasoning | +preserve_thinking | reasoning_details |
|---|---|---|---|---|---|---|---|
| 百炼 | qwen4-max | 6/7 | 命中 0/6 | 吃进 6/6 · 命中 6/6 | 吃进 0/6 | 吃进 6/6 · 命中 6/6 | 吃进 0/6 |
| 百炼 | qwen3.8-max | 3/3 | 0/3 | 吃进 3/3 · 2/3 | 0/3 | 吃进 3/3 · 3/3 | 0/3 |
| 百炼 | qwen3.8-flash | 3/3 | 0/3 | 吃进 3/3 · 2/3 | 0/3 | 吃进 3/3 · 3/3 | 0/3 |
| 百炼 | qwen3.7-plus | 1/3 | 0/1 | 吃进 1/1 · 1/1 | 0/1 | 吃进 1/1 · 1/1 | 0/1 |
| 百炼 | kimi-k3.1-pro | 7/7 | 0/7 | 吃进 7/7 · 7/7 | 0/7 | 吃进 7/7 · 7/7 | 0/7 |
| 百炼 | glm-5.3 | 6/7 | 0/6 | 吃进 6/6 · 6/6 | 0/6 | 吃进 6/6 · 6/6 | 0/6 |
| 百炼 | glm-5.3-prime | 1/4 | 0/1 | 吃进 1/1 · 1/1 | 0/1 | 吃进 1/1 · 1/1 | 0/1 |
| 百炼 | deepseek-v4.1-flash-1017 | 7/7 | 0/7 | 吃进 7/7 · 6/7 | 0/7 | 吃进 7/7 · 5/7 | 0/7 |
| OpenRouter | deepseek/deepseek-v4.1-flash | 4/4 | 0/4 | 吃进 4/4 · 4/4 | 4/4 · 4/4 | 4/4 · 4/4 | 4/4 · 4/4 |
| OpenRouter | moonshotai/kimi-k3.1-pro | 2/4 | 0/2 | 2/2 · 2/2 | 2/2 · 2/2 | 2/2 · 2/2 | 2/2 · 2/2 |
| OpenRouter | qwen/qwen3.8-max-0902 | 2/4 | 0/2 | 2/2 · 1/2 | 2/2 · 2/2 | 2/2 · 2/2 | 2/2 · 2/2 |
| OpenRouter | z-ai/glm-5.3 | 4/4 | 0/4 | 4/4 · 4/4 | 4/4 · 4/4 | 4/4 · 4/4 | 4/4 · 4/4 |
| OpenRouter | tencent/hy4 | 3/4 | 0/3 | 3/3 · 2/3 | 3/3 · 3/3 | 3/3 · 3/3 | 3/3 · 3/3 |
| OpenRouter | mistralai/mistral-large-4-0 | 4/4 | 1/4（撞数） | 4/4 · 4/4 | 4/4 · 4/4 | 4/4 · 4/4 | 4/4 · 4/4 |
| OpenRouter | openai/gpt-6.1-sol | 4/4 | — | 吃进 0/4 | 0/4 | 0/4 | **吃进 4/4** |
| OpenRouter | openai/gpt-6-astra | 4/4 | — | 0/4 | 0/4 | 0/4 | **4/4** |
| OpenRouter | openai/gpt-6.1-terra | 3/4 | — | 0/3 | 0/3 | 0/3 | **3/3** |
| OpenRouter | google/gemini-4-argon | 4/4 | — | 0/4 | 0/4 | 0/4 | **4/4** |
| OpenRouter | meta/muse-spark-1.3 | 3/4 | — | 0/3 | 0/3 | 0/3 | **3/3** |
| OpenRouter | x-ai/grok-4.7 | 4/4 | — | 0/4 | 0/4 | 0/4 | **4/4** |
| OpenRouter | anthropic/claude-opus-5.5 | 0/10 | adaptive 思考判定这题不用想（推理 0 token），拿不到样本，未验证 | | | | |
| fp8 自建 | qwen3.8-flash-next-fp8 | 3/4 | 0/3 | 3/3 · 3/3 | 3/3 · 3/3 | 3/3 · 3/3 | 0/3 |
| Kimi 直连 | k3.1-pro | 0/4 | 订阅 5 小时窗口 429，没测（行为本来就回传，未改） | | | | |

DeepSeek 直连、小米 MiMo 直连在模型中心里登记的是 Anthropic 协议（思考块原样保留），不在这张表的范围。

**跨用户消息**（`CROSS=1`，百炼）：Qwen3.7 Plus 不带 `preserve_thinking` 时上一条用户消息之前的思考被丢掉（吃进 0/3），带上 3/3；Qwen4 / 3.8、Kimi、GLM、DeepSeek 带不带都吃进。

## 结果：百炼上托管的别家型号认哪些参数

| 型号 | 不发 | enable_thinking:false | reasoning_effort low / max | none | thinking.type disabled | thinking_budget | enable_search + 工具 |
|---|---|---|---|---|---|---|---|
| qwen4-max | 思考 | 真关 | 生效 | 真关 | 真关 | 收 | 收 |
| kimi-k3.1-pro | 思考 | **真关** | 生效 | 真关 | 真关 | **400 不支持** | 收 |
| glm-5.3 / -prime | 思考 | **400** | 生效（只收 low/high/max） | 400 | **400** | 收（无效果） | **400 不支持** |
| deepseek-v4.1-flash-1017 | 思考 | 真关 | 生效（max 与 high 差不多） | 真关 | 真关 | 收 | 收 |

`kimi/kimi-k3.1-pro-highspeed`、`ZHIPU/GLM-5.3`、`ZHIPU/GLM-5.3-FlashX`、`vanchin/deepseek-v4.1-flash-1017`、MiniMax、小米：账号没开通（400 The product is not activated），不是代码问题。

**改之前 dimensio 在百炼上的实际请求**（适配器本地生成请求体 + 真打对照）：所有型号都走 Qwen 分支——Kimi 开思考发 `thinking_budget`（400），GLM 带工具发 `enable_search`（主循环每轮 400）、关思考发 `enable_thinking:false`（400）；除 DeepSeek 外都不回传思考。改后五个型号 × 关 / 低 / 高三档的工具循环全部 200、回传生效。

## 据此做的改动

- 型号知识层：`routeOf` 认出百炼；`replayOf(id, { route })` 按型号 × 线路给回传写法（`reasoning_content`）和这条线路要多带的参数（百炼上的 Qwen 带 `preserve_thinking:true`）；Kimi、MiMo、GLM-5.3、Qwen4 / 3.8 / 3.7 标回传，混元 Hy4、Mistral Large 4 只在 OpenRouter 上回传；百炼上的 Kimi 档位改成「`enable_thinking:false` 关闭 + `reasoning_effort` low / high / max」、不再当恒思考。
- dimensio：回传按型号 × 线路为主、厂商 id 只兜底表里没有的型号；自带厂商服务里托管的别家型号按模型中心给的档位表发（没给就按型号表现算），菜单档位也照它；模型中心的调用参数与兼容项（回传推理、输出上限字段）对自带厂商同样生效。
- Claude 分页：回传与 `preserve_thinking` 同样按线路。

## 没做

- **OpenRouter 上 GPT-6 / Gemini / Muse / Grok 的 `reasoning_details` 回传**：只认加密推理，`reasoning_content` 回传对它们无效。要做得两边都改：dimensio 从流里收 `reasoning_details` 存进思考块（换型号时不能带给别家）、Claude 本机代理把它塞进思考块的 signature 再还原。
- Claude 经 OpenRouter 的签名思考回传：没拿到样本。
- 智谱直连的 GLM-5.3 回传按官方「保留式思考」打开了，但这把 Key 调不了 5.3（1113），没实测。
