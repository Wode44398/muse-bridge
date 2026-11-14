// 文本编码：自动识别 + 解码 + 手动重选（对标 VS Code「通过编码重新打开」与系统文本查看器）。
//
//   detectEncoding(bytes)       → { encoding, bom }   识别顺序：BOM → 严格 UTF-8 → 东亚多字节打分（GB18030 / Big5 / Shift_JIS）→ 兜底 GB18030
//   decodeBytes(bytes, enc, o)  → string              o.partial=true：字节是截断的（只读了前 N MB），末尾半个字符丢掉不报错
//   ENCODINGS / encLabel(enc)   → 手动重选菜单与副标题用的显示名
//
// 纪律：零依赖、不碰 DOM，浏览器与 node --test 都能直接跑。

/** 手动重选的候选（顺序即菜单顺序）。value 是 TextDecoder 认的标签。 */
export const ENCODINGS = [
  { value: 'utf-8', label: 'UTF-8' },
  { value: 'gb18030', label: 'GB18030 / GBK' },
  { value: 'big5', label: 'Big5' },
  { value: 'shift_jis', label: 'Shift_JIS' },
  { value: 'euc-kr', label: 'EUC-KR' },
  { value: 'utf-16le', label: 'UTF-16 LE' },
  { value: 'utf-16be', label: 'UTF-16 BE' },
  { value: 'windows-1252', label: 'Western (Windows 1252)' },
];

export function encLabel(enc, bom = false) {
  const hit = ENCODINGS.find((e) => e.value === enc);
  const base = hit ? hit.label.split(' / ')[0] : String(enc || '').toUpperCase();
  return bom && enc === 'utf-8' ? base + ' BOM' : base;
}

/** 是不是 UTF-8（保存时不需要转码提示的那一种） */
export const isUtf8 = (enc) => !enc || enc === 'utf-8';

const asBytes = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b || []));

function bomOf(b) {
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) return 'utf-8';
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return 'utf-16le';
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return 'utf-16be';
  return null;
}

// 严格 UTF-8：fatal 解码器 + stream（末尾被截断的半个字符不算错）。从第一个高位字节起看 1MB 就够判（大文件不整篇试解）；
// 开头的纯 ASCII 跳过——英文开头的日志 / 代码要到几 MB 之后才出现 GBK 中文，只看文件头 1MB 会误判成 UTF-8、后面全成替换符
function validUtf8(b) {
  let s = 0;
  while (s < b.length && b[s] < 0x80) s++;
  try { new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(s, s + (1 << 20)), { stream: true }); return true; } catch { return false; }
}

// 无 BOM 的 UTF-16：ASCII 为主的 UTF-16 文本每两个字节就有一个 0x00，且集中落在奇数位（LE）或偶数位（BE）
function utf16NoBom(b) {
  const n = Math.min(b.length, 4096) & ~1;
  if (n < 16) return null;
  let even = 0, odd = 0;
  for (let i = 0; i < n; i += 2) { if (b[i] === 0) even++; if (b[i + 1] === 0) odd++; }
  const half = n / 2;
  if (odd > half * 0.4 && even < half * 0.05) return 'utf-16le';
  if (even > half * 0.4 && odd < half * 0.05) return 'utf-16be';
  return null;
}

// 东亚多字节编码打分：拿样本（前 64KB）分别按候选严格解码，解不了的直接出局；能解的数「常用字」命中——
// 乱码解出来的多是生僻字、半角片假名与私用区，真编码解出来满是高频字。简繁两套高频字表各取约 120 个，
// Shift_JIS 另数假名（日文正文假名占三成以上）。打不出明显高下时按 GB18030（本机用户最常见的老文件）。
const HAN_S = '的一是不了在人有我他这中大来上个国到说们为子和你地出道也时年得就那要下以生会自着去之过家学对可她里后小么心多天而能好都然没日于起还发成事只作当想看文无开手十用主行方又如前所本见经头面公同三已老从动两长知民样现分将外但身些与高意进把法此实回二理美点月明其种声全工己话儿者向情部正名定女问力机给等几很业最间新什打便位因重被走电四第门相次东政海口使教西再平真听世气信北少关并内加化由却代军产入先山五太水万市眼体别处总才场师书比住员九笑性通目华报立马命张活难神数件安表原车白应路期叫死常提感金何更反合放做系计或司利受光王果亲界及今京务制解各任至清物台象记边共风战干接它许八特觉望直服毛林题建南度统色字请交爱让认算论百吃义科怎元社术结六功指思非流每青管夫连远资队跟带花快条院变联言权往展该领传近留红治决周保达办运武半候七必城父强步完革深区友';   // i18n-ignore（字频表，不是界面文案）
const HAN_T = '的一是不了在人有我他這中大來上個國到說們為子和你地出道也時年得就那要下以生會自著去之過家學對可她裡後小麼心多天而能好都然沒日於起還發成事只作當想看文無開手十用主行方又如前所本見經頭面公同三已老從動兩長知民樣現分將外但身些與高意進把法此實回二理美點月明其種聲全工己話兒者向情部正名定女問力機給等幾很業最間新什打便位因重被走電四第門相次東政海口使教西再平真聽世氣信北少關並內加化由卻代軍產入先山五太水萬市眼體別處總才場師書比住員九笑性通目華報立馬命張活難神數件安表原車白應路期叫死常提感金何更反合放做系計或司利受光王果親界及今京務制解各任至清物台象記邊共風戰乾接它許八特覺望直服毛林題建南度統色字請交愛讓認算論百吃義科怎元社術結六功指思非流每青管夫連遠資隊跟帶花快條院變聯言權往展該領傳近留紅治決週保達辦運武半候七必城父強步完革深區友';   // i18n-ignore（字频表，不是界面文案）
const HANS = new Set(HAN_S), HANT = new Set(HAN_T);
const PUNCT = new Set('，。、；：？！“”‘’（）《》【】…—·「」『』　');   // i18n-ignore（字频表，不是界面文案）
// 韩文高频音节：GBK 的字节按 EUC-KR 也解得出、还满是谚文音节（两者码位区间重叠），只数常用音节才分得开
const HANGUL = new Set('이다는의에가을하고지기로서사한자리도어대수일정나시아인그들적해를게부상전원보있만주구우제거성장동소면국라여내경과진니마비실조신했오위문화생무요미계관되히연것개당학방물중와선각행저년회안공단발세은모영명결식업날러까말할데체려바후반치운습입늘울');   // i18n-ignore（字频表，不是界面文案）

function score(text, enc) {
  let hit = 0, cjk = 0, bad = 0, kana = 0, hangul = 0, hk = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) continue;
    if (c === 0xfffd || (c >= 0xe000 && c <= 0xf8ff) || (c >= 0xff61 && c <= 0xff9f)) { bad++; continue; }   // 替换符 / 私用区 / 半角片假名
    if (c >= 0x3040 && c <= 0x30ff) { kana++; continue; }
    if (c >= 0xac00 && c <= 0xd7a3) { hangul++; if (HANGUL.has(ch)) hk++; continue; }
    if (PUNCT.has(ch)) { hit++; continue; }
    if (c >= 0x4e00 && c <= 0x9fff) {
      cjk++;
      if (enc === 'big5' ? HANT.has(ch) : enc === 'shift_jis' ? HANS.has(ch) || HANT.has(ch) : enc === 'euc-kr' ? false : HANS.has(ch)) hit++;   // 韩文正文里汉字很少，不给 EUC-KR 加分
    } else if (c >= 0x3400 && c <= 0x4dbf) bad++;   // 扩展 A：乱码常落在这里
  }
  if (enc === 'shift_jis') hit += kana * 2;
  else bad += kana;
  // EUC-KR：常用音节才加分（真韩文六七成落在高频表里，GBK 误解出来的随机音节只有百分之几），生僻音节不扣分
  if (enc === 'euc-kr') hit += hk * 2;
  else bad += hangul;
  return hit * 3 - bad * 4 + cjk * 0.2;
}

function tryDecode(b, enc) {
  try { return new TextDecoder(enc, { fatal: true }).decode(b, { stream: true }); } catch { return null; }
}

/** 识别编码。bytes 可以是截断的前 N 字节。返回 { encoding, bom }。 */
export function detectEncoding(bytes) {
  const b = asBytes(bytes);
  const bom = bomOf(b);
  if (bom) return { encoding: bom, bom: true };
  const u16 = utf16NoBom(b);
  if (u16) return { encoding: u16, bom: false };
  if (validUtf8(b)) return { encoding: 'utf-8', bom: false };
  // 样本里跳过开头的纯 ASCII（代码文件的注释前大段英文不参与打分），取第一个高位字节起的 64KB
  let s = 0;
  while (s < b.length && b[s] < 0x80) s++;
  const sample = b.subarray(Math.max(0, s - 1), s + 65536);
  let best = 'gb18030', bestScore = -Infinity;
  // windows-1252 什么字节都解得出、不含中日韩字，分数恒为 0：只在东亚候选全都解不了或解出来全是乱码时胜出（西文老文件）
  for (const enc of ['gb18030', 'big5', 'shift_jis', 'euc-kr', 'windows-1252']) {
    const txt = tryDecode(sample, enc);
    if (txt == null) continue;
    const sc = enc === 'windows-1252' ? 0 : score(txt, enc) + (enc === 'gb18030' ? 1 : 0);   // 平手偏向 GB18030
    if (sc > bestScore) { bestScore = sc; best = enc; }
  }
  return { encoding: best, bom: false };
}

/** 没扩展名 / 不认识的文件：前 4KB 像不像文本。UTF-16（有无 BOM）算文本；有 NUL 或控制字符超过 5% 算二进制；
 *  其余能按识别出的编码解出来、替换符很少就算文本（GBK / Big5 / Shift_JIS 的老文件也认）。 */
export function looksText(bytes) {
  const b = asBytes(bytes).subarray(0, 4096);
  if (!b.length) return true;
  const det = detectEncoding(b);
  if (det.encoding.startsWith('utf-16')) return true;
  let ctrl = 0;
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c === 0) return false;
    if (c < 9 || (c > 13 && c < 32 && c !== 27)) ctrl++;
  }
  if (ctrl > b.length * 0.05) return false;
  if (det.encoding === 'utf-8') return true;
  const txt = decodeBytes(b, det.encoding, { partial: true });
  let bad = 0;
  for (const ch of txt) { const c = ch.codePointAt(0); if (c === 0xfffd || (c >= 0xe000 && c <= 0xf8ff)) bad++; }
  return bad <= Math.max(2, txt.length * 0.02);
}

/** HTML / XML 自己声明的编码（<meta charset>、http-equiv content 里的 charset、<?xml encoding?>），只看前 1KB——
 *  浏览器也只在这个范围里找。认不出的标签返回 null；GBK / GB2312 并成 gb18030（超集，解码结果一样）。 */
export function declaredCharset(bytes) {
  const b = asBytes(bytes);
  let head = '';
  for (let i = 0, n = Math.min(b.length, 1024); i < n; i++) head += String.fromCharCode(b[i]);
  const m = /<meta\b[^>]*?charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(head) || /<\?xml\b[^>]*?encoding\s*=\s*["']([\w.:-]+)/i.exec(head);
  if (!m) return null;
  let enc = m[1].toLowerCase();
  if (enc === 'gbk' || enc === 'gb2312' || enc === 'x-gbk') enc = 'gb18030';
  try { return new TextDecoder(enc).encoding; } catch { return null; }
}

/** 网页源码：BOM 优先 → 页面自己声明的编码 → 自动识别（与浏览器的取舍顺序一致） */
export function detectHtmlEncoding(bytes) {
  const det = detectEncoding(bytes);
  if (det.bom) return det;
  const dc = declaredCharset(bytes);
  return dc ? { encoding: dc, bom: false } : det;
}

/** 按指定编码解码。partial=true 时末尾不完整的多字节字符直接丢掉（截断显示用） */
export function decodeBytes(bytes, enc = 'utf-8', { partial = false } = {}) {
  const b = asBytes(bytes);
  let d;
  try { d = new TextDecoder(enc); } catch { d = new TextDecoder('utf-8'); }
  // TextDecoder 默认会吃掉与编码一致的 BOM（UTF-8 EF BB BF / UTF-16 FF FE、FE FF）——BOM 由 detect 记在 bom 上，保存时补回
  return partial ? d.decode(b, { stream: true }) : d.decode(b);
}

/** 一步到位：识别 + 解码 */
export function decodeAuto(bytes, opts) {
  const det = detectEncoding(bytes);
  return { ...det, text: decodeBytes(bytes, det.encoding, opts) };
}

/** 换行风格：保存时按原文的写回（编辑器内部一律是 \n） */
export function eolOf(text) {
  const s = String(text).slice(0, 1 << 20);
  const crlf = (s.match(/\r\n/g) || []).length;
  if (!crlf) return '\n';
  const lf = (s.match(/\n/g) || []).length - crlf;
  return crlf >= lf ? '\r\n' : '\n';
}
