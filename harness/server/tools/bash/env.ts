// 用哪个 shell，以及子进程的环境（白名单、隔离 HOME、机器级工具目录）。
import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { grantedSkillDirs } from "../../extensions.ts";
import { isSensitiveEnvName } from "../../helper-proc.ts";
import { tenantMode } from "../../tenant.ts";

export interface ShellInfo {
  kind: "bash" | "powershell" | "sh";
  path: string;
  argsFor(cmd: string): string[];
}

export const shell: ShellInfo = detectShell();

// Child env for spawned commands/servers: make sure localhost bypasses any
// system proxy (Clash etc.) — `curl http://localhost:<port>` routed through a
// proxy returns 000/502 and reads as "my server is broken" when it's fine.
// HTTP(S)_PROXY pass through so pip/curl/git in the sandbox can reach abroad;
// they track net-proxy.ts's adaptive state because childEnv reads process.env
// at call time, and NO_PROXY below keeps localhost direct.
const CHILD_ENV_BASE = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP",
  "TMPDIR", "USER", "USERNAME", "PROGRAMDATA", "PROGRAMFILES",
  "PROGRAMFILES(X86)", "PROGRAMW6432", "LANG", "LC_ALL", "TERM", "SHELL",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "CI",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY",
]);

function explicitChildEnvNames(): Set<string> {
  return new Set(
    (process.env.DIMENSIO_CHILD_ENV_ALLOW ?? "")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
}

// Machine-level tool channel: <harness>/tools (sibling of server/) holds
// agent-callable tooling installed on this machine (e.g. tools/ifind). These
// paths are sanctioned in BOTH sandbox access modes — the workspace containment
// guard below exempts them, and childEnv mirrors the single credential file
// their SDKs resolve via ~/.kimi/agent-gw.json into the isolated child home.
// 勾给 dimensio 的 Bridge 扩展技能目录（托管技能脚本）同享白名单——惰性现算：装第一个
// 扩展前 harness 可能已在跑，注册表出现即生效，不吃启动时快照。S3 起只到各技能自己的
// 目录：没勾给 dimensio 的技能与注册表（连接器令牌）都不在白名单里。
const SANCTIONED_TOOL_DIRS = [path.resolve(import.meta.dirname, "..", "..", "..", "tools")];
export const sanctionedToolDirs = (): string[] => [...SANCTIONED_TOOL_DIRS, ...grantedSkillDirs()];

function mirrorAgentGwCred(isolatedHome: string): void {
  // 租户实例不给：那是管理员的 kimi 数据插件凭据。
  if (tenantMode()) return;
  try {
    const src = path.join(os.homedir(), ".kimi", "agent-gw.json");
    if (!existsSync(src)) return;
    const dst = path.join(isolatedHome, ".kimi", "agent-gw.json");
    if (existsSync(dst) && statSync(dst).mtimeMs >= statSync(src).mtimeMs) return;
    mkdirSync(path.dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  } catch {
    // Non-fatal: the ifind call itself will surface the auth failure.
  }
}

// Windows JVMs write GBK bytes to a pipe, so any Chinese from a java/javac/
// gradle run comes back as mojibake (verified 2026-08-17: `java Hi.java | od -c`
// emits D6D0 CEC4 for 中文). Python is already forced to UTF-8 below; this is the
// same treatment for the JVM.
const JAVA_UTF8_OPTS = "-Dfile.encoding=UTF-8 -Dstdout.encoding=UTF-8 -Dstderr.encoding=UTF-8";
export const JAVA_PICKUP_LINE = `Picked up JAVA_TOOL_OPTIONS: ${JAVA_UTF8_OPTS}`;

// git-bash's /tmp is an MSYS mount that native Windows programs do not share:
// python and java resolve "/tmp/x" against the current drive instead.
// $WORKSPACE_TMP is one scratch path every program on this machine resolves the
// same way — a k3 run on 2026-08-16 lost two attempts to exactly that mismatch.
function scratchDir(): string {
  // DIMENSIO_SCRATCH_DIR：租户实例各用各的（bridge 指到用户自己的目录里），别人看不到彼此的草稿。
  const dir = path.resolve(process.env.DIMENSIO_SCRATCH_DIR?.trim() || path.join(os.tmpdir(), "dimensio-scratch"));
  mkdirSync(dir, { recursive: true });
  return dir.split(path.sep).join("/");
}

export function childEnv(extra?: Record<string, string>): NodeJS.ProcessEnv {
  const grow = (v?: string) => {
    const set = new Set((v ?? "").split(",").map((s) => s.trim()).filter(Boolean));
    set.add("localhost");
    set.add("127.0.0.1");
    set.add("::1");
    return [...set].join(",");
  };
  const allowed = explicitChildEnvNames();
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined || isSensitiveEnvName(name)) continue;
    if (CHILD_ENV_BASE.has(name.toUpperCase()) || allowed.has(name)) env[name] = value;
  }
  const noProxy = grow(process.env.NO_PROXY ?? process.env.no_proxy);
  const isolatedHome = path.resolve(process.env.DIMENSIO_CHILD_HOME?.trim() || path.join(os.tmpdir(), "dimensio-child-home"));
  const appData = path.join(isolatedHome, "AppData", "Roaming");
  const localAppData = path.join(isolatedHome, "AppData", "Local");
  mkdirSync(appData, { recursive: true });
  mkdirSync(localAppData, { recursive: true });
  mirrorAgentGwCred(isolatedHome);
  // 隔离 HOME 让「本机装了什么、用户配置在哪」的查找全落空（2026-10-09：查已装客户端扑空，打包的 Electron 取不到 desktop 目录崩启动），
  // 模型又不知道被重定向了。真实位置单独给出来，要找用户目录下的东西、或要以真实身份起 GUI 程序时显式用它；租户实例不给（那是管理员的家目录）。
  const realHome = tenantMode()
    ? {}
    : {
        REAL_USERPROFILE: os.homedir(),
        REAL_LOCALAPPDATA: process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
        REAL_APPDATA: process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
      };
  return {
    ...env,
    ...realHome,
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    XDG_CONFIG_HOME: path.join(isolatedHome, ".config"),
    GNUPGHOME: path.join(isolatedHome, ".gnupg"),
    NPM_CONFIG_USERCONFIG: path.join(isolatedHome, ".npmrc"),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "Never",
    // R14（X15）：交互式工具驯服——分页器不开（git log / gh / man 不会停在 less 里等按键）、不输出颜色转义
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    MANPAGER: "cat",
    TERM: "dumb",
    NO_COLOR: "1",
    // Windows consoles default python stdio to GBK — print("¥") then dies with
    // UnicodeEncodeError (2026-08-09: one such crash cost three failed calls).
    PYTHONUTF8: "1",
    PYTHONIOENCODING: "utf-8",
    JAVA_TOOL_OPTIONS: JAVA_UTF8_OPTS,
    WORKSPACE_TMP: scratchDir(),
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    ...extra,
  };
}


function detectShell(): ShellInfo {
  if (process.platform === "win32") {
    const gitBash = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ].find((p) => existsSync(p));
    if (gitBash) {
      return { kind: "bash", path: gitBash, argsFor: (c) => ["-c", c] };
    }
    return {
      kind: "powershell",
      path: "powershell.exe",
      argsFor: (c) => ["-NoProfile", "-NonInteractive", "-Command", c],
    };
  }
  return { kind: "sh", path: "/bin/sh", argsFor: (c) => ["-c", c] };
}
