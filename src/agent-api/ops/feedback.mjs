// 问题反馈：用户跟 Claude 说「是不是出 bug 了」时，Claude 先 diagnose 看现场、跟用户确认，再 report 上报。
// 上报 = 本机反馈库总是落一份（管理员在设置 › 反馈里看得到）；对方同意、且这台服务器的「发给 bridge 开发者」开着时，
// 再经反馈中继发给 bridge 开发者（runtime/feedback-upstream.mjs：白名单字段、不带用户名、本机域名 / 主机名先抹掉）。

import path from 'node:path';
import os from 'node:os';
import { readdirSync, readFileSync, statSync, mkdirSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { defineGroup, defineOp, OpError } from '../registry.mjs';
import { APP_VERSION_NAME, APP_VERSION_CODE } from '../../config/versions.mjs';
import { ROOT } from '../../config/index.mjs';
import { DISTRO, feedbackDest, isFeedbackDeclared } from '../../config/distro.mjs';
import { recentLogs } from '../../runtime/log-ring.mjs';
import { feedbackUpstream } from '../../runtime/feedback-upstream.mjs';
import { saveLocalFeedback } from '../../runtime/feedback-local.mjs';

// 反馈去向（发行版声明 distro.feedback，见 config/distro.mjs）：没声明 = 「bridge 开发者」，下面所有文案与现状逐字相同
const DEST = feedbackDest();
const DECLARED = isFeedbackDeclared();
const TO = DEST.to;
// 去向是公开的（比如中继把反馈发成公开 GitHub Issue）：知情同意时要说清会公开、别写隐私；图片按实际——中继只记个数
export const PUBLIC_NOTE = '这个去向是公开的：发出去的文字任何人都能看到，别写进隐私、账号、密钥、对话原文；截图不会公开发布（只记张数）。';

defineGroup('feedback', '问题反馈', `看现场、把 bug 报给这台服务器的管理员和 ${TO}。`);

const isAdmin = (ctx) => ctx.kind === 'admin';
const CRASH_DIR = path.join(ROOT, 'crashdumps');

// 「能不能发给开发者」翻成一句给 Claude 转述的话
export function shareInfo(st, admin, dest = DEST) {
  const TO = dest.to, declared = isFeedbackDeclared(dest), pub = dest.public ? ' ' + PUBLIC_NOTE : '';
  if (st.mode === 'push') return { canShare: true, note: `上报会同时发给 ${TO}（经反馈中继，不带用户名）。` + pub };
  if (st.mode === 'inbox') return { canShare: false, note: declared ? '这台就是反馈的汇总端（收件服务器）：上报只进本机反馈库。' : '这台就是 bridge 开发者自己的服务器：上报只进本机反馈库。' };
  if (st.reason === 'instance') return { canShare: false, note: '这是测试 / 开发实例，不跟反馈中继说话：上报只进本机反馈库。' };
  if (st.reason === 'no-relay') return { canShare: false, note: '这台服务器没配反馈中继（自己编译 / fork 的版本没有这条通道）：上报只进本机反馈库，由管理员处理。' };
  return admin
    ? { canShare: false, canEnable: true, note: `「把用户反馈同时发给 ${TO}」现在关着。你是管理员：用户明确同意的话，report 带 enableSharing=true 会顺手打开它（之后在设置 › 反馈里随时能关）。` + pub }
    : { canShare: false, note: `这台服务器的管理员没打开「发给 ${TO}」：上报只进本机反馈库，管理员能看到。` };
}

// 最近几份 Node 崩溃报告（fatal-guard 写的 report.*.json）：只取事件、时间和栈顶几帧，环境变量 / 命令行一概不碰
function crashSummaries(days = 7, max = 3) {
  let names = [];
  try { names = readdirSync(CRASH_DIR).filter((f) => /^report\..*\.json$/.test(f)); } catch { return []; }
  const since = Date.now() - days * 86400_000;
  return names
    .map((f) => { try { return { f, t: statSync(path.join(CRASH_DIR, f)).mtimeMs }; } catch { return null; } })
    .filter((x) => x && x.t >= since).sort((a, b) => b.t - a.t).slice(0, max)
    .map(({ f, t }) => {
      try {
        const r = JSON.parse(readFileSync(path.join(CRASH_DIR, f), 'utf8'));
        const js = r.javascriptStack || {};
        return { at: new Date(t).toISOString(), event: String(r.header?.event || '').slice(0, 200), trigger: r.header?.trigger || '', message: String(js.message || '').slice(0, 300), stack: (js.stack || []).slice(0, 6).map((s) => String(s).slice(0, 200)) };
      } catch { return { at: new Date(t).toISOString(), event: '（报告读不出来）' }; }
    });
}

defineOp({
  name: 'feedback.status', title: '上报会发到哪',
  desc: `这台服务器上报 bug 的去向：只进本机反馈库，还是也会发给 ${TO}；不能发的原因。report 之前先看它，跟用户确认时照实说去向。` + (DEST.public ? ' ' + PUBLIC_NOTE : ''),
  handler: async (ctx) => {
    const admin = isAdmin(ctx);
    const st = feedbackUpstream().state({ admin });
    return { mode: st.mode, ...shareInfo(st, admin), ...(DECLARED ? { destination: TO, destinationPublic: DEST.public } : {}), ...(admin ? { libraryDir: st.libraryDir, pending: st.pending, lastError: st.lastError || '' } : {}) };
  },
});

defineOp({
  name: 'feedback.diagnose', title: '看现场（版本、报错日志、崩溃）',
  desc: `用户怀疑 bridge 出 bug 时先调它：返回版本、平台、服务端已运行多久、上报去向；管理员身份还带最近的服务端警告 / 报错日志（进程内留的最近几百行，重启即清）和最近几天的崩溃报告摘要。
普通成员看不到服务端日志（里面有别人的活动），只能靠用户描述、截图和你自己的复现。
日志里出现报错不等于就是 bug：先对上用户说的现象和时间，能复现最好；是用户操作或配置问题就直接帮他解决，不用上报。`,
  params: {
    minutes: { type: 'integer', min: 1, max: 1440, default: 60, desc: '看最近多少分钟的日志' },
    grep: { type: 'string', max: 100, desc: '只要含这个词的日志行（不分大小写），比如报错里的关键字' },
    level: { type: 'string', enum: ['error', 'warn', 'all'], default: 'warn', desc: 'error=只要报错；warn=警告和报错；all=全部' },
    limit: { type: 'integer', min: 1, max: 300, default: 80, desc: '最多几行' },
  },
  handler: async (ctx, args) => {
    const admin = isAdmin(ctx);
    const st = feedbackUpstream().state({ admin });
    const out = {
      server: {
        version: APP_VERSION_NAME, versionCode: APP_VERSION_CODE, ...(DISTRO.id !== 'bridge' ? { distro: DISTRO.id } : {}),
        platform: `${process.platform} ${process.arch}`, os: `${os.type()} ${os.release()}`, node: process.version,
        uptimeMinutes: Math.round(process.uptime() / 60),
      },
      reporting: { mode: st.mode, ...shareInfo(st, admin) },
    };
    if (!admin) return { ...out, logs: null, logsNote: '服务端日志只有管理员能看。' };
    const since = Date.now() - args.minutes * 60_000;
    const levels = args.level === 'error' ? ['error'] : args.level === 'warn' ? ['warn', 'error'] : null;
    const q = (args.grep || '').toLowerCase();
    const rows = recentLogs(600).filter((l) => l.t >= since && (!levels || levels.includes(l.level)) && (!q || l.text.toLowerCase().includes(q)));
    out.logs = rows.slice(-args.limit).map((l) => `${new Date(l.t).toISOString().slice(11, 19)} ${l.level === 'log' || l.level === 'info' ? '' : l.level.toUpperCase() + ' '}${l.text.slice(0, 600)}`);
    out.logsNote = rows.length > args.limit ? `共 ${rows.length} 行，只给了最后 ${args.limit} 行` : `共 ${rows.length} 行`;
    out.crashes = crashSummaries();
    return out;
  },
});

defineOp({
  name: 'feedback.report', title: '上报一个 bug',
  access: 'danger',
  desc: `把确认过的 bug 报上去：本机反馈库总是落一份；share=true 且这台服务器开着「发给 ${TO}」时，再经反馈中继发给 ${TO}（发出去收不回）。${DEST.public ? '\n' + PUBLIC_NOTE + '跟用户确认时要把这一点说清楚。' : ''}
调用前必须先跟用户确认：用一两句话复述你认定的问题、会附上什么（日志摘录、截图）、发到哪（feedback.status 的说法），用户同意了才调。
details 写成开发者拿来就能查的样子：用户看到了什么、怎么触发（步骤）、期望怎样、你查到的线索和判断。不要写进用户的私人内容（对话原文、文件内容、账号、密钥）。
evidence 只放和这个 bug 相关的几行日志 / 报错原文。本机主机名、公网域名、用户名会先抹掉，中继再脱敏一遍（令牌、邮箱、网址、路径、IP），但图片原样发出——截图里有隐私就别附。`,
  params: {
    title: { type: 'string', required: true, max: 120, desc: '一句话标题，如「工作空间里重命名中文文件夹报 500」' },
    details: { type: 'string', required: true, max: 6000, desc: '现象、复现步骤、期望、你的诊断' },
    evidence: { type: 'string', max: 4000, desc: '相关的日志 / 报错原文摘录' },
    screen: { type: 'string', max: 80, desc: '出问题的界面位置，如「Claude 页 › 设置 › 模型」' },
    attachments: { type: 'array', desc: '截图的绝对路径（最多 3 张随报告发出；只认你自己的 uploads 和工作空间里的文件）' },
    share: { type: 'boolean', default: true, desc: `也发给 ${TO}（用户同意了才 true；false = 只进本机反馈库）` },
    enableSharing: { type: 'boolean', default: false, desc: `仅管理员：这台服务器的「发给 ${TO}」关着时顺手打开（用户明确同意才传）` },
  },
  handler: async (ctx, args, env) => {
    const admin = isAdmin(ctx);
    const up = feedbackUpstream();
    const id = env.identity || { kind: ctx.kind, user: ctx.user || null, tier: ctx.tier };
    if (args.enableSharing) {
      if (!admin) throw new OpError('forbidden', `只有管理员能打开「发给 ${TO}」`);
      const st = up.state({ admin: true });
      if (st.mode === 'off' && !st.reason && !st.enabled) {
        try { up.setPush(true); } catch (e) { throw new OpError('failed', String((e && e.message) || e)); }
      }
    }
    const atts = (args.attachments || []).slice(0, 9).map((p) => ({ path: String(p || '') }));
    // 同机 dimensio 实例经 BridgeCall 调来的（http.mjs 按凭据标 env.instance），报告里写明是谁诊断的
    const via = env.instance === 'dimensio' ? 'dimensio' : 'claude';
    const text = [
      `【经 ${via === 'dimensio' ? 'dimensio' : 'Claude'} 诊断后上报】` + args.title.trim(),
      '',
      args.details.trim(),
      ...(args.evidence && args.evidence.trim() ? ['', '相关日志 / 报错：', '```', args.evidence.trim(), '```'] : []),
    ].join('\n').slice(0, 8000);
    let saved;
    try {
      saved = saveLocalFeedback({ id, ctx, text, screen: args.screen || '', attachments: atts, via, title: args.title.trim(), allowDirs: [ctx.cwd] });
    } catch (e) { throw new OpError('failed', '写本机反馈库失败：' + ((e && e.message) || e)); }
    let upstream = 'off';
    if (args.share) {
      try { upstream = up.submit({ text, screen: args.screen || '', role: admin ? 'admin' : 'user', user: id.user || '', files: saved.srcs, consent: true }); }
      catch (e) { console.error('[feedback] 推送排队失败：' + ((e && e.message) || e)); }
    }
    const st = up.state({ admin });
    const sent = upstream === 'queued';
    return {
      saved: true,
      ...(admin ? { file: saved.file } : {}),
      attached: saved.srcs.length,
      ...(atts.length > saved.srcs.length ? { skippedAttachments: atts.length - saved.srcs.length } : {}),
      sentToDeveloper: sent,
      note: sent
        ? `已存进本机反馈库，并排进了发给 ${TO}的队列（发不出去会自动补发）。` + (DEST.public ? ' 这个去向是公开的：内容发出去后会被公开发布。' : '')
        : !args.share ? '按用户的意思只存进了本机反馈库。' : (DECLARED ? '已存进本机反馈库，没有发出去。原因：' : '已存进本机反馈库，没有发给开发者。原因：') + shareInfo(st, admin).note,
    };
  },
});

// —— 调试模式反馈（设置 › Claude / dimensio › 调试 › 调试模式）——
// 开着调试模式的会话把「harness 自己的毛病」记下来：工具报错是工具的锅、冗余 / 没必要的设计、缺的功能、不得不绕的路。
// 只落本机、不经中继、不用跟用户确认（这正是管理员打开调试模式要的东西）；放在服务端根目录 harness-feedback/<agent>/<日期>/，
// 每条一份 md，另在 harness-feedback/index.jsonl 追一行便于汇总。
export const HARNESS_FEEDBACK_DIR = path.join(ROOT, 'harness-feedback');
const HF_KINDS = { bug: '工具报错 / 行为不对', redundant: '冗余或没必要的设计', missing: '功能缺失', workaround: '不得不绕路', friction: '别扭难用' };
// Windows 文件名的非法字符全换掉：漏了反斜杠时它会被当成目录分隔符（11-08 记「Bash 吞反斜杠」那条就因此 ENOENT 丢了）。
const hfSlug = (s) => String(s || '').replace(/[\\/:*?"<>|\s\u0000-\u001f]+/g, '-').slice(0, 40).replace(/^[-.]+|[-.]+$/g, '') || 'note';

export function saveHarnessFeedback({ agent, args, sessionId = '' }) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  const hms = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const dir = path.join(HARNESS_FEEDBACK_DIR, agent, day);
  mkdirSync(dir, { recursive: true });
  let file = path.join(dir, `${hms}-${args.kind}-${hfSlug(args.title)}.md`);
  for (let i = 2; existsSync(file); i++) file = path.join(dir, `${hms}-${args.kind}-${hfSlug(args.title)}-${i}.md`);
  const meta = [
    `- 类型：${args.kind}（${HF_KINDS[args.kind]}）`,
    `- 严重度：${args.severity}`,
    `- agent：${agent}${args.model ? ' · ' + args.model : ''}`,
    ...(args.tool ? [`- 涉及工具 / 环节：${args.tool}`] : []),
    ...(sessionId || args.session ? [`- 会话：${sessionId || args.session}`] : []),
    `- 时间：${now.toISOString()}`,
  ];
  const body = [
    `# ${args.title.trim()}`, '', ...meta, '',
    ...(args.task ? ['## 当时在做什么', args.task.trim(), ''] : []),
    '## 问题说明', args.details.trim(), '',
    ...(args.evidence ? ['## 证据（报错原文 / 调用参数 / 输出摘录）', '```', args.evidence.trim(), '```', ''] : []),
    ...(args.workaround ? ['## 我是怎么绕过去的', args.workaround.trim(), ''] : []),
    ...(args.suggestion ? ['## 改进建议', args.suggestion.trim(), ''] : []),
  ].join('\n');
  writeFileSync(file, body, 'utf8');
  const rel = path.relative(HARNESS_FEEDBACK_DIR, file).split(path.sep).join('/');
  appendFileSync(path.join(HARNESS_FEEDBACK_DIR, 'index.jsonl'), JSON.stringify({ at: now.toISOString(), agent, kind: args.kind, severity: args.severity, tool: args.tool || '', title: args.title.trim(), file: rel, session: sessionId || args.session || '' }) + '\n', 'utf8');
  return file;
}

defineOp({
  name: 'feedback.harness', title: '调试模式：记一条 harness 反馈',
  access: 'write',
  desc: `只在开着「调试模式」的会话里用：把 harness（你手上的工具、系统提示、bridge / dimensio 的机制）本身的毛病记进服务端根目录的反馈文件夹，供之后改进 harness。
不发给任何人、不用先问用户；一个问题一条，发现就记，不要攒到最后。
kind：bug=工具报错或行为不对且确是工具的锅；redundant=冗余 / 没必要的设计、多余的步骤或提示；missing=缺的功能；workaround=为了完成任务不得不故意绕；friction=能用但别扭（参数难懂、返回不够、说明误导）。
details 写清现象与你判断是 harness 的锅（而不是任务本身 / 你自己用错）的理由；evidence 放报错原文、调用参数、关键输出；suggestion 写你希望 harness 怎么改。返回写好的文件路径。`,
  params: {
    kind: { type: 'string', required: true, enum: Object.keys(HF_KINDS), desc: 'bug | redundant | missing | workaround | friction' },
    title: { type: 'string', required: true, max: 120, desc: '一句话标题，如「Edit 对 CRLF 文件匹配失败」' },
    details: { type: 'string', required: true, max: 8000, desc: '问题说明：现象、触发方式、为什么认定是 harness 的问题、影响' },
    tool: { type: 'string', max: 80, desc: '涉及的工具或环节，如 Edit、mcp__browser__browser、系统提示「交付文件」一节、权限审批' },
    severity: { type: 'string', enum: ['low', 'medium', 'high'], default: 'medium', desc: 'high=挡住任务或给出错误结果；medium=多花了明显的功夫；low=小瑕疵' },
    task: { type: 'string', max: 600, desc: '当时在做的事（一两句，别贴用户原文里的隐私）' },
    evidence: { type: 'string', max: 6000, desc: '报错原文 / 调用参数 / 输出摘录' },
    workaround: { type: 'string', max: 2000, desc: '你实际是怎么绕过去的（kind=workaround 时必写）' },
    suggestion: { type: 'string', max: 3000, desc: '改进建议' },
    model: { type: 'string', max: 80, desc: '你当前的模型名' },
    session: { type: 'string', max: 80, desc: '会话 id（知道就填）' },
  },
  handler: async (ctx, args, env) => {
    if (!isAdmin(ctx)) throw new OpError('forbidden', '调试模式反馈只给主机管理员');
    const agent = env.instance === 'dimensio' ? 'dimensio' : 'claude';
    let file;
    try { file = saveHarnessFeedback({ agent, args, sessionId: env.sessionId || '' }); }
    catch (e) { throw new OpError('failed', '写反馈文件失败：' + ((e && e.message) || e)); }
    return { saved: true, file, note: '已记下。继续手头的任务，再遇到 harness 的问题照样随手记。' };
  },
});
