// 设置 › Claude › 对话 › 子 agent 调用策略 的后端（2026-11-11，契约 §3.4）。逻辑在 runtime/dispatch-policy.mjs（按身份的策略文件）、
// runtime/model-ratings.mjs（四档落点预览 ladderPreview）、runtime/dispatch-chart.mjs（主机级的性价比图数据）。写操作全走 POST（离线 apk 跨源，CORS 只放 GET/POST）。
// 鉴权同 /api/claude/settings：没登录 / 分享身份 401；快照访客能读（拿到 enabled:false 的只读默认）、写一律 403；
// 改策略要管理员或有命令行的身份（canEdit，不够格的由 dispatch-policy 抛 403）；图谱的导入 / 拉取 / 清除只给管理员（canImport）。
//   GET  /api/claude/dispatch?basis=official|custom             → { ok, policy, preview, canEdit, canImport }
//   POST /api/claude/dispatch/update          {patch, basis?}   → { ok, policy, preview }
//        patch = { enabled?, scope?:{ workflow?, subagent?, session? }, allowThirdParty?, activeId? }
//   POST /api/claude/dispatch/strategy/save   {strategy, copyOf?, basis?} → { ok, policy, strategy, preview }
//        strategy.id 有 = 改那一套（只改给了的字段），没有 = 新建（copyOf = 以哪一套为底）
//   POST /api/claude/dispatch/strategy/delete {id, basis?}      → { ok, policy, preview }
//   POST /api/claude/dispatch/preview         {strategy?, allowThirdParty?, basis?} → { ok, preview }   不落盘：拖判定线、改档位时的实时预览
//   GET  /api/claude/dispatch/chart/points                      → { ok, generated, points, vendors } | { ok, points:null }   「显示全图」的点
//   POST /api/claude/dispatch/chart/import    {html, name?}     → { ok, chart, preview }   HTML ≤ 12MB，超限 413
//   POST /api/claude/dispatch/chart/fetch     {}                → { ok, chart, preview }   从线上拉最新的覆盖
//   POST /api/claude/dispatch/chart/clear     {}                → { ok, chart, preview }   删掉导入的，回到随版本内置的快照
// 写成功后推总线 claude.dispatch：策略变更推 { rev } 给同账号的设备（经 onPolicyChange 挂一次，agent 接口经进程内请求改的也推）；
// 图谱变更推 { chart:true } 给所有在线身份（图谱数据主机级、所有身份共用，大家的预览都变了）。收到的设备重新 GET。
// 出错一律 { error: 人话 } + 状态码（400 输入不对、401 没登录、403 没权限、404 没有这套、413 太大、502 / 504 线上图谱拉不到 / 超时）。
//
// 作用域（2026-11-14，设置 › dimensio › 子 agent 调用策略）：上面每个接口都认 scope（GET 查询串、POST 请求体），缺省 claude（同上，一字不变）；
// scope=dimensio 读写 dimensio 那份（runtime/dispatch-policy.mjs 的 dimensio 作用域，多一个 follow，patch 也认 follow），鉴权一样：
//   GET 另带 claude:{ activeId, name, enabled, rev, note, overrides }（Claude 生效的那一套：跟随模式下给人看在跟随谁、只读显示它的备注与档位自定义）；
//   preview 按 dimensio 的口径算——候选是这个身份的 dimensio 实例此刻真能用的型号、API 价（本机 0 元），由实例自己算
//   （modules/dimensio 的 dispatchPreview → harness POST /api/dispatch/preview），这里只补上 chart 与档名；实例起不来时 preview:null + previewError。
//   跟随模式下预览按 Claude 那套算（档位自定义映射成 dimensio 的型号，见 runtime/dispatch-dimensio.mjs）。
//   dimensio 那份还没落过盘时，GET 先问实例要旧偏好迁一次（migrateDimensioLegacy）。总线推 { rev, scope:'dimensio' }。
//   策略变更（两个作用域都算：跟随模式依赖 Claude 那份）还会叫这个身份在跑的 dimensio 实例丢掉缓存（不拉起没在跑的）。
//
// 同机接口（dimensio 实例取它的生效策略，凭据 = 实例拉起时给的同机凭据，只认本机直连，见 agent-api/instance-auth.mjs）：
//   POST /api/internal/dispatch-policy { chart?: 手里图谱数据的版本键, legacy?: { ladder, note } }
//        → { ok, policy:（runtime/dispatch-dimensio.mjs 的 dimensioEffective）, chart:{ key, ratings? } }
//   只回策略本身（开关、范围、判定线、档位自定义、备注）与公开的图谱数据，不带号池、套餐、Key 之类。不是实例凭据 / 不是本机直连 → 404。
import { readBody } from '../runtime/body.mjs';
import { contextFor } from '../runtime/identity.mjs';
import { busPublish, busPublishAll } from '../runtime/bus.mjs';
import {
  policyFor, canEditPolicy, updatePolicy, saveStrategy, deleteStrategy, onPolicyChange, policyScope, sanitizeStrategy,
  dimensioPolicyStored, migrateDimensioLegacy,
} from '../runtime/dispatch-policy.mjs';
import { ladderPreview, TIERS } from '../runtime/model-ratings.mjs';
import { CHART_MAX_BYTES, importChartHtml, fetchChart, clearChart, chartAllPoints, chartMeta } from '../runtime/dispatch-chart.mjs';
import { dimensioEffective, claudeSummary, chartFor } from '../runtime/dispatch-dimensio.mjs';
import { instanceCaller } from '../agent-api/instance-auth.mjs';
import { getModule } from '../modules/registry.mjs';

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const KB = 1024;
const MB = 1024 * KB;

// 报错的出口：有状态码的是我们自己抛的人话，原样给；没有的是意外（多半是读写盘），记日志、给一句通用的话
function sendError(res, e) {
  const status = Number.isInteger(e?.status) && e.status >= 400 && e.status < 600 ? e.status : 500;
  if (status === 500) console.error('[dispatch] 请求处理失败：', e?.stack || e?.message || e);
  json(res, status, { error: status === 500 ? `子 agent 调用策略出错了：${String(e?.message || e).slice(0, 200)}` : String(e?.message || e) });
}

const basisOf = (v) => (v === 'custom' ? 'custom' : 'official');
const canImportChart = (ctx) => ctx.kind === 'admin' && !ctx.snap;
const bearer = (req) => { const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || '')); return m ? m[1].trim() : ''; };

// —— dimensio 那份的预览：实例自己算（候选与成本只有它知道）——
let testDim;   // 测试用：顶替 getModule('dimensio') 的那几个钩子（undefined = 不顶替）
const dim = () => (testDim !== undefined ? testDim : getModule('dimensio'));
/** 测试用：{ dispatchPreview?, dispatchLegacy?, dispatchChanged? } 顶替 dimensio 扩展；undefined = 回到真的。 */
export function _setDimensioHooksForTests(h) { testDim = h; }
const TITLE = Object.fromEntries(TIERS.map((t) => [t.key, { title: t.title, use: t.use }]));
/**
 * dimensio 口径的预览 → { preview, previewError? }。strategy 不给 = 按这个身份生效的那套（dimensio 没有 allowThirdParty，候选恒为全部）。
 * 草稿策略按当前模式认写法：跟随时是 Claude 写法（档位自定义 opus / custom:…），单独时是 dimensio 写法（厂商:型号）。
 */
async function dimensioPreview(ctx, { strategy } = {}) {
  const fn = dim()?.dispatchPreview;
  if (typeof fn !== 'function') return { preview: null, previewError: 'dimensio 没有加载' };
  // 候选是这个身份自己的 dimensio 实例能用的型号：快照访客、没有 dimensio 的成员不给（别落到管理员实例上去算）
  if (ctx.snap || !(ctx.kind === 'admin' || (ctx.kind === 'user' && ctx.allowDimensio))) return { preview: null, previewError: '这个身份用不了 dimensio' };
  const follow = policyFor(ctx, { scope: 'dimensio' }).follow === true;
  const draft = strategy !== undefined && strategy !== null ? sanitizeStrategy(strategy, { scope: follow ? 'claude' : 'dimensio' }) : undefined;
  const eff = dimensioEffective(ctx, { strategy: draft });
  let pv;
  try {
    pv = await fn(ctx, { strategy: eff.strategy, allowThirdParty: true });   // dimensio 没有「调用非 Claude 模型」开关：候选恒为全部
  } catch (e) {
    return { preview: null, previewError: String(e?.message || e).slice(0, 200) };
  }
  if (!pv || !Array.isArray(pv.tiers)) return { preview: null, previewError: 'dimensio 没有给出落点' };
  return {
    preview: {
      basis: 'dimensio', tiers: pv.tiers.map((t) => ({ ...TITLE[t.key], ...t, agentTool: null })),
      candidates: Array.isArray(pv.candidates) ? pv.candidates : [], unrated: Array.isArray(pv.unrated) ? pv.unrated : [],
      poolPlans: [], chart: chartMeta(),
    },
  };
}

// dimensio 那份还没落过盘：问实例要旧偏好（按难度选型阶梯开关、子 agent 调度偏好文本）迁一次。问不到就算了（实例取策略时还会再送）
async function syncDimensioLegacy(ctx) {
  if (!canEditPolicy(ctx) || dimensioPolicyStored(ctx)) return;
  const fn = dim()?.dispatchLegacy;
  if (typeof fn !== 'function') return;
  try { migrateDimensioLegacy(ctx, await fn(ctx)); } catch { /* 实例起不来 / 老版本没有这个接口 */ }
}

// 策略变更 → 同账号的设备（进程里只挂一次：路由注册几次都不重复推）；再叫这个身份在跑的 dimensio 实例丢掉缓存
let hooked = false;
function hookPolicyBus() {
  if (hooked) return;
  hooked = true;
  onPolicyChange((ctx, p, scope) => {
    if (ctx && ctx.key) busPublish(ctx.key, { type: 'claude.dispatch', rev: p.rev, ...(scope === 'dimensio' ? { scope } : {}) });
    try { dim()?.dispatchChanged?.(ctx); } catch { /* 通知不到就等它自己的缓存过期 */ }
  });
}

export function registerDispatchRoutes(router, { identify }) {
  hookPolicyBus();
  const guard = (req, res) => {
    const who = identify(req);
    if (!who || who.kind === 'none' || who.kind === 'share') { json(res, 401, { error: '没有登录' }); return null; }
    return contextFor(who);
  };
  // write：快照访客一律 403（同 POST /api/claude/settings）；admin：只有服务器管理员（图谱数据主机级）
  // limit：多数请求很小；导入图谱的 HTML 上限 12MB，转成 JSON 字符串后引号、换行要转义，给到两倍再留点余量
  const post = (path, fn, { limit = 64 * KB, write = true, admin = false } = {}) => router.on('POST', path, async (req, res) => {
    const ctx = guard(req, res);
    if (!ctx) return;
    if (write && ctx.snap) return json(res, 403, { error: '快照访客不能修改子 agent 调用策略' });
    if (admin && !canImportChart(ctx)) return json(res, 403, { error: '只有服务器管理员能管理性价比图数据' });
    let b;
    try {
      const raw = await readBody(req, limit);
      b = raw.trim() ? JSON.parse(raw) : {};
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('not an object');
    } catch (e) {
      return e?.message === 'body too large'
        ? json(res, 413, { error: admin ? '文件太大：性价比图上限 12MB' : `请求内容太大（上限 ${Math.round(limit / KB)} KB）` })
        : json(res, 400, { error: '请求内容不是合法的 JSON 对象' });
    }
    try { json(res, 200, { ok: true, ...(await fn(ctx, b, policyScope(b.scope))) }); }
    catch (e) { sendError(res, e); }
  });
  // 写接口带回的预览：按作用域算（dimensio 的那份带 previewError 时一并给）
  const preview = async (ctx, b, scope) => {
    if (scope === 'dimensio') return dimensioPreview(ctx);
    return { preview: ladderPreview(ctx, { basis: basisOf(b && b.basis) }) };
  };
  const chartChanged = async (ctx, chart, b, scope) => {
    busPublishAll({ type: 'claude.dispatch', chart: true });
    return { chart, ...(await preview(ctx, b, scope)) };
  };

  router.on('GET', '/api/claude/dispatch', async (req, res, url) => {
    const ctx = guard(req, res);
    if (!ctx) return;
    try {
      const scope = policyScope(url?.searchParams.get('scope') || undefined);
      if (scope === 'dimensio') {
        await syncDimensioLegacy(ctx);
        const pv = await dimensioPreview(ctx);
        json(res, 200, {
          ok: true, scope, policy: policyFor(ctx, { scope }), ...pv,
          canEdit: canEditPolicy(ctx), canImport: canImportChart(ctx), claude: claudeSummary(ctx),
        });
        return;
      }
      const basis = basisOf(url?.searchParams.get('basis'));
      json(res, 200, { ok: true, policy: policyFor(ctx), preview: ladderPreview(ctx, { basis }), canEdit: canEditPolicy(ctx), canImport: canImportChart(ctx) });
    } catch (e) { sendError(res, e); }
  });
  router.on('GET', '/api/claude/dispatch/chart/points', (req, res) => {
    const ctx = guard(req, res);
    if (!ctx) return;
    try { json(res, 200, { ok: true, ...(chartAllPoints() || { points: null }) }); } catch (e) { sendError(res, e); }
  });

  post('/api/claude/dispatch/update', async (ctx, b, scope) => {
    if (b.patch === undefined) throw fail(scope === 'dimensio' ? '要给 patch：{ enabled?, follow?, scope?, activeId? }' : '要给 patch：{ enabled?, scope?, allowThirdParty?, activeId? }');
    const policy = updatePolicy(ctx, b.patch, { scope });
    return { policy, ...(await preview(ctx, b, scope)) };
  });
  post('/api/claude/dispatch/strategy/save', async (ctx, b, scope) => {
    if (b.strategy === undefined) throw fail('要给 strategy：{ id?, name?, floors?, overrides?, note? }');
    const r = saveStrategy(ctx, b.strategy, { copyOf: b.copyOf ?? undefined, scope });
    return { policy: r.policy, strategy: r.strategy, ...(await preview(ctx, b, scope)) };
  });
  post('/api/claude/dispatch/strategy/delete', async (ctx, b, scope) => {
    const policy = deleteStrategy(ctx, typeof b.id === 'string' ? b.id : '', { scope });
    return { policy, ...(await preview(ctx, b, scope)) };
  });
  // 只算不写：没权限的身份也能算（结果和它自己能看到的一样），快照访客同 GET 能读
  post('/api/claude/dispatch/preview', async (ctx, b, scope) => {
    if (b.strategy != null && (typeof b.strategy !== 'object' || Array.isArray(b.strategy))) throw fail('strategy 要是对象');
    if (b.allowThirdParty !== undefined && typeof b.allowThirdParty !== 'boolean') throw fail('allowThirdParty 要是 true / false');
    if (scope === 'dimensio') return dimensioPreview(ctx, { strategy: b.strategy ?? undefined });
    return { preview: ladderPreview(ctx, { basis: basisOf(b.basis), strategy: b.strategy ?? undefined, allowThirdParty: b.allowThirdParty }) };
  }, { write: false });

  post('/api/claude/dispatch/chart/import', (ctx, b, scope) => {
    if (typeof b.html !== 'string' || !b.html) throw fail('要给 html：性价比图网页的全文');
    if (Buffer.byteLength(b.html) > CHART_MAX_BYTES) throw fail('文件太大：性价比图上限 12MB', 413);
    const chart = importChartHtml(b.html, { from: 'file', name: typeof b.name === 'string' ? b.name : undefined });
    return chartChanged(ctx, chart, b, scope);
  }, { admin: true, limit: 2 * CHART_MAX_BYTES + MB });
  post('/api/claude/dispatch/chart/fetch', async (ctx, b, scope) => chartChanged(ctx, await fetchChart(), b, scope), { admin: true });
  post('/api/claude/dispatch/chart/clear', (ctx, b, scope) => chartChanged(ctx, clearChart(), b, scope), { admin: true });

  // —— 同机接口：dimensio 实例取它的生效策略 ——
  router.on('POST', '/api/internal/dispatch-policy', async (req, res) => {
    const who = instanceCaller(req, bearer(req));
    // 不是同机实例凭据、或不是本机直连：当作不存在
    if (!who) return json(res, 404, { error: 'not found' });
    if (who.instance !== 'dimensio') return json(res, 403, { error: `${who.instance || '这个调用方'} 不能用这个接口` });
    let b;
    try { b = JSON.parse((await readBody(req, 16 * KB)) || '{}'); } catch { return json(res, 400, { error: 'bad json' }); }
    if (!b || typeof b !== 'object' || Array.isArray(b)) b = {};
    try {
      const ctx = who.ctx;
      if (b.legacy && typeof b.legacy === 'object') migrateDimensioLegacy(ctx, b.legacy);
      json(res, 200, { ok: true, policy: dimensioEffective(ctx), chart: chartFor(typeof b.chart === 'string' ? b.chart : '') });
    } catch (e) { sendError(res, e); }
  });
}
