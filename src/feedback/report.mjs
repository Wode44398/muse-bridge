// 出草稿、发报告、补发。网页（routes/feedback.mjs）、Muse（bootstrap.sh report → cli.mjs）、自动上报（auto.mjs）
// 三个入口都走这里：同一套白名单收集、同一份脱敏、同一个提交通道。
//
// 提交通道：项目方的 Cloudflare Worker（feedback-worker/）。它手里有 GitHub App 的私钥，以 App 的身份在
// 公开仓库开 Issue（同一个指纹已有 Issue 就 +1），安全问题改走仓库的私密漏洞报告。这台服务器上没有任何
// GitHub 凭据——安装包是公开的，放进来就等于公开。Worker 不通时报告进 outbox，之后补发；
// 实在发不了，还能给用户一个预填好的 GitHub「新建 Issue」链接。
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { PROGRAM_ROOT } from '../runtime/paths.mjs';
import { cleanReport } from './schema.mjs';
import { issueTitle, issueBody } from './render.mjs';
import { recentErrors } from './errors.mjs';
import * as store from './store.mjs';

export const REPO = 'Wode44398/muse-bridge';
export const FEEDBACK_URL = (process.env.MUSE_FEEDBACK_URL || 'https://muse-bridge-feedback.huole8610.workers.dev').replace(/\/+$/, '');
export const feedbackHost = () => { try { return new URL(FEEDBACK_URL).hostname; } catch { return ''; } };

export function programVersion() {
  try {
    const v = readFileSync(path.join(PROGRAM_ROOT, 'deploy', 'muse', 'VERSION'), 'utf8').split('\n')[0].trim();
    return v && !v.startsWith('$Format') ? v : 'dev';
  } catch { return 'dev'; }
}

// 公网主机名（自己的域名）也算隐私：出现在任何文字里都抹掉
function literals(extra = []) {
  const out = [...extra];
  const o = process.env.BRIDGE_PUBLIC_ORIGIN || '';
  try { if (o) out.push(new URL(o).hostname); } catch {}
  return out.filter(Boolean);
}

/**
 * 出一份草稿（还没发）。input：
 *   kind, source, description, title, lang
 *   env        额外的环境信息（agents、users、tunnel、browser、page、uiLang…；版本 / Node / 系统这里自己填）
 *   services   { bridge: 'active', … }（bootstrap.sh 给）
 *   sites      [{ host, state }]
 *   trail      ['page:claude', 'api POST /api/chat → 500', …]（网页给）
 *   errors     额外的报错（浏览器里的），会跟服务端最近的报错合在一起
 *   logs       更新失败时的日志摘录
 *   withServerErrors  附上服务端最近 6 小时的报错（默认 true）
 */
export function makeDraft(input = {}) {
  const errs = [...(input.errors || [])];
  if (input.withServerErrors !== false) {
    for (const e of recentErrors({ limit: 4, sinceMs: Date.now() - 6 * 3600_000 })) if (!errs.some((x) => x.fp === e.fp)) errs.push(e);
  }
  const payload = cleanReport({
    install: store.installId(),
    kind: input.kind || 'bug',
    source: input.source || 'web',
    lang: input.lang,
    title: input.title,
    description: input.description,
    fp: input.fp,
    env: {
      version: programVersion(),
      node: process.version,
      // 内核版本只留数字段（6.10.14-linuxkit → 6.10.14）：后缀里没有排查要用的东西，还会被脱敏规则误伤
      os: `${os.type()} ${(os.release().match(/^\d+(?:\.\d+){0,2}/) || [''])[0]}`.trim().slice(0, 40),
      arch: process.arch,
      uptimeMin: input.source === 'muse' ? undefined : Math.round(process.uptime() / 60),
      ...(input.env || {}),
    },
    services: input.services,
    sites: input.sites,
    trail: input.trail,
    errors: errs.slice(0, 8),
    logs: input.logs,
  }, { literals: literals(input.literals) });
  const draft = { id: store.newId(), at: Date.now(), owner: input.owner || '', payload };
  store.saveDraft(draft);
  // 预览给人看：正文里为 GitHub 转义的 &lt;（不转义的话 <secret> 会被当成 HTML 标签吃掉）还原回来
  return { ...draft, preview: { title: issueTitle(payload), body: issueBody(payload).replace(/&lt;/g, '<') } };
}

/** 预填好的 GitHub「新建 Issue」链接：Worker 发不出去时的最后一条路（要用户自己有 GitHub 账号） */
export function fallbackUrl(payload) {
  const title = issueTitle(payload);
  let body = issueBody(payload);
  const u = (b) => `https://github.com/${REPO}/issues/new?labels=from-muse&title=${encodeURIComponent(title)}&body=${encodeURIComponent(b)}`;
  while (u(body).length > 7500 && body.length > 200) body = body.slice(0, Math.floor(body.length * 0.8)) + '\n…';
  return u(body);
}

async function post(payload, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(FEEDBACK_URL + '/v1/report', {
      method: 'POST', signal: ctl.signal,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'muse-bridge-feedback/1' },
      body: JSON.stringify(payload),
    });
    let j = {}; try { j = await r.json(); } catch {}
    return { status: r.status, body: j };
  } finally { clearTimeout(timer); }
}

/**
 * 发一份草稿。返回：
 *   { status: 'sent', issue: { number, url } | null, duplicate, private }
 *   { status: 'queued', reason }      网络不通 / Worker 暂时出错：进 outbox，之后补发
 *   { status: 'rejected', reason }    Worker 明确拒收（限流、格式不对、通道关了）——不补发
 * 三种都带 fallbackUrl。
 */
export async function sendDraft(id, { timeoutMs = 25_000 } = {}) {
  const d = store.loadDraft(id);
  if (!d) return { status: 'missing' };
  const res = await deliver(d.id, d.payload, timeoutMs, d.owner);
  store.dropDraft(d.id);
  if (res.status === 'queued') store.queueOutbox({ id: d.id, at: Date.now(), tries: 1, owner: d.owner || '', payload: d.payload });
  return res;
}

async function deliver(id, payload, timeoutMs, owner = '') {
  const fb = fallbackUrl(payload);
  let r;
  try { r = await post(payload, timeoutMs); }
  catch (e) { return { status: 'queued', reason: e?.name === 'AbortError' ? 'timeout' : 'network', fallbackUrl: fb }; }
  if (r.status === 200 && r.body?.ok) {
    const issue = r.body.issue && Number.isInteger(r.body.issue.number) ? { number: r.body.issue.number, url: String(r.body.issue.url || '') } : null;
    store.recordSent({
      id, owner, at: new Date().toISOString(), kind: payload.kind, source: payload.source, title: payload.title,
      fp: payload.fp || '', version: payload.env?.version || '', issue, duplicate: !!r.body.duplicate, private: !!r.body.private,
    });
    return { status: 'sent', issue, duplicate: !!r.body.duplicate, private: !!r.body.private, fallbackUrl: fb };
  }
  if (r.status >= 500 || r.status === 0) return { status: 'queued', reason: `worker ${r.status}`, fallbackUrl: fb };
  return { status: 'rejected', reason: String(r.body?.error || `http ${r.status}`), retryAfter: r.body?.retryAfter, fallbackUrl: fb };
}

/** 补发 outbox 里的报告（服务进程每 10 分钟一次；最多试 30 次、留 7 天） */
export async function flushOutbox() {
  const out = [];
  for (const o of store.listOutbox()) {
    if (Date.now() - (o.at || 0) > 7 * 86400_000 || (o.tries || 0) >= 30) { store.dropOutbox(o.id); continue; }
    const r = await deliver(o.id, o.payload, 20_000, o.owner || '');
    if (r.status === 'queued') store.queueOutbox({ ...o, tries: (o.tries || 0) + 1 });
    else store.dropOutbox(o.id);
    out.push({ id: o.id, ...r });
    if (r.status === 'queued') break;   // 还是不通：剩下的下一轮再试
  }
  return out;
}
