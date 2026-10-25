// 拉取请求的纯函数（不碰 $state / 网络 / 字典）：状态归纳、「创建拉取请求」可不可点、提示词、转录信封识别。
// lib/pr.svelte.js 原样转出；单列出来是为了 node --test 能直接测（prText.test.js）。

const OPENISH = new Set(['open', 'draft', 'queued']);
/** 主 PR：开着的优先，没有就最后一个绑定的。 */
export function mainPr(view) {
  const list = (view && view.prs) || [];
  return list.filter((p) => OPENISH.has(p.state)).at(-1) || list.at(-1) || null;
}
/** CI 状态（官方 ER）：failed / passed / pending / skipped / none / unavailable */
export function ciStatus(pr) {
  if (!pr) return 'unavailable';
  if (pr.state === 'merged' || pr.state === 'closed') return 'unavailable';
  const c = pr.checks;
  if (!c) return 'unavailable';
  if (!c.total) return 'none';
  return c.failing ? 'failed' : c.pending ? 'pending' : c.passing ? 'passed' : 'skipped';
}
export const conflicting = (pr) => !!pr && (pr.mergeable === 'CONFLICTING' || pr.mergeStateStatus === 'DIRTY');
/** 芯片 / 卡片的状态色：merged / closed / draft / fail / conflict / pending / ok */
export function prTone(pr) {
  if (!pr) return '';
  if (pr.state === 'merged') return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (conflicting(pr)) return 'conflict';
  const ci = ciStatus(pr);
  if (ci === 'failed') return 'fail';
  if (pr.isDraft) return 'draft';
  if (ci === 'pending') return 'pending';
  return 'ok';
}

/**
 * 「创建拉取请求」不可点的原因（官方 PR 栏主按钮的 tooltip 表）：返回代码，'' = 可以点；文案见 CREATE_BLOCKER。
 * 「没有改动」看的是相对基线分支（官方 No changes to create a PR from）：分支已经整体推送、还没开 PR 也能点。
 * 老服务端没有 baseAhead（-1 / 缺省）时退回看未推送的提交。
 */
export function createBlocker(view, busy) {
  const g = view && view.git;
  if (!g || !g.git || !g.github) return 'no_remote';
  if (g.detached || g.onBase) return 'on_base';
  if (busy) return 'busy';
  const ahead = typeof g.baseAhead === 'number' && g.baseAhead >= 0 ? g.baseAhead : g.unpushed;
  if (!ahead && !g.dirty) return 'no_changes';
  return '';
}
/** 这个会话的基线分支：worktree 切出时的分支（服务端已核对 origin 上有），否则远端默认分支。 */
export const baseOf = (view) => (view && view.git && (view.git.base || view.git.defaultBranch)) || '';

// 提示词：官方 Create PR 模板（c06cf64bb 的 Go）的结构，措辞是 bridge 的中文版。发给模型的隐藏文本，不翻译。
export function createPrPrompt({ draft = false, repo = '', branch = '', base = '', cwd = '', attribution = 'default' } = {}) {
  const open = draft
    ? '用 `gh pr create --draft` 开成草稿拉取请求。用户这次点的是「创建草稿拉取请求」，即使你原本会开成可审查状态，也要保留草稿。'   // i18n-ignore
    : '用 `gh pr create` 开拉取请求，不要开成草稿：用户这次点的是「创建拉取请求」而不是「创建草稿拉取请求」，这个明确的选择优先于任何记忆、长期指示或之前的计划。';   // i18n-ignore
  const sign = attribution === 'none' ? '\n\n提交说明和拉取请求正文里都不要加 Claude 的署名（Co-Authored-By、Generated with Claude Code 之类）。' : '';   // i18n-ignore
  return '<create-pr-command>\n'
    + `## 概要\n\n为这个会话里的改动创建一个拉取请求，${draft ? '开成草稿' : '开成可审查状态（不是草稿）'}。\n\n`   // i18n-ignore
    + '## 步骤\n\n'   // i18n-ignore
    + '1. 看看有没有未提交的改动；有就暂存并提交，提交说明写清改了什么、为什么。\n'   // i18n-ignore
    + '2. 把分支推送到远程。\n'   // i18n-ignore
    + `3. ${open}如果下面的目标里写了基线分支、并且它在 origin 上存在（\`git ls-remote --heads origin <base>\`），用 \`--base\` 传进去；否则不加 \`--base\`，让 gh 自己推断。标题概括这次改动，正文写清改了什么、为什么、评审者需要知道什么；仓库有拉取请求模板就照模板写。\n`   // i18n-ignore
    + '4. 完成后报出拉取请求链接：单独一行用 `<pr-created>` 标签包住，界面据此显示实时状态卡，例如：`<pr-created>https://github.com/owner/repo/pull/123</pr-created>`\n\n'   // i18n-ignore
    + '如果这个分支已经有拉取请求，就只推送新提交，用同样的 `<pr-created>` 标签报出已有的链接，不要重复创建，也不要改它的草稿 / 可审查状态。'   // i18n-ignore
    + sign
    + `\n\n## 目标\n\n仓库：${repo}\n分支：${branch}${base && base !== branch ? `\n基线分支：${base}` : ''}${cwd ? `\n工作目录：${cwd}` : ''}\n`   // i18n-ignore
    + '</create-pr-command>';
}

// 「在 GitHub 上手动创建」：打开 compare 页
export function compareUrl(view) {
  const g = view && view.git;
  if (!g || !g.github || !g.branch) return '';
  const host = g.host || 'github.com';
  const base = baseOf(view);
  return `https://${host}/${g.repo}/compare/${base ? encodeURIComponent(base) + '...' : ''}${encodeURIComponent(g.branch)}?expand=1`;
}

// 「同步基线」冲突交接：以用户身份发给 Claude 的那段话包一层 <sync-conflict>，转录里折叠成一行
//（界面按当前语言显示，给模型的正文是中文；不包的话英文界面会看到一大段「像是自己发的」中文）
export function syncConflictPrompt(x) {
  const files = (x.files || []).map((f) => '`' + f + '`').join('、');
  const more = x.total > (x.files || []).length ? `（共 ${x.total} 个，列出前 ${x.files.length} 个）` : '';   // i18n-ignore
  return `<sync-conflict base="${String(x.base || '').replace(/["<>]/g, '')}" files="${Number(x.total) || 0}">`
    + `刚把基线分支 \`${x.base}\` 合并进本分支时出现冲突（合并还在进行中），冲突文件${more}：${files}。请逐个解决（保留两边的意图），\`git add\` 后用 \`git commit --no-edit\` 完成合并，再跑一下相关检查并推送；确实解决不了就 \`git merge --abort\`，并告诉我原因。`   // i18n-ignore
    + '</sync-conflict>';
}

// —— 转录：认出 /create-pr 提示词、CI 事件与同步基线冲突交接 ——
const CI_RE = /<ci-monitor-event>([\s\S]*?)<\/ci-monitor-event>/g;
const CREATE_RE = /^<create-pr-command>[\s\S]*?<\/create-pr-command>/;
const SYNC_RE = /^<sync-conflict\b([^>]*)>([\s\S]*?)<\/sync-conflict>/;
/**
 * null | { kind:'create', draft, raw, rest } | { kind:'ci', count, ref, enabled, events, rest } | { kind:'sync', base, files, raw, rest }
 * rest = 信封后面跟着的部分（真人轮会把攒着的会话间消息追加在后面）——PrMsgCard 照普通气泡 / 会话消息卡再画一遍。
 */
export function prEnvelope(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (s.startsWith('<create-pr-command>')) {
    const m = CREATE_RE.exec(s);
    const raw = m ? m[0] : s;
    return { kind: 'create', draft: /gh pr create --draft/.test(raw), raw, rest: m ? s.slice(raw.length).trim() : '' };
  }
  if (s.startsWith('<sync-conflict')) {
    const m = SYNC_RE.exec(s);
    if (m) {
      const attr = (k) => { const a = new RegExp(`${k}="([^"]*)"`).exec(m[1]); return a ? a[1] : ''; };
      return { kind: 'sync', base: attr('base'), files: Number(attr('files')) || 0, raw: m[2].trim(), rest: s.slice(m[0].length).trim() };
    }
  }
  if (!s.includes('<ci-monitor-event>')) return null;
  const events = [...s.matchAll(CI_RE)].map((m) => m[1].trim());
  if (!events.length) return null;
  const m = /正在盯 (.+?)，/.exec(events[0]);   // i18n-ignore
  // 用户刚打开自动修复时插进正在跑的那一轮的说明（服务端 pr-messages.mjs 的 AUTOFIX_ON_TEXT）
  const enabled = events.length === 1 && /刚为这个会话打开/.test(events[0]);   // i18n-ignore
  return { kind: 'ci', count: events.length, ref: m ? m[1] : '', enabled, events, rest: s.replace(CI_RE, '').trim() };
}
