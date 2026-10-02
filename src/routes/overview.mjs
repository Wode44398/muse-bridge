// Lightweight ambient endpoints, per-caller: which of THIS caller's conversations
// are generating, /api/attach (buffered-reattach SSE for one in-flight turn) and
// /api/stop (abort a turn). /api/status returns the cached rate-limit + context
// snapshot (rate limits are account-wide; context is best-effort last-turn).
//
// 多对话并发：一个 caller 可以同时有多个 gen。/api/active 的顶层旧字段（active/
// sessionId/userText/…）保持=最新一轮——旧 apk 的原生 AgentService、胶囊都在吃这个
// 结构，不能破坏；新增 runs[] 给多轮感知的前端。attach/stop 用 ?session= / body
// sessionId 定位具体某轮，不带则回落最新一轮（旧客户端行为）。

import { writeSseHeaders } from '../runtime/sse.mjs';
import { getCurrentGen, getLiveGens, findGenBySession, genWrite, genSubscribe } from '../runtime/gen.mjs';
import { interruptedRun, clearInterrupted, INTERRUPT_NOTE } from '../runtime/inflight.mjs';
import { busAttach } from '../runtime/bus.mjs';
import { watchSessions } from '../runtime/session-watch.mjs';
import { sessionQuestions } from '../runtime/questions.mjs';
import { statusState, getContext, pruneStaleLimits } from '../runtime/status.mjs';
import { getContextUsage, getEffort, getCommands } from '../runtime/ctx-usage.mjs';
import { listSuggestions } from '../runtime/suggestions.mjs';
import { maybeRefreshLimits } from '../runtime/usage-probe.mjs';
import { outboundProxyStatus, recheckOutboundProxy } from '../runtime/net-proxy.mjs';
import { requireCtx } from '../runtime/identity.mjs';
import { readBody } from '../runtime/body.mjs';

export function registerOverviewRoutes(router, { authOk, identify }) {
  // Auth + per-identity context resolution is shared in requireCtx (runtime/identity.mjs).

  const runSnapshot = (g) => ({
    sessionId: g.sessionId || null,
    userText: g.userText || '',
    startedAt: g.startedAt || 0,
    source: g.source || null,   // 'capsule' = 悬浮胶囊轮：网页端不镜像挂载
  });

  router.on('GET', '/api/overview', (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    const live = getLiveGens(ctx.key);
    const newest = live[live.length - 1] || null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      active: newest ? (newest.sessionId || null) : null,
      actives: live.map((g) => g.sessionId).filter(Boolean),
      pending: [...sessionQuestions.keys()],
      // pendingDetail：问题原文，给桌面壳的系统通知用（「Claude 在等你回答：要覆盖旧文件吗？」
      // 比一句干巴巴的"有提问"有用得多）。qid 不外泄——那是作答凭据，只走该 caller 自己的 SSE。
      // 老客户端只读 pending，多这个字段无害。
      pendingDetail: [...sessionQuestions.entries()].map(([sessionId, entry]) => ({
        sessionId,
        ts: entry?.ts || 0,
        header: String(entry?.questions?.[0]?.header || '').slice(0, 40),
        question: String(entry?.questions?.[0]?.question || '').slice(0, 200),
      })),
    }));
  });

  // Cheap probe: which of THIS caller's Claude turns are in flight? Lets their phone
  // decide whether to reattach after a refresh without consuming the SSE stream.
  router.on('GET', '/api/active', (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    const live = getLiveGens(ctx.key);
    const newest = live[live.length - 1] || null;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      // 旧字段=最新一轮（旧 apk AgentService/胶囊兼容）；runs=全部在跑的轮。
      active: !!newest,
      ...(newest ? runSnapshot(newest) : { sessionId: null, userText: '', startedAt: 0, source: null }),
      runs: live.map(runSnapshot),
    }));
  });

  // POST only（S8）：POST 本就是真身路径（Cloudflare 会缓冲 GET SSE），而 GET 版能被
  // 跨站顶级导航带着 SameSite=Lax cookie 触发建订阅——带副作用的 GET 不留。诊断用
  // curl -X POST 同样方便。?session=<id> reattaches to that conversation's gen
  //（多对话并发下必须点名）；不带则回落最新一轮。
  router.on('POST', '/api/attach', (req, res, url) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    const want = url && url.searchParams ? (url.searchParams.get('session') || '') : '';
    const gen = want ? findGenBySession(ctx.key, want) : getCurrentGen(ctx.key);
    // 没有 gen 可挂，但这个会话上一轮是被【进程中途退出】掐掉的：直接回一个完整的
    // 终止序列，让前端当场落定。以前这里只有 204，前端要连着试 4 次「落盘慢半拍」的
    // reconcile 才肯自行收敛——而那一轮的 assistant 记录永远不会出现，等的就是个空。
    if (!gen) {
      const it = want ? interruptedRun(ctx.key, want) : null;
      if (it) {
        writeSseHeaders(res);
        // 只发 error：它本身就是终止事件（前端 isTerminal 认 done/error/interrupted），
        // 会落在客户端【已经流到的那条气泡】上——既收敛了转圈，又不动它已经看到的内容。
        // 刻意不发 attach（那会清空气泡等整轮重放，而这一轮的缓冲已随进程一起没了），
        // 也刻意不补 done（done 会把 status 从 error 翻回 done，红旗就没了）。
        genWrite(res, { type: 'error', kind: 'interrupted', title: '这一轮被中断', hint: '服务进程在执行中途退出了', message: INTERRUPT_NOTE });
        res.end();
        clearInterrupted(ctx.key, want);   // 已经交代过了：持久那份在 transcript 里，不必每次重连都再播
        return;
      }
      res.writeHead(204); res.end(); return;
    }
    writeSseHeaders(res);
    // elapsedMs lets the phone re-anchor its "思考 Ns" timer to when the turn really
    // started server-side, so leaving + reopening the chat doesn't reset it to 0.
    // Sent as a duration (not an absolute ts) so phone/PC clock skew can't distort it.
    genWrite(res, { type: 'attach', userText: gen.userText, sessionId: gen.sessionId, done: gen.done, elapsedMs: Math.max(0, Date.now() - (gen.startedAt || Date.now())) });
    for (const ev of gen.events) genWrite(res, ev);
    if (gen.done) { res.end(); return; }
    genSubscribe(gen, res); // live updates from here on (chat's heartbeat covers it)
  });

  // 账号级事件总线：一条常驻 SSE 告诉这个 caller 的【所有设备】"刚发生了什么"——
  // 谁开跑了、谁结束了、哪个 transcript 又长了、哪个会话在等人回答。
  // /api/attach 管的是一轮之内的字节流；这条管的是轮与轮、会话与会话之间的变化，
  // 前端据此把「进页面刷一次列表 + 4s 轮询 active」换成推送驱动（见 web/src/lib/bus.js）。
  // POST 而非 GET，同 /api/attach：Cloudflare 会缓冲 GET SSE，且带副作用的 GET 有 CSRF 面。
  router.on('POST', '/api/stream', (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    // 快照桶（/c/ 分享出去的阉割版分页）不参与多端同步：它本就是一次性隔离视图，
    // 给它挂 watcher 只是白占句柄。204 = 前端安静回落轮询。
    if (ctx.snap) { res.writeHead(204); res.end(); return; }
    writeSseHeaders(res);
    // 先出一个字节：前端的半开连接看门狗按「多久没收到任何数据」判死，需要个起点。
    // 顺带把当前在跑的轮一并交底，省掉客户端连上后还要再探一次 /api/active。
    const live = getLiveGens(ctx.key);
    genWrite(res, {
      type: 'hello',
      runs: live.map(runSnapshot),
      pending: [...sessionQuestions.keys()],
      // 各会话眼下的输入建议（{sid:{text,at}}）：刷新页面 / 换设备 / 断线重连后输入框照样有。
      suggestions: listSuggestions(ctx.key),
    });
    const offBus = busAttach(ctx.key, res);
    const offWatch = watchSessions(ctx.key, ctx);
    let closed = false;
    const cleanup = () => { if (closed) return; closed = true; offBus(); offWatch(); };
    res.on('close', cleanup);
    res.on('error', cleanup);
  });

  router.on('POST', '/api/stop', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    // body {sessionId} 停指定那轮；空 body/旧客户端 → 停最新一轮（旧行为）。
    // body {release:true} =「结束等待」：这一轮只是在等后台任务（bg_hold），模型早说完了——
    // 按【正常定局】收尾（发 done、留下已有回答），而不是像硬停那样留一条「已中断」。
    // 后台任务本身随 CLI 收尾一起结束，这是用户明确要求的语义。
    let want = '', release = false;
    try { const b = JSON.parse(await readBody(req)); want = String(b.sessionId || ''); release = b.release === true; } catch {}
    // 不带 release 的停止：后台任务还活着就只打断当前这一轮作答（官方 Esc 同款），后台任务照跑、
    // 这一轮转入挂起——回 held:true，前端据此重新挂上直播看挂起态；否则照旧整个停掉。
    const g = want ? findGenBySession(ctx.key, want) : getCurrentGen(ctx.key);
    let released = false, held = false;
    if (g && !g.done) {
      if (release && typeof g.releaseHold === 'function') { try { released = g.releaseHold() === true; } catch {} }
      else if (!release && typeof g.interruptTurn === 'function') { try { held = g.interruptTurn() === true; } catch {} }
      // 硬停：这一轮当场收尾（interrupted），CLI 在后台退；控制口还没挂上（query 尚未建起）才直接 abort。
      if (!released && !held) {
        try { if (typeof g.hardStop === 'function') g.hardStop(); else g.abort.abort(); } catch {}
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, released, held }));
  });

  router.on('GET', '/api/status', async (req, res, url) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    // 刷新真实双桶用量（usage-probe 内部 5min TTL + 去重；这里最多等 4s——超时先回
    // 缓存，探针结果落地后下一次 30s 轮询自然带上）。化石条目顺手清掉。
    try { await Promise.race([maybeRefreshLimits(), new Promise((r) => setTimeout(r, 4000))]); } catch {}
    pruneStaleLimits();
    // ?session= → 回「这个会话自己」的 context 填充（多对话并发下 per-key 是最后收尾的那轮）。
    const sid = url && url.searchParams ? (url.searchParams.get('session') || '') : '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    // contextUsage / effort：这个会话最近一轮的上下文分布（getContextUsage 精确档）与实际生效
    // 档位（Stop hook）——刷新页面 / 换设备打开旧会话时环形面板与 effort 芯片据此恢复。
    res.end(JSON.stringify({
      limits: statusState.limits || {}, context: getContext(ctx.key, sid), updatedAt: statusState.updatedAt || 0, net: outboundProxyStatus(),
      contextUsage: getContextUsage(ctx.key, sid), effort: getEffort(ctx.key, sid),
      plan: statusState.plan || null,   // 套餐名（SDK usage 的 subscription_type，OAuth token 路径下常为空）
    }));
  });

  // 斜杠命令表（输入栏「/」菜单）：本账号最近一轮 init 时经 supportedCommands() 拿到的全表 +
  // terminal 段（手机/远程 UI 该藏的本地终端命令）。还没跑过任何一轮时是空表，前端提示先发一条消息。
  router.on('GET', '/api/commands', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getCommands(ctx.key)));
  });

  // 出站链路自检（只读）：现在走代理还是直连、上次探测于何时。出海失败时第一站看这里——
  // 403 Request not allowed 的锅几乎总在这条链路上，不在 token。
  // S8：GET 必须无副作用（恶意页开个链接就能带 Lax cookie 触发顶级导航 GET），
  // 立刻重探挪到下面的 POST /api/net/recheck，由 server.mjs 的 Origin 闸罩住。
  router.on('GET', '/api/net', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(outboundProxyStatus()));
  });

  // 立刻重探出站代理（刚改了代理想马上生效，不必等 60s 的自愈轮）。
  router.on('POST', '/api/net/recheck', async (req, res) => {
    const ctx = requireCtx(identify, req, res); if (!ctx) return;
    try { await recheckOutboundProxy(); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(outboundProxyStatus()));
  });
}
