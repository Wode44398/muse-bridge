// 设置 › Claude › 模型服务（自定义 API）的前端数据面。后端：src/routes/claude-providers.mjs。
// 主机管理员与成员各有一份（2026-10-27 起成员自带 Key）：成员的接口地址只许是公网、没有「本机模型」预设（cp.member）。
// 模型选择器读 cp.models（custom:<服务>:<模型>）；总线 {type:'claude.providers'} 推来就整份替换，
// 连上总线时的 hello 也带一份（claudeModels，各人自己的）——刷新后芯片不用等打开模型菜单。
//
// 推理强度（2026-10-21）：自定义模型的档位是它自己的表（设置里按模型配，含「不发」），不再套官方六档。
//   effortsFor(model)      该模型的档位表（官方模型 = caps.claude.efforts）
//   effortChoices(model)   给拉条 / 芯片用：自定义模型没有默认档时最前面多一项「默认」（= 什么都不发）
//   defaultEffortFor(model) 没选时用哪档（自定义模型 '' = 不发）
//   effectiveEffort(model, effort) 请求里该带的档：选的不在这个模型的表里（换模型带过来的）就不带
import { api } from './api.js';
import { busOn } from './bus.js';
import { me } from './state.svelte.js';
import { t } from './i18n.js';

export const cp = $state({
  ok: false,          // 拿到过完整配置（= 当前身份能用自定义 API）：设置入口显不显示看它
  member: false,      // 成员自己的那份（只许公网地址、有个数上限）
  maxProviders: 0,
  canShare: false,    // 多用户服务器上的管理员：编辑器里出「共享给成员」开关
  shared: [],         // 成员：管理员共享给他的服务（只有名字、预设、协议、模型名；只能用，不能改）
  proxyForced: false, // 部署方强制走出站代理：编辑器不摆「走出站代理」开关（服务端保存时也强制，见 runtime/claude-providers.mjs）
  modelsReady: false, // 模型清单到过（hello / 总线 / 拉取任一）：芯片据此区分「还没到」与「已停用」
  providers: [],
  models: [],         // 选择器用的扁平清单（只有启用的对话模型；hidden = 服务关了「显示在模型列表」）
  presets: [],
  err: '',
});
let loading = null;

function adopt(r) {
  if (Array.isArray(r?.providers)) cp.providers = r.providers;
  if (Array.isArray(r?.models)) { cp.models = r.models; cp.modelsReady = true; }
  if (Array.isArray(r?.presets)) cp.presets = r.presets;
  if (typeof r?.member === 'boolean') { cp.member = r.member; cp.maxProviders = r.maxProviders || 0; }
  if (typeof r?.canShare === 'boolean') cp.canShare = r.canShare;   // 只在 GET 里有
  if (Array.isArray(r?.shared)) cp.shared = r.shared;
  if (typeof r?.proxyForced === 'boolean') cp.proxyForced = r.proxyForced;   // 只在 GET 里有；总线推送不带，不动
  cp.ok = true;
}

busOn((ev) => {
  if (!ev) return;
  if (ev.type === 'claude.providers') adopt(ev);
  else if (ev.type === 'hello' && Array.isArray(ev.claudeModels)) { cp.models = ev.claudeModels; cp.modelsReady = true; }
});

const msg = (e) => (e && e.body && (e.body.error || (typeof e.body === 'string' ? e.body : ''))) || (e && e.message) || String(e);

/** 拉一次（不能用的身份 403 → 静默，cp.ok 保持 false，界面不出入口）。 */
export const canUseCustomApi = () => me.kind === 'admin' || me.kind === 'user';
export function loadProviders(force = false) {
  if (loading && !force) return loading;
  loading = api.get('/api/claude/providers')
    .then((r) => { adopt(r); cp.err = ''; })
    .catch((e) => { if (e && (e.status === 403 || e.status === 401)) cp.ok = false; else cp.err = msg(e); })
    .finally(() => { loading = null; });
  return loading;
}
/** 模型清单还没到（老服务端的 hello 不带 / 同源跟随页没拿到 hello）：补拉一次。 */
export function ensureCustomModels() {
  if (cp.modelsReady || loading || !canUseCustomApi()) return;
  loadProviders();
}

async function post(path, body) {
  try { return await api.post(path, body); }
  catch (e) { throw new Error(msg(e)); }
}

export async function createProvider(draft) {
  const r = await post('/api/claude/providers/create', draft);
  await loadProviders(true);
  return r.provider;
}
export async function updateProvider(id, patch) {
  const r = await post('/api/claude/providers/update', { id, patch });
  await loadProviders(true);
  return r.provider;
}
export async function deleteProvider(id) {
  await post('/api/claude/providers/delete', { id });
  await loadProviders(true);
}
/** 拉端点的模型列表（每项附能力猜测）：已存的给 id；编辑中的草稿给 draft（可带 apiKey）。 */
export async function fetchRemoteModels({ id, draft }) {
  const r = await post('/api/claude/providers/models', { id, draft });
  return r.models || [];
}
/** 手动添加的型号：按内置型号表 / 名字猜能力（不联网）。 */
export async function guessModels(ids, protocol) {
  const r = await post('/api/claude/providers/guess', { ids, protocol });
  return r.models || [];
}
/** 测试连接：{ id } 测已存的；{ draft } 测编辑中的（没保存也能测）。 */
export async function testProvider({ id, draft, model }) {
  const r = await post('/api/claude/providers/test', { id, draft, model });
  return r.result;
}
/** 一键识别协议与地址。 */
export async function detectProvider({ id, draft }) {
  const r = await post('/api/claude/providers/detect', { id, draft });
  return r.detect;
}
/** 探测一个模型的能力（真打几次）。 */
export async function probeModel({ id, draft, model }) {
  const r = await post('/api/claude/providers/probe-model', { id, draft, model });
  return r.probe;
}
export async function providerLog(id) {
  const r = await api.get('/api/claude/providers/log?id=' + encodeURIComponent(id));
  return r.log || [];
}

export const isCustomModel = (id) => typeof id === 'string' && id.startsWith('custom:');
export const customModelInfo = (id) => cp.models.find((m) => m.id === id) || null;
/** 能不能开 fast mode：官方模型看 caps 支持表；自定义模型看服务端给的 fast（官方 api.anthropic.com + 支持的 Opus 才有）。 */
export const modelSupportsFast = (id, capsData) => (isCustomModel(id) ? !!customModelInfo(id)?.fast : (capsData?.claude?.fast || []).includes(id));

// —— 推理强度：按模型 ——
/** 该模型的档位表 [{id, name}]。自定义模型取它自己的；官方模型取 capabilities。 */
// Ultracode 不在档位表里：它是拉条面板下面独立的勾选（10-30），自定义模型同样有。
export function effortsFor(modelId, capsData) {
  if (isCustomModel(modelId)) return customModelInfo(modelId)?.efforts || [];
  return capsData?.claude?.efforts || [];
}
/** 没选时用哪档：自定义模型的默认档（'' = 什么都不发，用厂商默认）；官方模型回 null（调用方按 claudeEffortFallback）。 */
export function defaultEffortFor(modelId) {
  if (!isCustomModel(modelId)) return null;
  return customModelInfo(modelId)?.effortDefault || '';
}
/** 拉条 / 芯片的可选项：自定义模型没有默认档时最前面放「默认」（id ''，选它 = 不带档位、什么都不发）。
 *  档位表空的自定义模型也给这一项「默认」：芯片照常显示，面板里还能勾 Ultracode。 */
export function effortChoices(modelId, capsData) {
  const list = effortsFor(modelId, capsData);
  if (isCustomModel(modelId) && customModelInfo(modelId) && !defaultEffortFor(modelId)) return [{ id: '', name: t('默认') }, ...list];
  return list;
}
/** 请求里该带的档位：自定义模型只认它自己表里的（清单还没到时照带，服务端会再校验）；官方模型原样。 */
export function effectiveEffort(modelId, effort) {
  if (!effort) return null;
  if (!isCustomModel(modelId) || !cp.modelsReady) return effort;
  return effortsFor(modelId).some((e) => e.id === effort) ? effort : null;
}

/** 设置入口的摘要：「{p} 个服务 · {m} 个模型（{h} 个已隐藏）」——只数启用服务里启用的对话模型。 */
export function cpSummary() {
  const live = cp.providers.filter((p) => p.enabled);
  const count = (p) => p.models.filter((m) => m.enabled && m.kind !== 'other').length;
  const m = live.reduce((n, p) => n + count(p), 0);
  const h = live.filter((p) => p.showInPicker === false).reduce((n, p) => n + count(p), 0);
  return { p: cp.providers.length, m, h };
}
export function cpSummaryText() {
  const s = cpSummary();
  if (!s.p) return '';
  return t('{p} 个服务 · {m} 个模型', s) + (s.h ? t('（{h} 个已隐藏）', s) : '');
}
