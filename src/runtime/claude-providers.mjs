// Claude 分页「自定义 API」——模型服务注册表（2026-10-21，维护者：给 Claude 接自定义 API，各种调用参数都能调）。
//
// 一个「模型服务」= 一个兼容 Anthropic Messages 或 OpenAI Chat Completions 的端点 + 一组模型 + 默认调用参数。
// Claude Code（SDK 里的 CLI）照常跑，只是模型请求经本机代理（claude-providers-proxy.mjs）转到这个端点：
// 代理逐请求换鉴权、改写参数（输出上限 / 温度 / top_p / top_k / 思考 / 停止序列 / 额外请求体）、
// 做兼容裁剪，OpenAI 协议的再整体翻译。会话里选的模型 id 是 custom:<服务 id>:<模型 id>。
//
// 模型上的能力字段（自动识别见 src/model-knowledge/knowledge.mjs，每个都能在设置里手改）：
//   kind          chat = 对话模型；other = 语音识别 / 合成、向量这类（不进模型菜单、不当默认模型）
//   contextWindow / maxOutput / vision
//   thinking      思考方式：none 不发思考参数 / budget = thinking.budget_tokens / adaptive = thinking.type adaptive
//                 （+ output_config.effort）/ effort = 档位表里每档的值写进 effortField（或整体深合并）
//   efforts       档位表 [{ id, name, value }]（最多 8 档）——输入框里的推理强度就列这些；空表 = 不显示推理强度
//   effortDefault 没选档位时用哪档；'' = 什么都不发（用厂商默认）
//   effortField   effort 方式写哪个字段（点分路径，如 reasoning_effort / output_config.effort / reasoning.effort）；
//                 空 = 按协议默认（OpenAI → reasoning_effort，Anthropic → output_config.effort），档位值是对象时深合并进请求体根
//   alwaysThinks  不发参数也会思考（小米、Kimi、GLM-5.3）：不剥历史思考块，OpenAI 协议回传 reasoning_content
//   source        各能力的来源 { contextWindow, maxOutput, vision, thinking: api | table | probe | guess | default | user }
// 老配置（没有 efforts 的）读进来时按原来的思考方式换算档位（行为不变），能查到型号表的顺手补上真实能力，下次保存落盘。
//
// 服务上的 showInPicker：false = 模型不出现在模型菜单里（正在用它的会话照常能跑；和「启用」是两回事——停用是硬停）。
//
// 存储（数据根下，已 gitignore）：
//   claude-providers/providers.json   配置（不含密钥）：{ rev, providers:[…] }
//   claude-providers/connector-secrets.*  API Key，AES-256-GCM + DPAPI（复用 extension-secrets.mjs）
//
// 按身份分开（2026-10-27，维护者：普通用户自带 Key）：主机管理员一份（上面两个文件），每个成员一份，
// 放在 claude-providers/users/<账号>/ 下（主机数据根里，不在成员自己的工作空间——他的 Claude 读写不到）。
// 成员的服务只许连公网（替他连任意地址 = SSRF，见 public-net.mjs），最多 10 个，没有「本机模型」预设。
// 内存里的服务对象带 owner（owner 键：'admin' / 'u:<账号>'），落盘与给前端时去掉。
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { readJson, writeJson } from '../jsonfile.mjs';
import { ROOT, config as bootConfig } from '../config/index.mjs';
import { readSecrets, writeSecrets } from '../extension-secrets.mjs';
import { HOST_OWNER, parseOwnerKey } from './principal.mjs';
// 型号知识（已知型号表、思考模板、档位 ID 规则）和 dimensio 的自定义服务共用：src/model-knowledge/
import { guessKind, tableEntry, thinkingTemplate, fixKnownBaseUrl, TIER_ID_RE, MAX_TIERS, OFF_TIER_IDS } from '../model-knowledge/knowledge.mjs';

export const PROVIDERS_DIR = path.join(ROOT, 'claude-providers');
export { HOST_OWNER };
export const MEMBER_MAX_PROVIDERS = 10;

/** 这个身份能不能用 / 管自定义 API，能的话回它的 owner 键（快照、分享、没开 Claude 的成员回 null）。 */
export function customOwner(ctx) {
  if (!ctx || ctx.snap) return null;
  if (ctx.kind === 'admin') return HOST_OWNER;
  if (ctx.kind === 'user' && ctx.key && ctx.allowClaude !== false) return ctx.key;
  return null;
}
export const isMemberOwner = (owner) => !!owner && owner !== HOST_OWNER;
const ownerOf = (owner) => owner || HOST_OWNER;
// 成员的目录名：账号 id 本身（安全字符时），否则取哈希
function dirOf(owner) {
  owner = ownerOf(owner);
  if (owner === HOST_OWNER) return PROVIDERS_DIR;
  const p = parseOwnerKey(owner);
  if (!p || p.kind !== 'user' || !p.id) throw new Error('自定义 API 只认主机管理员与成员账号');
  const id = /^[A-Za-z0-9_-]{1,64}$/.test(p.id) ? p.id : 'h-' + createHash('sha256').update(p.id).digest('hex').slice(0, 24);
  return path.join(PROVIDERS_DIR, 'users', id);
}

export const PROTOCOLS = ['anthropic', 'openai'];
export const AUTH_STYLES = ['x-api-key', 'bearer', 'none'];
export const THINKING_KINDS = ['none', 'budget', 'adaptive', 'effort'];
// 服务级「思考」策略：auto 跟随会话里选的档位（没选用默认档）；off 一律用「关闭」档（没有就不发）；on 没选时用默认档、没默认用最高档。
export const THINKING_MODES = ['auto', 'off', 'on'];
export const MAX_TOKENS_FIELDS = ['max_tokens', 'max_completion_tokens'];
export const MODEL_KINDS = ['chat', 'other'];
const SOURCES = new Set(['api', 'table', 'probe', 'guess', 'default', 'user']);
export { TIER_ID_RE };

const ID_RE = /^p-[0-9a-f]{6,12}$/;
const MODEL_ID_RE = /^[\w.:\/@+-]{1,200}$/;
const HEADER_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
const FIELD_RE = /^[A-Za-z_][\w-]{0,40}(?:\.[A-Za-z_][\w-]{0,40}){0,4}$/;
// 鉴权与逐跳头由代理自己管，自定义头不许覆盖它们。
const RESERVED_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'x-api-key', 'authorization', 'anthropic-version', 'content-type', 'accept-encoding']);

// 常用厂商预设：只给地址、协议、鉴权方式和兼容默认值；型号一律以「拉取模型列表」为准（各家改得勤）。
// modelsUrl：Anthropic 端点下没有 /v1/models 的厂商，拉模型列表改去这里（小米、DeepSeek 一类）。
export const PRESETS = Object.freeze([
  { id: 'anthropic', name: 'Anthropic API', note: '官方按量计费', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com', authStyle: 'x-api-key', compat: { promptCaching: true, slimBody: false, stripBetas: false } },
  { id: 'deepseek', name: 'DeepSeek', protocol: 'anthropic', baseUrl: 'https://api.deepseek.com/anthropic', authStyle: 'x-api-key' },
  { id: 'moonshot', name: 'Kimi · Moonshot', protocol: 'anthropic', baseUrl: 'https://api.moonshot.cn/anthropic', authStyle: 'x-api-key' },
  { id: 'zhipu', name: '智谱 GLM', protocol: 'anthropic', baseUrl: 'https://open.bigmodel.cn/api/anthropic', authStyle: 'x-api-key' },
  { id: 'dashscope', name: '阿里云百炼', protocol: 'anthropic', baseUrl: 'https://dashscope.aliyuncs.com/apps/anthropic', authStyle: 'x-api-key' },
  { id: 'minimax', name: 'MiniMax', protocol: 'anthropic', baseUrl: 'https://api.minimaxi.com/anthropic', authStyle: 'x-api-key' },
  // 小米 MiMo：Anthropic 兼容地址是 …/anthropic，…/v1 是 OpenAI 兼容地址（两种都实测跑通）
  { id: 'mimo', name: '小米 MiMo', note: '按量计费', protocol: 'anthropic', baseUrl: 'https://api.xiaomimimo.com/anthropic', authStyle: 'x-api-key' },
  { id: 'mimo-plan', name: '小米 MiMo Token Plan', note: '套餐', protocol: 'anthropic', baseUrl: 'https://token-plan-cn.xiaomimimo.com/anthropic', authStyle: 'x-api-key' },
  { id: 'openrouter', name: 'OpenRouter', protocol: 'openai', baseUrl: 'https://openrouter.ai/api/v1', authStyle: 'bearer' },
  { id: 'siliconflow', name: '硅基流动', protocol: 'openai', baseUrl: 'https://api.siliconflow.cn/v1', authStyle: 'bearer' },
  { id: 'openai', name: 'OpenAI', protocol: 'openai', baseUrl: 'https://api.openai.com/v1', authStyle: 'bearer', compat: { maxTokensField: 'max_completion_tokens' } },
  { id: 'local', name: '本机模型', note: 'Ollama / llama.cpp / LM Studio', protocol: 'openai', baseUrl: 'http://127.0.0.1:11434/v1', authStyle: 'none', compat: { useProxy: false } },
]);

// —— 规范化（所有入口都过这里：坏值一律抛 400，给人看的中文）——
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const int = (v, lo, hi, what) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < lo || n > hi) throw bad(`${what}要是 ${lo}–${hi} 之间的整数`);
  return n;
};
const num = (v, lo, hi, what) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < lo || n > hi) throw bad(`${what}要在 ${lo}–${hi} 之间`);
  return Math.round(n * 1000) / 1000;
};
const oneOf = (v, list, dflt) => (list.includes(v) ? v : dflt);
const str = (v, max) => String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);

export function normalizeBaseUrl(v) {
  const s = String(v || '').trim().replace(/\/+$/, '');
  if (!s) throw bad('接口地址不能为空');
  let u;
  try { u = new URL(s); } catch { throw bad('接口地址不是合法网址'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw bad('接口地址只支持 http / https');
  if (u.username || u.password) throw bad('接口地址里别带账号密码，API Key 单独填');
  if (u.search || u.hash) throw bad('接口地址里别带 ? 参数或 #');
  return s;
}

// 额外请求体：必须是 JSON 对象，最后深合并进每个请求（用户说了算）。存原文，方便原样回显。
export function parseExtraBody(text) {
  const s = String(text ?? '').trim();
  if (!s) return { text: '', obj: null };
  if (s.length > 8000) throw bad('额外请求体太长（上限 8000 字符）');
  let o;
  try { o = JSON.parse(s); } catch (e) { throw bad('额外请求体不是合法 JSON：' + ((e && e.message) || '')); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw bad('额外请求体要是 JSON 对象（{…}）');
  return { text: s, obj: o };
}

// 调用参数（服务级默认、模型级覆盖共用一个形状；模型级的 null = 沿用服务级）。
export function normalizeParams(p = {}) {
  p = p && typeof p === 'object' ? p : {};
  const stop = Array.isArray(p.stop) ? p.stop.map((x) => String(x ?? '').slice(0, 64)).filter(Boolean).slice(0, 8) : [];
  return {
    maxTokens: int(p.maxTokens, 1, 1_000_000, '最大输出'),
    temperature: num(p.temperature, 0, 2, 'temperature '),
    topP: num(p.topP, 0, 1, 'top_p '),
    topK: int(p.topK, 1, 1000, 'top_k '),
    thinking: p.thinking == null ? null : oneOf(p.thinking, THINKING_MODES, null),
    thinkingBudget: int(p.thinkingBudget, 1024, 200_000, '思考预算'),
    stop,
    extraBody: parseExtraBody(p.extraBody).text,
  };
}

function normalizeHeaders(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const h of list.slice(0, 16)) {
    const name = String(h?.name ?? '').trim();
    if (!name) continue;
    if (!HEADER_RE.test(name)) throw bad(`请求头名「${name.slice(0, 40)}」不合法`);
    if (RESERVED_HEADERS.has(name.toLowerCase())) throw bad(`请求头「${name}」由 bridge 自己管，不能自定义`);
    const value = String(h?.value ?? '').replace(/[\r\n]+/g, ' ').slice(0, 2000);
    out.push({ name, value });
  }
  return out;
}

// —— 档位表 ——
function tierValue(v, where) {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v === 'string') return v.slice(0, 200);
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw bad(`${where}的发送值不是有效数字`); return v; }
  if (typeof v === 'boolean') return v;
  if (typeof v === 'object' && !Array.isArray(v)) {
    const s = JSON.stringify(v);
    if (s.length > 2000) throw bad(`${where}的发送值太长（上限 2000 字符）`);
    return JSON.parse(s);
  }
  throw bad(`${where}的发送值要是文字、数字、true / false 或 JSON 对象`);
}
export function normalizeTiers(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const t of list.slice(0, MAX_TIERS)) {
    const id = String(t?.id ?? '').trim().toLowerCase();
    if (!TIER_ID_RE.test(id)) throw bad(`档位 ID「${id.slice(0, 30)}」不合法（小写字母数字与 _ -，最长 24）`);
    if (seen.has(id)) throw bad(`档位「${id}」重复了`);
    seen.add(id);
    out.push({ id, name: str(t.name, 24) || id, value: tierValue(t.value, `档位「${id}」`) });
  }
  return out;
}
function normalizeField(v) {
  const s = String(v ?? '').trim();
  if (!s) return '';
  if (!FIELD_RE.test(s) || s.split('.').some((k) => k === '__proto__' || k === 'constructor' || k === 'prototype')) throw bad(`写入字段「${s.slice(0, 60)}」不合法（点分路径，如 reasoning_effort、output_config.effort）`);
  return s;
}
function normalizeSource(s) {
  const out = {};
  if (s && typeof s === 'object') for (const k of ['contextWindow', 'maxOutput', 'vision', 'thinking']) if (SOURCES.has(s[k])) out[k] = s[k];
  return out;
}

const LEGACY_CTX = 200_000, LEGACY_OUT = 32_000;
// 老的四选一思考方式 → 档位表（老配置迁移、老版 apk 的编辑器保存时共用；fromTable = 按型号表的模板出的）。
function legacyThink(legacy, tbl, protocol) {
  const tpl = tbl && tbl.think ? thinkingTemplate(tbl.think, protocol, { dflt: tbl.dflt }) : null;   // dflt：型号表记的默认档（Opus 5.5 是 medium）
  // 原来是「不支持」（前端写死的默认值）或「Anthropic 协议 + effort」（这个组合以前什么都不发，等于没配）：按型号表来
  if (tpl && (legacy === 'none' || (legacy === 'effort' && protocol !== 'openai'))) return { ...tpl, fromTable: true };
  if (legacy === 'budget') return { thinking: 'budget', efforts: ['low', 'medium', 'high', 'xhigh', 'max'].map((x) => ({ id: x, name: x === 'xhigh' ? 'Extra' : x[0].toUpperCase() + x.slice(1), value: null })), effortField: '', effortDefault: 'high' };
  if (legacy === 'adaptive') return { thinking: 'adaptive', efforts: [{ id: 'adaptive', name: '自适应', value: null }], effortField: '', effortDefault: 'adaptive' };
  // 以前没选档位 OpenAI 协议照发 high；Anthropic 协议以前什么都不发，默认档留空保持不发
  if (legacy === 'effort') return { thinking: 'effort', efforts: ['low', 'medium', 'high'].map((x) => ({ id: x, name: x[0].toUpperCase() + x.slice(1), value: x })), effortField: '', effortDefault: protocol === 'openai' ? 'high' : '' };
  return { thinking: 'none', efforts: [], effortField: '', effortDefault: '' };
}
// 老配置（没有 efforts 档位表）→ 新形状。原则：行为不变；型号表里有的、原来又是写死默认值的，换成真实能力。
function migrateLegacy(m, id, protocol) {
  const tbl = tableEntry(id);
  const source = {};
  let contextWindow = int(m.contextWindow, 4096, 4_000_000, '上下文窗口');
  let maxOutput = int(m.maxOutput, 256, 1_000_000, '输出上限');
  let vision = m.vision !== false;
  if (tbl && tbl.ctx && (contextWindow == null || contextWindow === LEGACY_CTX)) { contextWindow = tbl.ctx; source.contextWindow = 'table'; }
  if (tbl && tbl.out && (maxOutput == null || maxOutput === LEGACY_OUT)) { maxOutput = tbl.out; source.maxOutput = 'table'; }
  // 视觉：老配置的 true 是前端写死的默认值，型号表说了算；人手动关掉的（false）不动
  if (tbl && typeof tbl.vision === 'boolean' && m.vision !== false) { vision = tbl.vision; source.vision = 'table'; }
  const think = legacyThink(oneOf(m.thinking, THINKING_KINDS, 'none'), tbl, protocol);
  if (think.fromTable) source.thinking = 'table';
  return {
    contextWindow: contextWindow ?? LEGACY_CTX, maxOutput: maxOutput ?? LEGACY_OUT, vision,
    thinking: think.thinking, efforts: think.efforts, effortField: think.effortField, effortDefault: think.effortDefault,
    alwaysThinks: m.alwaysThinks === true || !!think.alwaysThinks, source,
  };
}

function normalizeModel(m, i, protocol) {
  const id = String(m?.id ?? '').trim();
  if (!MODEL_ID_RE.test(id)) throw bad(`第 ${i + 1} 个模型的 ID 不合法（字母数字与 . _ - / : @ +，最长 200）`);
  const kindGiven = oneOf(m.kind, MODEL_KINDS, '');
  const kind = kindGiven || guessKind(id);
  let caps;
  if (!Array.isArray(m.efforts)) caps = migrateLegacy(m, id, protocol);
  else {
    const thinking = oneOf(m.thinking, THINKING_KINDS, 'none');
    // 「不思考」就不看档位表（界面切到「不思考」时它可能还带着、甚至有填坏的档，用户已经看不见它了）
    let efforts = thinking === 'none' ? [] : normalizeTiers(m.efforts);
    // 写入字段只有「档位」方式用（界面也只在这时露出来）：别的方式下留着的坏值不拦保存，直接清掉
    let effortField = thinking === 'effort' ? normalizeField(m.effortField) : '';
    let effortDefault = efforts.some((t) => t.id === m.effortDefault) ? m.effortDefault : '';
    // 有思考方式却没有档位 = 老版 apk 的编辑器（四选一，原样带回服务端给的空档位表）：新版编辑器保存时会把这种
    // 改成「不思考」，所以这里只可能是老界面刚选的预算 / 自适应 / 档位——按老规则补档位，别让它什么都不发
    if (thinking !== 'none' && !efforts.length) {
      const legacy = legacyThink(thinking, null, protocol);
      efforts = legacy.efforts; effortField = legacy.effortField; effortDefault = legacy.effortDefault;
    }
    caps = {
      contextWindow: int(m.contextWindow, 4096, 4_000_000, '上下文窗口') ?? LEGACY_CTX,
      maxOutput: int(m.maxOutput, 256, 1_000_000, '输出上限') ?? LEGACY_OUT,
      vision: m.vision !== false,
      thinking,
      efforts,
      effortField,
      effortDefault,
      alwaysThinks: m.alwaysThinks === true,
      source: normalizeSource(m.source),
    };
  }
  return {
    id,
    label: str(m.label, 80) || id,
    // 没标 kind 的（老配置、老版 apk 新加的）按名字判成非对话的（asr / tts…）默认不启用；落盘后 kind 有值，之后手动打开不受影响
    enabled: m.enabled !== false && (!!kindGiven || kind === 'chat'),
    kind,
    ...caps,
    params: normalizeParams(m.params),
  };
}

// 模型服务强制走出站代理（2026-10-27，Muse 同步第 23 条）：只能经出站代理访问外网的部署（Muse Bridge 的 VM）声明
//   环境变量 BRIDGE_PROXY_FORCED=1（其余非空值 = 不强制，可用来压掉 config），其次 config.json 的 "proxyForced": true。
// 声明了：保存一律 useProxy:true（normalizeProvider）；发请求时也不认存档里早先的 false（claude-providers-proxy.mjs）；
// GET /api/claude/providers 带 proxyForced:true，编辑器据此不摆「走出站代理」开关。走代理时照旧尊重 NO_PROXY（net-proxy.mjs）。
export function providerProxyForced({ env = process.env, cfg = bootConfig } = {}) {
  const v = String(env.BRIDGE_PROXY_FORCED ?? '').trim().toLowerCase();
  if (v) return ['1', 'true', 'on', 'yes'].includes(v);
  return !!(cfg && cfg.proxyForced === true);
}

const COMPAT_DEFAULTS = { promptCaching: false, stripBetas: true, slimBody: true, stripThinkingHistory: false, replayReasoning: false, maxTokensField: 'max_tokens', useProxy: true };

export function normalizeProvider(input, prev = null) {
  const p = { ...(prev || {}), ...(input || {}) };
  const protocol = oneOf(p.protocol, PROTOCOLS, 'anthropic');
  const models = (Array.isArray(p.models) ? p.models : []).slice(0, 300).map((m, i) => normalizeModel(m, i, protocol));
  const ids = new Set();
  for (const m of models) { if (ids.has(m.id)) throw bad(`模型「${m.id}」重复了`); ids.add(m.id); }
  // 默认模型（测试连接默认用它、排在本服务分组第一位）只认启用的对话模型——老配置里落在 asr 上的就地改正
  const chatIds = models.filter((m) => m.enabled && m.kind === 'chat').map((m) => m.id);
  const pickChat = (v) => (v && chatIds.includes(v) ? v : '');
  const c ={ ...COMPAT_DEFAULTS, ...(prev?.compat || {}), ...(input?.compat && typeof input.compat === 'object' ? input.compat : {}) };
  return {
    id: prev?.id || p.id,
    name: str(p.name, 40) || '未命名服务',
    note: str(p.note, 80),
    preset: str(p.preset, 24),
    enabled: p.enabled !== false,
    showInPicker: p.showInPicker !== false,
    protocol,
    baseUrl: normalizeBaseUrl(p.baseUrl),
    authStyle: oneOf(p.authStyle, AUTH_STYLES, protocol === 'openai' ? 'bearer' : 'x-api-key'),
    headers: normalizeHeaders(p.headers),
    timeoutSec: int(p.timeoutSec, 10, 1800, '超时') ?? 600,
    retries: int(p.retries, 0, 5, '重试次数') ?? 2,
    models,
    defaultModel: pickChat(p.defaultModel) || chatIds[0] || '',
    // 小任务模型同样只认启用的对话模型：指到 asr / tts 上，标题生成、摘要这类后台小任务会全部 400
    fastModel: pickChat(p.fastModel),
    params: normalizeParams(p.params),
    compat: {
      promptCaching: !!c.promptCaching,
      stripBetas: !!c.stripBetas,
      slimBody: !!c.slimBody,
      stripThinkingHistory: !!c.stripThinkingHistory,
      replayReasoning: !!c.replayReasoning,
      maxTokensField: oneOf(c.maxTokensField, MAX_TOKENS_FIELDS, 'max_tokens'),
      useProxy: c.useProxy !== false || providerProxyForced(),
    },
    createdAt: prev?.createdAt || Date.now(),
    updatedAt: Date.now(),
  };
}

// 官方 API 服务：fast 改由模型菜单的开关管（2026-10-23），以前手写在「额外请求体」里的 "speed" 读进来时去掉，下次保存落盘
//（代理那边对官方地址也一律不发额外请求体里的 speed，见 applyParams）。
function dropSpeedExtra(p) {
  const strip = (params) => {
    if (!params || !params.extraBody) return params;
    let o; try { o = JSON.parse(params.extraBody); } catch { return params; }
    if (!o || typeof o !== 'object' || Array.isArray(o) || !('speed' in o)) return params;
    delete o.speed;
    return { ...params, extraBody: Object.keys(o).length ? JSON.stringify(o, null, 2) : '' };
  };
  return { ...p, params: strip(p.params), models: p.models.map((m) => ({ ...m, params: strip(m.params) })) };
}

// —— 存储（按 owner 一份）——
const regs = new Map();   // owner → { rev, providers }
function load(owner) {
  owner = ownerOf(owner);
  const hit = regs.get(owner);
  if (hit) return hit;
  const raw = readJson(path.join(dirOf(owner), 'providers.json'), {});
  const list = [];
  for (const p of Array.isArray(raw.providers) ? raw.providers : []) {
    if (!p || !ID_RE.test(String(p.id || ''))) continue;
    try {
      // 已知的地址配错（小米：anthropic 协议配了 OpenAI 兼容的 …/v1，上游必 404）就地改正，下次保存落盘
      const fixed = fixKnownBaseUrl(p.protocol, p.baseUrl);
      if (fixed !== p.baseUrl) console.log(`[claude-providers] ${p.id} baseUrl ${p.baseUrl} → ${fixed}（Anthropic 协议的地址）`);
      const np = normalizeProvider({ ...p, baseUrl: fixed }, p);
      list.push({ ...(fastCapableProvider(np) ? dropSpeedExtra(np) : np), updatedAt: p.updatedAt || Date.now(), owner });
    } catch (e) { console.error('[claude-providers] skip bad provider', p.id, e && e.message); }
  }
  const d = { rev: Number.isFinite(raw.rev) ? raw.rev : 0, providers: list };
  regs.set(owner, d);
  return d;
}
const withoutOwner = ({ owner, ...p }) => p;
function save(owner) {
  const d = load(owner);
  d.rev += 1;
  writeJson(path.join(dirOf(owner), 'providers.json'), { rev: d.rev, providers: d.providers.map(withoutOwner) }, 2);
}

const listeners = new Set();
/** 注册表变了（代理据此丢掉缓存、在线客户端刷新选择器）：fn(owner)。 */
export function onProvidersChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function changed(owner) { for (const fn of listeners) { try { fn(owner); } catch {} } }

/** 已经读进内存的 owner（fast 探测结论变了要推给这些人）。 */
export const loadedOwners = () => [...regs.keys()];
export function providersRev(owner) { return load(owner).rev; }
export function getProvider(id, owner) { return load(owner).providers.find((p) => p.id === id) || null; }

// —— 密钥 ——
function secrets(owner) {
  try { return readSecrets(dirOf(owner)); } catch (e) { console.error('[claude-providers] secrets unreadable:', e && e.message); return {}; }
}
export function providerKey(id, owner) { const s = secrets(owner)[id]; return s && typeof s.key === 'string' ? s.key : ''; }
function setKey(id, key, owner) {
  const map = { ...secrets(owner) };
  if (key) map[id] = { key }; else delete map[id];
  writeSecrets(dirOf(owner), map);   // 失败就抛——绝不退回明文
}

/** 给前端的视图：不带完整密钥，只给尾 4 位供辨认。 */
export function publicProvider(p) {
  const key = providerKey(p.id, p.owner);
  return { ...withoutOwner(p), hasKey: !!key, keyTail: key ? key.slice(-4) : '' };
}
export function listProviders(owner) { return load(owner).providers.map(publicProvider); }
/** 这个 owner 能看到的预设（成员没有「本机模型」：只许连公网）。 */
export const presetsFor = (owner) => (isMemberOwner(owner) ? PRESETS.filter((p) => p.id !== 'local') : PRESETS);

export function createProvider(input, owner) {
  owner = ownerOf(owner);
  const d = load(owner);
  const max = isMemberOwner(owner) ? MEMBER_MAX_PROVIDERS : 30;
  if (d.providers.length >= max) throw bad(`模型服务最多 ${max} 个`);
  const id = 'p-' + randomBytes(4).toString('hex');
  const p = { ...normalizeProvider({ ...input, id }), owner };
  const key = typeof input?.apiKey === 'string' ? input.apiKey.trim() : '';
  if (key.length > 4000) throw bad('API Key 太长');
  if (key) setKey(id, key, owner);
  d.providers.push(p);
  save(owner); changed(owner);
  return publicProvider(p);
}

export function updateProvider(id, patch, owner) {
  owner = ownerOf(owner);
  const d = load(owner);
  const i = d.providers.findIndex((p) => p.id === id);
  if (i < 0) throw Object.assign(new Error('没有这个模型服务'), { status: 404 });
  const next = { ...normalizeProvider({ ...patch, id }, d.providers[i]), owner };
  // apiKey：字符串 = 换新；空串 = 清掉；不传 = 不动
  if (typeof patch?.apiKey === 'string') {
    const key = patch.apiKey.trim();
    if (key.length > 4000) throw bad('API Key 太长');
    setKey(id, key, owner);
  }
  d.providers[i] = next;
  save(owner); changed(owner);
  return publicProvider(next);
}

export function deleteProvider(id, owner) {
  owner = ownerOf(owner);
  const d = load(owner);
  const i = d.providers.findIndex((p) => p.id === id);
  if (i < 0) return false;
  d.providers.splice(i, 1);
  try { setKey(id, '', owner); } catch {}
  save(owner); changed(owner);
  return true;
}

// —— 会话里的模型 id：custom:<服务 id>:<模型 id>（模型 id 自己可以带冒号 / 斜杠）——
const CUSTOM_RE = /^custom:(p-[0-9a-f]{6,12}):(.+)$/;
export const customModelId = (pid, mid) => `custom:${pid}:${mid}`;
export const isCustomModelId = (s) => typeof s === 'string' && CUSTOM_RE.test(s);
export function parseCustomModel(s) {
  const m = typeof s === 'string' ? CUSTOM_RE.exec(s) : null;
  return m ? { pid: m[1], mid: m[2] } : null;
}

/** 解析成 { provider, model }：服务被删 / 停用、模型被删 / 关掉时回 null（调用方给人话错误）。「显示在模型列表」关着不影响。 */
/** owner = 谁的注册表（会话属主的 owner 键；不传 = 主机管理员）。 */
export function resolveCustomModel(s, owner) {
  const r = parseCustomModel(s);
  if (!r) return null;
  const provider = getProvider(r.pid, owner);
  if (!provider || !provider.enabled) return null;
  const model = provider.models.find((m) => m.id === r.mid && m.enabled);
  return model ? { provider, model } : null;
}

/** 模型档位表里最高的「开着」的一档（Ultracode = 这一档 + 动态工作流）；表空 / 只有关闭档 → ''（厂商默认）。 */
export function customTopTier(model) {
  const on = ((model && model.efforts) || []).filter((t) => !OFF_TIER_IDS.includes(t.id));
  return on.length ? on[on.length - 1].id : '';
}

/** 这个档位 id 是不是该自定义模型档位表里的（chat 路由校验请求里的 effort 用）。 */
export function customEffortOk(modelId, e, owner) {
  if (typeof e !== 'string' || !TIER_ID_RE.test(e)) return false;
  const r = resolveCustomModel(modelId, owner);
  return !!(r && (r.model.efforts || []).some((t) => t.id === e));
}

// fast mode（`speed:"fast"` + beta 头 fast-mode-2026-02-01）只有 Anthropic 官方 API 认。支持哪些型号靠真探测：
// 代理对官方地址的每个启用模型打一次 max_tokens=1 的带 speed 请求（claude-providers-proxy.mjs 的 ensureFastProbes），
// 200 / fast 额度 429 = 支持，400「does not support the `speed` parameter」= 不支持，结果按型号落盘（fast-probe.json，7 天复探）。
// 还没探出来（刚加的服务、网络错）先按实测表：2026-10-23 真 key 逐个打，Opus 5.5 / 5 / 4.8 / 4.6 回 200；
// Opus 4.7、Fable、Sonnet、Haiku 回 400。订阅号那条路（CLI settings.fastMode）的支持表在 capabilities.mjs，两边不一样。
const API_FAST = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-6']);
const FAST_HOSTS = new Set(['api.anthropic.com']);
const isFirstPartyHost = (u) => { try { return FAST_HOSTS.has(new URL(u).hostname); } catch { return false; } };
export function _fastHostForTests(h) { FAST_HOSTS.add(h); }
const FAST_FILE = path.join(PROVIDERS_DIR, 'fast-probe.json');
export const FAST_PROBE_TTL = 7 * 86400_000;
let fastProbes = null;   // 型号 id → { ok, at }（官方 API 上型号支不支持 fast 跟账号无关，按型号记）
const probes = () => (fastProbes ||= (() => { const j = readJson(FAST_FILE, {}); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; })());
const bareId = (id) => String(id).replace(/\[1m\]$/i, '');
/** 这个服务能不能开 fast：Anthropic 协议 + 官方 api.anthropic.com。 */
export const fastCapableProvider = (p) => !!(p && p.protocol === 'anthropic' && isFirstPartyHost(p.baseUrl));
/** 探测结果：true / false；null = 没探过或过期（该探了）。 */
export function fastProbe(modelId) {
  const r = probes()[bareId(modelId)];
  return r && typeof r.ok === 'boolean' && Date.now() - (r.at || 0) < FAST_PROBE_TTL ? r.ok : null;
}
/** 记一次探测结果；回 true = 结论变了（调用方据此通知在线客户端刷新菜单）。 */
export function recordFastProbe(modelId, ok) {
  const id = bareId(modelId), m = probes();
  const was = fastProbe(id);
  m[id] = { ok: !!ok, at: Date.now() };
  try { writeJson(FAST_FILE, m, 2); } catch {}
  return was !== !!ok;
}
export function _resetFastProbesForTests(map = {}) { fastProbes = map; }
/** 这个自定义模型能不能开 fast：官方 API 服务上、探测说支持（没探出来按实测表）。 */
export function customSupportsFast(provider, model) {
  if (!fastCapableProvider(provider) || !model) return false;
  const probed = fastProbe(model.id);
  return probed ?? API_FAST.has(bareId(model.id));
}

/**
 * 模型选择器用的扁平清单：启用的服务里启用的对话模型。服务关了「显示在模型列表」的照样列出、标 hidden——
 * 正在用它的会话芯片要取名字，菜单只在它是当前模型时才露出来。
 */
export function customModelsView(owner) {
  const out = [];
  for (const p of load(owner).providers) {
    if (!p.enabled) continue;
    for (const m of p.models) {
      if (!m.enabled || m.kind !== 'chat') continue;
      out.push({
        id: customModelId(p.id, m.id), name: m.label, provider: p.id, providerName: p.name, preset: p.preset, baseUrl: p.baseUrl,
        thinking: m.thinking, vision: m.vision, contextWindow: m.contextWindow,
        // 上下文窗口的来源（api / probe / user 实打实；table / guess / default 是估的）：菜单徽章据此加「≈」，同编辑器
        ctxSource: (m.source && m.source.contextWindow) || '',
        efforts: (m.efforts || []).map((t) => ({ id: t.id, name: t.name })), effortDefault: m.effortDefault || '', alwaysThinks: !!m.alwaysThinks,
        isDefault: p.defaultModel === m.id, hidden: p.showInPicker === false,
        fast: customSupportsFast(p, m),
      });
    }
  }
  return out;
}

// —— 子 agent 跨服务调度（设置 › Claude › 对话 › 子 agent 调度偏好）——
// 动态工作流的 agent({model}) 收任意字符串、CLI 原样写进 body.model，代理据此把这个子 agent 的请求转到对应服务。
// 给 Claude 看的模型名：全服唯一就用型号 id 本身（好写、不易抄错），重名的用 custom:<服务>:<型号>。
function chatModels(owner) {
  const out = [];
  for (const p of load(owner).providers) {
    if (!p.enabled) continue;
    for (const m of p.models) if (m.enabled && m.kind === 'chat') out.push({ provider: p, model: m });
  }
  return out;
}

/** 按子 agent 写的模型名找 { provider, model }：custom:<服务>:<型号> 精确；裸型号 id 不分大小写、全服只有一个才算。 */
export function resolveSubagentModel(name, owner) {
  if (typeof name !== 'string' || !name) return null;
  if (isCustomModelId(name)) return resolveCustomModel(name, owner);
  const n = name.replace(/\[1m\]$/i, '').toLowerCase();
  const hits = chatModels(owner).filter((x) => x.model.id.toLowerCase() === n);
  return hits.length === 1 ? hits[0] : null;
}

/** 可派给子 agent 的模型清单（系统提示里列给 Claude）：[{ name, label, provider, contextWindow, vision, efforts }]。 */
export function subagentModelCatalog(owner) {
  const all = chatModels(owner);
  const count = new Map();
  for (const x of all) { const k = x.model.id.toLowerCase(); count.set(k, (count.get(k) || 0) + 1); }
  return all.map(({ provider: p, model: m }) => ({
    name: count.get(m.id.toLowerCase()) > 1 ? customModelId(p.id, m.id) : m.id,
    label: m.label || m.id, provider: p.name, contextWindow: m.contextWindow || 0, vision: !!m.vision,
    efforts: (m.efforts || []).map((t) => t.id),
  }));
}

export function _resetProvidersForTests() { regs.clear(); }
