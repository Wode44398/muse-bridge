// 额度（三端拆分 P4；开源路线 S2-6「号池不被一个人吃光」）：注册用户受「每天 / 最近 7 天」的轮数与花费上限约束，
// 另有每天的媒体 / 视频次数；全服注册用户合计、每个成员各自同时在跑的轮数也可以设上限。
// 默认额度在策略（runtime/policy.mjs，控制台「额度与注册」），个人覆盖在账号上（users.setQuota）。
//
// 算谁的账（billingUser；不等于 ctx.scope——scope 是数据和池归谁，快照轮的 scope 是 'c:<令牌>'，见 principal.mjs）：
//   · 注册用户的轮 → 他本人（管理员代他发的也算他的：数据落他的目录、记他的账，「是谁发的」在 ctx.actor）；
//   · 聊天快照（/c/ 链接）访客的轮 → 铸这个快照的账号（以前谁都不记）；
//   · 管理员自己 → 不记、不限。
// 服务账号（QQ 机器人这类管理员自己的程序）不吃默认额度，只有单独给它设的才算；成员的高消耗功能开关也不管它。
// 统一闸门：Claude 对话（agents/claude.mjs）、定时任务与「立即运行」（runtime/routines-runner.mjs）、Gemini 对话
//（routes/chat.mjs 扩展 agent 分支）、媒体生成（vertex 扩展的生成端点与 Claude 的媒体工具）。
// 管理员代聊（routes/admin.mjs /api/admin/user/chat）的轮同样查被代的人的额度、记他的账，Claude 与 Gemini 一个口径；
// 只是那一轮不按成员的高消耗功能开关管（memberRules），媒体的按次计数也不记（admitUsage）。
import { getPolicy, LIMIT_KEYS } from './policy.mjs';
import { getUser, getUserById, accountId, usageWindow, noteUsageEvent } from '../users.mjs';
import { parseOwnerKey } from './principal.mjs';

// 这个人实际生效的额度：默认打底（服务账号没有默认），个人覆盖里写了的键覆盖（0 = 这一项对他不限）。
export function limitsFor(name) {
  const rec = getUser(name);
  const out = rec && rec.service === true ? {} : { ...getPolicy().quota };
  const own = rec?.quota;
  if (own && typeof own === 'object') {
    for (const k of LIMIT_KEYS) {
      if (!(k in own)) continue;
      const v = Number(own[k]);
      if (v > 0) out[k] = v; else delete out[k];
    }
  }
  return out;
}

export function quotaState(name) {
  const { today, week } = usageWindow(name);
  return { limits: limitsFor(name), today, week, timezone: getPolicy().timezone, features: memberFeaturesFor(name) };
}

const money = (v) => '$' + (Math.round(v * 100) / 100).toFixed(2);
const TAIL = '需要更多额度请联系管理员。';

// 开跑前查一次：超了返回 { title, message }（直接给人看），没超返回 null。
export function quotaBlock(name) {
  const { limits: l, today, week } = quotaState(name);
  if (l.dayTurns && today.turns >= l.dayTurns) {
    return { title: '今天的额度用完了', message: `今天已经跑了 ${today.turns} 轮，每天上限 ${l.dayTurns} 轮，明天 0 点恢复。${TAIL}` };
  }
  if (l.dayCostUsd && today.costUsd >= l.dayCostUsd) {
    return { title: '今天的额度用完了', message: `今天已用 ${money(today.costUsd)}，每天上限 ${money(l.dayCostUsd)}，明天 0 点恢复。${TAIL}` };
  }
  if (l.weekTurns && week.turns >= l.weekTurns) {
    return { title: '这 7 天的额度用完了', message: `最近 7 天已经跑了 ${week.turns} 轮，上限 ${l.weekTurns} 轮；最早那天的用量滑出 7 天窗口后逐步恢复。${TAIL}` };
  }
  if (l.weekCostUsd && week.costUsd >= l.weekCostUsd) {
    return { title: '这 7 天的额度用完了', message: `最近 7 天已用 ${money(week.costUsd)}，上限 ${money(l.weekCostUsd)}；最早那天的用量滑出 7 天窗口后逐步恢复。${TAIL}` };
  }
  return null;
}

// ---- 成员的高消耗功能 ----
const ALL_ON = Object.freeze({ fast: true, ultracode: true, ctx1m: true, media: true, video: true });
// 某个账号名能用哪些（服务账号 / 不存在的名字按全开算——后者只会出现在管理员视角）
export function memberFeaturesFor(name) {
  const rec = name ? getUser(name) : null;
  if (!rec || rec.service === true) return { ...ALL_ON };
  return { ...getPolicy().member };
}

// 这一轮按成员规则管不管：注册用户自己发起的（不是服务账号、不是管理员代发）。
const isMemberTurn = (ctx) => !!ctx && ctx.kind === 'user' && !!ctx.user && ctx.service !== true && ctx.actor !== 'admin';

/** 这一轮的成员限制：{ fast, ultracode, ctx1m, media, video, maxParallel }（maxParallel = Infinity 表示不限）。 */
export function memberRules(ctx) {
  if (isMemberTurn(ctx)) {
    const p = getPolicy();
    return { ...p.member, maxParallel: p.maxParallelPerUser > 0 ? p.maxParallelPerUser : Infinity };
  }
  // 聊天快照访客的轮：记的是铸造者的账，高消耗功能也跟他走——成员铸的快照不能用来绕开成员开关（服务账号、管理员铸的照旧全开）。
  // 并发另有快照通道的全服上限（chat-snapshot SNAP_MAX_TURNS），不按人。
  if (ctx && ctx.kind === 'snap') {
    const owner = billingUser(ctx);
    if (owner) return { ...memberFeaturesFor(owner), maxParallel: Infinity };
  }
  return { ...ALL_ON, maxParallel: Infinity };
}

// 每个成员最多几条启用中的定时任务（开源路线 S2-6：定时任务无人值守，开多了等于给号池挂了一串自动烧钱的轮）。
// 策略 maxRoutinesPerUser（新部署推荐 10；老部署 0 = 不限）。
export function routineCapFor(ctx) {
  if (!isMemberTurn(ctx)) return Infinity;
  const n = getPolicy().maxRoutinesPerUser;
  return n > 0 ? n : Infinity;
}

// ---- 算谁的账 ----
let snapOwnerOf = null;   // (token) => 'admin' | 'u:<名>' | ''（routes/chat-snapshot.mjs 启动时登记，免得这里反向 import 路由层）
let snapOwnersAll = null; // () => 全部快照的属主键（同上登记；控制台提醒「铸快照的号还不是服务账号」用）
export function setSnapOwnerResolver(fn, listOwners) {
  snapOwnerOf = typeof fn === 'function' ? fn : null;
  snapOwnersAll = typeof listOwners === 'function' ? listOwners : null;
}
/** 铸过（还留着记录的）聊天快照的账号 id。 */
export function snapMinterIds() {
  const out = new Set();
  try { for (const k of (snapOwnersAll ? snapOwnersAll() : []) || []) { const id = userFromOwnerKey(k); if (id) out.add(id); } } catch {}
  return out;
}

// owner 键 → 账号 id（只认 'u:<id>' 且账号还在的；管理员 / 认不出的返回 null）
export function userFromOwnerKey(key) {
  const p = parseOwnerKey(key);
  if (!p || p.kind !== 'user' || !p.id) return null;
  const rec = getUserById(p.id) || getUser(p.id);
  return rec ? accountId(rec) : null;
}

/** 这一轮记到谁头上（账号 id，老账号 = 用户名），不记返回 null。 */
export function billingUser(ctx) {
  if (!ctx) return null;
  if (ctx.kind === 'user') return ctx.user || null;
  if (ctx.kind === 'snap' && ctx.snap && snapOwnerOf) {
    try { return userFromOwnerKey(snapOwnerOf(ctx.snap.token)); } catch { return null; }
  }
  return null;
}

// ---- 对话轮以外的计数：媒体 / 视频 ----
const KIND = {
  media: { key: 'dayMedia', feature: 'media', label: '图片、语音和音乐', unit: '次' },
  video: { key: 'dayVideo', feature: 'video', label: '视频', unit: '条' },
};

/**
 * 某个账号现在能不能再用一次（kind：'media' | 'video'）。不能 → { title, message }；能 → null。
 * 成员功能开关关着（媒体 / 视频）也在这里拦。
 */
export function usageBlock(name, kind) {
  const def = KIND[kind];
  if (!def || !name) return null;
  if (def.feature && !memberFeaturesFor(name)[def.feature]) {
    return { title: `没有开放${def.label}生成`, message: `这台服务器没有给成员开放${def.label}生成。${TAIL}` };
  }
  const { limits: l, today } = quotaState(name);
  const cap = l[def.key];
  const used = today[kind] || 0;
  if (cap && used >= cap) {
    return { title: '今天的额度用完了', message: `今天已经用了 ${used} ${def.unit}${def.label}，每天上限 ${cap} ${def.unit}，明天 0 点恢复。${TAIL}` };
  }
  return null;
}

/** 开始用就记一次（同轮数「开跑即记」：并行发几次也绕不过去）。 */
export function noteUsage(name, kind) {
  if (!name || !KIND[kind]) return;
  try { noteUsageEvent(name, kind); } catch {}
}

/**
 * 一步到位：按身份查额度并记一次。返回 null = 放行（已记账）；{ title, message } = 拦下。
 * 管理员、快照（媒体对快照本来就不开放）、管理员代操作一律放行不记。
 */
export function admitUsage(ctx, kind) {
  if (!ctx || ctx.kind !== 'user' || !ctx.user || ctx.actor === 'admin') return null;
  const b = usageBlock(ctx.user, kind);
  if (b) return b;
  noteUsage(ctx.user, kind);
  return null;
}
