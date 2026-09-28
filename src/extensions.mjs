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

const needsSecrets = (items) => items.some((x) => x.type === 'connector' && ((x.connector?.envKeys || []).length || (x.connector?.headerKeys || []).length));

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

// 对外的样子：凭据只给键名，值一律打码
function publicItem(item) {
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
  const out = path.join(EXT_ROOT, 'runtime', `.dl-${crypto.randomBytes(4).toString('hex')}.zip`);
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

// —— 安装：技能（.md 单文件 / .zip / .skill）——
export async function installSkill(filename, buf, { replaceId, pkg } = {}) {
  const store = readStoreForWrite();
  if (store.items.length >= MAX_ITEMS) throw httpErr(400, '扩展数量已达上限');
  const isMd = /\.md$/i.test(filename || '');
  const staging = path.join(EXT_ROOT, 'runtime', `.stage-${crypto.randomBytes(4).toString('hex')}`);
  try {
    if (isMd) {
      mkdirSync(staging, { recursive: true });
      writeFileSync(path.join(staging, 'SKILL.md'), buf);
    } else {
      await extractArchive(buf, staging);
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

// —— 安装：Claude Code 插件（.zip，需 .claude-plugin/plugin.json）——
export async function installPlugin(filename, buf, { replaceId, pkg } = {}) {
  const store = readStoreForWrite();
  if (store.items.length >= MAX_ITEMS) throw httpErr(400, '扩展数量已达上限');
  const staging = path.join(EXT_ROOT, 'runtime', `.stage-${crypto.randomBytes(4).toString('hex')}`);
  try {
    await extractArchive(buf, staging);
    sanitizeTree(staging);
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
    plugins.push({ type: 'local', path: AGGREGATE_DIR });
  }
  for (const item of items) {
    if (item.type !== 'plugin' || !item.agents?.claude) continue;
    const dir = extensionDir(item);
    if (dir && existsSync(dir)) plugins.push({ type: 'local', path: dir });
  }
  const mcpServers = {};
  const conns = items.filter((x) => x.type === 'connector' && x.agents?.claude && x.connector);
  const secrets = secretsForInjection(conns);
  for (const item of conns) {
    const c = item.connector;
    const { env, headers } = connectorCreds(item, secrets);
    mcpServers[c.key || slugify(item.name, item.id)] =
      c.transport === 'stdio'
        ? { type: 'stdio', command: c.command, args: c.args || [], ...(hasValues(env) ? { env } : {}) }
        : { type: c.transport, url: c.url, ...(hasValues(headers) ? { headers } : {}) };
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
  const withKeys = store.items.filter((x) => needsSecrets([x]));
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
