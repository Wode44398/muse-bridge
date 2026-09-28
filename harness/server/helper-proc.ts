import path from "node:path";
import { sessionsDir } from "./store.ts";

// S7（#55）：harness 自己拉起的辅助进程——审阅与知识扫描的 git、检查点影子仓库的 git、共享
// 浏览器与截图浏览器、ffmpeg/ffprobe、语法诊断的 python——不是 agent 的
// 工具，但要么跑在 agent 改得到的目录上，要么吃 agent 挑的输入。两条规矩：
//   1. env 不带凭据（helperEnv）：provider key、harness 自己的令牌、桌面壳 broker 地址（URL 里
//      带 secret）一律删掉。与 agent 子进程用的 childEnv 不同，这里保留真实 HOME/APPDATA：
//      影子仓库要读用户级 git 配置（safe.directory 之类），浏览器要真实的 LOCALAPPDATA。
//   2. git 关掉仓库配置能指定的外部命令入口（helperGitArgs / GIT_DIFF_NO_EXTERNAL）：
//      core.fsmonitor（status / diff / add 都会调它）、hooks（update-ref 会跑
//      reference-transaction）、外部 diff 与 textconv。
// 本模块刻意只依赖 store.ts：audio/video 这类小模块引它不必拖进整个 Bash 工具。

// 凭据类环境变量名：childEnv 的白名单、helperEnv 的删除、Bash 输出脱敏共用这一条。
const SENSITIVE_ENV_RE = /(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH|CREDENTIAL|PRIVATE[_-]?KEY|OPENAI|ANTHROPIC|GEMINI|DASHSCOPE|ZHIPU|AWS_|AZURE_|GITHUB_|GITLAB_)/i;
export const isSensitiveEnvName = (name: string): boolean => SENSITIVE_ENV_RE.test(name);

const HELPER_ENV_DROP = new Set(["BRIDGE_DESKTOP_BROKER"]);

export function helperEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || isSensitiveEnvName(name) || HELPER_ENV_DROP.has(name.toUpperCase())) continue;
    env[name] = value;
  }
  return { ...env, ...extra };
}

// hooksPath 指向一个刻意不存在的目录：git 在那里找不到任何 hook。放在会话目录下，
// 是因为会话目录受写保护（sandbox.ts 的 protectedStateViolation），agent 建不出它。
export function helperGitArgs(): string[] {
  const noHooks = path.join(sessionsDir(), "no-hooks").split(path.sep).join("/");
  return ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${noHooks}`, "--no-optional-locks"];
}

// diff 类命令另加：不走 diff.external / diff.<driver>.command，也不跑 textconv。
export const GIT_DIFF_NO_EXTERNAL = ["--no-ext-diff", "--no-textconv"];
