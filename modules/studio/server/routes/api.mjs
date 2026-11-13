// Media Studio 的接口（方案 §3，硬契约）。全部要登录、按身份隔离（主机 owner 'admin'、成员 'u:<账号>'，同 Claude 自定义 API 的 customOwner）。
// 写操作全走 POST（离线 apk 跨源，CORS 只放 GET / POST）。
//
// 服务  GET  /api/studio/providers                    → { ok, providers, presets, rev, dialects, discoverable, authStyles, member, canShare, maxProviders?, shared?, vertexImport? }
//                                                       provider 另带 autoSync（可写）与只读 sync: { at, ok, error?, added, gone } | null（能发现的方言才有）
//       POST /api/studio/providers/create  {…}        → { ok, provider }
//       POST /api/studio/providers/update  {id, patch}→ { ok, provider }
//       POST /api/studio/providers/delete  {id}       → { ok }
//       POST /api/studio/providers/test    {id|draft, model?} → { ok, result: { ok, ms, status?, error?, detail? } }（不花钱）
//       POST /api/studio/providers/models  {id|draft} → { ok, models: [{ id, label, kind|null }] }
//       POST /api/studio/providers/import-vertex       → { ok, items, importedAt }（管理员）
//       GET  /api/studio/providers/log?id=             → { ok, log: [{ at, kind, model, status, ms, error?, test? }] }
//       POST /api/studio/providers/sync   { id? }      → { ok, results: { <服务 id>: sync }, providers }（立即检查：不给 id = 自己的全部服务）
//       变更推总线 { type:'studio.providers', providers, rev, shared? }
//       模型中心托管的服务（方案 §3.8）：provider 另带只读 managed / hubRef；update / delete / 指名 sync 回 400「由模型中心管理」，
//       不给 id 的 sync 跳过它们；create / update 收到的 managedBy / hubRef 一律丢掉（只有 hub-bridge.mjs 能写）
// 目录  GET  /api/studio/catalog                       → { ok, kinds, rev }（group.shelf = 备选模型的轻条目；上次巡检超过 6 小时的后台补一次）
//       GET  /api/studio/models/resolve?key=           → { ok, model: ResolvedModel }（备选模型的完整条目，按需取 schema）
//       GET  /api/studio/voices?key=<服务>/<模型>       → { ok, voices: [{ id, label, note? }] }
// 任务  POST /api/studio/jobs  { kind, key, prompt, negative?, params, inputs, thread?, parent? } → { ok, job }
//       GET  /api/studio/jobs?active=1                 → { ok, jobs, active? }
//       GET  /api/studio/jobs/<id>                     → { ok, job }
//       POST /api/studio/jobs/<id>/cancel              → { ok, job }
// 作品  GET  /api/studio/assets?kind=&cursor=&q=&thread= → { ok, items, cursor }
//       GET  /api/studio/assets/<id>                   → { ok, asset }
//       POST /api/studio/assets/<id>/save  { dir?, name? } → { ok, wsPath, asset }
//       POST /api/studio/assets/<id>/delete { withFile? }  → { ok }；推总线 { type:'studio.asset.deleted', id }
// 设置  GET  /api/studio/settings → { ok, host?: { values, changed }, mine: { values, changed }, effective, canEditHost }
//       POST /api/studio/settings { scope: 'host'|'mine', values: { 键: 值|null } } → 同 GET；变更推 { type:'studio.settings' }

import { readBody } from '@bridge/core/runtime/body.mjs';
import { contextFor } from '@bridge/core/runtime/identity.mjs';
import { busPublish } from '@bridge/core/runtime/bus.mjs';
import { FEATURES } from '@bridge/core/config/index.mjs';
import { assertPublicUrl, publicDispatcher } from '@bridge/core/runtime/public-net.mjs';
import {
  studioHostSnapshot, setStudioHostSettings, studioMineSnapshot, setStudioMineSettings, effectiveStudioSettings, onStudioSettingsChange,
} from '@bridge/core/runtime/studio-settings.mjs';
import {
  studioOwner, isMemberOwner, listProviders, createProvider, updateProvider, deleteProvider, getProvider, normalizeProvider, normalizeBaseUrl,
  providerSecret, sharedProvidersView, findProvider, loadedOwners, providersRev, onProvidersChange, HOST_OWNER, MEMBER_MAX_PROVIDERS, parseServiceAccount,
  DISCOVERABLE, isManaged,
} from '../providers.mjs';
import { presetsView, DIALECT_KINDS, AUTH_STYLES, DIALECT_AUTH, NO_BASEURL } from '../presets.mjs';
import { adapterFor } from '../adapters/index.mjs';
import { dialectBuiltinModels } from '../cards/dialects.mjs';
import { catalog, resolveKey, resolvedModel } from '../catalog.mjs';
import { syncProvider, syncOwner, maybeSyncStale, ensureSchema, discoverable } from '../discovery/index.mjs';
import { syncView } from '../discovery/store.mjs';
import { startJob, listJobs, getJob, cancelJob, forgetResult } from '../jobs.mjs';
import { listAssets, saveAsset, deleteAsset, getAsset, assetExists } from '../assets.mjs';
import { providerLog, logCall, dropLog } from '../log.mjs';
import { importVertex, importAvailable, lastImport } from '../migrate.mjs';

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
const ID_RE = /^[0-9a-f-]{36}$/;
// 托管服务（方案 §3.8）的连接、Key、模型清单都归模型中心：在 Studio 这边改了，下次模型中心同步又会被盖掉
const MANAGED_MSG = '这个服务由模型中心管理，请到 设置 › 模型中心 里改';
const managedError = () => Object.assign(new Error(MANAGED_MSG), { status: 400 });
// 托管标记只有桥接对象（hub-bridge.mjs）能写：前端 / 外部请求带来的一律丢掉
const withoutHubFields = (o) => { if (!o || typeof o !== 'object' || Array.isArray(o)) return {}; const { managedBy, hubRef, ...rest } = o; return rest; };

export function registerStudioApi(router, { identify }) {
  // 身份 → { ctx, owner }；没登录 401，快照 / 分享 / 没开 Studio 的成员 403
  const guard = (req, res) => {
    const who = identify(req);
    if (!who || who.kind === 'none' || who.kind === 'share') { json(res, 401, { error: 'unauthorized' }); return null; }
    const ctx = contextFor(who);
    const owner = studioOwner(ctx);
    if (!owner) { json(res, 403, { error: 'Media Studio 没对你开放（管理员没开，或没给你勾）' }); return null; }
    return { ctx, owner };
  };
  const body = async (req, res, max = 512 * 1024) => {
    try { return JSON.parse((await readBody(req, max)) || '{}') || {}; } catch { json(res, 400, { error: 'bad json' }); return null; }
  };
  const run = async (res, fn) => {
    try { json(res, 200, { ok: true, ...(await fn()) }); }
    catch (e) { json(res, e?.status || 500, { error: e?.message || String(e), ...(e?.title ? { title: e.title } : {}) }); }
  };

  // —— 总线 ——
  const snapshot = (owner) => ({ providers: listProviders(owner), rev: providersRev(owner), ...(isMemberOwner(owner) ? { shared: sharedProvidersView(owner) } : {}) });
  const publishOne = (owner) => busPublish(owner, { type: 'studio.providers', ...snapshot(owner) });
  // 管理员的改动可能动到共享给成员的服务：读过注册表的成员一起推
  onProvidersChange((owner) => {
    publishOne(owner);
    if (owner === HOST_OWNER) for (const o of loadedOwners()) if (isMemberOwner(o)) publishOne(o);
  });
  onStudioSettingsChange(({ scope, owner }) => {
    busPublish(owner, { type: 'studio.settings', scope });
    if (scope === 'host') for (const o of loadedOwners()) if (isMemberOwner(o)) busPublish(o, { type: 'studio.settings', scope });
  });

  // —— 服务 ——
  // 成员的接口地址只许是公网（草稿、保存、测试、拉列表都先查；生成时再查）
  const checkUrl = async (owner, dialect, url) => { if (isMemberOwner(owner) && url && !NO_BASEURL.has(dialect)) await assertPublicUrl(normalizeBaseUrl(url)); };
  // 已存的服务按存档；编辑中的草稿先规范化（带上 id 用已存的 Key、临时 apiKey / serviceAccount 覆盖）
  const draftOf = async (owner, b) => {
    const saved = b.id ? getProvider(String(b.id), owner) : null;
    if (!b.draft || typeof b.draft !== 'object') {
      if (!saved) throw Object.assign(new Error('没有这个媒体服务'), { status: 404 });
      return { provider: saved, secret: providerSecret(saved) };
    }
    const d = normalizeProvider({ ...(saved || {}), ...b.draft, models: [] }, saved);
    await checkUrl(owner, d.dialect, d.baseUrl);
    const base = saved ? providerSecret(saved) : { key: '', sa: '' };
    if (typeof b.draft.serviceAccount === 'string' && b.draft.serviceAccount.trim()) parseServiceAccount(b.draft.serviceAccount);
    return {
      provider: { ...d, id: saved ? saved.id : 'p-draft000', owner },
      secret: { key: typeof b.draft.apiKey === 'string' && b.draft.apiKey.trim() ? b.draft.apiKey.trim() : base.key, sa: typeof b.draft.serviceAccount === 'string' && b.draft.serviceAccount.trim() ? b.draft.serviceAccount.trim() : base.sa },
    };
  };
  const actx = (owner, secret) => ({ secret, dispatcher: isMemberOwner(owner) ? publicDispatcher() : undefined, signal: AbortSignal.timeout(45_000) });

  router.on('GET', '/api/studio/providers', async (req, res) => {
    const g = guard(req, res); if (!g) return;
    const member = isMemberOwner(g.owner);
    run(res, async () => ({
      ...snapshot(g.owner), presets: presetsView(member), dialects: DIALECT_KINDS, discoverable: DISCOVERABLE, authStyles: AUTH_STYLES, dialectAuth: DIALECT_AUTH, member,
      canShare: g.owner === HOST_OWNER && FEATURES.multiUser === true,
      ...(member ? { maxProviders: MEMBER_MAX_PROVIDERS } : { vertexImport: { available: await importAvailable(), last: lastImport() } }),
    }));
  });

  router.on('POST', '/api/studio/providers/create', async (req, res) => {
    const g = guard(req, res); if (!g) return;
    const b = await body(req, res); if (!b) return;
    run(res, async () => { await checkUrl(g.owner, b.dialect, b.baseUrl); return { provider: createProvider(withoutHubFields(b), g.owner) }; });
  });

  router.on('POST', '/api/studio/providers/update', async (req, res) => {
    const g = guard(req, res); if (!g) return;
    const b = await body(req, res); if (!b) return;
    run(res, async () => {
      const cur = getProvider(String(b.id || ''), g.owner);
      if (isManaged(cur)) throw managedError();
      await checkUrl(g.owner, b.patch?.dialect || cur?.dialect, b.patch && b.patch.baseUrl);
      return { provider: updateProvider(String(b.id || ''), withoutHubFields(b.patch), g.owner) };
    });
  });

  router.on('POST', '/api/studio/providers/delete', async (req, res) => {
    const g = guard(req, res); if (!g) return;
    const b = await body(req, res); if (!b) return;
    run(res, () => {
      const id = String(b.id || '');
      if (isManaged(getProvider(id, g.owner))) throw managedError();
      deleteProvider(id, g.owner); dropLog(g.owner, id); return {};
    });
  });

  router.on('POST', '/api/studio/providers/test', async (req, res) => {
    const g = guard(req, res); if (!g) return;
    const b = await body(req, res); if (!b) return;
    run(res, async () => {
      const { provider, secret } = await draftOf(g.owner, b);
      const t0 = Date.now();
      let result;
      try {
        const r = await adapterFor(provider.dialect).test(provider, { ...actx(g.owner, secret), model: b.model ? String(b.model) : '' });
        result = { ok: true, ms: Date.now() - t0, ...(r && r.detail ? { detail: r.detail } : {}) };
      } catch (e) {
        result = { ok: false, ms: Date.now() - t0, ...(e && e.status ? { status: e.status } : {}), error: (e && e.message) || String(e), ...(e && e.detail ? { detail: String(e.detail).slice(0, 400) } : {}) };
      }
      if (!b.draft && provider.id) logCall(provider, { kind: 'test', model: b.model || '', status: result.ok ? 'ok' : 'error', ms: result.ms, test: true, ...(result.error ? { error: result.error } : {}) });
      return { result };
    });
  });

  router.on('POST', '/api/studio/providers/models', async (req, res) => {
    const g = guard(req, res); if (!g) return;
    const b = await body(req, res); if (!b) return;
    run(res, async () => {
      const { provider, secret } = await draftOf(g.owner, b);
      const remote = await adapterFor(provider.dialect).listModels(provider, actx(g.owner, secret));
      // 方言自带的常见模型（有模型卡）排在前面、去重
      const seen = new Set();
      const models = [...dialectBuiltinModels(provider.dialect), ...remote]
        .filter((m) => m && m.id && !seen.has(m.id) && seen.add(m.id))
        .map((m) => ({ id: m.id, label: m.label || m.id, kind: m.kind || null, ...(m.card ? { card: m.card } : {}) }));
      return { models };
    });
  });

  router.on('POST', '/api/studio/providers/import-vertex', async (req, res) => {
    const g = guard(req, res); if (!g) return;
    if (g.owner !== HOST_OWNER) return json(res, 403, { error: '只有主机管理员能导入 Vertex' });
    run(res, () => importVertex());
  });

  router.on('GET', '/api/studio/providers/log', async (req, res, url) => {
    const g = guard(req, res); if (!g) return;
    const id = String(url.searchParams.get('id') || '');
    run(res, () => {
      if (!getProvider(id, g.owner)) throw Object.assign(new Error('没有这个媒体服务'), { status: 404 });
      return { log: providerLog(g.owner, id) };
    });
  });

  // 立即检查（设置页）：给 id 只查这一个（不看 autoSync），不给 = 自己的全部能发现的服务（托管的不算：清单归模型中心）
  router.on('POST', '/api/studio/providers/sync', async (req, res) => {
    const g = guard(req, res); if (!g) return;
    const b = await body(req, res, 4096); if (!b) return;
    run(res, async () => {
      let results = {};
      if (b.id) {
        const p = getProvider(String(b.id), g.owner);
        if (!p) throw Object.assign(new Error('没有这个媒体服务'), { status: 404 });
        if (isManaged(p)) throw managedError();
        if (!discoverable(p)) throw Object.assign(new Error('这种服务没有模型列表接口，不能自动发现'), { status: 400 });
        await syncProvider(g.owner, p.id, { reason: 'manual' });
        results[p.id] = syncView(g.owner, p.id);
      } else {
        const r = await syncOwner(g.owner, { force: true, includeManaged: false });
        results = Object.fromEntries(Object.keys(r).map((id) => [id, syncView(g.owner, id)]));
      }
      return { results, providers: listProviders(g.owner) };
    });
  });

  // —— 目录 ——
  router.on('GET', '/api/studio/catalog', async (req, res) => {
    const g = guard(req, res); if (!g) return;
    try { maybeSyncStale(g.owner); } catch {}   // 后台补巡检（不等、同服务去重；成员只补自己的服务）
    run(res, () => catalog(g.owner));
  });

  // 备选模型的完整条目（选择器里选中 / 搜到时取）；Replicate / fal 没缓存 schema 的现取一次
  router.on('GET', '/api/studio/models/resolve', async (req, res, url) => {
    const g = guard(req, res); if (!g) return;
    run(res, async () => {
      const hit = resolveKey(String(url.searchParams.get('key') || ''), g.owner);
      if (!hit) throw Object.assign(new Error('找不到这个模型（服务被停用 / 删除，或模型关掉了）'), { status: 404 });
      try { await ensureSchema(g.owner, hit.provider, hit.entry); } catch {}
      return { model: resolvedModel(hit.provider, hit.entry, g.owner) };
    });
  });

  router.on('GET', '/api/studio/voices', async (req, res, url) => {
    const g = guard(req, res); if (!g) return;
    run(res, async () => {
      const hit = resolveKey(String(url.searchParams.get('key') || ''), g.owner, 'speech');
      if (!hit) throw Object.assign(new Error('找不到这个配音模型'), { status: 404 });
      const a = adapterFor(hit.provider.dialect);
      if (typeof a.voices === 'function') {
        const voices = await a.voices(hit.provider, { ...actx(hit.provider.owner, providerSecret(hit.provider)) }, hit.entry.id);
        if (Array.isArray(voices) && voices.length) return { voices };
      }
      const spec = (hit.card.params || []).find((s) => s.type === 'voice' && Array.isArray(s.options));
      return { voices: spec ? spec.options.map((o) => ({ id: o.value, label: o.label, ...(o.note ? { note: o.note } : {}) })) : [] };
    });
  });

  // —— 任务 ——
  router.on('POST', '/api/studio/jobs', async (req, res) => {
    const g = guard(req, res); if (!g) return;
    const b = await body(req, res, 256 * 1024); if (!b) return;
    run(res, () => ({ job: startJob(g.ctx, b, { source: 'studio' }).job }));
  });
  router.on('GET', '/api/studio/jobs', async (req, res, url) => {
    const g = guard(req, res); if (!g) return;
    run(res, () => listJobs(g.owner, { active: url.searchParams.get('active') === '1', exists: (id) => assetExists(g.ctx, id) }));
  });
  router.prefix('GET', '/api/studio/jobs/', async (req, res, url) => {
    const g = guard(req, res); if (!g) return;
    const id = url.pathname.slice('/api/studio/jobs/'.length);
    if (!ID_RE.test(id)) return json(res, 404, { error: 'not found' });
    const job = getJob(g.owner, id);
    if (!job) return json(res, 404, { error: '没有这个任务' });
    json(res, 200, { ok: true, job });
  });
  router.prefix('POST', '/api/studio/jobs/', async (req, res, url) => {
    const g = guard(req, res); if (!g) return;
    const m = /^\/api\/studio\/jobs\/([0-9a-f-]{36})\/cancel$/.exec(url.pathname);
    if (!m) return json(res, 404, { error: 'not found' });
    const job = cancelJob(g.owner, m[1]);
    if (!job) return json(res, 404, { error: '没有这个任务' });
    json(res, 200, { ok: true, job });
  });

  // —— 作品 ——
  router.on('GET', '/api/studio/assets', async (req, res, url) => {
    const g = guard(req, res); if (!g) return;
    const q = (k) => url.searchParams.get(k) || undefined;
    run(res, () => listAssets(g.ctx.media, { kind: q('kind'), cursor: q('cursor'), q: q('q'), thread: q('thread'), limit: q('limit') }));
  });
  router.prefix('GET', '/api/studio/assets/', async (req, res, url) => {
    const g = guard(req, res); if (!g) return;
    const id = url.pathname.slice('/api/studio/assets/'.length);
    const asset = ID_RE.test(id) ? getAsset(g.ctx, id) : null;
    if (!asset) return json(res, 404, { error: '没有这个作品' });
    json(res, 200, { ok: true, asset });
  });
  router.prefix('POST', '/api/studio/assets/', async (req, res, url) => {
    const g = guard(req, res); if (!g) return;
    const m = /^\/api\/studio\/assets\/([0-9a-f-]{36})\/(save|delete)$/.exec(url.pathname);
    if (!m) return json(res, 404, { error: 'not found' });
    const b = await body(req, res, 16 * 1024); if (!b) return;
    run(res, () => {
      if (m[2] === 'save') return saveAsset(g.ctx, m[1], { dir: typeof b.dir === 'string' ? b.dir : undefined, name: typeof b.name === 'string' ? b.name : undefined }, effectiveStudioSettings(g.owner));
      if (!deleteAsset(g.ctx, m[1], { withFile: b.withFile === true })) throw Object.assign(new Error('没有这个作品'), { status: 404 });
      forgetResult(g.owner, m[1]);
      busPublish(g.owner, { type: 'studio.asset.deleted', id: m[1] });   // 同一个人开着的其它设备也拿掉它
      return {};
    });
  });

  // —— 设置 ——
  const settingsView = (owner) => ({
    ...(owner === HOST_OWNER ? { host: studioHostSnapshot() } : {}),
    mine: studioMineSnapshot(owner), effective: effectiveStudioSettings(owner), canEditHost: owner === HOST_OWNER,
  });
  router.on('GET', '/api/studio/settings', async (req, res) => {
    const g = guard(req, res); if (!g) return;
    run(res, () => settingsView(g.owner));
  });
  router.on('POST', '/api/studio/settings', async (req, res) => {
    const g = guard(req, res); if (!g) return;
    const b = await body(req, res, 32 * 1024); if (!b) return;
    const scope = b.scope === 'host' ? 'host' : 'mine';
    if (scope === 'host' && g.owner !== HOST_OWNER) return json(res, 403, { error: '主机级设置只有管理员能改' });
    // 默认模型：服务要真的存在（主机级 = 主机的服务；个人 = 自己的 + 管理员共享的），模型要在这个服务里、种类对得上。
    // 存进去后服务被删 / 停用的，目录照常回落到别的默认（catalog defaultFor），这里只挡写入时就不存在的
    const d = b.values && typeof b.values === 'object' ? b.values.defaults : null;
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      for (const [kind, x] of Object.entries(d)) {
        if (!x || typeof x !== 'object') continue;
        const p = findProvider(String(x.provider || ''), scope === 'host' ? HOST_OWNER : g.owner);
        if (!p) return json(res, 400, { error: `默认模型里的服务不存在：${String(x.provider || '').slice(0, 40)}` });
        if (!p.models.some((m) => m.id === x.model && m.kind === kind)) return json(res, 400, { error: `服务「${p.name}」里没有这个${{ image: '图像', video: '视频', speech: '配音', music: '音乐' }[kind] || ''}模型：${String(x.model || '').slice(0, 80)}` });
      }
    }
    const r = scope === 'host' ? setStudioHostSettings(b.values) : setStudioMineSettings(g.owner, b.values);
    if (!r.ok) return json(res, 400, { error: r.error });
    json(res, 200, { ok: true, ...settingsView(g.owner) });
  });
}
