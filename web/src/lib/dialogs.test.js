// 应用内对话框的纯逻辑与兜底路径（lib/dialogState.svelte.js + lib/dialogs.js）。
// 做法同 devices.state.test.js：用 svelte 编译器把真的 dialogState.svelte.js 编成客户端模块，
// dialogs.js 原样拷进临时目录，nativeDesktop / i18n 换成桩；DialogHost.svelte 故意不放——
// 动态 import 必然失败，正好验证「组件起不来时退回系统弹窗、Promise 照样结算」。
// 不碰真实数据根、不起浏览器：window / document 都是最小的假对象。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(here, '..', '..', 'package.json'));
const svelteRoot = dirname(require.resolve('svelte/package.json'));
const SV = {
  'svelte': pathToFileURL(join(svelteRoot, 'src', 'index-client.js')).href,
  'svelte/internal/client': pathToFileURL(join(svelteRoot, 'src', 'internal', 'client', 'index.js')).href,
  'svelte/internal/disclose-version': pathToFileURL(join(svelteRoot, 'src', 'internal', 'disclose-version.js')).href,
  'svelte/internal/flags/legacy': pathToFileURL(join(svelteRoot, 'src', 'internal', 'flags', 'legacy.js')).href,
};
const fixImports = (code) => code.replace(/from\s+['"](svelte(?:\/[\w/-]+)?)['"]/g, (m, s) => (SV[s] ? `from '${SV[s]}'` : m));

// —— 假环境：必须在 import dialogs.js 之前就位（它在模块求值时注册键盘监听、排空闲预取） ——
const listeners = {};
const shown = [];   // 兜底路径弹过的系统框
const idleCbs = []; // 空闲预取：收下回调，测试里手动触发
globalThis.window = {
  addEventListener(type, fn, capture) { (listeners[type] ||= []).push({ fn, capture }); },
  removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((l) => l.fn !== fn); },
  alert(text) { shown.push({ kind: 'alert', text }); },
  confirm(text) { shown.push({ kind: 'confirm', text }); return globalThis.__confirmAnswer ?? true; },
  requestIdleCallback(fn) { idleCbs.push(fn); },
};
globalThis.document = { activeElement: null, body: {}, documentElement: {} };
// staleGuard 用：刷新只记次数；sessionStorage 是它「60 秒内刚刷过」的防循环记录
let reloads = 0;
const store = new Map();
Object.defineProperty(globalThis, 'location', { configurable: true, writable: true, value: { reload() { reloads += 1; } } });
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true, writable: true,
  value: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => { store.set(k, String(v)); }, removeItem: (k) => { store.delete(k); } },
});
// 等刷新的时长在测试里缩短（dialogs.js 的 STALE_WAIT 改读它，见下方拷贝时的替换）
const STALE_WAIT_TEST = 300;
globalThis.__staleWait = STALE_WAIT_TEST;

const { compileModule } = await import(pathToFileURL(join(svelteRoot, 'src', 'compiler', 'index.js')).href);
const dir = mkdtempSync(join(tmpdir(), 'dialogs-test-'));
mkdirSync(join(dir, 'lib'));
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
const stateJs = compileModule(readFileSync(join(here, 'dialogState.svelte.js'), 'utf8'), { filename: 'dialogState.svelte.js', generate: 'client' }).js.code;
writeFileSync(join(dir, 'lib', 'dialogState.svelte.js'), fixImports(stateJs));
// dialogs.js 原样拷过去，只改两处：组件加载可由测试注入（模拟 Vite 预加载辅助函数的行为），等刷新的时长缩短
const LOAD_LINE = "const loadHost = () => import('../components/DialogHost.svelte');";
const WAIT_RE = /const STALE_WAIT = \d+;/;
const dialogsSrc = readFileSync(join(here, 'dialogs.js'), 'utf8');
assert.ok(dialogsSrc.includes(LOAD_LINE) && WAIT_RE.test(dialogsSrc), 'dialogs.js 的 loadHost / STALE_WAIT 写法变了，同步改这里的替换');
writeFileSync(join(dir, 'lib', 'dialogs.js'), fixImports(dialogsSrc
  .replace(LOAD_LINE, "const loadHost = () => (globalThis.__loadHost ? globalThis.__loadHost() : import('../components/DialogHost.svelte'));")
  .replace(WAIT_RE, 'const STALE_WAIT = globalThis.__staleWait;')));
writeFileSync(join(dir, 'lib', 'staleGuard.js'), readFileSync(join(here, 'staleGuard.js'), 'utf8'));
// 桩：desktopApp.messageBox 每次现读 globalThis.__box，测试里随时切换「有没有桌面壳」
writeFileSync(join(dir, 'lib', 'nativeDesktop.js'), 'export const desktopApp = { get messageBox() { return globalThis.__box; } };');
writeFileSync(join(dir, 'lib', 'i18n.js'), 'export const t = (s) => s;');

const S = await import(pathToFileURL(join(dir, 'lib', 'dialogState.svelte.js')).href);
const D = await import(pathToFileURL(join(dir, 'lib', 'dialogs.js')).href);
const G = await import(pathToFileURL(join(dir, 'lib', 'staleGuard.js')).href);   // 与 dialogs.js 用的是同一份模块实例

// 模拟 Vite 的 __vitePreload：依赖或模块加载失败时派发可取消的 vite:preloadError；
// 被 preventDefault 就不抛错、解析成 undefined，否则把错误抛给调用方
function vitePreloadFail() {
  return async () => {
    const err = new Error('Failed to fetch dynamically imported module: /app/assets/DialogHost-x.js');
    const ev = { type: 'vite:preloadError', payload: err, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    for (const l of [...(listeners['vite:preloadError'] || [])]) l.fn(ev);
    if (!ev.defaultPrevented) throw err;
    return undefined;
  };
}

const reset = () => { S.dlg.queue.splice(0, S.dlg.queue.length); S.host.ready = false; S.host.owner = null; S.hooks.key = null; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEF = { ok: '确定', cancel: '取消' };

test('clip：转字符串、按上限截断带省略号、不劈代理对', () => {
  assert.equal(S.clip(null, 10), '');
  assert.equal(S.clip(undefined, 10), '');
  assert.equal(S.clip(42, 10), '42');
  assert.equal(S.clip('abc', 3), 'abc');
  const long = S.clip('x'.repeat(5000), S.MSG_MAX);
  assert.equal(long.length, S.MSG_MAX);
  assert.ok(long.endsWith('…'));
  // 'aaa😀x' 截到 5：截点前一位是 😀 的高代理，连它一起丢
  assert.equal(S.clip('aaa😀x', 5), 'aaa…');
  // 对象 toString 抛错也不炸
  assert.equal(S.clip({ toString() { throw new Error('x'); } }, 5), '');
});

test('makeRequest：类型、danger、按钮名、截断的缺省与规整', () => {
  const a = S.makeRequest('alert', 'hi', undefined, DEF);
  assert.equal(a.kind, 'alert');
  assert.equal(a.type, 'info');
  assert.equal(a.danger, false);
  assert.equal(a.okLabel, '确定');
  assert.equal(a.count, 1);
  assert.equal(a.closing, false);

  const c = S.makeRequest('confirm', 'del?', { type: 'warning' }, DEF);
  assert.equal(c.type, 'warning');
  assert.equal(c.danger, true, 'warning 缺省就是危险操作');
  assert.equal(S.makeRequest('confirm', 'x', { type: 'warning', danger: false }, DEF).danger, false, '显式 danger:false 压过 warning');
  assert.equal(S.makeRequest('confirm', 'x', { danger: true }, DEF).danger, true);
  assert.equal(S.makeRequest('confirm', 'x', { type: 'bogus' }, DEF).type, 'question', '非法 type 回落');

  // okLabel 为 undefined / '' / 纯空白都回落默认（FilesPanel 中文路径就传 undefined）
  for (const v of [undefined, '', '   ', null]) assert.equal(S.makeRequest('confirm', 'x', { okLabel: v }, DEF).okLabel, '确定');
  assert.equal(S.makeRequest('confirm', 'x', { cancelLabel: '' }, DEF).cancelLabel, '取消');
  assert.equal(S.makeRequest('confirm', 'x', { okLabel: '删'.repeat(60) }, DEF).okLabel.length, S.LABEL_MAX);

  const big = S.makeRequest('alert', 'm'.repeat(3000), { detail: 'd'.repeat(9000), title: '  t  ' }, DEF);
  assert.equal(big.message.length, S.MSG_MAX);
  assert.equal(big.detail.length, S.DETAIL_MAX);
  assert.equal(big.title, 't');
  assert.ok(big.id > a.id, 'id 递增');
  // opts 传 null / 非对象也不炸
  assert.equal(S.makeRequest('confirm', 'x', null, null).okLabel, 'OK');
});

test('enqueue：连续相同 alert 合并成 ×n，只并队尾、confirm 不并、退场中的不并', () => {
  const q = [];
  const mk = (m, o) => S.makeRequest('alert', m, o, DEF);
  assert.equal(S.enqueue(q, mk('a')).status, 'queued');
  const r2 = S.enqueue(q, mk('a'));
  assert.equal(r2.status, 'merged');
  assert.equal(q.length, 1);
  assert.equal(q[0].count, 2);
  assert.equal(S.enqueue(q, mk('a', { detail: 'x' })).status, 'queued', 'detail 不同不并');
  assert.equal(S.enqueue(q, mk('a')).status, 'queued', '隔着别的弹窗不并，保持先后');
  assert.equal(q.length, 3);

  const q2 = [];
  S.enqueue(q2, S.makeRequest('confirm', 'c', {}, DEF));
  assert.equal(S.enqueue(q2, S.makeRequest('confirm', 'c', {}, DEF)).status, 'queued', 'confirm 各问各的');

  const q3 = [];
  S.enqueue(q3, mk('z'));
  q3[0].closing = true;
  assert.equal(S.enqueue(q3, mk('z')).status, 'queued', '正在退场的那条不再并');
});

test('enqueue：排队上限只数没在退场的', () => {
  const q = [];
  for (let i = 0; i < 3; i++) S.enqueue(q, S.makeRequest('confirm', 'c' + i, {}, DEF), 3);
  assert.equal(S.enqueue(q, S.makeRequest('confirm', 'x', {}, DEF), 3).status, 'full');
  q[0].closing = true;
  assert.equal(S.enqueue(q, S.makeRequest('confirm', 'x', {}, DEF), 3).status, 'queued');
});

test('默认焦点 / Esc / 返回值 / 焦点循环', () => {
  const ok = S.makeRequest('confirm', 'x', {}, DEF);
  const bad = S.makeRequest('confirm', 'x', { danger: true }, DEF);
  const al = S.makeRequest('alert', 'x', { danger: true }, DEF);
  assert.equal(S.defaultRole(ok), 'ok');
  assert.equal(S.defaultRole(bad), 'cancel', '危险确认默认焦点给取消');
  assert.equal(S.defaultRole(al), 'ok', 'alert 只有一个按钮');
  assert.equal(S.escRole(ok), 'cancel');
  assert.equal(S.escRole(al), 'ok', 'alert 的 Esc 视同确定');
  assert.equal(S.valueOf(ok, 'ok'), true);
  assert.equal(S.valueOf(ok, 'cancel'), false);
  assert.equal(S.valueOf(al, 'ok'), undefined);
  assert.equal(S.cycleIndex(2, 0, 1), 1);
  assert.equal(S.cycleIndex(2, 1, 1), 0);
  assert.equal(S.cycleIndex(2, 0, -1), 1);
  assert.equal(S.cycleIndex(2, -1, 1), 0, '焦点不在按钮上：正向落第一个');
  assert.equal(S.cycleIndex(2, -1, -1), 1, '反向落最后一个');
  assert.equal(S.cycleIndex(0, 0, 1), -1);
  assert.equal(S.cycleIndex(1, 0, 1), 0);
});

test('request / settle：FIFO、合并的调用一起结算、重复结算无效', async () => {
  reset();
  const p1 = S.request('alert', 'same', {}, DEF);
  const p2 = S.request('alert', 'same', {}, DEF);
  const p3 = S.request('confirm', 'sure?', {}, DEF);
  assert.equal(S.dlg.queue.length, 2);
  assert.equal(S.dlg.queue[0].count, 2);
  const first = S.activeRequest();
  assert.equal(first.message, 'same');
  assert.equal(S.settle(first.id, 'ok', { instant: true }), true);
  assert.equal(S.settle(first.id, 'ok', { instant: true }), false, '已结算的再点无效');
  assert.deepEqual(await Promise.all([p1, p2]), [undefined, undefined]);
  const second = S.activeRequest();
  assert.equal(second.kind, 'confirm');
  S.settle(second.id, 'ok', { instant: true });
  assert.equal(await p3, true);
  assert.equal(S.dlg.queue.length, 0);
  assert.equal(S.activeRequest(), null);
});

test('settle 不带 instant：先标退场（不再算当前），动画时长后出队', async () => {
  reset();
  const p = S.request('confirm', 'x', {}, DEF);
  const r = S.activeRequest();
  S.settle(r.id, 'cancel');
  assert.equal(await p, false);
  assert.equal(S.dlg.queue.length, 1, '退场期间还在队列里（要画淡出）');
  assert.equal(S.dlg.queue[0].closing, true);
  assert.equal(S.activeRequest(), null);
  assert.equal(S.pendingCount(), 0);
  await sleep(S.EXIT_MS + 30);
  assert.equal(S.dlg.queue.length, 0);
});

test('request：队列满了直接按取消返回，不卡住调用方', async () => {
  reset();
  const ps = [];
  for (let i = 0; i < S.QUEUE_MAX; i++) ps.push(S.request('confirm', 'q' + i, {}, DEF));
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await S.request('confirm', 'overflow', {}, DEF), false);
    assert.equal(await S.request('alert', 'overflow', {}, DEF), undefined);
  } finally { console.warn = warn; }
  assert.equal(S.dlg.queue.length, S.QUEUE_MAX);
  for (const r of [...S.dlg.queue]) S.settle(r.id, 'cancel', { instant: true });
  await Promise.all(ps);
});

test('兜底：组件加载失败 → window.confirm / alert，按队列顺序问完，标题与 ×n 并进正文', async () => {
  reset();
  globalThis.__box = undefined;
  shown.length = 0;
  const warn = console.warn;
  console.warn = () => {};
  try {
    globalThis.__confirmAnswer = true;
    const a1 = D.uiAlert('too big', { title: 'Upload' });
    const a2 = D.uiAlert('too big', { title: 'Upload' });
    const c = D.uiConfirm('删除？', { detail: '不可撤销', danger: true });
    assert.deepEqual(await Promise.all([a1, a2]), [undefined, undefined]);
    assert.equal(await c, true);
    assert.deepEqual(shown, [
      { kind: 'alert', text: 'Upload\ntoo big ×2' },
      { kind: 'confirm', text: '删除？\n不可撤销' },
    ]);
    globalThis.__confirmAnswer = false;
    assert.equal(await D.uiConfirm('again?'), false);
  } finally { console.warn = warn; globalThis.__confirmAnswer = undefined; }
  assert.equal(S.dlg.queue.length, 0);
});

test('兜底：上一批刚问完就进来的新请求不会被晾着（kick 收尾时补一次）', async () => {
  reset();
  globalThis.__box = undefined;
  shown.length = 0;
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await D.uiConfirm('first?'), true);
    // 紧接着（同一段续体里，兜底循环的收尾还没跑完）再问一句
    assert.equal(await D.uiConfirm('second?'), true);
  } finally { console.warn = warn; }
  assert.deepEqual(shown.map((s) => s.text), ['first?', 'second?']);
});

test('兜底：桌面壳在时走 messageBox，danger 默认按钮是取消', async () => {
  reset();
  const calls = [];
  globalThis.__box = async (o) => { calls.push(o); return { response: o.buttons.length > 1 ? 1 : 0 }; };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal(await D.uiConfirm('删除「a」？', { okLabel: '删除', danger: true }), false);
    await D.uiAlert('done', { detail: 'ok' });
  } finally { console.warn = warn; globalThis.__box = undefined; }
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].buttons, ['删除', '取消']);
  assert.equal(calls[0].defaultId, 1);
  assert.equal(calls[0].cancelId, 1);
  assert.equal(calls[0].type, 'question');
  assert.deepEqual(calls[1].buttons, ['确定']);
  assert.equal(calls[1].detail, 'ok');
});

test('键盘：模块求值时已在捕获阶段注册；有弹窗才拦，关弹窗那一下的自动重复不漏到底下', async () => {
  const down = listeners.keydown?.find((l) => l.capture === true)?.fn;
  const up = listeners.keyup?.find((l) => l.capture === true)?.fn;
  assert.ok(down && up, 'keydown / keyup 捕获监听已注册');
  const ev = (key, extra = {}) => {
    const e = { key, repeat: false, prevented: false, stopped: false, ...extra };
    e.preventDefault = () => { e.prevented = true; };
    e.stopImmediatePropagation = () => { e.stopped = true; };
    return e;
  };

  reset();
  // 队列空：什么都不做
  const idle = ev('Enter');
  down(idle);
  assert.equal(idle.stopped, false);

  // 模拟宿主就位：Enter 交给宿主处理（这里直接按确定结算）
  S.host.ready = true;
  S.hooks.key = (e) => { if (e.key === 'Enter' && !e.repeat) { e.preventDefault(); S.settle(S.activeRequest().id, 'ok', { instant: true }); } };
  const p = D.uiConfirm('go?');
  const letter = ev('a');
  down(letter);
  assert.equal(letter.stopped, true, '弹窗开着时底下的快捷键收不到');
  assert.equal(letter.prevented, false, '不拦默认行为（复制文字等）');
  const enter = ev('Enter');
  down(enter);
  assert.equal(enter.stopped, true);
  assert.equal(await p, true);
  // 按住不放的自动重复：弹窗已关，仍被吞掉
  const rep = ev('Enter', { repeat: true });
  down(rep);
  assert.equal(rep.prevented && rep.stopped, true);
  const rel = ev('Enter');
  up(rel);
  assert.equal(rel.stopped, true, '关弹窗那一下的 keyup 也不往下传');
  // 松开之后恢复正常
  const later = ev('Enter');
  down(later);
  assert.equal(later.stopped, false);
  reset();
});

// —— 指针防误触（DialogHost 的根节点捕获监听用的纯逻辑） ——

test('eventTime：认 performance.now 口径的 timeStamp，纪元毫秒 / 0 / 缺省退回现读', () => {
  assert.equal(S.eventTime({ timeStamp: 1234.5 }, 2000), 1234.5);
  assert.equal(S.eventTime({ timeStamp: 1900 }, 1500), 1900, '比现读略晚（1 秒内）仍认');
  assert.equal(S.eventTime({ timeStamp: 1_731_000_000_000 }, 2000), 2000, '纪元毫秒的老内核');
  assert.equal(S.eventTime({ timeStamp: 0 }, 2000), 2000);
  assert.equal(S.eventTime({}, 2000), 2000);
  assert.equal(S.eventTime(null, 2000), 2000);
});

test('pressTooSoon：出现后 SHOW_GUARD_MS 内的按下不算，出现前就按下、事件晚到的也不算', () => {
  const shownAt = 10_000;
  assert.equal(S.pressTooSoon(shownAt + 120, shownAt), true, '双击的第二下（约 100–200ms）');
  assert.equal(S.pressTooSoon(shownAt + S.SHOW_GUARD_MS - 1, shownAt), true);
  assert.equal(S.pressTooSoon(shownAt + S.SHOW_GUARD_MS, shownAt), false, '窗口一过照常');
  assert.equal(S.pressTooSoon(shownAt + 5000, shownAt), false, '读完再点');
  assert.equal(S.pressTooSoon(shownAt - 30, shownAt), true, '按下早于出现（主线程卡住、事件晚到）');
  assert.equal(S.pressTooSoon(123, -Infinity), false, '还没记出现时刻：不挡');
  assert.equal(S.pressTooSoon(shownAt + 200, shownAt, 100), false, '可传自定义窗口');
  assert.ok(S.SHOW_GUARD_MS >= 300 && S.SHOW_GUARD_MS <= 500, '盖住双击间隔、又不至于让人觉得点不动');
});

test('strayClick：连击的第二下起吞掉；按下被时间窗挡掉的 click 吞掉；键盘 / 程序 click 放行', () => {
  assert.equal(S.strayClick(2, false), true, '双击第二下');
  assert.equal(S.strayClick(3, false), true, '三连击');
  assert.equal(S.strayClick(1, false), false, '正常单击');
  assert.equal(S.strayClick(1, true), true, '按下落在时间窗里，随后的 click 一起吞');
  assert.equal(S.strayClick(0, true), false, '空格 / 回车 / el.click() 的 detail 为 0，不吞');
  assert.equal(S.strayClick(0, false), false);
  assert.equal(S.strayClick(undefined, true), false, 'detail 缺省按 0');
  assert.equal(S.strayClick('2', false), true);
});

// —— 只有 message、没有 detail 时的排版 ——

test('msgLayout：一整段在第一处句末拆成「问句 + 说明」，收尾引号 / 括号归前半句', () => {
  assert.deepEqual(S.msgLayout('删除「OpenRouter」？已经添加到各处的模型会一并移除。', ''),
    { lead: '删除「OpenRouter」？', rest: '已经添加到各处的模型会一并移除。', long: false });
  assert.deepEqual(S.msgLayout('有未保存的修改，确定离开？（草稿会临时保留）'),
    { lead: '有未保存的修改，确定离开？', rest: '（草稿会临时保留）', long: false });
  // 只拆第一处：后面几句都归说明
  const three = S.msgLayout('改为共用？原来的服务会被收编。之后在模型中心里管理。');
  assert.equal(three.lead, '改为共用？');
  assert.equal(three.rest, '原来的服务会被收编。之后在模型中心里管理。');
  // 句末之后的收尾引号归前半句
  assert.deepEqual(S.msgLayout('他说「好了。」然后走了'), { lead: '他说「好了。」', rest: '然后走了', long: false });
  // 西文：问号 / 句点后要跟空白
  const en = S.msgLayout('Delete “OpenRouter”? Models added elsewhere are removed too.');
  assert.equal(en.lead, 'Delete “OpenRouter”?');
  assert.equal(en.rest, 'Models added elsewhere are removed too.');
  assert.equal(S.msgLayout('Are you sure?” he asked. Then left.').lead, 'Are you sure?”', '问号后的收尾引号归前半句，再跟空白才算句末');
  // 换行也算分段，说明前面的空白去掉
  assert.deepEqual(S.msgLayout('以下文件没传上：\n a.txt\nb.txt'), { lead: '以下文件没传上：', rest: 'a.txt\nb.txt', long: false });
});

test('msgLayout：拆不开 / 不该拆的情况原样返回', () => {
  const same = (m, d) => {
    const L = S.msgLayout(m, d);
    assert.equal(L.lead, m, m);
    assert.equal(L.rest, '', m);
  };
  same('删除这件作品？');                       // 一整句
  same('删除这件作品？  ');                     // 句末之后只有空白
  same('「a.txt」：超过 20MB，暂不支持');        // 没有句末标点
  same('上传失败：v1.2.3 的 a.com/?x=1');        // 句点 / 问号后面不是空白
  same('Took 3.5 s. ', '');                     // 后面没东西了
  same('1. 先选文件');                          // 序号不算句子
  same('e.g. something else');                  // 缩写不算句子
  same('');
  same('删除「a」？已经跑出来的会话会保留。', '调用方给了 detail');   // 已经分过级的不再拆
  assert.deepEqual(S.msgLayout(null), { lead: '', rest: '', long: false });
  // 很短的中文问句也能拆（两个字就是一句）
  assert.equal(S.msgLayout('删除？不可撤销。').lead, '删除？');
});

test('msgLayout：拆不开的长句标 long（约两行以上），短句不标；textUnits 汉字记 2', () => {
  assert.equal(S.textUnits('ab'), 2);
  assert.equal(S.textUnits('删除'), 4);
  assert.equal(S.textUnits('「」？'), 6, '全角标点记 2');
  assert.equal(S.textUnits('😀'), 2, '按码位数，代理对不拆成两个');
  assert.equal(S.textUnits(null), 0);
  const longCn = '共用服务已经建好，但 dimensio 里原来那份没删掉，请到 dimensio 的「模型服务」里手动删一下，免得出现两张一样的卡。';
  const L = S.msgLayout(longCn);
  assert.equal(L.rest, '', '只有一句，不拆');
  assert.equal(L.long, true);
  assert.equal(S.msgLayout('删除「OpenRouter」？已经添加到各处的模型会一并移除。').long, false, '拆完前半句很短');
  assert.equal(S.msgLayout('x'.repeat(S.LONG_UNITS)).long, false);
  assert.equal(S.msgLayout('x'.repeat(S.LONG_UNITS + 1)).long, true);
});

// —— 空闲预取与 staleGuard（C2）——

test('staleGuard：quietPreload 期间的预加载失败不刷新、不吞错；结算后恢复刷新', async () => {
  store.clear();
  reloads = 0;
  await assert.rejects(G.quietPreload(vitePreloadFail()), /dynamically imported module/, '错误原样交回调用方');
  assert.equal(reloads, 0, '静默期间不刷新');
  assert.equal(G.reloadPending(), false);
  assert.equal(await G.quietPreload(async () => 42), 42, '成功时原样返回');
  // 两个静默加载并行：一个先结算了，另一个还挂着时仍然静默
  let finish;
  const slow = G.quietPreload(() => new Promise((res) => { finish = res; }));
  await G.quietPreload(async () => 1);
  await assert.rejects(vitePreloadFail()(), /dynamically imported module/);
  assert.equal(reloads, 0, '还有一个静默加载没结算');
  finish('done');
  assert.equal(await slow, 'done');
  // 都结算了：普通懒加载失败照旧按构建漂移刷新、并吞掉错误
  assert.equal(await vitePreloadFail()(), undefined, '被 preventDefault，Vite 解析成 undefined');
  assert.equal(reloads, 1);
  assert.equal(G.reloadPending(), true);
  store.clear();
});

test('dialogs：空闲预取失败不整页刷新、不弹任何框', async () => {
  reset();
  store.clear();
  reloads = 0;
  shown.length = 0;
  assert.equal(idleCbs.length, 1, '模块求值时排了一次空闲预取');
  globalThis.__loadHost = vitePreloadFail();
  try {
    idleCbs[0]();
    await sleep(20);
  } finally { globalThis.__loadHost = undefined; }
  assert.equal(reloads, 0);
  assert.equal(shown.length, 0);
  assert.equal(S.dlg.queue.length, 0);
});

test('dialogs：真实调用加载失败、staleGuard 正在刷新 → 先等刷新，不同时弹系统框；页面还在就照常兜底', async () => {
  reset();
  store.clear();
  reloads = 0;
  shown.length = 0;
  globalThis.__box = undefined;
  globalThis.__loadHost = vitePreloadFail();
  globalThis.__confirmAnswer = false;
  const warn = console.warn;
  console.warn = () => {};
  try {
    const t0 = performance.now();
    const p = D.uiConfirm('删除？', { danger: true });
    await sleep(STALE_WAIT_TEST / 3);
    assert.equal(reloads, 1, 'staleGuard 判成构建漂移，已发起刷新');
    assert.equal(shown.length, 0, '刷新途中不弹系统框');
    assert.equal(await p, false, '过了等待时长页面还在：照常兜底，Promise 结算');
    assert.ok(performance.now() - t0 >= STALE_WAIT_TEST - 5, '确实等过了');
    assert.deepEqual(shown, [{ kind: 'confirm', text: '删除？' }]);
  } finally { console.warn = warn; globalThis.__loadHost = undefined; globalThis.__confirmAnswer = undefined; }
});

test('dialogs：60 秒内刚刷过（不是构建漂移）→ 不再刷新，立刻走兜底', async () => {
  reset();
  shown.length = 0;
  store.set('bridge-stale-reload', String(Date.now()));
  const before = reloads;
  globalThis.__loadHost = vitePreloadFail();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const t0 = performance.now();
    await D.uiAlert('出错了');
    assert.ok(performance.now() - t0 < STALE_WAIT_TEST / 2, '没有等刷新');
  } finally { console.warn = warn; globalThis.__loadHost = undefined; }
  assert.equal(reloads, before);
  assert.deepEqual(shown, [{ kind: 'alert', text: '出错了' }]);
  store.clear();
});
