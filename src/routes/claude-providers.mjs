// 设置 › Claude › 模型服务（自定义 API）的后端。逻辑在 runtime/claude-providers*.mjs。
// 只给主机管理员（替别人连任意地址 = SSRF；Key 也是主机的）。写操作全走 POST（离线 apk 跨源，CORS 只放 GET/POST）。
//   GET  /api/claude/providers                 → { ok, providers, presets, models }
//   POST /api/claude/providers/create  {…}     → { ok, provider }
//   POST /api/claude/providers/update  {id, patch} → { ok, provider }
//   POST /api/claude/providers/delete  {id}    → { ok }
//   POST /api/claude/providers/models  {id?|draft}  → { ok, models }   拉端点的模型列表（附能力猜测；编辑中未保存的配置也能拉）
//   POST /api/claude/providers/guess   {ids, protocol} → { ok, models } 手动添加的型号按内置型号表 / 名字猜能力（不联网）
//   POST /api/claude/providers/test    {id?|draft, model?} → { ok, result }   用这份配置真打一次（草稿也能测）
//   POST /api/claude/providers/detect  {id?|draft} → { ok, detect }   一键识别协议与地址（同站兄弟地址 × 两种协议各打一次）
//   POST /api/claude/providers/probe-model {id?|draft, model} → { ok, probe }  探测一个模型的输出上限 / 视觉 / 思考 / 档位
//   GET  /api/claude/providers/log?id= → { ok, log }                   最近请求
// 改动推总线 {type:'claude.providers'}，在线设备的模型选择器即时跟上；连上总线时的 hello 也带一份模型清单（overview.mjs）。
// 官方 api.anthropic.com 的服务：启动时与每次保存后在后台探一遍各型号支不支持 fast（ensureFastProbes），结论变了也推一次总线。
import { readBody } from '../runtime/body.mjs';
import { contextFor } from '../runtime/identity.mjs';
import { busPublish } from '../runtime/bus.mjs';
import { HOST_OWNER } from '../runtime/principal.mjs';
import { listProviders, createProvider, updateProvider, deleteProvider, customModelsView, getProvider, normalizeProvider, PRESETS } from '../runtime/claude-providers.mjs';
import { fetchRemoteModels, guessModels, testProvider, detectProtocol, probeModel, providerLog, ensureFastProbes, onFastProbeChange } from '../runtime/claude-providers-proxy.mjs';

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

export function registerClaudeProviderRoutes(router, { identify }) {
  const guard = (req, res) => {
    const who = identify(req);
    if (who.kind === 'none' || who.kind === 'share') { json(res, 401, { error: 'unauthorized' }); return null; }
    const ctx = contextFor(who);
    if (ctx.kind !== 'admin' || ctx.snap) { json(res, 403, { error: '只有主机管理员能管理模型服务' }); return null; }
    return ctx;
  };
  const body = async (req, res) => {
    try { return JSON.parse(await readBody(req, 512 * 1024)) || {}; } catch { json(res, 400, { error: 'bad json' }); return null; }
  };
  const snapshot = () => ({ providers: listProviders(), models: customModelsView() });
  const publish = (ctx) => busPublish(ctx.key, { type: 'claude.providers', ...snapshot() });
  // 模型清单只给主机管理员（同 hello），fast 探测结论变了就推给 HOST_OWNER 这条总线，菜单里的开关跟着出现 / 消失
  onFastProbeChange(() => busPublish(HOST_OWNER, { type: 'claude.providers', ...snapshot() }));
  const probeFast = (id) => { const p = id && getProvider(id); if (p) ensureFastProbes(p).catch(() => {}); };
  setTimeout(() => { for (const p of listProviders()) probeFast(p.id); }, 5000).unref?.();
  const run = async (res, fn) => {
    try { json(res, 200, { ok: true, ...(await fn()) }); }
    catch (e) { json(res, e?.status || 500, { error: e?.message || String(e) }); }
  };
  // 已存的服务按存档配置；编辑中的草稿先过一遍规范化（地址、请求头、模型的校验同保存），带上 id（用已存的 Key）与临时 apiKey。
  // withModels=false：只关心连接（拉模型列表），草稿里的模型不校验。
  const draftOf = (b, withModels) => {
    const saved = b.id ? getProvider(String(b.id)) : null;
    if (!b.draft || typeof b.draft !== 'object') {
      if (!saved) throw Object.assign(new Error('没有这个模型服务'), { status: 404 });
      return saved;
    }
    const d = normalizeProvider({ ...(saved || {}), ...b.draft, ...(withModels ? {} : { models: [] }) }, saved);
    return { ...d, id: saved ? saved.id : undefined, apiKey: typeof b.draft.apiKey === 'string' ? b.draft.apiKey : undefined };
  };

  router.on('GET', '/api/claude/providers', async (req, res) => {
    if (!guard(req, res)) return;
    run(res, () => ({ ...snapshot(), presets: PRESETS }));
  });

  router.on('POST', '/api/claude/providers/create', async (req, res) => {
    const ctx = guard(req, res); if (!ctx) return;
    const b = await body(req, res); if (!b) return;
    run(res, () => { const provider = createProvider(b); publish(ctx); probeFast(provider.id); return { provider }; });
  });

  router.on('POST', '/api/claude/providers/update', async (req, res) => {
    const ctx = guard(req, res); if (!ctx) return;
    const b = await body(req, res); if (!b) return;
    run(res, () => { const provider = updateProvider(String(b.id || ''), b.patch || {}); publish(ctx); probeFast(provider.id); return { provider }; });
  });

  router.on('POST', '/api/claude/providers/delete', async (req, res) => {
    const ctx = guard(req, res); if (!ctx) return;
    const b = await body(req, res); if (!b) return;
    run(res, () => { deleteProvider(String(b.id || '')); publish(ctx); return {}; });
  });

  router.on('POST', '/api/claude/providers/models', async (req, res) => {
    if (!guard(req, res)) return;
    const b = await body(req, res); if (!b) return;
    run(res, async () => ({ models: await fetchRemoteModels(draftOf(b, false)) }));
  });

  router.on('POST', '/api/claude/providers/guess', async (req, res) => {
    if (!guard(req, res)) return;
    const b = await body(req, res); if (!b) return;
    run(res, () => ({ models: guessModels(b.ids, b.protocol === 'openai' ? 'openai' : 'anthropic') }));
  });

  router.on('POST', '/api/claude/providers/test', async (req, res) => {
    if (!guard(req, res)) return;
    const b = await body(req, res); if (!b) return;
    run(res, async () => {
      const p = draftOf(b, true);
      return { result: await testProvider(b.draft ? { draft: p, model: b.model ? String(b.model) : '' } : { id: p.id, model: b.model ? String(b.model) : '' }) };
    });
  });

  router.on('POST', '/api/claude/providers/detect', async (req, res) => {
    if (!guard(req, res)) return;
    const b = await body(req, res); if (!b) return;
    run(res, async () => ({ detect: await detectProtocol(draftOf(b, true)) }));
  });

  router.on('POST', '/api/claude/providers/probe-model', async (req, res) => {
    if (!guard(req, res)) return;
    const b = await body(req, res); if (!b) return;
    run(res, async () => {
      const p = draftOf(b, false);
      if (!b.model || typeof b.model !== 'object') throw Object.assign(new Error('缺要探测的模型'), { status: 400 });
      // 模型同样过一遍规范化（档位表、写入字段的校验同保存）
      const [model] = normalizeProvider({ ...p, models: [b.model] }).models;
      return { probe: await probeModel(p, model) };
    });
  });

  router.on('GET', '/api/claude/providers/log', async (req, res, url) => {
    if (!guard(req, res)) return;
    run(res, () => ({ log: providerLog(String(url.searchParams.get('id') || '')) }));
  });
}
