#!/usr/bin/env node
// 模型中心品牌标生成器（流 L）：把 @lobehub/icons-static-svg 的 icons 目录清洗后写成 web/src/lib/brandLogos.js。
//
//   node web/scripts/gen-brand-logos.mjs <图标目录>     例：C:\...\icons-pkg\package\icons
//
// 收哪些：src/model-knowledge/brands.mjs 的 VENDORS 与 PROVIDERS 用到的全部 logoKey（去重，按字典序）。
// 怎么清洗（cleanSvgInfo）：
//   - 去掉 XML 声明、DOCTYPE、注释、<title>、<desc>、<metadata>；
//   - 根 <svg> 去掉 width / height / style / version / class / role，保留 viewBox 与其它展示属性，补 aria-hidden；
//   - 所有 id 改成 bl-<logoKey>-<原 id>，url(#…) 与 href="#…" 同步改（同一页上多个标互不撞）；
//   - 单色标（没有渐变 / 图片，填色只有 none、currentColor 或近黑）：近黑填色改 currentColor，根上没有 fill 就补 fill="currentColor"；
//     彩色标保留原色（与 web/src/lib/providerLogos.js 的约定一致）；
//   - 含 <script>、事件属性、外部引用、style 里内联填色的输入直接拒绝（记入 bad，退出码 1）。
// 缺失的 logoKey 只列出来、不中断（前端会退回首字头像）。输出没有时间戳，重跑逐字节相同。

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const BRANDS_FILE = join(REPO, 'src', 'model-knowledge', 'brands.mjs');
const OUT_FILE = join(REPO, 'web', 'src', 'lib', 'brandLogos.js');
const SVG_NS = 'http://www.w3.org/2000/svg';

// 根 <svg> 上不要的属性（viewBox、xmlns、aria-hidden 由下面统一补）
const DROP_ROOT = new Set(['width', 'height', 'style', 'version', 'class', 'role', 'focusable', 'aria-hidden', 'viewBox', 'xmlns']);
const PAINT_NAMES = new Set(['fill', 'stroke', 'stop-color', 'flood-color', 'lighting-color']);
// 属性形式的填色：捕获 (前导空白)(属性名)(=)(引号)(值)
const PAINT_RE = /(\s)(fill|stroke|stop-color|flood-color|lighting-color)(\s*=\s*)(["'])([^"']*)\4/g;
const ATTR_RE = /([^\s="'<>\/]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const attrOf = ([k, v]) => (v.includes('"') ? `${k}='${v}'` : `${k}="${v}"`);
const parseAttrs = (s) => [...s.matchAll(ATTR_RE)].map((m) => [m[1], m[2] ?? m[3] ?? '']);

/** 颜色字符串 → [r, g, b]；认不出的命名色返回 null。 */
function rgbOf(v) {
  const t = v.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(t);
  if (hex) {
    const h = hex[1].length <= 4 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const fn = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/.exec(t);
  if (fn) return [+fn[1], +fn[2], +fn[3]];
  if (t === 'black') return [0, 0, 0];
  if (t === 'white') return [255, 255, 255];
  return null;
}

/** 填色分类：none / current / inherit / url（渐变、图案）/ black（近黑）/ color（其余，白色也算彩色）。 */
function paintKind(v) {
  const t = String(v).trim().toLowerCase();
  if (t === 'none' || t === 'transparent') return 'none';
  if (t === 'currentcolor') return 'current';
  if (t === 'inherit') return 'inherit';
  if (t.startsWith('url(')) return 'url';
  const rgb = rgbOf(t);
  return rgb && Math.max(...rgb) <= 60 ? 'black' : 'color';
}

/**
 * 清洗单个图标。key 用来做 id 前缀。输入不安全或认不出（没有完整 <svg>、没有 viewBox 也推不出尺寸）时抛错。
 * 返回 { svg, mono, warnings }：mono 表示按单色处理；warnings 是引用了不存在的 id 的悬空引用。
 */
export function cleanSvgInfo(raw, key) {
  const slug = String(key).replace(/[^A-Za-z0-9_-]/g, '-');
  let s = String(raw)
    .replace(/^\uFEFF/, '')
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[\s\S]*?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  if (/<script[\s>]/i.test(s)) throw new Error('含 <script>');
  if (/<foreignObject[\s>]/i.test(s)) throw new Error('含 foreignObject');
  if (/\son[a-z]+\s*=/i.test(s)) throw new Error('含事件属性（on*）');
  if (/<(?:animate|set|animateMotion|animateTransform)[\s>]/i.test(s)) throw new Error('含 SMIL 动画（未支持）');
  if (/<style[\s>]/i.test(s)) throw new Error('含 <style>（样式表会全局生效，未支持）');
  if (/javascript:/i.test(s)) throw new Error('含 javascript: 地址');
  if (/url\(\s*(?!['"]?#)/i.test(s) || /(?:^|[\s:])href\s*=\s*(?!["']#)/i.test(s)) throw new Error('含外部引用（只允许 #id 形式的内部引用）');
  if (/\sstyle\s*=\s*["'][^"']*\b(?:fill|stroke)\s*:/i.test(s)) throw new Error('style 里内联了填色（未支持）');

  const open = /<svg\b([^>]*)>/i.exec(s);
  const end = s.lastIndexOf('</svg>');
  if (!open || end < open.index) throw new Error('没有完整的 <svg> 根');
  const rootIn = parseAttrs(open[1]);
  const rootVal = (name) => rootIn.find(([k]) => k === name)?.[1];
  let viewBox = rootVal('viewBox');
  if (!viewBox && rootVal('width') && rootVal('height')) {
    viewBox = `0 0 ${parseFloat(rootVal('width'))} ${parseFloat(rootVal('height'))}`;
  }
  if (!viewBox) throw new Error('根上没有 viewBox，也推不出尺寸');

  let attrs = rootIn.filter(([k]) => !DROP_ROOT.has(k));
  let body = s.slice(open.index + open[0].length, end)
    .replace(/<(title|desc|metadata)\b[^>]*\/>/gi, '')
    .replace(/<(title|desc|metadata)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/>\s+</g, '><');

  // 单色判定：看根与所有元素的填色 / 描边，没有渐变、图片，且实色只有近黑（或 none / currentColor / 继承）
  const kinds = [
    ...attrs.filter(([k]) => PAINT_NAMES.has(k)).map(([, v]) => v),
    ...[...body.matchAll(PAINT_RE)].map((m) => m[5]),
  ].map(paintKind);
  const mono = !/<image\b/i.test(body) && kinds.every((k) => k === 'none' || k === 'current' || k === 'black' || k === 'inherit');
  if (mono) {
    attrs = attrs.map(([k, v]) => [k, PAINT_NAMES.has(k) && paintKind(v) === 'black' ? 'currentColor' : v]);
    if (!attrs.some(([k]) => k === 'fill')) attrs.push(['fill', 'currentColor']);
    body = body.replace(PAINT_RE, (m, sp, name, eq, q, v) => (paintKind(v) === 'black' ? `${sp}${name}${eq}${q}currentColor${q}` : m));
  }

  let svg = `<svg ${[['aria-hidden', 'true'], ['viewBox', viewBox], ['xmlns', SVG_NS], ...attrs].map(attrOf).join(' ')}>${body}</svg>`;

  // id 加前缀，引用同步改；引用了不存在的 id 记成悬空引用
  const ids = new Set([...svg.matchAll(/\sid\s*=\s*(["'])([^"']*)\1/g)].map((m) => m[2]));
  const warnings = [];
  for (const m of svg.matchAll(/url\(\s*['"]?#([^'")\s]+)/g)) if (!ids.has(m[1])) warnings.push(`悬空引用 url(#${m[1]})`);
  for (const m of svg.matchAll(/(?:\s|:)href\s*=\s*["']#([^"']*)/g)) if (!ids.has(m[1])) warnings.push(`悬空引用 href=#${m[1]}`);
  const idOf = (id) => `bl-${slug}-${id}`;
  svg = svg
    .replace(/(\sid\s*=\s*)(["'])([^"']*)\2/g, (m, pre, q, id) => (ids.has(id) ? `${pre}${q}${idOf(id)}${q}` : m))
    .replace(/url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g, (m, q, id) => (ids.has(id) ? `url(${q}#${idOf(id)}${q})` : m))
    .replace(/((?:\s|:)href\s*=\s*)(["'])#([^"']*)\2/g, (m, pre, q, id) => (ids.has(id) ? `${pre}${q}#${idOf(id)}${q}` : m))
    .replace(/\s+/g, ' ');

  if (/<(title|script|foreignObject)\b/i.test(svg) || /\son[a-z]+\s*=/i.test(svg)) throw new Error('清洗后仍有残留');
  return { svg, mono, warnings };
}

/** 只要字符串：cleanSvgInfo(raw, key).svg。 */
export function cleanSvg(raw, key) {
  return cleanSvgInfo(raw, key).svg;
}

/** brands.mjs 用到的全部 logoKey（VENDORS 与 PROVIDERS；空串不收），去重、按字典序。 */
export function collectLogoKeys(brands) {
  const set = new Set();
  for (const v of Object.values(brands.VENDORS)) if (v && v.logo) set.add(v.logo);
  for (const p of brands.PROVIDERS) if (p && p.logo) set.add(p.logo);
  return [...set].sort(byCodeUnit);
}

// 单引号字符串字面量（SVG 里的 " 不用转义，文件更小）
const QUOTE_ESC = { '\\': '\\\\', "'": "\\'", '\n': '\\n', '\r': '\\r', '\u2028': '\\u2028', '\u2029': '\\u2029' };
const quote = (s) => `'${String(s).replace(/[\\'\n\r\u2028\u2029]/g, (c) => QUOTE_ESC[c])}'`;

/** 生成 brandLogos.js 的源码：只有 BRAND_SVG 一个导出，键按字典序，没有时间戳。 */
export function renderModule(entries, meta) {
  const head = [
    '// 模型中心品牌标——生成物，请勿手改。重跑：node web/scripts/gen-brand-logos.mjs <图标目录>（清洗规则见该脚本）。',
    `// 来源：${meta.name}@${meta.version}，许可 ${meta.license}（原始许可见图标包）。收 src/model-knowledge/brands.mjs 用到的 ${entries.length} 个 logoKey。`,
    '// SVG 已去掉 <title> 与根上的固定宽高 / style；id 加了 bl-<logoKey>- 前缀防撞；单色标的近黑填色改为 currentColor，彩色标保留原色。',
    '// 体积大，只许动态 import（BrandLogo.svelte 首次用到时才加载），不要静态引入。',
  ];
  const rows = entries.map(([k, v]) => `  ${quote(k)}: ${quote(v)},`);
  return `${head.join('\n')}\nexport const BRAND_SVG = {\n${rows.join('\n')}\n};\n`;
}

function readMeta(iconsDir) {
  const fallback = { name: '@lobehub/icons-static-svg', version: '未知', license: '未知' };
  try {
    const pkg = JSON.parse(readFileSync(join(iconsDir, '..', 'package.json'), 'utf8'));
    return {
      name: pkg.name || fallback.name,
      version: pkg.version || fallback.version,
      license: typeof pkg.license === 'string' ? pkg.license : fallback.license,
    };
  } catch {
    return fallback;
  }
}

/**
 * 跑一遍生成。brandsFile / outFile 默认指向仓库里的真文件；测试时可以指到临时目录。
 * 返回统计：collected（写进产物的个数）、keys（brands 用到的总数）、mono / colored、各种字节数、missing / bad / warnings。
 */
export async function generate({ iconsDir, brandsFile = BRANDS_FILE, outFile = OUT_FILE }) {
  const brands = await import(pathToFileURL(brandsFile).href);
  const keys = collectLogoKeys(brands);
  const entries = [];
  const missing = [];
  const bad = [];
  const warnings = [];
  let rawBytes = 0;
  let cleanBytes = 0;
  let mono = 0;
  for (const key of keys) {
    const file = join(iconsDir, `${key}.svg`);
    if (!existsSync(file)) {
      missing.push(key);
      continue;
    }
    rawBytes += statSync(file).size;
    try {
      const info = cleanSvgInfo(readFileSync(file, 'utf8'), key);
      entries.push([key, info.svg]);
      cleanBytes += Buffer.byteLength(info.svg);
      if (info.mono) mono++;
      for (const w of info.warnings) warnings.push(`${key}：${w}`);
    } catch (e) {
      bad.push(`${key}：${e.message}`);
    }
  }
  const text = renderModule(entries, readMeta(iconsDir));
  writeFileSync(outFile, text);
  return {
    keys: keys.length,
    collected: entries.length,
    mono,
    colored: entries.length - mono,
    rawBytes,
    cleanBytes,
    outBytes: Buffer.byteLength(text),
    missing,
    bad,
    warnings,
    outFile,
  };
}

async function main(argv) {
  const iconsArg = argv[0];
  if (!iconsArg || !existsSync(resolve(iconsArg))) {
    console.error('用法：node web/scripts/gen-brand-logos.mjs <图标目录>（目录里要有 <logoKey>.svg）');
    return 2;
  }
  const r = await generate({ iconsDir: resolve(iconsArg) });
  const list = (xs) => (xs.length ? `：\n  ${xs.join('\n  ')}` : '');
  console.log([
    `收录 ${r.collected} / ${r.keys} 个 logoKey（单色 ${r.mono}，彩色 ${r.colored}）`,
    `SVG 原始 ${r.rawBytes} 字节 → 清洗后 ${r.cleanBytes} 字节；${basename(r.outFile)} 写出 ${r.outBytes} 字节`,
    `缺失 ${r.missing.length} 个${list(r.missing)}`,
    `拒收 ${r.bad.length} 个${list(r.bad)}`,
    `悬空引用 ${r.warnings.length} 处${list(r.warnings)}`,
  ].join('\n'));
  return r.bad.length ? 1 : 0;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (e) => { console.error(e); process.exitCode = 1; },
  );
}
