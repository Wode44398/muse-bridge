// 流式 tar（tar-stream.mjs）：多条目逐个交出、pax 与 GNU 长名并进下一个条目、stop 提前收手、drain 读干尾巴。
// extractTarEntry 的老用法（只取一个条目）在 claude-cli.test.mjs 里另有覆盖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { walkTar } from './tar-stream.mjs';

function header(name, size, type, { mode = '0000644', linkname = '' } = {}) {
  const h = Buffer.alloc(512);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write(mode + '\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('        ', 148);
  h.write(type, 156);
  if (linkname) h.write(linkname.slice(0, 100), 157, 'utf8');
  h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}
const pad = (n) => Buffer.alloc((512 - (n % 512)) % 512);
const paxRec = (k, v) => { const body = ` ${k}=${v}\n`; let len = body.length + 1; while (String(len).length + body.length !== len) len = String(len).length + body.length; return Buffer.from(len + body); };
function* chunks(buf) {
  let i = 0;
  while (i < buf.length) { const n = 1 + Math.floor(Math.random() * 700); yield buf.subarray(i, i + n); i += n; }
}

const big = randomBytes(3000);
const longName = 'pkg/' + 'y'.repeat(130) + '/tool';
const gnuName = 'pkg/' + 'z'.repeat(140) + '.txt';
const pax = Buffer.concat([paxRec('mtime', '1795130305.8'), paxRec('path', longName)]);
const tar = Buffer.concat([
  header('bin/', 0, '5', { mode: '0000755' }),
  header('PaxHeader', pax.length, 'x'), pax, pad(pax.length),
  header('short', big.length, '0', { mode: '0000755' }), big, pad(big.length),
  header('././@LongLink', gnuName.length + 1, 'L'), Buffer.from(gnuName + '\0'), pad(gnuName.length + 1),
  header('trunc', 5, '0'), Buffer.from('hello'), pad(5),
  header('link', 0, '2', { linkname: 'bin/' }),
  header('empty', 0, '0'),
  Buffer.alloc(1024),
  Buffer.alloc(4096),   // 归档结尾标记之后的补齐（gzip 的 tar 常见）
]);

test('walkTar：逐个交出条目，长名并进下一个条目，数据与权限位都对', async () => {
  for (let round = 0; round < 5; round++) {
    const seen = [];
    const data = new Map();
    let ended = 0;
    const mode = await walkTar(Readable.from(chunks(tar)), (e) => {
      seen.push(`${e.type}:${e.name}:${e.mode.toString(8)}${e.linkname ? '->' + e.linkname : ''}`);
      if (e.type !== '0') return null;
      const parts = [];
      data.set(e.name, parts);
      return { data: async (b) => { parts.push(Buffer.from(b)); }, end: () => { ended++; } };
    });
    assert.equal(mode, 'end');
    assert.deepEqual(seen, ['5:bin/:755', `0:${longName}:755`, `0:${gnuName}:644`, '2:link:644->bin/', '0:empty:644']);
    assert.ok(Buffer.concat(data.get(longName)).equals(big));
    assert.equal(Buffer.concat(data.get(gnuName)).toString(), 'hello');
    assert.equal(ended, 3);
  }
});

test('walkTar：stop 到条目边界就收手；drain 把结尾标记之后的字节也读干', async () => {
  let n = 0;
  const mode = await walkTar(Readable.from([tar]), () => { n++; return null; }, { stop: () => n >= 2 });
  assert.equal(mode, 'stopped');
  assert.equal(n, 2);

  for (const drain of [false, true]) {
    let read = 0;
    // 直接给生成器、不经 Readable：Readable.from 会预读十几块，量不出「读到哪里就停了」
    const src = (function* () { for (const c of chunks(tar)) { read += c.length; yield c; } })();
    await walkTar(src, () => null, { drain });
    if (drain) assert.equal(read, tar.length);
    else assert.ok(read < tar.length);
  }
});

test('walkTar：扩展头大得离谱（坏包）直接报错，不把它整个攒进内存', async () => {
  const huge = Buffer.concat([header('././@PaxHeader', 2 << 20, 'x'), Buffer.alloc(4096)]);
  await assert.rejects(walkTar(Readable.from([huge]), () => null), /扩展头过大/);
});
