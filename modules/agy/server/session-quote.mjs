// Antigravity 引用对话：侧栏把一条会话拖进输入框 / 另一条会话时，把原会话双方正文整理成
// Markdown 落盘到调用者自己的 uploads 目录，当附件挂进输入栏，发送时由模型按需读取。

import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeName } from '@bridge/core/runtime/paths.mjs';
import { isSessionDeleted, loadAgySessionDetail } from './sessions.mjs';

// 存盘名格式：<时间戳>-chatref-<会话 id>--<标题>.md（双连字符分隔 id 与标题，兼容含连字符的 UUID 与任意非空 id）
const AGY_QUOTE_FILE_RE = /^\d+-chatref-([A-Za-z0-9_-]{4,80})--(.*)\.md$/;
const ATTACHED_HEAD = '本轮附加文件路径：';

export function parseAgyQuoteFile(file) {
  const m = AGY_QUOTE_FILE_RE.exec(String(file || ''));
  return m ? { id: m[1], title: m[2] || '' } : null;
}

function stripAttachedPrefix(raw) {
  const s = String(raw ?? '');
  if (!s.startsWith(ATTACHED_HEAD)) return s;
  const lines = s.slice(ATTACHED_HEAD.length).split('\n');
  if (lines[0].trim() !== '') return s;
  let i = 1;
  for (; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.startsWith('- ') || !line.slice(2).trim()) break;
  }
  if (i === 1) return s;
  return lines.slice(i).join('\n').replace(/^\n+/, '');
}

function trimTitle(s) {
  const clean = String(s || '').replace(/\s+/g, ' ').trim();
  return clean.slice(0, 80);
}

export function extractAgyTurns(messages = []) {
  const turns = [];
  for (const m of (Array.isArray(messages) ? messages : [])) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const raw = m.role === 'user' ? stripAttachedPrefix(m.text) : String(m.text || '');
    const text = raw.trim();
    if (!text) continue;
    turns.push({ role: m.role, text });
  }
  return turns;
}

export function agySessionMarkdown(turns = [], { id = '', title = '', at = new Date() } = {}) {
  const dt = at instanceof Date ? at : new Date(at);
  const pad = (n) => String(n).padStart(2, '0');
  const iso = `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  const safeYamlTitle = String(title || '').replace(/"/g, '\\"');
  const lines = [
    '---',
    `title: "${safeYamlTitle}"`,
    `session_id: ${id}`,
    `exported_at: "${iso}"`,
    'source: "claude-bridge 引用对话（Antigravity）"',
    '---',
    '',
    `# ${title || ('会话 ' + String(id).slice(0, 8))}`,
    '',
    '> 这是用户从另一段 Antigravity 对话里拖过来的【引用】，下面是那段对话的完整记录（只含双方正文，工具调用过程已略去）。把它当作这次对话的背景材料，结合用户这条消息作答；用户没问到的部分不必复述。',
    '',
  ];
  for (const turn of turns) {
    lines.push(turn.role === 'user' ? '## 我' : '## Antigravity');
    lines.push('');
    lines.push(turn.text);
    lines.push('');
  }
  return lines;
}

export async function quoteAgySession(ctx, { id = '', title = '', cwd = '' } = {}, { loadDetail = loadAgySessionDetail } = {}) {
  const sid = String(id || '').trim();
  if (!sid || sid.length > 80 || !/^[A-Za-z0-9_.:-]+$/.test(sid)) {
    throw Object.assign(new Error('找不到这个对话'), { status: 404 });
  }
  if (isSessionDeleted(ctx.agyDir, sid)) {
    throw Object.assign(new Error('找不到这个对话'), { status: 404 });
  }
  const detail = await loadDetail(ctx, sid, { cwd: String(cwd || '').trim() });
  const turns = extractAgyTurns(detail?.messages);
  if (!turns.length) {
    throw Object.assign(new Error('这个对话还没有内容'), { status: 422 });
  }
  const given = trimTitle(title);
  const finalTitle = given || trimTitle(detail?.customTitle || detail?.title) || ('会话 ' + sid.slice(0, 8));
  const lines = agySessionMarkdown(turns, { id: sid, title: finalTitle, at: new Date() });

  mkdirSync(ctx.uploads, { recursive: true });
  const safeId = sid.replace(/[^A-Za-z0-9_-]/g, '_').replace(/--+/g, '-');
  const safeTitle = sanitizeName(finalTitle.replace(/[\\/]+/g, ' ')).replace(/[.\s]+$/, '').slice(0, 60) || 'conversation';
  const file = `${Date.now()}-chatref-${safeId}--${safeTitle}.md`;
  const dest = path.join(ctx.uploads, file);
  await writeFile(dest, lines.join('\n'), 'utf8');
  return { ok: true, path: dest, name: safeTitle, file, count: turns.length, id: sid };
}
