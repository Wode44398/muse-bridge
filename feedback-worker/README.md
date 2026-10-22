# Muse Bridge 反馈中继（Cloudflare Worker）

各台 Muse 上的服务器把**用户同意过**的问题报告 POST 到这里，Worker 以 GitHub App
`muse-bridge-feedback` 的身份提交到本仓库：普通问题开公开 Issue（同一个指纹已有开着的 Issue 就 +1），
安全问题走私密漏洞报告。App 的私钥只存在 Worker secret 里，安装包里没有任何 GitHub 凭据。

报告格式、脱敏规则、Issue 排版都跟服务端共用 `src/feedback/` 下的同一份代码（`wrangler deploy` 时打包进来）。

## 接口

- `POST /v1/report`：报告（格式见 `src/feedback/schema.mjs`）。回 `{ ok, issue:{number,url}, duplicate }`，
  安全问题回 `{ ok, private:true }`；400 格式不对、413 太大、429 限流、503 停收、502 GitHub 出错（客户端会存着补发）。
- `GET /v1/health`

### claude-bridge 反馈收件箱（`/v1/cb/*`）

同一个 Worker 顺带给 claude-bridge（The Bridge）当反馈中继：别人服务器上的用户反馈推到这里，
开发者自己那台 bridge 定时来取。跟上面 Muse 的报告完全分开——**不进 GitHub**，只存 KV 私有收件箱。

- `POST /v1/cb/report`：一份反馈（白名单见 `src/feedback/cb-schema.mjs`：文字、界面位置、版本、平台、角色，
  最多 3 张 ≤2MB 的图片，按文件头只认 png/jpeg/gif/webp）。文字按 Muse 同一套规则脱敏；存成 `cbi:<id>`，
  `CB_TTL_DAYS` 天后过期。回 `{ ok, id }`；400 格式不对、413 太大、429 限流、503 停收或收件箱没配（对方会存着补发）。
- `GET /v1/cb/inbox?limit=10`：列出还没确认的（含图片 base64），`more` 表示还有下一页。
- `POST /v1/cb/inbox/ack`：`{ ids: [...] }`，写进库之后确认，确认过的删掉。

后两个只认 `Authorization: Bearer <INBOX_TOKEN>`；Worker 没配 `INBOX_TOKEN` 这个 secret 时一律 404。
claude-bridge 那边默认就推到本 Worker 的地址（它的 `config.json` 可用 `feedbackRelay` 改）；部署地址变了要两边一起改。
限流单独计数：`CB_DAILY_CAP`（全局每天，默认 50）、`CB_PER_INSTALL_DAILY`（每台装机每天，默认 20）、
`CB_DAILY_MB`（全局每天的体积，默认 30MB）；`cfg:paused` 停收对这里同样生效。
这些默认值按 KV 免费档压的：整个账号每天 1000 次写入、1GB 存储，跟 Muse 那条路共用（换个 namespace 也不隔离，额度按账号算）。
收下一份写 3 次（全局份数与体积合一个键、每台装机一个键、报告本身），被拒的不写；汇总端一个月没来取，最多攒约 900MB。
`/v1/cb/report` 不要凭据（地址在公开代码里），被刷时最坏是当天的全局份额被占满、真实服务器拿到 429 隔天补发；
账号升了 Workers Paid 可以按需放宽这几个值。
大图报告的 CPU 开销按免费档（每次请求 10ms）压过：base64 只做字符集扫描，
收件接口把存的 JSON 直接拼成响应、不再解析；一次最多回约 12M 字符，多的翻页。

## 部署

```bash
cd feedback-worker
npx wrangler login                                   # 维护者自己的 Cloudflare 账号
npx wrangler kv namespace create FEEDBACK_KV         # 把输出的 id 填进 wrangler.toml
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < 私钥.pem   # GitHub App 设置页生成的私钥；放进去后删掉本地文件
npx wrangler secret put INBOX_TOKEN                  # claude-bridge 收件令牌（随机串）；同一个值写进开发者 bridge 的 config.json feedbackInbox.token
npx wrangler deploy
```

App 的权限只开了 Issues 读写、元数据读、仓库安全公告读写，只装在本仓库上。部署地址变了要同步改
`src/feedback/report.mjs` 里的 `FEEDBACK_URL`（`bootstrap.sh` 的放行网站列表从那里读）。

## 运维

- 停收（被刷、GitHub 出问题）：`npx wrangler kv key put --binding FEEDBACK_KV cfg:paused 1`（恢复：删掉这个键）。
  停收期间客户端拿到 503，报告留在各自的 outbox 里，恢复后自动补发。
- 上限：`wrangler.toml` 的 `DAILY_CAP`（全局每天）、`PER_INSTALL_DAILY`（每台装机每天）。
- 测试：`npm test`（假 GitHub 接口 + 内存 KV，不联网）。
