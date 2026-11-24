// Media Studio 的单模型配置：给一个媒体模型补参数（覆盖）、写调用配方、预演与试跑。/api/studio/model-config 与 model-trial 的薄封装。
// 整组受模型中心的开关「允许 AI 配置媒体接口」（registry 的 prefs.agentMediaConfig，默认关）管：关着时一律 forbidden，
// 并告诉 agent 去请用户打开——开关只能用户在界面里改，这里没有改它的操作。
// 托管服务（模型中心管的）还没有这个模型时，先替它在模型中心加进目录、给 Media Studio，再写配置（Studio 那边不许直接加）。
// 配方格式写在手册 studio 章「调用配方」；这里的说明压短（手册按组切段，一组超过 6000 字会被截断）。

import { defineGroup, defineOp, OpError } from '../registry.mjs';
import { internalRequest, routeError } from '../internal.mjs';
import { deliver } from './media.mjs';
import { agentMediaDeny } from '../../runtime/vertex-settings.mjs';
import { hubPrefs, catalogAddModel, assignHubModels } from '../../runtime/model-hub/registry.mjs';
import { studioPoll } from './studio.mjs';

defineGroup('studio_config', 'Media Studio 模型配置',
  '给单个媒体模型补参数、写调用配方（接不标准的中转站接口）、预演与试跑。要用户在 设置 › 模型中心 打开「允许 AI 配置媒体接口」。格式见手册 studio 章「调用配方」。');

const KINDS = ['image', 'video', 'speech', 'music'];
const NEED = ['agent:studio'];
const FINAL = new Set(['done', 'error', 'canceled']);
const OFF_MSG = '用户没有打开「允许 AI 配置媒体接口」：请用户到 设置 › 模型中心（页面最下面）打开后再试；这个开关只能用户自己开';
const gate = () => (hubPrefs().agentMediaConfig ? null : OFF_MSG);
const callerOf = (ctx) => (ctx && ctx.agentCaller ? String(ctx.agentCaller) : 'api');

function fail(r, what) {
  const code = r.status === 403 ? 'forbidden' : r.status === 404 ? 'not_found' : r.status === 429 ? 'quota' : r.status === 400 ? 'bad_args' : r.status === 409 ? 'conflict' : 'failed';
  throw new OpError(code, what + '：' + routeError(r));
}
async function get(env, url, what) {
  const r = await internalRequest(env.identity, 'GET', url);
  if (r.status !== 200 || !r.json?.ok) fail(r, what);
  return r.json;
}
async function post(env, url, body, what) {
  const r = await internalRequest(env.identity, 'POST', url, body || {});
  if (r.status !== 200 || !r.json?.ok) fail(r, what);
  return r.json;
}
const keyArg = (v) => {
  const k = String(v || '').trim();
  if (!/^p-[0-9a-f]{6,12}\/\S{1,200}$/.test(k)) throw new OpError('bad_args', 'model 要写成「服务 id/模型 id」', { hint: '用 studio.models 或 studio.providers 查服务 id' });
  return k;
};
const getConfig = (env, key) => get(env, '/api/studio/model-config?key=' + encodeURIComponent(key), '读模型配置');

// 给 agent 的视图：示例配方只在还没配方时带（照着改），省篇幅
function view(c, { examples = false } = {}) {
  const { examples: ex, ...rest } = c;
  return { ...rest, ...(examples ? { examples: ex } : {}) };
}

const MODEL = { type: 'string', required: true, max: 300, desc: '<服务 id>/<模型 id>（studio.models 的 key）' };
const DRAFT_ARGS = {
  recipe: { type: 'any', desc: '草稿配方（不给 = 用已存的）' },
  over: { type: 'any', desc: '草稿参数覆盖（不给 = 用已存的）' },
  kind: { type: 'string', enum: KINDS, desc: '模型还没加进服务时必给' },
  prompt: { type: 'string', max: 12000 },
  negative: { type: 'string', max: 2000 },
  params: { type: 'object' },
};

defineOp({
  name: 'studio_config.get', title: '看一个媒体模型的调用配置',
  desc: '回 exists（模型在不在服务里）、provider（managed = 模型中心托管）、base（服务方言自带的参数卡）、effective（叠上配置后实际用的卡）、'
    + 'over（参数覆盖）、recipe（调用配方）。还没有配方时带 examples（几种常见接口的配方，照着改）。',
  need: NEED, deny: gate,
  params: { model: MODEL, examples: { type: 'boolean', desc: '强制带上示例配方' } },
  handler: async (ctx, args, env) => {
    const { config } = await getConfig(env, keyArg(args.model));
    return { config: view(config, { examples: args.examples ?? !config.recipe }) };
  },
});

defineOp({
  name: 'studio_config.set', title: '写一个媒体模型的调用配置',
  desc: 'over（参数覆盖：options 补选项 / defaults 改默认 / extra 垫请求体）、recipe（调用配方，有它就照配方发请求）：不给 = 不动，null = 删掉。'
    + '模型还不在服务里要给 kind（托管服务会先在模型中心加好）。写之前先用 studio_config.preview 预演、讲清要改什么并征得用户同意。',
  access: 'danger', need: NEED, deny: gate,
  params: {
    model: MODEL,
    over: { type: 'any', desc: '{ options?, defaults?, extra? } | null' },
    recipe: { type: 'any', desc: '配方对象 | null' },
    kind: { type: 'string', enum: KINDS, desc: '新加模型时的种类' },
    label: { type: 'string', max: 80, desc: '新加模型时的显示名' },
  },
  handler: async (ctx, args, env) => {
    const key = keyArg(args.model);
    if (args.over === undefined && args.recipe === undefined) throw new OpError('bad_args', 'over 和 recipe 至少给一个（给 null = 删掉）');
    const { config } = await getConfig(env, key);
    const body = { key, ...(args.over !== undefined ? { over: args.over } : {}), ...(args.recipe !== undefined ? { recipe: args.recipe } : {}) };
    let added = false;
    if (!config.exists) {
      if (!args.kind) throw new OpError('bad_args', '这个模型还不在服务里：给 kind（' + KINDS.join(' / ') + '）一起加进去');
      if (config.provider.managed) {
        // 托管服务的模型清单归模型中心：先加进它的目录、去向给 Media Studio，同步过去以后再写配置
        const mid = key.slice(key.indexOf('/') + 1);
        try {
          catalogAddModel(config.provider.hubRef, { id: mid, kind: args.kind === 'speech' ? 'voice' : args.kind, ...(args.label ? { label: args.label } : {}) });
          const r = assignHubModels(config.provider.hubRef, [{ id: mid, agents: ['studio'] }]);
          if (r.warnings?.length) throw new Error(r.warnings.join('；'));
        } catch (e) { throw new OpError('failed', '在模型中心添加这个模型没成：' + (e?.message || e)); }
        added = true;
      } else body.create = { kind: args.kind, ...(args.label ? { label: args.label } : {}) };
    }
    const r = await post(env, '/api/studio/model-config', body, '写模型配置');
    return { config: view(r.config), ...(r.warnings?.length ? { warnings: r.warnings } : {}), ...(added || body.create ? { added: true } : {}) };
  },
});

defineOp({
  name: 'studio_config.preview', title: '预演媒体模型的请求（不花钱）',
  desc: '只拼请求、不发：回规范化后的 params、warnings（哪些参数没照原样生效）、request（配方模型：提交请求的方法、地址、请求头、请求体，Key 只剩尾号；'
    + '另附轮询与取结果的写法）。没有配方的模型 request 为 null（请求在方言适配器里拼，只能 trial 看）。inputs 只给角色就行：[{ role }]。',
  need: NEED, deny: gate,
  params: { model: MODEL, ...DRAFT_ARGS, inputs: { type: 'array', desc: '[{ role: edit|ref|first|last|audio|video }]' } },
  handler: async (ctx, args, env) => {
    const r = await post(env, '/api/studio/model-trial', { ...args, key: keyArg(args.model), dry: true }, '预演');
    const { ok, ...rest } = r;
    return rest;
  },
});

defineOp({
  name: 'studio_config.trial', title: '试跑媒体模型（真发一次，花钱）',
  desc: '真发一次生成，回每一步的原始请求与响应（trace：step、method、url、request、response.status / body，Key 已抹掉、素材只留大小）和结果作品。'
    + '可带草稿 recipe / over 先试再存。花钱：先征得用户同意；视频按秒计费，能用图像 / 短时长验证就别用长的。默认等结果（最多 20 分钟）。',
  access: 'danger', slow: true, need: NEED, deny: gate,
  params: {
    model: MODEL, ...DRAFT_ARGS,
    inputs: { type: 'array', desc: '[{ role, asset（作品 id）| path（工作空间）| upload }]' },
    saveTo: { type: 'string', desc: '复制进工作空间的路径（/ 结尾 = 文件夹）' },
    wait: { type: 'boolean', default: true },
  },
  handler: async (ctx, args, env) => {
    const key = keyArg(args.model);
    const { config } = await getConfig(env, key);
    const kind = config.kind || args.kind;
    const why = agentMediaDeny(callerOf(ctx), kind || '');
    if (why) throw new OpError('forbidden', why);
    const { saveTo, wait = true, model, ...rest } = args;
    let { job } = await post(env, '/api/studio/model-trial', { ...rest, key, dry: false }, '试跑');
    const read = async () => {
      const r = await internalRequest(env.identity, 'GET', '/api/studio/model-trial?job=' + encodeURIComponent(job.id));
      if (r.status === 404) throw new OpError('failed', '试跑记录不见了（服务可能重启了）');
      if (r.status !== 200 || !r.json?.ok) fail(r, '读试跑记录');
      return r.json;
    };
    let res = await read();
    if (!wait) return { job: res.job, trace: res.trace, note: '任务在服务端跑：之后用 studio.job 查结果' };
    const t0 = Date.now();
    while (!res.done) {
      if (Date.now() - t0 > studioPoll.totalMs || env.signal?.aborted) return { job: res.job, trace: res.trace, timedOut: true };
      await new Promise((r) => setTimeout(r, studioPoll.ms));
      res = await read();
    }
    job = res.job;
    return {
      state: job.state, ...(job.error ? { error: job.error } : {}), trace: res.trace,
      ...(job.state === 'done' ? { results: (job.result || []).map((a) => deliver(ctx, env, a.id, a.kind, saveTo)) } : {}),
    };
  },
});
