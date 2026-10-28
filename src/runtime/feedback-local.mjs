// 反馈落本机库：设置页的提交表单（routes/feedback.mjs）和 Claude 诊断后上报（agent-api/ops/feedback.mjs）共用。
// 每条一个 .md（frontmatter 元数据 + 正文 + 可选附件），附件 copy 进反馈库 attachments/，正文用 ![[attachments/...]] 嵌入。
//
// 附件只接调用者自己 uploads 里的文件（严格前缀校验，防越权读任意文件）；allowDirs 可以再放开几个目录
// （Claude 上报时还认他自己的工作空间：截图常被存在那里）。
import path from 'node:path';
import { writeFileSync, mkdirSync, existsSync, statSync, copyFileSync } from 'node:fs';
import { APP_VERSION_NAME, APP_VERSION_CODE } from '../config/versions.mjs';
import { FEEDBACK_DIR, yamlStr, safeName, noteStamp } from './feedback-upstream.mjs';

const inside = (base, p) => { const b = path.resolve(base); return p === b || p.startsWith(b + path.sep); };

/**
 * id = 登录身份（kind / user / tier），ctx = contextFor(id)；attachments = [{ path, name? }]。
 * via：'form'（默认，设置页提交）| 'claude' / 'dimensio'（agent 跟用户确认过后代为上报），写进 frontmatter。
 * 回 { file, srcs }：srcs 是通过校验的附件源路径（推给中继时用）。写不进去就抛错。
 */
export function saveLocalFeedback({ id, ctx, text = '', screen = '', attachments = [], via = 'form', title = '', feedbackDir = FEEDBACK_DIR, allowDirs = [] }) {
  const user = id.user || (id.kind === 'admin' ? 'admin' : '匿名');
  const tier = id.tier || (id.kind === 'admin' ? 'admin' : '');
  const { date, stamp } = noteStamp(new Date());   // 服务器本地时区
  const attachDir = path.join(feedbackDir, 'attachments');
  const bases = [ctx.uploads, ...allowDirs].filter(Boolean);

  const embeds = [];
  const srcs = [];
  let ai = 0;
  for (const a of attachments) {
    try {
      const src = path.resolve(String((a && a.path) || ''));
      if (!bases.some((b) => inside(b, src))) continue;
      if (!existsSync(src) || !statSync(src).isFile()) continue;
      mkdirSync(attachDir, { recursive: true });
      const fname = `${stamp}-${ai++}-${safeName((a && a.name) || path.basename(src))}`;
      copyFileSync(src, path.join(attachDir, fname));
      embeds.push(`![[attachments/${fname}]]`);
      srcs.push(src);
    } catch {}
  }

  const fm = [
    '---', 'type: feedback', `date: ${date}`, `user: ${yamlStr(user)}`, `kind: ${id.kind}`, `tier: ${tier}`,
    `app: v${APP_VERSION_NAME} (code ${APP_VERSION_CODE})`, `screen: ${yamlStr(screen || '-')}`,
    ...(via === 'claude' || via === 'dimensio' ? [`via: ${via}`, `title: ${yamlStr(title || '-')}`] : []),
    'status: new', '---', '', '',
  ].join('\n');
  let md = fm + (text || '');
  if (embeds.length) md += (text ? '\n\n' : '') + '**附件：**\n' + embeds.join('\n');
  md += '\n';
  mkdirSync(feedbackDir, { recursive: true });
  let file = path.join(feedbackDir, `${stamp}-${safeName(user).slice(0, 40)}.md`);
  // 同一秒两条（Claude 连着报、或表单和 Claude 撞上）：别互相覆盖
  if (existsSync(file)) file = file.replace(/\.md$/, `-${Math.random().toString(16).slice(2, 6)}.md`);
  writeFileSync(file, md, 'utf8');
  return { file, srcs };
}
