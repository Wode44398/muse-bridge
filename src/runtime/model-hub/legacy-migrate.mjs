// 老配置统一并进模型中心（2026-11-13）。维护者：「彻底把所有的配置都统一成一种，不再保留不同的配置方式；
// 老版本的 bridge 在更新服务端之后能自动把老的配置方式整合进新的」。
//
// 以前能配模型服务的地方有四处：设置 › Claude 的自定义服务（claude-providers）、dimensio 自建的服务（harness 的 providers.json）、
// Media Studio 的媒体服务（studio-providers）、模型中心。这里在服务端启动时把前三处管理员的那些并进模型中心，只做一次（迁移台账
// services.json 的 migrated 记着谁并到了哪），之后模型中心就是唯一的配置入口：
//   · Claude：照抄成模型中心服务（一条线路「原 Key」，型号两边能给的都给）；模型中心里已经有同一个服务（同地址、同协议、同一把 Key、
//     共享给成员一致）就把型号并进那一个。原服务从模型菜单里藏起来、不停用不删——会话里记着的 custom:<原 id>:<型号> 照常能跑。
//   · Media Studio：「地址 + Key」的服务原地收编（Studio 服务 id 不变，任务与作品历史照常引用）；同一个服务已经在模型中心里、
//     还没托管媒体的，并进那一个。Vertex（Google 云凭据）与本机图像模型不是「地址 + Key」，不搬：模型中心的 Vertex 卡、本机卡直接管它们。
//   · dimensio 的在 dimensio 扩展里迁（modules/dimensio/server/runtime/legacy-migrate.mjs，它读得到 harness 的文件）。
// 成员自己的服务不动：模型中心只对服务器管理员开放，成员没有它，照旧用自己那套。
// 某一个没并成（Key 存储解不开、到了服务数上限……）只跳过它：记日志、不记台账，下次启动再试；总览里它还在，点它走手动收编。
import { getProvider, listProviders, providerKey, updateProvider, HOST_OWNER } from '../claude-providers.mjs';
import {
  createHubService, absorbTextModels, findTwinService, adoptStudioService, updateHubV2, listHubServices, migratedOf, markMigrated, backupHubFile,
} from './registry.mjs';
import { studioList } from './studio-link.mjs';

const fail = (msg, status = 400) => Object.assign(new Error(msg), { status });

// 收编来的服务模型太多（一个服务的文本模型上限 100）：默认型号和排在前面的先加上，其余放进目录——之后在模型列表里勾一下就能加。
const TEXT_CAP = 100;
export function capModels(models, defaultModel) {
  if (models.length <= TEXT_CAP) return { models, rest: [], warnings: [] };
  const sorted = [...models].sort((a, b) => Number(b.id === defaultModel) - Number(a.id === defaultModel));
  return {
    models: sorted.slice(0, TEXT_CAP), rest: sorted.slice(TEXT_CAP),
    warnings: [`这个服务有 ${models.length} 个模型，先添加了前 ${TEXT_CAP} 个；其余的在模型列表里，勾上就能加`],
  };
}

// 名字和模型中心里已有的撞了：后面标一下来路，列表里分得清
function freeName(name, tag) {
  const taken = new Set(listHubServices().map((s) => s.name));
  if (!taken.has(name)) return name;
  const n = `${name} · ${tag}`.slice(0, 40);
  return taken.has(n) ? `${name.slice(0, 30)} · ${tag} ${Math.random().toString(16).slice(2, 5)}` : n;
}

/**
 * 把一个文本服务（Claude / dimensio 的老服务）并进模型中心 → { service, warnings, merged }。
 * src = { name, protocol, baseUrl, authStyle, headers, useProxy?, timeoutSec?, models, parked, defaultModel, key, members }。
 * auto：自动迁移（一个启用的型号都没有也照建；名字撞了加来路标）；手动收编时没型号照旧报错。
 */
export function adoptTextService(src, { auto = false, tag = '' } = {}) {
  const members = src.members === true;
  const twin = findTwinService({ baseUrl: src.baseUrl, key: src.key || '', kind: src.protocol, members, enabled: true, samePath: true });
  if (twin) {
    try {
      const r = absorbTextModels(twin, src.models, { parked: src.parked, defaultModel: src.defaultModel });
      return { service: r.service, warnings: [], merged: true };
    } catch (e) {
      // 并不进去（文本模型超上限之类）：另建一个
      console.error(`[model-hub] 「${src.name}」并不进已有的服务，改为另建：`, e?.message || e);
    }
  }
  if (!src.models.length && !auto) throw fail('这个服务里没有启用的对话模型');
  const cap = capModels(src.models, src.defaultModel);
  const service = createHubService({
    name: auto && tag ? freeName(src.name, tag) : src.name, kind: src.protocol, baseUrl: src.baseUrl, authStyle: src.authStyle, headers: src.headers,
    ...(typeof src.useProxy === 'boolean' ? { useProxy: src.useProxy } : {}), ...(src.timeoutSec ? { timeoutSec: src.timeoutSec } : {}),
    models: cap.models, defaultModel: src.defaultModel, lines: [{ label: '原 Key', key: src.key || '' }], members,
  }, { catalogExtra: [...cap.rest, ...(src.parked || [])], allowEmpty: auto });
  return { service, warnings: cap.warnings, merged: false };
}

/** Claude 的一个自定义服务（管理员的）读成 adoptTextService 的形状；没有回 null。 */
function claudeSource(id) {
  const p = getProvider(id, HOST_OWNER);
  if (!p) return null;
  const pick = (m) => ({ id: m.id, label: m.label, contextWindow: m.contextWindow, maxOutput: m.maxOutput, vision: m.vision });
  return {
    p,
    src: {
      name: p.name, protocol: p.protocol, baseUrl: p.baseUrl, authStyle: p.authStyle, headers: p.headers,
      useProxy: p.compat?.useProxy !== false, timeoutSec: p.timeoutSec, defaultModel: p.defaultModel,
      models: p.models.filter((m) => m.enabled && m.kind !== 'other').map((m) => ({ ...pick(m), kind: 'text' })),
      // 停用着的型号不算已添加，但放进目录：搬过来以后想用，勾一下就行
      parked: p.models.filter((m) => !m.enabled && m.kind !== 'other').map(pick),
      key: providerKey(p.id, HOST_OWNER) || '', members: p.shared === true,
    },
  };
}

/** 收编 Claude 的一个自定义服务（手动 POST /adopt 与自动迁移共用）→ { service, warnings, merged }。原服务从模型菜单里藏起来。 */
export function adoptClaudeProvider(id, { auto = false } = {}) {
  const got = claudeSource(id);
  if (!got) throw fail('没有这个模型服务', 404);
  const r = adoptTextService(got.src, { auto, tag: 'Claude' });
  updateProvider(got.p.id, { showInPicker: false }, HOST_OWNER);
  markMigrated('claude', got.p.id, r.service.id);
  return r;
}

const NOT_ADOPTABLE = new Set(['vertex', 'local']);
const tailOf = (t) => String(t || '').replace(/^…/, '');

/** 收编 Studio 的一个「地址 + Key」服务（手动与自动共用）→ { service, warnings, merged }。能并进已有服务就并，否则原地收编成新服务。 */
export function adoptStudioProvider(x, { auto = false } = {}) {
  // 候选：同主机、共享给成员与启停一致、还没托管媒体、Key 尾号对得上的模型中心服务（尾号只是粗筛，真比对在 adoptStudioService 里）
  let host = '';
  try { host = new URL(x.baseUrl).host.toLowerCase(); } catch {}
  const cands = host ? listHubServices().filter((s) => String(s.host || '').toLowerCase() === host
    && (s.members === true) === (x.shared === true) && (s.enabled !== false) === (x.enabled !== false)
    && !s.media?.providerId && !Object.entries(s.counts || {}).some(([k, n]) => k !== 'text' && n > 0)
    && s.lines.some((l) => l.enabled !== false && tailOf(l.keyTail) === String(x.keyTail || ''))) : [];
  for (const c of cands) {
    try {
      const r = adoptStudioService(x.id, { into: c.id });
      markMigrated('studio', x.id, r.service.id);
      return { ...r, merged: true };
    } catch (e) {
      if (e?.code !== 'twin') console.error(`[model-hub] 「${x.name}」并不进「${c.name}」：`, e?.message || e);
    }
  }
  const r = adoptStudioService(x.id);
  let service = r.service;
  if (auto) {
    const name = freeName(service.name, '媒体');
    if (name !== service.name) {
      // freeName 把自己也算进去了：只有别的服务占着这个名字才改
      const others = listHubServices().filter((s) => s.id !== service.id && s.name === service.name);
      if (others.length) { try { service = updateHubV2(service.id, { name }).service; } catch {} }
    }
  }
  markMigrated('studio', x.id, service.id);
  return { service, warnings: r.warnings, merged: false };
}

/**
 * 启动时调一次（server.mjs 在 loadModules、reconcileStudio 之后：Studio 的桥那时才有）→ { claude, studio, skipped }。
 * 已经记过台账的跳过；什么都没有要并的不动文件。
 */
export function migrateLegacyConfigs() {
  const out = { claude: [], studio: [], skipped: [] };
  const doneC = migratedOf('claude');
  const claude = listProviders(HOST_OWNER).filter((p) => !doneC[p.id]);
  let studio = [];
  try {
    const doneS = migratedOf('studio');
    studio = (studioList() || []).filter((x) => x && !x.managed && !NOT_ADOPTABLE.has(x.dialect) && x.baseUrl && !doneS[x.id]);
  } catch (e) { console.error('[model-hub] 读不出 Media Studio 的服务，这次不并：', e?.message || e); }
  if (!claude.length && !studio.length) return out;
  backupHubFile('services.pre-unify.bak.json');
  for (const p of claude) {
    try {
      const r = adoptClaudeProvider(p.id, { auto: true });
      out.claude.push(`${p.name} → ${r.service.name}${r.merged ? '（并进已有服务）' : ''}`);
    } catch (e) { out.skipped.push(`Claude「${p.name}」：${e?.message || e}`); }
  }
  for (const x of studio) {
    try {
      const r = adoptStudioProvider(x, { auto: true });
      out.studio.push(`${x.name} → ${r.service.name}${r.merged ? '（并进已有服务）' : ''}`);
    } catch (e) { out.skipped.push(`Media Studio「${x.name}」：${e?.message || e}`); }
  }
  console.log(`[model-hub] 老配置并进模型中心：Claude ${out.claude.length} 个${out.claude.length ? `（${out.claude.join('、')}）` : ''}，`
    + `Media Studio ${out.studio.length} 个${out.studio.length ? `（${out.studio.join('、')}）` : ''}`
    + (out.skipped.length ? `；没并成（下次启动再试）：${out.skipped.join('；')}` : ''));
  return out;
}
