import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { insideGrantedSkillDir, isExtensionRegistryPath } from "./extensions.ts";
import { sessionsDir } from "./store.ts";
import { customProvidersDir } from "./paths.ts";
import { accessLock, insideDeniedRoot, tenantMode } from "./tenant.ts";

// Credential stores recognised by NAME: never readable or writable wherever they
// live, even if a permission rule says "allow" — the sandbox only tightens.
// Judged per path SEGMENT (S4). The old single regex put a second separator after
// the directory alternatives, so `.ssh/.aws/.gnupg` only matched when the path
// ENDED at that directory: ~/.aws/credentials, ~/.ssh/config and everything under
// ~/.gnupg slipped through.
const SECRET_SEGMENT_RE =
  /^(?:\.env(?:\..*)?|\.git-credentials|\.netrc|_netrc|\.npmrc|\.pypirc|credentials\.json|\.credentials\.json|id_rsa|id_ed25519|id_ecdsa|id_dsa)$/i;
const SECRET_DIRS = new Set([".ssh", ".aws", ".gnupg", ".azure", ".cloudflared"]);
// <dir>/<file> pairs whose file name alone is too common to block everywhere
// (S4 / #37④: the stores that actually exist on this machine).
const SECRET_PAIRS: [string, RegExp][] = [
  [".codex", /^auth\.json$/i],
  [".kimi", /^agent-gw\.json$/i],
  [".docker", /^config\.json$/i],
  ["gh", /^hosts\.yml$/i], // ~/.config/gh/hosts.yml
  ["github cli", /^hosts\.yml$/i], // %APPDATA%\GitHub CLI\hosts.yml
  [".kube", /^config$/i],
  [".cargo", /^credentials(?:\.toml)?$/i],
  [".m2", /^settings(?:-security)?\.xml$/i],
  [".gradle", /^gradle\.properties$/i],
];

function secretByName(value: string): boolean {
  const segs = value.replace(/\\/g, "/").split("/").filter(Boolean);
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (SECRET_SEGMENT_RE.test(seg) || SECRET_DIRS.has(seg.toLowerCase())) return true;
    if (i > 0) {
      const dir = segs[i - 1].toLowerCase();
      if (SECRET_PAIRS.some(([d, re]) => d === dir && re.test(seg))) return true;
    }
  }
  return false;
}

// Two very different signals used to share one regex. A credential STORE is
// recognised by NAME (.env, .ssh, id_rsa …) and stays blocked everywhere, in
// every access mode. Key material recognised only by EXTENSION is a far weaker
// signal: a .pem/.key inside the workspace is usually a test fixture or
// something the agent just produced, and blanket-blocking those cost a real run
// its only route (2026-08-16: a k3 run could not extract shairport-sync's
// public, decade-old AirPlay key). Extension matches are blocked only OUTSIDE
// the workspace; anything printed is still scrubbed by the Bash redaction pass.
const SECRET_EXT_RE = /\.(pem|key)$/i;

export function isSecretName(value: string): boolean {
  return secretByName(value);
}

export function isKeyMaterialPath(value: string): boolean {
  return SECRET_EXT_RE.test(value.replace(/\\/g, "/"));
}

// Union of both — for callers that must stay maximally conservative wherever the
// path lives (checkpoint trees never store either kind).
export function isSecretPath(value: string): boolean {
  return isSecretName(value) || isKeyMaterialPath(value);
}

// Directories outside the workspace the user has explicitly opened for READING
// (a JDK, an SDK, Program Files …): DIMENSIO_READONLY_PATHS, semicolon-separated
// absolute directories. Read at call time so the list can change without a
// restart. Reads only — writes and execution stay inside the workspace.
export function readOnlyRoots(): string[] {
  return (process.env.DIMENSIO_READONLY_PATHS ?? "")
    .split(";")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry));
}

export function insideReadOnlyRoot(abs: string): boolean {
  return readOnlyRoots().some((root) => isInside(root, abs));
}

function isInside(root: string, abs: string): boolean {
  const rel = path.relative(root, abs);
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

// ── Credential stores recognised by LOCATION (S4) ───────────────────────────
// bridge 的 config.json（管理员令牌、Claude 账号 OAuth、各家 key）：仓库根与数据根各一份，
// 外加 config.json.bak-* 备份。名字太常见，只能按位置认。
const BRIDGE_ROOT = path.resolve(import.meta.dirname, "..", "..");
const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

// 自定义模型服务的存储（custom-providers.ts）：同账户进程能调 DPAPI 解开 connector-secrets.*，所以整个目录按位置挡。
export function isCustomProviderStorePath(abs: string): boolean {
  return isInside(fold(customProvidersDir()), fold(path.resolve(abs)));
}

export function isBridgeConfigPath(abs: string): boolean {
  const p = path.resolve(abs);
  if (!/^config\.json/i.test(path.basename(p))) return false;
  const dir = fold(path.dirname(p));
  return [BRIDGE_ROOT, process.env.BRIDGE_DATA_ROOT, process.env.BRIDGE_ROOT]
    .filter((v): v is string => Boolean(v && v.trim()))
    .some((d) => fold(path.resolve(d)) === dir);
}

// 家目录下的点目录 / 点文件默认不许碰（S4）：那里是各家 CLI 的凭据与会话（.claude、.codex、
// .config/gh、.docker、shell 历史、rc 文件里 export 的 key…），名单永远补不全。只放行纯依赖
// 缓存与工具链；用户显式开放的只读目录（DIMENSIO_READONLY_PATHS）可以覆盖读。
const HOME_DOT_OK = new Set([
  ".cargo", ".rustup", ".m2", ".gradle", ".nuget", ".npm", ".pnpm-store", ".yarn", ".bun", ".deno",
  ".pyenv", ".conda", ".dotnet", ".jdks", ".vscode", ".gitconfig", ".editorconfig", ".gitignore_global",
]);

export function homeDotEntry(abs: string): string | null {
  const home = path.resolve(os.homedir());
  const rel = path.relative(home, path.resolve(abs));
  if (!rel || rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) return null;
  const first = rel.split(path.sep)[0];
  if (!first.startsWith(".") || HOME_DOT_OK.has(first.toLowerCase())) return null;
  return first;
}

// ── S6（#23、#17）：路径的别名与链接 ───────────────────────────────────────
// UNC（\\host\share、git-bash 里的 //host/share）与 NT/设备命名空间（\\?\、\\.\）是同一块磁盘的
// 另一种写法：它们绕过工作区边界，也绕过所有按位置的判定（家目录点目录、bridge 配置）；
// \\.\PhysicalDrive0 是整块裸盘；连外部主机的 SMB 还会把 Windows 凭据（NTLM）交给对方。
// 任何访问模式都拒。CON/NUL/COM1… 这类保留设备名读起来会挂住（等控制台输入），一并拒。
const NT_DEVICE_RE = /^(?:\\\\|\/\/)[?.](?:\\|\/)/;
const UNC_RE = /^(?:\\\\|\/\/)[^\\/]+[\\/]+[^\\/]+/;
const RESERVED_DEVICE_RE = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CONIN\$|CONOUT\$)(?:\.[^\\/]*)?$/i;

// UNC 与 NT/设备命名空间（Bash 命令行也用这一条；保留设备名不适用于命令行——`2>nul` 很常见）。
export function pathAliasViolation(p: string): string | null {
  const s = p.trim();
  if (NT_DEVICE_RE.test(s)) return "Blocked: NT/device namespace paths (\\\\?\\…, \\\\.\\…) are not allowed — use a normal path";
  if (UNC_RE.test(s)) {
    return "Blocked: UNC / network-share paths (\\\\host\\share) are not allowed — they bypass the workspace and credential checks and can hand your Windows credentials to that host";
  }
  return null;
}

export function rawPathViolation(p: string): string | null {
  const alias = pathAliasViolation(p);
  if (alias) return alias;
  const s = p.trim();
  const last = s.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "";
  if (RESERVED_DEVICE_RE.test(last)) return `Blocked: "${last}" is a Windows device name, not a file`;
  return null;
}

// realpath of the path, or — when it does not exist yet (a file about to be written) — of its
// nearest existing ancestor with the missing tail re-appended. null only if nothing resolves.
export function realOrNearest(abs: string): string | null {
  let cur = path.resolve(abs);
  const tail: string[] = [];
  for (let depth = 0; depth < 256; depth++) {
    try {
      const real = fs.realpathSync.native(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
  return null;
}

// ── S7（#55）：harness 自己的状态，agent 任何模式都不许改写 ─────────────────────
// 会话目录装着全部会话记录、检查点影子仓库（shadow.git 的 hooks/config 会被 harness 自己的
// git 读到——以前 `.git` 规则只认名字恰好是 `.git` 的段，漏了它）、工作流日志与图片 assets。
// 桌面壳宿主描述（BRIDGE_DESKTOP_HOST_FILE）决定共享浏览器附着到哪个 broker，URL 里还带着
// secret，所以读也拒（见 readVerdict）。读会话目录照常放行。
function desktopHostFile(): string | null {
  const file = process.env.BRIDGE_DESKTOP_HOST_FILE?.trim();
  return file ? path.resolve(file) : null;
}

function isDesktopHostFile(abs: string): boolean {
  const file = desktopHostFile();
  return Boolean(file && fold(file) === fold(path.resolve(abs)));
}

// 会话目录的字面路径与真实落点（它本身可能在 junction 后面）；Bash 逐词判，按目录值缓存。
let sessionStore: { dir: string; dirs: string[] } | null = null;
function sessionStoreDirs(): string[] {
  const dir = sessionsDir();
  if (sessionStore?.dir !== dir) {
    const real = realOrNearest(dir);
    sessionStore = { dir, dirs: real && fold(real) !== fold(dir) ? [dir, real] : [dir] };
  }
  return sessionStore.dirs;
}

export function protectedStateViolation(abs: string): string | null {
  const p = path.resolve(abs);
  if (sessionStoreDirs().some((dir) => isInside(fold(dir), fold(p)))) {
    return "Refusing to modify dimensio's own session store (session records, checkpoint shadow repo, workflow journals)";
  }
  if (isDesktopHostFile(p)) return "Refusing to modify the desktop host descriptor";
  return null;
}

// S4（#37）：Read、Grep/Glob 遍历、Browser file://、Bash 命令行共用的凭据判定；null = 放行。
// root 给出时，工作区之内只按名字判：项目自己的 .pem 夹具、.claude/ 项目配置照常可用。
export function readVerdict(abs: string, root?: string): string | null {
  const p = path.resolve(abs);
  if (secretByName(p)) return "Blocked by secret guard";
  if (isExtensionRegistryPath(p)) return "Blocked by secret guard (the extension registry holds connector credentials)";
  if (isBridgeConfigPath(p)) return "Blocked by secret guard (the bridge config holds its tokens and keys)";
  if (isCustomProviderStorePath(p)) return "Blocked by secret guard (dimensio's custom model services hold encrypted API keys)";
  if (isDesktopHostFile(p)) return "Blocked by secret guard (the desktop host descriptor carries the browser broker's secret)";
  // 租户模式的额外禁区（bridge 数据根、程序目录、别人的用户目录……；自己的根除外），见 tenant.ts。
  if (insideDeniedRoot(p)) return "Blocked: this location belongs to the host or to another user";
  if (root && isInside(path.resolve(root), p)) return null;
  if (isKeyMaterialPath(p)) return "Blocked by secret guard (key material outside the workspace)";
  const dot = homeDotEntry(p);
  if (dot && !insideReadOnlyRoot(p) && !insideGrantedSkillDir(p)) {
    return `Blocked by secret guard (~/${dot} is a per-user config/credential area; ask the user to open a specific directory for reading if it is really needed)`;
  }
  return null;
}

// Extra targets protected from writes/exec (reads are fine): any `.git` or `*.git`
// segment — a repo's metadata, a worktree's gitdir pointer file, a bare repo.
// S7: the `*.git` half is new (sessions/shadow.git used to slip through).
const PROTECTED_WRITE_RE = /(^|[/\\])[^/\\]*\.git([/\\]|$)/i;

// How far the sandbox reaches:
//   "workspace" — the classic containment: every path must stay under root.
//   "full"      — Claude-Code-like: root is the primary working directory, but
//                 absolute paths anywhere on the machine are allowed. The
//                 secret guard and .git write-protection still apply globally.
export type SandboxAccess = "workspace" | "full";

export class SandboxError extends Error {
  // P13（X18）：纯粹因为「工作区外」被拒（不是凭据、不是别名 / 链接这类）时带上落点——loop 据此问人要不要放行这次读
  outside?: { abs: string; write: boolean };
}

// P13：这个错误是不是「只读越界」（有人在场时可以问一句、批了就放行重跑）；是的话给出落点
export function outsideReadOf(e: unknown): { path: string } | undefined {
  return e instanceof SandboxError && e.outside && !e.outside.write ? { path: e.outside.abs } : undefined;
}

// P13：放行读时授权到哪一层——是目录就是它本身，否则是它所在的目录
export function readRootFor(abs: string): string {
  try {
    if (fs.statSync(abs).isDirectory()) return path.resolve(abs);
  } catch {
    /* 不存在：按文件算 */
  }
  return path.dirname(path.resolve(abs));
}

export class Sandbox {
  readonly root: string;
  // 可在会话中途切换（POST /api/sessions/:id/access）：resolve() 每次都读当前值，
  // 所以切「整机」立刻放行绝对路径、切回「仅工作空间」立刻重新拦截。
  access: SandboxAccess;

  constructor(root: string, access: SandboxAccess = "workspace") {
    this.root = path.resolve(root);
    this.access = access;
  }

  // R10（二）：工作区之外、只许读的目录——会话自己的压缩归档（Context Recovery）。只放本会话那一个目录，不放会话存储
  // 整体（里面有别的会话和 shadow.git）；写照旧被会话存储的写保护挡住。目录本身在 junction 后面时真实落点也算。
  private extraRead: string[] = [];
  setExtraReadDirs(dirs: string[]): void {
    this.extraRead = dirs.flatMap((d) => {
      const abs = path.resolve(d);
      const real = realOrNearest(abs);
      return real && fold(real) !== fold(abs) ? [abs, real] : [abs];
    });
  }
  private insideExtraRead(abs: string): boolean {
    return this.extraRead.some((dir) => isInside(dir, abs)) || this.readGrants().some((dir) => isInside(dir, abs));
  }

  // P13（X18）：用户在卡片上放行的工作区外只读目录（「本会话把这个目录设为只读」，随会话落盘）；会话挂上取值函数
  private readGrants: () => string[] = () => [];
  setReadGrants(fn: () => string[]): void {
    this.readGrants = fn;
  }
  grantedReadRoots(): string[] {
    return this.readGrants();
  }
  // P13：「允许这一次」——只给这一次调用的沙箱视图，多放行几个只读目录（原沙箱不变）
  withReadRoots(dirs: string[]): Sandbox {
    if (!dirs.length) return this;
    const view = new Sandbox(this.root, this.access);
    view.extraRead = this.extraRead;
    view.realRootCache = this.realRootCache;
    const base = this.readGrants;
    view.readGrants = () => [...base(), ...dirs.map((d) => path.resolve(d))];
    return view;
  }

  private realRootCache: string | null = null;
  // The workspace root with every link resolved (the root itself may sit behind a junction).
  realRoot(): string {
    if (!this.realRootCache) this.realRootCache = realOrNearest(this.root) ?? this.root;
    return this.realRootCache;
  }

  // Resolve a user/model-supplied path against the workspace root, refusing escapes (in
  // workspace mode) + secrets (always).
  resolve(p: string, opts: { forWrite?: boolean } = {}): string {
    if (!p || typeof p !== "string") throw new SandboxError("Missing path");
    // S6（#23）：先看原始字符串——UNC、NT/设备命名空间别名会绕开所有按位置的判定。
    const raw = rawPathViolation(p);
    if (raw) throw new SandboxError(`${raw}: ${p}`);
    const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(this.root, p);
    this.check(abs, this.root, p, opts, "");
    // S6（#17）：realpath 复核。工作区里一个指到外面的 junction / 符号链接（mklink /J 不要管理员），
    // 字符串比较看不出来；按真实落点再判一次边界与凭据。
    const real = realOrNearest(abs);
    if (real && fold(real) !== fold(abs)) this.check(real, this.realRoot(), p, opts, " (through a link or junction)");
    return abs;
  }

  private check(abs: string, root: string, p: string, opts: { forWrite?: boolean }, via: string): void {
    // 工作区本身在映射网络盘上时，realpath 出来的就是 UNC——那是它的真身，不算别名。
    const alias = via && UNC_RE.test(root) ? null : rawPathViolation(abs);
    if (alias) throw new SandboxError(`${alias}: ${p}${via}`);
    const rel = path.relative(root, abs);
    const outside =
      rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel);
    // S4：凭据判定先于边界判定（名字 / 注册表 / bridge 配置 / 工作区外的密钥件与家目录点目录），
    // 这样模型拿到的是「密钥守卫」而不是「越界」，不会转头去切整机模式重试。
    const verdict = readVerdict(abs, root);
    if (verdict) throw new SandboxError(`${verdict}: ${p}${via}`);
    // 访问范围锁（租户模式恒 workspace，见 tenant.ts）在这里现读：this.access 被谁改成 full 都不算数。
    if (outside && (accessLock() ?? this.access) !== "full") {
      // 勾给 dimensio 的技能目录在 workspace 模式下有【只读】豁免（S3：只到各技能自己的
      // 目录，不再是整个扩展根）：SKILL.md/脚本要能 Read/Grep，但写入仍然只许 full access。
      // 用户显式开的只读目录同理：读放行、写照旧拒绝。会话自己的压缩归档（R10 二）也是。
      if (opts.forWrite || (!insideGrantedSkillDir(abs) && !insideReadOnlyRoot(abs) && !this.insideExtraRead(abs))) {
        const err = new SandboxError(
          `Path escapes the sandbox: ${p}${via}` +
            (opts.forWrite && insideReadOnlyRoot(abs) ? " (that directory is opened for reading only)" : ""),
        );
        // P13：经链接 / junction 出去的不算（那是另一种越界，不给放行）。租户模式不问（批准的人就是用户自己），直接拒。
        if (!via && !tenantMode()) err.outside = { abs, write: Boolean(opts.forWrite) };
        throw err;
      }
    }
    // The probe string the write guard runs against: rooted-relative inside the
    // workspace, the absolute path outside it (full mode only).
    const probe = outside ? abs : "/" + rel.split(path.sep).join("/");
    if (opts.forWrite && PROTECTED_WRITE_RE.test(probe)) {
      throw new SandboxError(`Refusing to write inside a protected path: ${p}${via}`);
    }
    const state = opts.forWrite ? protectedStateViolation(abs) : null;
    if (state) throw new SandboxError(`${state}: ${p}${via}`);
  }

  // Display a path relative to the sandbox root (for tool summaries/UI).
  // Paths outside the root (full mode) display as absolute.
  rel(abs: string): string {
    const r = path.relative(this.root, abs);
    if (r === "") return ".";
    if (r === ".." || r.startsWith(".." + path.sep) || path.isAbsolute(r)) {
      return abs.split(path.sep).join("/");
    }
    return r.split(path.sep).join("/");
  }
}

// S4（#37②）：Browser 的 file:// 与 Read 走同一道闸（边界 + 凭据判定）。以前 Navigate 到
// file:///…/.ssh/id_ed25519 再 ReadPage，私钥就进了模型上下文。null = 放行；非 file: 一律放行。
export function fileUrlBlock(rawUrl: string, sandbox: Sandbox): string | null {
  if (!/^file:/i.test(rawUrl.trim())) return null;
  let p: string;
  try {
    p = fileURLToPath(rawUrl.trim());
  } catch {
    return `Not a usable file URL: ${rawUrl}`;
  }
  try {
    sandbox.resolve(p);
    return null;
  } catch (e) {
    return (e as Error).message;
  }
}
