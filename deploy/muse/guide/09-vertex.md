# Gemini · Vertex：图像、视频、语音、音乐

Muse Bridge 带着 bridge 的 Gemini · Vertex 扩展：经 Google 的 Vertex AI 用 Gemini 对话，生成图像（Nano Banana）、短视频（Veo）、语音（Gemini TTS）和配乐（Lyria）；Claude 也会多出画图、配音、配乐这几个工具。**它要用户自己的 Google 云账号和凭据，费用由 Google 按用量收**，所以装好时是关着的，管理员打开、配好凭据才出现。

## 打开它（管理员）

1. **设置 → 扩展 → 功能扩展**，最上面「Agent」一区里有 Gemini · Vertex 这张卡，把卡上的开关打开。即时生效，不用重启。
2. 打开后设置根页「Agent」分组里多出 **Gemini** 一行，主页多出 **Vertex** 方块。还没配凭据时那一行写着「还没配认证」，Vertex 页里也生成不了——先做下一节。
3. 不想用了就把同一个开关关掉：主页、设置、成员那里都不再出现，生成过的作品还在，再打开就回来。

## 配 Google 云凭据（设置 → Agent → Gemini）

页面上开关下面是 **「Google 云凭据」**（Google Cloud credentials）卡片，只有管理员看得到。

1. 先准备凭据（卡片里点 **「怎么拿到凭据」**（How to get credentials）有同样的步骤和直达链接）。两种都行：
   - **服务账号密钥（推荐）**：Google Cloud 控制台选好项目 → 启用 Vertex AI API → IAM 和管理 › 服务账号里新建一个，角色选「Vertex AI 用户」→ 点进它 › 密钥 › 添加密钥 › 创建新密钥 › JSON，下载那个文件。项目要已经开通结算。
   - **自己的 Google 账号**：在用户自己的电脑上装 gcloud，运行 `gcloud auth application-default login`，浏览器里登录后，上传生成的 `application_default_credentials.json`（Windows 在 `%APPDATA%\gcloud\`，macOS / Linux 在 `~/.config/gcloud/`）。这种不带项目，项目 ID 要自己填。
2. 把 JSON 文件拖进卡片里的虚线框，或点 **「选择文件」**（Choose file），或 **「粘贴内容」**（Paste contents）把文件全文贴进去。选错了文件（比如 OAuth 客户端 ID 文件）当场就会说。
3. **「项目 ID」**（Project ID）：服务账号密钥里带的会自动填好；用自己账号的凭据时自己填 Google Cloud 项目 ID。
4. Gemini API Key 可选：个别模型、2K / 4K 的部分图像、长歌曲要用（界面上标「扣预付费额度」的就是）。保存后只显示末 4 位。
5. **「区域」**（Regions）一般别动：对话走 global，媒体模型在 us-central1。
6. 点 **「保存并测试」**（Save and test）：马上生效，并真连一次 Google（不生成东西、不收费）。看到「✓ Vertex 已连通」就好了；**「测试连接」**（Test connection）只测不改，**「移除凭据」**（Remove credentials）删掉上传的那份。

**在 Muse 上第一次测试多半会卡住**：出站代理要用户批准访问 Google 的接口，卡片在 Muse 里（输入框上方或右侧「待审核」面板），没人批时测试等 30 秒后报「30 秒没有回应…出站代理还在等你批准访问 googleapis.com」。最省事的做法：管理员打开扩展后，在 Muse 里说一句「放行 Vertex 要用的网站」，Muse 会跑 `allow-sites`（按现在的配置算，Gemini 开着时会带上 `oauth2.googleapis.com`、`aiplatform.googleapis.com`、`us-central1-aiplatform.googleapis.com`、`generativelanguage.googleapis.com`），用户在每张卡上选「总是允许此站点」，再回来点一次「保存并测试」。只选「允许一次」的话，之后在后台生成时还会再问，生成会停在那里。

测试没通过时，卡片上会写一句原因，照着改：

| 写的是 | 怎么办 |
|---|---|
| 这个项目还没开通 Vertex AI API | Google Cloud 控制台「API 和服务」里启用 Vertex AI API |
| 没有权限 | 给这个服务账号（或自己的账号）加「Vertex AI 用户」角色，再核对项目 ID |
| 这个项目没有关联结算账号 | 给项目开通结算 |
| 凭据无效 | 密钥被删或吊销了，重新下载一份上传 |
| 30 秒没有回应 / 连不上 Google | 多半是 Muse 里的审核卡没批，见上一段 |

凭据只存在这台 VM 的数据目录里（只有服务本身读得到），成员看不到，接口也只回服务账号邮箱这类摘要。**别把凭据文件的内容发在 Muse 的聊天里**，直接在设置页上传。

## 用起来

- 主页的 **Vertex** 方块进去，右上角的 **「功能模块」**（Modes）菜单在 **「对话」**（Chat）、**「图像」**（Image）、**「视频」**（Video）、**「语音」**（Speech）、**「音乐」**（Music）五个模块之间切换（电脑上是主页 Dock 里的 Vertex）。图像是对话式的：先描述生成，再接着说「改成…」逐轮修改；视频和音乐一次约 1–2 分钟。每个模块有自己的历史，在「≡」里。
- **在 Claude 里**：Gemini 开着时，直接跟 Claude 说「画一张…」「配一段音乐」「把这段读出来」，作品显示在对话里，Claude 还能把文件拿去当素材（比如做网页配图）。
- 图像模型列表里的「Qwen Image 2.1 · 本机」是在有显卡的电脑上本地出图用的，**在 Muse 上用不了**，选别的模型。
- 成员：Gemini 打开后，新注册的账号默认就有 Gemini；老账号要在「用户」页他那一行勾上（见 06-users-admin.md）。成员的图像 / 语音 / 音乐和视频生成可以在 **「额度与注册」**（Quotas & sign-ups）里分别关掉或限每天几次，所有生成都记在管理员的 Google 账单上。

## 要花多少钱

- 全部按 Google Cloud 的 Vertex AI 价格计费，账单在用户自己的 Google Cloud 里，Muse Bridge 不收钱。视频按秒计、最贵；图像按张；对话按 token。
- 想控制花费：在 Google Cloud 里设预算提醒；多人用时把成员的视频生成关掉或限次数。
