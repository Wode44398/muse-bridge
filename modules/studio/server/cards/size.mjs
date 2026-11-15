// 尺寸能力（方案 §10）：ParamSpec type:'size' 的取值、校验、「原图」适配与上游编码。
//
// size 参数 = 字符串档（options 里的：''=不传、'auto'、'original'、'1K'、'1024x1024' 这类预设）或自由宽高 { width, height }。
// spec.custom 描述自由宽高的规则（没有就不收自由宽高）：
//   { width: { min, max, multipleOf }, height: { min, max, multipleOf }, aspect: { min, max }（宽 / 高）, pixels: { min, max }, exact }
//   exact:false = 上游会就近取整（如 Qwen 编辑取 16 的倍数），只校验范围不校验倍数。
// spec.encode：上游怎么收自由宽高——'x'（'2048x1152'，默认）/ '*'（'2048*1152'）/ 'object'（{ width, height }）/
//   'split'（拆进 spec.fields = { width: 字段, height: 字段 }）。
// spec.editDefault：有「改这张图」素材时、本次没给值用哪个（一般是 'original'）。前端同一套逻辑在 web/src/modules/studio/size.js。

const SEP = /^\s*(\d{1,5})\s*[x×*X]\s*(\d{1,5})\s*$/;

/** {width,height} / 'WxH' / 'W*H' / 'W×H' → { width, height }（正整数）；别的回 null。 */
export function parseSize(v) {
  if (v && typeof v === 'object' && !Array.isArray(v)) {
    const w = Number(v.width), h = Number(v.height);
    return Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 ? { width: w, height: h } : null;
  }
  if (typeof v === 'string') {
    const m = SEP.exec(v);
    if (m) { const w = Number(m[1]), h = Number(m[2]); if (w > 0 && h > 0) return { width: w, height: h }; }
  }
  return null;
}

/** 一个自由宽高违反了规则的哪些条：[{ code, … }]，空数组 = 合法。 */
export function sizeProblems(rule, s) {
  const out = [];
  if (!rule || !s) return out;
  for (const side of ['width', 'height']) {
    const r = rule[side] || {};
    const v = s[side];
    if (r.min != null && v < r.min) out.push({ code: 'min', side, n: r.min });
    if (r.max != null && v > r.max) out.push({ code: 'max', side, n: r.max });
    if (rule.exact !== false && r.multipleOf > 1 && v % r.multipleOf) out.push({ code: 'multiple', side, n: r.multipleOf });
  }
  const ratio = s.width / s.height;
  const a = rule.aspect;
  if (a && ((a.min != null && ratio < a.min - 1e-9) || (a.max != null && ratio > a.max + 1e-9))) out.push({ code: 'aspect', min: a.min, max: a.max });
  const px = s.width * s.height;
  const p = rule.pixels;
  if (p && ((p.min != null && px < p.min) || (p.max != null && px > p.max))) out.push({ code: 'pixels', min: p.min, max: p.max });
  return out;
}

const ratioText = (x) => (x >= 1 ? `${+x.toFixed(2)}:1` : `1:${+(1 / x).toFixed(2)}`);
const SIDE = { width: '宽', height: '高' };
/** 给人看的一句（服务端 400 用；前端有自己的翻译版）。 */
export function sizeError(rule, s) {
  const p = sizeProblems(rule, s)[0];
  if (!p) return '';
  switch (p.code) {
    case 'min': return `${SIDE[p.side]}不能小于 ${p.n}`;
    case 'max': return `${SIDE[p.side]}不能大于 ${p.n}`;
    case 'multiple': return `宽和高都要是 ${p.n} 的倍数`;
    case 'aspect': return `宽高比要在 ${ratioText(p.min)} 到 ${ratioText(p.max)} 之间`;
    default: return `总像素要在 ${p.min ?? 0} 到 ${p.max ?? '∞'} 之间`;
  }
}

/**
 * 把一个尺寸（原图）挪进规则里：先夹宽高比、再夹总像素、再夹边长，最后落到倍数上（在几个取整组合里挑合法且最接近的）。
 * 回 { width, height, adapted }；规则自相矛盾挪不进去时回最接近的那个（adapted:true，交给上游报错）。
 */
export function fitSize(rule, s) {
  if (!rule) return { ...s, adapted: false };
  if (!sizeProblems(rule, s).length) return { width: s.width, height: s.height, adapted: false };
  let r = s.width / s.height;
  if (rule.aspect?.min != null) r = Math.max(r, rule.aspect.min);
  if (rule.aspect?.max != null) r = Math.min(r, rule.aspect.max);
  let px = s.width * s.height;
  if (rule.pixels?.min != null) px = Math.max(px, rule.pixels.min);
  if (rule.pixels?.max != null) px = Math.min(px, rule.pixels.max);
  let w = Math.sqrt(px * r), h = Math.sqrt(px / r);
  const k = Math.min(1, rule.width?.max ? rule.width.max / w : 1, rule.height?.max ? rule.height.max / h : 1);
  w *= k; h *= k;
  const up = Math.max(1, rule.width?.min ? rule.width.min / w : 1, rule.height?.min ? rule.height.min / h : 1);
  w *= up; h *= up;
  const mw = rule.exact !== false && rule.width?.multipleOf > 1 ? rule.width.multipleOf : 1;
  const mh = rule.exact !== false && rule.height?.multipleOf > 1 ? rule.height.multipleOf : 1;
  const cands = [];
  for (const fw of [Math.floor, Math.ceil, Math.round]) for (const fh of [Math.floor, Math.ceil, Math.round]) {
    const c = { width: Math.max(mw, fw(w / mw) * mw), height: Math.max(mh, fh(h / mh) * mh) };
    cands.push(c);
  }
  const score = (c) => Math.abs(Math.log((c.width / c.height) / (s.width / s.height))) * 4 + Math.abs(Math.log((c.width * c.height) / px));
  const ok = cands.filter((c) => !sizeProblems(rule, c).length).sort((a, b) => score(a) - score(b));
  const best = ok[0] || cands.sort((a, b) => sizeProblems(rule, a).length - sizeProblems(rule, b).length || score(a) - score(b))[0];
  return { width: best.width, height: best.height, adapted: true };
}

/**
 * 按 spec 规范化一个 size 值（applySpecs 用）。回：{ value } 合法；{ drop:true } 不传；坏的自由宽高抛 400。
 * 字符串先认 options，再认能解析成宽高的（「1536x864」「1536*864」）；没有 custom 规则的模型不收自由宽高。
 */
export function normalizeSizeValue(spec, v) {
  const opts = spec.options || [];
  if (typeof v === 'string' || typeof v === 'number') {
    const hit = opts.find((o) => String(o.value) === String(v));
    if (hit) return hit.value === '' ? { drop: true } : { value: hit.value };
  }
  const s = spec.custom ? parseSize(v) : null;
  if (s) {
    const err = sizeError(spec.custom, s);
    if (err) throw Object.assign(new Error(`${spec.label || '尺寸'}：${err}`), { status: 400 });
    return { value: s };
  }
  return null;   // 认不出：交给调用方回落默认值
}

/** 主改图素材（「原图」跟它走）：role edit 的第一张；没有就是续改链上最后一张（这些方言续改拿它当改图对象）。只认图片字节。 */
export function editImageOf(req, { thread = true } = {}) {
  const ed = (req?.inputs || []).find((x) => x.role === 'edit' && x.data);
  if (ed) return ed;
  if (!thread || (req?.inputs || []).some((x) => x.role === 'ref')) return null;
  const turns = req?.thread?.turns || [];
  const last = turns[turns.length - 1];
  return last?.data ? last : null;
}

// PNG / JPEG / WebP 的宽高（不解码）
export function imageDims(buf) {
  try {
    if (!buf || buf.length < 24) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50) return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const fmt = buf.toString('ascii', 12, 16);
      if (fmt === 'VP8X') return [1 + buf.readUIntLE(24, 3), 1 + buf.readUIntLE(27, 3)];
      if (fmt === 'VP8 ') return [buf.readUInt16LE(26) & 0x3fff, buf.readUInt16LE(28) & 0x3fff];
      if (fmt === 'VP8L') { const b = buf.readUInt32LE(21); return [1 + (b & 0x3fff), 1 + ((b >> 14) & 0x3fff)]; }
    }
  } catch {}
  return null;
}

/**
 * 「原图」→ 实际要发的宽高：读主改图素材的像素，按规则适配。没有改图素材 / 读不出宽高 → null（调用方当「自动」处理）。
 * 回 { width, height, adapted, from:{width,height} }。
 */
export function originalSize(rule, req) {
  const img = editImageOf(req);
  const d = img ? imageDims(Buffer.isBuffer(img.data) ? img.data : Buffer.from(img.data || '', 'base64')) : null;
  if (!d || !(d[0] > 0 && d[1] > 0)) return null;
  const from = { width: d[0], height: d[1] };
  return { ...fitSize(rule, from), from };
}

const encodeOne = (spec, s) => {
  switch (spec.encode) {
    case 'object': return { width: s.width, height: s.height };
    case '*': return `${s.width}*${s.height}`;
    default: return `${s.width}x${s.height}`;
  }
};

/**
 * 把参数表里的 size 值编码成上游字段（schema 卡 / 内置卡共用）：'auto' 不传，'original' 换成原图适配后的宽高，
 * 自由宽高按 spec.encode 编码（split 拆进两个字段）；字符串预设原样。回 { body 片段, meta }。
 */
export function encodeSizeParams(specs, params, req) {
  const out = { ...params };
  const meta = {};
  for (const spec of specs || []) {
    if (spec.type !== 'size' || !(spec.key in out)) continue;
    let v = out[spec.key];
    delete out[spec.key];
    if (v === '' || v == null || v === 'auto' && !spec.sendAuto) continue;
    if (v === 'original') {
      const o = originalSize(spec.custom, req);
      if (!o) continue;   // 没有改图素材：等于自动
      if (o.adapted) meta.sizeAdapted = { from: `${o.from.width}x${o.from.height}`, to: `${o.width}x${o.height}` };
      v = { width: o.width, height: o.height };
    }
    const s = typeof v === 'object' ? parseSize(v) : null;
    if (!s) { out[spec.key] = v; continue; }   // 预设档（'1K'、'landscape_4_3'、'1024x1024'）原样
    if (spec.encode === 'split' && spec.fields) { out[spec.fields.width] = s.width; out[spec.fields.height] = s.height; continue; }
    out[spec.key] = encodeOne(spec, s);
  }
  return { params: out, meta };
}
