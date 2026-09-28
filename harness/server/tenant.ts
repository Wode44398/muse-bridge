// 租户模式（bridge 三端拆分 P2，2026-09-28）。
//
// bridge 的服务端形态是多用户的，而 harness 是单租户的（一个进程 = 一套会话 / 配置 / 记忆）。多用户的做法是
// 「每个注册用户一个 harness 进程」：bridge 用 DIMENSIO_TENANT=1 拉起，所有数据位置经 paths.ts 的环境变量改道进
// 该用户自己的目录，工作区（WORKSPACE_DIR）就是他的私有文件夹。这个文件集中定义租户实例的锁：
//
//   · 访问范围锁死「仅工作空间」（DIMENSIO_ACCESS_LOCK，租户默认 workspace）：配置与会话接口都不许切整机。
//   · 工作区类路径（配置里的 workspace、导入项目、dock 的 ws、目录浏览 / 新建目录）必须落在租户根之内。
//   · 越界不弹「允许这一次 / 本会话只读」的卡：批准的人就是用户自己，弹了等于没拦——直接拒。
//   · DIMENSIO_DENY_PATHS：额外的禁区（bridge 数据根、程序目录、别人的用户目录……），文件工具与命令行都拒；
//     租户自己的根在禁区里也照常可用。
//   · 关掉的工具（DIMENSIO_DISABLED_TOOLS，租户默认 LocalPC；没有命令行的租户再关 Bash / Preview）与 provider
//     （DIMENSIO_DISABLE_PROVIDERS）。
//   · 共享凭据不外带：租户没填自己的 key 时，provider 的请求地址只能是服务端配置的默认地址（config.ts 的
//     providerBaseUrlFor / resolveConfig）——否则一个 baseUrl 就能把服务端的共享 key 发到任意地址。
//   · 不连 bridge 的集成件：扩展注册表（里面有连接器凭据）、桌面壳浏览器宿主、本机 PC broker、用户的 Edge、
//     任意本机调试端口（Browser attach）。
//
// 这仍是应用层护栏（同 bridge 的「软隔离」），不是 OS 沙箱：有命令行的用户存心绕，
// 字符串守卫拦不住。要真隔离得按人降权或上容器。
import path from "node:path";

const fold = (p: string) => (process.platform === "win32" ? p.toLowerCase() : p);

function isInside(root: string, abs: string): boolean {
  const rel = path.relative(fold(path.resolve(root)), fold(path.resolve(abs)));
  return rel === "" || (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel));
}

// 现读环境变量（不在模块加载时定死）：测试里要能切换。
export function tenantMode(): boolean {
  return process.env.DIMENSIO_TENANT === "1";
}

// 租户有没有命令行（bridge 按档位传：Pro 有、普通没有）。非租户恒 true。
export function tenantShell(): boolean {
  return !tenantMode() || process.env.DIMENSIO_TENANT_SHELL !== "0";
}

// 访问范围锁：显式 DIMENSIO_ACCESS_LOCK 优先；租户模式默认锁 workspace。
export function accessLock(): "workspace" | "full" | null {
  const v = (process.env.DIMENSIO_ACCESS_LOCK ?? "").trim() || (tenantMode() ? "workspace" : "");
  return v === "workspace" || v === "full" ? v : null;
}

// 租户根 = 他的私有文件夹（WORKSPACE_DIR）。非租户返回 null（不限制）。
export function tenantRoot(): string | null {
  if (!tenantMode()) return null;
  const v = process.env.WORKSPACE_DIR?.trim();
  return v ? path.resolve(v) : null;
}

export function insideTenant(abs: string): boolean {
  const root = tenantRoot();
  return !root || isInside(root, abs);
}

// 工作区类路径的统一闸门：租户模式下必须落在租户根之内，否则抛（接口回 400 / 403）。
export function assertInTenant(abs: string, what = "路径"): void {
  if (!insideTenant(abs)) throw new Error(`${what}超出了你的工作空间：${abs}`);
}

// 额外禁区：分隔符与 PATH 相同（Windows 分号、其余冒号）。
export function denyRoots(): string[] {
  return (process.env.DIMENSIO_DENY_PATHS ?? "")
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s));
}

// 落在禁区里吗（租户自己的根除外——他的根可能恰好在「用户根」这个禁区里面）。
export function insideDeniedRoot(abs: string): boolean {
  const roots = denyRoots();
  if (!roots.length) return false;
  const own = tenantRoot();
  if (own && isInside(own, abs)) return false;
  return roots.some((r) => isInside(r, abs));
}

// 命令行里出现的禁区字面（引号拼接、变量前缀这类抽不出候选路径的写法，按字面兜底）。
export function deniedRootLiteral(command: string): string | null {
  const roots = denyRoots();
  if (!roots.length) return null;
  const own = tenantRoot();
  const text = fold(command.replace(/\\/g, "/"));
  const ownLit = own ? fold(own.replace(/\\/g, "/")) : null;
  for (const r of roots) {
    const lit = fold(r.replace(/\\/g, "/")).replace(/\/+$/, "");
    if (!lit || lit === "/") continue;
    let at = text.indexOf(lit);
    while (at >= 0) {
      const next = text[at + lit.length];
      const boundary = next === undefined || next === "/" || /[\s'"`;|&)]/.test(next);
      // 这一处是不是其实指着自己的根（自己的根在禁区里面时）
      const isOwn = Boolean(ownLit && text.startsWith(ownLit, at) && (text[at + ownLit.length] === undefined || /[\s/'"`;|&)]/.test(text[at + ownLit.length])));
      if (boundary && !isOwn) return r;
      at = text.indexOf(lit, at + 1);
    }
  }
  return null;
}

// 关掉的工具。
export function disabledTools(): Set<string> {
  const set = new Set(
    (process.env.DIMENSIO_DISABLED_TOOLS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  if (tenantMode()) {
    set.add("LocalPCInspect");
    set.add("LocalPCAct");
    if (!tenantShell()) {
      set.add("Bash");
      set.add("Preview");
    }
  }
  return set;
}

// 关掉的 provider。
export function disabledProviders(): Set<string> {
  return new Set(
    (process.env.DIMENSIO_DISABLE_PROVIDERS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

// 给 /api/info 的一份状态：前端据此藏掉访问范围开关、终端、连 Edge 这些入口。
export function tenantInfo(): { tenant: boolean; shell: boolean; accessLocked: "workspace" | "full" | null } {
  return { tenant: tenantMode(), shell: tenantShell(), accessLocked: accessLock() };
}
