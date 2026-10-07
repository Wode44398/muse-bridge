// 扩展中心（Claude Desktop「Customize」同款三类：技能 Skill / 连接器 Connector / 插件 Plugin），
// bridge 统一托管、按 agent 勾选生效（claude / dimensio）。存储全落 DATA_ROOT/extensions/：
//   registry.json         元数据（id/type/name/描述/enabled/agents 矩阵/目录）；连接器只记凭据的键名
//   connector-secrets.*   连接器凭据（env / headers 的值）：AES-256-GCM 密文 + DPAPI 包住的数据密钥（S3，extension-secrets.mjs）
//   skills/<slug>/        技能解包目录（SKILL.md + 附属文件）
//   plugins/<slug>/       Claude Code 插件目录（.claude-plugin/plugin.json）
//   runtime/claude-plugin 聚合插件（生成物）：把「对 claude 生效」的技能 junction 进一个
//                         本地 plugin，经 Agent SDK options.plugins 注入（与 ~/.claude 的
//                         settingSources 无关，卸载即消失）。
//
// 三类扩展对两个 agent 的支持矩阵是硬编码事实（EXT_SUPPORT），不是配置：
//   skill     → claude（聚合插件）· dimensio（system prompt 渐进披露，见 harness/server/extensions.ts）
//   connector → claude（stdio/http/sse 全支持）· dimensio（stdio/http/sse，harness/server/mcp.ts；
//               凭据由 harness 按需从 connector-secrets.* 解开，新会话生效）
//   plugin    → 仅 claude（Claude Code 专属格式）
//
// 生效时机（各 agent 驱动语义不同，UI 脚注已说明）：claude 每轮 query 现读=下一条消息生效；
// dimensio 新会话生效（与 GUIDE.md 同契约）。
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync,
  statSync, symlinkSync, rmdirSync, lstatSync, cpSync,
} from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { ROOT } from './config/index.mjs';
import { writeJson } from './jsonfile.mjs';
import { readSecrets, writeSecrets } from './extension-secrets.mjs';

export const EXT_ROOT = path.join(ROOT, 'extensions');
export const EXT_REGISTRY_FILE = path.join(EXT_ROOT, 'registry.json');
const AGGREGATE_DIR = path.join(EXT_ROOT, 'runtime', 'claude-plugin');

const MAX_ITEMS = 200;
const httpErr = (status, msg) => Object.assign(new Error(msg), { status });
// 控制字符清洗（\p{Cc} 含 NUL~US 与 DEL），防名字/描述携带终端注入或破坏 JSON 展示。
const stripCc = (s) => String(s ?? '').replace(/\p{Cc}/gu, '');

// 支持矩阵（值为 false=该 agent 不支持此类型；'stdio'=仅 stdio 传输时支持）。
export const EXT_SUPPORT = {
  skill: { claude: true, dimensio: true },
  connector: { claude: true, dimensio: true },
  plugin: { claude: true, dimensio: false },
};

// 与 in-process MCP server 名撞车会静默顶掉内置能力，一律避让。
const RESERVED_MCP_KEYS = new Set(['snapshot', 'terminal', 'workspace']);

// 与 dimensio 沙箱的 secret 守卫同源：技能/插件包里不许携带凭据形状的文件（解包时剔除），
// 否则 harness 的 Bash 凭据闸会把整个技能目录的调用拦死，还容易把真凭据传播出去。
const SECRET_FILE_RE = /(^|[/\\])(\.env(\.[^/\\]*)?|\.git-credentials|id_rsa|id_ed25519|\.netrc|credentials\.json)$|\.(pem|key)$/i;

// G10：注册表读取分清「没有」和「坏了」。以前坏了就静默当成空表——列表一片空白、没人知道为什么，而且下一次
// 保存就把整张表覆盖成只剩那一项。现在坏了：列表照样空着但诊断里说清楚，写操作一律拒绝（不覆盖它）。
let registryError = null;

function readStore() {
  registryError = null;
  let data = { items: [] };
  if (existsSync(EXT_REGISTRY_FILE)) {
    try {
      let text = readFileSync(EXT_REGISTRY_FILE, 'utf8');
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      const o = JSON.parse(text);
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('不是 JSON 对象');
      data = o;
    } catch (e) {
      registryError = `registry.json 解析失败（${String(e?.message || e).slice(0, 120)}）`;
    }
  }
  const store = { items: (Array.isArray(data.items) ? data.items : []).filter((x) => x && typeof x.id === 'string' && typeof x.name === 'string' && x.type) };
  if (!registryError) migrateLegacySecrets(store);
  return store;
}

function readStoreForWrite() {
  const store = readStore();
  if (registryError) throw httpErr(409, `${registryError}。为了不把它覆盖掉，扩展中心暂停写入——修好或挪走 extensions/registry.json 后再试`);
  return store;
}

function saveStore(store) {
  mkdirSync(EXT_ROOT, { recursive: true });
  writeJson(EXT_REGISTRY_FILE, store, 2);
  rebuildClaudeAggregate(store);
}

// —— S3（#36、X02）：连接器凭据不进注册表 ——
// 注册表里只留键名（connector.envKeys / headerKeys），值在加密存储里（extension-secrets.mjs）。对外（API、前端）
// 的样子只给键名、值一律打码；只有注入 agent 时才解密。旧注册表里的明文在读到时挪进去。
export const SECRET_MASK = '••••••••';
const hasValues = (o) => !!o && typeof o === 'object' && Object.keys(o).length > 0;

// 旧注册表的明文凭据挪进加密存储：先写密文、解回来核对，再把注册表里的明文抹掉。失败就原样留着（明文照样能用，
// 诊断里标出来），十分钟内不再重试——每轮 query 都读注册表，别每次都去起 PowerShell。
let migrateRetryAt = 0;
let migrateError = null;
function migrateLegacySecrets(store) {
  const legacy = store.items.filter((x) => x.type === 'connector' && x.connector && (hasValues(x.connector.env) || hasValues(x.connector.headers)));
  if (!legacy.length || Date.now() < migrateRetryAt) return;
  try {
    const secrets = { ...readSecrets(EXT_ROOT) };
    for (const item of legacy) {
      const c = item.connector;
      const cur = secrets[item.id] || {};
      const env = { ...(cur.env || {}), ...(c.env || {}) };
      const headers = { ...(cur.headers || {}), ...(c.headers || {}) };
      secrets[item.id] = { ...(hasValues(env) ? { env } : {}), ...(hasValues(headers) ? { headers } : {}) };
    }
    writeSecrets(EXT_ROOT, secrets);
    for (const item of legacy) {
      const c = item.connector;
      if (hasValues(c.env)) c.envKeys = [...new Set([...(c.envKeys || []), ...Object.keys(c.env)])];
      if (hasValues(c.headers)) c.headerKeys = [...new Set([...(c.headerKeys || []), ...Object.keys(c.headers)])];
      delete c.env;
      delete c.headers;
    }
    writeJson(EXT_REGISTRY_FILE, store, 2);
    migrateError = null;
    console.log(`[extensions] ${legacy.length} 个连接器的明文凭据已挪进加密存储`);
  } catch (e) {
    migrateError = String(e?.message || e);
    migrateRetryAt = Date.now() + 10 * 60_000;
    console.error('[extensions] 连接器凭据挪进加密存储失败（明文照旧可用）：', migrateError);
  }
}

// 这个连接器此刻的凭据明文：加密存储里的 + 还没迁移走的明文
function connectorCreds(item, secrets) {
  const c = item.connector || {};
  const s = secrets?.[item.id] || {};
  return { env: { ...(c.env || {}), ...(s.env || {}) }, headers: { ...(c.headers || {}), ...(s.headers || {}) } };
}

const needsSecrets = (items) => items.some((x) => (x.type === 'connector' && ((x.connector?.envKeys || []).length || (x.connector?.headerKeys || []).length))
  || (x.type === 'plugin' && (x.configKeys || []).length));

// 注入 agent 用：解不开就只能不带凭据注入（诊断里会标出来），不许拖垮整轮 query
function secretsForInjection(items) {
  if (!needsSecrets(items)) return {};
  try {
    return readSecrets(EXT_ROOT);
  } catch (e) {
    console.error('[extensions] 连接器凭据解不开，本轮不带凭据注入：', String(e?.message || e));
    return {};
  }
}

// 对外的样子：凭据只给键名，值一律打码。插件现读目录带上配置表单与内容清单（目录即真相，替换后自然更新）。
function publicItem(item) {
  if (item?.type === 'plugin') {
    const dir = extensionDir(item);
    if (!dir || !existsSync(dir)) return item;
    const meta = pluginManifest(dir);
    const fields = pluginConfigFields(dir, meta);
    const { configValues, configKeys, ...rest } = item;
    const values = { ...(configValues || {}), ...Object.fromEntries((configKeys || []).map((k) => [k, SECRET_MASK])) };
    return { ...rest, contents: pluginContents(dir, meta), config: { fields, values, missing: missingConfig(item, fields) } };
  }
  if (item?.type !== 'connector' || !item.connector) return item;
  const { env, headers, envKeys, headerKeys, ...rest } = item.connector;
  const mask = (keys) => Object.fromEntries([...new Set(keys)].map((k) => [k, SECRET_MASK]));
  const conn = { ...rest };
  if (rest.transport === 'stdio') conn.env = mask([...(envKeys || []), ...Object.keys(env || {})]);
  else conn.headers = mask([...(headerKeys || []), ...Object.keys(headers || {})]);
  return { ...item, connector: conn };
}

// 表单回传的值是打码占位符 = 这一项没改，沿用旧值（旧值里没有这一项就丢掉）
function resolveMasked(input, old) {
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (v === SECRET_MASK) {
      if (old && k in old) out[k] = old[k];
    } else {
      out[k] = v;
    }
  }
  return out;
}

// 删掉这些扩展的凭据（解不开就算了——那些凭据本来就用不上了）
function dropSecrets(ids) {
  try {
    const secrets = { ...readSecrets(EXT_ROOT) };
    let changed = false;
    for (const id of ids) if (id in secrets) { delete secrets[id]; changed = true; }
    if (changed) writeSecrets(EXT_ROOT, secrets);
  } catch (e) {
    console.error('[extensions] 删除连接器凭据失败：', String(e?.message || e));
  }
}

const now = () => Date.now();
const newId = () => 'x' + crypto.randomBytes(8).toString('hex');
// 目录名安全化：只留常规字符，防路径注入；全非常规字符（如纯中文名）就退回 id。
const slugify = (name, fallback) => (String(name).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60)) || fallback;

// —— frontmatter 解析（只认 SKILL.md 需要的 name/description/version 三项，容错手写，不引 yaml 库）——
// 支持单行值（含引号）与 |/> 块标量（后续缩进行拼接）。
export function parseFrontmatter(md) {
  let text = String(md || '');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);   // 剥 BOM
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text);
  if (!m) return null;
  const lines = m[1].split(/\r?\n/);
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description|version)\s*:\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let val = kv[2].trim();
    if (/^[|>][+-]?$/.test(val)) {   // 块标量：吃掉后续更深缩进的行
      const buf = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) buf.push(lines[++i].trim());
      while (buf.length && !buf[buf.length - 1]) buf.pop();
      val = buf.join(val.startsWith('|') ? '\n' : ' ');
    } else {
      val = val.replace(/^["']|["']$/g, '');
    }
    out[kv[1]] = val;
  }
  return out;
}

// —— zip 收发：bsdtar 既解 zip 也打 zip，不引依赖 ——
// 必须钉死 System32 的 tar.exe：裸跑 'tar' 走 PATH 可能命中 Git 的 GNU tar，它把
// `C:\...` 当「主机:路径」远程语法直接报 "Cannot connect to C"（files.mjs 同款结论）。
const firstExisting = (list) => list.find((p) => { try { return statSync(p).isFile(); } catch { return false; } });
const BSDTAR = () => firstExisting(['C:\\Windows\\System32\\tar.exe', '/usr/bin/bsdtar', '/usr/bin/tar']) || 'tar';
const execFileAsync = promisify(execFile);
const runTar = (args) => execFileAsync(BSDTAR(), args, {
  windowsHide: true,
  timeout: 60_000,
  maxBuffer: 2 * 1024 * 1024,
});

async function extractArchive(buf, destDir) {
  mkdirSync(destDir, { recursive: true });
  const tmpFile = path.join(destDir, '..', `.up-${crypto.randomBytes(4).toString('hex')}.bin`);
  writeFileSync(tmpFile, buf);
  try {
    // 双试（files.mjs 先例）：裸跑兼容 GBK 名 zip；UTF-8 名报错再补 hdrcharset=UTF-8。
    try {
      await runTar(['-xf', tmpFile, '-C', destDir]);
    } catch {
      await runTar(['--options', 'hdrcharset=UTF-8', '-xf', tmpFile, '-C', destDir]);
    }
  } catch (e) {
    throw httpErr(400, '压缩包无法解开（支持 .zip / .skill）：' + String(e.stderr || e.message).slice(0, 200));
  } finally {
    rmSync(tmpFile, { force: true });
  }
}

export async function packExtensionZip(item) {
  const dir = extensionDir(item);
  if (!dir) throw httpErr(400, '该扩展没有文件目录');
  return zipDir(dir);
}

// 把一个目录整棵打成 zip（Buffer）。下载与「从目录安装」（extensions-catalog.mjs）共用。
export async function zipDir(dir) {
  const out =path.join(EXT_ROOT, 'runtime', `.dl-${crypto.randomBytes(4).toString('hex')}.zip`);
  mkdirSync(path.dirname(out), { recursive: true });
  try {
    // hdrcharset=UTF-8：bsdtar 造 zip 默认按系统 ANSI 码页写文件名，中文名下载后乱码（deliverables 同款）。
    await runTar(['--options', 'hdrcharset=UTF-8', '-a', '-cf', out, '-C', dir, '.']);
    return await readFile(out);
  } finally { try { await rm(out, { force: true }); } catch {} }
}

// 解包后的安全清扫：剔除凭据形状文件与符号链接（zip 里塞 symlink 可指向包外）。
function sanitizeTree(dir) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isSymbolicLink()) { rmSync(p, { recursive: true, force: true }); continue; }
    if (ent.isDirectory()) { sanitizeTree(p); continue; }
    if (SECRET_FILE_RE.test(ent.name)) rmSync(p, { force: true });
  }
}

function treeStats(dir) {
  let files = 0, size = 0;
  const walk = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else { files++; try { size += statSync(p).size; } catch {} }
    }
  };
  try { walk(dir); } catch {}
  return { files, size };
}

export function extensionDir(item) {
  if (!item || !item.dir) return null;
  const abs = path.resolve(EXT_ROOT, item.dir);
  if (abs !== EXT_ROOT && !abs.startsWith(EXT_ROOT + path.sep)) return null;   // 防注册表被手改出穿越
  return abs;
}

// 「从目录安装」（extensions-catalog.mjs：插件目录里的条目）不走压缩包：整棵复制进暂存区（.git 不带）再走同一套校验。
function stageFromDir(src, staging) {
  mkdirSync(path.dirname(staging), { recursive: true });
  cpSync(src, staging, { recursive: true, filter: (p) => path.basename(p) !== '.git' });
}

// —— 安装：技能（.md 单文件 / .zip / .skill；fromDir = 直接从一个目录装）——
export async function installSkill(filename, buf, { replaceId, pkg, fromDir, catalogId } = {}) {
  const store = readStoreForWrite();
  if (store.items.length >= MAX_ITEMS) throw httpErr(400, '扩展数量已达上限');
  const isMd = !fromDir && /\.md$/i.test(filename || '');
  const staging = path.join(EXT_ROOT, 'runtime', `.stage-${crypto.randomBytes(4).toString('hex')}`);
  try {
    if (isMd) {
      mkdirSync(staging, { recursive: true });
      writeFileSync(path.join(staging, 'SKILL.md'), buf);
    } else {
      if (fromDir) stageFromDir(fromDir, staging);
      else await extractArchive(buf, staging);
      sanitizeTree(staging);
    }
    // SKILL.md 可以在根，也可以在唯一一层子目录里（zip 常见「文件夹套一层」）。
    let base = staging;
    if (!existsSync(path.join(base, 'SKILL.md'))) {
      const subs = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory());
      const hit = subs.find((e) => existsSync(path.join(base, e.name, 'SKILL.md')));
      if (hit) base = path.join(base, hit.name);
      else throw httpErr(400, '包里找不到 SKILL.md（需在根目录或一级子目录）');
    }
    const fm = parseFrontmatter(readFileSync(path.join(base, 'SKILL.md'), 'utf8'));
    if (!fm || !fm.name || !fm.description) throw httpErr(400, 'SKILL.md 缺少 YAML frontmatter 的 name / description');
    fm.name = stripCc(fm.name).trim().slice(0, 80);
    fm.description = stripCc(fm.description).trim().slice(0, 1600);

    const dup = store.items.find((x) => x.type === 'skill' && x.name === fm.name && x.id !== replaceId);
    if (dup) throw httpErr(409, `已存在同名技能「${fm.name}」，可在其详情页选择「替换」`);
    const old = replaceId ? store.items.find((x) => x.id === replaceId && x.type === 'skill') : null;
    if (replaceId && !old) throw httpErr(404, '要替换的技能不存在');

    const slug = slugify(fm.name, newId());
    const dest = path.join(EXT_ROOT, 'skills', slug);
    if (old) { const od = extensionDir(old); if (od) rmSync(od, { recursive: true, force: true }); }
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(base, dest, { recursive: true });

    const pkgName = pkg ? stripCc(pkg).trim().slice(0, 80) : (old?.pkg || '');
    const stats = treeStats(dest);
    const item = {
      id: old ? old.id : newId(),
      type: 'skill',
      name: fm.name,
      description: fm.description,
      ...(fm.version ? { version: stripCc(fm.version).slice(0, 40) } : {}),
      ...(pkgName ? { pkg: pkgName } : {}),
      enabled: old ? old.enabled : true,
      agents: old ? old.agents : { claude: true, dimensio: true },
      ...(catalogId || old?.catalogId ? { catalogId: catalogId || old.catalogId } : {}),   // 从「发现」装的：目录里的 id（名字可能和目录不一样）
      dir: 'skills/' + slug,
      entry: 'SKILL.md',
      files: stats.files, size: stats.size,
      created: old ? old.created : now(), updated: now(),
    };
    if (old) store.items[store.items.indexOf(old)] = item;
    else store.items.push(item);
    saveStore(store);
    return item;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// —— 安装：Claude Code 插件（.zip，需 .claude-plugin/plugin.json；fromDir = 直接从一个目录装）——
// manifest：目录条目里 strict:false 的插件没有自己的 plugin.json，定义写在条目里——由调用方传进来补一份。
export async function installPlugin(filename, buf, { replaceId, pkg, fromDir, manifest, source, catalogId } = {}) {
  const store = readStoreForWrite();
  if (store.items.length >= MAX_ITEMS) throw httpErr(400, '扩展数量已达上限');
  const staging = path.join(EXT_ROOT, 'runtime', `.stage-${crypto.randomBytes(4).toString('hex')}`);
  try {
    if (fromDir) stageFromDir(fromDir, staging);
    else await extractArchive(buf, staging);
    sanitizeTree(staging);
    if (manifest) {
      const pj = path.join(staging, '.claude-plugin', 'plugin.json');
      if (!existsSync(pj)) {
        mkdirSync(path.dirname(pj), { recursive: true });
        writeFileSync(pj, JSON.stringify(manifest, null, 2));
      } else {
        // 有自己 plugin.json 的：目录条目里写的组件路径作补充（官方同款），plugin.json 自己有的不动
        const own = readJsonFile(pj);
        if (own && typeof own === 'object') {
          let changed = false;
          for (const k of ['skills', 'commands', 'agents', 'hooks', 'mcpServers', 'lspServers', 'userConfig']) {
            if (!(k in own) && k in manifest) { own[k] = manifest[k]; changed = true; }
          }
          if (changed) writeFileSync(pj, JSON.stringify(own, null, 2));
        }
      }
    }
    let base = staging;
    if (!existsSync(path.join(base, '.claude-plugin', 'plugin.json'))) {
      const subs = readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory());
      const hit = subs.find((e) => existsSync(path.join(base, e.name, '.claude-plugin', 'plugin.json')));
      if (hit) base = path.join(base, hit.name);
      else throw httpErr(400, '包里找不到 .claude-plugin/plugin.json（不是有效的 Claude Code 插件）');
    }
    let meta;
    try { meta = JSON.parse(readFileSync(path.join(base, '.claude-plugin', 'plugin.json'), 'utf8')); }
    catch { throw httpErr(400, 'plugin.json 不是有效 JSON'); }
    const name = stripCc(meta.name).trim().slice(0, 80);
    if (!name) throw httpErr(400, 'plugin.json 缺少 name');

    const dup = store.items.find((x) => x.type === 'plugin' && x.name === name && x.id !== replaceId);
    if (dup) throw httpErr(409, `已存在同名插件「${name}」，可在其详情页选择「替换」`);
    const old = replaceId ? store.items.find((x) => x.id === replaceId && x.type === 'plugin') : null;
    if (replaceId && !old) throw httpErr(404, '要替换的插件不存在');

    const slug = slugify(name, newId());
    const dest = path.join(EXT_ROOT, 'plugins', slug);
    if (old) { const od = extensionDir(old); if (od) rmSync(od, { recursive: true, force: true }); }
    if (existsSync(dest)) rmSync(dest, { recursive: true, force: true });
    mkdirSync(path.dirname(dest), { recursive: true });
    cpSync(base, dest, { recursive: true });

    const pkgName = pkg ? stripCc(pkg).trim().slice(0, 80) : (old?.pkg || '');
    const stats = treeStats(dest);
    const item = {
      id: old ? old.id : newId(),
      type: 'plugin',
      name,
      description: stripCc(meta.description).trim().slice(0, 500),
      ...(meta.version ? { version: stripCc(meta.version).slice(0, 40) } : {}),
      ...(pkgName ? { pkg: pkgName } : {}),
      enabled: old ? old.enabled : true,
      agents: old ? old.agents : { claude: true, dimensio: false },
      ...(source || old?.source ? { source: source || old.source } : {}),
      ...(catalogId || old?.catalogId ? { catalogId: catalogId || old.catalogId } : {}),   // 从哪个目录装的（「自定义」页显示来源）
      ...(old?.configValues ? { configValues: old.configValues } : {}),      // 替换版本不丢配置
      ...(old?.configKeys ? { configKeys: old.configKeys } : {}),
      dir: 'plugins/' + slug,
      entry: '.claude-plugin/plugin.json',
      files: stats.files, size: stats.size,
      created: old ? old.created : now(), updated: now(),
    };
    if (old) store.items[store.items.indexOf(old)] = item;
    else store.items.push(item);
    saveStore(store);
    return item;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// —— 连接器（MCP server 定义表单，无文件目录）——
export function saveConnector(input = {}) {
  const store = readStoreForWrite();
  const id = input.id ? String(input.id) : null;
  const old = id ? store.items.find((x) => x.id === id && x.type === 'connector') : null;
  if (id && !old) throw httpErr(404, '连接器不存在');
  if (!old && store.items.length >= MAX_ITEMS) throw httpErr(400, '扩展数量已达上限');

  const name = stripCc(input.name).trim().slice(0, 60);
  if (!name) throw httpErr(400, '请输入连接器名称');
  const transport = ['stdio', 'http', 'sse'].includes(input.transport) ? input.transport : 'stdio';
  // S3：凭据明文只在这里过一手，进加密存储；注册表只记键名。编辑时表单回传的打码占位符 = 沿用旧值。
  let secrets = null;
  const loadSecrets = () => {
    if (secrets) return secrets;
    try { secrets = { ...readSecrets(EXT_ROOT) }; }
    catch (e) { throw httpErr(500, `连接器凭据的加密存储打不开（${String(e?.message || e)}），这次没保存`); }
    return secrets;
  };
  const oldCreds = old ? connectorCreds(old, needsSecrets([old]) ? loadSecrets() : {}) : { env: {}, headers: {} };
  const conn = { transport };
  const creds = {};
  if (transport === 'stdio') {
    conn.command = stripCc(input.command).trim();
    if (!conn.command) throw httpErr(400, 'stdio 连接器需要启动命令');
    conn.args = (Array.isArray(input.args) ? input.args : []).map((a) => stripCc(a)).filter(Boolean).slice(0, 64);
    const env = resolveMasked(sanitizeKV(input.env), oldCreds.env);
    if (hasValues(env)) creds.env = env;
    conn.envKeys = Object.keys(env);
  } else {
    conn.url = stripCc(input.url).trim();
    if (!/^https?:\/\//i.test(conn.url)) throw httpErr(400, '请填写有效的 http(s) 地址');
    const headers = resolveMasked(sanitizeKV(input.headers), oldCreds.headers);
    if (hasValues(headers)) creds.headers = headers;
    conn.headerKeys = Object.keys(headers);
  }
  // MCP server 键名：slug 化 + 内置保留名避让（撞名会顶掉内置能力）。
  let key = old?.connector?.key || slugify(name, 'connector');
  if (RESERVED_MCP_KEYS.has(key.toLowerCase())) key = 'ext-' + key;
  const dupKey = store.items.find((x) => x.type === 'connector' && x.connector?.key === key && x.id !== (old ? old.id : null));
  if (dupKey) key = key + '-' + crypto.randomBytes(2).toString('hex');
  conn.key = key;

  const dupName = store.items.find((x) => x.type === 'connector' && x.name === name && x.id !== (old ? old.id : null));
  if (dupName) throw httpErr(409, `已存在同名连接器「${name}」`);

  const item = {
    id: old ? old.id : newId(),
    type: 'connector',
    name,
    description: stripCc(input.description).trim().slice(0, 500),
    ...(input.pkg ? { pkg: stripCc(input.pkg).trim().slice(0, 80) } : old?.pkg ? { pkg: old.pkg } : {}),
    enabled: old ? old.enabled : true,
    agents: old ? old.agents : { claude: true, dimensio: false },
    ...(input.catalogId || old?.catalogId ? { catalogId: String(input.catalogId || old.catalogId).slice(0, 300) } : {}),
    connector: conn,
    created: old ? old.created : now(), updated: now(),
  };
  // 先存凭据（存不进去就整个不保存，绝不退回明文），再写注册表
  const storeCreds = () => {
    try { writeSecrets(EXT_ROOT, secrets); }
    catch (e) { throw httpErr(500, `连接器凭据加密保存失败（${String(e?.message || e)}），这次没保存`); }
  };
  if (hasValues(creds)) {
    loadSecrets()[item.id] = creds;
    storeCreds();
  } else if (old && needsSecrets([old])) {
    delete loadSecrets()[item.id];
    storeCreds();
  }
  if (old) store.items[store.items.indexOf(old)] = item;
  else store.items.push(item);
  saveStore(store);
  return publicItem(item);
}

function sanitizeKV(obj) {
  const out = {};
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const key = stripCc(k).trim().slice(0, 80);
      if (!key || /\s/.test(key)) continue;
      out[key] = stripCc(v).slice(0, 4000);
      if (Object.keys(out).length >= 40) break;
    }
  }
  return out;
}

// —— 插件配置（Claude Desktop「安装 → 配置」同款）——
// 配置项两个来源：plugin.json 的 userConfig（官方格式：title / description / type / sensitive / required / default / options，
// 在 MCP 配置里写成 ${user_config.KEY}），以及插件 MCP 配置里引用的 ${VAR} 环境变量（多半是令牌）。
// 值的去处：非敏感的记在注册表 configValues；敏感的进加密存储（与连接器凭据同一份，键 <id>.config），注册表只记键名 configKeys。
// 插件自带的 MCP 一律由宿主解析后注入（SDK skipMcpDiscovery）——CLI 读不到这里存的配置值。
const PLUGIN_VARS = new Set(['CLAUDE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA', 'CLAUDE_PROJECT_DIR']);
const VAR_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)?)(:-([^}]*))?\}/g;
const SENSITIVE_RE = /token|secret|key|password|passwd|auth|credential|cookie|pat$/i;

function readJsonFile(f) {
  try { return JSON.parse(readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch { return null; }
}
export function pluginManifest(dir) { return readJsonFile(path.join(dir, '.claude-plugin', 'plugin.json')) || {}; }

// 插件的 MCP 定义：.mcp.json（两种写法：顶层即 server 表 / 包在 mcpServers 里）+ plugin.json 的 mcpServers（对象或指向 json 的相对路径）
export function pluginMcpMap(dir, meta = pluginManifest(dir)) {
  const unwrap = (j) => (j && typeof j === 'object' ? (j.mcpServers && typeof j.mcpServers === 'object' ? j.mcpServers : j) : {});
  let fromMeta = {};
  if (typeof meta.mcpServers === 'string') {
    const f = path.resolve(dir, meta.mcpServers);
    if (f.startsWith(dir + path.sep)) fromMeta = unwrap(readJsonFile(f));
  } else if (meta.mcpServers && typeof meta.mcpServers === 'object') fromMeta = meta.mcpServers;
  const map = { ...unwrap(readJsonFile(path.join(dir, '.mcp.json'))), ...fromMeta };
  return Object.fromEntries(Object.entries(map).filter(([, c]) => c && typeof c === 'object' && !Array.isArray(c)));
}

// 配置表单字段（前端照着画表单）
export function pluginConfigFields(dir, meta = pluginManifest(dir)) {
  const fields = [];
  const seen = new Set();
  const uc = meta.userConfig && typeof meta.userConfig === 'object' ? meta.userConfig : {};
  for (const [key, f] of Object.entries(uc)) {
    if (!f || typeof f !== 'object' || seen.has(key)) continue;
    seen.add(key);
    fields.push({
      key, title: stripCc(f.title || key).slice(0, 80), description: stripCc(f.description || '').slice(0, 400),
      type: ['string', 'number', 'boolean', 'directory', 'file'].includes(f.type) ? f.type : 'string',
      sensitive: !!f.sensitive, required: !!f.required,
      ...(f.default !== undefined ? { default: f.default } : {}),
      ...(Array.isArray(f.options) ? { options: f.options.map(String).slice(0, 40) } : {}),
    });
  }
  const walk = (v) => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(VAR_RE)) {
        const name = m[1];
        if (PLUGIN_VARS.has(name) || name.startsWith('user_config.') || seen.has(name)) continue;
        seen.add(name);
        const hasDef = m[2] !== undefined;
        fields.push({
          key: name, title: name, description: '', type: 'string', env: true,
          sensitive: SENSITIVE_RE.test(name), required: !hasDef, ...(hasDef ? { default: m[3] } : {}),
        });
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(pluginMcpMap(dir, meta));
  return fields;
}

// 插件里装了什么（详情页「包含」一栏，与官方插件详情一致）：技能 / 命令 / 子 agent / MCP / hooks
export function pluginContents(dir, meta = pluginManifest(dir)) {
  const list = (sub, re) => { try { return readdirSync(path.join(dir, sub), { withFileTypes: true }).filter(re).map((e) => e.name); } catch { return []; } };
  const skills = new Set(list('skills', (e) => e.isDirectory() && existsSync(path.join(dir, 'skills', e.name, 'SKILL.md'))));
  for (const rel of Array.isArray(meta.skills) ? meta.skills : []) {
    const d = typeof rel === 'string' ? path.resolve(dir, rel) : '';
    if (d.startsWith(dir + path.sep) && existsSync(path.join(d, 'SKILL.md'))) skills.add(path.basename(d));
  }
  return {
    skills: [...skills].sort(),
    commands: list('commands', (e) => e.isFile() && /\.md$/i.test(e.name)).map((n) => n.replace(/\.md$/i, '')).sort(),
    agents: list('agents', (e) => e.isFile() && /\.md$/i.test(e.name)).map((n) => n.replace(/\.md$/i, '')).sort(),
    mcp: Object.keys(pluginMcpMap(dir, meta)).sort(),
    hooks: existsSync(path.join(dir, 'hooks', 'hooks.json')) || !!meta.hooks,
  };
}

// 此刻缺哪些必填项（没值、没默认、后端环境里也没有同名变量）
function missingConfig(item, fields) {
  const vals = item.configValues || {};
  const keys = new Set(item.configKeys || []);
  return fields.filter((f) => f.required && f.default === undefined && !(f.key in vals) && !keys.has(f.key)
    && !(f.env && process.env[f.key])).map((f) => f.key);
}

// 保存插件配置：values 里的打码占位符 = 沿用旧值；空串 = 清掉这一项
export function configureExtension(id, values = {}) {
  const store = readStoreForWrite();
  const item = store.items.find((x) => x.id === String(id || '') && x.type === 'plugin');
  if (!item) throw httpErr(404, '插件不存在');
  const dir = extensionDir(item);
  if (!dir || !existsSync(dir)) throw httpErr(404, '插件目录不在了');
  const fields = pluginConfigFields(dir);
  const plain = { ...(item.configValues || {}) };
  let secrets;
  try { secrets = { ...readSecrets(EXT_ROOT) }; }
  catch (e) { throw httpErr(500, `加密存储打不开（${String(e?.message || e)}），这次没保存`); }
  const sec = { ...(secrets[item.id]?.config || {}) };
  for (const f of fields) {
    if (!(f.key in values)) continue;
    let v = values[f.key];
    if (v === SECRET_MASK) continue;
    if (f.type === 'boolean') v = v === true || v === 'true';
    else if (f.type === 'number') v = v === '' || v == null ? '' : Number(v);
    else v = stripCc(Array.isArray(v) ? v.join(',') : v).slice(0, 4000);
    const empty = v === '' || (typeof v === 'number' && Number.isNaN(v));
    if (f.sensitive) { if (empty) delete sec[f.key]; else sec[f.key] = String(v); delete plain[f.key]; }
    else { if (empty) delete plain[f.key]; else plain[f.key] = v; }
  }
  const rest = { ...(secrets[item.id] || {}) };
  if (Object.keys(sec).length) rest.config = sec; else delete rest.config;
  if (Object.keys(rest).length) secrets[item.id] = rest; else delete secrets[item.id];
  try { writeSecrets(EXT_ROOT, secrets); }
  catch (e) { throw httpErr(500, `配置加密保存失败（${String(e?.message || e)}），这次没保存`); }
  item.configValues = plain;
  item.configKeys = Object.keys(sec);
  if (!item.configKeys.length) delete item.configKeys;
  item.updated = now();
  saveStore(store);
  return publicItem(item);
}

// 插件 MCP → SDK mcpServers：${CLAUDE_PLUGIN_ROOT} 换成插件目录，${user_config.K} / ${VAR} 依次取配置值、后端环境、
// ${VAR:-默认}、userConfig 的 default；还解不开（必填项没填）的那条 server 不带，免得带着字面量 ${…} 去连。
function pluginMcpServers(item, dir, secrets, taken) {
  const meta = pluginManifest(dir);
  const fields = pluginConfigFields(dir, meta);
  const defs = Object.fromEntries(fields.filter((f) => f.default !== undefined).map((f) => [f.key, f.default]));
  const vals = { ...(item.configValues || {}), ...(secrets?.[item.id]?.config || {}) };
  const dataDir = path.join(EXT_ROOT, 'runtime', 'plugin-data', path.basename(dir));
  const lookup = (name, def) => {
    if (name === 'CLAUDE_PLUGIN_ROOT') return dir;
    if (name === 'CLAUDE_PLUGIN_DATA') { mkdirSync(dataDir, { recursive: true }); return dataDir; }
    const key = name.startsWith('user_config.') ? name.slice(12) : name;
    if (key in vals) return String(vals[key]);
    if (!name.startsWith('user_config.') && process.env[name] != null) return process.env[name];
    if (def !== undefined) return def;
    if (key in defs) return String(defs[key]);
    return undefined;
  };
  const expand = (v) => {
    if (typeof v === 'string') {
      return v.replace(VAR_RE, (m, name, d, def) => {
        const r = lookup(name, d !== undefined ? def : undefined);
        if (r === undefined) throw new Error('unresolved');
        return r;
      });
    }
    if (Array.isArray(v)) return v.map(expand);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expand(x)]));
    return v;
  };
  // userConfig 也以 CLAUDE_PLUGIN_OPTION_<KEY> 环境变量交给插件的 stdio server（官方约定）
  const optEnv = {};
  for (const f of fields) if (!f.env) { const r = lookup('user_config.' + f.key); if (r !== undefined) optEnv['CLAUDE_PLUGIN_OPTION_' + f.key.toUpperCase()] = r; }
  const out = {};
  for (const [key, raw] of Object.entries(pluginMcpMap(dir, meta))) {
    let c;
    try { c = expand(raw); } catch { continue; }
    const t = c.type === 'http' || c.type === 'sse' ? c.type : (c.url && !c.command ? 'http' : 'stdio');
    let cfg;
    if (t === 'stdio') {
      if (typeof c.command !== 'string' || !c.command) continue;
      const env = { ...optEnv, ...(c.env && typeof c.env === 'object' ? c.env : {}) };
      cfg = { type: 'stdio', command: c.command, args: Array.isArray(c.args) ? c.args.map(String) : [], ...(hasValues(env) ? { env } : {}), ...(c.cwd ? { cwd: String(c.cwd) } : {}) };
    } else {
      if (typeof c.url !== 'string' || !/^https?:\/\//i.test(c.url)) continue;
      const headers = Object.fromEntries(Object.entries(c.headers || {}).filter(([, v]) => String(v).trim()));
      cfg = { type: t, url: c.url, ...(hasValues(headers) ? { headers } : {}) };
    }
    let k = key;
    if (RESERVED_MCP_KEYS.has(k.toLowerCase()) || taken[k] || out[k]) k = slugify(`${item.name}-${key}`, item.id);
    while (RESERVED_MCP_KEYS.has(k.toLowerCase()) || taken[k] || out[k]) k += '-x';
    out[k] = cfg;
  }
  return out;
}

// —— 通用 CRUD ——
// 对外的列表：连接器凭据只给键名、值打码（S3：凭据不出服务端）
export function listExtensions() {
  return readStore().items.map(publicItem);
}

export function getExtension(id) {
  return publicItem(readStore().items.find((x) => x.id === String(id || '')) || null);
}

export function updateExtension(id, patch = {}) {
  const store = readStoreForWrite();
  const item = store.items.find((x) => x.id === String(id || ''));
  if (!item) throw httpErr(404, '扩展不存在');
  if (typeof patch.enabled === 'boolean') item.enabled = patch.enabled;
  // 包归属：传字符串归入/改包，传 null 移出包（散装）。
  if (typeof patch.pkg === 'string') { const p = stripCc(patch.pkg).trim().slice(0, 80); if (p) item.pkg = p; }
  else if (patch.pkg === null) delete item.pkg;
  if (patch.agents && typeof patch.agents === 'object') {
    const support = EXT_SUPPORT[item.type] || {};
    for (const a of ['claude', 'dimensio']) {
      if (typeof patch.agents[a] !== 'boolean') continue;
      if (patch.agents[a] && !support[a]) throw httpErr(400, `该类型扩展不支持 ${a}`);
      item.agents[a] = patch.agents[a];
    }
  }
  item.updated = now();
  saveStore(store);
  return publicItem(item);
}

export function deleteExtension(id) {
  const store = readStoreForWrite();
  const item = store.items.find((x) => x.id === String(id || ''));
  if (!item) return false;
  const dir = extensionDir(item);
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  store.items = store.items.filter((x) => x.id !== item.id);
  saveStore(store);
  if (needsSecrets([item])) dropSecrets([item.id]);
  return true;
}

// —— 包级批量操作：以 pkg 为单位启停 / 勾选 agent / 整包卸载（散装项无 pkg，不受影响）——
export function bulkByPkg(pkg, input = {}) {
  const name = String(pkg || '').trim();
  const store = readStoreForWrite();
  const members = store.items.filter((x) => x.pkg === name);
  if (!name || !members.length) throw httpErr(404, '没有找到该包里的扩展');
  const action = input.action;
  if (action === 'enable' || action === 'disable') {
    const v = action === 'enable';
    for (const it of members) { it.enabled = v; it.updated = now(); }
  } else if (action === 'agents') {
    const patch = input.agents || {};
    for (const it of members) {
      const sup = EXT_SUPPORT[it.type] || {};
      for (const a of ['claude', 'dimensio']) {
        if (typeof patch[a] !== 'boolean') continue;
        // 包内类型可能混合：不支持的组合逐项跳过，不整体报错。
        if (patch[a] && !sup[a]) continue;
        it.agents = { ...(it.agents || {}), [a]: patch[a] };
      }
      it.updated = now();
    }
  } else if (action === 'delete') {
    for (const it of members) { const d = extensionDir(it); if (d && existsSync(d)) rmSync(d, { recursive: true, force: true }); }
    store.items = store.items.filter((x) => x.pkg !== name);
  } else {
    throw httpErr(400, '未知的包操作：' + action);
  }
  saveStore(store);
  if (action === 'delete') {
    const withSecrets = members.filter((it) => needsSecrets([it])).map((it) => it.id);
    if (withSecrets.length) dropSecrets(withSecrets);
  }
  return { count: members.length };
}

// —— 详情页文件面：树列表 + 单文件读取（严格锁在该扩展目录内）——
export function listExtensionFiles(id) {
  const item = getExtension(id);
  const dir = item && extensionDir(item);
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
  const entry = item.entry || '';
  return out.sort((a, b) => (a.path === entry ? 0 : 1) - (b.path === entry ? 0 : 1) || a.path.localeCompare(b.path));
}

export function readExtensionFile(id, rel) {
  const item = getExtension(id);
  const dir = item && extensionDir(item);
  if (!dir) throw httpErr(404, '扩展不存在');
  const abs = path.resolve(dir, String(rel || ''));
  if (abs !== dir && !abs.startsWith(dir + path.sep)) throw httpErr(400, '路径越界');
  if (!existsSync(abs) || !statSync(abs).isFile()) throw httpErr(404, '文件不存在');
  if (statSync(abs).size > 2 * 1024 * 1024) throw httpErr(400, '文件过大，不支持预览');
  return readFileSync(abs, 'utf8');
}

// —— Claude 聚合插件：skills/<name> junction → 各技能目录 ——
// 每次注册表变更后重建；query() 只拿现成目录，路径稳定所以 SDK 侧无需感知重建。
function rebuildClaudeAggregate(store = readStore()) {
  const skillsDir = path.join(AGGREGATE_DIR, 'skills');
  try {
    // 逐个拆链再删目录：junction 用 rmdir 删链接本身；rmSync recursive 兜底普通目录。
    if (existsSync(skillsDir)) {
      for (const ent of readdirSync(skillsDir, { withFileTypes: true })) {
        const p = path.join(skillsDir, ent.name);
        try { if (lstatSync(p).isSymbolicLink()) { rmdirSync(p); continue; } } catch {}
        rmSync(p, { recursive: true, force: true });
      }
    }
    const active = store.items.filter((x) => x.type === 'skill' && x.enabled && x.agents?.claude);
    mkdirSync(path.join(AGGREGATE_DIR, '.claude-plugin'), { recursive: true });
    writeJson(path.join(AGGREGATE_DIR, '.claude-plugin', 'plugin.json'), { name: 'bridge', description: 'Bridge 扩展中心托管的技能', version: '1.0.0' }, 2);
    mkdirSync(skillsDir, { recursive: true });
    for (const item of active) {
      const src = extensionDir(item);
      if (!src || !existsSync(src)) continue;
      const link = path.join(skillsDir, path.basename(item.dir));
      try { symlinkSync(src, link, 'junction'); }
      catch { try { cpSync(src, link, { recursive: true }); } catch {} }   // 文件系统不支持 junction 时退化为复制
    }
  } catch (e) {
    console.error('[extensions] 聚合插件重建失败：', e?.message || e);
  }
}

// —— agent 驱动侧读取（现读现取，注册表即真相）——

// Claude：options.plugins + options.mcpServers 增量。仅 admin 非沙箱会话注入。
export function claudeExtensionOptions() {
  const items = readStore().items.filter((x) => x.enabled);
  const plugins = [];
  const hasSkills = items.some((x) => x.type === 'skill' && x.agents?.claude);
  if (hasSkills && existsSync(path.join(AGGREGATE_DIR, '.claude-plugin', 'plugin.json'))) {
    plugins.push({ type: 'local', path: AGGREGATE_DIR, skipMcpDiscovery: true });
  }
  const mcpServers = {};
  const conns = items.filter((x) => x.type === 'connector' && x.agents?.claude && x.connector);
  const plugs = items.filter((x) => x.type === 'plugin' && x.agents?.claude);
  const secrets = secretsForInjection([...conns, ...plugs]);
  for (const item of conns) {
    const c = item.connector;
    const { env, headers } = connectorCreds(item, secrets);
    mcpServers[c.key || slugify(item.name, item.id)] =
      c.transport === 'stdio'
        ? { type: 'stdio', command: c.command, args: c.args || [], ...(hasValues(env) ? { env } : {}) }
        : { type: c.transport, url: c.url, ...(hasValues(headers) ? { headers } : {}) };
  }
  // 插件：技能 / 命令 / agent / hooks 由 CLI 从目录加载；MCP 由这里按存好的配置解析后显式传（skipMcpDiscovery）
  for (const item of plugs) {
    const dir = extensionDir(item);
    if (!dir || !existsSync(dir)) continue;
    plugins.push({ type: 'local', path: dir, skipMcpDiscovery: true });
    try { Object.assign(mcpServers, pluginMcpServers(item, dir, secrets, mcpServers)); }
    catch (e) { console.error(`[extensions] 插件「${item.name}」的 MCP 解析失败：`, String(e?.message || e)); }
  }
  return { plugins, mcpServers };
}

// —— G10：注册表与连接器诊断（设置页扩展中心顶部显示）——
// 以前这些情况全是静默的：注册表坏了列表就空了、凭据解不开连接器就悄悄没了认证、技能目录被删了就悄悄不生效。
export function extensionDiagnostics() {
  const out = [];
  const store = readStore();
  if (registryError) {
    out.push({ level: 'error', msg: `${registryError}：列表暂时显示为空，扩展中心暂停写入（不会覆盖它）；修好或挪走 extensions/registry.json 后恢复` });
  }
  if (migrateError) out.push({ level: 'warn', msg: `有连接器的凭据还是明文存的，挪进加密存储没成功：${migrateError}` });
  for (const x of store.items) {
    if (x.type !== 'plugin' || !x.enabled) continue;
    const dir = extensionDir(x);
    if (!dir || !existsSync(dir)) continue;
    const miss = missingConfig(x, pluginConfigFields(dir));
    if (miss.length) out.push({ level: 'warn', id: x.id, msg: `插件「${x.name}」还有必填配置没填（${miss.join('、')}），用到它们的 MCP 暂不加载` });
  }
  const withKeys = store.items.filter((x) => x.type === 'connector' && needsSecrets([x]));
  if (withKeys.length) {
    let secrets = null;
    try {
      secrets = readSecrets(EXT_ROOT);
    } catch (e) {
      out.push({
        level: 'error',
        msg: `连接器凭据解不开（${String(e?.message || e)}）——换了 Windows 账户或机器时会这样；这些连接器眼下不带凭据，请重新填写它们的环境变量 / 请求头：${withKeys.map((x) => x.name).join('、')}`,
      });
    }
    if (secrets) {
      for (const x of withKeys) {
        const s = secrets[x.id] || {};
        const lost = [
          ...(x.connector.envKeys || []).filter((k) => !(k in (s.env || {}))),
          ...(x.connector.headerKeys || []).filter((k) => !(k in (s.headers || {}))),
        ];
        if (lost.length) out.push({ level: 'warn', id: x.id, msg: `连接器「${x.name}」的 ${lost.join('、')} 在加密存储里找不到，请重新填写` });
      }
    }
  }
  for (const x of store.items) {
    if (x.type !== 'skill' && x.type !== 'plugin') continue;
    const dir = extensionDir(x);
    const entry = x.entry || (x.type === 'skill' ? 'SKILL.md' : '.claude-plugin/plugin.json');
    if (!dir || !existsSync(path.join(dir, entry))) {
      out.push({ level: 'warn', id: x.id, msg: `${x.type === 'skill' ? '技能' : '插件'}「${x.name}」的 ${entry} 不在了，${x.enabled ? '勾给的 agent 拿不到它' : '（已停用）'}` });
    }
  }
  return out;
}
