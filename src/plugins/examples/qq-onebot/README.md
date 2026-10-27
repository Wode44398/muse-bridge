# QQ 机器人（OneBot）

把 QQ 群和好友私聊接到 Claude。也是 bridge 插件运行环境的完整示例：插件本身只写 OneBot 协议适配和群聊规则，
排队、身份、审批、文件、进程、设置界面都由 bridge 提供。

| 用到的能力 | 在哪 |
|---|---|
| 收协议端上报 `POST /hook/qq-onebot/onebot`（只收本机直连，或带密钥） | `ctx.webhook` |
| 以授权账号跑 Claude：同一个群串行、记住会话续写、不出审批卡 | `ctx.chat.run` |
| 群里的图片当附件给 Claude 看 | `ctx.files.put` |
| Claude 产出的文件做成公开只读链接 | `ctx.share.space` |
| 「由 bridge 拉起」时托管协议端进程 | `ctx.process.spawn` |
| 设置页：分组表单、账号授权、群号下拉、按群设置、状态块、「检查连接」按钮 | 清单 `config` + `ctx.status` / `ctx.action` / `ctx.configOptions` |
| QQ 控制台（聊天记录、手动发消息、重开对话） | 清单 `ui.panel` + `web/index.html`（用 `/plugins/_sdk/bridge-plugin.js`） |

## 用起来

1. 准备一个 OneBot 11 协议端（如 NapCat），开 HTTP 服务（默认 `http://127.0.0.1:3000`）。
2. 在 bridge 里建一个**普通档**的服务账号给机器人用（设置 › 账号），它没有命令行、只能动自己的文件夹。
3. 设置 › 扩展 › 功能扩展 › 添加：本机目录填这个目录，或把它打成 zip 上传。
4. 插件详情里：「以哪个账号回答」选第 2 步的账号，填 OneBot 地址和 Token，保存。
5. 协议端的 HTTP 上报地址填详情页「运行状态」里列出的回调地址（`http://127.0.0.1:<bridge 端口>/hook/qq-onebot/onebot`）。
6. 在群里 @ 机器人或用 `/ai` 开头提问。设置侧栏「插件」组里的「QQ 控制台」能看收发记录。

## 不打扰真群的试法

往回调地址打一条伪造的 OneBot 消息，把「OneBot HTTP 地址」指向一个本地假服务记录发出的消息即可，
仓库里的 `src/plugins/qq-onebot.example.test.mjs` 就是这么测的。
