// Media Studio 设置注册表（2026-11-04）：设置 › Media Studio 上的几组。
//
// 纯数据、无 node 依赖：服务端（src/runtime/studio-settings.mjs 读写、校验、判定）和两套设置外壳都从这一份表渲染，
// 同 vertex-settings.mjs / claude-settings.mjs 的做法。label / desc / optionLabels 写中文原文，前端过 t() 出英文。
//
// 两级：
//   主机级（scope 'host' / 'both'，只有管理员能改）：存 config.json 的 studioHost 键，只存与默认不同的显式值。
//     「让别的 agent 生成」「agent 能生成什么」这两组 2026-11-04 从 vertexHost 迁过来（首次读到时照抄老值）。
//     内容安全过滤四键同样从 vertexHost 迁来（Gemini 对话下线后只剩 Studio 在用，只发给 vertex / gemini 方言的 generateContent：Nano Banana）。
//   个人级（scope 'both'）：每个人自己的默认模型、自动保存与保存位置，存 <数据根>/studio-providers[/users/<账号>]/settings.json；
//     读取时个人值压过主机值。
//
// 每项字段：key / group / type（'bool' | 'enum' | 'text' | 'defaults'）/ options / optionLabels / default / label / desc，
//   scope      'host' 只有主机级；'both' 主机给默认、个人可覆盖
//   dependsOn  主项为假值时本项不显示
//   agent      只有这个 agent 在这台服务器上有时才显示
//   max        text 的长度上限
// 'defaults' 类型的值：{ image?: { provider, model }, video?, speech?, music? }——provider 是服务 id（p-xxxxxxxx），
//   model 是该服务里的模型 id；缺某一种 = 用内置默认（catalog 里第一个能用的）。

export const STUDIO_KINDS = Object.freeze(['image', 'video', 'speech', 'music']);
export const STUDIO_KIND_LABEL = Object.freeze({ image: '图像', video: '视频', speech: '配音', music: '音乐' });

export const STUDIO_SETTING_GROUPS = Object.freeze([
  { id: 'defaults', label: '默认模型', foot: '创作页打开时选中的模型，也是 Claude 的媒体工具没指定模型时用的。成员可以在自己的设置里另选。' },
  { id: 'storage', label: '存储', foot: '在 Media Studio 里生成的作品自动复制一份进工作空间，侧栏「文件」里直接能看到。' },
  { id: 'agents', label: '允许的 agent', foot: '只管 agent 自己调用；你在 Media Studio 里手动生成不受影响。' },
  { id: 'kinds', label: '允许的种类', foot: '对上面开着的 agent 都生效。成员还受「额度与注册」里的媒体开关和每日次数限制。' },
  { id: 'safety', label: '内容安全过滤', foot: '对 Gemini 图像模型（Nano Banana）生效，跟 Google AI Studio 的安全设置是同一套。被拦下时报错里会写明。Google 对较新的模型默认不过滤。' },
]);

const SAFETY_OPTIONS = ['default', 'off', 'high', 'medium', 'low'];
const SAFETY_LABELS = ['Google 默认', '不过滤', '只拦高风险', '拦中风险及以上', '拦低风险及以上'];

export const STUDIO_SETTINGS = Object.freeze([
  // —— 默认模型（主机给默认，个人可覆盖）——
  { key: 'defaults', group: 'defaults', type: 'defaults', default: Object.freeze({}), scope: 'both',
    label: '默认模型', desc: '图像、视频、配音、音乐各选一个；不选就用内置默认' },

  // —— 存储 ——
  { key: 'autoSave', group: 'storage', type: 'bool', default: true, scope: 'both',
    label: '自动存进工作空间', desc: '按「保存位置 / 种类 / 时间-描述」命名' },
  { key: 'saveDir', group: 'storage', type: 'text', default: 'Media Studio', scope: 'both', dependsOn: 'autoSave', max: 200,
    label: '保存位置', desc: '相对你的工作空间根目录；留空就是根目录' },

  // —— 允许的 agent（以前叫「让别的 agent 生成媒体」，2026-11-04 从 vertexHost 迁来）——
  { key: 'claudeMedia', group: 'agents', type: 'bool', default: true, scope: 'host',
    label: 'Claude', desc: '对话和定时任务里多出生成图片、视频、语音、音乐的工具' },
  { key: 'claudeProactive', group: 'agents', type: 'bool', default: true, scope: 'host', dependsOn: 'claudeMedia',
    label: '需要素材时主动生成', desc: '做网页、文档时不等你开口就配图、配乐；关掉后只在你明确要求时生成' },
  { key: 'dimensioMedia', group: 'agents', type: 'bool', default: false, scope: 'host', agent: 'dimensio',
    label: 'dimensio', desc: '经 bridge 的操作接口生成；图片和语音按权限档审批，视频和音乐每次先问你' },
  { key: 'codexMedia', group: 'agents', type: 'bool', default: false, scope: 'host', agent: 'codex',
    label: 'ChatGPT · Codex', desc: '经 bridge 的操作接口生成；视频和音乐每次先问你' },
  { key: 'apiMedia', group: 'agents', type: 'bool', default: true, scope: 'host',
    label: '外部 agent', desc: '拿着「Agent 接入」里生成的密钥来调用的 agent 和脚本' },

  // —— 允许的种类（以前叫「agent 能生成什么」；顺序同创作页标签：图像 / 视频 / 配音 / 音乐）——
  { key: 'agentImage', group: 'kinds', type: 'bool', default: true, scope: 'host', label: '图像' },
  { key: 'agentVideo', group: 'kinds', type: 'bool', default: true, scope: 'host', label: '视频', desc: '1–3 分钟一条，按秒计费，最贵' },
  { key: 'agentVideoMaxRes', group: 'kinds', type: 'enum', default: '4k', scope: 'host', dependsOn: 'agentVideo',
    options: ['720p', '1080p', '4k'], optionLabels: ['720p', '1080p', '4K'],
    label: '视频最高分辨率', desc: 'agent 要更高的会降到这一档' },
  { key: 'agentSpeech', group: 'kinds', type: 'bool', default: true, scope: 'host', label: '配音' },
  { key: 'agentMusic', group: 'kinds', type: 'bool', default: true, scope: 'host', label: '音乐', desc: '约 1–2 分钟一首，按次计费' },

  // —— 内容安全过滤（只发给 vertex / gemini 方言的 generateContent，即 Nano Banana；2026-11-04 从 vertexHost 迁来）——
  { key: 'safetyHarassment', group: 'safety', type: 'enum', default: 'default', scope: 'host', options: SAFETY_OPTIONS, optionLabels: SAFETY_LABELS,
    label: '骚扰', desc: '辱骂、威胁、霸凌' },
  { key: 'safetyHate', group: 'safety', type: 'enum', default: 'default', scope: 'host', options: SAFETY_OPTIONS, optionLabels: SAFETY_LABELS,
    label: '仇恨言论', desc: '针对群体的仇视与煽动' },
  { key: 'safetySexual', group: 'safety', type: 'enum', default: 'default', scope: 'host', options: SAFETY_OPTIONS, optionLabels: SAFETY_LABELS,
    label: '色情内容' },
  { key: 'safetyDangerous', group: 'safety', type: 'enum', default: 'default', scope: 'host', options: SAFETY_OPTIONS, optionLabels: SAFETY_LABELS,
    label: '危险内容', desc: '教唆或协助危险、违法行为' },
]);

export const STUDIO_SETTING_BY_KEY = Object.freeze(Object.fromEntries(STUDIO_SETTINGS.map((s) => [s.key, s])));
// 个人能设的键
export const STUDIO_PERSONAL_KEYS = Object.freeze(STUDIO_SETTINGS.filter((s) => s.scope === 'both').map((s) => s.key));
// 从 vertexHost 迁来的键（agents + kinds 两组）
export const STUDIO_MIGRATED_KEYS = Object.freeze(STUDIO_SETTINGS.filter((s) => ['agents', 'kinds', 'safety'].includes(s.group)).map((s) => s.key));

/** 默认值表（defaults 给一个新的空对象，免得被改到共享的冻结值）。 */
export function studioSettingDefaults() {
  return Object.fromEntries(STUDIO_SETTINGS.map((s) => [s.key, s.type === 'defaults' ? {} : s.default]));
}

const PROVIDER_ID_RE = /^p-[0-9a-f]{6,12}$/;
const MODEL_ID_RE = /^[\w.:/@+-]{1,200}$/;

/** 校验单个值：{ ok:true, value } | { ok:false, error }。 */
export function normalizeStudioSetting(key, v) {
  const s = STUDIO_SETTING_BY_KEY[key];
  if (!s) return { ok: false, error: '未知设置项：' + key };
  if (s.type === 'bool') return typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, error: s.label + '：应为开或关' };
  if (s.type === 'enum') return s.options.includes(v) ? { ok: true, value: v } : { ok: false, error: s.label + '：不认识的选项 ' + String(v) };
  if (s.type === 'text') {
    if (typeof v !== 'string') return { ok: false, error: s.label + '：应为文字' };
    const t = v.replace(/\\/g, '/').replace(/[\r\n\t]+/g, ' ').trim().replace(/^\/+|\/+$/g, '');
    if (t.length > (s.max || 200)) return { ok: false, error: s.label + '：太长了' };
    if (key === 'saveDir') {
      const segs = t.split('/').filter(Boolean);
      if (/^[a-zA-Z]:/.test(t) || segs.some((x) => x === '..' || x === '.' || /[<>:"|?*\x00-\x1f]/.test(x)) || segs[0] === '.bridge') {
        return { ok: false, error: '保存位置要是工作空间里的相对路径（不能有 ..、盘符或特殊字符）' };
      }
      return { ok: true, value: segs.join('/') };
    }
    return { ok: true, value: t };
  }
  if (s.type === 'defaults') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, error: s.label + '：应为 { 种类: { provider, model } }' };
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      if (!STUDIO_KINDS.includes(k)) return { ok: false, error: s.label + '：不认识的种类 ' + k };
      if (x === null || x === undefined || x === '') continue;
      if (!x || typeof x !== 'object' || !PROVIDER_ID_RE.test(String(x.provider || '')) || !MODEL_ID_RE.test(String(x.model || ''))) {
        return { ok: false, error: s.label + '：' + (STUDIO_KIND_LABEL[k] || k) + ' 要选一个服务和模型' };
      }
      out[k] = { provider: String(x.provider), model: String(x.model) };
    }
    return { ok: true, value: out };
  }
  return { ok: false, error: '未知类型' };
}

/** 两个值是否相同（defaults 是对象，按内容比）。 */
export function sameStudioValue(a, b) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** 设置页上这一项显不显示：主项关着的依赖项、这台服务器上没有的 agent 那一行、个人页上的主机级项都不显示。 */
export function studioSettingVisible(key, values, agentIds, scope = 'host') {
  const s = STUDIO_SETTING_BY_KEY[key];
  if (!s) return false;
  if (scope === 'mine' && s.scope !== 'both') return false;
  if (s.dependsOn && !values[s.dependsOn]) return false;
  if (s.agent && Array.isArray(agentIds) && !agentIds.includes(s.agent)) return false;
  return true;
}

// 媒体种类 ↔ 开关键（工具名、操作名都归到这四种）
export const STUDIO_KIND_KEY = Object.freeze({ image: 'agentImage', speech: 'agentSpeech', music: 'agentMusic', video: 'agentVideo' });
// 调用方 ↔ 开关键：'claude' 是 Claude 的媒体工具；同机实例按自报名；'api' 是拿 agent 密钥来的外部调用
export const STUDIO_CALLER_KEY = Object.freeze({ claude: 'claudeMedia', dimensio: 'dimensioMedia', codex: 'codexMedia', api: 'apiMedia' });

// 安全阈值 → Google 的 HarmBlockThreshold；'default' = 不发这一类，跟 Google 的默认
export const SAFETY_THRESHOLD = Object.freeze({ off: 'OFF', high: 'BLOCK_ONLY_HIGH', medium: 'BLOCK_MEDIUM_AND_ABOVE', low: 'BLOCK_LOW_AND_ABOVE' });
export const SAFETY_CATEGORY = Object.freeze({
  safetyHarassment: 'HARM_CATEGORY_HARASSMENT',
  safetyHate: 'HARM_CATEGORY_HATE_SPEECH',
  safetySexual: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  safetyDangerous: 'HARM_CATEGORY_DANGEROUS_CONTENT',
});
