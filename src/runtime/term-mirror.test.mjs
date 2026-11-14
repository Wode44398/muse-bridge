import test from 'node:test';
import assert from 'node:assert/strict';
import { createMirror, serializeTerm } from './term-mirror.mjs';

const write = (m, d) => new Promise((r) => m.term.write(d, r));

// 逐行取文字 + 折行标记 + 每格属性指纹
function dump(term, which = 'active') {
  const buf = term.buffer[which];
  const cell = buf.getNullCell();
  const rows = [];
  for (let y = 0; y < buf.length; y++) {
    const line = buf.getLine(y);
    let attrs = '';
    for (let x = 0; x < line.length; x++) {
      line.getCell(x, cell);
      if (!cell.getChars() || cell.getChars() === ' ') continue;
      attrs += `${x}:${cell.getFgColorMode()}/${cell.getFgColor()}/${cell.getBgColorMode()}/${cell.getBgColor()}/${cell.isBold()}${cell.isItalic()}${cell.isUnderline()}${cell.isInverse()},`;
    }
    rows.push({ t: line.translateToString(true), w: line.isWrapped, a: attrs });
  }
  return { rows, cx: buf.cursorX, cy: buf.cursorY, type: term.buffer.active.type };
}

async function roundTrip(cols, rows, data) {
  const a = createMirror(cols, rows, { scrollback: 200 });
  const b = createMirror(cols, rows, { scrollback: 200 });
  assert.ok(a && b, '@xterm/headless 应可用');
  try {
    await write(a, data);
    await write(b, serializeTerm(a.term));
    return { a: dump(a.term), b: dump(b.term), an: dump(a.term, 'normal'), bn: dump(b.term, 'normal'), am: a.term.modes, bm: b.term.modes };
  } finally { a.dispose(); b.dispose(); }
}

test('文字、颜色、滚回与光标原样复现', async () => {
  let s = '';
  for (let i = 1; i <= 40; i++) s += `\x1b[3${i % 8}mline ${i}\x1b[0m \x1b[1;4mbold\x1b[0m \x1b[38;2;10;200;30mrgb\x1b[48;5;200m bg \x1b[0m\r\n`;
  s += 'PS C:\\> ';
  const r = await roundTrip(30, 10, s);
  assert.deepEqual(r.b.rows, r.a.rows);
  assert.equal(r.b.cx, r.a.cx);
  assert.equal(r.b.cy, r.a.cy);
});

test('自动折行与宽字符', async () => {
  const long = 'x'.repeat(25) + '中文宽字符测试' + 'y'.repeat(30);
  const r = await roundTrip(20, 6, `${long}\r\n短行\r\n${'z'.repeat(19)}中\r\n> `);
  assert.deepEqual(r.b.rows, r.a.rows);
  assert.ok(r.a.rows.some((x) => x.w), '原缓冲应有折行');
  assert.equal(r.b.cx, r.a.cx);
  assert.equal(r.b.cy, r.a.cy);
});

test('光标停在行中间、行尾带底色空格', async () => {
  const r = await roundTrip(30, 5, 'abc\r\n\x1b[44m    \x1b[0m\r\nhello world\x1b[6D');
  assert.deepEqual(r.b.rows, r.a.rows);
  assert.equal(r.b.cx, r.a.cx);
  assert.equal(r.b.cy, r.a.cy);
});

test('备用屏（vim / less）与输入模式', async () => {
  const pre = 'before 1\r\nbefore 2\r\n$ vim\r\n';
  const alt = '\x1b[?1049h\x1b[?1h\x1b[?2004h\x1b[?1000h\x1b[H\x1b[2J~\r\n~\r\n\x1b[7m"file" 2L\x1b[0m\x1b[1;1Hhello';
  const r = await roundTrip(24, 6, pre + alt);
  assert.equal(r.b.type, 'alternate');
  assert.deepEqual(r.b.rows, r.a.rows);
  assert.deepEqual(r.bn.rows, r.an.rows);
  assert.equal(r.b.cx, r.a.cx);
  assert.equal(r.b.cy, r.a.cy);
  assert.equal(r.bm.applicationCursorKeysMode, true);
  assert.equal(r.bm.bracketedPasteMode, true);
  assert.equal(r.bm.mouseTrackingMode, r.am.mouseTrackingMode);
});

test('改过尺寸之后的镜像照样能序列化', async () => {
  const a = createMirror(40, 12, { scrollback: 200 });
  const b = createMirror(40, 12, { scrollback: 200 });
  try {
    for (let i = 1; i <= 30; i++) a.write(`row ${i}\r\n`);
    a.resize(40, 6);
    a.resize(40, 12);
    a.resize(28, 12);
    await write(a, 'row 31\r\n> ');
    await write(b, '');
    b.resize(28, 12);
    await write(b, serializeTerm(a.term));
    assert.deepEqual(dump(b.term).rows, dump(a.term).rows);
    assert.equal(dump(b.term).cy, dump(a.term).cy);
  } finally { a.dispose(); b.dispose(); }
});

test('at(fn) 在已写入的输出结算完的那一点执行', async () => {
  const m = createMirror(30, 5);
  try {
    m.write('first\r\n');
    let seen = '';
    m.at(() => { seen = m.term.buffer.active.getLine(0).translateToString(true); });
    m.write('second\r\n');
    await write(m, '');
    assert.equal(seen, 'first');
  } finally { m.dispose(); }
});
