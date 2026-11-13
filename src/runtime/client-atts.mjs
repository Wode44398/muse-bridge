// 用户消息附件：从注入进 prompt 的「[用户上传了以下附件…]」清单里抽出附件，并换成前端能取图的形态。
// 历史重开（routes/sessions.mjs）与直播插话（agents/claude.mjs 的 steer 事件）共用，两边气泡同形。
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
    const raw = m[1].replace(/\s+←.*$/, '').trim();
    // 用户电脑上的文件夹（只引用、没上传，runtime/device-refs.mjs）：路径是他电脑上的，名字不剥时间戳前缀
    const dev = parseDeviceRefNote((/\s+←\s*(.*)$/.exec(m[1]) || [])[1]);
    if (dev) {
      const p = raw.replace(/^`(.*)`$/, '$1');   // 提示词里这条路径包着反引号
      attachments.push({ file: basenameOf(p), name: basenameOf(p), raw: p, kind: 'folder', device: { id: dev.deviceId, name: dev.deviceName } });
      continue;
    }
    const file = raw.split(/[\\/]/).pop() || '';
    if (!file) continue;
    const q = parseQuoteFile(file);
    attachments.push(q ? { file, name: q.title, raw, kind: 'chat', quoteId: q.id } : { file, name: file.replace(/^\d+-/, ''), raw });
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
    out.push(toClientAtt(q ? { file, name: q.title, raw: p, kind: 'chat', quoteId: q.id } : { file, name: file.replace(/^\d+-/, ''), raw: p }, ctx));
  }
  return out;
}
export function toClientAtt(a, ctx) {
  if (a.device) return { name: a.name, kind: 'folder', device: a.device };   // 电脑上的路径不必回传，卡上只写名字与哪台电脑
  const raw = a.raw || '';
  const under = (dir) => dir && raw && path.resolve(raw).startsWith(path.resolve(dir) + path.sep);
  if (under(ctx.uploads)) return a.kind === 'chat' ? { file: a.file, name: a.name, kind: 'chat', quoteId: a.quoteId } : { file: a.file, name: a.name };
  if (under(ctx.cwd)) return { rel: path.relative(ctx.cwd, raw).split(path.sep).join('/'), name: a.file };
  return { name: a.name };
}
