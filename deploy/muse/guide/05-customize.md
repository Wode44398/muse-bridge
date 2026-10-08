# 自定义：技能、连接器、插件

## 是什么

| 类型 | 是什么 | 能给谁用 |
|---|---|---|
| **技能**（Skill） | 一份写给 agent 的做事说明（`SKILL.md`，可以带脚本），比如「怎么写 Excel」「怎么做代码审查」 | Claude Code、dimensio |
| **连接器**（Connector） | 一个外部 MCP 服务，给 agent 增加工具（比如连 GitHub、数据库）。本地命令（stdio）或远程地址（HTTP / SSE）都行 | Claude Code、dimensio（dimensio 默认没勾，要手动打开） |
| **插件**（Plugin） | Claude Code 专用的一整包：命令、子 agent、技能、钩子、MCP 打包在一起 | 只有 Claude Code |

- **只有管理员能装、能管**，而且**只对管理员自己的对话生效**（管理员的 Claude 对话、管理员的定时任务、管理员的 dimensio）。注册账号的 Claude 和 dimensio 都不加载这些扩展。
- 生效时间：Claude Code 从**下一条消息**起；dimensio 在**新对话**里。

## 怎么进

- Claude 页侧栏 **「自定义」**（Customize）。
- 或 **「设置」** 左栏的 **「自定义」** 分组：**「技能」**（Skills）、**「连接器」**（Connectors）、**「插件」**（Plugins）。
- 打开后占住 Claude 页的中间区域；点任何一个对话就收起。

## 自定义页

- 顶部三个标签：技能 / 连接器 / 插件；再切 **「你的」**（Yours）——装好的，和 **「发现」**（Discover）——可以装的。
- 搜索框、**「筛选」**（Filter）、**「排序」**（Sort），以及 **「添加」**（Add）菜单：**「上传技能…」**（Upload skill…）、**「上传插件…」**（Upload plugin…）、**「添加自定义连接器…」**（Add custom connector…）、**「更新官方目录」**（Update official directory）。

### 「发现」：官方插件目录

- 列的是 **Anthropic 官方插件目录**（几百个插件，以及从里面拆出来的单独技能和连接器）。
- 服务器上第一次用时还没有目录：点 **「下载官方目录」**（Download directory），从 GitHub 下载约 15MB。以后 **「更新官方目录」** 拉最新的。
- **在 Muse 上第一次下载可能弹 github.com 的审核卡**：没人批就会下载失败。提前让 Muse 跑 `bash /home/hatch/bridge-ops/bootstrap.sh allow-sites github.com`，提醒用户选「总是允许此站点」。
- 每张卡片上的 ＋ 就是添加（变成 ✓ 表示已添加）。标着「添加时从 GitHub 下载」的插件，添加时才从 GitHub 拉下来。第三方插件先看看它的主页再装。
- 需要配置的（比如要填某个服务的 token）：添加后会弹出配置表单，填好才生效。看起来像密钥的字段加密存在服务器上，存了就不再显示，留空表示不改。

### 「你的」：装好的

- 每张卡片有开关和状态：**「需要配置」**（Needs setup）/ **「已启用」**（Enabled）/ **「已停用」**（Disabled）。
- 点开看详情：包含哪些东西、配置项、**「生效 Agent」**（Enabled for）——分别给 Claude Code、dimensio 打开或关掉；还有 **「卸载」**（Uninstall）：文件和保存的配置一起删。
- 还有必填配置没填时会提示：用到它们的 MCP 暂时不加载。

## 上传自己的技能 / 插件、加自定义连接器

- **技能**：`.md` 文件（开头的 YAML 里要有 `name` 和 `description`），或 `.zip` / `.skill` 包（里面要有 `SKILL.md`）。
- **插件**：`.zip`，里面要有 `.claude-plugin/plugin.json`。
- **自定义连接器**：填名称和 **「传输」**（Transport）方式——
  - 本地命令（stdio）：启动命令、参数（一行一个）、环境变量（一行一个 `KEY=VALUE`）；
  - 远程 HTTP / SSE：服务地址、请求头（一行一个 `KEY=VALUE`）。
- 上传时会自动剔除 `.env`、私钥这类敏感文件。单个上传最大 64MB，扩展总数最多 200 个。
- 同名的已经装过时，到它的详情页用「替换」上传新版本（保留开关和配置）。
- 连接器要访问的新网站，在 Muse 上第一次用时也会弹审核卡；提前用 `allow-sites <地址>` 放行。

## 常见问题

- **装了技能，注册账号的 Claude 里用不了**：设计如此，扩展只对管理员生效。
- **装了没反应**：Claude 要从下一条消息起才加载；dimensio 要开新对话；还要确认详情里「生效 Agent」勾上了这个 agent、没有「需要配置」。
- **dimensio 用不了插件**：插件只支持 Claude Code。
- **下载目录 / 添加插件失败**：多半是 github.com 的审核卡没批，见上面。
- **要浏览器的插件 / 连接器**（Playwright、Chrome 操控、网页截图这类）：在 Muse 上装了也用不了，这台 VM 起不了浏览器（见 08-faq.md）。联网搜索、抓网页文字不需要装东西，本来就能用。
