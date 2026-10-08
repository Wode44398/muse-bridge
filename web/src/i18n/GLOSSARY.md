# The Bridge — English glossary and style guide

This file is **binding** for everyone who writes English UI strings for The Bridge (bridge `web/src`
and dimensio `harness/web/src`). Code mechanics (`t()` / `tc()` / `tr()`, dictionary files, the
checker) are in `GUIDE.md` next to this file — read that first; nothing here repeats it.

How to use this file:

1. Find the Chinese term in §4 (term tables) or the sentence shape in §6 (patterns).
2. Use the **English** column. It is the canonical value for the plain key `t('中文')`.
3. Use a **context variant** only on the surface named in the variants column, through
   `tc('<context>', '中文')` with one of the context ids in §1.15. Never invent a different plain
   translation for a key that already exists — the checker reports it as a conflict.
4. If a term is missing, pick the wording the page’s reference product uses (§3), follow the
   rules in §1, and add a row here in the same commit.

Evidence shorthand used below: **Claude** = Claude desktop / claude.ai / Claude Code English UI;
**OpenAI** = ChatGPT / Codex app English UI (reverse of its zh-CN bundle, shown as `中文→English`);
**Google** = Vertex AI Studio / Gemini; **Apple** = iOS 26 / macOS Tahoe; **Windows** = Windows 11 /
File Explorer; **Android** = stock Android settings; **Obsidian** = Obsidian app; **coined** = our own.

---

## 1. Style guide

### 1.1 Voice and tone

- **Direct, calm, second person.** Talk to the user as “you”; talk about the agent by name
  (“Claude”, “Codex”) or as “the agent”. Never “we”, never “the user”.
  - 需要你批准 → “Needs your approval” (not “User approval required”)
  - 它问了你一个问题 → “Claude asked you a question”
- **No exclamation marks.** Not in success toasts, not in greetings.
  - 收到，谢谢！反馈已经记下了。 → “Thanks. Your feedback has been sent.”
- **No “please”** except when we genuinely ask a favour the app can’t do itself (rare).
  请重试 → “Try again”. 请先登录 → “Sign in first”. 请在系统设置里允许… → “Allow … in Settings”.
- **Plain verbs over jargon.** The Chinese UI is chatty and colloquial (跑、挂着、碰不到、没成); English
  is neutral and short. Translate the meaning, not the slang (§1.14).
  - 在跑 → “Running”; 没删成 → “Couldn’t delete”; agent 碰不到这台电脑 → “Agents can’t access this computer”
- **Don’t blame the user**, don’t apologise (“Sorry” is not used), don’t anthropomorphise the app.
- **State the consequence, then the fix.** “Can’t reach the server. Check your connection settings.”
- **Keep technical words the owner actually sees in products**: “token”, “context”, “compact”,
  “prompt”, “provider”, “endpoint”. Don’t over-simplify them.

### 1.2 Capitalization — sentence case everywhere

Buttons, menu items, tabs, chips, section titles, dialog titles, table headers, tooltips, aria labels
and settings rows all use **sentence case**: capitalize the first word and proper nouns only.

| Right | Wrong |
|---|---|
| New chat | New Chat |
| Show in File Explorer | Show In File Explorer |
| Sign in with QR code | Sign In With QR Code |
| Manage memory | Manage Memory |
| Admin console → Users | Admin Console → Users |

Proper nouns and official feature names keep their capitals: Claude, Claude Code, ChatGPT, Codex,
Gemini, Vertex AI, Veo, Imagen, Lyria, Antigravity, Obsidian, Windows, Android, File Explorer,
Recycle Bin, Task Scheduler, Cloudflare Tunnel, Liquid Glass, Live Preview (Obsidian),
Quick Ask, Local Agent, Bridge Keyboard, UI Automation, Wi‑Fi, LAN, QR code, API key, URL, PDF, ZIP.
**dimensio is always lowercase**, even at the start of a label (“dimensio · Done”).
“agent” is a common noun: lowercase mid-sentence (“Waiting for agents to start”), capital only as
the first word of a label (“Agent browser”).

After a colon inside a label, continue in lowercase unless a proper noun or a full sentence follows:
“Mode: plan first”, but “Offline: can’t reach your computer. Messages can’t be sent.”

### 1.3 Punctuation

| Rule | Example |
|---|---|
| Curly apostrophe ’ (never `'`) | Couldn’t, can’t, Claude’s, you’re |
| Curly double quotes “ ” around names and quoted text | Delete “{name}”? |
| Chinese 「X」『X』 around a UI element or item name → “X” | 点「重试」 → Tap “Try again” |
| Navigation paths: `→`, no quotes | 设置→通用→语言 → Settings → General → Language |
| Single ellipsis character … (never `...`), no space before | Loading…, Save as…, Move to… |
| Em dash — **without spaces**, only for an aside inside one sentence. Two statements → two sentences with periods; label + detail → colon | Scanned. Confirm on your phone. (not “Scanned—confirm…”) |
| Middle dot · with spaces, kept where the Chinese uses it | Goal · Turn 2/5 |
| En dash – for ranges | About 1–2 min |
| Chinese colon ： → `: `; Chinese comma ，→ `, `; 。→ `.`; （）→ ` ( )` | 模型：{m} → Model: {m} |
| No Chinese punctuation or full-width characters in English values | (checker flags them) |
| Keep ＋ only where the Chinese uses it as a glyph on a button | ＋ New |
| Serial (Oxford) comma in every list of three or more, with “and” or “or” (Anthropic, OpenAI, Google and Apple all use it) | Files, uploads, and sharing; Ctrl, Alt, or Shift |

Ellipsis has exactly two uses: (1) an **in-progress** label (“Uploading…”, “Thinking…”);
(2) a **command that opens a dialog or picker needing more input** (“Rename…”, “Move to…”,
“Open with…”, “Import files…”, “Switch provider…”). Plain immediate actions get no ellipsis
(“Delete”, “Copy link”). Placeholders that invite typing also end with … (“Reply…”, “Ask anything”
is the exception because OpenAI writes it that way).

### 1.4 Periods and sentence endings

- **No period** on buttons, menu items, tabs, chips, titles, table cells, column headers,
  single-fragment toasts and single-fragment descriptions: “Copied”, “Saved to Downloads”,
  “Skills · Connectors · Plugins”, “Runs quietly in the system tray”.
- **Period** on anything that is a full sentence in a description, hint, footnote, dialog body or
  banner, and on **every** sentence of a multi-sentence string:
  “Couldn’t delete. Try again.” / “This can’t be undone.” / “Changes take effect immediately.”
- Questions end with “?” — confirmation titles always do (§1.6).
- Never end with “…” just to sound soft.

### 1.5 Errors

Choose by what the Chinese describes:

| Chinese shape | English | Example |
|---|---|---|
| An action the user tried: 无法X / X失败（动作） / 没X成 | `Couldn’t {verb}` | 重命名失败 → Couldn’t rename |
| …with a reason | `Couldn’t {verb}: {reason}` | 删除失败：{r} → Couldn’t delete: {r} |
| …with a remedy | `Couldn’t {verb}. {Remedy}.` | 保存失败，请重试 → Couldn’t save. Try again. |
| A status label / noun: 上传失败 in a list, 连接失败 badge | `{Noun} failed` | Upload failed; Connection failed; Sign-in failed |
| A standing inability (not an attempt) | `Can’t {verb}` | 当前无法回滚 → Can’t rewind right now |
| Unreachable target | `Can’t reach {target}` | 连不上服务器 → Can’t reach the server |
| Unknown failure | Something went wrong | 出错了 → Something went wrong |

Rules: “Couldn’t” for an attempt that failed, “Can’t” for a state that blocks. Never “Error:
Failed to …”, never “Oops”. Put `{reason}` last after a colon; don’t wrap it in quotes. Use
“Failed to …” only in text that is clearly log/debug output.

### 1.6 Confirmations

- Title = the action as a question: `{Verb} {object}?` — “Delete “{name}”?”, “Stop the main service?”,
  “Revoke admin sign-in on this device?”, “Leave with unsaved changes?”
- Body = the consequence, full sentences: “All its files will be deleted. This can’t be undone.”
- **The confirming button repeats the verb** (“Delete”, “Stop”, “Revoke”, “Sign out”), never “OK”,
  “Yes” or “Confirm delete”. The other button is “Cancel”. 确认删除 → Delete; 确认停止 → Stop.
- Reassurance lines: 不会删除电脑上的文件 → “Files on your computer won’t be deleted.”
- Two-step inline buttons: 再点一次删除 → “Tap again to delete” (see §1.12 for tap/click).

### 1.7 Empty states

- 还没有 X → “No {things} yet” (“No files yet”, “No routines yet”, “No memories yet”).
- 没有 X / 暂无 X (a filter or search result, not a “yet” situation) → “No {things}”
  (“No matching chats”, “No transfers”).
- Optional second line tells the user how to fill it, as a full sentence:
  “No routines yet. Tap ＋ New to create one.”
- Bare 暂无 / 无 in a cell → “None”.

### 1.8 Progress, status and results

| Chinese | English |
|---|---|
| 正在X… / X中… | `{Verb}ing…` — Loading…, Saving…, Uploading… {n}%, Compacting… |
| 已X (done state or toast) | past participle — Saved, Copied, Deleted, Uploaded, Rewound |
| 已X {n} 项 | `{Verb}ed {n} items` — Imported 3 items |
| 运行中 / 已停止 / 未启动 / 就绪 / 出错 | Running / Stopped / Not started / Ready / Error |
| 已开启 / 已关闭 (a toggle’s state) | On / Off (never “Opened/Closed”) |
| 已启用 / 已禁用 (an extension, connector, agent badge) | Enabled / Disabled |
| 已完成 (task/run status) | Completed; as a toast or short chip: Done |
| 已取消 | Canceled (en-US, one L, everywhere) |
| 已过期 / 已失效 (link, code) | Expired |

Status chips never end with a period or ellipsis unless the thing is actively in progress.

### 1.9 Time and dates

Two styles, chosen by density:

| | Compact (lists, chips, sidebars, tables) | Full (sentences, tooltips, cards) |
|---|---|---|
| < 1 min | Now | Just now |
| minutes | 5m ago | 5 min ago |
| hours | 3h ago | 3 hr ago |
| 1 day | Yesterday | Yesterday |
| 2–6 days | 4d ago | 4 days ago |
| ≥ 7 days, same year | Sep 28 | Sep 28 |
| other year | Sep 28, 2025 | Sep 28, 2025 |
| durations | 12s · 5m 3s · 2h 15m | 12 sec · 5 min 3 sec · 2 hr 15 min |
| countdown | 4m 10s left | Resets in 2 hr 15 min |

- Clock times: 12-hour en-US with `Intl.DateTimeFormat('en-US')` (“3:04 PM”, “Sep 28, 2026, 3:04 PM”).
  Never concatenate date parts by hand.
- Weekdays: Mon Tue Wed Thu Fri Sat Sun (short); Monday … (full). 周{d} {hh}:{mm} 重置 → “Resets Mon 3:00 PM”.
- Periods: 5 小时窗口 → “5-hour window”, 7 天窗口 → “7-day window” (hyphenated adjective).
- Don’t use `Intl.RelativeTimeFormat` short style (it yields “5 min. ago” with a period); use the
  dictionary plural templates above.

### 1.10 Counts and plurals

- English has no measure words. 条/个/次/项/台/张/轮/字 disappear; name the noun and pluralize it.
  {n} 条消息 → {n} messages; 召回 {n} 次 → Recalled {n} times; {n} 台 → {n} devices; {n} 字 → {n} chars.
- **Every string with a count uses a one/other object** (see GUIDE). Never write “item(s)”.
  1 次 → “once”, 2 次 → “twice” only in prose; lists use “{n} times”.
- 已选 {n} 项 → “{n} selected” (no noun needed). 第 {i} 项，共 {n} 项 → “{i} of {n}”.
- Numbers: digits always (“3 files”, not “three files”); thousands separator comma (2,000);
  compact counts with lowercase k/M (“1.2k tokens”, “3.4M tokens”).

### 1.11 Numbers and units

| Kind | Format | Example |
|---|---|---|
| File sizes | number, space, KB / MB / GB | 12 MB, 1.5 GB, over 20 MB |
| Tokens | k/M suffix, no space | 1.2k tokens, 200k context |
| Percent | no space | 45%, 45% used |
| Pixels | no space | 1280px, 390px |
| Frame rate | space | 30 fps |
| Chars | “chars” in dense UI, “characters” in prose | 3,200 / 4,000 chars |
| Durations | see §1.9 | 2h 15m / 2 hr 15 min |
| Versions | as-is | v5.51, 2026.09.27.1455 |
| Ranges | en dash | 1–2 min |

### 1.12 Keyboard keys and gestures

- Key names: Tab, Enter, Esc, Shift, Ctrl, Alt, Space, Backspace, Delete, Home, End, F2;
  arrows as Left Arrow / Up Arrow. Combinations with `+`, no spaces: Ctrl+K, Ctrl+Shift+V, Alt+Up Arrow.
  macOS equivalents only in macOS-only copy: ⌘K.
- In hints: “Tab to accept · Esc to dismiss”, “Send (Enter)”, “Back (Alt+Left Arrow)”.
- Gestures: 点/点击 → **Tap** on phone-only surfaces, **Click** on desktop-only surfaces.
  For components shared by phone and desktop, **rephrase neutrally** (“QR code expired · Refresh”,
  “Select a file”); if a touch verb is unavoidable, use “Tap” (the phone is the primary client).
  长按 → Press and hold. 双击 → Double-tap (phone) / Double-click (desktop). 拖/拖入 → Drag / Drop.
  松手 / 松开 → Release (“Release to create”, “Drop to attach”).

### 1.13 Length budget

English runs 1.5–2.5× longer than Chinese. Budget for a 390px phone:

| Element | Target | Hard limit |
|---|---|---|
| Tabs, segmented controls, chips, badges | ≤ 10 chars | 12 |
| Buttons | ≤ 14 chars | 18 |
| Menu items, settings row titles | ≤ 24 chars | 32 |
| Toasts | one line ≈ 40 chars | 60 |
| Column headers | ≤ 12 chars | 14 |

When over budget: drop articles, use the short variant listed in §4 (“Full access” not
“Whole computer”), move the detail into a subtitle or tooltip. Never abbreviate with dots
(“Conf.”, “Setg.”). Don’t drop the object from destructive verbs (“Delete chat”, not “Del”).

### 1.14 Colloquialisms, puns and Chinese-only wordplay

- Translate the **intent**; drop wordplay that has no English equivalent. Don’t transliterate.
- Chinese mechanical metaphors → the English product term: 挂进输入栏 → “Add to composer”;
  铸快照 → “Create snapshot”; 总闸 → “Master switch”; 收尾 → “Finishing up”; 召唤 → “Hand off to”.
- Humour/greetings: 夜深了 → “Up late?”; 早上好/中午好/下午好/晚上好 → Good morning / Good afternoon /
  Good afternoon / Good evening. Personalized: “Good evening, {name}”.
- Emoji and symbols in the Chinese (⛔ ⏳ ✓ →) are kept as-is and in the same position.
- If a string only makes sense in Chinese (a Chinese example sentence, a pinyin hint, an IME tip),
  write an English equivalent example rather than translating literally.
- Internal shorthand like 菊花 (spinner) or 月桥 (the logo) never appears in English UI.

### 1.15 Context ids for `tc()`

Use only these. Page contexts apply the reference product of §3; semantic contexts disambiguate
parts of speech.

| Id | Surface |
|---|---|
| `claude` | Claude page (incl. single-agent mode and Quick Ask) |
| `chatgpt` | ChatGPT mode of the ChatGPT/Codex page |
| `codex` | Codex mode of the ChatGPT/Codex page |
| `agy` | Antigravity page |
| `vertex` | Vertex page (media + Gemini chat) |
| `dimensio` | dimensio (only for dimensio-only wording; dimensio has its own dictionary) |
| `files` | Workspace page, phone/web file manager (iOS Files style) |
| `explorer` | Desktop file manager (Windows 11 File Explorer style) |
| `md` | Markdown reader/editor |
| `settings` | Settings pages (iOS / macOS / claude.ai shells) |
| `admin` | Server admin console |
| `开关` | The value shown on a toggle: 开 / 关 / 开启 / 关闭 → On / Off |
| `diff` | Review/diff panel verbs (撤销 → Revert) |
| `名词` | A Chinese word used as a noun where the plain key is the verb (应用 → App) |

**One merged dictionary.** Inside The Bridge, the bridge dictionary (`web/src/i18n/en`) and the dimensio
dictionary (`harness/web/src/i18n/en`) are merged into one object and dimensio’s is applied last, so a
plain key that exists in both **must have the same English in both** — otherwise dimensio’s value silently
replaces the bridge one on bridge pages. When dimensio needs a different rendering, give it a
`tc('dimensio', …)` key (example: dimensio’s compact fold-line durations `dimensio::{n} 秒` → `{n}s`, while
the plain `{n} 秒` stays `{n} sec` for bridge settings and the video player).

---

## 2. Proper names and do-not-translate

Keep exactly as written (case included). Don’t add “the” except where shown.

| Category | Keep as-is |
|---|---|
| Our brand | **The Bridge** (in sentences: “Sign in to The Bridge”); **Bridge** as a modifier or where space is tight (“Bridge service”, “Bridge Keyboard”, “Bridge URL”). The wordmark “THE BRIDGE” only in logo art. Chinese lowercase “bridge” in UI copy → The Bridge / Bridge by the same rule. |
| Our products | dimensio (always lowercase); Quick Ask; Local Agent |
| Anthropic | Claude, Claude Code, Claude in Chrome, claude.ai, Opus, Sonnet, Haiku, Fable, model ids (`claude-opus-5-5`) |
| OpenAI | ChatGPT, Codex, GPT‑x model names, Plus, Pro, Free (plan names) |
| Google | Gemini, Vertex AI (page label “Vertex”), Veo, Imagen, Lyria, Chirp, SynthID, Antigravity, Google Search |
| Other AI | DeepSeek (“DeepThink” is its feature name), Kimi, Qwen, GLM / Z.ai, llama.cpp, OpenRouter, vLLM, Ollama, Depth Anything |
| Platforms & apps | Windows, Android, iOS, macOS, Edge, Chrome, WebView, Electron, Obsidian, Cloudflare, Cloudflare Tunnel, cloudflared, OSS (Alibaba Cloud OSS), NapCat, QQ, WeChat (微信), MIUI, Git, GitHub, npm, Docker |
| Windows names | File Explorer, Recycle Bin, Task Scheduler, Task Manager, This PC, UI Automation |
| Protocols & formats | MCP, stdio, HTTP, SSE, Streamable HTTP, CDP, API, URL, LAN, Wi‑Fi, OAuth, APK, PDF, ZIP, JSON, PNG, JPEG, MP4, WebM, Markdown (capital M), CSV |
| File names | SKILL.md, CLAUDE.md, AGENTS.md, config.json, .mcpb, auth.json — in code style where the UI supports it |
| Code & commands | slash commands (`/compact`, `/clear`, `/chat`), tool ids (`Bash`, `Read`, `Edit`, `Glob`, `Grep`, `WebFetch`), CLI flags, env var names, rule syntax `Bash(git push:*)`, paths, PIDs, port numbers, `{placeholders}` |
| Keys | Tab, Enter, Esc, Ctrl, Alt, Shift, Space, F2 (see §1.12) |
| Language names | 简体中文 always stays in Chinese; English is “English” |

Tool **display labels** are translated (执行命令 → Run command); tool **ids** shown in monospace are not.

---

## 3. Page-specific voice

### 3.1 Reference product per surface

| Surface | Follow | Notes |
|---|---|---|
| Claude page | Anthropic — Claude desktop Code tab / claude.ai/code | “session”, “composer”, permission-mode names, “Rewind”, “Compact”, “Effort”, curly quotes |
| ChatGPT mode | OpenAI — ChatGPT web/app | “chat”, “Ask anything”, “Log out”, “Temporary chat”, “Thinking effort” |
| Codex mode | OpenAI — Codex app | “chat”, “Reasoning effort”, “Approval prompt”, “Scheduled tasks”, “Full access” |
| Antigravity page | Google Antigravity | “Ask anything…”, “agent”, “conversation” in prose |
| Vertex page | Google Vertex AI Studio / Gemini app | “Generate”, “Parameters”, “Aspect ratio”, “Negative prompt”, “Thinking level”, “Grounding with Google Search” |
| dimensio | Claude Code wording where equivalent, otherwise §4 | “chat”, “Side panel”, “Checkpoint”, “Permission request” |
| Workspace (phone/web) | Apple iOS Files | Locations, Recents, Shared, Get Info, On My Phone |
| Desktop file manager | Windows 11 File Explorer | Cut/Copy/Paste, Properties, Recycle Bin, Date modified, Compress to ZIP file, Extract all… |
| Markdown editor | Obsidian | Reading view, Live Preview, Source mode, Properties, Backlinks, Callout |
| Settings (phone) | iOS 26 Settings | row titles in sentence case, On/Off values, Automatic for theme |
| Settings (desktop) | macOS Tahoe System Settings | same terms, “Open at login” only in macOS-specific copy |
| Settings (single-agent mode) | claude.ai settings dialog | General, Appearance, Account, Usage |
| Admin console | Google Admin console / Claude admin settings | Users, Devices, Audit log, Quotas |
| Phone control, permissions | Android Settings | Accessibility, Display over other apps, Battery optimization, Install unknown apps |
| Home screen, assistant | Apple (Dock, Wallpaper, Liquid Glass) | Assistant = the glass orb |

### 3.2 Terms that differ by surface

Plain key = the Default column. Other columns are `tc('<id>', '中文')` variants.

| 中文 | Default | claude | chatgpt / codex | vertex / agy | files / explorer |
|---|---|---|---|---|---|
| 对话 | Chat | Session (lists, titles, menus); “conversation” when it means the transcript | Chat | Chat; agy prose: conversation | — |
| 新建对话 / 新对话 | New chat | New session | New chat | New chat | — |
| 会话 | Session | Session | Chat (chatgpt only) | Session | — |
| 思考强度 | Effort | Effort | chatgpt: Thinking effort; codex: Reasoning effort | vertex: Thinking level | — |
| 思考深度 / 思考档 | Effort | Effort | Reasoning effort (codex) | vertex: Thinking level | — |
| 退出登录 | Sign out | Sign out | Log out | Sign out | — |
| 定时任务 / 定时触发 | Routines | Routines | codex: Scheduled tasks | — | — |
| 权限卡 | Permission request | Permission request | codex: Approval prompt | — | — |
| 停止生成 | Stop response | Stop response | Stop | Stop | — |
| 参数 | Arguments | Arguments | Arguments | vertex: Parameters | — |
| 联网搜索 | Web search | Web search | Web search | vertex: Grounding with Google Search | — |
| 文件+对话 / 仅文件 | Files and conversation / Files only | Code and conversation / Code only | — | — | — |
| 插话 | Steer | Queue (verb) / Queued message | Steer | Steer | — |
| 发消息… (placeholder) | Message… | Reply… (existing session) | Ask anything | agy: Ask anything… | — |
| 回收站 | Recycle Bin | — | — | — | Recycle Bin (both; it is the PC’s real Recycle Bin) |
| 属性 | Properties | — | — | — | files: Get Info (menu) / Info (pane); explorer: Properties |
| 类型 / 种类 | Type | — | — | — | Type (both) |
| 在资源管理器中显示 / 定位 | Show in File Explorer | — | — | — | files: Reveal |
| 压缩 | Compact (context) | Compact | Compact | — | Compress |
| 跟随系统 | System | System | System | — | settings (iOS shell): Automatic |
| 额度 | Usage limit | Usage limit | Usage limit | — | admin: Quota |
| 档位 | Mode | Mode | Mode | — | admin: Tier |
| 正文 | Body | — | — | — | md: Normal text |
| 撤销 | Undo | — | — | — | diff: Revert |
| 应用 | Apply | — | 名词: App | — | — |

Workspace vs folder: **工作空间 = Workspace** (the vault — never write “vault” in the UI, even where the
Chinese says vault — or a project’s working folder as a
concept); **文件夹 / 目录 = Folder** (a concrete directory). **工作区 = Side panel** (the right-hand
dock inside a chat page) — never “Workspace”, to keep it distinct from 工作空间.

---

## 4. Term tables

Columns: **中文** | **English** (canonical, plain `t()`) | **Context variants** | **Evidence / notes**.

### 4.1 Chats, sessions and messages

| 中文 | English | Context variants | Evidence / notes |
|---|---|---|---|
| 对话 | Chat | claude: Session; transcript sense: conversation | OpenAI: 对话→Chat; Claude: “New session” |
| 会话 | Session | chatgpt: Chat | Claude: “Sessions”, “Rewind session” |
| 聊天 | Chat | — | OpenAI: 聊天→Chat |
| 新建对话 / 新对话 / 新聊天 / 发起新对话 / 新话题 | New chat | claude: New session | OpenAI: 新对话→New chat |
| 新会话 | New session | — | Claude |
| 开一个新对话（同一个项目） | New chat in this project | claude: New session in this project | — |
| 重命名对话 | Rename chat | claude: Rename session | Claude: “Rename session” |
| 搜索对话 / 搜索聊天 | Search chats | claude: Search sessions | OpenAI: 搜索聊天→Search chats |
| 历史对话 | Past chats | empty: No chats yet; chatgpt 历史聊天记录 (sidebar aria): Chat history | coined; ChatGPT sidebar nav “Chat history” |
| 历史会话 | Past sessions | — | — |
| 历史 | History | — | Claude: “History” |
| 最近会话 | Recent sessions | — | — |
| 最近 | Recents | — | Claude, OpenAI, iOS Files |
| （空会话） | (Empty session) | — | coined |
| 未命名 / （无标题） | Untitled | 未命名项目: Untitled project | OpenAI: 无标题→Untitled |
| 消息 | Message | — | OpenAI: 消息→Message |
| 发消息 / 发送 | Send | — | OpenAI: 发送→Send |
| 发消息…（占位） | Message… | claude: Reply…; chatgpt: Ask anything | Claude: “Reply…” |
| 问点什么… / 想问什么都可以… / 有问题，尽管问 | Ask anything | claude empty state: How can I help you today? | OpenAI placeholder |
| 输入框 / 输入栏 | Composer | aria-label/placeholder: Message | Claude: “…back in the composer” |
| 回复 / 回答 | Response | 提交回答 (ask card): Submit | Claude: “Stop response” |
| 停止生成 / 停止回答 | Stop response | chatgpt/codex: Stop; tight: Stop | Claude; OpenAI composer aria: 停止→Stop |
| 复制回复 | Copy response | — | — |
| 复制消息 | Copy message | — | — |
| 编辑消息 | Edit message | — | — |
| 编辑并重试 | Edit and retry | — | — |
| 从这里改写 / 改写 | Edit from here | 改写失败: Couldn’t edit | coined from Claude “Rewind to here” |
| 撤回 | Unsend | — | iMessage/Instagram |
| 送达 / 没送达 | Delivered / Not delivered | — | Claude |
| 排队 / 已排队 | Queued | — | Claude: “Queued” |
| 待送达的插话 | Queued messages | — | Claude: “Queued messages” |
| 插话 | Steer | claude: Queue; status: Steering | OpenAI: 正在引导→Steering |
| 立即中断并发送 | Send now | long: Interrupt and send | Claude: “Send now” |
| 附件 | Attachment | plural: Attachments | Claude, OpenAI |
| 当附件提问 | Ask about this | 当附件向 Claude 提问: Ask Claude about this | coined |
| 引用对话 | Reference chat | — | coined; ChatGPT “Reference chat history” |
| 续聊 | Continue chat | — | — |
| 继续 / 接着做 | Continue | paused thing: Resume | OpenAI: 继续→Continue / Resume |
| 你说： / ChatGPT 说： | You said: / ChatGPT said: | — | OpenAI (screen-reader labels) |
| 转录 | Transcript | 查看转录: View transcript | Claude |
| 摘要 | Summary | — | Claude |
| 派生 / 分支到新对话 | Fork | chatgpt: Branch in new chat | Claude: “Fork”; OpenAI |
| 临时聊天 | Temporary chat | — | OpenAI |
| 归档 | Archive | — | OpenAI: 归档→Archive |
| 置顶 / 取消置顶 | Pin / Unpin | 已置顶: Pinned | OpenAI, Claude |
| 收藏 / 取消收藏 | Star / Unstar | heading: Starred | Claude |
| 项目 | Project | plural: Projects | OpenAI, Claude |
| 新建项目 / 新项目 | New project | — | OpenAI |
| 项目选项 / 对话选项 | Project options / Chat options | icon button: More options | OpenAI |
| 隐藏项目 | Hide project | 已隐藏的项目: Hidden projects | — |

### 4.2 Turns, running states and activity

| 中文 | English | Context variants | Evidence / notes |
|---|---|---|---|
| 轮 / 一轮 / 本轮 / 这一轮 | Turn | plural: turns; 停止这一轮: Stop this turn | OpenAI: 轮次 ID→Turn ID |
| 跑 / 在跑 / 跑完 | Run / Running / Finished | — | Colloquial 跑 = neutral “run” |
| 运行中 | Running | {name} 运行中: {name} is running | OpenAI, Claude |
| 正在处理 | Working | — | OpenAI: 正在处理→Working |
| 思考 / 思考中 | Thinking / Thinking… | — | Claude, OpenAI |
| 思考过程 | Thought process | — | Claude |
| 已思考 {n} 秒 | Thought for {n}s | ≥1 min: Thought for {m}m {s}s | Claude |
| 查看过程 | Show thinking | — | Gemini “Show thinking” |
| 思考摘要 / 想法 | Thinking summary | vertex: Thoughts | Gemini API |
| 深度思考 | Extended thinking | Assistant with DeepSeek: DeepThink | Claude |
| 思考一下 | Think | chatgpt tools menu: Think longer | OpenAI |
| 回复中 | Responding… | 回复已生成: Response ready | — |
| 等待模型回复 | Waiting for model… | claude: Waiting for Claude… | Claude |
| 收尾 / 收尾中 | Finishing up / Finishing up… | — | Claude |
| 挂起 / 挂着 | On hold | 本轮挂起中: Turn on hold · waiting for {n} {type} | coined |
| 久无动静 | Stalled | — | Claude, OpenAI |
| 已中断 | Interrupted | — | Claude |
| 中止 | Stop | status: Stopped; 中止失败: Couldn’t stop | UIs don’t say “Abort” |
| 超时被停 | Killed (timed out) | — | — |
| 退出码 | Exit code {code} | — | Claude |
| 被限流 | Rate limited | full: Rate limited. Try again in a moment. | Claude |
| 上游繁忙 | Overloaded | — | Claude “Model overloaded” |
| 上游超时 | Timed out | — | — |
| 等你 | Waiting for you | badge: Needs input | Claude |
| 等你回答 | Waiting for your answer | — | Claude, OpenAI |
| 需要你批准 | Needs your approval | — | Claude |
| 它问了你一个问题 | Claude asked you a question | generic: {agent} asked you a question | Claude |
| 汇报 | Report back | 正在等 Claude 接着汇报: Waiting for Claude to report back | coined |
| 处理过程 | Steps | 收起处理过程: Hide steps | Claude |
| 工具 | Tool | 正在用 X 工具: Using {tool} | Claude |
| 工具调用 | Tool call | {n} 次工具调用: {n} tool calls | Claude |
| 执行命令 | Run command | running: Running command… ; done: Ran command | OpenAI: 已运行命令→Ran command |
| 读取文件 | Read file | Reading file… / Read file | Claude |
| 写入文件 | Write file | — | — |
| 编辑文件 | Edit file | Editing file… / Edited file | Claude |
| 匹配文件 (Glob) | Find files | — | — |
| 搜索内容 (Grep) | Search files | — | Claude “Searched files” |
| 抓取网页 | Fetch page | Fetching page… / Fetched | Claude |
| 联网搜索 / 网页搜索 | Web search | 正在搜索网页: Searching the web…; vertex: Grounding with Google Search | Claude, OpenAI |
| 委托子任务 | Delegate task | — | — |
| 编排工作流 | Run workflow | — | Claude “run a workflow” |
| 命令 | Command | — | OpenAI |
| 后台命令 | Background command | — | — |
| 转后台 | Move to background | error: Couldn’t move to background | — |
| 后台运行 | Run in background | — | OpenAI |
| 后台任务 | Background tasks | singular: Background task | Claude |
| 后台对话 | Background chats | {n} 个对话在后台运行: {n} chats running in background | — |
| 监视任务 | Monitor | — | Claude |
| 参数 (tool input) | Arguments | vertex: Parameters | Claude |
| 结果 | Result | 结构化结果: Structured output | Agent SDK |
| 用时 | Took {t} | agent work time: Worked for {t} | OpenAI: 用时→Worked for |

### 4.3 Modes, permissions and approvals

| 中文 | English | Context variants | Evidence / notes |
|---|---|---|---|
| 运行档位 / 档位 | Mode | full label: Permission mode; admin: Tier | Claude “Permission mode” |
| 档位胶囊 | Mode picker | — | — |
| 默认 | Default | — | Claude mode label |
| 接受编辑 / 自动接受编辑 | Accept edits | — | Claude |
| 计划模式 | Plan mode | mode option 先出计划: Plan first | Claude, OpenAI |
| 自主执行 / 自主 | Auto | long: Autonomous | Claude mode label “Auto” |
| 跳过权限 | Bypass permissions | — | Claude |
| 只读 | Read-only | — | Claude (hyphenated) |
| 访问范围 | Access | — | OpenAI permissions dropdown |
| 整机 / 整机可访问 | Full access | long: Whole computer | OpenAI: 完全访问→Full access |
| 仅工作空间 | Workspace only | — | coined, pairs with Full access |
| 越界 | Outside workspace | generic: Out of scope | coined |
| 权限卡 | Permission request | codex: Approval prompt | Claude: “Permission request(s)”; OpenAI: “approval prompts” |
| 批准 | Approve | 批准并执行: Approve and run | Claude, OpenAI |
| 待批准 | Awaiting approval | — | — |
| 已批准 | Approved | 计划已批准: Plan approved | Claude |
| 拒绝 | Deny | — | Claude, OpenAI |
| 已拒绝 / 被拒绝 | Denied | — | — |
| 拒绝并停止 | Deny and stop | 已拒绝并停止: Denied and stopped | coined |
| 允许一次 | Allow once | 已允许一次: Allowed once | Claude, OpenAI |
| 本会话都允许 | Allow for this session | — | Claude |
| 按前缀 / 本会话按前缀允许 | Allow prefix for this session | short: By prefix | Claude CLI |
| 每次问我 | Always ask | — | OpenAI: 始终询问→Always ask |
| 总是允许 | Always allow | — | OpenAI |
| 从不允许 | Never allow | — | pairs with Always ask/allow |
| 规则 | Rule | 命中的规则: Matched rule; 记下的规则: Saved rules | — |
| 软闸 | Safeguard | — | coined |
| 裁决 / 未裁决 | Decision / Undecided | — | coined |
| 密钥文件 | Secret files | 疑似含密钥: Possible secret (content hidden) | GitHub “secret scanning” |
| 控制面文件 | Control file | — | coined |
| 提示注入 | Prompt injection | — | industry term |
| 离开模式 | Away mode | chip: Away | coined |
| 安全栅门 | Safety fallback | — | coined |
| 快速模式 / Fast | Fast mode | 启用: Turn on fast mode | Claude, OpenAI |
| 超时没人批 · 已按拒绝处理 | Timed out. Denied | plan: Timed out. Plan not approved; ask: Timed out. Continued with reasonable assumptions | — |
| 已失效（超时或这一轮已结束） | This card has expired (timed out or the turn ended) | — | — |

### 4.4 Context, memory and checkpoints

| 中文 | English | Context variants | Evidence / notes |
|---|---|---|---|
| 上下文 | Context | 上下文约 {n}%: Context {n}% | Claude |
| 上下文用量 | Context usage | — | OpenAI |
| 上下文窗口 | Context window | — | Claude |
| 压缩 | Compact | files/explorer: Compress | Claude: “Compacting…” |
| 立即压缩 | Compact now | — | — |
| 压缩好了 | Compacted conversation · {a} → {b} tokens | — | Claude |
| 自动压缩 | Auto-compact | 即将自动压缩: Auto-compacts soon | Claude |
| 压缩会话 | Compact session | 距自动压缩还有 {tokens}: {tokens} until auto-compact | Claude（用量弹层按钮） |
| 整理上下文 | Compacting context… | — | OpenAI (ellipsis because it is an in-progress activity label, §1.3) |
| 带摘要开新会话 | New session with summary | — | coined |
| 缓存 / 前缀缓存 | Prompt cache | label: Cached | Claude, OpenAI |
| token | token | plural: tokens | — |
| 入 / 出 | In / Out | full: Input / Output | Claude |
| 回滚 / 回滚到这里 | Rewind / Rewind to here | 回滚中: Rewinding…; 已回滚: Rewound | Claude |
| 前滚 | Redo rewind | — | Claude |
| 检查点 | Checkpoint | — | Claude CLI |
| 轮内快照 | Mid-turn snapshot | — | coined |
| 文件+对话 / 仅文件 | Files and conversation / Files only | claude: Code and conversation / Code only | Claude “Restore code and conversation” |
| 对话之外 / 外部改动 | Changed outside this chat | badge: Also changed outside | coined |
| 记忆 | Memory | items: Memories | Claude |
| 记忆管理 | Manage memory | — | Claude, ChatGPT |
| 全局记忆 | Global memory | — | coined, parallels “Global instructions” |
| 项目记忆 | Project memory | 「X」的记忆: Memory for “{project}” | — |
| 项目知识 / 项目概况 | Project knowledge / Project overview | — | Claude |
| 召回 | Recall | 召回 {n} 次: Recalled {n} times | RAG term |
| 待确认 | Pending | — | Claude |
| 生效 / 生效中 | Active | extension column: Enabled for | Claude CLI “Goal active” |
| 驳回 / 撤销驳回 | Reject / Undo reject | 已驳回: Rejected | Claude |
| 已失效 / 已被替代 / 已退场 | Stale / Superseded / Retired | — | Claude |
| 被隔离 | Quarantined | — | coined |
| 挂靠文件 | Linked file | — | coined |
| 你确认过 / 验证过 / 观察到 / 推测 | Confirmed by you / Verified / Observed / Inferred | — | coined (evidence levels) |
| 偏好 / 做法 / 参考 | Preference / Practice / Reference | — | coined (memory kinds) |
| 主题 / 标题 / 一句话说明 / 正文 / 证据 | Topic / Title / Description / Body / Evidence | 正文 in md: Normal text | memory fields |
| 适用范围 / 记忆范围 | Scope | — | Claude |
| 到期时间 | Expires | 去掉到期时间: Remove expiration | Claude |
| 提示 / 进提示 | Prompt / In prompt | 进提示 x / y 字: In prompt: {x} / {y} chars | — |
| 作为提示词 | Use as prompt | — | — |
| 自定义指令 | Custom instructions | — | Claude |
| 指令 | Instructions | — | Claude |
| 风格 / 回复风格 | Style | — | Claude |

### 4.5 Plans, questions, goals and cards

| 中文 | English | Context variants | Evidence / notes |
|---|---|---|---|
| 计划 | Plan | — | Claude |
| 计划待批准 | Plan awaiting approval | — | — |
| 退回 | Send back | 退回修改: Request changes | Claude CLI “No, keep planning” |
| 修改意见 | Feedback | — | Claude CLI |
| 在新会话中实施 | Implement in new session | — | coined |
| 计划进度 / 进度 | Progress | — | Claude |
| 正在做 / 进行中 | In progress | subagent: Active | — |
| 问题 / 提问 / 题 | Question | 第 x 题: Question {x}; progress: Question {x} of {n} | Claude |
| 已回答 / 未回答 / 超时未答 | Answered / Unanswered / Timed out | — | Claude |
| 提交回答 | Submit | — | Claude |
| 已跳过 | Skipped | — | Claude |
| 合理假设 | Reasonable assumptions | — | coined |
| 其他… | Other… | — | Claude Code AskUserQuestion |
| 可多选 | Select all that apply | — | — |
| 等你处理的卡片 | Waiting for you | action: Respond | OpenAI “waiting for you” |
| 目标 | Goal | — | OpenAI, Claude |
| 目标模式 | Goal mode | — | OpenAI |
| 目标已达成 | Goal achieved | — | — |
| 目标 · 第 x/y 轮 | Goal · Turn {x}/{y} | — | Turn, not Round |
| 结束等待 | Stop waiting | — | coined |

### 4.6 Agents, tasks, workflows and routines

| 中文 | English | Context variants | Evidence / notes |
|---|---|---|---|
| agent / Agent | agent (mid-sentence), Agent (label start) | {n} 个 agent: {n} agents | Claude |
| Agent 开关 | Agents | subtitle: Turn agents on or off · Sign-in status | iOS toggle list |
| 能用的 agent | Available agents | — | — |
| 子 agent / 子代理 | Subagent | plural: Subagents | Claude, OpenAI |
| 主对话 | Main agent | — | Claude |
| 工作流 | Workflow | — | Claude |
| 阶段 | Phase | plural: Phases | Claude |
| 任务 | Task | panel: Tasks | Claude, OpenAI |
| 新任务 | New task | — | Claude |
| 路由 / 定时任务 / 定时触发 | Routine | plural: Routines; codex: Scheduled tasks; dimensio project-knowledge kind (HTTP route): tc('dimensio', '路由') → Route | Claude “Routines”; OpenAI 定时任务→Scheduled tasks |
| 新建路由 | New routine | 未命名路由: Untitled routine | Claude |
| 频率 | Frequency | — | Claude |
| 每小时 / 每天 / 工作日 / 每周 | Hourly / Daily / Weekdays / Weekly | Hourly at :{mm}; Weekdays at {time} | Claude, OpenAI |
| 下次运行 / 上次 | Next run / Last run | — | Claude |
| 立即运行 | Run now | — | Claude, OpenAI |
| 调度器 | Scheduler | — | — |
| 已安排 | Scheduled | — | OpenAI |
| 技能 | Skills | singular in compounds: Skill, Upload skill; 已载入技能: Loaded skill {name}; {n} 个技能: {n} skill / {n} skills | Claude, OpenAI 技能→Skills (24×). Bare 技能 / 连接器 / 插件 are nav labels → plural |
| 斜杠命令 | Slash commands | — | Claude, OpenAI |
| 命令 / 钩子 (plugin parts) | Commands / Hooks | — | Claude |

### 4.7 Models and providers

| 中文 | English | Context variants | Evidence / notes |
|---|---|---|---|
| 模型 / 型号 | Model | ID column: Model ID | Claude, OpenAI |
| 选择模型 | Select model | — | OpenAI |
| 切换模型 / 换型号 | Switch model | — | Claude |
| 已切换到 | Switched to {model} | 实际使用: Using {model}; 已选: Selected | Claude |
| 模型 ID | Model ID | — | Claude |
| 模型服务 | Provider | 切换模型服务…: Switch provider… | industry |
| 自定义服务 | Custom provider | — | coined |
| OpenAI 兼容接口 | OpenAI-compatible API | — | — |
| 接口地址 | Base URL | — | Claude “API base URL” |
| API Key / Key | API key | 已配 Key: Key set | Claude (lowercase key) |
| 思考强度 / 强度 | Effort | chatgpt: Thinking effort; codex: Reasoning effort; vertex: Thinking level | Claude, OpenAI, Gemini |
| 推理强度 | Reasoning effort | — | OpenAI |
| 思考深度 / 思考等级 / 思考档 | Effort | vertex: Thinking level | — |
| 轻量 / 中等 / 高 | Low / Medium / High | — | Claude |
| 超高 | Extra high | — | Claude “Extra high”; OpenAI 极高→Extra High (xhigh) |
| 最高 | Max | a11y: Max, 5 of 5 | Claude, OpenAI 最高→Max |
| Effort pickers (rule) | Label by **level id**, not by the Chinese word: none None · minimal Minimal · low Low · medium Medium · high High · xhigh Extra high · max Max · ultra Ultra | — | OpenAI/Claude level labels; the ChatGPT clone’s 极高 (=max) / 最高 (=ultra) must not reuse t('极高') / t('最高') |
| 极速 / 智能 | Instant / Auto | — | ChatGPT model picker |
| 本机模型 | Local model | — | — |
| 本地 AI | Local AI | 启动本地 AI: Start local AI | — |
| 显存 / 权重 | VRAM / Weights | — | — |
| 引擎 | Engine | 全局助手引擎: Assistant engine | — |
| 下线 | Retires | 将于 7月23日下线: Retires on Jul 23 | Claude “Retired” |
| 输入建议 | Prompt suggestions | — | Claude |
| 填入建议 | Accept suggestion | hint: Tab to accept · Esc to dismiss | — |
| 填入 | Insert | — | — |
| 快速识图 | Fast image mode | — | coined |
| 深度研究 | Deep research | — | OpenAI |
| Research 已开启 | Research on | — | Claude “Research” |
| 模型描述标签 | Anthropic flagship · Deep thinking | Fastest · Everyday tasks; Stronger reasoning · Complex tasks | coined |

### 4.8 Workspace and files

| 中文 | English | Context variants | Evidence / notes |
|---|---|---|---|
| 工作空间 | Workspace | 在工作空间中打开: Open in Workspace | page name |
| 工作区 | Side panel | 收起工作区: Hide side panel | OpenAI “side panel” |
| 工作台 | Workbench | — | coined (Claude page tool dock) |
| 文件夹 / 目录 | Folder | technical only: directory | Windows, iOS |
| 新建文件夹 | New folder | — | Windows Explorer |
| 新建文件 | New file | md: New note | — |
| 位置 | Location | sidebar: Locations; Add location… | iOS Files |
| 电脑位置 | PC location | Add PC location… | coined |
| 本地位置 | On My Phone | generic: Local location | iOS “On My iPhone” |
| 本地（工作空间） | Local | — | OpenAI: 本地→Local |
| 本地工作空间 | Local workspace | — | — |
| 整个手机存储 | All phone storage | — | Android |
| 所有文件访问 | All files access | — | Android |
| 授权 / 撤销授权 | Allow access / Revoke access | status: Access not granted; Granted | Android |
| 上传 | Upload | Upload files…; Uploading… {n}% | OpenAI |
| 从设备上传 | Upload from device | — | Claude |
| 下载 | Download | Downloading…; Cancel download | OpenAI |
| 导入 | Import | Import files… | OpenAI |
| 重命名 / 改名 | Rename | menu item opening an editor: Rename… | Windows, OpenAI |
| 移到 / 移动到 | Move to… | toast: Moved {n} items to {folder} | Windows |
| 移动 | Move | Moving… | Windows |
| 移到这里 | Move here | — | Claude |
| 剪切 | Cut | — | Windows |
| 粘贴 | Paste | Pasting… | Windows |
| 回收站 | Recycle Bin | Move to Recycle Bin; Moved to Recycle Bin | Windows (files live on the PC) |
| 清空回收站 | Empty Recycle Bin | — | Windows |
| 找回 | Restore | Restored | Windows, Claude |
| 解压 | Extract | Extract here; explorer: Extract all… | Windows, 7-Zip |
| 压缩为 ZIP | Compress to ZIP file | — | Windows 11 |
| 压缩包 / 压缩归档 | ZIP archive | type column: Compressed (zipped) folder | Windows, macOS |
| 属性 | Properties | files: Get Info | Windows |
| 简介 / 显示简介 | Info / Get Info | — | iOS Files |
| 打开方式 | Open with… | error: Couldn’t open with app | OpenAI, Windows |
| 用默认应用打开 | Open with default app | short: Open | — |
| 在资源管理器中显示 | Show in File Explorer | tight: Show in Explorer; files: Reveal | OpenAI |
| 定位 | Reveal | Reveal in file tree | Claude |
| 完整路径 / 复制路径 | Full path / Copy path | toast: Path copied | Claude, OpenAI |
| 名称 | Name | — | Windows column |
| 大小 | Size | — | Windows column |
| 类型 / 种类 | Type | — | Windows column |
| 修改时间 | Date modified | — | Windows column |
| 创建时间 | Date created | — | Windows column |
| 文稿 / 文档 | Document | PDF document; Markdown document; Text document | Windows type names |
| 列表视图 / 图标视图 / 网格视图 | List view / Icon view / Grid view | explorer layouts: List / Details / Large icons | OpenAI, Windows |
| 全选 / 取消选择 | Select all / Select none | — | Windows |
| 选择（进入多选） | Select | — | iOS Files |
| 显示隐藏的项目 | Show hidden items | — | Windows |
| 替换 / 跳过 / 保留两者（同名） | Replace the file / Skip this file / Keep both | title: Replace or skip files; conflict: An item named “{name}” already exists | Windows, macOS |
| 传输 | Transfers | 清除已完成: Clear completed | Chrome downloads |
| 预览 | Preview | error: Can’t preview this file type | OpenAI |
| 浏览文件 | Browse files | — | Claude |
| 生成的文件 / 产物 | Generated files | — | Claude |
| 发送给 AI | Send to AI… | 发给 X: Send to {name} | Claude “Send to Claude” |
| 投 | Send | — | — |
| 挂进 / 挂载 | Attach | into a composer: Add to {agent} composer; folder: Attach folder | Claude “Attach as context” |
| 后退 / 前进 / 上一级 | Back / Forward / Up | tooltips: Back (Alt+Left Arrow); Up to parent folder (Alt+Up Arrow) | Windows |
| 选定此文件夹 / 使用此文件夹 | Select folder / Use this folder | — | Claude, Windows |
| 盘符 | Drives | — | Windows |
| 分享空间 / 共享 | Shared | — | iOS Files |
| 文件库 / 库 | Library | — | OpenAI |
| 安装包 | Installer | Android: APK | — |
| 文件与分享 | Files & sharing | — | settings row |
| 剪贴板 | Clipboard | 剪贴板里没有文件: No files on the clipboard | — |
| 查看大图 | View image | 关闭大图: Close image | Claude |

### 4.9 Git and review

| 中文 | English | Context variants | Evidence / notes |
|---|---|---|---|
| 审阅 / 审阅面板 | Review / Review panel | — | OpenAI |
| 变更 / 改动 / 更改 | Changes | singular: Change; Review changes | OpenAI, Claude |
| 逐行改动 / diff | Diff | — | OpenAI |
| 改前 / 改后 | Before / After | diff editor headers: Original / Modified | VS Code |
| 新增 / 修改 / 改名 / 删除 / 未跟踪 | Added / Modified / Renamed / Deleted / Untracked | — | VS Code SCM |
| 二进制 | Binary | Binary file not shown | Claude, OpenAI |
| 未提交 / 已暂存 | Uncommitted / Staged | — | OpenAI |
| 工作树 | Working tree | git worktree feature: Worktree | git |
| 分支 | Branch | — | OpenAI |
| 主检出 | Main checkout | — | — |
| Git 仓库 / 项目仓库 | Git repository | tight: repo | OpenAI |
| 对比基线 | Compare against | options: This session / Project Git | — |
| 撤销（改动） | Revert | — | OpenAI: 还原→Revert; use tc('diff', '撤销') |
| 验证命令 | Verify command | — | coined |

### 4.10 Markdown editor

| 中文 | English | Context variants | Evidence / notes |
|---|---|---|---|
| 笔记 | Note | — | Obsidian |
| 阅读 / 编辑 / 源码（三态切换） | Read / Edit / Source | tooltips: Reading view / Live Preview / Source mode | Obsidian |
| 属性 / 笔记属性 | Properties | Add property; Property name; Property type | Obsidian |
| 属性类型 | Text / List / Number / Checkbox / Date / Date & time | — | Obsidian |
| 双链 | Internal link | technical: wikilink | Obsidian |
| 反向链接 / 出链 | Backlinks / Outgoing links | — | Obsidian |
| 标注 | Callout | — | Obsidian |
| 大纲 | Outline | — | Obsidian |
| 标签（笔记） | Tags | — | Obsidian |
| 加粗 / 斜体 / 删除线 / 高亮 / 行内代码 | Bold / Italic / Strikethrough / Highlight / Inline code | — | Obsidian |
| {n} 级标题 | Heading {n} | — | Obsidian |
| 正文（段落样式） | Normal text | use tc('md', '正文') | Google Docs |
| 引用 | Quote | — | Claude |
| 无序列表 / 有序列表 / 任务列表 | Bulleted list / Numbered list / Task list | — | Claude, OpenAI |
| 代码块 / 数学块 / 脚注 / 分隔线 | Code block / Math block / Footnote / Horizontal rule | — | Obsidian |
| 表格操作 | Insert row above / below; Insert column left / right; Delete row; Delete column; Alignment | — | Obsidian |
| 文本格式 / 段落 / 插入 | Format / Paragraph / Insert | — | Obsidian |
| 查找 / 替换 | Find / Replace | Replace all; Find and replace; counter: {i} of {n} | VS Code |
| 未保存 | Unsaved | Unsaved changes | Claude |
| 文件已被外部修改 | File changed on disk | actions: Reload / Keep my changes | VS Code |
| 已同步 Claude 的修改 | Synced Claude’s edits | — | coined |

### 4.11 Sharing and snapshots

| 中文 | English | Context variants | Evidence / notes |
|---|---|---|---|
| 分享 | Share | — | OpenAI |
| 分享链接 | Share link | menu: Share link… | OpenAI |
| 只读分享 | Read-only share | — | Google Drive |
| 只读分享文件夹 | Read-only folder link | — | coined |
| 分享密码 / 访问密码 | Password | Require password; Set password | Dropbox |
| 过期 / 有效期 | Expires | field: Expiration; state: Expired | Claude |
| 链接已失效 | Link expired | — | — |
| 快照 | Snapshot | — | OpenAI “snapshot of this chat” |
| 快照对话 | Snapshot chat | — | coined |
| 铸快照 | Create chat snapshots | Allowed to create snapshots | coined |
| 新建快照 | New snapshot | — | — |
| 关停 | Shut down | — | — |
| 销毁 | Delete | Deleted automatically after 1 hour with no new messages | user-facing “delete” |
| 临时对话空间 | Temporary chat | — | ChatGPT |

### 4.12 Media generation (Vertex)

| 中文 | English | Context variants | Evidence / notes |
|---|---|---|---|
| 功能模块 | Modes | tabs: Chat / Image / Video / Speech / Music | Vertex AI Studio |
| 图像 / 图片 | Image | plural: Images; Image generation | OpenAI, Google |
| 视频 | Video | Video generation | — |
| 语音 / 语音合成 | Speech | Text-to-speech | Gemini API |
| 音乐 / 配乐 / 谱曲 | Music | Lyria · Text to music; progress: Composing with Lyria… | Lyria |
| 音频 | Audio | — | — |
| 生成 / 合成 | Generate | Generating speech… | Google (not “synthesize”) |
| 本次生成 / 生成结果 | This generation / Results | — | Vertex |
| 参数 / 生成参数 | Parameters | — | Vertex |
| 提示词 | Prompt | placeholder: Describe what you want to create | Vertex |
| 负面提示词 | Negative prompt | — | Vertex |
| 自动增强 | Enhance prompt | — | Veo |
| 首帧 / 尾帧 | First frame / Last frame | Swap first and last frames | Veo |
| 参考图 / 偏好图 | Reference image | plural: Reference images | Veo 3.1 |
| 带入主体 / 风格 | Subject and style reference | — | Imagen |
| 素材 | Source media | Choose source image | Vertex |
| 比例 / 分辨率 / 时长 / 输出格式 | Aspect ratio / Resolution / Duration / Output format | — | Vertex |
| 生成数量 | Number of results | — | Vertex |
| 种子 | Seed | — | Vertex |
| 帧率 | Frame rate | — | Veo |
| 生成音频 | Generate audio | — | Veo 3 |
| 人物生成 | Person generation | Allow people / Allow adults only / Don’t allow | Imagen |
| 水印 | Watermark | — | SynthID |
| 说话人 / 音色 | Speaker / Voice | Choose voice | Gemini TTS |
| 多人对白 | Multi-speaker | — | AI Studio |
| 朗读文本 | Text | placeholder: Enter text to speak… | AI Studio |
| 媒体库 / 历史作品 | Library | — | Gemini, ChatGPT |
| 创建图片 / 生成图片 | Create image | — | OpenAI |
| 听写 | Dictate | Start dictation | OpenAI |
| 播放 / 暂停 | Play / Pause | — | — |
| 播放速度 / 静音 / 取消静音 | Playback speed / Mute / Unmute | — | YouTube |
| 画质（播放器） | Quality | — | YouTube |
| 原画 / 流畅 | Original / Smooth | — | streaming players |
| 上一张 / 下一张 | Previous / Next | Previous image / Next image | OpenAI |

### 4.13 Home screen, appearance and layout

| 中文 | English | Context variants | Evidence / notes |
|---|---|---|---|
| 主页 | Home | prose: home screen | — |
| 分页 | Page | Claude page, Vertex page | coined; not “tab” |
| 底栏 | Dock | — | Apple |
| 壁纸 | Wallpaper | Choose wallpaper; My wallpapers | iOS |
| 动态（壁纸） | Live | — | Android “Live wallpaper” |
| 空间壁纸 / 空间化 | Spatial wallpaper | progress: Adding depth… | iOS “Spatial Scene” |
| 景深 | Depth effect | Depth intensity | iOS “Depth Effect” |
| 深度模型 | Depth model | — | — |
| 流体壁纸 | Fluid wallpaper | — | coined |
| 液态玻璃 / 玻璃 | Liquid Glass | tight: Glass | Apple |
| 光感 / 折射 / 色散 / 磨砂 | Lighting / Refraction / Dispersion / Frost | — | Figma glass |
| 画质 / 画质预设 | Quality / Quality preset | — | games |
| 性能 / 平衡 / 极高 / 原画 | Performance / Balanced / Ultra / Original | — | game presets; plain 极高 = Ultra (effort levels follow §4.7 rule); 原画 = Original everywhere |
| 转场动画 / 入场演出 | Transitions | Turn off transitions | iOS Reduce Motion |
| 原图加载 | Load full-resolution images | — | iOS Photos |
| 外观 | Appearance | — | Claude, OpenAI |
| 主题 / 配色 | Theme | — | OpenAI |
| 跟随系统 / 浅色 / 深色 | System / Light / Dark | settings (iOS shell): Automatic | Claude, iOS |
| 明亮系统 / 深色系统 | Light set / Dark set | — | coined |
| 切换明暗主题 | Toggle light/dark theme | — | Claude |
| 助手 / 全局助手 | Assistant | 呼出助手: Open Assistant | Siri, Google Assistant |
| 呼出 / 唤出 | Open | — | — |
| 挖孔 | Camera cutout | Calibrate cutout position | Android DisplayCutout |
| 校准 | Calibrate | — | Claude |
| 胶囊 | Capsule | — | Apple shape name |
| 悬浮外壳 | Floating capsule | — | coined |
| 横屏 / 竖屏 | Landscape / Portrait | 横竖屏对调: Rotate | iOS |
| 分屏 | Split view | — | Claude |
| 格 | Pane | 第 {n} 格：{x}: Pane {n}: {x} | Claude |
| 主窗 | Main window | — | macOS/Windows |
| 独立窗口 | Separate window | action: Open in new window | OpenAI “separate windows”, 在新窗口中打开→Open in new window |
| 侧栏 / 边栏 | Sidebar | Open / Close / Collapse / Expand sidebar; 收起侧栏 / 展开侧栏: Collapse sidebar / Expand sidebar; Claude page top-bar menu button: tc('claude', '收起侧栏') Close sidebar | Claude |
| 面板 | Panel | — | Claude |
| 标签页 | Tab | New tab; Close tab | OpenAI |
| 视口 | Viewport | Viewport width | Claude |
| 桌面 / 平板 / 手机（视口） | Desktop / Tablet / Mobile | — | DevTools |
| 触屏仿真 | Touch emulation | — | DevTools |
| 浏览器 | Browser | Agent browser | Claude, OpenAI |
| 终端 | Terminal | — | OpenAI |
| 命令面板 / Ctrl+K 搜索 | Command menu / Search (Ctrl+K) | — | OpenAI |
| 放大 / 还原 | Maximize / Restore | images: Zoom in | Claude |
| 拖动调整宽度 | Drag to resize | — | Claude |

### 4.14 Settings, account and sign-in

| 中文 | English | Context variants | Evidence / notes |
|---|---|---|---|
| 设置 | Settings | — | — |
| 通用 / 个性化 / 帮助 / 关于 | General / Personalization / Help / About | — | OpenAI, Claude |
| 连接与更新 | Connection & updates | — | coined |
| 关于与更新 | About & updates | — | coined |
| 设置与账户 | Settings & account | — | — |
| 账号 / 账户 | Account | login field: Username | OpenAI |
| 用户名 | Username | — | OpenAI, Claude |
| 密码 | Password | Password (at least 8 characters) | — |
| 修改密码 | Change password | — | Apple |
| 原密码 / 新密码 / 确认密码 | Current password / New password / Confirm new password | mismatch: New passwords don’t match | Apple, Google |
| 登录 | Sign in | noun: Sign-in; 登录失败: Sign-in failed | Claude |
| 退出登录 / 退出 / 登出 | Sign out | chatgpt/codex: Log out; 退出（应用 / 托盘菜单）: Quit; 已退出（进程/终端）: Exited | Claude (Sign out 18× vs Log out 8×), OpenAI |
| 退出所有设备 | Sign out everywhere | — | Claude |
| 吊销其它设备 | Sign out other devices | — | — |
| 注册 | Sign up | noun: Sign-up; 注册新账号: Create account; 已关闭注册: Sign-ups are closed | OpenAI, Claude |
| 邀请码 | Invite code | — | — |
| 扫码登录 | Sign in with QR code | — | WeChat/WhatsApp |
| 扫一扫 | Scan | — | WeChat |
| 二维码 | QR code | 二维码已过期: QR code expired | OpenAI |
| 确认登录 | Confirm sign-in | — | Google |
| 已扫描，请在手机上确认 | Scanned. Confirm on your phone. | — | §1.3 |
| 登录态 | Sign-in | 用本机登录态: Use this computer’s sign-in | coined |
| 登录已过期 | Your sign-in expired. Sign in again to continue. | short: Sign-in expired | Claude |
| 未登录 / 已登录 | Not signed in / Signed in | 已登录为 X: Signed in as {x} | Claude |
| 需要登录 | Sign-in required | — | — |
| 登录后显示 | Sign in to view | — | — |
| 认证 | Sign-in | 还没配认证: Not signed in yet; 去配置 / 配置（动词）: Set up | — |
| 配置（名词） | Configuration | tight chip: Config; 连接配置: Connection settings; 未配置: Not set up | OpenAI 设置→Set up (verb) |
| 令牌 | Token | 令牌无效: Invalid token | Claude |
| 访问令牌 | Access token | — | OpenAI |
| 管理员令牌 | Admin token | — | — |
| 设备令牌 | Device token | — | — |
| 个人资料菜单 | Profile menu | — | OpenAI |
| 免费版 / 升级 / 升级至 Plus | Free / Upgrade / Upgrade to Plus | — | OpenAI |
| 订阅 | Subscription | 共享订阅: Shared subscription | OpenAI |
| 额度 | Usage limit | admin (per-user cap): Quota; 我的额度: Your usage | Claude “Plan usage” |
| 订阅额度 / 账号额度 / 用量额度 | Plan usage | — | Claude |
| 用量 | Usage | 查看用量: View usage | OpenAI, Claude |
| 当前会话（5 小时） | Current session | — | Claude usage page |
| 5 小时窗口 / 7 天窗口 | 5-hour window / 7-day window | — | — |
| 5 小时上限 / 5 小时额度 | 5-hour limit | — | — |
| 每周 · 所有模型 | Weekly · all models | Weekly · Opus; Weekly · connected apps | Claude |
| 每周额度 / 本周额度 | Weekly limit | — | Claude |
| 重置 | Resets | Resets in {h} hr {m} min | Claude |
| 额度正常 / 接近上限 / 已达上限 | Within limit / Approaching limit / Limit reached | — | Claude |
| % 已用 / % 剩余 | {pct}% used / {pct}% left | — | Claude, OpenAI |
| 暂无额度数据 | Usage unavailable | — | Claude |
| Claude 账号 | Claude account | 切到此号: Switch to this account | — |
| 通知 | Notifications | 任务通知: Task notifications | OpenAI |
| 快捷键 | Keyboard shortcuts | singular: Shortcut | Claude |
| 热键 | Hotkey | — | OpenAI |
| 改键 / 键位 | Change shortcut | Click to change; Reset shortcuts to defaults | macOS |
| 开机自动启动 / 开机自启 | Run on startup | macOS: Open at login | Claude |
| 保持唤醒 | Keep awake | Windows: Keep this PC awake | Claude, OpenAI |
| 托盘 / 系统托盘 | System tray | macOS: Menu bar | Claude |
| 检查更新 | Check for updates | desktop menu item: Check for updates… (sentence case, §1.2, even though Claude’s native menu is title case) | Claude |
| 有新版本 | Update available | — | Claude |
| 已是最新版本 | You’re up to date | — | Apple |
| 一键更新 | Update now | — | — |
| 重启以更新 | Relaunch to update | Relaunch now | Claude |
| 版本 / 当前版本 | Version / Current version | — | OpenAI |
| 版本历史 / 新版本说明 | Version history / What’s new | — | OpenAI, Claude |
| 版本过旧 / 请更新 | Update required | — | — |
| 反馈 / 提交反馈 | Send feedback | chatgpt/codex: Share feedback | Claude, OpenAI |
| 诊断包 | Diagnostic report | 导出诊断包: Export diagnostic report; in progress: Collecting diagnostics… | Claude “Diagnostic Report”, “Collecting diagnostics…” |
| 省电 / 豁免省电 | Battery optimization | Unrestricted; Not optimized | Android |
| 自启动 | Autostart | Autostart & background activity | MIUI |
| 保持后台运行 | Keep running in background | — | — |
| 相机权限 | Camera access | — | iOS, Android |
| 无障碍权限 | Accessibility access | — | Android |
| 悬浮窗权限 / 显示在其他应用上层 | Display over other apps | — | Android |
| 通知权限 | Allow notifications | blocked: Notifications blocked | Android 13 |
| 安装未知应用 | Install unknown apps | — | Android |
| 输入法 | Keyboard | Android settings: Input method | Android |
| 常驻通知 | Ongoing notification | — | Android |
| 实验性 | Experimental | — | Claude |
| 语言 / 界面语言 | Language / Display language | — | existing core.js |

### 4.15 Server, admin console and network

| 中文 | English | Context variants | Evidence / notes |
|---|---|---|---|
| 服务端 / 服务器 | Server | — | OpenAI |
| 服务 / 主服务 | Service / Main service | bridge 服务: Bridge service | Windows Services |
| 服务进程 | Service process | — | — |
| 常驻进程 | Background process | — | OpenAI |
| 常驻服务 | Background service | — | Windows, Android |
| harness 服务 | harness service | user-facing prose: dimensio service | process name stays lowercase |
| 服务端控制台 / 服务控制台 | Admin console | — | Google Admin console |
| 控制台 | Console | — | — |
| 总览 | Overview | — | Claude |
| 用户 | User | tab: Users | OpenAI |
| 注册用户 | Registered users | — | — |
| 管理员 | Admin | — | OpenAI, Claude |
| 只有管理员能改这里 | Only admins can change this | — | — |
| 这个分页已被管理员关闭 | Turned off by your admin | — | OpenAI |
| 管理员登录 | Admin sign-in | — | — |
| 服务账号 | Service account | — | Google Cloud IAM |
| 普通用户 / 普通档 | Standard user | chip: Standard | Windows account type |
| Pro 用户 / Pro 档 | Pro user | chip: Pro | — |
| 完整权限用户 | Full-access users | — | — |
| 命令行 | Shell | Shell access | Claude Code docs |
| 档位（用户） | Tier | use tc('admin', '档位') | — |
| 单人 / 多用户 | Single-user / Multi-user | — | — |
| 主机端 / 服务端 / 用户端 | Host edition / Server edition / Client | chips: Host / Server / Client | coined |
| 主机 | Host | — | OpenAI |
| 客户端 | Client | plural: Clients; desktop: Desktop client | — |
| 额度与注册 | Quotas & sign-ups | — | coined |
| 并发 / 会话槽 | Concurrency / Session slots | 全服并发: Server-wide concurrency | — |
| 活跃进程 | Active processes | — | — |
| 服务控制 | Service | — | tab label |
| 审计日志 | Audit log | — | Claude |
| 中继审计 | Relay audit log | — | — |
| 日志 / 最近日志 | Logs / Recent logs | — | OpenAI, Claude |
| 重启服务 | Restart service | — | — |
| 空闲时重启 | Restart when idle | — | Windows Update |
| 服务重启 | Server restart | — | — |
| 强杀 | Force stop | Windows: End task | Android, Windows |
| 托管 / 守护 | Managed by | Kept running by the desktop app | Apple/Microsoft pattern |
| 计划任务 | Scheduled task | app name: Task Scheduler | Windows |
| 附着形态 | Attached mode | — | coined |
| 隧道 | Tunnel | product: Cloudflare Tunnel; Public tunnel | Cloudflare |
| 隧道地址 / 公网地址 | Tunnel URL / Public URL | — | — |
| 服务器地址 | Server URL | — | Claude |
| 直连 / 局域网 / 同源 | Direct / LAN / Same origin | — | networking |
| 局域网直连 | LAN direct | 局域网地址: LAN address | — |
| 线路 / 当前线路 | Route / Current route | tunnel links: {n} connections | coined |
| 探测 | Check | Re-check LAN; Checking… | — |
| 连接 / 连接中… / 已连通 / 未连接 | Connect / Connecting… / Connected / Not connected | — | OpenAI |
| 重连中 | Reconnecting… | — | OpenAI |
| 连接中断 / 网络中断 | Connection lost | — | OpenAI |
| 已断开连接 | Disconnected | — | OpenAI |
| 连接超时 | Connection timed out | — | — |
| 在线 / 离线 | Online / Offline | — | OpenAI, Claude |
| 代理 / 出站代理 | Proxy / Outbound proxy | — | OpenAI |
| 上游 | Upstream | — | OpenAI |
| 镜像 | Mirror | · OSS mirror available | — |
| 服务器时区 | Server time zone | — | Apple, Windows |
| 加密存在服务端，不回传浏览器 | Stored encrypted on the server. Never sent to the browser. | — | — |
| 网页版 | Web | form factor: Web app | Anthropic, OpenAI |
| 安卓离线版 / Windows 桌面版 | Android (offline) / Windows desktop | — | — |
| 手机 App | mobile app | Available in the mobile app only | Claude |
| 最后活跃 / 最后请求 | Last active / Last request | — | Claude |
| 已运行 {t}（进程） | Up {t} | long: Running for {t} | Docker |

### 4.16 Devices, pairing and remote control

| 中文 | English | Context variants | Evidence / notes |
|---|---|---|---|
| 设备 | Device | 这台设备: This device; 未知设备: Unknown device | OpenAI, Claude |
| 本机 | This computer | chip/provider: Local; Windows copy: This PC | Claude |
| 电脑 | Computer | “your computer” in sentences | OpenAI |
| 配对 | Pair | Paired; Pairing; Pair new device; Paired devices | Claude |
| 配对码 | Pairing code | — | Claude, OpenAI |
| 配对向导 | Pairing setup | — | — |
| 客户端配对 | Client pairing | — | — |
| 兑换（配对码） | Use | Unused pairing codes; Used · see devices below | one-time codes |
| 作废 / 吊销 | Revoke | Revoked | Claude |
| 中继 | Relay | Relay URL | — |
| 中继设置 | Relay settings | — | — |
| 主机派发密钥 | Host dispatch secret | — | coined |
| 轮换 | Rotate | — | Claude “Rotate secret” |
| 控制通道 | Control channel | — | coined |
| 反向控制 / 远程控制 | Remote control | — | sentence case (not Claude’s RC feature) |
| 总闸 | Master switch | — | coined |
| 远程操作 | Remote access | — | Windows |
| 允许主机远程操作（本机） | Allow host remote access | — | one toggle, one name on every settings shell and in hints that quote it |
| 允许远程桌面控制 / 允许操作真桌面 | Allow remote desktop control | — | same toggle under two Chinese labels |
| 远程桌面控制 / 桌面控制 | Desktop control | — | — |
| 远程更新 | Update remotely | — | — |
| 查看屏幕 / 远程屏幕 | View screen / Remote screen | — | — |
| 只读直播 | Live view (read-only) | — | — |
| 本机 Agent | Local Agent | — | coined feature name |
| 桌面能力 / 桌面权限 | Desktop access | Desktop permissions | — |
| 观察 / 操作 | Observe / Control | — | coined mode pair |
| 急停 | Emergency stop | button: Stop now | E-stop |
| 立即停止 | Stop now | — | — |
| UIA / 界面自动化 | UI Automation | — | Microsoft |
| 手机操控 | Phone control | Phone control · Experimental | — |
| 停止操控 | Stop control | — | — |
| 召唤 Claude | Hand off to Claude | — | OpenAI “Handed off to” |
| 转交中 / 跳转中 | Handing off… / Opening… | — | OpenAI |
| Bridge 输入法 | Bridge Keyboard | — | Android “keyboard” |
| 邀请文本 | Invite message | — | — |
| AI 请求转发 | AI request forwarding | — | coined |
| Codex 登录态镜像 | Codex sign-in sharing | — | coined |

### 4.17 Desktop app and extensions

| 中文 | English | Context variants | Evidence / notes |
|---|---|---|---|
| 桌面客户端 / 桌面壳 | Desktop app | Windows app | Claude |
| 本地运行时 | Local runtime | — | — |
| 快速提问 | Quick Ask | — | coined |
| 扩展 / 扩展中心 | Extensions | subtitle: Skills · Connectors · Plugins | Claude |
| 技能 | Skills | Upload skill (see §4.6) | Claude, OpenAI |
| 技能包 / 包 / 整包 | Bundle | Uninstall bundle; Enable bundle | Claude (.mcpb bundles) |
| 连接器 | Connectors | Add connector; Edit connector | Claude |
| 插件 | Plugins | chatgpt: 应用 → Apps | OpenAI, Claude |
| 生效 Agent | Enabled for | — | — |
| 已安装 | Installed | — | OpenAI |
| 卸载 | Uninstall | Uninstall “{name}”? | OpenAI, Claude |
| 内置 | Built-in | — | Claude |
| 环境变量 / 请求头 / 服务地址 / 启动命令 | Environment variables / Request headers / Server URL / Command | — | Claude |
| 本地命令 (stdio) / 远程 HTTP / 远程 SSE | Local command (stdio) / Remote HTTP (Streamable HTTP) / Remote SSE | — | Claude |
| 传输（MCP） | Transport | — | MCP spec |

### 4.18 Generic actions and states

| 中文 | English | Context variants | Evidence / notes |
|---|---|---|---|
| 确定 / 好 | OK | on a hint: Got it | OpenAI |
| 确认 | Confirm | destructive dialogs: repeat the verb | §1.6 |
| 取消 | Cancel | — | — |
| 已取消 | Canceled | — | en-US spelling |
| 完成 | Done | — | — |
| 关闭 | Close | toggle value: tc('开关','关闭') Off; banner: Dismiss | OpenAI |
| 开启 / 打开（开关） | Turn on | toggle value: tc('开关','开启') On | Claude |
| 已开启 / 已关闭 | On / Off | automation: Active | iOS |
| 启用 / 停用 / 禁用 | Enable / Disable | status: Enabled / Disabled | OpenAI |
| 返回 | Back | error page: Go back; 返回X: Back to {x} (Back to list, Back to sign-in, Back to Home); ‹ 返回: ‹ Back | OpenAI |
| 加载中… / 载入中… / 读取中… / 正在加载… | Loading… | reading one named file: Reading {name}… | OpenAI 正在加载…→Loading… |
| 加载失败 / 读取失败 | Couldn’t load | with reason: Couldn’t load: {reason}; with remedy: Couldn’t load. Try again. | §1.5 |
| 操作失败 | Something went wrong | with reason: Something went wrong: {reason} | §1.5 unknown failure |
| 恢复 | Restore | window: Restore; hidden item: Unhide | Windows |
| 回到底部 | Scroll to bottom | — | Claude, OpenAI 滚动到底部→Scroll to bottom |
| 状态 / 来源 / 备注 / 说明 | Status / Source / Note / Description | — | OpenAI 状态→Status, 来源→Source |
| 未设置 / 未分组 | Not set / Ungrouped | — | — |
| 可用 / 不可用 | Available / Unavailable | — | — |
| 成功（结果列） | Succeeded | — | status column, pairs with Failed |
| 欢迎回来 | Welcome back | — | OpenAI |
| 下一步 / 上一步 | Next / Back | — | setup wizards |
| 跳过 | Skip | — | — |
| 了解更多 | Learn more | — | — |
| 知道了 | Got it | — | OpenAI, Claude |
| 保存 / 已保存 | Save / Saved | Saving… | — |
| 另存为 | Save as… | Save image as… | OpenAI |
| 应用 | Apply | 名词: App | OpenAI |
| 编辑 | Edit | — | — |
| 更改 | Change | — | OpenAI |
| 重试 | Try again | chips/icons: Retry | OpenAI, Claude |
| {n} 秒后重试 | Retry in {n}s | — | OpenAI |
| 刷新 | Refresh | browser: Reload | OpenAI |
| 重新加载 | Reload | — | OpenAI |
| 后退 / 前进（浏览器） | Back / Forward | — | — |
| 启动 / 停止 / 重启 | Start / Stop / Restart | — | OpenAI |
| 启动中 / 等待启动 | Starting… / Waiting to start | — | OpenAI |
| 停止中 | Stopping… | — | OpenAI |
| 已停止 | Stopped | — | — |
| 已暂停 / 暂停 | Paused / Pause | — | OpenAI |
| 等待中 | Waiting… | — | OpenAI |
| 空闲 | Idle | — | OpenAI |
| 就绪 | Ready | — | OpenAI |
| 失败 / 错误 / 出错了 | Failed / Error / Something went wrong | — | OpenAI, Claude |
| 已完成 | Completed | toast/chip: Done; subagent: Finished | OpenAI |
| 删除 | Delete | — | permanent |
| 移除 | Remove | — | detach only |
| 清除 / 清空 | Clear / Clear all | container: Empty | Claude, Windows |
| 撤销 / 重做 | Undo / Redo | diff: Revert | OpenAI |
| 放弃更改 / 放弃 | Discard changes / Discard | — | Claude |
| 复制 / 已复制 | Copy / Copied | Copied to clipboard | OpenAI |
| 复制链接 | Copy link | — | Claude |
| 新建 | New | picker: Create new | OpenAI |
| ＋ 添加 / ＋ 新建 | ＋ Add / ＋ New | — | — |
| 创建并使用 | Create and use | — | — |
| 搜索 | Search | — | — |
| 排序 / 升序 / 降序 | Sort / Ascending / Descending | Sort by; Newest first | Claude |
| 筛选 | Filter | — | — |
| 全部 / 无 | All / None | — | — |
| 是 / 否 | Yes / No | — | — |
| 更多 / 更多选项 | More / More options | More options for {name} | OpenAI |
| 管理 / 查看详情 | Manage / View details | — | OpenAI |
| 收起 / 展开（面板） | Collapse / Expand | — | Claude |
| 收起 / 展开（文字、列表） | Show less / Show more | — | OpenAI |
| 隐藏 / 已隐藏 / 恢复显示 | Hide / Hidden / Unhide | — | OpenAI |
| 勾选 | Select | 部分成员已勾: Some selected | Claude |
| 已选 / 已选择 | {n} selected | bare: Selected | Claude |
| 全选 / 多选 | Select all / Select | — | OpenAI, iOS |
| 切换 | Switch | tooltip toggles: Toggle | OpenAI |
| 当前 | Current | — | Claude |
| 默认 / 恢复默认 | Default / Reset to defaults | one field: Reset to default | Claude |
| 不限 | No limit | — | — |
| （可选） | (optional) | — | OpenAI |
| 拖 / 松手 | Drag / Release | Drop files here or click to browse | Claude |
| 放在这里 | Drop here | — | Claude |
| 长按 | Press and hold | — | OpenAI |
| 左右对调 | Swap | — | Claude |
| 断开 | Disconnect | — | OpenAI |
| 仍要… | {Verb} anyway | — | Claude |
| 不再提示 | Don’t show again | permission: Don’t ask again | — |
| 暂不支持 / 即将上线 / 开发中 | Not supported yet / Coming soon / In development | — | OpenAI, Claude |
| 正在重做中 | This page is being rebuilt | — | coined |
| 未开放 | Not available | — | — |
| 请稍候 | Just a moment… | — | Windows 11 |
| 已截断 | Truncated | inline: (truncated) | OpenAI |
| 确定吗？ | Are you sure? | — | OpenAI |
| 此操作不可撤销 | This can’t be undone. | — | OpenAI, Claude |
| 检查网络连接 | Check your internet connection | — | OpenAI |
| 今天 / 昨天 / 更早 | Today / Yesterday / Older | — | Claude |

---

## 5. Coined Bridge features

Names for the app’s own features. Use them exactly, in sentence case except where noted.

| 中文 | English name | Rationale |
|---|---|---|
| bridge / 桥 | The Bridge (Bridge as modifier) | Brand; “The” is part of the name in sentences |
| 分页 | Page | Full-screen agent surfaces; “tab” is reserved for real tabs inside pages |
| 工作空间 | Workspace | The vault file area and a project’s working folder share one concept |
| 工作区 | Side panel | Matches OpenAI “side panel”; keeps “Workspace” unambiguous |
| 工作台 | Workbench | The Claude page’s browser/terminal/files/tasks set; a bench of tools |
| 底栏 | Dock | The home-screen launcher; Apple’s word |
| 快照对话 | Snapshot chat | A throwaway chat outside projects; pairs with “snapshot” for /chat links |
| 聊天快照 /chat | Chat snapshot | Public read-only copy link; OpenAI calls shared copies “snapshots” |
| 离开模式 | Away mode | Short, says “nobody will answer cards”; chip: Away |
| 插话 | Steer | OpenAI’s term for mid-turn guidance; Claude page uses queue wording |
| 挂起（本轮） | On hold | The turn is kept open waiting on background work |
| 带摘要开新会话 | New session with summary | Describes exactly what happens; parallels Claude “Start a new session” |
| 在新会话中实施 | Implement in new session | Plan-card option; mirrors Claude CLI’s clean-context approval |
| 轮内快照 | Mid-turn snapshot | Checkpoint taken inside a turn |
| 全局记忆 / 项目记忆 | Global memory / Project memory | Parallels Claude “Global instructions” / “Project knowledge” |
| 被隔离 | Quarantined | Memory held out of the prompt for safety |
| 控制面文件 | Control file | Instructions/run config/session log that always need approval |
| 软闸 | Safeguard | Rules that prevent mistakes; explicitly not a sandbox |
| 安全栅门 | Safety fallback | Automatic model switch when a safety gate trips |
| 快速识图 | Fast image mode | Downscaled vision input; says what the user gains |
| 快速提问 | Quick Ask | Global-shortcut mini window; proper name, title case |
| 全局助手 | Assistant | The Siri-like glass orb; “global” is redundant in English |
| 悬浮外壳 | Floating capsule | Android overlay shaped like a capsule |
| Bridge 输入法 | Bridge Keyboard | Android calls IMEs keyboards; proper name, title case |
| 本机 Agent | Local Agent | Desktop-control agent on the PC; proper name, title case |
| 观察 / 操作 | Observe / Control | The Local Agent’s two modes; one verb each |
| 急停 | Emergency stop | Industrial E-stop; unmistakable |
| 反向控制 | Remote control | The host controlling a paired client PC; “reverse control” is unidiomatic |
| 总闸 | Master switch | Control-panel term for the all-devices switch |
| 控制通道 | Control channel | Relay link to a paired PC |
| 主机派发密钥 | Host dispatch secret | Secret the host uses to dispatch jobs; “secret” per Claude wording |
| 附着形态 | Attached mode | Desktop app attaching to a service run by Task Scheduler |
| 主机端 / 服务端 / 用户端 | Host edition / Server edition / Client | The three editions; chips Host / Server / Client |
| 普通 / Pro（用户档） | Standard / Pro | Windows account-type echo; Pro = shell access |
| 额度与注册 | Quotas & sign-ups | Admin tab: per-user quotas and registration |
| 线路 | Route | LAN vs tunnel path |
| 局域网直连 | LAN direct | Same-Wi‑Fi direct connection |
| 空间壁纸 | Spatial wallpaper | Depth-parallax wallpaper; echoes iOS “Spatial Scene” |
| 流体壁纸 | Fluid wallpaper | The WASM fluid simulation wallpaper |
| 明亮系统 / 深色系统 | Light set / Dark set | Wallpaper families bound to appearance |
| 你确认过 / 验证过 / 观察到 / 推测 | Confirmed by you / Verified / Observed / Inferred | Memory evidence levels, strongest first |
| Codex 登录态镜像 | Codex sign-in sharing | Copies Codex credentials to clients |
| 铸快照 | Create chat snapshots | Permission to mint public /chat snapshots |

---

## 6. Recurring sentence patterns

Placeholders keep the same names on both sides. Chinese measure words vanish (§1.10).
Plural forms are shown as `one / other`.

| Chinese pattern | English pattern | Example |
|---|---|---|
| X失败：{reason} (action) | Couldn’t {verb}: {reason} | 重命名失败：{r} → Couldn’t rename: {r} |
| X失败 (status/noun) | {Noun} failed | 上传失败 → Upload failed |
| X失败，请重试 | Couldn’t {verb}. Try again. | 停止失败，请重试 → Couldn’t stop. Try again. |
| 没X成：{r} | Couldn’t {verb}: {r} | 压缩没成：{r} → Couldn’t compact: {r} |
| 无法X / 当前无法X | Couldn’t {verb} / Can’t {verb} right now | 当前无法回滚 → Can’t rewind right now |
| 连不上X | Can’t reach {target} | 连不上电脑 → Can’t reach your computer |
| 正在X… / X中… | {Verb}ing… | 正在准备… → Preparing… |
| X中 {n}% | {Verb}ing… {n}% | 上传中 {n}% → Uploading… {n}% |
| 已X | {Past participle} | 已保存 → Saved |
| 已X到「{place}」 | {Past participle} to {place} | 已保存到「下载」 → Saved to Downloads |
| 已X {n} 项 | {Verb}ed {n} item / {Verb}ed {n} items | 已导入 {n} 项 → Imported {n} items |
| {a} 项已X，{b} 项失败 | {Verb}ed {a} items. {b} couldn’t be {verb}ed. | Moved 3 items. 1 couldn’t be moved. |
| {n} 项失败 | {n} failed | ，{n} 项失败 → , {n} failed |
| 已选 {n} 项 | {n} selected | — |
| 删除选中的 {n} 项？ | Delete {n} item? / Delete {n} items? | — |
| X「{name}」？ | {Verb} “{name}”? | 移除「{name}」？ → Remove “{name}”? |
| 确认X (button) | {Verb} | 确认删除 → Delete |
| 再点一次X | Tap again to {verb} | 再点一次停止 → Tap again to stop |
| 还没有X | No {things} yet | 还没有项目 → No projects yet |
| 没有X / 暂无X | No {things} | 没有匹配的对话 → No matching chats |
| 查看更早的 {n} 条消息 | Show {n} earlier message / Show {n} earlier messages | — |
| 加载更早的X（还有 {n} 个） | Load older {things} ({n} more) | Load older sessions (12 more) |
| {n} 分钟前 / 小时前 / 天前 | {n}m ago / {n}h ago / {n}d ago (compact); {n} min ago / {n} hr ago / {n} day ago / {n} days ago (full) | §1.9 |
| {h} 小时 {m} 分后重置 | Resets in {h} hr {m} min | — |
| 周{d} {hh}:{mm} 重置 | Resets {day} {time} | Resets Mon 3:00 PM |
| 还剩 {m} 分 {s} 秒 | {m}m {s}s left | — |
| 约需 {n} 分钟 | About {n} min | 约需 1–2 分钟 → About 1–2 min |
| 用时 {t} | Took {t} | agent: Worked for {t} |
| {n} 分钟有效 · 一次性 | Valid for {n} min · One-time use | — |
| {t} 后失效 | Expires in {t} | — |
| 更新于 {time} | Updated {time} | Updated 5 min ago |
| 第 {n} 步 · {x} | Step {n} · {x} | — |
| 第 {i} 项，共 {n} 项 | {i} of {n} | — |
| {n} 个{类型}运行中 | {n} {type} running | 2 个后台任务运行中 → 2 background tasks running |
| X 运行中 | {name} is running | — |
| 在等你批准一次操作 | “{title}” is waiting for your approval | — |
| X 需要你… | {agent} needs your {thing} | Claude needs your approval |
| 这一轮跑完再X | {Verb} after this turn finishes | Compact after this turn finishes |
| 这一轮还在跑，先停下再X | This turn is still running. Stop it before {verb}ing. | …Stop it before editing. |
| 有对话正在跑，停下后才能X | A chat is running. Stop it first to {verb}. | — |
| {time} 前没人批，就拒绝 | If no one approves by {time}, it will be denied | review: If no one reviews by {time}, … |
| 已开启：{后果} | On. {Consequence}. | 已开启：Claude 可以读屏… → On. Claude can read the screen… |
| 未开启 · 点此… | Off · Tap to {verb} | Off · Tap to turn on “Claude Bridge” in Settings |
| 已关闭，{后果} | Off. {Consequence}. | Off. Agents can’t access this computer. |
| 去开启 / 去允许 / 去配置 | Turn on / Allow / Set up | jumps to system settings: Open Settings |
| 留空＝X | Leave blank to {verb} | 留空＝不改 → Leave blank to keep current |
| 留空或填 0 = 不限 | Leave blank or enter 0 for no limit | — |
| X（可选，如 Y） | {X} (optional, e.g. {Y}) | Verify command (optional, e.g. npm test) |
| 不会删除X上的文件 | Files on {device} won’t be deleted. | Files on your phone won’t be deleted. |
| X，此操作不可撤销 | {Consequence}. This can’t be undone. | — |
| 超过 {n}MB（X 上限） | Over {n} MB ({X} limit) | Image is over 7 MB (Vertex AI attachment limit) |
| 结果超过 {n} 条，已截断 | More than {n} results; showing the first {n} | — |
| 在「A → B」里… | In A → B, … | Add it in Admin console → Claude accounts |
| 已挂进 X 的输入栏 | Added to {agent} composer | 已挂 {n} 项进 X 的输入栏 → Added {n} items to {agent} composer |
| 发给「{conversation}」 | Send to “{conversation}” | — |
| {agent} 已完成 / 「{name}」已完成 | {agent} is done / “{name}” is done | — |
| 已切换到 X | Switched to {x} | — |
| 本会话实际生效：X | Active in this session: {x} | — |
| X（Enter） / X（Tab） | {X} (Enter) / {X} (Tab) | Send (Enter) |
| X · Esc 收起 | {X} · Esc to dismiss | Tab to accept · Esc to dismiss |
| 点「X」… | Tap “X” to … (X = that button’s English label) | 点「重试」重新下载 → Tap “Try again” to download again. |
| 拖到此处… | Drop {things} here to {verb} | Drop files here to attach |
| 松手即可X | Release to {verb} | Release to create |
| X，放回输入框了 | {…}. Your message is back in the composer. | — |
| 早上好，{name} | Good morning, {name} | — |
| {a} 台已配对 · {b} 台在线 | {a} paired · {b} online | — |
| 配对码：{c}（{n} 分钟内有效，只能用一次） | Pairing code: {c} (valid for {n} min, one-time use) | — |
| 仍然X（覆盖…） | {Verb} anyway (overwrite …) | Rewind anyway (overwrite these external changes) |
| 有未保存的修改，确定离开？ | Leave with unsaved changes? | body: Your draft is kept for now. |
