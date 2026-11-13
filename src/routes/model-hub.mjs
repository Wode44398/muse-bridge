// 设置 › 模型中心 的后端（只给服务器主机管理员）。逻辑在 runtime/model-hub/*。写操作全走 POST（离线 apk 跨源，CORS 只放 GET/POST）。
// v2（2026-11-10，契约 §5.4）：服务加一次，去向细到每个模型（文本 → Claude / dimensio，媒体 → Media Studio）。
//   GET  /api/model-hub                         → { ok, v: 2, vertex, services, claude, dimensio|null, studio|null, studioErr?, plugins }   总览（不带任何 Key）
//        studio：null = 没开 Media Studio；读不出来时 [] + studioErr（人话）
//   POST /api/model-hub/detect   {id} | {draft}  → { ok, conn, models, media|null, warnings }   识别协议、地址、模型目录
//   GET  /api/model-hub/catalog?id=             → { ok, at, models }   一个服务的模型目录（已添加但目录里没有的补在后面）
//   POST /api/model-hub/catalog/add {id, model:{id, kind, label?}} → { ok, model }   手动加一个模型 ID 进目录
//   POST /api/model-hub/create   {name?, baseUrl, kind, authStyle?, headers?, useProxy?, key, catalog, assign, media?} → { ok, service, warnings }
//        （老形状 {…服务, lines, models, agents} 也收：老前端、脚本照常能用）
//   POST /api/model-hub/assign   {id, changes:[{id, agents}]} → { ok, service, warnings }   agents = 这个模型去向的全集，[] = 移除
//   POST /api/model-hub/update   {id, patch}     → { ok, service, warnings }   patch.lines 给了就整表替换（没带 key 的线路沿用存着的）；模型走 assign
//   POST /api/model-hub/delete   {id}            → { ok, warnings }
//   POST /api/model-hub/adopt    {from: 'claude' | 'dimensio' | 'studio', id} → { ok, service, warnings }
//        claude / dimensio：地址、协议、型号、Key 照抄成一个模型中心服务（一条线路），全部模型去向 = 两边能给的
//        （Gemini 协议、id 或上下文窗口不合 Claude 规则的只给 dimensio）；Claude 的原服务从模型菜单里隐藏（不停用：记着它的老会话照常能跑）。
//        studio：原地收编（Studio 服务 id 不变，打上托管标；启停、共享照抄，停用 / 备选的模型只进目录）。
//   GET  /api/model-hub/builtins                → { ok, builtins: [{ id, name, dialect: 'vertex'|'local', enabled, shared, models:[{ id, label, kind, enabled }] }] | null }
//   POST /api/model-hub/builtin  {id, enabled?, shared?, models?: { 模型 id: bool }} → { ok, builtin }   Studio 的内置媒体服务（Vertex / 本机）
//   POST /api/model-hub/builtin/import              → { ok, items }   加上 Vertex / 本机的媒体服务（Studio 一键导入）
//   保留：POST /vertex、/line/reset、/models（从一条线路拉模型 id 列表）、/test。
// 出错一律 { error: 人话 } + 状态码（400 输入不对、404 没有这个、413 太大、502 / 504 上游连不上 / 超时）。任何响应都不带 Key。
import { readBody } from '../runtime/body.mjs';
import {
  createHubService, createHubFromDetect, assignHubModels, updateHubV2, deleteHubV2, updateVertex, resetHubLine, lineContext,
  detectHub, catalogView, catalogAddModel, markMigrated,
} from '../runtime/model-hub/registry.mjs';
import { adoptClaudeProvider, adoptTextService, adoptStudioProvider, migrateLegacyConfigs } from '../runtime/model-hub/legacy-migrate.mjs';
import { getModule } from '../modules/registry.mjs';
import { studioList, studioBuiltins, setStudioBuiltin } from '../runtime/model-hub/studio-link.mjs';
import { hubOverview, exportDimensioProvider } from '../runtime/model-hub/overview.mjs';
import { fetchLineModels, testLine } from '../runtime/model-hub/probe.mjs';

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });
const KB = 1024;

// 报错的出口：有状态码的是我们自己抛的人话，原样给；没有的是意外（多半是读写盘），记日志、给一句通用的话，
// 不把内部的报错原文（路径、栈）直接甩给界面
function sendError(res, e) {
  const status = Number.isInteger(e?.status) && e.status >= 400 && e.status < 600 ? e.status : 500;
  if (status === 500) console.error('[model-hub] 请求处理失败：', e?.stack || e?.message || e);
  json(res, status, { error: status === 500 ? `模型中心出错了：${String(e?.message || e).slice(0, 200)}` : String(e?.message || e) });
}

export function registerModelHubRoutes(router, { identify }) {
  const guard = (req, res) => {
    const who = identify(req);
    if (who.kind !== 'admin') { json(res, who.kind === 'none' ? 401 : 403, { error: '只有服务器管理员能管理模型中心' }); return false; }
    return true;
  };
  // limit：多数请求很小；create 带着整份识别目录（OpenRouter 一次几百个模型），给到 2 MB
  const post = (path, fn, limit = 512 * KB) => router.on('POST', path, async (req, res) => {
    if (!guard(req, res)) return;
    let b;
    try {
      const raw = await readBody(req, limit);
      b = raw.trim() ? JSON.parse(raw) : {};
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw new Error('not an object');
    } catch (e) {
      return e?.message === 'body too large'
        ? json(res, 413, { error: `请求内容太大（上限 ${Math.round(limit / KB)} KB）` })
        : json(res, 400, { error: '请求内容不是合法的 JSON 对象' });
    }
    try { json(res, 200, { ok: true, ...(await fn(b)) }); }
    catch (e) { sendError(res, e); }
  });
  const id = (b) => String(b.id || '');

  router.on('GET', '/api/model-hub', (req, res) => {
    if (!guard(req, res)) return;
    try { json(res, 200, { ok: true, ...hubOverview() }); } catch (e) { sendError(res, e); }
  });
  router.on('GET', '/api/model-hub/catalog', (req, res, url) => {
    if (!guard(req, res)) return;
    try {
      const sid = String(url?.searchParams.get('id') || '');
      if (!sid) throw fail('要给服务 id');
      json(res, 200, { ok: true, ...catalogView(sid) });
    } catch (e) { sendError(res, e); }
  });

  post('/api/model-hub/detect', (b) => detectHub(b));
  post('/api/model-hub/catalog/add', (b) => catalogAddModel(id(b), b.model));
  post('/api/model-hub/create', (b) => {
    // v2 的形状带 catalog / assign（识别 → 勾选 → 建）；都没带 = 老形状（服务级 agents + 型号清单）
    if (Array.isArray(b.catalog) || Array.isArray(b.assign)) return createHubFromDetect(b);
    return { service: createHubService(b), warnings: [] };
  }, 2048 * KB);
  post('/api/model-hub/assign', (b) => assignHubModels(id(b), b.changes));
  post('/api/model-hub/update', (b) => updateHubV2(id(b), b.patch || {}));
  post('/api/model-hub/delete', (b) => deleteHubV2(id(b)));
  post('/api/model-hub/vertex', (b) => ({ vertex: updateVertex(b) }));
  post('/api/model-hub/line/reset', (b) => {
    const service = resetHubLine(id(b), String(b.lineId || ''));
    if (!service) throw fail('没有这个服务', 404);
    return { service };
  });
  post('/api/model-hub/models', async (b) => {
    const { service, line, key } = lineContext(b);
    return { models: await fetchLineModels(service, line, key) };
  });
  post('/api/model-hub/test', async (b) => {
    const { service, line, key } = lineContext(b);
    const model = String(b.model || '').trim();
    if (!model) throw fail('要选一个型号来测');
    return { result: await testLine(service, line, key, model) };
  });
  post('/api/model-hub/adopt', (b) => {
    if (b.from === 'studio') {
      const x = (studioList() || []).find((p) => p && p.id === id(b));
      if (!x) throw fail('Media Studio 里没有这个服务', 404);
      if (x.managed) throw fail('这个媒体服务已经由模型中心管理');
      const r = adoptStudioProvider(x);
      return { service: r.service, warnings: r.warnings };
    }
    if (b.from === 'dimensio') {
      // dimensio 的自定义服务：地址、协议、型号、Key 照抄成共用服务。原来那份由前端随后经 dimensio 自己的接口删掉
      //（它的注册表在 harness 进程内存里，这里不碰它的文件）。
      const p = exportDimensioProvider(id(b));
      if (!p) throw fail('没有这个模型服务', 404);
      if (!p.key && p.authStyle !== 'none') throw fail('这个服务的 Key 读不出来，没法照抄；请在 dimensio 里重新填一次 Key 再试');
      const r = adoptTextService({ ...p, models: p.models.map(({ agents: _a, ...m }) => ({ ...m, kind: 'text' })), members: p.shared === true });
      markMigrated('dimensio', id(b), r.service.id);
      return { service: r.service, warnings: r.warnings };
    }
    if (b.from !== 'claude') throw fail('只能从 Claude、dimensio 或 Media Studio 的服务搬');
    const r = adoptClaudeProvider(id(b));
    return { service: r.service, warnings: r.warnings };
  });
  // Media Studio 的内置媒体服务（Vertex / 本机图像模型）：不是「地址 + Key」，数据留在 Studio，由模型中心的 Vertex 卡、本机卡直接读写
  router.on('GET', '/api/model-hub/builtins', (req, res) => {
    if (!guard(req, res)) return;
    try { json(res, 200, { ok: true, builtins: studioBuiltins() }); } catch (e) { sendError(res, e); }
  });
  // 加上 Vertex / 本机图像模型的媒体服务（Studio 的一键导入，幂等）；顺带导进来的「地址 + Key」服务（Gemini、OpenRouter 的 Key）当场并进模型中心
  post('/api/model-hub/builtin/import', async () => {
    const studio = getModule('studio');
    if (typeof studio?.importVertex !== 'function') throw fail('这台服务器没有启用 Media Studio');
    const r = await studio.importVertex();
    try { migrateLegacyConfigs(); } catch (e) { console.error('[model-hub] 导入后并进模型中心失败：', e?.message || e); }
    const items = (r?.items || []).map((x) => ({ id: x.id, ok: !!x.ok, status: x.status, ...(x.reason ? { reason: String(x.reason).slice(0, 200) } : {}) }));
    return { items };
  });
  post('/api/model-hub/builtin', (b) => ({
    builtin: setStudioBuiltin(id(b), {
      ...(typeof b.enabled === 'boolean' ? { enabled: b.enabled } : {}),
      ...(typeof b.shared === 'boolean' ? { shared: b.shared } : {}),
      ...(b.models && typeof b.models === 'object' && !Array.isArray(b.models) ? { models: b.models } : {}),
    }),
  }));
}
