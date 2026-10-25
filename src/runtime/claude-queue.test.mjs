import test from 'node:test';
import assert from 'node:assert/strict';
import { enqueue, listQueue, removeItem, moveItem, clearQueue, coalesce, drain, setQueueReplayer, enqueueFront, fakeRequest, fakeResponse } from './claude-queue.mjs';

const KEY = 'test-q';
const SID = '11111111-2222-3333-4444-555555555555';
const H = { authorization: 'Bearer x' };

test('排队：增 / 删 / 排序 / 清空，前端视图不带身份头和原请求体', () => {
  clearQueue(KEY, SID);
  const a = enqueue(KEY, SID, { message: '第一条', attachments: ['C:/a/x.png'], body: { agent: 'claude', sessionId: SID, priority: 'later', model: 'm1' }, headers: H });
  enqueue(KEY, SID, { message: '第二条', attachments: [], body: { agent: 'claude', sessionId: SID, priority: 'later', model: 'm2' }, headers: H });
  enqueue(KEY, SID, { message: '第三条', attachments: [], body: { agent: 'claude', sessionId: SID, priority: 'later' }, headers: H });
  let v = listQueue(KEY, SID);
  assert.deepEqual(v.map((x) => x.text), ['第一条', '第二条', '第三条']);
  assert.deepEqual(v[0].files, ['x.png']);
  assert.ok(!('headers' in v[0]) && !('body' in v[0]));
  v = moveItem(KEY, SID, v[2].id, 0);
  assert.deepEqual(v.map((x) => x.text), ['第三条', '第一条', '第二条']);
  const r = removeItem(KEY, SID, a.item.id);
  assert.equal(r.item.text, '第一条');
  assert.deepEqual(r.item.attachments, ['C:/a/x.png']);
  assert.deepEqual(listQueue(KEY, SID).map((x) => x.text), ['第三条', '第二条']);
  enqueueFront(KEY, SID, r.raw);
  assert.equal(listQueue(KEY, SID)[0].text, '第一条');
  clearQueue(KEY, SID);
  assert.equal(listQueue(KEY, SID).length, 0);
});

test('合并：正文按顺序空一行拼接、附件去重取并集、参数取最后一条、去掉 priority', () => {
  const c = coalesce([
    { text: 'A', attachments: ['p1', 'p2'], body: { model: 'm1', priority: 'later', message: 'A' }, headers: H, url: '/api/chat' },
    { text: '', attachments: ['p2'], body: { model: 'm2' }, headers: H, url: '/api/chat' },
    { text: 'C', attachments: ['p3'], body: { model: 'm3', priority: 'later' }, headers: { authorization: 'Bearer y' }, url: '/api/chat?ct=t' },
  ]);
  assert.equal(c.body.message, 'A\n\nC');
  assert.deepEqual(c.body.attachments, ['p1', 'p2', 'p3']);
  assert.equal(c.body.model, 'm3');
  assert.equal(c.body.priority, undefined);
  assert.equal(c.headers.authorization, 'Bearer y');
  assert.equal(c.url, '/api/chat?ct=t');
});

test('发出：成功则清空；重放失败原样放回队首', async () => {
  clearQueue(KEY, SID);
  enqueue(KEY, SID, { message: 'x1', attachments: [], body: { sessionId: SID }, headers: H });
  enqueue(KEY, SID, { message: 'x2', attachments: [], body: { sessionId: SID }, headers: H });
  // enqueue 时没有在跑的轮会自己排一次发送；这里先换成失败的重放器再手动发
  const seen = [];
  setQueueReplayer(async (rq) => { seen.push(rq.body.message); return { status: 409 }; });
  assert.equal(await drain(KEY, SID), false);
  assert.deepEqual(listQueue(KEY, SID).map((x) => x.text), ['x1', 'x2']);
  setQueueReplayer(async (rq) => { seen.push(rq.body.message); return { status: 200 }; });
  assert.equal(await drain(KEY, SID), true);
  assert.equal(listQueue(KEY, SID).length, 0);
  assert.equal(seen.at(-1), 'x1\n\nx2');
  // 只发其中一条（立即发送）
  enqueue(KEY, SID, { message: 'y1', attachments: [], body: { sessionId: SID }, headers: H });
  const { item } = enqueue(KEY, SID, { message: 'y2', attachments: [], body: { sessionId: SID }, headers: H });
  assert.equal(await drain(KEY, SID, [item.id]), true);
  assert.deepEqual(listQueue(KEY, SID).map((x) => x.text), ['y1']);
  clearQueue(KEY, SID);
  setQueueReplayer(null);
  await new Promise((r) => setTimeout(r, 450));   // 让 enqueue 排的自动发送计时器走完（重放器已卸，空转）
});

test('内部重放的假请求 / 假响应', async () => {
  const req = fakeRequest({ headers: H, url: '/api/chat?ct=abc', body: { message: 'hi' } });
  assert.equal(req.url, '/api/chat?ct=abc');
  assert.equal(req.headers.authorization, 'Bearer x');
  let body = '';
  for await (const c of req) body += c;
  assert.deepEqual(JSON.parse(body), { message: 'hi' });
  const res = fakeResponse();
  let closed = false;
  res.on('close', () => { closed = true; });
  res.writeHead(200, {});
  res.write('data: x\n\n');
  res.end();
  assert.equal(res.statusCode, 200);
  assert.ok(res.writableEnded && closed);
});
