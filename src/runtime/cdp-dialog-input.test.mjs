import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpSession } from './cdp.mjs';
import { handlePageMessage } from './cdp-events.mjs';
import { withDialogNote } from './browser-extra.mjs';

// 2026-10-07 实遇的两种「浏览器工具卡死」：
//  ① 页面弹原生 alert，没人应答 → 主线程被挡，之后每个 eval / 塞文件都 30 秒超时，还被报成「死循环」；
//  ② 触屏仿真下用合成鼠标点击 → mousePressed 的回执等手势结束、mouseReleased 等回执，互等超时，页面只收到 touchstart。
function stub(responder = async () => ({})) {
  const session = new CdpSession();
  const sent = [];
  session.send = async (method, params, timeoutMs) => { sent.push([method, params, timeoutMs]); return responder(method, params); };
  return { session, sent };
}

test('alert / beforeunload are accepted, confirm / prompt are dismissed, all recorded', () => {
  const { session, sent } = stub();
  const mark = session.dialogSeq;
  handlePageMessage(session, JSON.stringify({ method: 'Page.javascriptDialogOpening', params: { type: 'alert', message: '超过 20MB，暂不支持' } }));
  handlePageMessage(session, JSON.stringify({ method: 'Page.javascriptDialogOpening', params: { type: 'confirm', message: '删除这个文件？' } }));
  handlePageMessage(session, JSON.stringify({ method: 'Page.javascriptDialogOpening', params: { type: 'beforeunload', message: '' } }));
  const answers = sent.filter(([m]) => m === 'Page.handleJavaScriptDialog').map(([, p]) => p.accept);
  assert.deepEqual(answers, [true, false, true]);
  const seen = session.dialogsSince(mark);
  assert.deepEqual(seen.map((d) => [d.type, d.accepted]), [['alert', true], ['confirm', false], ['beforeunload', true]]);
  assert.match(session.consoleEntries().map((e) => `${e.type} ${e.msg}`).join('\n'), /dialog\.alert 超过 20MB/);
  assert.equal(session.dialogsSince(session.dialogSeq).length, 0, 'mark 之后没新弹窗 = 空');
});

test('each dialog is reported exactly once, on the next result (success or error)', () => {
  const { session } = stub();
  session.onDialog({ type: 'confirm', message: '确定要删除吗？' });
  const ok = withDialogNote({ content: [{ type: 'text', text: '已点击' }] }, session);
  assert.match(ok.content[0].text, /已点击\n页面弹出了原生对话框：confirm「确定要删除吗？」（已自动取消）；要确认请先 eval window\.confirm/);
  const again = withDialogNote({ content: [{ type: 'text', text: '已滚动' }] }, session);
  assert.equal(again.content[0].text, '已滚动', '报过的不再重复');
  session.onDialog({ type: 'alert', message: '定时器弹的' });   // 两次动作之间弹的
  const bad = withDialogNote({ content: [{ type: 'text', text: '浏览器操作失败：x' }], isError: true }, session);
  assert.match(bad.content[0].text, /alert「定时器弹的」（已自动点确定）/);
  assert.doesNotMatch(bad.content[0].text, /确定要删除吗/);
  assert.equal(bad.isError, true);
  assert.equal(withDialogNote({ content: [{ type: 'text', text: 'x' }] }, null).content[0].text, 'x', '浏览器还没起来时不报错');
});

test('mobile emulation clicks with real touch events; desktop keeps mouse events', async () => {
  const mobile = stub();
  mobile.session.emu = { mobile: true, scheme: 'auto', dpr: 2 };
  await mobile.session.dispatchClick(320, 36);
  assert.deepEqual(mobile.sent.map(([m, p]) => `${m}:${p.type}`), ['Input.dispatchTouchEvent:touchStart', 'Input.dispatchTouchEvent:touchEnd']);
  assert.deepEqual(mobile.sent[0][1].touchPoints, [{ x: 320, y: 36 }]);
  mobile.sent.length = 0;
  await mobile.session.dispatchClick(10, 10, { clickCount: 2 });
  assert.equal(mobile.sent.filter(([, p]) => p.type === 'touchStart').length, 2, '双击 = 两次轻点');

  const desk = stub();
  await desk.session.dispatchClick(5, 6);
  assert.deepEqual(desk.sent.map(([m, p]) => `${m}:${p.type}`), ['Input.dispatchMouseEvent:mouseMoved', 'Input.dispatchMouseEvent:mousePressed', 'Input.dispatchMouseEvent:mouseReleased']);
});

test('eval timeout reports whether the page still answers instead of claiming it recovered', async () => {
  const alive = stub(async (m, p) => {
    if (m === 'Runtime.evaluate' && p.awaitPromise) throw new Error('CDP Runtime.evaluate timed out');
    return { result: { value: 1 } };
  });
  await assert.rejects(alive.session.eval('new Promise(() => {})'), /页面本身还能响应.*Promise 一直没完成/);
  assert.ok(alive.sent.some(([m]) => m === 'Runtime.terminateExecution'));

  const stuck = stub(async (m) => {
    if (m === 'Runtime.evaluate') throw new Error('CDP Runtime.evaluate timed out');
    return {};
  });
  await assert.rejects(stuck.session.eval('1+1'), /主线程至今仍无响应/);
  await assert.rejects(stuck.session.eval('1+1'), (e) => !/已恢复/.test(e.message));
});
