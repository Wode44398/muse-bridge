# Muse Bridge 反馈中继（Cloudflare Worker）

各台 Muse 上的服务器把**用户同意过**的问题报告 POST 到这里，Worker 以 GitHub App
`muse-bridge-feedback` 的身份提交到本仓库：普通问题开公开 Issue（同一个指纹已有开着的 Issue 就 +1），
安全问题走私密漏洞报告。App 的私钥只存在 Worker secret 里，安装包里没有任何 GitHub 凭据。

报告格式、脱敏规则、Issue 排版都跟服务端共用 `src/feedback/` 下的同一份代码（`wrangler deploy` 时打包进来）。

## 接口

- `POST /v1/report`：报告（格式见 `src/feedback/schema.mjs`）。回 `{ ok, issue:{number,url}, duplicate }`，
  安全问题回 `{ ok, private:true }`；400 格式不对、413 太大、429 限流、503 停收、502 GitHub 出错（客户端会存着补发）。
- `GET /v1/health`

## 部署

```bash
cd feedback-worker
npx wrangler login                                   # 维护者自己的 Cloudflare 账号
npx wrangler kv namespace create FEEDBACK_KV         # 把输出的 id 填进 wrangler.toml
npx wrangler secret put GITHUB_APP_PRIVATE_KEY < 私钥.pem   # GitHub App 设置页生成的私钥；放进去后删掉本地文件
npx wrangler deploy
```

App 的权限只开了 Issues 读写、元数据读、仓库安全公告读写，只装在本仓库上。部署地址变了要同步改
`src/feedback/report.mjs` 里的 `FEEDBACK_URL`（`bootstrap.sh` 的放行网站列表从那里读）。

## 运维

- 停收（被刷、GitHub 出问题）：`npx wrangler kv key put --binding FEEDBACK_KV cfg:paused 1`（恢复：删掉这个键）。
  停收期间客户端拿到 503，报告留在各自的 outbox 里，恢复后自动补发。
- 上限：`wrangler.toml` 的 `DAILY_CAP`（全局每天）、`PER_INSTALL_DAILY`（每台装机每天）。
- 测试：`npm test`（假 GitHub 接口 + 内存 KV，不联网）。
