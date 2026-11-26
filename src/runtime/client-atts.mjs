// 用户消息附件：从注入进 prompt 的「[用户上传了以下附件…]」清单里抽出附件，并换成前端能取图的形态。
// 历史重开（routes/sessions.mjs）与直播插话（agents/claude.mjs 的 steer 事件）共用，两边气泡同形。
import { statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseDeviceRefNote, basenameOf, parseDeviceRef } from './device-refs.mjs';

// 用户带附件发送时，claude.mjs 把「[用户上传了以下附件…绝对路径]」注入进 prompt，会转写进 transcript。
// 重开历史会话时：① 把这段注入文本从气泡里剥掉（否则漏出服务端绝对路径）② 抽出附件——存盘名 file
// （Date.now()-原名）+ 去时间戳前缀的显示名 name + 完整路径 raw（供 toClientAtt 按来源分类，
// 不直接出服务器）；前端据此走 /api/upload/raw 或 /api/file 把图片渲染回缩略图。
const ATT_MARK = '[用户上传了以下附件';
export function splitAttachments(text) {
  const mi = text.indexOf(ATT_MARK);
  if (mi < 0) return { text, attachments: [] };
  const clean = text.slice(0, mi).replace(/\n+$/, '');
  const attachments = [];
  const re = /^-\s+(.+)$/gm;
  let m;
  while ((m = re.exec(text.slice(mi)))) {
    // 行尾可能带 claude.mjs 加的标注（「  ← 文件夹」「  ← 引用的对话」），不属于路径
    const note = (/\s+←\s*(.*)$/.exec(m[1]) || [])[1] || '';
    const raw = m[1].replace(/\s+←.*$/, '').trim();
    // 用户电脑上的文件夹（只引用、没上传，runtime/device-refs.mjs）：路径是他电脑上的，名字不剥时间戳前缀
    const dev = parseDeviceRefNote(note);
    if (dev) {
      const p = raw.replace(/^`(.*)`$/, '$1');   // 提示词里这条路径包着反引号
      attachments.push({ file: basenameOf(p), name: basenameOf(p), raw: p, kind: 'folder', device: { id: dev.deviceId, name: dev.deviceName } });
      continue;
    }
    const file = raw.split(/[\\/]/).pop() || '';
    if (!file) continue;
    const q = parseQuoteFile(file);
    if (q) attachments.push({ file, name: q.title, raw, kind: 'chat', quoteId: q.id });
    else if (/^文件夹/.test(note.trim())) attachments.push({ file, name: file, raw, kind: 'folder' });
    else attachments.push({ file, name: file.replace(/^\d+-/, ''), raw });
  }
  return { text: clean, attachments };
}
// 「引用对话」附件（侧栏把一条会话拖进另一个对话，见 POST /api/session/quote）：存盘名
// <时间戳>-chatref-<会话 id>-<标题>.md。靠名字认出来，重开历史时气泡里画成对话卡而不是一份 .md。
const QUOTE_FILE_RE = /^\d+-chatref-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})-(.*)\.md$/;
export function parseQuoteFile(file) {
  const m = QUOTE_FILE_RE.exec(String(file || ''));
  return m ? { id: m[1], title: m[2] || '' } : null;
}
// 历史附件出口（绝对路径不出服务器）：uploads 里的 → {file}（前端走 /api/upload/raw）；
// 工作空间直发的（「发送给 AI」零拷贝路径）→ {rel}（前端走 /api/file）；都不是 → 只留名字。
// 直播轮的附件（发送时那份绝对路径清单）→ 与历史同形：/api/attach 重放开头的用户气泡据此带回图。
// 电脑上的引用（device://）只留名字，不认识来源的也只留名字（toClientAtt 兜底）。
export function liveUserAtts(list, ctx) {
  const out = [];
  for (const p of Array.isArray(list) ? list : []) {
    if (typeof p !== 'string' || !p) continue;
    const dev = parseDeviceRef(p);
    if (dev) { out.push({ name: basenameOf(dev.path), kind: 'folder', device: { id: dev.deviceId, name: '' } }); continue; }
    const file = p.split(/[\\/]/).pop() || '';
    if (!file) continue;
    const q = parseQuoteFile(file);
    if (q) { out.push(toClientAtt({ file, name: q.title, raw: p, kind: 'chat', quoteId: q.id }, ctx)); continue; }
    let isDir = false;
    try { isDir = statSync(p).isDirectory(); } catch {}
    out.push(toClientAtt(isDir ? { file, name: file, raw: p, kind: 'folder' } : { file, name: file.replace(/^\d+-/, ''), raw: p }, ctx));
  }
  return out;
}
export function toClientAtt(a, ctx) {
  if (a.device) return { name: a.name, kind: 'folder', device: a.device };   // 电脑上的路径不必回传，卡上只写名字与哪台电脑
  const raw = a.raw || '';
  const under = (dir) => dir && raw && path.resolve(raw).startsWith(path.resolve(dir) + path.sep);
  if (a.kind === 'folder') {
    return under(ctx.cwd)
      ? { rel: path.relative(ctx.cwd, raw).split(path.sep).join('/'), name: a.name, kind: 'folder' }
      : { name: a.name, kind: 'folder' };
  }
  if (under(ctx.uploads)) return a.kind === 'chat' ? { file: a.file, name: a.name, kind: 'chat', quoteId: a.quoteId } : { file: a.file, name: a.name };
  if (under(ctx.cwd)) return { rel: path.relative(ctx.cwd, raw).split(path.sep).join('/'), name: a.file };
  // 桌面壳零拷贝引用的本机文件（没进 uploads、也不在工作空间里，如截图工具的录屏）：只回文件名 lfile，
  // 绝对路径照旧不出服务器——前端要封面 / 播放时带 lfile 去问 /api/claude/artifact（path=bridge-att:<名>），
  // 服务端在这条会话自己的附件清单里按名字找回原路径（attachedPathOf）。名字不剥前缀：那是原文件名，不是存盘时间戳。
  if (raw && path.isAbsolute(raw) && a.file) return { name: a.file, lfile: a.file };
  return { name: a.name };
}

// 「bridge-att:<文件名>」→ 这条会话里用户自己附过的那个文件的绝对路径（找不到给 null）。
// 只认 transcript 里注入的附件清单（同 splitAttachments），按文件名对，同名取最后一次；电脑上的引用不算。
// 结果按 transcript 缓存：命中直接用（附过的路径不会变），没命中且文件变过才重扫。
// 授权不在这里：调用方（/api/claude/artifact）照旧过会话所有权 + 交付根守卫。
export const ATT_REF_PREFIX = 'bridge-att:';
const attIndex = new Map();   // transcript → { mt, size, map: 文件名 → 绝对路径 }
function collectStrings(v, out) {
  if (typeof v === 'string') { if (v.includes(ATT_MARK)) out.push(v); return; }
  if (Array.isArray(v)) { for (const x of v) collectStrings(x, out); return; }
  if (v && typeof v === 'object') for (const k in v) collectStrings(v[k], out);
}
export async function attachedPathOf(transcript, name) {
  const base = String(name || '');
  if (!base || /[\\/]/.test(base)) return null;
  let st;
  try { st = statSync(transcript); } catch { return null; }
  const hit = attIndex.get(transcript);
  if (hit && (hit.map.has(base) || (hit.mt === st.mtimeMs && hit.size === st.size))) return hit.map.get(base) || null;
  const map = new Map();
  let text = '';
  try { text = await readFile(transcript, 'utf8'); } catch { return null; }
  for (const line of text.split('\n')) {
    if (!line.includes(ATT_MARK)) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const strs = [];
    collectStrings(o, strs);
    for (const s of strs) {
      for (const a of splitAttachments(s).attachments) {
        if (!a.device && a.raw && path.isAbsolute(a.raw) && a.file) map.set(a.file, a.raw);
      }
    }
  }
  attIndex.delete(transcript);
  attIndex.set(transcript, { mt: st.mtimeMs, size: st.size, map });
  if (attIndex.size > 64) attIndex.delete(attIndex.keys().next().value);
  return map.get(base) || null;
}
