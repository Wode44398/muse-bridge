// 设置 › Claude › 模型服务（自定义 API）的后端。逻辑在 runtime/claude-providers*.mjs。
// 主机管理员与成员各管各的一份（2026-10-27 起成员自带 Key，见 runtime/claude-providers.mjs）：成员的接口地址只许是公网
//（保存、测试、拉列表都先查，代理发请求时再查），没有「本机模型」预设。快照 / 分享访客一律 403。写操作全走 POST（离线 apk 跨源，CORS 只放 GET/POST）。
//   GET  /api/claude/providers                 → { ok, providers, presets, models, proxyForced }（proxyForced：部署方强制走出站代理）
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
// 管理员共享给成员（2026-10-28）：管理员的服务上可标 shared（create / update 收；canShare = 多用户服务器的管理员才显示开关）；
// 成员的 GET 多带 shared（共享服务的名字与模型，不给地址和 Key），模型清单里并进它们（managed）。共享服务改 / 删 / 测试成员都够不着
//（这些接口只认他自己那份）。管理员改了服务，读过注册表的成员也推一份。
// 官方 api.anthropic.com 的服务：启动时与每次保存后在后台探一遍各型号支不支持 fast（ensureFastProbes），结论变了也推一次总线。
import { readBody } from '../runtime/body.mjs';
import { contextFor } from '../runtime/identity.mjs';
import { busPublish } from '../runtime/bus.mjs';
import { listProviders, createProvider, updateProvider, deleteProvider, customModelsView, getProvider, normalizeProvider, normalizeBaseUrl, presetsFor, customOwner, isMemberOwner, loadedOwners, providerProxyForced, sharedProvidersView, HOST_OWNER, MEMBER_MAX_PROVIDERS } from '../runtime/claude-providers.mjs';
import { FEATURES } from '../config/index.mjs';
import { assertPublicUrl } from '../runtime/public-net.mjs';
import { fetchRemoteModels, guessModels, testProvider, detectProtocol, probeModel, providerLog, ensureFastProbes, onFastProbeChange } from '../runtime/claude-providers-proxy.mjs';

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

export function registerClaudeProviderRoutes(router, { identify }) {
  const guard = (req, res) => {
    const who = identify(req);
    if (who.kind === 'none' || who.kind === 'share') { json(res, 401, { error: 'unauthorized' }); return null; }
    const ctx = contextFor(who);
    const owner = customOwner(ctx);
    if (!owner) { json(res, 403, { error: '这个身份不能用自定义 API' }); return null; }
    return owner;
  };
  const body = async (req, res) => {
    try { return JSON.parse(await readBody(req, 512 * 1024)) || {}; } catch { json(res, 400, { error: 'bad json' }); return null; }
  };
  const snapshot = (owner) => ({ providers: listProviders(owner), models: customModelsView(owner), ...(isMemberOwner(owner) ? { shared: sharedProvidersView(owner) } : {}) });
  // 各推各的总线（owner 键就是总线分区）。管理员的改动可能动到共享给成员的服务：读过注册表的成员一起推
  const publishOne = (owner) => busPublish(owner, { type: 'claude.providers', ...snapshot(owner) });
  const publish = (owner) => {
    publishOne(owner);
    if (owner === HOST_OWNER) for (const o of loadedOwners()) if (isMemberOwner(o)) publishOne(o);
  };
  // fast 探测结论按型号记、各家共用：变了就推给所有读过注册表的人，菜单里的开关跟着出现 / 消失
  onFastProbeChange(() => { for (const o of loadedOwners()) publishOne(o); });
  const probeFast = (id, owner) => { const p = id && getProvider(id, owner); if (p) ensureFastProbes(p).catch(() => {}); };
  // 成员的接口地址只许是公网（草稿、保存都查；代理发请求时还会再查）
  const checkUrl = async (owner, url) => { if (isMemberOwner(owner) && url) await assertPublicUrl(normalizeBaseUrl(url)); };
  setTimeout(() => { for (const p of listProviders()) probeFast(p.id); }, 5000).unref?.();
  const run = async (res, fn) => {
    try { json(res, 200, { ok: true, ...(await fn()) }); }
    catch (e) { json(res, e?.status || 500, { error: e?.message || String(e) }); }
  };
  // 已存的服务按存档配置；编辑中的草稿先过一遍规范化（地址、请求头、模型的校验同保存），带上 id（用已存的 Key）与临时 apiKey。
  // withModels=false：只关心连接（拉模型列表），草稿里的模型不校验。
  const draftOf = async (owner, b, withModels) => {
    const saved = b.id ? getProvider(String(b.id), owner) : null;
    if (!b.draft || typeof b.draft !== 'object') {
      if (!saved) throw Object.assign(new Error('没有这个模型服务'), { status: 404 });
      return saved;
    }
    const d = normalizeProvider({ ...(saved || {}), ...b.draft, ...(withModels ? {} : { models: [] }) }, saved);
    await checkUrl(owner, d.baseUrl);
    return { ...d, owner, id: saved ? saved.id : undefined, apiKey: typeof b.draft.apiKey === 'string' ? b.draft.apiKey : undefined };
  };

  router.on('GET', '/api/claude/providers', async (req, res) => {
    const owner = guard(req, res); if (!owner) return;
    run(res, () => ({
      ...snapshot(owner), presets: presetsFor(owner), member: isMemberOwner(owner), proxyForced: providerProxyForced(),
      ...(isMemberOwner(owner) ? { maxProviders: MEMBER_MAX_PROVIDERS } : {}),
      // 编辑器里出「共享给成员」开关：多用户服务器上的管理员
      canShare: owner === HOST_OWNER && FEATURES.multiUser === true,
    }));
  });

  router.on('POST', '/api/claude/providers/create', async (req, res) => {
    const owner = guard(req, res); if (!owner) return;
    const b = await body(req, res); if (!b) return;
    run(res, async () => { await checkUrl(owner, b.baseUrl); const provider = createProvider(b, owner); publish(owner); probeFast(provider.id, owner); return { provider }; });
  });

  router.on('POST', '/api/claude/providers/update', async (req, res) => {
    const owner = guard(req, res); if (!owner) return;
    const b = await body(req, res); if (!b) return;
    run(res, async () => { await checkUrl(owner, b.patch && b.patch.baseUrl); const provider = updateProvider(String(b.id || ''), b.patch || {}, owner); publish(owner); probeFast(provider.id, owner); return { provider }; });
  });

  router.on('POST', '/api/claude/providers/delete', async (req, res) => {
    const owner = guard(req, res); if (!owner) return;
    const b = await body(req, res); if (!b) return;
    run(res, () => { deleteProvider(String(b.id || ''), owner); publish(owner); return {}; });
  });

  router.on('POST', '/api/claude/providers/models', async (req, res) => {
    const owner = guard(req, res); if (!owner) return;
    const b = await body(req, res); if (!b) return;
    run(res, async () => ({ models: await fetchRemoteModels(await draftOf(owner, b, false)) }));
  });

  router.on('POST', '/api/claude/providers/guess', async (req, res) => {
    if (!guard(req, res)) return;
    const b = await body(req, res); if (!b) return;
    run(res, () => ({ models: guessModels(b.ids, b.protocol === 'openai' ? 'openai' : 'anthropic') }));
  });

  router.on('POST', '/api/claude/providers/test', async (req, res) => {
    const owner = guard(req, res); if (!owner) return;
    const b = await body(req, res); if (!b) return;
    run(res, async () => {
      const p = await draftOf(owner, b, true);
      return { result: await testProvider(b.draft ? { draft: p, model: b.model ? String(b.model) : '' } : { id: p.id, owner, model: b.model ? String(b.model) : '' }) };
    });
  });

  router.on('POST', '/api/claude/providers/detect', async (req, res) => {
    const owner = guard(req, res); if (!owner) return;
    const b = await body(req, res); if (!b) return;
    run(res, async () => ({ detect: await detectProtocol(await draftOf(owner, b, true)) }));
  });

  router.on('POST', '/api/claude/providers/probe-model', async (req, res) => {
    const owner = guard(req, res); if (!owner) return;
    const b = await body(req, res); if (!b) return;
    run(res, async () => {
      const p = await draftOf(owner, b, false);
      if (!b.model || typeof b.model !== 'object') throw Object.assign(new Error('缺要探测的模型'), { status: 400 });
      // 模型同样过一遍规范化（档位表、写入字段的校验同保存）
      const [model] = normalizeProvider({ ...p, models: [b.model] }).models;
      return { probe: await probeModel(p, model) };
    });
  });

  router.on('GET', '/api/claude/providers/log', async (req, res, url) => {
    const owner = guard(req, res); if (!owner) return;
    run(res, () => ({ log: providerLog(String(url.searchParams.get('id') || ''), owner) }));
  });
}
