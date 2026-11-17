// 会话路由（src/routes/sessions.mjs）的特征基准：拆分前后，一组有代表性的请求的状态码、内容类型与（规整后的）响应逐字不变。
// 进程内用真路由器（runtime/router.mjs）挂 registerSessionRoutes，起一个本机 HTTP 服务按顺序打请求；会话数据是临时目录里
// 造的样例转录，数据根 / Vault / 账号库 / Claude 配置目录 / 家目录全部隔离（做法同 agents/testing/chat-suite.mjs）。
//
// 不进全量测试（文件名不是 *.test.mjs）。拆分前后这样跑（在仓库根）：
//   node --import ./src/modules/register.mjs --test src/routes/characterization/sessions-routes.char.mjs
// 有意改行为时在未改动的代码上加 UPDATE_CHAR_BASELINE=1 重新生成基准。
//
// 本文件不能静态 import bridge 的运行时模块：环境变量要先于它们设好。
import test from 'node:test';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baselineStore, Normalizer } from './normalize.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const store = baselineStore(path.join(here, 'sessions-routes.baseline.json'), {
  update: process.env.UPDATE_CHAR_BASELINE === '1',
  actualDir: process.env.CHAR_ACTUAL_DIR,
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dimensio-char-bridge-'));
const dirs = { data: path.join(tmp, 'data'), vault: path.join(tmp, 'vault'), users: path.join(tmp, 'users'), claude: path.join(tmp, 'claude'), home: path.join(tmp, 'home') };
for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true });
for (const k of Object.keys(process.env)) {
  if (/^(ANTHROPIC_|_CLAUDE_|CLAUDE|BRIDGE_|VERTEX_|GEMINI_|OPENROUTER_|GIT_)/i.test(k) || ['PORT', 'VAULT_PATH', 'PYTHONIOENCODING', 'CODEX_BIN', 'PV_PUBLIC_DOMAIN'].includes(k)) delete process.env[k];
}
Object.assign(process.env, {
  BRIDGE_DATA_ROOT: dirs.data,
  VAULT_PATH: dirs.vault,
  BRIDGE_USERS_ROOT: dirs.users,
  CLAUDE_CONFIG_DIR: dirs.claude,
  USERPROFILE: dirs.home,
  HOME: dirs.home,
  APPDATA: path.join(dirs.home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(dirs.home, 'AppData', 'Local'),
  BRIDGE_MODULES_SKIP: 'all',
  BRIDGE_CLAUDE_IN_CHROME: '0',
  BRIDGE_NO_ROUTINES: '1',
  BRIDGE_DESKTOP_MIRROR: '0',
  BRIDGE_CLAUDE_CLI_DOWNLOAD: '0',
  BRIDGE_PLUGINS_STATE: path.join(dirs.data, 'plugins.json'),
  BRIDGE_PLUGINS_DIR: path.join(dirs.data, 'plugins'),
});

const { createRouter } = await import('../../runtime/router.mjs');
const { registerSessionRoutes } = await import('../sessions.mjs');
const { sessionsDir } = await import('../../runtime/paths.mjs');

// ── 样例转录 ──
const S1 = '11111111-1111-4111-8111-111111111111';
const S2 = '22222222-2222-4222-8222-222222222222';
const S3 = '33333333-3333-4333-8333-333333333333';
const ts = (n) => new Date(Date.UTC(2026, 0, 10, 9, 0, n)).toISOString();
const base = (sid, uuid, parentUuid, n) => ({ sessionId: sid, uuid, parentUuid, timestamp: ts(n), cwd: dirs.vault, version: '2.1.0' });
const user = (sid, uuid, parent, n, content, extra = {}) => ({ type: 'user', ...base(sid, uuid, parent, n), message: { role: 'user', content }, ...extra });
const asst = (sid, uuid, parent, n, content) => ({ type: 'assistant', ...base(sid, uuid, parent, n), message: { role: 'assistant', id: `msg_${uuid}`, model: 'claude-x', content, usage: { input_tokens: 10, output_tokens: 5 } } });
const tu = (id, name, input) => ({ type: 'tool_use', id, name, input });
const tr = (id, content, isError = false) => [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }];

fs.writeFileSync(path.join(dirs.vault, 'notes.md'), '# notes\nhello\n');
fs.writeFileSync(path.join(dirs.vault, 'report.html'), '<title>report</title><h1>report</h1>');
const transcripts = {
  [S1]: [
    user(S1, 'a1', null, 0, '帮我看一下 notes.md 并写个报告'),
    asst(S1, 'a2', 'a1', 1, [{ type: 'thinking', thinking: '先读文件', signature: 'sig' }, { type: 'text', text: '我先读一下。' }, tu('t1', 'Read', { file_path: path.join(dirs.vault, 'notes.md') })]),
    user(S1, 'a3', 'a2', 2, tr('t1', '# notes\nhello')),
    asst(S1, 'a4', 'a3', 3, [tu('t2', 'Bash', { command: 'ls', description: 'List files' })]),
    user(S1, 'a5', 'a4', 4, tr('t2', 'notes.md\nreport.html')),
    asst(S1, 'a6', 'a5', 5, [tu('t3', 'Write', { file_path: path.join(dirs.vault, 'report.html'), content: '<h1>report</h1>' })]),
    user(S1, 'a7', 'a6', 6, tr('t3', 'File created successfully')),
    asst(S1, 'a8', 'a7', 7, [tu('t4', 'AskUserQuestion', { questions: [{ question: '要不要发出去？', header: '发送', options: [{ label: '要' }, { label: '不要' }], multiSelect: false }] })]),
    user(S1, 'a9', 'a8', 8, tr('t4', 'User has answered your questions: "要不要发出去？"="要". You can now continue with the user\'s answers in mind.')),
    asst(S1, 'a10', 'a9', 9, [{ type: 'text', text: '报告写好了：report.html。' }]),
    user(S1, 'a11', 'a10', 10, '<command-name>/compact</command-name>\n<command-message>compact</command-message>'),
    user(S1, 'a12', 'a11', 11, '再改一下标题'),
    asst(S1, 'a13', 'a12', 12, [tu('t5', 'Edit', { file_path: path.join(dirs.vault, 'notes.md'), old_string: 'hello', new_string: 'hi' })]),
    user(S1, 'a14', 'a13', 13, tr('t5', 'permission denied by user', true)),
    asst(S1, 'a15', 'a14', 14, [{ type: 'text', text: '没改成，等你决定。' }]),
  ],
  [S2]: [
    user(S2, 'b1', null, 0, '计划一下怎么整理笔记'),
    asst(S2, 'b2', 'b1', 1, [tu('p1', 'ExitPlanMode', { plan: '1. 归类\n2. 合并重复' })]),
    user(S2, 'b3', 'b2', 2, tr('p1', 'User has approved your plan. You can now start coding.')),
    asst(S2, 'b4', 'b3', 3, [tu('k1', 'Task', { description: '查重复', prompt: '找出重复的笔记', subagent_type: 'general-purpose' })]),
    user(S2, 'b5', 'b4', 4, tr('k1', [{ type: 'text', text: '有两篇重复' }])),
    asst(S2, 'b6', 'b5', 5, [{ type: 'text', text: '整理完了。' }]),
    { type: 'custom-title', customTitle: '整理笔记的计划', sessionId: S2 },
  ],
  [S3]: [
    user(S3, 'c1', null, 0, '第一问'),
    asst(S3, 'c2', 'c1', 1, [{ type: 'text', text: '答一' }]),
    { type: 'system', subtype: 'compact_boundary', ...base(S3, 'cB', null, 2), parentUuid: null, logicalParentUuid: 'c2', content: 'Conversation compacted', compactMetadata: { trigger: 'auto', preTokens: 900000, postTokens: 20000 } },
    user(S3, 'cS', 'cB', 3, 'This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. 第一问', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
    user(S3, 'c3', 'cS', 4, '第二问'),
    asst(S3, 'c4', 'c3', 5, [{ type: 'text', text: '答二' }]),
    { type: 'summary', summary: '两问两答', leafUuid: 'c4' },
  ],
};
const projDir = sessionsDir(dirs.vault, dirs.claude);
fs.mkdirSync(projDir, { recursive: true });
let day = 1;
for (const [sid, recs] of Object.entries(transcripts)) {
  const file = path.join(projDir, `${sid}.jsonl`);
  fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n');
  const t = new Date(Date.UTC(2026, 0, day++, 8, 0, 0));
  fs.utimesSync(file, t, t);
}

async function freePort(start) {
  for (let p = start; p < start + 40; p++) {
    const ok = await new Promise((r) => { const s = net.createServer(); s.once('error', () => r(false)); s.listen(p, '127.0.0.1', () => s.close(() => r(true))); });
    if (ok) return p;
  }
  throw new Error('no free port');
}

test('SR01 会话路由：状态码、内容类型、响应', { timeout: 120_000 }, async () => {
  const router = createRouter();
  const identify = (req) => ({ kind: req.headers['x-char-who'] || 'admin' });
  registerSessionRoutes(router, { authOk: () => true, identify });
  const server = http.createServer((req, res) => router.dispatch(req, res));
  const port = await freePort(8891);
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const norm = new Normalizer([
    [new RegExp(`127\\.0\\.0\\.1:${port}`, 'g'), '127.0.0.1:<port>'],
    [/"etag":"[^"]*"/g, '"etag":"<etag>"'],
    // 临时对话桶按（随机的）家目录算出的目录名；落盘文件名里的毫秒时刻与日期
    [/(bridge-quickchat[\\/]+)i-[0-9a-f]+/g, '$1i-<hash>'],
    [/\b1\d{12}\b/g, '<epoch>'],
    [/\d{4}-\d{2}-\d{2}(?=_)/g, '<DATE>'],
  ], /^(created|updated|rev)$/);
  const results = [];
  const hit = async (name, method, p, body, headers = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, {
      method,
      headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const type = (res.headers.get('content-type') || '').split(';')[0];
    const buf = Buffer.from(await res.arrayBuffer());
    let value;
    if (/json/.test(type)) { try { value = JSON.parse(buf.toString('utf8')); } catch { value = buf.toString('utf8').slice(0, 3000); } }
    else if (/^text\//.test(type) || type === '') value = buf.toString('utf8').slice(0, 3000);
    else value = { bytes: buf.length };
    const head = { disposition: res.headers.get('content-disposition'), cache: res.headers.get('cache-control') };
    results.push({ name, status: res.status, type, head: norm.value(head), body: norm.value(value) });
    return value;
  };
  try {
    await hit('sessions-none', 'GET', '/api/sessions', undefined, { 'x-char-who': 'none' });
    await hit('sessions', 'GET', '/api/sessions');
    await hit('sessions-quick2', 'GET', '/api/sessions?quick=2');
    await hit('sessions-archived', 'GET', '/api/sessions?view=archived');
    await hit('sessions-page', 'GET', '/api/sessions?limit=1');
    await hit('sessions-keep', 'GET', `/api/sessions?keep=${S1},44444444-4444-4444-8444-444444444444`);
    await hit('locations', 'GET', '/api/project/locations');
    const projects = await hit('projects', 'GET', '/api/claude/projects');
    await hit('projects-quick2', 'GET', '/api/claude/projects?quick=2');
    const created = await hit('project-create', 'POST', '/api/claude/project/create', { name: 'char-proj' });
    const pid = created && typeof created === 'object' ? (created.id || created.project?.id || '') : '';
    await hit('project-rename', 'POST', '/api/claude/project/rename', { id: pid, name: 'char-proj-2' });
    await hit('project-order', 'POST', '/api/claude/project/order', { ids: [pid] });
    await hit('project-delete', 'POST', '/api/claude/project/delete', { id: pid });
    await hit('project-bad-json', 'POST', '/api/claude/project/rename', 'not json');
    await hit('quick-new', 'POST', '/api/claude/quick/new', {});
    await hit('quick-save-bad', 'POST', '/api/claude/quick/save', { id: 'nope' });
    await hit('quick-keep-bad', 'POST', '/api/claude/quick/keep', { id: 'nope' });
    await hit('quick-recycled', 'GET', '/api/claude/quick/recycled');
    await hit('quick-restore-bad', 'POST', '/api/claude/quick/restore', { id: 'nope' });
    await hit('library-star', 'POST', '/api/claude/library', { op: 'star', id: S1, on: true });
    await hit('library-title', 'POST', '/api/claude/library', { op: 'title', id: S1, title: '改过的标题' });
    await hit('library-bad', 'POST', '/api/claude/library', 'nope');
    await hit('settings', 'GET', '/api/claude/settings');
    await hit('settings-post-bad', 'POST', '/api/claude/settings', { patch: { noSuchKey: 1 } });
    await hit('output-style', 'GET', `/api/claude/output-style?session=${S1}`);
    await hit('output-style-post', 'POST', '/api/claude/output-style', { session: S1, style: 'explanatory' });
    await hit('output-style-post-bad', 'POST', '/api/claude/output-style', { session: S1, style: 'nope' });
    await hit('rail', 'GET', `/api/claude/session-rail?id=${S1}`);
    await hit('rail-missing', 'GET', '/api/claude/session-rail?id=55555555-5555-4555-8555-555555555555');
    const s1 = await hit('session-1', 'GET', `/api/session?id=${S1}`);
    await hit('session-1-fp', 'GET', `/api/session?id=${S1}&fp=${encodeURIComponent((s1 && s1.fp) || '')}`);
    await hit('session-2', 'GET', `/api/session?id=${S2}`);
    await hit('session-3', 'GET', `/api/session?id=${S3}`);
    await hit('session-missing', 'GET', '/api/session?id=66666666-6666-4666-8666-666666666666');
    await hit('session-bad-id', 'GET', '/api/session?id=..%2F..%2Fx');
    await hit('sessions-after-title', 'GET', '/api/sessions');
    await hit('artifact', 'GET', `/api/claude/artifact?id=${S1}&path=${encodeURIComponent(path.join(dirs.vault, 'report.html'))}`);
    await hit('artifact-dl', 'GET', `/api/claude/artifact?id=${S1}&path=${encodeURIComponent(path.join(dirs.vault, 'report.html'))}&dl=1`);
    await hit('artifact-missing', 'GET', `/api/claude/artifact?id=${S1}&path=${encodeURIComponent(path.join(dirs.vault, 'nope.txt'))}`);
    await hit('artifact-locate', 'GET', `/api/claude/artifact?id=${S1}&locate=1&name=report.html`);
    await hit('quote', 'POST', '/api/session/quote', { id: S2, title: '整理笔记的计划' });
    await hit('quote-bad', 'POST', '/api/session/quote', { id: 'nope' });
    await hit('export', 'POST', '/api/session/export', { id: S3 });
    await hit('export-bad', 'POST', '/api/session/export', 'x');
    await hit('rewind-bad', 'POST', '/api/claude/rewind', { sessionId: S1 });
    await hit('rewind', 'POST', '/api/claude/rewind', { sessionId: S1, uuid: 'a12', mode: 'conversation' });
    await hit('session-1-after-rewind', 'GET', `/api/session?id=${S1}`);
    await hit('delete', 'POST', '/api/session/delete', { id: S3 });
    await hit('delete-again', 'POST', '/api/session/delete', { id: S3 });
    await hit('sessions-after-delete', 'GET', '/api/sessions');
    await hit('unknown', 'GET', '/api/sessions/nope');
    void projects;
  } finally {
    await new Promise((r) => server.close(r));
  }
  store.check('SR01-routes', results);
});

test.after(() => {
  store.flush();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows 句柄 */ }
  // 被测模块留着几个兜底定时器；结果都已输出，不等它们
  setTimeout(() => process.exit(process.exitCode || 0), 200);
});
