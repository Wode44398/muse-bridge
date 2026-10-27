import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpSession } from './cdp.mjs';

// replMode 只 await 顶层的 `await x`：表达式本身求值为 Promise（`snap()`、`(async()=>…)()`）时，
// 以前 returnByValue 直接拿回 Promise 序列化出的 `{}`。现在先拿引用再按类型取值。
function stub(first, follow = {}) {
  const s = new CdpSession();
  const sent = [];
  s.send = async (method, params) => {
    sent.push([method, params]);
    if (method === 'Runtime.evaluate') return first;
    return follow[method] ?? {};
  };
  return { s, sent };
}
const methods = (sent) => sent.map(([m]) => m);

test('eval awaits a returned Promise instead of serializing it to {}', async () => {
  const { s, sent } = stub(
    { result: { type: 'object', subtype: 'promise', objectId: 'p1' } },
    { 'Runtime.awaitPromise': { result: { type: 'object', value: { ok: true } } } },
  );
  assert.deepEqual(await s.eval('snap()'), { ok: true });
  assert.equal(sent.find(([m]) => m === 'Runtime.awaitPromise')[1].promiseObjectId, 'p1');
  assert.ok(methods(sent).includes('Runtime.releaseObjectGroup'), '引用用完整组释放');
});

test('eval fetches plain objects by value and leaves primitives alone', async () => {
  const obj = stub(
    { result: { type: 'object', objectId: 'o1' } },
    { 'Runtime.callFunctionOn': { result: { type: 'object', value: { a: 1 } } } },
  );
  assert.deepEqual(await obj.s.eval('({a:1})'), { a: 1 });
  const prim = stub({ result: { type: 'number', value: 3 } });
  assert.equal(await prim.s.eval('1+2'), 3);
  assert.deepEqual(methods(prim.sent), ['Runtime.evaluate'], '原始值一次往返就够，不发释放');
  const nan = stub({ result: { type: 'number', unserializableValue: 'NaN' } });
  assert.equal(await nan.s.eval('0/0'), 'NaN');
});

test('a rejected Promise surfaces as an error', async () => {
  const { s } = stub(
    { result: { type: 'object', subtype: 'promise', objectId: 'p1' } },
    { 'Runtime.awaitPromise': { exceptionDetails: { text: 'Uncaught (in promise)', exception: { description: 'Error: boom' } } } },
  );
  await assert.rejects(s.eval('Promise.reject(new Error("boom"))'), /boom/);
});
