// 「快照存为工作空间」之后把桶【挪出快照地盘】，落到固定位置（claude-quick.mjs 的 savedQuickRoot）。
//
// 为什么要挪（10-21 定）：快照桶根 ~/.bridge-quickchat 是回收的地盘，只靠项目表里登记过
// 来躲过回收；可删除它的不止生产的 pruneQuick——共用根的测试夹具、按「测完删桶」习惯手动
// rm -rf 的 agent，都只看这棵目录。存好的工作空间挪出去，就再也不在任何清理逻辑的视野里。
//
// 挪目录 = 换 cwd，而 Claude 的 transcript 按 cwd 归档（<config>/projects/<cwd 非字母数字换 -> /），
// 所以要连带搬三样，任何一步失败都整体回滚、原地不动（原地仍受项目表 + .owner 隔离保护）：
//   1. transcript 目录改名：桶本身那个 slug，加上「以桶内子目录为 cwd」的那些（slug 以它为前缀）；
//      自动记忆（非 git 目录按 cwd slug 落 memory/）跟着这些目录一起走；
//   2. 工作目录本身 rename；
//   3. transcript 里的旧绝对路径改写成新路径（复用账号迁移的改写器）：产物链接、cwd 字段都对得上。
// 有会话正在跑就不挪（返回 null，下次再试）；停放着的常驻 CLI 先关掉（它开着 transcript 与 cwd）。
import path from 'node:path';
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { inQuickRoots, savedQuickRoot } from './claude-quick.mjs';
import { projectsBase } from './runtime/paths.mjs';
import { encodeCwd, makeRewriter, rewriteJsonlText } from './users-migrate.mjs';

function inGitRepo(dir) {
  let d = path.resolve(dir);
  for (;;) {
    if (existsSync(path.join(d, '.git'))) return true;
    const up = path.dirname(d);
    if (up === d) return false;
    d = up;
  }
}

function listDir(dir) {
  try { return readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

function* jsonlFiles(dir) {
  for (const e of listDir(dir)) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* jsonlFiles(p);
    else if (e.isFile() && e.name.endsWith('.jsonl')) yield p;
  }
}

// 目录 rename；跨盘（EXDEV）退回复制 + 删除。
function moveDir(from, to) {
  try { renameSync(from, to); }
  catch (e) {
    if (e?.code !== 'EXDEV') throw e;
    cpSync(from, to, { recursive: true, errorOnExist: true });
    rmSync(from, { recursive: true, force: true });
  }
}

// 把一只存好的桶挪到固定位置。成功返回新路径，不挪（不在快照地盘 / 正在跑 / 失败已回滚）返回 null。
//   busy    = 正在跑的会话 id；release(id) = 关掉该会话停放着的常驻 CLI；
//   name    = 新目录名（ASCII：中文在 slug 里全变成 -，不同名字会撞同一个 transcript 目录）。
export async function relocateSavedQuick(ctx, dir, { name, busy = new Set(), release = async () => {} } = {}) {
  const from = path.resolve(String(dir || ''));
  if (!inQuickRoots(ctx, from) || !existsSync(from)) return null;
  const root = savedQuickRoot(ctx);
  if (inGitRepo(root)) return null;

  const base = projectsBase(ctx.configDir);
  const oldSlug = encodeCwd(from);
  const slugs = listDir(base).filter((e) => e.isDirectory() && (e.name === oldSlug || e.name.startsWith(oldSlug + '-'))).map((e) => e.name);
  const ids = slugs.flatMap((s) => listDir(path.join(base, s)).filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name.slice(0, -6)));
  if (ids.some((id) => busy.has(id))) return null;
  for (const id of ids) { try { await release(id); } catch {} }

  mkdirSync(root, { recursive: true });
  const stem = String(name || path.basename(from)).replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60) || 'snapshot';
  let to = path.join(root, stem);
  for (let i = 2; existsSync(to); i++) to = path.join(root, `${stem}-${i}`);
  const newSlug = encodeCwd(to);

  const moved = [];
  const rollback = () => { for (const [a, b] of moved.reverse()) { try { renameSync(b, a); } catch {} } };
  try {
    for (const s of slugs) {
      const a = path.join(base, s);
      const b = path.join(base, newSlug + s.slice(oldSlug.length));
      if (existsSync(b)) throw new Error('目标会话目录已存在：' + b);
      renameSync(a, b);
      moved.push([a, b]);
    }
    moveDir(from, to);
  } catch (e) {
    rollback();
    console.warn('[quick] 存好的工作空间没挪成（原地保留）:', e?.message || e);
    return null;
  }

  // transcript 改写尽力而为：改不动的那份只是历史里的旧路径，不影响续聊（续聊按目录找 transcript）。
  const rw = makeRewriter(from, to);
  for (const [, b] of moved) {
    for (const f of jsonlFiles(b)) {
      try {
        const text = await readFile(f, 'utf8');
        // 再换 transcript 目录名本身（工具输出落盘文件的路径带着它）：slug 只含字母数字与 -、
        // 又带着桶的 UUID，整串替换不会误伤。
        const next = rewriteJsonlText(text, rw).split(oldSlug).join(newSlug);
        if (next !== text) await writeFile(f, next);
      } catch {}
    }
  }
  return to;
}
