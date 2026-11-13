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
import { readBody } from '../runtime/body.mjs';
import { contextFor } from '../runtime/identity.mjs';
import { busPublish, busPublishAll } from '../runtime/bus.mjs';
import { policyFor, canEditPolicy, updatePolicy, saveStrategy, deleteStrategy, onPolicyChange } from '../runtime/dispatch-policy.mjs';
import { ladderPreview } from '../runtime/model-ratings.mjs';
import { CHART_MAX_BYTES, importChartHtml, fetchChart, clearChart, chartAllPoints } from '../runtime/dispatch-chart.mjs';

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

// 策略变更 → 同账号的设备（进程里只挂一次：路由注册几次都不重复推）
let hooked = false;
function hookPolicyBus() {
  if (hooked) return;
  hooked = true;
  onPolicyChange((ctx, p) => { if (ctx && ctx.key) busPublish(ctx.key, { type: 'claude.dispatch', rev: p.rev }); });
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
    try { json(res, 200, { ok: true, ...(await fn(ctx, b)) }); }
    catch (e) { sendError(res, e); }
  });
  const preview = (ctx, b) => ladderPreview(ctx, { basis: basisOf(b && b.basis) });
  const chartChanged = (ctx, chart) => {
    busPublishAll({ type: 'claude.dispatch', chart: true });
    return { chart, preview: preview(ctx) };
  };

  router.on('GET', '/api/claude/dispatch', (req, res, url) => {
    const ctx = guard(req, res);
    if (!ctx) return;
    try {
      const basis = basisOf(url?.searchParams.get('basis'));
      json(res, 200, { ok: true, policy: policyFor(ctx), preview: ladderPreview(ctx, { basis }), canEdit: canEditPolicy(ctx), canImport: canImportChart(ctx) });
    } catch (e) { sendError(res, e); }
  });
  router.on('GET', '/api/claude/dispatch/chart/points', (req, res) => {
    const ctx = guard(req, res);
    if (!ctx) return;
    try { json(res, 200, { ok: true, ...(chartAllPoints() || { points: null }) }); } catch (e) { sendError(res, e); }
  });

  post('/api/claude/dispatch/update', (ctx, b) => {
    if (b.patch === undefined) throw fail('要给 patch：{ enabled?, scope?, allowThirdParty?, activeId? }');
    const policy = updatePolicy(ctx, b.patch);
    return { policy, preview: preview(ctx, b) };
  });
  post('/api/claude/dispatch/strategy/save', (ctx, b) => {
    if (b.strategy === undefined) throw fail('要给 strategy：{ id?, name?, floors?, overrides?, note? }');
    const r = saveStrategy(ctx, b.strategy, { copyOf: b.copyOf ?? undefined });
    return { policy: r.policy, strategy: r.strategy, preview: preview(ctx, b) };
  });
  post('/api/claude/dispatch/strategy/delete', (ctx, b) => {
    const policy = deleteStrategy(ctx, typeof b.id === 'string' ? b.id : '');
    return { policy, preview: preview(ctx, b) };
  });
  // 只算不写：没权限的身份也能算（结果和它自己能看到的一样），快照访客同 GET 能读
  post('/api/claude/dispatch/preview', (ctx, b) => {
    if (b.strategy != null && (typeof b.strategy !== 'object' || Array.isArray(b.strategy))) throw fail('strategy 要是对象');
    if (b.allowThirdParty !== undefined && typeof b.allowThirdParty !== 'boolean') throw fail('allowThirdParty 要是 true / false');
    return { preview: ladderPreview(ctx, { basis: basisOf(b.basis), strategy: b.strategy ?? undefined, allowThirdParty: b.allowThirdParty }) };
  }, { write: false });

  post('/api/claude/dispatch/chart/import', (ctx, b) => {
    if (typeof b.html !== 'string' || !b.html) throw fail('要给 html：性价比图网页的全文');
    if (Buffer.byteLength(b.html) > CHART_MAX_BYTES) throw fail('文件太大：性价比图上限 12MB', 413);
    const chart = importChartHtml(b.html, { from: 'file', name: typeof b.name === 'string' ? b.name : undefined });
    return chartChanged(ctx, chart);
  }, { admin: true, limit: 2 * CHART_MAX_BYTES + MB });
  post('/api/claude/dispatch/chart/fetch', async (ctx) => chartChanged(ctx, await fetchChart()), { admin: true });
  post('/api/claude/dispatch/chart/clear', (ctx) => chartChanged(ctx, clearChart()), { admin: true });
}
