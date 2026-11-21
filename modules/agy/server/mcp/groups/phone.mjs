// 工具中枢 · 手机操控：把 Claude 的 25 个 mcp__phoneControl__* 合成一个 phone_control（action 选动作），省 agy 的工具清单预算。
//
// 动作本身全用核心 mcp/phone-control-tools.mjs 的实现（buildPhoneControlTools），这里只管三件 agy 特有的事：
//   · 锁定的设备要跨调用留着：中枢每次调用都现建工具，所以按「身份 + agy 会话」缓存那一份工具（闭包里记着本会话选定的手机）；
//   · 确认：发短信 / 打电话先认 agy 审批卡上的手动允许（用户在卡上看得到号码和内容），没有就同时在手机悬浮窗和 agy 对话里
//     弹「允许 / 不允许」，120 秒没人答按没确认；phone_confirm 本身就是问用户，永远弹；
//   · 截图照常返回给模型，不往对话里发 gen_media 帧（agy 前端不认）。
// 单次调用整体夹在 150 秒内（hub 的 budgetMs）。

import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { pluginOr, pluginConfig } from '@bridge/core/plugins/state.mjs';
import { PHONE_CONTROL } from '@bridge/core/config/index.mjs';
import { buildPhoneControlTools } from '@bridge/core/mcp/phone-control-tools.mjs';
import { requestPhoneControl } from '@bridge/core/runtime/phone-control.mjs';
import { askAgyUser, takeManualApproval, ASK_MAX_MS } from '../ask.mjs';

export const PHONE_TOOL = 'phone_control';
// 只看 / 只问 / 只记经验的动作：审批免卡（approval.mjs 按它判）
export const PHONE_READ_ACTIONS = Object.freeze(['devices', 'screen', 'clipboard_get', 'recall', 'learn', 'wait', 'confirm']);
const ACTIONS = Object.freeze([
  'devices', 'screen', 'tap', 'long_press', 'swipe', 'scroll', 'input', 'key', 'wait',
  'open_app', 'open_url', 'open_settings', 'share', 'clipboard_set', 'clipboard_get', 'notify',
  'compose_sms', 'send_sms', 'dial', 'call', 'vibrate', 'speak', 'confirm', 'recall', 'learn',
]);

// 原说明里的 phone_xxx 指的都是同组别的动作：改成 agy 这边的写法
const toAction = (s) => String(s || '').replace(/\bphone_(devices|open_app|open_url|open_settings|share|clipboard_set|clipboard_get|notify|compose_sms|send_sms|dial|call|vibrate|speak|confirm|screen|tap|long_press|swipe|scroll|input|key|wait|recall|learn)\b/g, 'action:"$1"');
const reword = (r) => (r && Array.isArray(r.content)
  ? { ...r, content: r.content.map((c) => (c && c.type === 'text' ? { ...c, text: toAction(c.text) } : c)) }
  : r);

// 每个 agy 会话一份（设备锁定、编号归属、每轮一次的经验带回都在闭包里）
const CACHE_MAX = 40;
const cache = new Map();   // `${ctx.key}|${sid}` → { holder, byName }
function toolsFor(ctx, sid) {
  const k = `${ctx.key}|${sid}`;
  let hit = cache.get(k);
  if (hit) { cache.delete(k); cache.set(k, hit); return hit; }
  const holder = { gen: null };
  const confirm = (p) => confirmForAgy(ctx, holder, p);
  const defs = buildPhoneControlTools(ctx.key, () => holder.gen, () => (holder.gen?.turnOrigin?.kind === 'phone' ? holder.gen.turnOrigin.id : undefined), () => sid, { confirm, toUser: false });
  hit = { holder, byName: new Map(defs.map((d) => [d.name, d])) };
  cache.set(k, hit);
  while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return hit;
}

// 高危动作的确认：审批卡上手动允许过（参数对得上）就算；否则手机悬浮窗与对话里的卡一起弹，先答的算。
async function confirmForAgy(ctx, holder, { kind, deviceId, header, question, detail, owner, ownerLabel }) {
  const gen = holder.gen;
  // 审批卡上看到的号码 / 内容要和这次真要发的对得上
  const a = holder.args || {};
  if (kind !== 'confirm' && gen && takeManualApproval(gen, PHONE_TOOL, { action: kind, to: a.to, body: a.body, number: a.number })) return true;
  const ac = new AbortController();
  const phone = deviceId
    ? requestPhoneControl({ genKey: ctx.key, deviceId, op: 'confirm', args: { title: header, question, detail }, timeoutMs: ASK_MAX_MS, owner, ownerLabel })
      .then((r) => (r && typeof r.confirmed === 'boolean' ? (r.confirmed ? 'allow' : 'deny') : null))
      .catch((e) => { if (/正被另一个会话/.test(String(e?.message))) throw e; return null; })
    : Promise.resolve(null);
  const card = askAgyUser(ctx, gen, { message: `${header}：${question}`, detail, signal: ac.signal });
  try {
    // 悬浮窗没开 / 不在线时它很快回 null：那就只等对话里的卡
    const first = await Promise.race([phone.then((v) => (v ? { from: 'phone', v } : null)), card.then((v) => ({ from: 'card', v }))]);
    const verdict = first ? first.v : await card;
    return verdict === 'allow';
  } finally { ac.abort(); }   // 先在悬浮窗上答了、或出错：撤掉对话里那张
}

const s = z.string().optional();
const n = z.number().optional();
const SCHEMA = {
  action: z.enum(ACTIONS).describe('动作'),
  device: s.describe('哪台手机（devices 列出的句柄）'),
  observe: z.enum(['both', 'elements', 'screenshot', 'none']).optional().describe('做完带回的画面'),
  format: z.enum(['both', 'elements', 'screenshot']).optional().describe('screen 看什么'),
  by: s.describe('index / text / coord / focused'),
  index: n, x: n, y: n, x1: n, y1: n, x2: n, y2: n,
  text: s, app: s, url: s, page: s, target: s, title: s,
  to: s, body: s, number: s, question: s, detail: s,
  direction: z.enum(['up', 'down', 'left', 'right']).optional(),
  amount: n, durationMs: n, ms: n,
  clear: z.boolean().optional(),
  submit: z.enum(['enter', 'search', 'send', 'go', 'done', 'next']).optional(),
  key: z.enum(['back', 'home', 'recents', 'notifications', 'enter']).optional(),
  task: s, steps: s, gotchas: s,
  traits: z.union([z.string(), z.array(z.string())]).optional(),
};

function description() {
  const defs = buildPhoneControlTools('doc', () => null, undefined, 'doc', { toUser: false });
  const lines = defs.map((d) => `- ${d.name.replace(/^phone_/, '')}：${toAction(d.description).replace(/toUser:true 时[^。]*。/, '').replace(/子 agent 用它代替 AskUserQuestion。/, '')}`);
  return [
    '操作用户的安卓手机（经手机 app 里常驻的操控服务，真实点按输入）。action 选动作，其余字段按动作给（字段同 Claude 的同名手机工具）。',
    '先 action:"devices" 看哪台在线、能不能用；看画面用 screen，点按用 tap（by:index 用最近一次画面里的编号）。本会话第一次选定的手机会一直锁定，换台要传 device。',
    '发消息、下单、删除这类不可撤回的事，用户原话没明确要求（对象 + 内容）就先 action:"confirm" 问；send_sms / call 自带确认。绝不完成支付、转账。单次调用最长约 150 秒。',
    '动作：',
    ...lines,
  ].join('\n');
}
let DESC = '';

export function makeAgyPhoneMcp({ ctx, getGen }) {
  if (!DESC) DESC = description();
  return createSdkMcpServer({
    name: 'agy-phone',
    version: '1.0.0',
    tools: [tool(PHONE_TOOL, DESC, SCHEMA, async (a, extra) => {
      const gen = getGen && getGen();
      const sid = gen && gen.sessionId;
      if (!sid) return { content: [{ type: 'text', text: '当前会话还没有 id，下一轮再操作手机。' }], isError: true };
      const { holder, byName } = toolsFor(ctx, sid);
      holder.gen = gen;
      holder.args = a;
      const def = byName.get('phone_' + a.action);
      if (!def) return { content: [{ type: 'text', text: `没有动作「${a.action}」。可用：${ACTIONS.join(' / ')}` }], isError: true };
      const parsed = z.object(def.schema || {}).safeParse(a);
      if (!parsed.success) {
        return { content: [{ type: 'text', text: `action:"${a.action}" 的参数不对：${parsed.error.issues.map((i) => `${i.path.join('.') || '(根)'} ${i.message}`).join('；')}（完整说明：tool_docs(name:"${PHONE_TOOL}")）` }], isError: true };
      }
      return reword(await def.handler(parsed.data, extra));
    })],
  });
}

export const PHONE_GROUP = Object.freeze({
  key: 'phone',
  setting: 'phoneControl',
  bare: true,
  owns: (name) => name === PHONE_TOOL,
  budgetMs: 150_000,
  // 同 Claude 的口径（agents/claude/plan.mjs）：手机操控插件开着、且插件配置里「给 agent 工具」没关；在不在线由工具现查
  available: (ctx) => ctx?.kind === 'admin' && pluginOr('phone-control', PHONE_CONTROL) && (pluginConfig('phone-control')?.tools ?? PHONE_CONTROL) !== false,
  build: ({ ctx, getGen }) => makeAgyPhoneMcp({ ctx, getGen }),
});

export function _resetPhoneCacheForTest() { cache.clear(); }
