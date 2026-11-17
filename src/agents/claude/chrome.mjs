// Claude in Chrome（主机管理员真实在用的 Edge）：CLI 子进程的环境变量，与拆分模式下单独挂的 MCP 子进程。

import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CLAUDE_CHROME_CONFIG_DIR } from '../../config/index.mjs';
import { claudeCliPath } from '../../runtime/claude-cli.mjs';

// Claude in Chrome 轮的子进程 env（10-07 实测）：
// ① CLI 判断 env 注入的 token 有没有 user:profile 只看 CLAUDE_CODE_OAUTH_SCOPES，缺了静默不挂 claude-in-chrome
//   （工具数 0、不报错）；正式服由 explorer 拉起不带它，当初验收从桌面 app 会话里起、继承了变量才是假绿。
// ② 工具挂上之后，云中继还要求这一轮的账号 = Edge 扩展登录的 claude.ai 账号；setup-token（控制台账号池）
//   一律回「Browser extension is not connected」，本机 ~/.claude 登录态才连得上。所以有登录凭据时
//   这些轮去掉注入的 token、改用登录态（CLI 自己续期）；没有凭据文件（如 Docker）就只补 SCOPES。
const CHROME_OAUTH_SCOPES = 'user:inference user:file_upload user:profile user:sessions:claude_code user:plugins';
// 这个配置目录里有没有 claude login 的凭据。不能只看 .credentials.json 在不在：CLI 也往里存 MCP 服务的 OAuth 状态
//（mcpOAuth，装个 context7 之类就会写出来），只有它没有 claudeAiOauth 时按「有登录」去掉 token，每轮都是
// 「Not logged in · Please run /login」（10-28 用户 VPS 实测）。
export function hasClaudeLogin(dir) {
  try {
    const o = JSON.parse(readFileSync(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth;
    return !!(o && (o.accessToken || o.refreshToken));
  } catch { return false; }
}
export function chromeEngineEnv(base) {
  const env = { ...base };
  const credDir = env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  if (hasClaudeLogin(credDir)) { delete env.CLAUDE_CODE_OAUTH_TOKEN; delete env.CLAUDE_CODE_OAUTH_SCOPES; }
  else if (env.CLAUDE_CODE_OAUTH_TOKEN && !env.CLAUDE_CODE_OAUTH_SCOPES) env.CLAUDE_CODE_OAUTH_SCOPES = CHROME_OAUTH_SCOPES;
  return env;
}

// 拆分模式（10-10）：上面那套让 admin 每轮推理也跟着走登录态，控制台切号对 admin 失效。其实 --chrome
// 只是让 CLI 挂一个 stdio MCP 子进程 `claude.exe --claude-in-chrome-mcp`，自己挂它就能给它单独的 env：
// 推理照用号池激活号 token，子进程用 Edge 扩展那个账号的专用登录目录（CLAUDE_CHROME_CONFIG_DIR）。
// 坑：① 服务名 claude-in-chrome 被 CLI 保留、自挂会被静默丢掉，改叫 edge（工具 mcp__edge__*）；
// ② stdio 子进程继承父进程 env，注入的 token 必须显式置空，否则它拿 setup-token 去连中继照样连不上。
// 专用目录没有凭据（还没 /login）就返回 null，回落到旧的 --chrome + chromeEngineEnv。
export const CHROME_MCP_NAME = 'edge';
export function chromeSplitServer() {
  if (!hasClaudeLogin(CLAUDE_CHROME_CONFIG_DIR)) return null;
  const command = claudeCliPath();   // 与推理同一个 Claude Code（以前写死 node_modules 里 SDK 自带的那份）；没就绪就退回 --chrome
  if (!command) return null;
  return {
    type: 'stdio',
    command,
    args: ['--claude-in-chrome-mcp'],
    env: { CLAUDE_CONFIG_DIR: CLAUDE_CHROME_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CODE_OAUTH_SCOPES: '' },
  };
}
