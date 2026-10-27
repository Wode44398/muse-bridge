// 手机工作空间「电脑位置」的两处服务端改动：
//   ① /api/files 列目录改成全程异步（整机浏览时同步 readdir/stat 会把单线程服务钉住）；
//   ② /api/files/delete 的 trash:true＝送进 Windows 回收站（admin 专属、可批量）。
// 回收站的真调用会往本机回收站里放东西，默认不跑；BRIDGE_TEST_RECYCLE=1 时跑一次并自己清干净。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { handleDelete, handleList } from './file-core.mjs';
import { parseRecycleOutput, recycleErrorText, recyclePaths } from '../runtime/recycle.mjs';

const ADMIN = () => ({ kind: 'admin' });
const USER = () => ({ kind: 'user', user: 'xfer-test', tier: 'pro' });

function fakeRes() {
  const res = { status: 0, headers: {}, body: '', headersSent: false, writableEnded: false };
  res.writeHead = (code, headers) => { res.status = code; res.headers = headers || {}; res.headersSent = true; return res; };
  res.end = (chunk) => { res.body += chunk ?? ''; res.writableEnded = true; };
  res.json = () => JSON.parse(res.body);
  return res;
}
const jsonReq = (obj) => Object.assign(Readable.from([Buffer.from(JSON.stringify(obj))]), { headers: {} });

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-list-'));
  fs.mkdirSync(path.join(root, 'b-dir', 'deep'), { recursive: true });
  fs.mkdirSync(path.join(root, 'a-dir'));
  fs.writeFileSync(path.join(root, 'z.txt'), 'zz');
  fs.writeFileSync(path.join(root, '中文.md'), '# hi');
  fs.writeFileSync(path.join(root, '.part-abcdef123'), 'partial');
  fs.writeFileSync(path.join(root, 'b-dir', 'inner.txt'), 'x');
  return root;
}
const clean = (root) => { try { fs.rmSync(root, { recursive: true, force: true }); } catch {} };

test('列目录（ws=任意绝对路径）：文件夹在前、分块上传残片不露面、大小与时间齐全', async () => {
  const root = tree();
  try {
    const res = fakeRes();
    await handleList({ headers: {} }, res, new URL('http://x/api/files?path=&ws=' + encodeURIComponent(root)), ADMIN);
    assert.equal(res.status, 200);
    const data = res.json();
    assert.equal(data.path, '');
    assert.equal(data.truncated, false);
    assert.deepEqual(data.items.map((i) => i.name).slice(0, 2), ['a-dir', 'b-dir']);
    assert.ok(data.items.every((i) => !i.name.startsWith('.part-')));
    const md = data.items.find((i) => i.name === '中文.md');
    assert.equal(md.isDir, false);
    assert.equal(md.size, 4);
    assert.ok(md.mtime > 0);

    const sub = fakeRes();
    await handleList({ headers: {} }, sub, new URL('http://x/api/files?path=b-dir&ws=' + encodeURIComponent(root)), ADMIN);
    assert.equal(sub.json().path, 'b-dir');
    assert.deepEqual(sub.json().items.map((i) => i.name), ['deep', 'inner.txt']);

    const found = fakeRes();
    await handleList({ headers: {} }, found, new URL('http://x/api/files?path=&q=%E4%B8%AD&ws=' + encodeURIComponent(root)), ADMIN);
    assert.deepEqual(found.json().items.map((i) => i.name), ['中文.md']);
    assert.equal(found.json().total, 1);
    const upper = fakeRes();
    await handleList({ headers: {} }, upper, new URL('http://x/api/files?path=&q=A-DIR&ws=' + encodeURIComponent(root)), ADMIN);
    assert.deepEqual(upper.json().items.map((i) => i.name), ['a-dir'], '按名字筛不分大小写');

    const gone = fakeRes();
    await handleList({ headers: {} }, gone, new URL('http://x/api/files?path=nope&ws=' + encodeURIComponent(root)), ADMIN);
    assert.equal(gone.status, 404);

    const file = fakeRes();
    await handleList({ headers: {} }, file, new URL('http://x/api/files?path=z.txt&ws=' + encodeURIComponent(root)), ADMIN);
    assert.equal(file.status, 400);
  } finally { clean(root); }
});

test('上千项的目录：截断时文件夹优先留下，total 给出截之前的总数，q 能找到截掉的那部分', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-big-'));
  try {
    for (let i = 0; i < 1510; i += 1) fs.writeFileSync(path.join(root, `f${String(i).padStart(4, '0')}.txt`), '');
    fs.mkdirSync(path.join(root, 'zz-last-dir'));   // 磁盘顺序排在所有文件之后
    const res = fakeRes();
    await handleList({ headers: {} }, res, new URL('http://x/api/files?path=&ws=' + encodeURIComponent(root)), ADMIN);
    const data = res.json();
    assert.equal(data.truncated, true);
    assert.equal(data.total, 1511);
    assert.equal(data.items.length, 1500);
    assert.equal(data.items[0].name, 'zz-last-dir');
    const q = fakeRes();
    await handleList({ headers: {} }, q, new URL('http://x/api/files?path=&q=f1509&ws=' + encodeURIComponent(root)), ADMIN);
    assert.deepEqual(q.json().items.map((i) => i.name), ['f1509.txt']);
    assert.equal(q.json().truncated, false);
  } finally { clean(root); }
});

test('回收站输出解析：按序号落位，缺的留 null，杂行忽略', () => {
  assert.deepEqual(parseRecycleOutput('0:0\r\n2:5\r\nWARNING: x\r\n', 3), [0, null, 5]);
  assert.deepEqual(parseRecycleOutput('', 2), [null, null]);
  assert.deepEqual(parseRecycleOutput('7:0\n', 2), [null, null]);
  assert.equal(recycleErrorText(5), '没有权限');
  assert.match(recycleErrorText(0x10000), /0x10000/);
});

test('trash：只给 admin；位置根与越界一律拒；不存在的项如实报「不存在」而不是整批失败', async () => {
  const root = tree();
  try {
    const user = fakeRes();
    await handleDelete(jsonReq({ path: 'z.txt', trash: true }), user, USER);
    assert.equal(user.status, 403);
    assert.match(user.json().error, /管理员/);

    for (const bad of ['', '..', '../..']) {
      const res = fakeRes();
      await handleDelete(jsonReq({ ws: root, paths: [bad], trash: true }), res, ADMIN);
      assert.equal(res.status, 403, `rel=${JSON.stringify(bad)}`);
    }

    const tooMany = fakeRes();
    await handleDelete(jsonReq({ ws: root, paths: [], trash: true }), tooMany, ADMIN);
    assert.equal(tooMany.status, 400);

    const missing = fakeRes();
    await handleDelete(jsonReq({ ws: root, paths: ['missing.txt'], trash: true }), missing, ADMIN);
    assert.equal(missing.status, 500);
    assert.equal(missing.json().results[0].error, '不存在');
    assert.ok(fs.existsSync(path.join(root, 'z.txt')), '别的文件原封不动');
  } finally { clean(root); }
});

// 在本机回收站里按原始文件名找到这次测试放进去的项，连 $I 元数据一起删掉。
function purgeFromRecycleBin(uniqueName) {
  const drive = path.parse(os.tmpdir()).root;
  const needle = Buffer.from(uniqueName, 'utf16le');
  let purged = 0;
  const binRoot = path.join(drive, '$Recycle.Bin');
  let sids = [];
  try { sids = fs.readdirSync(binRoot); } catch { return 0; }
  for (const sid of sids) {
    const dir = path.join(binRoot, sid);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names.filter((n) => n.startsWith('$I'))) {
      try {
        if (!fs.readFileSync(path.join(dir, name)).includes(needle)) continue;
        fs.rmSync(path.join(dir, '$R' + name.slice(2)), { recursive: true, force: true });
        fs.rmSync(path.join(dir, name), { force: true });
        purged += 1;
      } catch {}
    }
  }
  return purged;
}

test('trash 真调用：文件与含中文名的文件夹一次送进回收站', { skip: process.platform !== 'win32' || process.env.BRIDGE_TEST_RECYCLE !== '1' }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-trash-'));
  const tag = 'bridge-trash-' + Date.now().toString(36);
  try {
    fs.writeFileSync(path.join(root, tag + '.txt'), 'x');
    fs.mkdirSync(path.join(root, tag + '-目录'));
    fs.writeFileSync(path.join(root, tag + '-目录', '里面.txt'), 'y');
    const res = fakeRes();
    await handleDelete(jsonReq({ ws: root, paths: [tag + '.txt', tag + '-目录'], trash: true }), res, ADMIN);
    assert.equal(res.status, 200, res.body);
    assert.deepEqual(res.json().results.map((r) => r.ok), [true, true]);
    assert.equal(fs.existsSync(path.join(root, tag + '.txt')), false);
    assert.equal(fs.existsSync(path.join(root, tag + '-目录')), false);
    const direct = await recyclePaths([path.join(root, 'never-existed-' + tag)]);
    assert.equal(direct[0].ok, false);
  } finally {
    purgeFromRecycleBin(tag);
    clean(root);
  }
});
