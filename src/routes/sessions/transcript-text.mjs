// 转录里的文字与标题：取正文、/api/session 响应的指纹、标题清洗与读取。
import { createReadStream, statSync } from 'node:fs';
import readline from 'node:readline';
import { createHash } from 'node:crypto';
import { pendingRewindAnchor } from '../../agents/claude-rewind.mjs';
import { chatPrefsFor } from '../../runtime/chat-prefs.mjs';
import { splitAttachments } from '../../runtime/client-atts.mjs';
import { isInjectedText } from './history-parse.mjs';

function extractText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string' && !isInjectedText(b.text))
      .map((b) => b.text)
      .join('');
  }
  return '';
}

// /api/session 响应的指纹。响应只由三样东西决定：
//   ① transcript 文件本身（size + mtime——内容变了这两者必变，不必读文件）
//   ② 回滚锚点（pending 时视图要按锚点截断）
//   ③ 该会话的 prefs sidecar（model/effort/fast，前端要用它恢复选择器）
// 取不到 stat 就返回 null = 不短路，老老实实重建（宁可多算，绝不给错的 unchanged）。
export function sessionFingerprint(file, sessionId, ctx) {
  let st;
  try { st = statSync(file); } catch { return null; }
  const parts = [
    st.size,
    Math.round(st.mtimeMs),
    pendingRewindAnchor(sessionId) || '',
    JSON.stringify(chatPrefsFor(ctx, sessionId) || null),
  ];
  return createHash('sha1').update(parts.join('\x00')).digest('hex').slice(0, 16);
}


export function trimTitle(s) {
  if (!s) return '';
  // 标题取的是第一条用户消息【原文】，带附件发送时 claude.mjs 会把「[用户上传了以下
  // 附件…绝对路径如下]」整段注进 prompt，也就一并写进 transcript。气泡那条通道由
  // splitAttachments() 剥掉了，标题这条以前没剥——于是会话列表里直接显示内部提示词
  // 加服务器绝对路径（体检时线上实测到）。/api/sessions 对 user 与公开快照访客同样
  // 开放，注释里那条「绝对路径不出服务器」的规矩在这里被绕过去了。
  const { text, attachments } = splitAttachments(String(s));
  // 会话间消息的信封（session-family.mjs）：派生的子会话第一条就是父会话发来的任务说明——
  // 标题取信封里的正文（去掉「【任务】」这类小标题），不出标签。
  let body = text.replace(/<session-hint>[\s\S]*?<\/session-hint>/g, '')
    .replace(/<side-sessions-event>[\s\S]*?<\/side-sessions-event>/g, '')
    .replace(/<session-message\b[^>]*>([\s\S]*?)<\/session-message>/g, (_, b) => b.replace(/【(背景|任务)】/g, ' '))
    .replace(/<cross-session-message\b[^>]*>([\s\S]*?)<\/cross-session-message>/g, '$1')   // Desktop / 终端会话发来的（session-peers.mjs）
    // 拉取请求（pr-monitor.mjs）：Auto-fix 事件不当标题；「创建拉取请求」那条长提示词显示成 /create-pr
    .replace(/<ci-monitor-event>[\s\S]*?<\/ci-monitor-event>/g, '')
    .replace(/<create-pr-command>[\s\S]*?<\/create-pr-command>/g, (m) => (/gh pr create --draft/.test(m) ? '/create-pr --draft' : '/create-pr'))
    .replace(/<sync-conflict\b[^>]*>([\s\S]*?)<\/sync-conflict>/g, (_, b) => b);   // PR 卡「同步基线」冲突交接：只留正文
  // 只传附件、一个字没写的会话：剥完就空了，而调用方把空标题当成「读不出来的会话」
  // 直接从列表里丢掉（listSessions 里的 `if (!title) continue`）。用附件名兜底——
  // 只出文件名，不出路径。
  if (!body.trim() && attachments.length) {
    body = attachments.map((a) => a.name).filter(Boolean).join('、');
  }
  const line = body.replace(/\s+/g, ' ').trim();
  return line.length > 80 ? line.slice(0, 80) + '…' : line;
}

// Stream a session log only until its first real user message — that's the title.
export function readSessionTitle(file) {
  return new Promise((resolve) => {
    // Keep the stream ref so we can DESTROY it. We close mid-file the instant the title
    // is found, but readline.close() does NOT close the underlying fd — and the stream
    // hasn't hit EOF, so autoClose never fires either. /api/sessions opens ~40 of these
    // per request; leaking each fd piles up until the process throws EMFILE: too many
    // open files (even lazy imports then fail to load). destroy() on every exit path = fix.
    const stream = createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let title = '';
    const finish = () => { try { rl.close(); } catch {} try { stream.destroy(); } catch {} resolve(title); };
    rl.on('line', (line) => {
      if (title) return;
      let o; try { o = JSON.parse(line); } catch { return; }
      if (o.type === 'user' && o.message && !o.isMeta) {
        const t = extractText(o.message.content);
        if (t && t.trim()) { title = t; finish(); }
      }
    });
    rl.on('close', finish);
    rl.on('error', finish);
  });
}
