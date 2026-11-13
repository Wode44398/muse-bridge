// 模型中心的总览：把散在各处的模型来源摆到一张表上（只读视图，不带任何 Key）。
//   · 共用（模型中心自己的：Vertex + API 池服务）   registry.mjs
//   · 只在 Claude 的自定义服务                       claude-providers.mjs
//   · 只在 dimensio 的自定义服务                     dimensio 扩展读它的 providers.json（经 setDimensioProvidersReader 注入）
//   · 插件提供的                                     model-services.mjs
//   · Media Studio 的服务（v2）                      studio 扩展的 hub 桥（studio-link.mjs）；没装 / 没加载 = null
// Claude 订阅号池的账号与用量由前端直接打 /api/admin/claude-accounts(+/usage)。
import { listProviders, HOST_OWNER } from '../claude-providers.mjs';
import { modelServices } from '../model-services.mjs';
import { listHubServices, vertexView, hubFlag, migratedOf, HUB_PLUGIN } from './registry.mjs';
import { studioList, studioBuiltins, fromStudioKind } from './studio-link.mjs';

let dimensioReader = null;
/** dimensio 扩展启动时注入：() => [{ id, name, protocol, host, models: 数量, shared }]。 */
export function setDimensioProvidersReader(fn) { dimensioReader = fn; }

let dimensioExporter = null;
/**
 * dimensio 扩展启动时注入：(id) => { name, protocol, baseUrl, authStyle, headers, models: [{ id, label, contextWindow, maxOutput, vision }],
 * defaultModel, key } | null —— 把管理员实例里一个自定义服务连 Key 一起读出来，供「改为共用」照抄（只在服务端内部流转，不下发）。
 */
export function setDimensioProviderExporter(fn) { dimensioExporter = fn; }
export function exportDimensioProvider(id) { return dimensioExporter ? dimensioExporter(id) : null; }

const host = (u) => { try { return new URL(u).host; } catch { return ''; } };
const count = (v) => (Number.isFinite(v) && v > 0 ? Math.round(v) : 0);

// Studio 里这几种方言要么用 Google 云凭据（vertex）、要么根本没有地址和 Key（local），抄不成模型中心的「地址 + Key」服务
const NOT_ADOPTABLE = new Set(['vertex', 'local']);
/** 桥给的一条 → StudioView（契约 §5.4）。种类换成模型中心的叫法（speech → voice）；不带 Key（桥本来也只给 keyTail，这里连它也不往外给）。 */
function studioView(p) {
  const kinds = { image: 0, video: 0, voice: 0, music: 0 };
  for (const [k, n] of Object.entries(p?.kinds || {})) { const hk = fromStudioKind(k); if (hk in kinds) kinds[hk] += count(n); }
  const managed = p?.managed === true;
  return {
    id: String(p?.id || ''), name: String(p?.name || ''), dialect: String(p?.dialect || ''), preset: String(p?.preset || ''),
    host: p?.host || host(p?.baseUrl), enabled: p?.enabled !== false, shared: p?.shared === true, hasKey: p?.hasKey === true,
    managed, hubRef: managed ? String(p?.hubRef || '') : '',
    kinds, models: count(p?.models),
    adoptable: !managed && !NOT_ADOPTABLE.has(p?.dialect) && p?.hasKey === true && !!p?.baseUrl,
    // 内置媒体服务（不是「地址 + Key」）：模型中心的 Vertex 卡 / 本机卡直接管，前端不单列成 Studio 服务
    builtin: !managed && NOT_ADOPTABLE.has(p?.dialect) ? String(p.dialect) : '',
  };
}

function readBuiltins() {
  try {
    const list = studioBuiltins();
    return Array.isArray(list) ? list.map((b) => ({ ...b, models: (b.models || []).map((m) => ({ ...m, kind: fromStudioKind(m.kind) })) })) : null;
  } catch (e) { console.error('[model-hub] Media Studio 的内置服务读不出来：', e?.message || e); return null; }
}

export function hubOverview() {
  let dimensio = null;
  try {
    const list = dimensioReader ? dimensioReader() : null;
    // 自定义服务都是文本模型（媒体模型在 Media Studio）：种类计数只有 text 一项，和 Claude 那栏对齐
    // 已经并进模型中心的（迁移台账里有）不再单列：原件只是留着给老会话用
    const done = migratedOf('dimensio');
    dimensio = Array.isArray(list) ? list.filter((p) => !done[p?.id] && !p?.hubRef).map((p) => ({ ...p, kinds: { text: count(p?.models) } })) : null;
  } catch (e) { console.error('[model-hub] dimensio 服务读不出来：', e?.message || e); }
  // Studio：没有桥 = null；读不出来 = [] + studioErr（不冒充「一个服务都没有」，前端照着提示）
  let studio = null, studioErr = '';
  try {
    const list = studioList();
    if (list !== null) {
      if (!Array.isArray(list)) throw new Error('返回的不是列表');
      studio = list.map(studioView);
    }
  } catch (e) {
    console.error('[model-hub] Media Studio 的服务读不出来：', e?.message || e);
    studio = []; studioErr = '读不出 Media Studio 的服务列表，详情见服务器日志';
  }
  const doneClaude = migratedOf('claude');
  return {
    v: 2,
    // dimensio 自带适配的厂商已经交给模型中心（它们是普通的模型中心服务了）：前端不再单列「dimensio 内置厂商」
    dimensioNative: hubFlag('dimensioNative'),
    vertex: vertexView(),
    services: listHubServices(),
    // 已经并进模型中心的 Claude 服务不再单列（原服务藏在菜单外、老会话照常能跑）
    claude: listProviders(HOST_OWNER).filter((p) => !doneClaude[p.id]).map((p) => {
      const n = p.models.filter((m) => m.enabled && m.kind !== 'other').length;
      return {
        id: p.id, name: p.name, note: p.note || '', preset: p.preset || '', protocol: p.protocol, host: host(p.baseUrl), enabled: p.enabled !== false,
        shown: p.showInPicker !== false, shared: p.shared === true, hasKey: p.hasKey || p.authStyle === 'none', models: n, kinds: { text: n },
      };
    }),
    dimensio,   // null = 这台服务器没开 dimensio
    studio,     // null = 这台服务器没开 Media Studio；managed 的属于对应的模型中心服务（前端不单列）
    builtins: readBuiltins(),   // Studio 的内置媒体服务（Vertex / 本机）明细：模型中心的 Vertex 卡、本机卡直接改它们；null = 没开 Studio
    ...(studioErr ? { studioErr } : {}),
    plugins: modelServices().filter((s) => s.plugin !== HUB_PLUGIN).map((s) => ({
      id: s.key, name: s.name, plugin: s.pluginName, protocol: s.protocol, agents: s.agents, models: s.models.length,
    })),
  };
}
