// 项目对话的概览接口（运行档位 › 项目，runtime/project-mode.mjs；前端 SessionRail 的项目卡片）：
//   GET  /api/claude/project?session=<项目对话>                 → { instructions, paused, memory:[{name,size,at}], limits:{ maxLive, daily, dailyLeft } }
//   POST /api/claude/project        { session, instructions?, paused?, threadModel?, threadEffort? } → 同上（暂停 = 停下项目对话和它所有在跑的讨论串、不再开新的；恢复 = 把攒着的汇报送进去）
//        threadModel / threadEffort：这个项目新开讨论串用的模型 / 档位，'' 或 null = 回到按设置（GET 的 thread 里带设置给的默认）
//   POST /api/claude/project/resolve { session, thread, resolved }      → { ok, resolved }（讨论串标为已解决 / 重新打开）
//   GET  /api/claude/project/memory?session=&name=             → { name, content }
//   POST /api/claude/project/memory { session, name, content | null }   → { ok, memory }（null = 删掉）
// 讨论串列表本身走会话信息面板那份（/api/claude/session-rail 的 family，项目对话里多带 waiting / resolved / at）。
// 变化经总线推 {type:'project', sessionId}，别的设备上的概览跟着重拉。身份门同会话工具：管理员与有 shell 的身份。
import { statSync, openSync, readSync, closeSync } from 'node:fs';
import { readBody } from '../runtime/body.mjs';
import { contextFor } from '../runtime/identity.mjs';
import { ID_RE } from '../jsonfile.mjs';
import { CLAUDE_MODELS } from '../config/capabilities.mjs';
import { isCustomModelId } from '../runtime/claude-providers.mjs';
import { busPublish } from '../runtime/bus.mjs';
import { findGenBySession } from '../runtime/gen.mjs';
import * as claudeProjects from '../claude-projects.mjs';
import { childrenOf, familyLink, wakeSoon, sessionTitleOf, defuseEnvelopes, envelopeNonce } from '../runtime/session-family.mjs';
import { isProjectSession, projectState, updateProject, projectSettings, dailyThreadsLeft, memoryList, memoryRead, memoryWrite, memoryNameOk, INSTRUCTIONS_MAX } from '../runtime/project-mode.mjs';

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

// —— 转成项目（档位菜单里普通对话的「转成项目」，routes/chat.mjs 调）——
// 新的项目对话以原会话为背景：首条消息前面附一张「原会话」卡（<session-message relation="source" kind="brief">）。
// 主机管理员给原会话 transcript 的路径，协调者自己用 Read / Grep 去读；沙箱身份的 transcript 在自己的配置目录里（围栏外读不到），
// 改附一份最近对话的摘录。拿不到原会话返回 ''（照普通项目对话开）。
const DIGEST_MAX = 12000;
function transcriptDigest(file) {
  let lines = [];
  try {
    const size = statSync(file).size, len = Math.min(size, 4 * 1024 * 1024);
    const fd = openSync(file, 'r'); const buf = Buffer.alloc(len);
    try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
    lines = buf.toString('utf8').split('\n');
  } catch { return ''; }
  const out = [];
  for (const s of lines) {
    if (!s.includes('"message"')) continue;
    let o; try { o = JSON.parse(s); } catch { continue; }
    if ((o.type !== 'user' && o.type !== 'assistant') || o.isSidechain || o.isMeta) continue;
    const c = o.message && o.message.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text).join('\n') : '';
    if (text.trim()) out.push((o.type === 'user' ? '用户：' : 'Claude：') + text.trim());
  }
  const all = out.join('\n\n');
  return all.length > DIGEST_MAX ? '…\n' + all.slice(-DIGEST_MAX) : all;
}
export async function projectSourceNote(ctx, srcSid) {
  const p = claudeProjects.locateSessionPaths(ctx.claudeProjects, claudeProjects.identityCtx(ctx), srcSid);
  if (!p || !p.file) return '';
  const title = String(await sessionTitleOf(ctx, srcSid) || '').replace(/"/g, "'").slice(0, 80);
  let body;
  if (ctx.kind === 'admin' && !ctx.sandbox) {
    body = `这条项目对话是从会话「${title || srcSid.slice(0, 8)}」转来的。原会话的完整记录在 ${p.file}（JSONL，每行一条消息，正文在 message.content 里）：先用 Read 读它（文件大就分段读、用 Grep 找关键处），弄清目标、已经做了什么、还剩什么。`;
  } else {
    const d = transcriptDigest(p.file);
    if (!d) return '';
    body = `这条项目对话是从会话「${title || srcSid.slice(0, 8)}」转来的，下面是原会话最近的对话摘录：\n\n${d}`;
  }
  return `<session-message from="${srcSid}" name="" title="${title}" relation="source" kind="brief" nonce="${envelopeNonce()}">\n${defuseEnvelopes(body)}\n</session-message>`;
}

function viewOf(ctx, sid) {
  const st = projectState(ctx, sid);
  const { maxLive, daily } = projectSettings(ctx);
  const s = projectSettings(ctx);
  return {
    instructions: st.instructions, paused: st.paused, memory: memoryList(ctx, sid),
    // 讨论串模型 / 档位：model / effort = 这个项目另选的（'' = 没选）；default* = 设置给的（defaultModel '' = 跟协调者）
    thread: { model: st.threadModel, effort: st.threadEffort, defaultModel: s.threadModel, defaultEffort: s.threadEffort },
    limits: { maxLive, daily, dailyLeft: Math.max(0, dailyThreadsLeft(ctx)), instructionsMax: INSTRUCTIONS_MAX },
  };
}
// 暂停：项目对话和它在跑的讨论串当场停下（硬停，同输入框的停止）
function stopAll(ctx, sid) {
  let n = 0;
  for (const id of [sid, ...childrenOf(ctx, sid).map((c) => c.id)]) {
    const g = findGenBySession(ctx.key, id);
    if (!g || g.done) continue;
    try { if (typeof g.hardStop === 'function') g.hardStop(); else g.abort.abort(); n++; } catch {}
  }
  return n;
}

export function registerProjectModeRoutes(router, { identify }) {
  const projCtx = (req, res) => {
    const who = identify(req);
    if (!who || who.kind === 'none' || who.kind === 'share') { json(res, 401, { error: 'unauthorized' }); return null; }
    const ctx = contextFor(who);
    if (ctx.snap || !(ctx.kind === 'admin' || ctx.shell)) { json(res, 403, { error: 'forbidden' }); return null; }
    return ctx;
  };
  const bodyOf = async (req, res) => { try { return JSON.parse(await readBody(req, 256 * 1024)); } catch { json(res, 400, { error: 'bad json' }); return null; } };
  // 只认这个身份自己的项目对话
  const projectSid = (ctx, res, v) => {
    const sid = String(v || '');
    if (!ID_RE.test(sid)) { json(res, 400, { error: 'bad session' }); return null; }
    if (!isProjectSession(ctx, sid)) { json(res, 404, { error: '这不是项目对话' }); return null; }
    return sid;
  };
  const changed = (ctx, sid, extra = {}) => busPublish(ctx.key, { type: 'project', sessionId: sid, at: Date.now(), ...extra });

  router.on('GET', '/api/claude/project', (req, res, url) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    const sid = projectSid(ctx, res, url.searchParams.get('session')); if (!sid) return;
    json(res, 200, viewOf(ctx, sid));
  });

  router.on('POST', '/api/claude/project', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    const b = await bodyOf(req, res); if (!b) return;
    const sid = projectSid(ctx, res, b.session); if (!sid) return;
    const before = projectState(ctx, sid);
    const patch = {};
    if (typeof b.instructions === 'string') {
      if (b.instructions.length > INSTRUCTIONS_MAX) return json(res, 400, { error: `项目说明最多 ${INSTRUCTIONS_MAX} 字` });
      patch.instructions = b.instructions;
    }
    if (typeof b.paused === 'boolean') patch.paused = b.paused;
    if (b.threadModel !== undefined) {
      const m = b.threadModel == null ? '' : String(b.threadModel);
      if (m && !(CLAUDE_MODELS.has(m) || isCustomModelId(m))) return json(res, 400, { error: '不认识这个模型' });
      patch.threadModel = m;
    }
    if (b.threadEffort !== undefined) {
      // 档位 id：官方五档或自定义模型档位表里自由起的名字；真正收不收由 /api/chat 按讨论串的模型再判
      const e = b.threadEffort == null ? '' : String(b.threadEffort);
      if (e && !/^[\w.-]{1,40}$/.test(e)) return json(res, 400, { error: '不认识这个推理强度' });
      patch.threadEffort = e;
    }
    updateProject(ctx, sid, patch);
    let stopped = 0;
    if (patch.paused === true && !before.paused) stopped = stopAll(ctx, sid);
    if (patch.paused === false && before.paused) wakeSoon(ctx, sid);
    changed(ctx, sid);
    json(res, 200, { ok: true, stopped, ...viewOf(ctx, sid) });
  });

  router.on('POST', '/api/claude/project/resolve', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    const b = await bodyOf(req, res); if (!b) return;
    const sid = projectSid(ctx, res, b.session); if (!sid) return;
    const tid = String(b.thread || '');
    if (!ID_RE.test(tid) || familyLink(ctx, tid)?.parent !== sid) return json(res, 404, { error: '这条讨论串不在这个项目里' });
    const st = updateProject(ctx, sid, { resolve: { id: tid, value: b.resolved === true } });
    changed(ctx, sid, { thread: tid });
    json(res, 200, { ok: true, resolved: st.resolved[tid] === true });
  });

  router.on('GET', '/api/claude/project/memory', (req, res, url) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    const sid = projectSid(ctx, res, url.searchParams.get('session')); if (!sid) return;
    const name = String(url.searchParams.get('name') || '');
    if (!memoryNameOk(name)) return json(res, 400, { error: 'bad name' });
    const content = memoryRead(ctx, sid, name);
    if (content === null) return json(res, 404, { error: '没有这一篇' });
    json(res, 200, { name, content });
  });

  router.on('POST', '/api/claude/project/memory', async (req, res) => {
    const ctx = projCtx(req, res); if (!ctx) return;
    const b = await bodyOf(req, res); if (!b) return;
    const sid = projectSid(ctx, res, b.session); if (!sid) return;
    const r = memoryWrite(ctx, sid, String(b.name || ''), b.content === null ? null : String(b.content ?? ''));
    if (!r.ok) return json(res, 400, { error: r.error });
    changed(ctx, sid, { memory: true });
    json(res, 200, { ok: true, memory: memoryList(ctx, sid) });
  });
}
