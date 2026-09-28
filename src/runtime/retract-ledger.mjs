// 安全栅门撤回记账（agents/claude.mjs 主线程专用，抽出来是为了能单测——记账错一格就是「回退模型的开头
// 永久丢失」或「被拒半截和回退正文粘成一段」，这两种坏法在直播里都很难肉眼定位）。
//
// 背景：client lane 下被拒那截半成品已经流给了前端（先 stream_event 增量，再来 model_refusal_fallback 通知，
// 再由回退模型重试）。通知只给被撤回帧的 uuid，前端的 text 段对不上 uuid；所以服务端按 uuid 记「每个主线程
// assistant 帧覆盖了正文 / 思考 / 工具行的哪一段」，收到撤回名单就算出该删的【区间】，发 retract。
//
// 为什么是「区间删除」而不是「保留长度尾截」：CLI 2.1.25x 的通知 / 首帧 supersedes 常在回退模型的增量
// 【之后】才到——首帧本身就是在它自己的增量流完才 yield 的，通知更可能被 pendingNotice 延后到回退模型好几个
// 帧之后（真实 jsonl：通知记录的 parentUuid 是回退模型的 tool_use 帧）。此时尾截会把回退模型已流出的开头
// 一并砍掉（首块是 tool_use 时那一行整个消失，随后的 tool_done 找不到条目）。区间删除只删被拒那截，之后的
// 内容原样保留并前移；记账里的计数、帧区间、消息区间同步前移。
//
// 区间怎么定：
//   · 名单命中已知帧 → 命中帧区间的并集，再扩到该帧所属 API 消息的收尾——被拒在半途的最后一个 block 没凑成
//     帧（没有 uuid 可对），但它的增量已经发出去了；消息还开着就扩到当前计数。
//   · 名单里一个已知帧都没有 → 被拒那截连一个 block 都没凑成（uuid 是 CLI 给半截消息派的）：只认「最近一条
//     已收尾、零帧、有内容的消息」，其次「当前开着、零帧、有内容的消息」（通知先于回退流到、message_stop
//     还没来）。都不是 → 不撤：那是 server lane 缝合（uuid 是墓碑，正文该保留）或子 agent 的帧。
//   · 幂等：处理过的 uuid 不再算（通知的 retracted_message_uuids 与重试首帧的 supersedes 是同一份）。
const DIMS = ['text', 'think', 'tools'];

export function makeRetractLedger() {
  const sent = { text: 0, think: 0, tools: 0 };   // 已发给前端的正文字符数 / 思考字符数 / tool 事件条数
  let frames = [];                                 // { uuid, text0,text1, think0,think1, tools0,tools1, msg }
  let cur = null;                                  // 当前 API 消息 { open, frames, retracted, k0, k1 }
  let closed = [];                                 // 已收尾的消息（空且零帧的不入表：无物可撤）
  const end = { text: 0, think: 0, tools: 0 };     // 上一帧结束时的计数（下一帧的区间起点）
  const seen = new Set();

  const hasContent = (o) => DIMS.some((k) => (o.open ? sent[k] : o[k + '1']) > o[k + '0']);
  const messageStop = () => {
    if (!cur || !cur.open) return;
    cur.open = false;
    for (const k of DIMS) cur[k + '1'] = sent[k];
    if (cur.frames || hasContent(cur)) closed.push(cur);
  };
  const openMsg = () => {
    cur = { open: true, frames: 0, retracted: false };
    for (const k of DIMS) { cur[k + '0'] = sent[k]; cur[k + '1'] = -1; }
  };
  const messageStart = () => { messageStop(); openMsg(); };   // 上一条没等到 message_stop 就来了新的 → 视为已收尾
  const frame = (uuid) => {
    const f = { uuid: typeof uuid === 'string' ? uuid : '', msg: cur };
    for (const k of DIMS) { f[k + '0'] = end[k]; f[k + '1'] = sent[k]; end[k] = sent[k]; }
    if (cur) cur.frames++;
    if (f.uuid) frames.push(f);
  };

  const retract = (list) => {
    const uuids = (Array.isArray(list) ? list : []).filter((u) => typeof u === 'string' && u && !seen.has(u));
    if (!uuids.length) return null;
    for (const u of uuids) seen.add(u);
    const hitSet = new Set(uuids);
    const hits = frames.filter((f) => hitSet.has(f.uuid));
    const lo = { text: Infinity, think: Infinity, tools: Infinity }, hi = { text: -1, think: -1, tools: -1 };
    const take = (o) => {
      for (const k of DIMS) {
        const a = o[k + '0'], b = o.open ? sent[k] : o[k + '1'];
        if (a < lo[k]) lo[k] = a;
        if (b > hi[k]) hi[k] = b;
      }
    };
    const takeMsg = (mg) => { if (!mg || mg.retracted) return; mg.retracted = true; take(mg); };
    if (hits.length) {
      for (const f of hits) { take(f); takeMsg(f.msg); }
    } else {
      const last = closed.length ? closed[closed.length - 1] : null;
      if (last && !last.frames && !last.retracted) takeMsg(last);
      else if (cur && cur.open && !cur.frames && !cur.retracted && hasContent(cur)) takeMsg(cur);
      else return null;
    }
    const cut = {};
    let any = false;
    for (const k of DIMS) {
      if (!isFinite(lo[k])) lo[k] = 0;
      cut[k] = Math.max(0, hi[k] - lo[k]);
      if (cut[k] > 0) any = true;
      if (hi[k] < lo[k]) hi[k] = lo[k];
    }
    if (!any) return null;
    const ev = { type: 'retract', textFrom: lo.text, textTo: hi.text, thinkFrom: lo.think, thinkTo: hi.think, toolsFrom: lo.tools, toolsTo: hi.tools };
    // 记账前移：区间内（被撤消息的）帧作废，区间之后的计数减去删掉的长度；区间之前的不动
    const shift = (v, k) => (v >= hi[k] ? v - cut[k] : (v > lo[k] ? lo[k] : v));
    for (const k of DIMS) { sent[k] = shift(sent[k], k); end[k] = shift(end[k], k); }
    frames = frames.filter((f) => !hitSet.has(f.uuid) && !(f.msg && f.msg.retracted));
    const shiftObj = (o) => { for (const k of DIMS) { o[k + '0'] = shift(o[k + '0'], k); if (o[k + '1'] >= 0) o[k + '1'] = shift(o[k + '1'], k); } };
    for (const f of frames) shiftObj(f);
    closed = closed.filter((m) => !m.retracted);
    for (const m of closed) shiftObj(m);
    if (cur && cur.retracted) {
      // 被撤的就是当前开着的消息（通知先到 / server lane 首帧 supersedes）：此后到的增量属于接续的内容，
      // 另起一条消息记账，别再算进已撤的那条
      if (cur.open) openMsg(); else cur = null;
    } else if (cur) shiftObj(cur);
    return ev;
  };

  return {
    sent,
    messageStart, messageStop,
    addText: (n) => { sent.text += n; },
    addThink: (n) => { sent.think += n; },
    addTool: () => { sent.tools += 1; },
    frame,
    retract,
    // 调试 / 单测用的只读快照
    _debug: () => ({ sent: { ...sent }, end: { ...end }, frames: frames.map((f) => ({ ...f, msg: undefined })), cur: cur ? { ...cur } : null, closed: closed.map((m) => ({ ...m })) }),
  };
}
