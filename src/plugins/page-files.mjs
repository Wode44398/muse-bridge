// 插件页面的文件句柄：页面永远拿不到路径，只拿到使用者在 bridge 自己的选择器里选中的那几个文件的句柄。
//
//   POST /api/plugins/handles { plugin, items: [{ rel, ws? }], mode?: 'rw' | 'r' }   （bridge 自己的界面，登录态）
//        → { files: [{ handle, name, size, mime, mode }] }
//   GET  /api/plugin/<id>/_bridge/files/stat?h=    → { name, size, mime, mtime, mode }
//   GET  /api/plugin/<id>/_bridge/files/read?h=    → 文件字节
//   POST /api/plugin/<id>/_bridge/files/write?h=   （原始字节 ≤ 50MB）→ { ok: true, size, mtime }
//
// 解析规则与 /api/file 同一套：身份的文件根（主机 = vault，成员 = 自己的空间）、ws = 项目目录（要命令行权限，
// authorizeProjectPath 判边界，经 scopeCtx）、safeJoin 拼相对路径；再用 isPathInside(…, { resolveLinks: true })
// 挡住「空间里一个 junction / 软链指到空间外」——字面路径在根内、真实位置不在，照样拒。
// 句柄只在内存：绑定插件、使用者、绝对路径与模式，1 小时过期；每对插件 / 使用者最多 200 个（超了挤掉最旧的）；
// 插件停用、page.files 授权撤销时作废。

import crypto from 'node:crypto';
import path from 'node:path';
import { createReadStream, realpathSync, statSync } from 'node:fs';
import { rename, stat as statAsync, unlink, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream';
import { kernel } from './state.mjs';
import { canUsePluginPages } from './ui.mjs';
import { requireGrant, onGrantRevoked, isDeclared } from './page-grants.mjs';
import { safeJoin, isPathInside, mimeType } from '../runtime/http-file.mjs';
import { scopeCtx, protectedTarget } from '../routes/file-core.mjs';

export const HANDLE_TTL_MS = 3600_000;
export const HANDLES_PER_OWNER = 200;
export const ITEMS_PER_CALL = 20;
export const WRITE_MAX = 50 * 1024 * 1024;

const err = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const handles = new Map();   // 句柄 → { handle, plugin, owner, file, root, name, mode, guard, expires, byHandler? }（byHandler = 经哪个文件处理器免授权签的）

function prune(now = Date.now()) {
  for (const [k, h] of handles) if (h.expires < now) handles.delete(k);
}
const sweeper = setInterval(prune, 5 * 60_000);
sweeper.unref?.();

/** 作废一对插件 / 使用者的全部句柄（owner 省略 = 这个插件的全部）。 */
export function dropHandles(pluginId, owner) {
  for (const [k, h] of handles) if (h.plugin === pluginId && (owner == null || h.owner === owner)) handles.delete(k);
}

// page.files 撤销 → 这对插件 / 使用者的句柄当场作废
onGrantRevoked((plugin, owner, perm) => { if (perm === 'page.files') dropHandles(plugin, owner); });

// 插件停用（含出错、卸载）→ 它的句柄全部作废。第一次签句柄时才挂监听（测试与没用到的进程不挂）。
let watching = null;
function watchKernel() {
  if (watching || typeof kernel.on !== 'function') return;
  watching = kernel.on('change', () => {
    for (const [k, h] of handles) if (!kernel.isActive(h.plugin)) handles.delete(k);
  });
}

// scopeCtx 失败时直接写 res；这里给它一个只记下状态码与消息的替身，好把同一套规则用在不是 HTTP 回应的地方。
function scopeOf(c, ws) {
  const sink = { code: 0, msg: '', writeHead(code) { this.code = code; }, end(m) { this.msg = String(m || ''); } };
  const scoped = scopeCtx(c, ws, sink);
  if (scoped) return scoped;
  if (!c.shell && sink.code === 403) throw err(403, '选项目目录里的文件要有命令行权限（Pro 档）');
  throw err(sink.code || 403, sink.msg && sink.msg !== 'forbidden' ? sink.msg : '这个位置不能选');
}

// 按真实位置判受保护目录：根与目标都 realpath 之后再比（根本身是链接时两边一致）。解析不了算受保护，宁可不给。
function realProtected(root, target, guard) {
  try { return protectedTarget(realpathSync(root), realpathSync(target), guard); } catch { return true; }
}

// 一项 { rel, ws? } → 绝对路径与文件信息。不合格就抛（带人话）。
function resolveItem(c, item) {
  if (!item || typeof item !== 'object') throw err(400, 'items 的每一项要是 { rel, ws? }');
  const rel = String(item.rel ?? '');
  const ws = item.ws ? String(item.ws) : '';
  const scoped = scopeOf(c, ws);
  const root = scoped.cwd;
  const file = rel ? safeJoin(root, rel) : null;
  if (!file || path.resolve(file) === path.resolve(root)) throw err(403, '这个位置不能选');
  let st;
  try { st = statSync(file); } catch { throw err(404, `文件「${path.basename(file)}」不在了`); }
  if (!st.isFile()) throw err(400, `「${path.basename(file)}」不是文件`);
  if (!isPathInside(file, root, { resolveLinks: true })) throw err(403, `「${path.basename(file)}」链接到了你的空间以外，不能给插件`);
  // 系统目录与正在上传的临时片不给（成员自己的 .bridge 里是会话 / 配置）。字面路径查一遍，真实位置再查一遍：
  // 空间里一个 junction / 软链指向本空间的 .bridge、.git，字面上看不出来，只有按 realpath 才认得出。
  if (protectedTarget(root, file, scoped) || realProtected(root, file, scoped)) throw err(403, `「${path.basename(file)}」在受保护的位置，不能给插件`);
  return { file, root, name: path.basename(file), size: st.size, guard: { kind: scoped.kind, sandbox: !!scoped.sandbox, shell: !!scoped.shell } };
}

/**
 * 给使用者 c 选中的文件签句柄（主界面的选择器选完调；手机中转 pick.file 完成时也走这里）。
 * 要求：插件开着、c 能用它的页面、声明并授权过 page.files；每次最多 20 项，任何一项不合格整批不签。
 * opts.via = 文件处理器（ui.mjs 的 findFileHandler 查出来的 { id, exts, … }，文件列表里的「用 X 打开」）：
 * 这一批文件的扩展名全在处理器的 exts 里 → 免授权（用户在文件列表里点「用 X 打开」本身就是同意给这一个文件），
 * 但插件仍得声明 page.files；有一个对不上就照常要授权——处理器只替它登记过的类型担保。
 */
export function signHandles(c, pluginId, items, mode = 'rw', opts = {}) {
  const id = String(pluginId || '');
  if (!kernel.isActive(id)) throw err(404, '插件没开着');
  if (!canUsePluginPages(c, id)) throw err(403, '你用不了这个插件的页面');
  const via = opts && opts.via && typeof opts.via === 'object' ? opts.via : null;
  if (!via) requireGrant(id, c.key, 'page.files');
  else if (!isDeclared(id, 'page.files')) throw err(403, '插件没有声明「page.files」权限，用不了这个功能', { undeclared: true, perm: 'page.files' });
  if (!Array.isArray(items) || !items.length) throw err(400, '要 items：[{ rel, ws? }]');
  if (items.length > ITEMS_PER_CALL) throw err(400, `一次最多选 ${ITEMS_PER_CALL} 个文件`);
  const m = mode === 'r' || c.readOnly ? 'r' : 'rw';
  const resolved = items.map((it) => resolveItem(c, it));
  // 免授权只在扩展名全对得上时成立；对不上就回到普通规则（没授权 → 403 needGrant，前端照常弹授权框）
  let byHandler = null;
  if (via) {
    const exts = new Set((Array.isArray(via.exts) ? via.exts : []).map((e) => String(e || '').toLowerCase().replace(/^\./, '')).filter(Boolean));
    const extOf = (name) => { const e = path.extname(String(name || '')).toLowerCase(); return e ? e.slice(1) : ''; };
    if (exts.size && resolved.every((r) => exts.has(extOf(r.name)))) byHandler = String(via.id || '') || 'handler';
    else requireGrant(id, c.key, 'page.files');
  }
  watchKernel();
  prune();
  const now = Date.now();
  const out = [];
  for (const r of resolved) {
    // 每对插件 / 使用者封顶：挤掉最旧的（Map 按插入顺序）
    const mine = [...handles.values()].filter((h) => h.plugin === id && h.owner === c.key);
    for (let n = mine.length - HANDLES_PER_OWNER + 1; n > 0; n--) handles.delete(mine.shift().handle);
    const handle = crypto.randomBytes(24).toString('base64url');
    handles.set(handle, { handle, plugin: id, owner: c.key, file: r.file, root: r.root, name: r.name, mode: m, guard: r.guard, expires: now + HANDLE_TTL_MS, ...(byHandler ? { byHandler } : {}) });
    out.push({ handle, name: r.name, size: r.size, mime: mimeType(r.name, { safe: true }), mode: m });
  }
  return out;
}

/** 页面拿句柄来用：必须是这个插件、这个使用者的，没过期；插件开着、page.files 还授权着。 */
export function useHandle(h, pluginId, owner) {
  const rec = typeof h === 'string' ? handles.get(h) : null;
  if (!rec || rec.expires < Date.now() || rec.plugin !== pluginId || rec.owner !== owner || !kernel.isActive(pluginId)) {
    if (rec && rec.expires < Date.now()) handles.delete(h);
    throw err(404, '文件句柄失效了（过期、插件停用或授权撤销），请重新选择文件');
  }
  // 经文件处理器签的（免授权的那一个文件）：用时也不要授权，但声明还得在（插件升级去掉了 page.files 就不认了）
  if (rec.byHandler) {
    if (!isDeclared(pluginId, 'page.files')) { handles.delete(h); throw err(404, '文件句柄失效了（插件不再声明 page.files），请重新选择文件'); }
  } else requireGrant(pluginId, owner, 'page.files');
  return rec;
}

// 每次用（读、stat、写）都重新核对：文件还在、还是普通文件、真实位置仍在根内、真实位置不在受保护目录里
//（选完之后被换成指向外面、或指向本空间 .bridge / .git 的链接也拦得住）
function liveTarget(rec) {
  let real, realRoot;
  try { real = realpathSync(rec.file); } catch { throw err(404, `文件「${rec.name}」不在了`); }
  try { realRoot = realpathSync(rec.root); } catch { throw err(404, '文件所在的空间不在了'); }
  if (!isPathInside(real, rec.root, { resolveLinks: true })) throw err(403, `「${rec.name}」现在链接到了空间以外`);
  if (protectedTarget(realRoot, real, rec.guard)) throw err(403, `「${rec.name}」现在在受保护的位置，插件读写不了`);
  let st;
  try { st = statSync(real); } catch { throw err(404, `文件「${rec.name}」不在了`); }
  if (!st.isFile()) throw err(400, `「${rec.name}」不是文件了`);
  return { real, st };
}

export function statHandle(rec) {
  const { st } = liveTarget(rec);
  return { name: rec.name, size: st.size, mime: mimeType(rec.name, { safe: true }), mtime: Math.round(st.mtimeMs), mode: rec.mode };
}

/** 把文件字节写给 res（Content-Type 按扩展名；网页类一律当纯文本给，不让它在 bridge 的源上被当文档解析）。 */
export function streamHandle(rec, res) {
  const { real, st } = liveTarget(rec);
  res.writeHead(200, {
    'Content-Type': mimeType(rec.name, { safe: true }),
    'Content-Length': st.size,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  // pipeline 而不是 .pipe：页面中途取消 / 断开时 .pipe 只解绑不销毁读流，文件描述符会一直占着；
  // pipeline 任一端出错或关闭都把另一端一起收掉（同 runtime/http-file.mjs）
  const s = createReadStream(real);
  pipeline(s, res, () => {});
  return s;   // 路由不用；测试据此看断开后读流有没有收掉
}

/** 存回：要 rw；liveTarget 重新核对链接越界与写保护；先写同目录临时文件（.part-*，文件列表里不显示）再改名。 */
export async function writeHandle(rec, buf) {
  if (rec.mode !== 'rw') throw err(403, '这个文件是只读打开的，不能存回');
  const { real } = liveTarget(rec);
  const tmp = path.join(path.dirname(real), '.part-' + crypto.randomBytes(8).toString('hex'));
  try { await writeFile(tmp, buf); } catch (e) {
    await unlink(tmp).catch(() => {});
    throw err(500, `「${rec.name}」没存进去：${e?.message || e}`);
  }
  for (let i = 0; ; i++) {
    try { await rename(tmp, real); break; } catch (e) {
      // Windows：文件正被编辑器 / 杀毒短暂占着时改名会 EPERM / EBUSY，稍等重试；还不行就报忙
      const busy = ['EPERM', 'EBUSY', 'EACCES'].includes(e?.code);
      if (i >= 4 || !busy) {
        await unlink(tmp).catch(() => {});
        throw busy ? err(409, `「${rec.name}」正被别的程序占用，稍后再存`) : err(500, `「${rec.name}」没存进去：${e?.message || e}`);
      }
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
  const st = await statAsync(real);
  return { ok: true, size: st.size, mtime: Math.round(st.mtimeMs) };
}

// 测试用：看一眼内存里还有几个句柄
export const _handleCount = (pluginId, owner) => [...handles.values()].filter((h) => h.plugin === pluginId && (owner == null || h.owner === owner)).length;
