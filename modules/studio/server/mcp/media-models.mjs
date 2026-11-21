// list_media_models 工具的内容：这个人能用的媒体模型（Media Studio 目录）压成给 Claude 读的紧凑文本。
// 不给 key = 按种类列模型（键、名字、服务、能收的素材、参数键）；给 key = 这一个模型的完整参数说明（取值、默认、生效条件），配音模型带音色。
// 手机版与桌面版共用（桌面版 owner 固定 'admin'）。只读，不花钱；音色列表可能现问一次上游（只读接口）。

import { publicDispatcher } from '@bridge/core/runtime/public-net.mjs';
import { catalog, resolveKey, resolvedModel } from '../catalog.mjs';
import { ensureSchema } from '../discovery/index.mjs';
import { adapterFor } from '../adapters/index.mjs';
import { providerSecret, isMemberOwner } from '../providers.mjs';

const KIND_NAME = { image: '图像', video: '视频', speech: '配音', music: '音乐' };
const KINDS = Object.keys(KIND_NAME);
const ROLE_NAME = { edit: '改图', ref: '参考图', first: '首帧', last: '尾帧' };

// 素材：images.roles + 张数上限；参考音频 / 视频；负面提示词
function inputsLine(inp = {}) {
  const out = [];
  const img = inp.images;
  if (img && Array.isArray(img.roles) && img.roles.length) out.push(img.roles.join('/') + (img.max > 1 ? ' 共≤' + img.max + ' 张' : ''));
  if (inp.video) out.push('video' + (inp.video.max ? '≤' + inp.video.max : ''));
  if (inp.audio) out.push('audio' + (inp.audio.max ? '≤' + inp.audio.max : ''));
  return out.join('，');
}

const cond = (when) => Object.entries(when || {}).map(([k, v]) => k + '=' + (Array.isArray(v) ? v.join('/') : String(v))).join(' 且 ');
const val = (v) => (v === '' ? '""' : typeof v === 'string' ? v : JSON.stringify(v));

// 选项的显示名：和取值一样（1024x1024 / 1024×1024）就不写；以取值打头（「Zephyr · 明亮」）只留后半
function optLabel(o) {
  if (o.label == null) return '';
  const v = String(o.value), l = String(o.label);
  if (l === v || l.replace(/×/g, 'x') === v) return '';
  if (v && l.startsWith(v)) { const rest = l.slice(v.length).replace(/^[\s·:：-]+/, ''); return rest ? '=' + rest : ''; }
  return '=' + l;
}

// 一条 ParamSpec → 一行说明。same：同一张卡里取值表一样的参数（双人对白的 voiceA / voiceB）只写「同 voice」
function paramLine(s, same) {
  const head = s.key + (s.label && s.label !== s.key ? '（' + s.label + '）' : '');
  let body = '';
  const sig = Array.isArray(s.options) && s.options.length > 8 ? JSON.stringify(s.options.map((o) => o.value)) : '';
  if (sig && same && same.has(sig)) body = '取值同 ' + same.get(sig);
  else if (Array.isArray(s.options) && s.options.length) {
    if (sig && same) same.set(sig, s.key);
    body = s.options.map((o) => {
      const lab = optLabel(o);
      const only = o.only && !Array.isArray(o.only) && typeof o.only === 'object' ? '[仅 ' + cond(o.only) + ']' : '';
      return val(o.value) + lab + only + (o.rejected ? '[被上游拒过]' : '');
    }).join(' | ');
  } else if (s.type === 'bool') body = 'true / false';
  else if (s.type === 'json') body = 'JSON 对象，原样合并进请求体';
  else if (s.type === 'text') body = '文本';
  else if (s.min != null || s.max != null) body = (s.min ?? '') + '–' + (s.max ?? '') + (s.integer || s.type === 'seed' ? ' 整数' : '') + (s.unit ? ' ' + s.unit : '');
  else body = s.type;
  if (s.type === 'size' && s.custom) {
    const c = s.custom, w = c.width || {}, h = c.height || {};
    body += '；也可自定义 "宽x高"（宽 ' + (w.min ?? '') + '–' + (w.max ?? '') + '、高 ' + (h.min ?? '') + '–' + (h.max ?? '') + (w.multipleOf ? '、' + w.multipleOf + ' 的倍数' : '') + '）';
  }
  const tail = [];
  if (s.default !== undefined && s.default !== '') tail.push('默认 ' + val(s.default));
  if (s.when) tail.push('仅当 ' + cond(s.when));
  if (s.desc && String(s.desc) !== body) tail.push(String(s.desc));
  return '- ' + head + '：' + body + (tail.length ? '；' + tail.join('；') : '');
}

function summaryLine(m, groupName, isDefault) {
  const keys = (m.params || []).map((s) => s.key);
  const inp = inputsLine(m.inputs);
  return '- ' + m.key + ' · ' + m.label + ' · ' + groupName + (isDefault ? ' · 【默认】' : '')
    + (inp ? ' · 素材 ' + inp : ' · 只收文字')
    + (m.inputs?.negative ? ' · 收 negative' : '')
    + (keys.length ? ' · 参数 ' + keys.join(' ') : '')
    + (m.priceHint ? ' · ' + m.priceHint : '');
}

async function voicesOf(hit) {
  const a = adapterFor(hit.provider.dialect);
  if (typeof a.voices !== 'function') return null;
  try {
    const v = await a.voices(hit.provider, {
      secret: providerSecret(hit.provider), signal: AbortSignal.timeout(20_000),
      dispatcher: isMemberOwner(hit.provider.owner) ? publicDispatcher() : undefined,
    }, hit.entry.id);
    return Array.isArray(v) && v.length ? v : null;
  } catch { return null; }
}

/**
 * opts.kinds：允许列的种类（管理员关掉的不列）。回一段文本。
 */
export async function mediaModelsText(owner, { kind, key, q } = {}, { kinds = KINDS } = {}) {
  if (key) {
    const hit = resolveKey(String(key), owner);
    if (!hit || !kinds.includes(hit.entry.kind)) return '找不到这个模型「' + key + '」（键写错了、服务被停用 / 删除，或模型关掉了）。不带 key 调用可以列出全部可用模型。';
    try { await ensureSchema(owner, hit.provider, hit.entry); } catch {}
    const m = resolvedModel(hit.provider, hit.entry, owner);
    const lines = [m.key + ' · ' + m.label + ' · ' + KIND_NAME[m.kind] + ' · 服务「' + hit.provider.name + '」'];
    if (m.desc) lines.push(m.desc);
    const inp = inputsLine(m.inputs);
    lines.push('素材（inputs 的 role）：' + (inp || '不收，只收文字') + (m.inputs?.multiTurn === false ? '；没有多轮上下文，continueFrom 续改时拿上一张当参考图' : ''));
    lines.push('负面提示词（negative）：' + (m.inputs?.negative ? '收' : '不收'));
    if (m.priceHint) lines.push('价格：' + m.priceHint);
    if (m.generic) lines.push('（这是通用参数卡：服务没报参数，常用参数不一定生效，可用 extra 原样传上游参数）');
    lines.push('参数（放进 params，键名照写；不传 = 用默认；「仅当」= 只在那个条件下生效，$edit/$first/$last/$ref = 有改图/首帧/尾帧/参考图素材）：');
    const same = new Map();
    for (const s of m.params || []) lines.push(paramLine(s, same));
    if (m.kind === 'speech') {
      const v = await voicesOf(hit);
      // 卡上的音色表已经列过（Gemini TTS）就不再重复；ElevenLabs 这类按账号拉的音色才另列
      const listed = (m.params || []).some((s) => s.type === 'voice' && Array.isArray(s.options) && s.options.length);
      if (v && !listed) lines.push('音色（params.voice 或 voice）：' + v.slice(0, 120).map((x) => x.id + (x.label && x.label !== x.id ? '=' + x.label : '')).join(' | ') + (v.length > 120 ? ' …共 ' + v.length + ' 个' : ''));
    }
    return lines.join('\n');
  }

  const c = catalog(owner);
  const needle = q ? String(q).toLowerCase() : '';
  const hitQ = (m) => !needle || String(m.key).toLowerCase().includes(needle) || String(m.label || '').toLowerCase().includes(needle);
  const out = [];
  for (const k of KINDS) {
    if (!kinds.includes(k) || (kind && kind !== k)) continue;
    const { defaults, groups } = c.kinds[k] || { groups: [] };
    const defKey = defaults ? defaults.provider + '/' + defaults.model : '';
    const lines = [];
    let shelfLeft = 0;
    for (const g of groups) {
      for (const m of g.models) if (hitQ(m)) lines.push(summaryLine(m, g.provider.name, m.key === defKey));
      const shelf = g.shelf || [];
      if (needle) for (const m of shelf) { if (hitQ(m)) lines.push('- ' + m.key + ' · ' + m.label + ' · ' + g.provider.name + ' · 备选（参数用 key 查）'); }
      else shelfLeft += shelf.length;
    }
    if (!lines.length && needle) continue;
    out.push('【' + KIND_NAME[k] + '】默认 ' + (defKey || '无'));
    out.push(...(lines.length ? lines : ['- （没有可用的模型：设置 › Media Studio 里加服务）']));
    if (shelfLeft) out.push('  另有 ' + shelfLeft + ' 个备选模型没列出，按名字搜传 q。');
  }
  if (!out.length) return needle ? '没有名字或键里含「' + q + '」的模型。' : '没有可用的媒体模型。';
  out.push('', '生成工具的 model 传上面的键（服务 id/模型 id）。要看某个模型的参数取值、默认值和音色，带 key 再调一次。');
  return out.join('\n');
}
