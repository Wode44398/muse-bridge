// 文本类预览的纯函数单测：编码识别 / 解码、CSV 解析、JSON 格式化、查找、日志识别、带上限读取、文档相对资源解析。
// node --test web/src/lib/codeview/codeview.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectEncoding, decodeBytes, decodeAuto, looksText, declaredCharset, detectHtmlEncoding, encLabel, isUtf8, eolOf } from './encoding.js';
import { detectDelim, parseDelimited, colWidths, toTsv } from './delimited.js';
import { looksMinified, formatJson, formatJsonAsync } from './jsonfmt.js';
import { findAll, looksLikeLog, LV_ERR, LV_WARN } from './textutil.js';
import { readCapped, capFor, SAVE_MAX } from './readtext.js';
import { artifactRef, resolveRelPath, siblingDesc } from '../docres.js';

const hex = (h) => Uint8Array.from(h.match(/../g), (x) => parseInt(x, 16));
const utf8 = (s) => new TextEncoder().encode(s);
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

// 床前明月光，疑是地上霜。举头望明月，低头思故乡。（GB18030 / GBK）
const GBK = hex('b4b2c7b0c3f7d4c2b9e2a3acd2c9cac7b5d8c9cfcbaaa1a3bed9cdb7cdfbc3f7d4c2a3acb5cdcdb7cbbcb9cacfe7a1a3');
// 床前明月光，疑是地上霜。舉頭望明月，低頭思故鄉。這是我們的時間。（Big5）
const BIG5 = hex('a7c9ab65a9faa4eba5faa141bac3ac4fa661a457c1f7a143c17cc059b1e6a9faa4eba141a743c059abe4ac47b66da143b36fac4fa7daadccaabaaec9b6a1a143');
// これは日本語のテキストです。東京へ行きます。ありがとうございました。（Shift_JIS）
const SJIS = hex('82b182ea82cd93fa967b8cea82cc8365834c8358836782c582b78142938c8b9e82d68d7382ab82dc82b7814282a082e882aa82c682a482b282b482a282dc82b582bd8142');

test('编码：GBK 自动识别为 GB18030 并正确解码', () => {
  const d = decodeAuto(GBK);
  assert.equal(d.encoding, 'gb18030');
  assert.equal(d.bom, false);
  assert.ok(d.text.startsWith('床前明月光'));
  // 前面一大段 ASCII（代码注释）也不影响判断
  const withAscii = cat(utf8('// header comment\nconst x = 1;\n'.repeat(40)), GBK);
  assert.equal(detectEncoding(withAscii).encoding, 'gb18030');
  // 开头超过 1MB 的纯 ASCII（日志前面全是英文）之后才出现 GBK：严格 UTF-8 校验从第一个高位字节起算，不被 ASCII 糊弄
  const longAscii = cat(utf8('2026-11-13 10:00:00 INFO plain ascii line\n'.repeat(30000)), GBK);
  assert.ok(longAscii.length > 1 << 20);
  assert.equal(detectEncoding(longAscii).encoding, 'gb18030');
  assert.equal(encLabel('gb18030'), 'GB18030');
});

test('编码：Big5 与 Shift_JIS 打分胜出', () => {
  assert.equal(detectEncoding(BIG5).encoding, 'big5');
  assert.ok(decodeBytes(BIG5, 'big5').includes('舉頭望明月'));
  assert.equal(detectEncoding(SJIS).encoding, 'shift_jis');
  assert.ok(decodeBytes(SJIS, 'shift_jis').includes('日本語のテキスト'));
  // 真韩文仍认 EUC-KR（GBK 误判成 EUC-KR 的反方向）
  const KR = hex('c7d1b1b9beee20c5d8bdbac6aec0d4b4cfb4d92e20c0ccb0cdc0ba20c5d7bdbac6ae20b9aec0e5c0ccb8e72c20bfecb8aeb4c220bfc0b4c320c7d0b1b3bfa120b0a9b4cfb4d92e20b4ebc7d1b9ceb1b9c0c720bcf6b5b5b4c220bcadbfefc0d4b4cfb4d92e');
  assert.equal(detectEncoding(KR).encoding, 'euc-kr');
  assert.ok(decodeBytes(KR, 'euc-kr').startsWith('한국어'));
  // 短句 GBK 也不被 EUC-KR 抢走（两者码位区间重叠）
  assert.equal(detectEncoding(GBK.subarray(0, 10)).encoding, 'gb18030');
});

test('编码：BOM 优先；UTF-8 正文；无 BOM 的 UTF-16', () => {
  const u8bom = cat(hex('efbbbf'), utf8('你好'));
  assert.deepEqual(detectEncoding(u8bom), { encoding: 'utf-8', bom: true });
  assert.equal(decodeBytes(u8bom, 'utf-8'), '你好');   // BOM 被解码器吃掉，保存时按 bom 补回
  assert.equal(encLabel('utf-8', true), 'UTF-8 BOM');
  const le = cat(hex('fffe'), hex('604f7d59'));   // 你好 UTF-16LE
  assert.deepEqual(detectEncoding(le), { encoding: 'utf-16le', bom: true });
  assert.equal(decodeBytes(le, 'utf-16le'), '你好');
  assert.equal(detectEncoding(hex('feff4f60597d')).encoding, 'utf-16be');
  assert.equal(detectEncoding(utf8('床前明月光 hello')).encoding, 'utf-8');
  // 无 BOM 的 UTF-16LE（ASCII 为主）
  const ascii = 'hello world, plain ascii text\n';
  const noBom = new Uint8Array(ascii.length * 2);
  for (let i = 0; i < ascii.length; i++) noBom[i * 2] = ascii.charCodeAt(i);
  assert.equal(detectEncoding(noBom).encoding, 'utf-16le');
  assert.ok(isUtf8('utf-8') && isUtf8(undefined) && !isUtf8('gb18030'));
});

test('编码：截断在半个字符上（partial）不出替换符', () => {
  const b = utf8('你好世界');
  const cut = b.subarray(0, b.length - 1);
  assert.equal(detectEncoding(cut).encoding, 'utf-8');   // 末尾半个字符不算非法 UTF-8
  assert.equal(decodeBytes(cut, 'utf-8', { partial: true }), '你好世');
  assert.equal(decodeBytes(GBK.subarray(0, 9), 'gb18030', { partial: true }), '床前明月');
});

test('编码：HTML 自己声明的 charset', () => {
  const page = cat(utf8('<!doctype html><html><head><meta charset="gbk"><title>x</title></head><body>'), GBK);
  assert.equal(declaredCharset(page), 'gb18030');
  assert.equal(detectHtmlEncoding(page).encoding, 'gb18030');
  assert.equal(declaredCharset(utf8('<meta http-equiv="Content-Type" content="text/html; charset=Shift_JIS">')), 'shift_jis');
  assert.equal(declaredCharset(utf8('<?xml version="1.0" encoding="big5"?><a/>')), 'big5');
  assert.equal(declaredCharset(utf8('<p>no charset</p>')), null);
  // BOM 压过声明
  assert.equal(detectHtmlEncoding(cat(hex('efbbbf'), utf8('<meta charset="gbk">'))).encoding, 'utf-8');
});

test('嗅探：looksText 认文本（含 GBK / UTF-16），拒二进制', () => {
  assert.ok(looksText(utf8('PATH=/usr/bin\nexport A=1\n')));
  assert.ok(looksText(GBK));
  assert.ok(looksText(hex('fffe680069000a00')));
  assert.ok(looksText(new Uint8Array(0)));
  assert.ok(!looksText(hex('89504e470d0a1a0a0000000d49484452')));   // PNG 头
  assert.ok(!looksText(cat(utf8('PK'), hex('0304140000000800'))));   // zip 头
});

test('换行风格 eolOf', () => {
  assert.equal(eolOf('a\r\nb\r\nc'), '\r\n');
  assert.equal(eolOf('a\nb\nc'), '\n');
  assert.equal(eolOf('single line'), '\n');
});

test('CSV：引号、转义、字段内换行、CRLF、BOM、截断', () => {
  const csv = '\ufeffname,note,n\r\n"Li, Lei","he said ""hi""",1\r\nWang,"line1\nline2",2\r\n';
  assert.equal(detectDelim(csv), ',');
  const r = parseDelimited(csv, { delim: ',' });
  assert.equal(r.cols, 3);
  assert.deepEqual(r.rows[0], ['name', 'note', 'n']);
  assert.deepEqual(r.rows[1], ['Li, Lei', 'he said "hi"', '1']);
  assert.deepEqual(r.rows[2], ['Wang', 'line1\nline2', '2']);
  assert.equal(r.rows.length, 3);
  assert.equal(r.truncated, false);
  const t2 = parseDelimited('a\n1\n2\n3\n', { maxRows: 2 });
  assert.equal(t2.rows.length, 2);
  assert.equal(t2.truncated, true);
  assert.deepEqual(parseDelimited('a,b,\n').rows[0], ['a', 'b', '']);   // 行尾空字段
});

test('分隔符识别 / 列宽 / 复制成 TSV', () => {
  assert.equal(detectDelim('a\tb\tc\n1\t2\t3\n'), '\t');
  assert.equal(detectDelim('a;b;c\n1;2;3\n'), ';');
  assert.equal(detectDelim('x,y\n', 'tsv'), '\t');
  const w = colWidths([['短', 'a much longer header text here'], ['中文中文中文中文中文中文', 'x']]);
  assert.equal(w.length, 2);
  assert.ok(w.every((x) => x >= 64 && x <= 360));
  assert.ok(w[1] > 64);
  assert.equal(typeof toTsv, 'function');
});

test('JSON：压缩判定、格式化、坏 JSON 返回 null', async () => {
  const min = JSON.stringify({ a: 1, b: [1, 2, { c: 'x' }], d: 'y'.repeat(300) });
  assert.ok(looksMinified(min));
  assert.ok(!looksMinified(JSON.stringify({ a: 1, b: 2 }, null, 2)));
  assert.equal(formatJson('{"a":1}'), '{\n  "a": 1\n}');
  assert.equal(formatJson('{"a":1'), null);
  assert.equal(formatJson('// c\n{"a":1}'), null);
  assert.equal(await formatJsonAsync('[1,2]'), '[\n  1,\n  2\n]');
});

test('查找：大小写 / 全字 / 正则 / 正则写错', () => {
  const s = 'Error error ERROR terror\nerror2';
  assert.equal(findAll(s, { q: 'error' }).n, 5);
  assert.equal(findAll(s, { q: 'error', cs: true }).n, 3);
  assert.equal(findAll(s, { q: 'error', word: true }).n, 3);
  const r = findAll(s, { q: 'err(or)?\\d', re: true });
  assert.equal(r.n, 1);
  assert.deepEqual([r.hits[0], r.hits[1]], [25, 31]);
  assert.equal(findAll(s, { q: '(', re: true }).error, true);
  assert.equal(findAll(s, { q: '' }).n, 0);
  assert.equal(findAll('床前明月光，明月', { q: '明月' }).n, 2);
});

test('日志识别与级别词', () => {
  assert.ok(looksLikeLog('', 'app.log'));
  const lines = ['2026-11-13 10:00:01 INFO start', '2026-11-13 10:00:02 WARN slow', '2026-11-13 10:00:03 ERROR boom', '2026-11-13 10:00:04 INFO ok'].join('\n');
  assert.ok(looksLikeLog(lines, 'out.txt'));
  assert.ok(!looksLikeLog('just\nsome\nplain\ntext\nlines', 'notes.txt'));
  assert.ok(LV_ERR.test('[ERROR] x') && !LV_ERR.test('terrors'));
  assert.ok(LV_WARN.test('WARNING: y'));
});

function fakeFetch(bytes, { headers = {}, chunk = 1000, stream = true, status = 200 } = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    body: stream ? {
      getReader() {
        let i = 0;
        return {
          read: async () => (i >= bytes.length ? { done: true } : { done: false, value: bytes.subarray(i, (i += chunk)) }),
          cancel: async () => {},
        };
      },
    } : null,
  });
}

test('带上限读取 readCapped：截断、整读、总长、非 2xx', async () => {
  const big = new Uint8Array(10_000).fill(65);
  const a = await readCapped('/x', { cap: 4096, fetchImpl: fakeFetch(big, { headers: { 'content-length': '10000' } }) });
  assert.equal(a.bytes.length, 4096);
  assert.equal(a.truncated, true);
  assert.equal(a.total, 10000);
  const b = await readCapped('/x', { cap: 1 << 20, fetchImpl: fakeFetch(big) });
  assert.equal(b.bytes.length, 10000);
  assert.equal(b.truncated, false);
  assert.equal(b.total, 10000);
  // 正好停在上限、没有总长：再读一拍判断
  const c = await readCapped('/x', { cap: 10_000, fetchImpl: fakeFetch(big) });
  assert.equal(c.truncated, false);
  // 老 WebView 没有可读流
  const d = await readCapped('/x', { cap: 100, fetchImpl: fakeFetch(big, { stream: false }) });
  assert.equal(d.bytes.length, 100);
  assert.equal(d.truncated, true);
  await assert.rejects(readCapped('/x', { fetchImpl: fakeFetch(big, { status: 404 }) }), /HTTP 404/);
  assert.equal(capFor(true), 4 * 1024 * 1024);
  assert.equal(capFor(false), 10 * 1024 * 1024);
  assert.equal(SAVE_MAX, 5_000_000);
});

test('文档相对资源：resolveRelPath 保留分隔符风格、不越过根', () => {
  assert.equal(resolveRelPath('C:\\work\\out\\report.md', 'img/a.png'), 'C:\\work\\out\\img\\a.png');
  assert.equal(resolveRelPath('C:\\work\\out\\report.md', '../shared/b.md'), 'C:\\work\\shared\\b.md');
  assert.equal(resolveRelPath('/home/u/docs/a.md', './pics/x.png'), '/home/u/docs/pics/x.png');
  assert.equal(resolveRelPath('/a.md', '../../x.png'), '/x.png');
  assert.equal(resolveRelPath('/a/b.md', 'https://e.com/x.png'), null);
  assert.equal(resolveRelPath('/a/b.md', '/abs.png'), null);
});

test('文档相对资源：产物条目（Claude / Codex / dimensio）与工作空间', () => {
  const claude = { origin: 'claude', url: '/api/claude/artifact?id=s1&path=' + encodeURIComponent('C:\\w\\out\\r.md'), name: 'r.md' };
  assert.deepEqual(artifactRef(claude), { origin: 'claude', id: 's1', path: 'C:\\w\\out\\r.md' });
  assert.deepEqual(siblingDesc(claude, 'img/p.png'), { origin: 'claude', id: 's1', path: 'C:\\w\\out\\img\\p.png', name: 'p.png' });
  const harness = { origin: 'harness', url: '/harness/api/sessions/abc/artifact?path=' + encodeURIComponent('/srv/w/a.md') };
  assert.deepEqual(siblingDesc(harness, '../b.md'), { origin: 'harness', id: 'abc', path: '/srv/b.md', name: 'b.md' });
  assert.equal(artifactRef({ origin: 'cloud', url: '/api/file?rel=x' }), null);
  const ws = { origin: 'cloud', saveTarget: { origin: 'cloud', rel: 'notes/day/a.md', ws: 'w1' } };
  assert.deepEqual(siblingDesc(ws, '../img/x.png'), { origin: 'cloud', rel: 'notes/img/x.png', name: 'x.png', ws: 'w1', nativeLocation: '' });
  const loc = { origin: 'local', saveTarget: { origin: 'local', rel: 'Download/a.md' } };
  assert.deepEqual(siblingDesc(loc, 'b.txt'), { origin: 'local', rel: 'Download/b.txt', name: 'b.txt' });
});
