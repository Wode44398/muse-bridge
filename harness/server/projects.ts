import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteFile } from "./atomic-write.ts";
import { projectsFile as registryFile, projectsRoot } from "./paths.ts";
import { assertInTenant } from "./tenant.ts";

// A project is deliberately thin: it is a display name bound to one absolute
// workspace directory. Sessions keep owning their workspace snapshots; this
// registry only preserves empty projects and friendly names for the sidebar.

export interface Project {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  exists: boolean;
  // 侧栏排序/可见性：置顶可多个（按置顶时刻倒序排在最前），隐藏只是不显示，
  // 既不删目录也不删会话，随时能在「已隐藏」里恢复。
  pinned: boolean;
  pinnedAt: number;
  hidden: boolean;
}

interface StoredProject {
  name: string;
  path: string;
  createdAt: number;
  pinnedAt?: number;
  hidden?: boolean;
  // 侧栏里手动拖出来的位次（小的在前）；置顶区与非置顶区各排各的。没有 = 还没被拖过，排在本区最前（新建 / 刚置顶的在上面）
  rank?: number;
}

interface ProjectFile {
  v: 1;
  projects: StoredProject[];
}

// Q8：数据位置统一在 paths.ts 解析；这里照旧导出。
export { projectsRoot };

function keyFor(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function idFor(p: string): string {
  return createHash("sha1").update(keyFor(p)).digest("hex").slice(0, 16);
}

function fallbackName(p: string): string {
  const resolved = path.resolve(p);
  return path.basename(resolved) || resolved;
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function readStored(): Promise<StoredProject[]> {
  try {
    const raw = JSON.parse(await fs.readFile(registryFile(), "utf8")) as ProjectFile;
    if (raw?.v !== 1 || !Array.isArray(raw.projects)) return [];
    return raw.projects
      .filter((p) => p && typeof p.name === "string" && typeof p.path === "string")
      .map((p) => ({
        name: p.name.trim() || fallbackName(p.path),
        path: path.resolve(p.path),
        createdAt: Number.isFinite(p.createdAt) ? p.createdAt : Date.now(),
        ...(Number.isFinite(p.pinnedAt) && (p.pinnedAt as number) > 0 ? { pinnedAt: p.pinnedAt } : {}),
        ...(p.hidden ? { hidden: true } : {}),
        ...(Number.isFinite(p.rank) ? { rank: p.rank } : {}),
      }));
  } catch {
    return [];
  }
}

async function writeStored(projects: StoredProject[]): Promise<void> {
  // M6：唯一临时名 + 同路径串行 + fsync（以前固定 `${file}.tmp`，并发写会互相踩）。
  await atomicWriteFile(registryFile(), JSON.stringify({ v: 1, projects }, null, 2) + "\n");
}

function validateName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new Error("项目名称不能为空");
  if (name.length > 80) throw new Error("项目名称不能超过 80 个字符");
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) {
    throw new Error("项目名称包含不能用于文件夹的字符");
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name)) {
    throw new Error("这个名称是系统保留名称");
  }
  return name;
}

// 本区内的先后：没拖过的在前（照旧按置顶时刻 / 新建时刻），拖过的按位次
const rankOf = (p: StoredProject | undefined): number => (p && Number.isFinite(p.rank) ? (p.rank as number) : -1);

function view(stored: StoredProject, exists: boolean): Project {
  const pinnedAt = Number.isFinite(stored.pinnedAt) ? (stored.pinnedAt as number) : 0;
  return {
    id: idFor(stored.path),
    name: stored.name,
    path: stored.path,
    createdAt: stored.createdAt,
    exists,
    pinned: pinnedAt > 0,
    pinnedAt,
    hidden: Boolean(stored.hidden),
  };
}

export async function listProjects(discoveredPaths: string[] = []): Promise<Project[]> {
  const stored = await readStored();
  const byPath = new Map(stored.map((p) => [keyFor(p.path), p]));

  // The current workspace and every historical session workspace are projects
  // even if they predate the registry. They remain implicit until the user
  // explicitly imports/creates them, so reading the list does not mutate disk.
  for (const raw of discoveredPaths) {
    if (!raw?.trim()) continue;
    const resolved = path.resolve(raw);
    const key = keyFor(resolved);
    if (!byPath.has(key)) {
      byPath.set(key, { name: fallbackName(resolved), path: resolved, createdAt: 0 });
    }
  }

  const rows = await Promise.all(
    [...byPath.values()].map(async (p) => view(p, await isDirectory(p.path))),
  );
  // 置顶的一律在前（后置顶的更靠上），其余保持「新建在前」；侧栏里手动拖过的，在本区里按拖出来的位次（没拖过的排在
  // 本区最前）。隐藏的项目仍然返回（带 hidden 标记），侧栏据此折进「已隐藏」里，才有地方恢复。
  const rank = (row: Project) => rankOf(byPath.get(keyFor(row.path)));
  return rows.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return b.pinnedAt - a.pinnedAt || b.createdAt - a.createdAt || a.name.localeCompare(b.name);
  });
}

// 侧栏拖动排序：paths 是一个区（置顶区或非置顶区）拖完之后的完整次序，按它写位次。历史里发现、还没进注册表的
// 隐式项目顺手登记（createdAt 0，与置顶 / 隐藏同一个规矩）。
export async function setProjectOrder(rawPaths: string[]): Promise<void> {
  const paths = rawPaths.filter((p) => typeof p === "string" && p.trim()).map((p) => path.resolve(p.trim()));
  if (!paths.length) throw new Error("缺少项目路径");
  const projects = await readStored();
  paths.forEach((workspace, rank) => {
    const key = keyFor(workspace);
    const idx = projects.findIndex((p) => keyFor(p.path) === key);
    if (idx >= 0) projects[idx] = { ...projects[idx]!, rank };
    else projects.push({ name: fallbackName(workspace), path: workspace, createdAt: 0, rank });
  });
  await writeStored(projects);
}

async function register(stored: StoredProject): Promise<Project> {
  const projects = await readStored();
  const key = keyFor(stored.path);
  const idx = projects.findIndex((p) => keyFor(p.path) === key);
  if (idx >= 0) {
    // 重新导入同一个文件夹 = 明确要它回到侧栏，顺手撤掉隐藏。
    const merged = { ...projects[idx]!, name: stored.name };
    delete merged.hidden;
    projects[idx] = merged;
    stored = merged;
  } else {
    projects.unshift(stored);
  }
  await writeStored(projects);
  return view(stored, true);
}

export async function createBlankProject(rawName: string): Promise<Project> {
  const name = validateName(rawName);
  const root = projectsRoot();
  const workspace = path.join(root, name);
  await fs.mkdir(root, { recursive: true });
  try {
    await fs.mkdir(workspace);
  } catch (e: any) {
    if (e?.code === "EEXIST") {
      throw new Error(`“${name}”文件夹已存在，请用“使用现有文件夹”导入`);
    }
    throw e;
  }
  return register({ name, path: workspace, createdAt: Date.now() });
}

export async function importProject(rawPath: string): Promise<Project> {
  const workspace = path.resolve(rawPath.trim());
  // 租户实例：只能把他自己文件夹里的目录当项目（见 tenant.ts）。
  assertInTenant(workspace, "项目文件夹");
  if (!(await isDirectory(workspace))) throw new Error("所选工作空间不是有效文件夹");
  return register({ name: fallbackName(workspace), path: workspace, createdAt: Date.now() });
}

// 置顶 / 隐藏：两者都只改注册表，不碰目录、不碰会话。历史里发现的隐式项目
// （还没进过注册表）在这里被顺手登记下来，createdAt 保持 0 以免排序跳位。
export async function setProjectFlags(
  rawPath: string,
  patch: { pinned?: boolean; hidden?: boolean },
): Promise<Project> {
  if (!rawPath?.trim()) throw new Error("缺少项目路径");
  const workspace = path.resolve(rawPath.trim());
  const projects = await readStored();
  const key = keyFor(workspace);
  const idx = projects.findIndex((p) => keyFor(p.path) === key);
  const base: StoredProject =
    idx >= 0
      ? projects[idx]!
      : { name: fallbackName(workspace), path: workspace, createdAt: 0 };
  const next: StoredProject = { ...base };
  if (patch.pinned !== undefined) {
    if (patch.pinned) next.pinnedAt = Date.now();
    else delete next.pinnedAt;
    // 换了区：拖出来的位次作废，排到新区的最前（与「后置顶的更靠上」一致）
    if (patch.pinned !== Boolean(base.pinnedAt)) delete next.rank;
  }
  if (patch.hidden !== undefined) {
    if (patch.hidden) next.hidden = true;
    else delete next.hidden;
  }
  if (idx >= 0) projects[idx] = next;
  else projects.push(next);
  await writeStored(projects);
  return view(next, await isDirectory(next.path));
}
