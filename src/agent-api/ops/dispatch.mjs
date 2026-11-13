// 子 agent 调用策略（dispatch.* 组）：读 / 改 设置 › Claude › 子 agent 调用策略——总开关、生效范围、要不要非 Claude 模型、
// 可命名的多套策略（每档的智力分判定线、档位自定义、口述备注），以及性价比图数据的刷新。
// 都经进程内请求走现成路由（/api/claude/dispatch*，routes/dispatch.mjs）：校验、权限、落盘、总线推送（别的设备上的设置页当场跟上）
// 全在路由与 runtime/dispatch-policy.mjs 里，这里只把「名字 → id」对上，再把快照翻成给 agent 看的样子。
// 这组只在接口手册里（{{ops:dispatch}}），不往任何系统提示里加清单。

import { defineGroup, defineOp, OpError } from '../registry.mjs';
import { internalRequest, routeError } from '../internal.mjs';

defineGroup('dispatch', '子 agent 调用策略', [
  'Claude 派子 agent（动态工作流的 agent()、Agent 工具、start_session 的 auto:<档>）时按哪套规则选模型与推理强度：',
  '四档（top 最难 / hard 难 / normal 常规 / light 机械）各有一条智力分判定线，这一档取「够线的候选里每任务成本最低的」；',
  '优先级：性价比图谱 < 档位自定义（手动指定模型 + 档位）< 口述备注（原样进系统提示）。按身份一份，管理员或有命令行的身份才能改。',
].join(''));

const CODE_OF = { 400: 'bad_args', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'bad_args', 502: 'unavailable', 504: 'timeout' };
const failOf = (r, hint = '') => new OpError(CODE_OF[r.status] || 'failed', routeError(r), hint ? { hint } : {});

async function readPolicy(env) {
  const r = await internalRequest(env.identity, 'GET', '/api/claude/dispatch');
  if (r.status !== 200 || !r.json?.policy) throw failOf(r);
  return r.json;
}

// 一档的落点：auto:<档> 实际换成的模型与档位；agentTool = Agent 工具那条路（只认 Claude 别名）落到的，与 model 不同时才给
function tierView(t) {
  const p = t.pick || {};
  return {
    key: t.key, title: t.title, ...(t.use ? { use: t.use } : {}), floor: t.floor, floorDefault: t.floorDefault, source: t.source,
    model: p.model, label: p.label, effort: p.effort || '', ii: p.ii, cost: p.cost, basis: p.basis, ...(p.provider ? { provider: p.provider } : {}),
    ...(p.est ? { est: true } : {}), ...(t.short ? { short: true } : {}), ...(t.overrideSkipped ? { overrideSkipped: true } : {}),
    ...(t.agentTool ? { agentTool: t.agentTool } : {}),
  };
}
const strategyView = (s, activeId) => ({
  id: s.id, name: s.name, active: s.id === activeId, floors: s.floors, overrides: s.overrides, note: s.note || '',
});
const candidateView = (c) => ({
  model: c.model, label: c.label, effort: c.effort || '', ii: c.ii, cost: c.cost, basis: c.basis,
  ...(c.provider ? { provider: c.provider } : {}), ...(c.est ? { est: true } : {}),
});
function policyView(j, { candidates = false } = {}) {
  const p = j.policy, pv = j.preview || {};
  const active = p.strategies.find((s) => s.id === p.activeId) || p.strategies[0] || null;
  return {
    enabled: p.enabled, scope: p.scope, allowThirdParty: p.allowThirdParty,
    active: active ? { id: active.id, name: active.name } : null,
    strategies: p.strategies.map((s) => strategyView(s, p.activeId)),
    tiers: (pv.tiers || []).map(tierView),
    ...(candidates ? { candidates: (pv.candidates || []).map(candidateView), unrated: pv.unrated || [] } : {}),
    chart: pv.chart || null, rev: p.rev,
    you: { canEdit: !!j.canEdit, canImport: !!j.canImport },
    ...(j.canEdit ? {} : { note: '这个身份不能改调用策略（要管理员或有命令行的身份），看到的是总开关关着的只读默认' }),
  };
}

// 「id 或名字」→ 那一套；名字对上几套 → conflict（要用 id）
function findStrategy(policy, ref, what = '策略') {
  const v = String(ref ?? '').trim();
  if (!v) return null;
  const byId = policy.strategies.find((s) => s.id === v);
  if (byId) return byId;
  const hits = policy.strategies.filter((s) => s.name === v);
  if (hits.length > 1) throw new OpError('conflict', `有 ${hits.length} 套${what}都叫「${v}」`, { hint: '改用 id：' + hits.map((s) => s.id).join('、') });
  return hits[0] || null;
}
const needStrategy = (policy, ref, what) => {
  const s = findStrategy(policy, ref, what);
  if (!s) throw new OpError('not_found', `没有叫「${String(ref).trim()}」的${what}`, { hint: '现有的：' + policy.strategies.map((x) => `${x.name}（${x.id}）`).join('、') });
  return s;
};

defineOp({
  name: 'dispatch.get', title: '看子 agent 调用策略',
  desc: [
    '返回：enabled（总开关；关 = 完全照 Claude Code 原生调用：不拼调度提示、不挂上游代理；旧脚本写的 auto:<档> 只在自定义 API 会话里仍按默认阶梯换名，',
    '官方订阅会话里不再换名（会被当成未知模型拒掉，要写具体模型名），start_session 不解析 auto:<档>（当作没给 model，沿用本会话）。',
    '开着时官方订阅会话也要配了可派的第三方模型、且 workflow 范围管着这一轮才挂上游代理换 auto:<档>，否则只用 Claude 别名）、',
    'scope（生效范围：workflow = 动态工作流 / Ultracode 脚本里的 agent()，subagent = Agent 工具派的子 agent，session = start_session 的 model 写 auto:<档>）、',
    'allowThirdParty（候选里要不要非 Claude 模型）、active（生效的那套）、strategies（全部策略：id、name、active、floors 每档判定线（null = 默认线）、',
    'overrides 档位自定义（{ model, effort } 或 null）、note 口述备注）、',
    'tiers（生效那套的四档实际落点：model / label / effort、ii 智力分、cost 每任务成本（元）、basis 成本口径 sub 订阅 / plan 第三方套餐 / api 官方 API 价、',
    'floor 与 floorDefault、source=override 表示用户指定、short 表示没有模型够得着这条线取了最强的、overrideSkipped 表示指定的模型已不在候选里被忽略、',
    'agentTool 表示 Agent 工具那条路实际落到的 Claude 别名（与 model 不同时才给））、chart（图谱数据版本：source imported 导入的 / builtin 随版本内置，generated 数据日期）、',
    'you（canEdit 能不能改、canImport 能不能刷新图谱）。candidates=true 另带全部候选（指定档位前先看能填哪些 model + effort）。',
  ].join(''),
  need: ['agent:claude'],
  params: {
    basis: { type: 'string', enum: ['official', 'custom'], desc: '落点口径：official = 主会话用订阅模型时（默认），custom = 主会话是自定义 API 模型时' },
    candidates: { type: 'boolean', default: false, desc: '带上全部候选（模型 × 推理档位，含智力分与成本）' },
  },
  handler: async (ctx, args, env) => {
    const r = await internalRequest(env.identity, 'GET', '/api/claude/dispatch' + (args.basis ? '?basis=' + args.basis : ''));
    if (r.status !== 200 || !r.json?.policy) throw failOf(r);
    return policyView(r.json, { candidates: args.candidates });
  },
});

defineOp({
  name: 'dispatch.set', title: '改调用策略的开关与生效策略',
  desc: [
    '改总开关 enabled、生效范围 scope（{ workflow?, subagent?, session? }，只改给了的）、allow_third_party（要不要非 Claude 模型）、',
    '切换生效策略 activate（填策略 id 或名字）。至少给一项；和用户在设置页上改是一回事：随账号同步，只影响之后的轮。只在用户要你改时改。',
    '返回改了哪几项与改完的全貌（同 dispatch.get）。',
  ].join(''),
  access: 'write', need: ['agent:claude'],
  params: {
    enabled: { type: 'boolean', desc: '总开关：false = 完全照 Claude Code 原生调用' },
    scope: { type: 'object', desc: '{ workflow?, subagent?, session? }：各自 true / false' },
    allow_third_party: { type: 'boolean', desc: '候选里要不要非 Claude 模型（关 = 只派 Claude，第三方的档位自定义回落图谱）' },
    activate: { type: 'string', desc: '切到哪一套：策略 id 或名字' },
  },
  example: { scope: { session: true } },
  handler: async (ctx, args, env) => {
    const patch = {};
    if (args.enabled !== undefined) patch.enabled = args.enabled;
    if (args.scope !== undefined) patch.scope = args.scope;
    if (args.allow_third_party !== undefined) patch.allowThirdParty = args.allow_third_party;
    const before = await readPolicy(env);
    if (args.activate !== undefined) patch.activeId = needStrategy(before.policy, args.activate, '策略').id;
    if (!Object.keys(patch).length) throw new OpError('bad_args', '什么都没给', { hint: '至少给 enabled / scope / allow_third_party / activate 里的一项' });
    const r = await internalRequest(env.identity, 'POST', '/api/claude/dispatch/update', { patch });
    if (r.status !== 200 || !r.json?.policy) throw failOf(r, '可改的项见 dispatch.get');
    const a = before.policy, b = r.json.policy;
    const changed = [];
    if (a.enabled !== b.enabled) changed.push({ key: 'enabled', from: a.enabled, to: b.enabled });
    for (const k of Object.keys(b.scope || {})) if (a.scope?.[k] !== b.scope[k]) changed.push({ key: 'scope.' + k, from: a.scope?.[k], to: b.scope[k] });
    if (a.allowThirdParty !== b.allowThirdParty) changed.push({ key: 'allowThirdParty', from: a.allowThirdParty, to: b.allowThirdParty });
    if (a.activeId !== b.activeId) {
      const nm = (p, id) => (p.strategies.find((s) => s.id === id) || {}).name || id;
      changed.push({ key: 'active', from: nm(a, a.activeId), to: nm(b, b.activeId) });
    }
    return { changed, ...(changed.length ? {} : { note: '值和原来一样，没有改动' }), ...policyView({ ...r.json, canEdit: before.canEdit, canImport: before.canImport }) };
  },
});

defineOp({
  name: 'dispatch.strategy_save', title: '新建或修改一套调用策略',
  desc: [
    'id 给了（策略 id 或名字）= 改那一套，只改给了的字段；没给 id 时：给了 copy_of = 以那一套为底新建，name 正好是现有某一套的名字 = 改那一套，否则新建。',
    'floors = { top?, hard?, normal?, light? }：每档的智力分判定线（0–100，一位小数；null = 回默认线），合并后要从高到低。',
    'overrides = { 档: { model, effort } | null }：手动指定这一档（压过图谱），model 写 opus / sonnet / haiku / fable 或 custom:<服务 id>:<型号>，',
    'effort 写推理档位（\'\' = 用模型默认），能填的组合见 dispatch.get candidates=true；null = 取消指定。',
    'note = 口述备注（≤2000 字，原样进系统提示，优先级最高；\'\' = 清空）。新建的不会自动生效，要用 dispatch.set activate 切过去。',
    '返回这套策略与它的四档落点（还没生效的也按它算给你看）。',
  ].join(''),
  access: 'write', need: ['agent:claude'],
  params: {
    id: { type: 'string', desc: '要改的那套：策略 id 或名字（不给 = 新建，或按 name 找同名的改）' },
    name: { type: 'string', desc: '名字（≤24 字）：新建时的名字，或改名' },
    floors: { type: 'object', desc: '{ top?, hard?, normal?, light? }：判定线，null = 默认线' },
    overrides: { type: 'object', desc: '{ 档: { model, effort } | null }' },
    note: { type: 'string', desc: '口述备注；\'\' = 清空' },
    copy_of: { type: 'string', desc: '新建时以哪一套为底复制：策略 id 或名字' },
  },
  example: { name: '省钱', copy_of: '默认', floors: { hard: 60 }, overrides: { light: { model: 'haiku', effort: '' } } },
  handler: async (ctx, args, env) => {
    const fields = ['name', 'floors', 'overrides', 'note'].filter((k) => args[k] !== undefined);
    if (args.id === undefined && args.copy_of === undefined && !fields.length) throw new OpError('bad_args', '什么都没给', { hint: '新建至少给 name；修改给 id 与要改的字段' });
    const cur = await readPolicy(env);
    const P = cur.policy;
    let target = null, copyOf;
    if (args.id !== undefined) target = needStrategy(P, args.id, '策略');
    else if (args.copy_of !== undefined) copyOf = needStrategy(P, args.copy_of, '要复制的策略').id;
    else if (args.name !== undefined) target = findStrategy(P, args.name, '策略');
    const strategy = { ...(target ? { id: target.id } : {}) };
    for (const k of fields) strategy[k] = args[k];
    // 按名字找到的那套：name 就是用来定位的，不当成改名
    if (target && args.id === undefined && strategy.name === target.name) delete strategy.name;
    const r = await internalRequest(env.identity, 'POST', '/api/claude/dispatch/strategy/save', { strategy, ...(copyOf ? { copyOf } : {}) });
    if (r.status !== 200 || !r.json?.strategy) throw failOf(r, '字段写法见 dispatch.strategy_save 的说明；能填的模型与档位见 dispatch.get candidates=true');
    const s = r.json.strategy, active = s.id === r.json.policy.activeId;
    let tiers = r.json.preview?.tiers || [];
    if (!active) {
      const pv = await internalRequest(env.identity, 'POST', '/api/claude/dispatch/preview', { strategy: s });
      tiers = pv.status === 200 && pv.json?.preview ? pv.json.preview.tiers || [] : [];
    }
    const skipped = tiers.filter((t) => t.overrideSkipped).map((t) => t.key);
    return {
      created: !target, strategy: strategyView(s, r.json.policy.activeId), tiers: tiers.map(tierView),
      ...(active ? {} : { note: '这套还没生效：要用它就调 dispatch.set activate=' + s.id }),
      ...(skipped.length ? { warning: `${skipped.join('、')} 档指定的模型不在候选里（被过滤或已删除），这几档按图谱选` } : {}),
    };
  },
});

defineOp({
  name: 'dispatch.strategy_delete', title: '删除一套调用策略',
  desc: '删掉一套策略（id 或名字）。生效中的那套不能删（先用 dispatch.set activate 切到别的），至少要留一套。删了不能恢复：先跟用户确认。',
  access: 'danger', need: ['agent:claude'],
  params: { id: { type: 'string', required: true, desc: '要删的那套：策略 id 或名字' } },
  handler: async (ctx, args, env) => {
    const cur = await readPolicy(env);
    const s = needStrategy(cur.policy, args.id, '策略');
    const r = await internalRequest(env.identity, 'POST', '/api/claude/dispatch/strategy/delete', { id: s.id });
    if (r.status !== 200 || !r.json?.policy) throw failOf(r);
    return { deleted: { id: s.id, name: s.name }, remaining: r.json.policy.strategies.map((x) => ({ id: x.id, name: x.name, active: x.id === r.json.policy.activeId })) };
  },
});

defineOp({
  name: 'dispatch.chart_refresh', title: '刷新性价比图数据',
  desc: [
    '从线上拉最新的「订阅 plan 性价比图」覆盖现有的图谱数据（智力分、每任务成本、各家套餐价；主机级，所有身份共用），返回新的数据版本与四档落点。',
    '只有服务器管理员能做；拉取要几秒到半分钟。只在用户要你更新图谱时调。',
  ].join(''),
  access: 'write', slow: true, need: ['agent:claude'],
  handler: async (ctx, args, env) => {
    const r = await internalRequest(env.identity, 'POST', '/api/claude/dispatch/chart/fetch', {}, { timeoutMs: 60_000 });
    if (r.timedOut) throw new OpError('timeout', '等了 60 秒还没拉完性价比图', { hint: '稍后用 dispatch.get 看 chart 的 generated 有没有变' });
    if (r.status !== 200 || !r.json?.chart) throw failOf(r, r.status === 403 ? '图谱数据只有服务器管理员能刷新' : '');
    return { chart: r.json.chart, tiers: (r.json.preview?.tiers || []).map(tierView) };
  },
});
