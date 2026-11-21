// Antigravity 分页能力目录归一：模型按系列分组、按当前模型动态裁剪思考档位、运行模式元数据与斜杠命令过滤。

import { t } from '../i18n.js';

export function flattenSelectOptions(opt) {
  const out = [];
  for (const item of (opt?.options || [])) {
    if (Array.isArray(item?.options)) {
      const groupName = item.group || item.name || '';
      for (const sub of item.options) {
        if (sub && sub.value !== undefined) {
          out.push({
            id: String(sub.value),
            name: String(sub.name || sub.label || sub.value),
            description: String(sub.description || ''),
            group: groupName,
          });
        }
      }
    } else if (item && item.value !== undefined) {
      out.push({
        id: String(item.value),
        name: String(item.name || item.label || item.value),
        description: String(item.description || ''),
        group: '',
      });
    }
  }
  return out;
}

const KNOWN_MODEL_NAMES = Object.freeze({
  'antigravity-orchestrator': 'Antigravity Orchestrator',
  'gemini-4-neon': 'Gemini 4 Neon',
  'gemini-4-hydrogen': 'Gemini 4 Hydrogen',
  'gemini-4-carbon': 'Gemini 4 Carbon',
  'gemini-4-argon': 'Gemini 4 Argon',
  'gemini-pro-orchestrator': 'Orchestrator (Carbon)',
  'gemini-pro-orchestrator-neon': 'Orchestrator (Neon)',
  'gemini-pro-orchestrator-argon': 'Orchestrator (Argon)',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
  'gemini-3-8-flash': 'Gemini 3.8 Flash',
  'claude-opus-4-6-thinking': 'Claude Opus 4.6 (Thinking)',
  'claude-opus-4-6': 'Claude Opus 4.6',
  'claude-sonnet-4-6-thinking': 'Claude Sonnet 4.6 (Thinking)',
  'claude-sonnet-4-6': 'Claude Sonnet 4.6',
  'gpt-oss-120b': 'GPT-OSS 120B',
});

const AGY_MODEL_EFFORT_RE = /^(.*?)(?:-(?:tiered|thinking))?-(xhigh|high|medium|low|max|minimal)$/i;

/** 把 agy 转录里的原始模型 ID（如 gemini-4-hydrogen-tiered-high / gemini-4-neon-xhigh）拆成显示名与思考强度。 */
export function parseAgyModelAndEffort(rawModel = '', flatCatalog = [], { short = true } = {}) {
  const raw = String(rawModel || '').trim();
  if (!raw) return { raw: '', modelId: '', modelName: '', effort: '' };
  const m = AGY_MODEL_EFFORT_RE.exec(raw);
  const modelId = m && m[1] ? m[1].replace(/-tiered$/i, '') : raw;
  const effort = m && m[2] ? m[2].toLowerCase() : '';
  return {
    raw,
    modelId,
    modelName: modelDisplayName(modelId, flatCatalog, { short }),
    effort,
  };
}

// 统一模型显示名解析：优先取在线目录名，其次查已知映射并将带连字符的内部 ID 转为规范人类可读名
export function modelDisplayName(id = '', flatCatalog = [], { short = false } = {}) {
  const raw = String(id || '').trim();
  if (!raw) return '';
  let label = Array.isArray(flatCatalog)
    ? (flatCatalog.find((m) => m && m.id === raw)?.name || '')
    : '';
  if (!label) label = KNOWN_MODEL_NAMES[raw.toLowerCase()] || '';
  if (!label) {
    if (raw.includes(' ') || !raw.includes('-')) {
      label = raw;
    } else {
      const thinking = /-thinking$/i.test(raw);
      const base = raw.replace(/-thinking$/i, '');
      const formatted = base
        .replace(/^gpt-oss-(\d+b)$/i, (_, sz) => `GPT-OSS ${sz.toUpperCase()}`)
        .replace(/^(claude-(?:opus|sonnet|haiku))-(\d+)-(\d+)$/i, (_, head, maj, min) => `${head}-${maj}.${min}`)
        .replace(/^gemini-(\d+)-(\d+)-(.*)$/i, (_, maj, min, rest) => `gemini-${maj}.${min}-${rest}`)
        .split('-')
        .map((seg) => (/^gpt$/i.test(seg) ? 'GPT' : /^oss$/i.test(seg) ? 'OSS' : seg.charAt(0).toUpperCase() + seg.slice(1)))
        .join(' ');
      label = thinking ? `${formatted} (Thinking)` : formatted;
    }
  }
  return short ? label.replace(/\s*\(Thinking\)/i, '') : label;
}

export function modelSeriesOf(id = '', explicitGroup = '') {
  if (explicitGroup) return explicitGroup;
  const lower = String(id).toLowerCase();
  if (lower.startsWith('gemini-4') || lower.includes('orchestrator')) return 'Gemini 4';
  if (lower.startsWith('gemini-3')) return 'Gemini 3.8';
  if (lower.includes('claude')) return 'Claude';
  if (lower.includes('gpt')) return 'GPT-OSS';
  return t('其他模型');
}

export function modelDescriptionOf() {
  return '';
}

export function groupModels(configOptions = [], fallbackModels = []) {
  const modelOpt = (Array.isArray(configOptions) ? configOptions : [])
    .find((c) => c && (c.id === 'model' || c.category === 'model'));
  let items = flattenSelectOptions(modelOpt);
  if (!items.length && Array.isArray(fallbackModels)) {
    items = fallbackModels.map((m) => ({
      id: String(m.id || m.value),
      name: String(m.name || m.label || m.id),
      description: '',
      group: '',
    }));
  }

  const order = ['Gemini 4', 'Gemini 3.8', 'Claude', 'GPT-OSS', t('其他模型')];
  const buckets = new Map();
  for (const m of items) {
    const series = modelSeriesOf(m.id, m.group);
    if (!buckets.has(series)) buckets.set(series, []);
    buckets.get(series).push({
      id: m.id,
      name: m.name,
      series,
      description: modelDescriptionOf(m.id, m.description),
    });
  }

  const groups = [];
  for (const key of order) {
    if (buckets.has(key)) {
      groups.push({ series: key, models: buckets.get(key) });
      buckets.delete(key);
    }
  }
  for (const [series, models] of buckets.entries()) {
    groups.push({ series, models });
  }

  return {
    current: modelOpt?.currentValue ? String(modelOpt.currentValue) : (items[0]?.id || ''),
    flat: groups.flatMap((g) => g.models),
    groups,
  };
}

// 思考档位展示保持真实调用名（low / medium / high / xhigh），不翻成中文
export function thoughtLabelOf(val = '') {
  return String(val || '').trim().toLowerCase();
}

// 在线会话已有 configOptions 时严格以 ACP 返回的 thought_level 项为准（不支持的模型不返回该项）；
// 新对话尚未握手时按 capabilities 里该模型的 efforts 列表动态裁剪。
export function extractThoughtOptions(configOptions = [], fallbackEfforts = [], selectedModel = '', fallbackModels = []) {
  const hasLiveConfig = Array.isArray(configOptions) && configOptions.length > 0;
  const opt = hasLiveConfig
    ? configOptions.find((c) => c && (c.id === 'thought_level' || c.category === 'thought_level'))
    : null;

  if (hasLiveConfig) {
    const liveModel = configOptions.find((c) => c && (c.id === 'model' || c.category === 'model'))?.currentValue || '';
    // 若用户在已有会话上刚点了另一个模型而服务端新 configOptions 尚未回包，按目标模型裁剪避免闪旧档位
    if (!selectedModel || !liveModel || selectedModel === liveModel) {
      if (!opt) return { current: '', options: [] };
      const list = flattenSelectOptions(opt).map((o) => ({
        id: o.id,
        name: thoughtLabelOf(o.id),
        rawName: o.name,
      }));
      return {
        current: opt.currentValue ? String(opt.currentValue) : (list[0]?.id || ''),
        options: list,
      };
    }
  }

  const modelMeta = Array.isArray(fallbackModels) && selectedModel
    ? fallbackModels.find((m) => m && m.id === selectedModel)
    : null;
  if (modelMeta && Array.isArray(modelMeta.efforts)) {
    if (!modelMeta.efforts.length) return { current: '', options: [] };
    const allow = new Set(modelMeta.efforts);
    const base = (Array.isArray(fallbackEfforts) && fallbackEfforts.length)
      ? fallbackEfforts.filter((e) => allow.has(e.id))
      : modelMeta.efforts.map((id) => ({ id, name: id }));
    const list = base.map((e) => ({
      id: String(e.id),
      name: thoughtLabelOf(e.id),
      rawName: String(e.name || e.id),
    }));
    return { current: list.find((x) => x.id === 'medium')?.id || list[0]?.id || '', options: list };
  }

  const list = (Array.isArray(fallbackEfforts) ? fallbackEfforts : []).map((e) => ({
    id: String(e.id),
    name: thoughtLabelOf(e.id),
    rawName: String(e.name || e.id),
  }));
  return {
    current: list.find((x) => x.id === 'medium')?.id || list[0]?.id || 'medium',
    options: list,
  };
}

export function modeMetaOf(id = '') {
  const v = String(id).toLowerCase();
  if (v === 'bypass') {
    return { label: t('完全放行'), desc: '' };
  }
  if (v === 'accept-edits' || v === 'accept_edits') {
    return { label: t('接受编辑'), desc: '' };
  }
  if (v === 'auto') {
    return { label: t('自动'), desc: '' };
  }
  if (v === 'plan') {
    return { label: t('计划'), desc: '' };
  }
  if (v === 'request-review' || v === 'request_review') {
    return { label: t('逐项确认'), desc: '' };
  }
  if (v === 'turbo') {
    return { label: 'Turbo', desc: '' };
  }
  return { label: t('默认'), desc: '' };
}

export function extractModeOptions(configOptions = [], modes = null, fallbackModes = []) {
  const opt = (Array.isArray(configOptions) ? configOptions : [])
    .find((c) => c && (c.id === 'mode' || c.category === 'mode'));
  let rawList = flattenSelectOptions(opt);
  if (!rawList.length && Array.isArray(modes?.availableModes)) {
    rawList = modes.availableModes.map((m) => ({
      id: String(m.id),
      name: String(m.name || m.id),
      description: String(m.description || ''),
    }));
  }
  if (!rawList.length && Array.isArray(fallbackModes)) {
    rawList = fallbackModes.map((m) => ({
      id: String(m.id),
      name: String(m.name || m.id),
      description: '',
    }));
  }
  // 「完全放行」是 bridge 自己加的模式（服务端对 agy 设 auto + 自动允许审批）；目录里没带就按 auto 是否存在补上
  if (rawList.some((m) => m.id === 'auto') && !rawList.some((m) => m.id === 'bypass')) {
    rawList = [...rawList, { id: 'bypass', name: 'bypass', description: '' }];
  }
  const options = rawList.map((m) => {
    const meta = modeMetaOf(m.id);
    return {
      id: m.id,
      name: meta.label,
      description: meta.desc,
    };
  });
  const current = opt?.currentValue
    ? String(opt.currentValue)
    : (modes?.currentModeId ? String(modes.currentModeId) : (options[0]?.id || 'default'));
  return { current, options };
}

export function filterSlashCommands(commands = [], inputText = '') {
  const raw = String(inputText ?? '');
  if (!raw.startsWith('/')) return [];
  if (raw.includes('\n')) return [];
  const afterSlash = raw.slice(1);
  if (/\s/.test(afterSlash)) return [];

  const needle = afterSlash.toLowerCase();
  const list = Array.isArray(commands) ? commands : [];
  const scored = [];
  for (const cmd of list) {
    if (!cmd || !cmd.name) continue;
    const name = String(cmd.name).replace(/^\/+/, '');
    const desc = String(cmd.description || '');
    const hint = String(cmd.input?.hint || cmd.argumentHint || '');
    const lower = name.toLowerCase();
    if (!needle) {
      scored.push({ name, description: desc, hint, rank: 1 });
    } else if (lower.startsWith(needle)) {
      scored.push({ name, description: desc, hint, rank: 0 });
    } else if (lower.includes(needle) || desc.toLowerCase().includes(needle)) {
      scored.push({ name, description: desc, hint, rank: 2 });
    }
  }
  scored.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return scored.slice(0, 12);
}
