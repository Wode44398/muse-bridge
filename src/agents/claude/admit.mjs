import { writeSseHeaders } from '../../runtime/sse.mjs';
import { genWrite, findGenBySession } from '../../runtime/gen.mjs';
import { clearSuggestion } from '../../runtime/suggestions.mjs';
import { sessionPaths } from '../../runtime/paths.mjs';
import { quotaBlock } from '../../runtime/quota.mjs';
import { pendingRewindAnchor } from '../claude-rewind.mjs';
import { handedTurn, markTurn } from '../../runtime/turn-timing.mjs';
import { spareRuns, sleep, warmRuns, warmStat, closeWarm } from './warm.mjs';

// 准入：这条消息要不要另起一个 CLI。预热只续期、额度超了、被预热 / 停放 / 挂起中的进程接走、
// 同会话上一轮让不出来——这些都在这里收场，返回 true；返回 false = 照常冷起。
export async function admitTurn(plan, req, res) {
  const {
    message, sessionId, model, attachments, source, origin, limitResume, restartResume, ctx, family, snap, isSpare, ownKey, permPolicy, turnPerm, billTo,
    pIn, warmSig, sigDiff, chatPrefs, limitReplay,
  } = plan;
  if (isSpare) {
    // 已有同参数的预热进程：续期即可；参数变了（换模型/项目/开关）就换掉旧的。
    const cur = spareRuns.get(ctx.key);
    if (cur && cur.sig === warmSig) { cur.touch(); return true; }
    if (cur) cur.close();
  } else {
    writeSseHeaders(res);
  }

  // 额度（三端拆分 P4）：注册用户超了每天 / 最近 7 天的上限就不开跑——放在「顶掉同会话上一轮」
  // 之前，被拒的重发不该把还在跑的那一轮停掉。管理员不走这里；快照访客的轮查铸造者的额度（billTo）。
  // 自定义 API 的轮花的是这个人自己的 Key，不占也不受主机额度管（同下面记账处）；管理员共享的服务照常受管。
  if (billTo && !ownKey) {
    const block = quotaBlock(billTo);
    if (block) {
      genWrite(res, { type: 'error', kind: 'quota', title: block.title, message: block.message });
      res.end();
      return true;
    }
  }

  // 新会话：有预热好的 CLI 且启动参数一致 → 接管它（与续聊的 warmTake 同一条路，首字不再等 spawn）；
  // 参数不一致就关掉它（它还没有 transcript，不必等它退干净），照常冷起。
  // 派生的子会话不碰预热进程：它的提示词带子会话身份，签名必然对不上，碰了只会白白关掉用户刚预热好的那个。
  if (!sessionId && !isSpare && !snap && !family) {
    const sp = spareRuns.get(ctx.key);
    if (sp) {
      if (sp.sig === warmSig && await sp.take({ res, message, attachments, pin: pIn, source, chatPrefs, origin, permMode: turnPerm.mode, limitReplay })) { handedTurn(req, sessionId, 'spare'); return true; }
      console.log(`[claude] spare CLI not used (${sp.sig !== warmSig ? 'options changed: ' + sigDiff(sp.digest) : 'gone'}) — cold start`);
      sp.close();
    }
  }
  // 上一轮定局后停放着的 CLI（见 WARM_IDLE_MS）：参数一致就直接接着用；否则关掉它再冷起
  //（一份 transcript 不许两个 CLI）。新一轮开跑，上一条输入建议也就过时了。
  if (sessionId) {
    clearSuggestion(ctx.key, sessionId);
    // 上一轮已经回了 done、正在做定局后的收尾（见 emitDone 里的 finalizing）：等它收完停放好，最多 10s。
    const fin = findGenBySession(ctx.key, sessionId);
    if (fin && !fin.done && fin.finalizing) { markTurn(req, 'prep'); if (fin.hurry) fin.hurry(); await Promise.race([fin.settled, sleep(10_000)]); markTurn(req, 'fin-wait'); }
    const w = warmRuns.get(ctx.key + '|' + sessionId);
    if (w) {
      const sp = sessionPaths(sessionId, ctx.cwd, ctx.configDir);
      const why = w.sig !== warmSig ? 'options changed: ' + sigDiff(w.digest)
        : pendingRewindAnchor(sessionId) ? 'rewind pending'
          : (sp && warmStat(sp.file) !== w.stat()) ? 'transcript changed by someone else' : '';
      if (!why && await w.take({ res, message, attachments, pin: pIn, source, chatPrefs, origin, family, permMode: turnPerm.mode, limitReplay, auto: !!limitResume })) { handedTurn(req, sessionId, 'warm'); return true; }
      console.log(`[claude] warm CLI ${sessionId.slice(0, 8)} not reused (${why || 'gone'}) — cold start`);
      await closeWarm(w);
    }
  }
  // Supersede ONLY this conversation's own in-flight turn — an explicit resend of
  // the SAME session（一份 transcript 不能有两个写入者）。别的会话的轮不再被顶掉，
  // 各自并行（多对话并发）。
  const prev = sessionId ? findGenBySession(ctx.key, sessionId) : null;
  // 挂起接力（09-28）：上一轮只是在等后台任务（模型早已停笔）——这条消息直接送进【同一个】
  // 活着的 CLI 开新一轮，后台任务照跑、完成时照常续轮汇报。以前这里一律顶掉上一轮，
  // 顶掉 = abort = CLI 连同后台任务一起被杀（维护者报：想接着聊只能先点停止，一停任务就没了）。
  if (prev && !prev.done && typeof prev.handoff === 'function') {
    const took = await prev.handoff({ res, message, attachments, pin: pIn, source, model, chatPrefs, origin, family, permMode: turnPerm.mode, permPolicy, limitReplay, auto: !!limitResume });
    if (took === 'policy' || took === 'mode' || took === 'model' || took === 'busy') {
      genWrite(res, { type: 'error', kind: 'busy', title: '会话正在后台工作', message: took === 'policy'
        ? '这个会话在等后台任务做完。这条消息和它不是同一种发起方式（管理台代聊 / 本人发话），没有插进去，也没有打断它。等它做完再发，或先到该会话点「停止」。'
        : took === 'model' ? '这个会话在等后台任务做完。切换到 / 切换出自定义 API 的模型要重开会话进程，所以这条消息没有插进去，也没有打断它。等它做完再发，或先到该会话点「停止」。'
        : took === 'mode' ? '这个会话在等后台任务做完，没能切到你选的更严格的权限模式，所以这条消息没有插进去，也没有打断它。等它做完再发，或先到该会话点「停止」。'
          : '这个会话正在接收另一条消息，这条没有插进去。稍后再发。' });
      res.end();
      return true;
    }
    if (took) { handedTurn(req, sessionId, 'handoff'); return true; }
  }
  // 服务端自动发起的轮（Auto-fix 唤醒，pr-monitor.mjs 的 family.noPreempt；重启后自动继续，restart-resume.mjs）
  // 绝不顶掉同会话正在跑的轮：回 busy，发起方下次再来。
  if (prev && !prev.done && ((family && family.noPreempt) || restartResume > 0)) {
    genWrite(res, { type: 'error', kind: 'busy', title: '会话正在工作', message: '这个会话有一轮正在跑，自动发起的消息没有插进去。' });
    res.end();
    return true;
  }
  // prev.stopping：用户按了停止，那一轮对界面已收尾（done），但 CLI 还在退出中——同样要等它退干净，
  // 否则新旧两个进程同写一份 transcript。
  if (prev && (!prev.done || prev.stopping)) {
    if (!prev.done) { try { prev.abort.abort(); } catch {} }
    markTurn(req, 'prep');
    const stopped = await Promise.race([
      (prev.done ? prev.stopping : prev.settled).then(() => true, () => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
    ]);
    markTurn(req, 'prev-stop');
    if (!stopped) {
      // Never start a second SDK writer for the same transcript. A wedged old
      // turn is inconvenient; overlapping JSONL writers permanently corrupt it.
      genWrite(res, { type: 'error', kind: 'busy', title: '上一轮仍在停止', message: '上一轮尚未安全退出，没有启动新的同会话请求。稍等片刻再重试，或先到该会话点「停止」。' });
      res.end();
      return true;
    }
  }
  return false;
}
