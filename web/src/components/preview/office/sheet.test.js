// 表格模型单测：node --test web/src/components/preview/office/sheet.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as XLSX from 'xlsx';
import { unzipSync, strFromU8 } from 'fflate';
import {
  colName, colIndex, addr, decodeAddr, rangeLabel, decodeText, xmlColor, textUnits, evalFormula,
  parseBook, guessFreeze, prefix, indexAt, findCells, selectionTsv, fontPx, pack,
} from './sheet.js';

const fflate = { unzipSync, strFromU8 };

test('地址：列名 ↔ 序号、A1 解析、区域标签', () => {
  assert.deepEqual([0, 25, 26, 51, 52, 701, 702, 16383].map(colName), ['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA', 'XFD']);
  for (const c of [0, 25, 26, 701, 702, 16383]) assert.equal(colIndex(colName(c)), c);
  assert.equal(addr(2, 1), 'B3');
  assert.deepEqual(decodeAddr('B3'), { r: 2, c: 1 });
  assert.deepEqual(decodeAddr(' $c$10 '), { r: 9, c: 2 });
  assert.equal(decodeAddr('B3:D4'), null);
  assert.equal(decodeAddr('3B'), null);
  assert.equal(decodeAddr(''), null);
  assert.equal(rangeLabel({ r0: 0, c0: 0, r1: 0, c1: 0 }), 'A1');
  assert.equal(rangeLabel({ r0: 1, c0: 1, r1: 9, c1: 3 }), 'B2:D10');
});

/** 小工作簿环境：sheets = [[[值…]…]…]，值以 = 开头视为公式 */
function envOf(sheets, names = sheets.map((_, i) => 'S' + (i + 1))) {
  const visiting = new Set();
  const env = {
    sheet: 0,
    sheetIndex: (n) => names.findIndex((x) => x.toLowerCase() === String(n).toLowerCase()),
    extent: (si) => ({ rows: sheets[si].length, cols: Math.max(0, ...sheets[si].map((r) => r.length)) }),
    value(si, r, c) {
      const v = sheets[si]?.[r]?.[c];
      if (typeof v !== 'string' || !v.startsWith('=')) return v ?? null;
      const k = `${si}:${r}:${c}`;
      if (visiting.has(k)) return { e: '#REF!' };
      visiting.add(k);
      const prev = env.sheet;
      env.sheet = si;
      const out = evalFormula(v.slice(1), env);
      env.sheet = prev;
      visiting.delete(k);
      return out;
    },
  };
  return env;
}

test('公式：四则、优先级、百分号、字符串拼接、比较', () => {
  const env = envOf([[[2, 3, 'x']]]);
  assert.equal(evalFormula('1+2*3', env), 7);
  assert.equal(evalFormula('(1+2)*3', env), 9);
  assert.equal(evalFormula('2^3^2', env), 64);           // Excel 的乘方左结合
  assert.equal(evalFormula('-2^2', env), 4);             // 一元负号先于乘方
  assert.equal(evalFormula('50%*A1', env), 1);
  assert.equal(evalFormula('A1&"-"&C1', env), '2-x');
  assert.equal(evalFormula('A1<B1', env), true);
  assert.equal(evalFormula('"a"="A"', env), true);       // 文本比较不分大小写
  assert.deepEqual(evalFormula('1/0', env), { e: '#DIV/0!' });
  assert.deepEqual(evalFormula('C1+1', env), { e: '#VALUE!' });
});

test('公式：区域函数、跨表引用、IF / IFERROR、文本函数', () => {
  const s1 = [[1, 2, 3], [4, 'a', 6], [null, true, '=SUM(A1:C2)']];
  const s2 = [[10, 20]];
  const env = envOf([s1, s2], ['数据', 'Other Sheet']);
  assert.equal(evalFormula('SUM(A1:C2)', env), 16);       // 区域里的文字不计
  assert.equal(evalFormula('SUM(A:A)', env), 5);          // 整列收到已用区域
  assert.equal(evalFormula('AVERAGE(A1:A2)', env), 2.5);
  assert.equal(evalFormula('COUNT(A1:C3)', env), 6);      // C3 的公式算出来是数字
  assert.equal(evalFormula('COUNTA(A1:C3)', env), 8);
  assert.equal(evalFormula('MAX(A1:C2,100)', env), 100);
  assert.equal(evalFormula("'Other Sheet'!A1+'Other Sheet'!B1", env), 30);
  assert.equal(evalFormula('SUM(\'Other Sheet\'!A1:B1)*2', env), 60);
  assert.equal(evalFormula('IF(A1>0,"正","负")', env), '正');
  assert.equal(evalFormula('IF(A1>5,1)', env), false);
  assert.equal(evalFormula('IFERROR(1/0,"—")', env), '—');
  assert.equal(evalFormula('ROUND(2.345,2)', env), 2.35);
  assert.equal(evalFormula('ROUNDDOWN(-2.9,0)', env), -2);
  assert.equal(evalFormula('MOD(-7,3)', env), 2);
  assert.equal(evalFormula('LEFT("表格模型",2)&LEN("abc")', env), '表格3');
  assert.equal(evalFormula('AND(A1=1,B3)', env), true);
});

test('公式：循环引用 → #REF!；不支持的函数 / 语法 → 算不了', () => {
  const env = envOf([[['=B1+1', '=A1+1']]]);
  assert.deepEqual(env.value(0, 0, 0), { e: '#REF!' });
  const plain = envOf([[[1]]]);
  assert.ok(evalFormula('VLOOKUP(1,A1:A1,1,0)', plain).unsup);
  assert.ok(evalFormula('1+', plain).unsup);
  assert.ok(evalFormula('SUM(1,2))', plain).unsup);
  assert.ok(evalFormula('[1]Sheet1!A1', plain).unsup);
});

test('前缀和与像素定位：缺省、隐藏（负数）、缩放', () => {
  const pre = prefix([100, -1, 0, 50], 5, 64, 1);
  assert.deepEqual([...pre], [0, 100, 100, 164, 214, 278]);
  assert.equal(indexAt(pre, -5), 0);
  assert.equal(indexAt(pre, 0), 0);
  assert.equal(indexAt(pre, 99.9), 0);
  assert.equal(indexAt(pre, 100), 2);                     // 隐藏的第 1 列被跳过
  assert.equal(indexAt(pre, 213), 3);
  assert.equal(indexAt(pre, 1e9), 4);                     // 超出末尾夹到最后一列
  const z = prefix(null, 3, 22, 1.5);
  assert.deepEqual([...z], [0, 33, 66, 99]);
  assert.equal(indexAt(prefix(null, 0, 64), 10), 0);
});

test('文字宽度、字号换算、颜色', () => {
  assert.equal(textUnits('abc'), 3);
  assert.equal(textUnits('中文ab'), 6);
  assert.equal(textUnits('ｶﾅ全角，'), 8);                // 半角片假名算 1，汉字与全角标点算 2
  assert.equal(fontPx(11), 13);
  assert.equal(fontPx(0), 13);
  assert.equal(Math.round(fontPx(16)), 19);
  assert.equal(xmlColor(' rgb="FF4472C4"'), '#4472C4');
  assert.equal(xmlColor(' theme="4"'), '#4472C4');
  assert.equal(xmlColor(' auto="1"'), '');
});

test('文本解码：UTF-8（含 BOM）与 GBK 回落', () => {
  const u8 = new TextEncoder().encode('﻿名称,数量\n苹果,3');
  assert.equal(decodeText(u8), '名称,数量\n苹果,3');
  const gbk = Uint8Array.from([0xC3, 0xFB, 0xB3, 0xC6, 0x2C, 0x31]);   // 「名称,1」的 GBK 字节
  assert.equal(decodeText(gbk), '名称,1');
});

test('CSV：类型、对齐所需的 k、自动列宽、首行表头自动冻结', () => {
  const rows = ['城市,人口,日期', ...Array.from({ length: 40 }, (_, i) => `城市${i},${1000 + i},2024-01-${String(i % 28 + 1).padStart(2, '0')}`)];
  const book = parseBook(XLSX, fflate, new TextEncoder().encode(rows.join('\n')), 'csv');
  const sh = book.sheets[0];
  assert.equal(sh.nRows, 41);
  assert.equal(sh.nCols, 3);
  assert.equal(sh.cells[0][0].w, '城市');
  assert.equal(sh.cells[1][1].k, 'n');
  assert.equal(sh.cells[1][1].w, '1000');
  assert.ok(sh.colW.every((w) => w >= 48 && w <= 360));
  assert.deepEqual(sh.freeze, { rows: 1, cols: 0, auto: true });
  assert.equal(guessFreeze({ ...sh, nRows: 10 }).rows, 0);       // 太短的表不冻
});

test('TSV：制表符分隔', () => {
  const book = parseBook(XLSX, fflate, new TextEncoder().encode('a\tb\n1\t2\n'), 'tsv');
  assert.equal(book.sheets[0].nCols, 2);
  assert.equal(book.sheets[0].cells[1][1].w, '2');
});

test('xlsx：合并单元格、隐藏列、没缓存值的公式现算并按格式显示、查找与复制', () => {
  const ws = XLSX.utils.aoa_to_sheet([
    ['标题', null, null],
    ['单价', '数量', '金额'],
    [12.5, 4, null],
    [3, 'n/a', null],
  ]);
  ws.C3 = { t: 'n', f: 'A3*B3', z: '0.00' };              // 不带 v：模拟别的程序写出、没存缓存值的公式
  ws.C4 = { t: 'n', f: 'A4*B4' };
  ws.D1 = { t: 'n', f: 'SUM(C3:C4)' };
  ws['!ref'] = 'A1:D4';
  ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }];
  ws['!cols'] = [{ wpx: 120 }, { hidden: true }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '汇总');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['x']]), '第二张');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  const book = parseBook(XLSX, fflate, buf, 'xlsx');
  assert.equal(book.sheets.length, 2);
  const sh = book.sheets[0];
  assert.equal(sh.name, '汇总');
  assert.deepEqual(sh.merges, [{ r0: 0, c0: 0, r1: 0, c1: 2 }]);
  assert.ok(sh.anchors.has(pack(0, 0)));
  assert.ok(sh.covered.has(pack(0, 1)) && sh.covered.has(pack(0, 2)));
  assert.equal(sh.colW[1], -1);
  assert.equal(sh.colW[0], 140);                          // 文件里存的是字符宽 20（SheetJS 按 MDW 6 换成 120px；Excel 里 Calibri 11 是 7px/字符）
  assert.equal(sh.cells[2][2].w, '50.00');
  assert.equal(sh.cells[2][2].f, 'A3*B3');
  assert.equal(sh.cells[2][2].k, 'n');
  assert.equal(sh.cells[3][2].k, 'e');                    // 3 * "n/a" → #VALUE!
  assert.equal(sh.cells[3][2].w, '#VALUE!');
  assert.equal(sh.cells[0][3].w, '#VALUE!');              // 区域里有错误值，SUM 也是错误
  assert.deepEqual(findCells(sh, '单'), [{ r: 1, c: 0 }]);
  assert.deepEqual(findCells(sh, 'VALUE').map((h) => addr(h.r, h.c)), ['D1', 'C4']);
  assert.equal(selectionTsv(sh, { r0: 1, c0: 0, r1: 2, c1: 2 }), '单价\t数量\t金额\n12.5\t4\t50.00');
  assert.equal(selectionTsv(sh, { r0: 3, c0: 0, r1: 99, c1: 0 }), '3');   // 超出数据区的部分收掉
});

// 样张（QA 生成，本机才有）：冻结窗格、行高、样式
const SAMPLE = join(process.env.TEMP || process.env.TMPDIR || '/tmp', 'bridge-preview-qa', 'vault', '预览样张', '文档', '数据表.xlsx');
test('样张 数据表.xlsx：冻结窗格与表头样式', { skip: !existsSync(SAMPLE) && '没有样张' }, () => {
  const book = parseBook(XLSX, fflate, readFileSync(SAMPLE), 'xlsx');
  const [sum, detail] = book.sheets;
  assert.equal(sum.name, '汇总');
  assert.deepEqual({ r: sum.freeze.rows, c: sum.freeze.cols }, { r: 2, c: 1 });   // B3
  assert.equal(sum.rowH[0], 30);
  assert.ok(sum.merges.some((m) => m.r0 === 0 && m.c0 === 0 && m.c1 === 5));
  const head = book.styles[sum.cells[1][0].s];
  assert.equal(head.bg, '#4472C4');
  assert.equal(detail.nRows, 20001);
  assert.deepEqual({ r: detail.freeze.rows, c: detail.freeze.cols }, { r: 1, c: 0 });
  assert.equal(detail.cells[1][6].k, 'n');
});
