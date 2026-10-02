// AskUserQuestion bridge between Claude's tool-call interception and the phone.
// The model's AskUserQuestion tool is interactive; headless it auto-returns an
// empty answer (the phone never sees the question). We intercept it in
// canUseTool, push the question to the phone over SSE, wait for the phone to
// POST its choice to /api/answer, then feed that choice back to the model as
// the (denied) tool result — deny.message is the only channel that becomes the
// tool_result content the model reads.

import { readBody } from './body.mjs';
import { contextFor } from './identity.mjs';

// qid -> { settle(value) }
export const pendingQuestions = new Map();
// sessionId -> { qid, questions, ts }
// Which sessions have an AskUserQuestion waiting for an answer. Lets the phone
// mark "this conversation is asking you something" in the conversation list,
// even when it's not the open conversation.
export const sessionQuestions = new Map();

export function waitForAnswer(qid, signal, timeoutMs = 600_000, ownerKey = null) {
  return new Promise((resolve, reject) => {
    let done = false;
    const cleanup = () => {
      done = true;
      pendingQuestions.delete(qid);
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => { if (!done) { cleanup(); reject(new Error('aborted')); } };
    const timer = setTimeout(() => { if (!done) { cleanup(); reject(new Error('timeout')); } }, timeoutMs);
    pendingQuestions.set(qid, {
      // ownerKey = the identity (admin / u:<name>) whose turn raised this question.
      // Only that identity may answer it (see handleAnswer).
      ownerKey,
      settle: (value) => { if (!done) { cleanup(); resolve(value); } },
    });
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

export function formatAnswer(questions, ans) {
  if (ans && ans.cancelled) {
    return '（用户取消了这次选择，没有作答。可以改用普通文字向用户提问，或根据已有信息继续。）';
  }
  const answers = (ans && Array.isArray(ans.answers)) ? ans.answers : [];
  const lines = ['用户在手机上回答了你刚才的提问，选择如下：'];
  questions.forEach((q, i) => {
    const a = answers[i] || {};
    const picks = [];
    if (Array.isArray(a.selected)) picks.push(...a.selected.filter(Boolean));
    if (a.custom && String(a.custom).trim()) picks.push('（自定义）' + String(a.custom).trim());
    lines.push('');
    lines.push('【' + (q.header || ('问题' + (i + 1))) + '】' + (q.question || ''));
    lines.push('答：' + (picks.length ? picks.join('、') : '（未选）'));
  });
  return lines.join('\n');
}

// POST /api/answer handler: the phone POSTs the user's choice; we settle the
// promise that the canUseTool interception is awaiting.
export async function handleAnswer(req, res, { identify }) {
  // Any authenticated caller (admin OR an account user) may answer — a sandboxed
  // user rides their bridge_user cookie. Previously this required the admin token,
  // so a logged-in user could never answer their own Claude's question and it hung
  // until timeout.
  const id = identify(req);
  // 公开只读分享（share）不能答题；聊天快照访客（snap）要能答自己快照里的提问，照旧放行。
  if (!id || id.kind === 'none' || id.kind === 'share') {
    res.writeHead(401, { 'Content-Type': 'text/plain' });
    res.end('unauthorized');
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(await readBody(req));
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    res.end('bad json');
    return;
  }
  const qid = String(parsed.qid || '');
  const entry = pendingQuestions.get(qid);
  if (!entry) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('no pending question for that id');
    return;
  }
  // Bind the answer to the identity whose turn raised the question. The qid is only
  // ever sent over that caller's own SSE stream; this is defense-in-depth so a
  // leaked qid can't be used by another account to answer (or hijack) the question.
  if (entry.ownerKey && entry.ownerKey !== contextFor(id).key) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('forbidden');
    return;
  }
  // choice：安全栅门 Paused 卡的二选一（retry_fallback / edit_prompt），由等待方自己校验取值。
  const choice = typeof parsed.choice === 'string' ? parsed.choice.slice(0, 40) : undefined;
  entry.settle(parsed.cancelled ? { cancelled: true } : { answers: Array.isArray(parsed.answers) ? parsed.answers : [], ...(choice ? { choice } : {}) });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}
