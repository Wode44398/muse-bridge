// Gemini · Vertex 设置注册表（2026-10-29）：设置 › Agent › Gemini 页上「Google 云凭据」卡下面那几组。
//
// 纯数据、无 node 依赖：服务端（src/runtime/vertex-settings.mjs 读写、校验、判定）和两套设置外壳
// （手机 Settings.svelte / 桌面 SettingsDesktop.svelte）都从这一份表渲染，同 claude-settings.mjs 的做法。
// 全是主机级（管理员），存 config.json 的 vertexHost 键，只存与默认不同的显式值。
//
// 每项字段：key / group / type（'bool' | 'enum'）/ options / default / label / desc / optionLabels，
//   dependsOn  主项为假值时本项不显示（缩进紧跟主项）
//   agent      只有这个 agent 在这台服务器上有时才显示（如 Codex 只在私有版）
// label/desc/optionLabels 写中文原文，前端过 t() 出英文（web/src/i18n/en/vertex.js）。
export const VERTEX_SETTING_GROUPS = Object.freeze([
  { id: 'agents', label: '让别的 agent 生成媒体', foot: '只管 agent 自己调用；你在 Vertex 页里手动生成不受影响。' },
  { id: 'kinds', label: 'agent 能生成什么', foot: '对上面开着的 agent 都生效。成员还受「额度与注册」里的媒体开关和每日次数限制。' },
  { id: 'safety', label: '内容安全过滤', foot: '对 Gemini 对话和 Gemini 图像模型生效，跟 Google AI Studio 的安全设置是同一套。被拦下时回复里会写明。Google 对较新的模型默认不过滤。' },
]);

const SAFETY_OPTIONS = ['default', 'off', 'high', 'medium', 'low'];
const SAFETY_LABELS = ['Google 默认', '不过滤', '只拦高风险', '拦中风险及以上', '拦低风险及以上'];

export const VERTEX_SETTINGS = Object.freeze([
  // —— 让别的 agent 生成媒体 ——
  { key: 'claudeMedia', group: 'agents', type: 'bool', default: true,
    label: 'Claude', desc: '对话和定时任务里多出生成图片、视频、语音、音乐的工具' },
  { key: 'claudeProactive', group: 'agents', type: 'bool', default: true, dependsOn: 'claudeMedia',
    label: '需要素材时主动生成', desc: '做网页、文档时不等你开口就配图、配乐；关掉后只在你明确要求时生成' },
  { key: 'dimensioMedia', group: 'agents', type: 'bool', default: false, agent: 'dimensio',
    label: 'dimensio', desc: '经 bridge 的操作接口生成；图片和语音按权限档审批，视频和音乐每次先问你' },
  { key: 'codexMedia', group: 'agents', type: 'bool', default: false, agent: 'codex',
    label: 'ChatGPT · Codex', desc: '经 bridge 的操作接口生成；视频和音乐每次先问你' },
  { key: 'apiMedia', group: 'agents', type: 'bool', default: true,
    label: '外部 agent（Agent 接入）', desc: '拿着「Agent 接入」里生成的密钥来调用的 agent 和脚本' },

  // —— agent 能生成什么 ——
  { key: 'agentImage', group: 'kinds', type: 'bool', default: true, label: '图片' },
  { key: 'agentSpeech', group: 'kinds', type: 'bool', default: true, label: '语音' },
  { key: 'agentMusic', group: 'kinds', type: 'bool', default: true, label: '音乐', desc: '约 1–2 分钟一首，按次计费' },
  { key: 'agentVideo', group: 'kinds', type: 'bool', default: true, label: '视频', desc: '1–3 分钟一条，按秒计费，最贵' },
  { key: 'agentVideoMaxRes', group: 'kinds', type: 'enum', default: '4k', dependsOn: 'agentVideo',
    options: ['720p', '1080p', '4k'], optionLabels: ['720p', '1080p', '4K'],
    label: '视频最高分辨率', desc: 'agent 要更高的会降到这一档' },

  // —— 内容安全过滤（Vertex 的 safetySettings；四类与 AI Studio 一致）——
  { key: 'safetyHarassment', group: 'safety', type: 'enum', default: 'default', options: SAFETY_OPTIONS, optionLabels: SAFETY_LABELS,
    label: '骚扰', desc: '辱骂、威胁、霸凌' },
  { key: 'safetyHate', group: 'safety', type: 'enum', default: 'default', options: SAFETY_OPTIONS, optionLabels: SAFETY_LABELS,
    label: '仇恨言论', desc: '针对群体的仇视与煽动' },
  { key: 'safetySexual', group: 'safety', type: 'enum', default: 'default', options: SAFETY_OPTIONS, optionLabels: SAFETY_LABELS,
    label: '色情内容' },
  { key: 'safetyDangerous', group: 'safety', type: 'enum', default: 'default', options: SAFETY_OPTIONS, optionLabels: SAFETY_LABELS,
    label: '危险内容', desc: '教唆或协助危险、违法行为' },
]);

export const VERTEX_SETTING_BY_KEY = Object.freeze(Object.fromEntries(VERTEX_SETTINGS.map((s) => [s.key, s])));

/** 默认值表。 */
export function vertexSettingDefaults() {
  return Object.fromEntries(VERTEX_SETTINGS.map((s) => [s.key, s.default]));
}

/** 校验单个值：{ ok:true, value } | { ok:false, error }。 */
export function normalizeVertexSetting(key, v) {
  const s = VERTEX_SETTING_BY_KEY[key];
  if (!s) return { ok: false, error: '未知设置项：' + key };
  if (s.type === 'bool') return typeof v === 'boolean' ? { ok: true, value: v } : { ok: false, error: s.label + '：应为开或关' };
  if (s.type === 'enum') return s.options.includes(v) ? { ok: true, value: v } : { ok: false, error: s.label + '：不认识的选项 ' + String(v) };
  return { ok: false, error: '未知类型' };
}

/** 设置页上这一项显不显示：主项关着的依赖项、这台服务器上没有的 agent 那一行都不显示。 */
export function vertexSettingVisible(key, values, agentIds) {
  const s = VERTEX_SETTING_BY_KEY[key];
  if (!s) return false;
  if (s.dependsOn && !values[s.dependsOn]) return false;
  if (s.agent && Array.isArray(agentIds) && !agentIds.includes(s.agent)) return false;
  return true;
}

// 媒体种类 ↔ 开关键（工具名、操作名都归到这四种）
export const VERTEX_KIND_KEY = Object.freeze({ image: 'agentImage', speech: 'agentSpeech', music: 'agentMusic', video: 'agentVideo' });
// 调用方 ↔ 开关键：'claude' 是 Claude 的媒体工具；同机实例按自报名；'api' 是拿 agent 密钥来的外部调用
export const VERTEX_CALLER_KEY = Object.freeze({ claude: 'claudeMedia', dimensio: 'dimensioMedia', codex: 'codexMedia', api: 'apiMedia' });

// 安全阈值 → Vertex 的 HarmBlockThreshold；'default' = 不发这一类，跟 Google 的默认
export const SAFETY_THRESHOLD = Object.freeze({ off: 'OFF', high: 'BLOCK_ONLY_HIGH', medium: 'BLOCK_MEDIUM_AND_ABOVE', low: 'BLOCK_LOW_AND_ABOVE' });
export const SAFETY_CATEGORY = Object.freeze({
  safetyHarassment: 'HARM_CATEGORY_HARASSMENT',
  safetyHate: 'HARM_CATEGORY_HATE_SPEECH',
  safetySexual: 'HARM_CATEGORY_SEXUALLY_EXPLICIT',
  safetyDangerous: 'HARM_CATEGORY_DANGEROUS_CONTENT',
});
