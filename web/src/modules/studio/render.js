// 参数渲染器的纯逻辑（方案 §9.2「参数坞 / 参数浮层」+ §9.3 ParamSpec 增量）：每个参数用哪种控件、怎么分组、值怎么写。
// 目标：任意来源（内置卡 / 上游 schema / 同族继承 / 通用卡）、任意多个参数都排得好看——前端不再靠模型 id 或值的样子硬猜，
// 有 format 就按 format，没有才看 key / 值兜底。纯函数，有单测（studio.test.js）。
//
//   ParamSpec 增量：unit?: 's'|'px'|'%' · desc?（不上正文，悬停 / 长按标签才出）· format?: 'aspect'|'resolution'|'duration'|'size'|'count'
//                   · options[].hint?（菜单里行尾的一小段，比如价格档）
import { optionsOf, visibleSpec } from './params.js';
import { parseSize, isCustomSize, sizeText } from './size.js';

const RATIO = /^\d+(?:\.\d+)?:\d+(?:\.\d+)?$/;
export const isRatio = (v) => RATIO.test(String(v ?? ''));

/** 渲染提示：只看 spec.format（§9.3 落地澄清：schema 卡的键是上游原名、内置卡是 aspectRatio 这类，别按键名猜）。
 *  没写 format 的老服务端只认一种：选项几乎全是「16:9」这样的比值 → 比例。 */
export function formatOf(spec) {
  if (spec?.format) return spec.format;
  const opts = spec?.options || [];
  const ratioOpts = opts.filter((o) => isRatio(o.value)).length;
  if (ratioOpts >= 2 && ratioOpts >= opts.length - 2) return 'aspect';
  return '';
}

// 12px 字大约多宽（px）：中日韩 12、数字与大写 7、空格 3.5、其余 6.3——分段放不放得下按它估（数字按 1 单位估会偏窄：480p / 720p / 1080p 估得下、实际被切）
export const textPx = (s) => [...String(s ?? '')].reduce((n, c) => n + (c.charCodeAt(0) > 0x2e80 ? 12 : /[0-9A-Z]/.test(c) ? 7 : c === ' ' ? 3.5 : 6.3), 0);

/**
 * 每个参数用哪种控件（方案 §11：选项尽量直接摆出来，一步点到，不再「点选择钮 → 再弹一层菜单」）：
 *   seg     ≤4 项的短枚举（右栏宽度放得下才用）· pills 选项直接摆成一排排小块（≤10 项、每项不太长；标签在上、选项在下）
 *   aspect  比例小形状格 · select 选择钮 + 菜单（只留给项多 / 标签长的；>12 项菜单带搜索）
 *   steps   小范围整数（1–4 这类）→ 分段 · stepper 张数这类整数（− 3 +）· slider 有上下限的数值（滑条 + 可直接改的数字框）
 *   number  没上下限的数值 · switch 开关 · seed 种子 · voice 音色 · text 单行 · textarea 多行 · json 原始参数
 *   size    尺寸（方案 §10 / §11）：自动 / 原图 + 比例 × 档位格 + 一直在的宽 × 高
 * @param labelOf (opt) → 显示文字（界面先过 tr()）
 * @param room 右侧控件列大约多宽（px）：参数坞里实测约 142，各端用同一个数，控件不随设备变
 */
export const PILLS_MAX = 10;
export function controlOf(spec, opts = [], { labelOf = (o) => String(o.label ?? o.value), room = 140 } = {}) {
  switch (spec?.type) {
    case 'size': return 'size';
    case 'bool': return 'switch';
    case 'seed': return 'seed';
    case 'voice': return 'voice';
    case 'json': return 'json';
    case 'text': return spec.multiline ? 'textarea' : 'text';
    case 'number': {
      if (spec.min == null || spec.max == null) return 'number';
      const step = spec.step || 1;
      const n = Math.round((spec.max - spec.min) / step) + 1;
      if (Number.isInteger(step) && n >= 2 && n <= 5 && formatOf(spec) !== 'duration') return 'steps';
      if (formatOf(spec) === 'count' && Number.isInteger(step) && n <= 64) return 'stepper';
      return 'slider';
    }
    case 'enum': {
      if (formatOf(spec) === 'aspect' && opts.some((o) => isRatio(o.value))) return 'aspect';
      if (!opts.length) return 'select';
      // 分段：最多 4 项，按字宽估每项（textPx + 左右内距 16，槽内距 6）总宽放得下；估错了还有实测兜底（Segmented onoverflow）
      const ws = opts.map((o) => textPx(labelOf(o)));
      if (opts.length <= 4 && ws.reduce((s, w) => s + w + 16, 6) <= room) return 'seg';
      // 小块：≤10 项、单项不超过半行、总共不超过三行左右（每行约 260）——再多再长才收进菜单
      if (opts.length <= PILLS_MAX && Math.max(...ws) <= 132 && ws.reduce((s, w) => s + w + 28, 0) <= 780) return 'pills';
      return 'select';
    }
    default: return 'text';
  }
}

/** 选择菜单要不要搜索框 */
export const needsSearch = (opts) => (opts?.length || 0) > 12;

/** 在选项里搜（标签、值、hint 都算；不分大小写、忽略空格） */
export function searchOptions(opts, q, labelOf = (o) => String(o.label ?? o.value)) {
  const s = String(q || '').toLowerCase().replace(/\s+/g, '');
  if (!s) return opts;
  return opts.filter((o) => [labelOf(o), o.value, o.hint].some((x) => String(x ?? '').toLowerCase().replace(/\s+/g, '').includes(s)));
}

// 搜索命中在选项名里的那一段（加粗用）：返回 [前, 中, 后]；名字里没命中（命中的是原值或 hint）就 null
export function hitParts(label, q) {
  const s = String(q || '').trim().toLowerCase();
  const l = String(label ?? '');
  const i = s ? l.toLowerCase().indexOf(s) : -1;
  return i < 0 ? null : [l.slice(0, i), l.slice(i, i + s.length), l.slice(i + s.length)];
}

// 比例格：前 8 个常用的直接摆，其余收进「更多比例」（选中值在后面时自动展开）
const COMMON = ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '21:9', '4:5', '5:4', '9:21'];
export function aspectSplit(opts, value) {
  const named = opts.filter((o) => !isRatio(o.value));          // 「自动」「默认」这类
  const ratios = opts.filter((o) => isRatio(o.value));
  const rank = (o) => { const i = COMMON.indexOf(String(o.value)); return i < 0 ? 100 : i; };
  const sorted = [...ratios].sort((a, b) => rank(a) - rank(b));
  let cap = Math.max(0, 8 - named.length);
  if (sorted.length > cap) cap = Math.max(0, cap - 1);
  const head = [...named, ...sorted.slice(0, cap)];
  const more = sorted.slice(cap);
  return { head, more, open: more.some((o) => o.value === value) };
}

// 基本组按语义排：比例 → 分辨率 / 尺寸 → 画质 → 时长 → 张数 → 其余（schema 卡按上游字段顺序给，Seedance 会把时长排在比例前）
const BASIC_RANK = { aspect: 0, resolution: 1, size: 1, duration: 3, count: 4 };
const basicRank = (s) => BASIC_RANK[formatOf(s)] ?? (/quality/i.test(s.key || '') ? 2 : 5);
// 「更多」组保留接口给的顺序（成对的参数挨着：格式 · 压缩率、说话人 A · A 的音色；按控件种类排会把它们拆开，复核 11-06 第二轮），
// 只有原始参数（json）永远最末
const advRank = (s) => (s.type === 'json' ? 1 : 0);
const sortBy = (arr, rank) => arr.map((s, i) => [s, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([s]) => s);

/** 分组：basic（按语义排）→ advanced（接口顺序，json 收到这一组最末）；when 不满足的不出。
 *  basic 为空时 advanced 的东西照样排在一组里（只有一组就不写组名，见 ParamsList） */
export function paramGroups(specs, values) {
  const vis = (specs || []).filter((s) => visibleSpec(s, values));
  const basic = sortBy(vis.filter((s) => s.group !== 'advanced' && s.type !== 'json'), basicRank);
  const adv = sortBy(vis.filter((s) => s.group === 'advanced' || s.type === 'json'), advRank);
  return [{ id: 'basic', specs: basic }, { id: 'advanced', specs: adv }].filter((g) => g.specs.length);
}

// —— 「翻译」一层：自动识别出来的名字和值原样上屏会像接口文档（复核 11-06）——
/** 参数名：去掉括号里的说明（「Safety tolerance (lower is stricter…)」→「Safety tolerance」），说明进 desc 的悬停 / 长按 */
export function cleanLabel(s) {
  const t = String(s ?? '').replace(/\s*[（(][^()（）]*[)）]\s*$/, '').replace(/[\s:：,，.。]+$/, '').trim();
  return t || String(s ?? '');
}
// 常见枚举值 → 界面词的表在 words.js（要过 t()，这里保持纯函数）；单测直接传一张表
const AUDIO_FMT = /^(mp3|pcm|wav|opus|ulaw|alaw|flac|aac|ogg|mulaw)_(\d{4,6})(?:_(\d{2,3}))?$/i;
/** 枚举项的显示文字：后端给了跟值不一样的 label 就用它；否则把值整理成人话。
 *  words：常见词表（界面传 words.js 的 valueWords()，键是小写原值，'' = 默认） */
export function humanValue(o, words = {}) {
  const v = o?.value;
  const lab = o?.label;
  if (lab != null && lab !== '' && String(lab) !== String(v)) return String(lab);
  if (v === '' || v == null) return words[''] ?? 'Default';
  const s = String(v);
  const w = words[s.toLowerCase()];
  if (w) return w;
  const af = AUDIO_FMT.exec(s);
  if (af) {
    const hz = Number(af[2]);
    const khz = (hz / 1000).toFixed(hz % 1000 ? 1 : 0).replace(/\.0$/, '') + 'kHz';
    return [af[1].toUpperCase(), khz, af[3] ? af[3] + 'k' : ''].filter(Boolean).join(' · ');
  }
  if (/^[a-z][a-z0-9]*([_-][a-z0-9]+)+$/i.test(s) || /^[a-z]+$/.test(s)) {
    const words = s.split(/[_-]+/);
    return words.map((x, i) => (i === 0 ? x[0].toUpperCase() + x.slice(1) : x)).join(' ');
  }
  return s;
}

const UNIT = { s: 's', px: 'px', '%': '%', ms: 'ms' };
/** 数值的显示（mono）：按 step 的小数位，带单位 */
export function fmtNumber(spec, v) {
  if (v == null || v === '' || !Number.isFinite(Number(v))) return '';
  const n = Number(v);
  const dp = spec?.step && spec.step < 1 ? (String(spec.step).split('.')[1]?.length || 2) : 0;
  const s = dp ? n.toFixed(dp) : String(Math.round(n * 1000) / 1000);
  const u = UNIT[spec?.unit] || spec?.unit || (formatOf(spec) === 'duration' ? 's' : '');
  return u ? (u === '%' ? s + '%' : s + ' ' + u) : s;
}

/** 输入框底行的「值芯片」（方案 §11）：基本参数**每一项都出**，默认值也出（以前默认项不占芯片，结果「画质 高」在、「尺寸」不在，看不出规律）。
 *  回显示的值文字；不适合上芯片的（种子、文本、json、没上下限的数值、没选的音色）回 null；开关回 ''（芯片只写名字，开没开看样式）。
 *  labelOf 给枚举项的显示文字。 */
export function chipValue(spec, v, { labelOf = (o) => String(o.label ?? o.value), modelId = '', values = {} } = {}) {
  switch (spec?.type) {
    case 'size': {
      if (isCustomSize(v)) { const s = parseSize(v); return s ? sizeText(s) : null; }
      const o = optionsOf(spec, modelId, values).find((x) => x.value === v) || (spec.options || []).find((x) => x.value === v);
      return o ? labelOf(o) : null;
    }
    case 'enum': {
      const o = optionsOf(spec, modelId, values).find((x) => x.value === v) || (spec.options || []).find((x) => x.value === v);
      return o ? labelOf(o) : null;
    }
    case 'number':
      if (spec.min == null || spec.max == null || v == null) return null;   // 没设置的数值不占芯片
      return formatOf(spec) === 'count' ? '×' + fmtNumber({ ...spec, unit: '' }, v) : fmtNumber(spec, v);   // 张数：「×2」，光一个「2」看不出是什么
    case 'bool': return '';
    case 'voice': return v ? String(v) : null;
    default: return null;
  }
}
/** 值自己说得清是什么（「16:9」「2K」「1080p」「8 秒」「×2」「2048×1152」）：芯片只写值；说不清的（「自动」「默认」「高」）前面带淡色参数名 */
export const selfExplaining = (spec, text = '') => !!formatOf(spec) && /\d/.test(String(text));

/** 一个参数现在是不是改过（和默认值不一样） */
export const isChanged = (v, d) => JSON.stringify(v ?? null) !== JSON.stringify(d ?? null);
