// 成员自己的技能（设置 → 扩展，成员登录时看到的就是这一份）。
//
// 管理员的扩展中心（extensions.mjs）只有两个范围：自用 / 全服统一。成员以前只能用管理员加装给全服的技能，自己一个都装不了；
// dimensio 那边更糟——成员实例连全服技能都读不到（注册表里有连接器凭据，租户模式一概不认）。现在：
//   · 每个成员一份独立的注册表：DATA_ROOT/extensions/members/<账号哈希>/registry.json + skills/<slug>/。
//     不混进管理员那份 registry.json——管理员侧的读取方（Claude 注入、Codex、管理员的 dimensio、扩展列表）一个都看不到它，
//     不会把某个成员的技能漏给管理员或别的成员。
//   · 只收技能（SKILL.md）。连接器要在服务器上起进程、插件能带 hooks，都是主机级能力，不下放给成员。
//   · 生效的 agent 只有 claude 与 dimensio（codex 不支持多用户）。
//   · Claude：聚合成一个本地插件（名 mine，技能叫 mine:<名>），claudeExtensionsFor 给成员注入「全服 + 自己的」；
//     沙箱对这棵目录只读放行（claude.mjs sandboxFence）。
//   · dimensio：成员实例经 DIMENSIO_SKILL_REGISTRIES 读「自己的注册表 + 全服技能清单」（harness/server/extensions.ts）。
//   · 成员自己的 agent 对这里只读：装 / 删 / 开关只走 /api/my-extensions（routes/member-skills.mjs）。
import path from 'node:path';
import crypto from 'node:crypto';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync, statSync, cpSync } from 'node:fs';
import { writeJson } from './jsonfile.mjs';
import {
  EXT_ROOT, parseFrontmatter, extractArchive, sanitizeTree, treeStats, stagingDir, rebuildAggregate,
  stripCc, slugify, ensureSharedSkillsView, SHARED_SKILLS_VIEW,
} from './extensions.mjs';

export const MEMBERS_ROOT = path.join(EXT_ROOT, 'members');
export const MEMBER_MAX_ITEMS = 200;
export const MEMBER_AGENTS = ['claude', 'dimensio'];
export const MEMBER_SUPPORT = { skill: { claude: true, dimensio: true, codex: false } };
const AGG_NAME = 'mine';

const httpErr = (status, msg) => Object.assign(new Error(msg), { status });
const now = () => Date.now();
const newId = () => 'm' + crypto.randomBytes(8).toString('hex');

// 账号 id 不直接当目录名（改名、奇怪字符、大小写都不该影响）：取哈希前 16 位
export function memberRoot(user) {
  const id = String(user || '').trim();
  if (!id) throw httpErr(400, '缺少账号');
  return path.join(MEMBERS_ROOT, crypto.createHash('sha256').update(id).digest('hex').slice(0, 16));
}
const registryOf = (root) => path.join(root, 'registry.json');
const aggregateOf = (root) => path.join(root, 'runtime', 'claude-plugin');

function itemDir(root, item) {
  if (!item?.dir) return null;
  const abs = path.resolve(root, item.dir);
  return abs !== root && abs.startsWith(root + path.sep) ? abs : null;
}

function readStore(root) {
  const file = registryOf(root);
  if (!existsSync(file)) return { items: [] };
  try {
    let text = readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const o = JSON.parse(text);
    const items = Array.isArray(o?.items) ? o.items : [];
    return { items: items.filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string' && x.type === 'skill') };
  } catch (e) {
    // 只关系到他自己：坏了就拒绝写（不覆盖），读当成空
    throw httpErr(409, `你的技能清单损坏了（${String(e?.message || e).slice(0, 120)}），请联系管理员`);
  }
}

function saveStore(root, store) {
  mkdirSync(root, { recursive: true });
  writeJson(registryOf(root), store, 2);
  rebuildAggregate(
    { dir: aggregateOf(root), name: AGG_NAME, description: '我自己添加的技能' },
    store.items,
    (item) => itemDir(root, item),
  );
}

// —— 列表 / 单项 ——
export function listMemberSkills(user) {
  const root = memberRoot(user);
  try { return readStore(root).items; } catch { return []; }
}
export function getMemberSkill(user, id) {
  return listMemberSkills(user).find((x) => x.id === String(id || '')) || null;
}

// —— 安装：.md 单文件 / .zip / .skill ——
export async function installMemberSkill(user, filename, buf, { replaceId, pkg } = {}) {
  const root = memberRoot(user);
  readStore(root);
  const staging = stagingDir();
  try {
    if (/\.md$/i.test(filename || '')) {
      mkdirSync(staging, { recursive: true });
      writeFileSync(path.join(staging, 'SKILL.md'), buf);
    } else {
      await extractArchive(buf, staging);
    }
    return installMemberSkillFromDir(user, staging, { replaceId, pkg });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function cleanSource(src) {
  if (!src || typeof src !== 'object') return null;
  const out = {};
  for (const k of ['market', 'plugin', 'path']) if (typeof src[k] === 'string' && src[k]) out[k] = stripCc(src[k]).slice(0, 200);
  return Object.keys(out).length ? out : null;
}

// 目录 → 他的注册表（上传与市场共用）。srcDir 会被就地清扫，调用方负责删掉。
export function installMemberSkillFromDir(user, srcDir, { replaceId, pkg, source } = {}) {
  const root = memberRoot(user);
  const store = readStore(root);
  if (!replaceId && store.items.length >= MEMBER_MAX_ITEMS) throw httpErr(400, `最多添加 ${MEMBER_MAX_ITEMS} 个技能`);
  sanitizeTree(srcDir);
  let base = srcDir;
  if (!existsSync(path.join(base, 'SKILL.md'))) {
    const subs = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory());
    const hit = subs.find((e) => existsSync(path.join(base, e.name, 'SKILL.md')));
    if (hit) base = path.join(base, hit.name);
    else throw httpErr(400, '包里找不到 SKILL.md（需在根目录或一级子目录）');
  }
  const fm = parseFrontmatter(readFileSync(path.join(base, 'SKILL.md'), 'utf8'));
  if (!fm || !fm.name || !fm.description) throw httpErr(400, 'SKILL.md 缺少 YAML frontmatter 的 name / description');
  const name = stripCc(fm.name).trim().slice(0, 80);
  const description = stripCc(fm.description).trim().slice(0, 1600);

  const old = replaceId ? store.items.find((x) => x.id === replaceId) : null;
  if (replaceId && !old) throw httpErr(404, '要替换的技能不存在');
  if (store.items.some((x) => x.name === name && x.id !== replaceId)) throw httpErr(409, `已存在同名技能「${name}」，可在其详情页选择「替换」`);

  const slug = slugify(name, newId());
  const dest = path.join(root, 'skills', slug);
  if (old) { const od = itemDir(root, old); if (od) rmSync(od, { recursive: true, force: true }); }
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.dirname(dest), { recursive: true });
  cpSync(base, dest, { recursive: true });

  const pkgName = pkg ? stripCc(pkg).trim().slice(0, 80) : (old?.pkg || '');
  const src = cleanSource(source) || old?.source || null;
  const stats = treeStats(dest);
  const item = {
    id: old ? old.id : newId(),
    type: 'skill',
    scope: 'member',
    name, description,
    ...(fm.version ? { version: stripCc(fm.version).slice(0, 40) } : {}),
    ...(pkgName ? { pkg: pkgName } : {}),
    ...(src ? { source: src } : {}),
    enabled: old ? old.enabled : true,
    agents: old ? old.agents : { claude: true, dimensio: true },
    dir: 'skills/' + slug,
    entry: 'SKILL.md',
    files: stats.files, size: stats.size,
    created: old ? old.created : now(), updated: now(),
  };
  if (old) store.items[store.items.indexOf(old)] = item;
  else store.items.push(item);
  saveStore(root, store);
  return item;
}

function applyAgents(item, patch) {
  for (const a of MEMBER_AGENTS) if (typeof patch?.[a] === 'boolean') item.agents = { ...(item.agents || {}), [a]: patch[a] };
  if (patch && typeof patch.codex === 'boolean' && patch.codex) throw httpErr(400, '成员的技能不支持 Codex');
}

export function updateMemberSkill(user, id, patch = {}) {
  const root = memberRoot(user);
  const store = readStore(root);
  const item = store.items.find((x) => x.id === String(id || ''));
  if (!item) throw httpErr(404, '技能不存在');
  if (typeof patch.enabled === 'boolean') item.enabled = patch.enabled;
  if (typeof patch.pkg === 'string') { const p = stripCc(patch.pkg).trim().slice(0, 80); if (p) item.pkg = p; }
  else if (patch.pkg === null) delete item.pkg;
  if (patch.agents) applyAgents(item, patch.agents);
  item.updated = now();
  saveStore(root, store);
  return item;
}

export function deleteMemberSkill(user, id) {
  const root = memberRoot(user);
  const store = readStore(root);
  const item = store.items.find((x) => x.id === String(id || ''));
  if (!item) return false;
  const dir = itemDir(root, item);
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  store.items = store.items.filter((x) => x.id !== item.id);
  saveStore(root, store);
  return true;
}

export function bulkMemberSkills(user, pkg, input = {}) {
  const name = String(pkg || '').trim();
  const root = memberRoot(user);
  const store = readStore(root);
  const members = store.items.filter((x) => x.pkg === name);
  if (!name || !members.length) throw httpErr(404, '没有找到该包里的技能');
  const action = input.action;
  if (action === 'enable' || action === 'disable') {
    for (const it of members) { it.enabled = action === 'enable'; it.updated = now(); }
  } else if (action === 'agents') {
    for (const it of members) { applyAgents(it, input.agents || {}); it.updated = now(); }
  } else if (action === 'delete') {
    for (const it of members) { const d = itemDir(root, it); if (d && existsSync(d)) rmSync(d, { recursive: true, force: true }); }
    store.items = store.items.filter((x) => x.pkg !== name);
  } else {
    throw httpErr(400, '未知的包操作：' + action);
  }
  saveStore(root, store);
  return { count: members.length };
}

// —— 详情页：文件树 / 单文件 / 打包下载用的目录 ——
export function memberSkillDir(user, id) {
  const item = getMemberSkill(user, id);
  return item ? itemDir(memberRoot(user), item) : null;
}
export function listMemberSkillFiles(user, id) {
  const dir = memberSkillDir(user, id);
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  const walk = (d, rel) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const r = rel ? rel + '/' + ent.name : ent.name;
      if (ent.isDirectory()) walk(path.join(d, ent.name), r);
      else { let size = 0; try { size = statSync(path.join(d, ent.name)).size; } catch {} out.push({ path: r, size }); }
      if (out.length >= 500) return;
    }
  };
  walk(dir, '');
  return out.sort((a, b) => (a.path === 'SKILL.md' ? 0 : 1) - (b.path === 'SKILL.md' ? 0 : 1) || a.path.localeCompare(b.path));
}
export function readMemberSkillFile(user, id, rel) {
  const dir = memberSkillDir(user, id);
  if (!dir) throw httpErr(404, '技能不存在');
  const abs = path.resolve(dir, String(rel || ''));
  if (abs !== dir && !abs.startsWith(dir + path.sep)) throw httpErr(400, '路径越界');
  if (!existsSync(abs) || !statSync(abs).isFile()) throw httpErr(404, '文件不存在');
  if (statSync(abs).size > 2 * 1024 * 1024) throw httpErr(400, '文件过大，不支持预览');
  return readFileSync(abs, 'utf8');
}

// 市场「已添加」标记（同 ext-market.installedKeys 的 skill 部分）
export function memberInstalledKeys(user) {
  return listMemberSkills(user).filter((x) => x.source?.market && x.source?.path).map((x) => `skill:${x.source.market}::${x.source.path}`);
}

// —— agent 注入 ——
// Claude：他自己的聚合插件（有勾给 claude 的启用技能才给）
export function memberClaudePlugins(user) {
  if (!user) return [];
  let root;
  try { root = memberRoot(user); } catch { return []; }
  const agg = aggregateOf(root);
  const has = listMemberSkills(user).some((x) => x.enabled && x.agents?.claude);
  return has && existsSync(path.join(agg, '.claude-plugin', 'plugin.json')) ? [{ type: 'local', path: agg }] : [];
}
// 沙箱只读放行的那棵目录（不存在就不给）
export function memberSkillRootIfAny(user) {
  if (!user) return null;
  try { const r = memberRoot(user); return existsSync(r) ? r : null; } catch { return null; }
}
// dimensio 成员实例：自己的注册表在前（同名时他自己的优先），全服清单在后
export function memberDimensioRegistries(user) {
  ensureSharedSkillsView();
  const own = registryOf(memberRoot(user));
  return [own, SHARED_SKILLS_VIEW];
}
